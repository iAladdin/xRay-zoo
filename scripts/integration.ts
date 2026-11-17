import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../packages/core/db.js";
import { hashPassword, randomToken } from "../packages/core/crypto.js";
import { recordPaidInvoice } from "../packages/core/billing.js";
import {
  syncEntitlement,
  engineUsername,
} from "../packages/core/entitlements.js";
import { engine } from "../packages/engine-remnawave/client.js";
import { settings } from "../packages/core/config.js";
const user = await db.user.create({
  data: {
    email: "integration-" + randomUUID() + "@example.com",
    passwordHash: await hashPassword(randomToken()),
  },
});
const plan = await db.plan.findUniqueOrThrow({ where: { id: "p0-20gb" } });
const order = await db.order.create({
  data: {
    userId: user.id,
    planId: plan.id,
    provider: "dev",
    idempotencyKey: randomUUID(),
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    quotaBytes: plan.quotaBytes,
    regions: plan.regions,
  },
});
const now = new Date(),
  end = new Date(Date.now() + 600_000);
const invoice = {
  provider: "dev" as const,
  invoiceId: "integration-" + randomUUID(),
  orderId: order.id,
  amountMinor: order.amountMinor,
  currency: order.currency,
  startAt: now.toISOString(),
  endAt: end.toISOString(),
};
await assert.rejects(
  recordPaidInvoice({ ...invoice, amountMinor: invoice.amountMinor - 1 }),
  /PAYMENT_ORDER_MISMATCH/,
);
const deliveries = await Promise.all([
  recordPaidInvoice(invoice),
  recordPaidInvoice(invoice),
]);
assert.equal(deliveries.filter((v) => !v.duplicate).length, 1);
assert.equal(await db.servicePeriod.count({ where: { orderId: order.id } }), 1);
const subId = deliveries[0].subscriptionId;
// The real worker may acquire this same subscription; retry only the explicit lease conflict.
async function sync() {
  for (let i = 0; i < 15; i++) {
    try {
      await syncEntitlement(subId);
      return;
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "ENTITLEMENT_BUSY") throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Lease did not clear");
}
await sync();
let sub = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
assert.equal(sub.status, "active");
assert.equal(sub.appliedVersion, sub.desiredVersion);
assert.ok(sub.tokenHash && sub.accessUuidCipher);
let observed = await engine.findUser(engineUsername(subId));
assert.equal(observed?.status, "ACTIVE");
assert.equal(observed?.activeInternalSquads?.length, 5);
const identity = observed!.vlessUuid;
await sync();
observed = await engine.findUser(engineUsername(subId));
assert.equal(observed?.vlessUuid, identity);
await db.subscription.update({
  where: { id: subId },
  data: { status: "suspended", desiredVersion: { increment: 1 } },
});
await sync();
observed = await engine.findUser(engineUsername(subId));
assert.notEqual(observed?.status, "ACTIVE");
const wrongOrigin = await fetch(settings.apiOrigin + "/auth/register", {
  method: "POST",
  headers: {
    Origin: "https://example.com",
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(wrongOrigin.status, 403);
const unauthenticated = await fetch(settings.apiOrigin + "/admin/nodes");
assert.equal(unauthenticated.status, 401);
const badToken = await fetch(settings.apiOrigin + "/s/" + randomToken());
assert.equal(badToken.status, 403);
const badWebhook = await fetch(settings.apiOrigin + "/webhooks/stripe", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "stripe-signature": "invalid",
  },
  body: "{}",
});
assert.equal(badWebhook.status, 400);
console.log(
  "PASS: wrong amount rejected; concurrent duplicate invoice grants once; real engine activation + stable identity + five region squads + revocation; Origin, admin auth, invalid subscription, webhook signature checks.",
);
console.log(
  "Integration identity remains suspended for audit. No real charge was made.",
);
await db.$disconnect();
