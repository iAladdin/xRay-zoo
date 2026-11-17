import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "./db.js";

export const PaidInvoice = z
  .object({
    provider: z.enum(["dev", "stripe"]),
    invoiceId: z.string().min(1).max(200),
    orderId: z.string().uuid(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  })
  .refine(
    (v) => new Date(v.endAt) > new Date(v.startAt),
    "Invalid service period",
  );
export type PaidInvoiceInput = z.infer<typeof PaidInvoice>;

export async function recordPaidInvoice(input: PaidInvoiceInput) {
  const invoice = PaidInvoice.parse(input);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.$transaction(
        async (tx) => {
          const existing = await tx.servicePeriod.findUnique({
            where: {
              provider_invoiceId: {
                provider: invoice.provider,
                invoiceId: invoice.invoiceId,
              },
            },
          });
          if (existing) {
            if (
              existing.orderId !== invoice.orderId ||
              existing.startAt.toISOString() !== invoice.startAt ||
              existing.endAt.toISOString() !== invoice.endAt
            )
              throw new Error("INVOICE_CONFLICT");
            return { subscriptionId: existing.subscriptionId, duplicate: true };
          }
          const order = await tx.order.findUniqueOrThrow({
            where: { id: invoice.orderId },
          });
          if (
            order.provider !== invoice.provider ||
            order.amountMinor !== invoice.amountMinor ||
            order.currency.toUpperCase() !== invoice.currency.toUpperCase()
          )
            throw new Error("PAYMENT_ORDER_MISMATCH");
          const subscription = await tx.subscription.upsert({
            where: { userId: order.userId },
            create: { userId: order.userId, regions: order.regions },
            update: {},
          });
          await tx.servicePeriod.create({
            data: {
              subscriptionId: subscription.id,
              orderId: order.id,
              provider: invoice.provider,
              invoiceId: invoice.invoiceId,
              startAt: new Date(invoice.startAt),
              endAt: new Date(invoice.endAt),
              quotaBytes: order.quotaBytes,
            },
          });
          await tx.order.update({
            where: { id: order.id },
            data: { status: "paid" },
          });
          const next = await tx.subscription.update({
            where: { id: subscription.id },
            data: { desiredVersion: { increment: 1 } },
          });
          await tx.outbox.create({
            data: {
              kind: "entitlement",
              aggregateId: next.id,
              version: next.desiredVersion,
            },
          });
          return { subscriptionId: next.id, duplicate: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2034", "P2002"].includes(error.code) &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
  throw new Error("TRANSACTION_RETRY_EXHAUSTED");
}

export async function receiveInvoiceEvent(
  provider: "dev" | "stripe",
  eventId: string,
  invoice: PaidInvoiceInput,
) {
  PaidInvoice.parse(invoice);
  if (invoice.provider !== provider) throw new Error("EVENT_PROVIDER_MISMATCH");
  return db.$transaction(async (tx) => {
    const event = await tx.providerEvent.upsert({
      where: { provider_eventId: { provider, eventId } },
      create: { provider, eventId, kind: "invoice.paid", payload: invoice },
      update: {},
    });
    await tx.outbox.upsert({
      where: {
        kind_aggregateId_version: {
          kind: "payment",
          aggregateId: event.id,
          version: 1,
        },
      },
      create: { kind: "payment", aggregateId: event.id, version: 1 },
      update: {},
    });
    return event;
  });
}

export async function processPayment(eventId: string) {
  const event = await db.providerEvent.findUniqueOrThrow({
    where: { id: eventId },
  });
  if (event.status === "processed") return;
  await recordPaidInvoice(PaidInvoice.parse(event.payload));
  await db.providerEvent.update({
    where: { id: event.id },
    data: { status: "processed", lastError: null },
  });
}
