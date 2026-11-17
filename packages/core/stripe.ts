import Stripe from "stripe";
import { db } from "./db.js";
import { required, settings } from "./config.js";
import { receiveInvoiceEvent } from "./billing.js";

export function stripeClient() {
  const key = required("STRIPE_SECRET_KEY");
  if (!/^(sk|rk)_test_/.test(key))
    throw new Error("STRIPE_SANDBOX_KEY_REQUIRED");
  return new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 });
}
export async function createStripeCheckout(orderId: string) {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { plan: true, user: true },
  });
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: "subscription",
      client_reference_id: order.id,
      customer_email: order.user.email,
      metadata: { orderId: order.id, application: "xray-zoo" },
      subscription_data: {
        metadata: { orderId: order.id, application: "xray-zoo" },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: order.currency,
            unit_amount: order.amountMinor,
            recurring: { interval: "month" },
            product_data: { name: order.plan.name },
          },
        },
      ],
      success_url: settings.webOrigin + "/?checkout=returned",
      cancel_url: settings.webOrigin + "/?checkout=cancelled",
    },
    { idempotencyKey: "xz-checkout-" + order.id },
  );
  if (session.livemode || !session.url)
    throw new Error("INVALID_CHECKOUT_MODE");
  return db.order.update({
    where: { id: order.id },
    data: { checkoutId: session.id, checkoutUrl: session.url },
  });
}

// Only a verified Stripe invoice grants service; a browser redirect never grants access.
export async function acceptStripeEvent(raw: Buffer, signature: string) {
  const stripe = stripeClient();
  const signingSecret = required("STRIPE_WEBHOOK_SECRET");
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, signingSecret);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError)
      throw new Error("STRIPE_SIGNATURE_INVALID");
    throw error;
  }
  if (event.livemode) throw new Error("LIVE_EVENT_REJECTED");
  if (event.type !== "invoice.paid") return { ignored: true };
  const invoice = await stripe.invoices.retrieve(event.data.object.id);
  const details = invoice.parent?.subscription_details;
  const orderId = details?.metadata?.orderId;
  if (!orderId || details?.metadata?.application !== "xray-zoo")
    return { ignored: true };
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const subscriptionId =
    typeof details.subscription === "string"
      ? details.subscription
      : details.subscription?.id;
  if (
    !subscriptionId ||
    invoice.livemode ||
    invoice.status !== "paid" ||
    !["subscription_create", "subscription_cycle"].includes(
      invoice.billing_reason ?? "",
    ) ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1
  )
    throw new Error("UNSUPPORTED_INVOICE");
  const line = invoice.lines.data[0];
  if (
    order.provider !== "stripe" ||
    invoice.amount_paid !== order.amountMinor ||
    invoice.total !== order.amountMinor ||
    line.amount !== order.amountMinor ||
    invoice.currency !== order.currency ||
    line.quantity !== 1
  )
    throw new Error("PAYMENT_ORDER_MISMATCH");
  const bound = await db.order.updateMany({
    where: {
      id: orderId,
      OR: [
        { providerSubscriptionId: null },
        { providerSubscriptionId: subscriptionId },
      ],
    },
    data: { providerSubscriptionId: subscriptionId },
  });
  if (!bound.count) throw new Error("SUBSCRIPTION_BINDING_CONFLICT");
  await receiveInvoiceEvent("stripe", event.id, {
    provider: "stripe",
    invoiceId: invoice.id,
    orderId,
    amountMinor: invoice.amount_paid,
    currency: invoice.currency,
    startAt: new Date(line.period.start * 1000).toISOString(),
    endAt: new Date(line.period.end * 1000).toISOString(),
  });
  return { accepted: true };
}
