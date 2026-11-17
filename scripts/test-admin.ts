import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { db } from "../packages/core/db.js";
import { root, settings } from "../packages/core/config.js";
import {
  hashPassword,
  hashToken,
  randomToken,
  unseal,
} from "../packages/core/crypto.js";
import {
  syncEntitlement,
  engineUsername,
} from "../packages/core/entitlements.js";
import { engine } from "../packages/engine-remnawave/client.js";
const id = randomUUID(),
  email = `admin-qa-${id}@example.com`,
  password = randomToken();
const planId = "qa-" + id.slice(0, 8);
let userId = "",
  subId = "",
  adminCookie = "",
  customerCookie = "";
async function http(path: string, cookie = "", body?: unknown, expected = 200) {
  const r = await fetch("http://127.0.0.1:3101" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: settings.webOrigin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, expected, `${path}: ${JSON.stringify(data)}`);
  return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
try {
  const admin = JSON.parse(
    readFileSync(resolve(root, ".local/operator-admin.json"), "utf8"),
  );
  adminCookie = (
    await http(
      "/auth/login",
      "",
      { email: admin.email, password: admin.password },
      201,
    )
  ).cookie;
  const u = await db.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
  userId = u.id;
  customerCookie = (await http("/auth/login", "", { email, password }, 201))
    .cookie;
  for (const path of [
    "/admin/overview",
    "/admin/nodes",
    "/admin/users",
    "/admin/plans",
    "/admin/orders",
    "/admin/subscriptions",
    "/admin/audit",
    "/admin/machines",
  ]) {
    await http(path, "", undefined, 401);
    await http(path, customerCookie, undefined, 403);
    const { data } = await http(path, adminCookie);
    assert(
      !/"(?:passwordHash|tokenHash|tokenCipher|accessUuidCipher|publicKey|shortId|checkoutUrl)"/.test(
        JSON.stringify(data),
      ),
    );
  }
  for (const path of [
    "/admin/nodes/refresh",
    "/admin/nodes/xz-p0-tw/action",
    "/admin/plans",
    "/admin/subscriptions/missing/action",
    "/admin/subscriptions/missing/link",
    "/admin/machines",
    "/admin/machines/preview",
    `/admin/machines/${id}/retry`,
    "/admin/nodes/xz-p0-jp/ip-rotation/preview",
    "/admin/nodes/xz-p0-jp/ip-rotation",
    `/admin/ip-rotations/${id}/retry`,
    `/admin/ip-rotations/${id}/rollback`,
  ]) {
    await http(path, "", {}, 401);
    await http(path, customerCookie, {}, 403);
  }
  for (const path of [
    "/admin/azure/locations",
    "/admin/azure/skus?region=eastus2",
    `/admin/machines/${id}`,
    `/admin/ip-rotations/${id}`,
  ]) {
    await http(path, "", undefined, 401);
    await http(path, customerCookie, undefined, 403);
  }
  await http(
    "/admin/nodes/xz-p0-jp/ip-rotation",
    adminCookie,
    { planId: id, idempotencyKey: randomUUID(), address: "untrusted" },
    400,
  );
  await http(
    "/admin/nodes/xz-p0-jp/ip-rotation",
    adminCookie,
    { planId: id, idempotencyKey: randomUUID() },
    404,
  );
  await http(`/admin/ip-rotations/${id}`, adminCookie, undefined, 404);
  await http(`/admin/ip-rotations/${id}/retry`, adminCookie, {}, 409);
  await http(`/admin/ip-rotations/${id}/rollback`, adminCookie, {}, 409);
  await http(
    "/admin/machines",
    adminCookie,
    { planId: id, idempotencyKey: randomUUID(), script: "untrusted" },
    400,
  );
  await http(
    "/admin/machines",
    adminCookie,
    { planId: id, idempotencyKey: randomUUID() },
    404,
  );
  await http(
    "/admin/machines/preview",
    adminCookie,
    { region: "eastus2", size: "Standard_B2ats_v2", subscription: "untrusted" },
    400,
  );
  await http(
    "/admin/azure/skus?region=../untrusted",
    adminCookie,
    undefined,
    400,
  );
  await http("/admin/users?page=0", adminCookie, undefined, 400);
  await http(
    "/admin/plans",
    adminCookie,
    {
      id: planId,
      name: "后台验证套餐",
      amountMinor: 999,
      currency: "USD",
      quotaGB: 1,
      regions: ["JP", "SG", "US", "HK", "TW"],
      active: false,
    },
    201,
  );
  const order = await db.order.create({
    data: {
      userId,
      planId,
      provider: "dev",
      status: "paid",
      idempotencyKey: randomUUID(),
      amountMinor: 999,
      currency: "USD",
      quotaBytes: 1_000_000_000n,
      regions: ["JP", "SG", "US", "HK", "TW"],
    },
  });
  await http(
    "/admin/plans",
    adminCookie,
    {
      id: planId,
      name: "后台验证套餐",
      amountMinor: 1999,
      currency: "USD",
      quotaGB: 2,
      regions: ["JP"],
      active: false,
    },
    201,
  );
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).amountMinor,
    999,
  );
  const subscription = await db.subscription.create({
    data: { userId, regions: order.regions, desiredVersion: 1 },
  });
  subId = subscription.id;
  await db.servicePeriod.create({
    data: {
      subscriptionId: subId,
      orderId: order.id,
      provider: "dev",
      invoiceId: id,
      startAt: new Date(Date.now() - 1000),
      endAt: new Date(Date.now() + 600000),
      quotaBytes: order.quotaBytes,
    },
  });
  async function sync() {
    for (let n = 0; n < 10; n++) {
      try {
        await syncEntitlement(subId);
        return;
      } catch (e) {
        if (e instanceof Error && e.message === "ENTITLEMENT_BUSY") {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
    throw new Error("sync did not settle");
  }
  await sync();
  let s = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
  assert.equal(s.status, "active");
  assert.equal(s.quotaBytes, 1_000_000_000n);
  const oldToken = unseal(s.tokenCipher!);
  const link = (
    await http(`/admin/subscriptions/${subId}/link`, adminCookie, {}, 201)
  ).data.url;
  assert.equal(link, settings.subscriptionOrigin + "/s/" + oldToken);
  // Two operators acting on the same displayed version: one succeeds, one conflicts.
  const responses = await Promise.all(
    ["suspend", "suspend"].map((action) =>
      fetch(`http://127.0.0.1:3101/admin/subscriptions/${subId}/action`, {
        method: "POST",
        headers: {
          Origin: settings.webOrigin,
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          expectedVersion: s.desiredVersion,
          reason: "自动化管理权限与并发验证",
        }),
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  await sync();
  s = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
  assert.equal(s.status, "suspended");
  assert.equal(
    (await engine.findUser(engineUsername(subId)))?.status,
    "DISABLED",
  );
  await http("/s/" + oldToken, "", undefined, 403);
  await http(
    `/admin/subscriptions/${subId}/action`,
    adminCookie,
    {
      action: "resume",
      expectedVersion: s.desiredVersion,
      reason: "验证恢复原服务期",
    },
    201,
  );
  await sync();
  s = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
  assert.equal(s.status, "active");
  await http(
    `/admin/subscriptions/${subId}/action`,
    adminCookie,
    {
      action: "rotate-link",
      expectedVersion: s.desiredVersion,
      reason: "验证旧链接失效",
    },
    201,
  );
  await sync();
  const rotated = await db.subscription.findUniqueOrThrow({
    where: { id: subId },
  });
  assert.notEqual(rotated.tokenHash, hashToken(oldToken));
  assert.equal(unseal(rotated.accessUuidCipher!), unseal(s.accessUuidCipher!));
  await http("/s/" + oldToken, "", undefined, 403);
  const yaml = await fetch(
    "http://127.0.0.1:3101/s/" + unseal(rotated.tokenCipher!),
  );
  assert.equal(yaml.status, 200);
  assert((await yaml.text()).includes("xz-p0-tw"));
  assert((await db.auditLog.count({ where: { targetId: subId } })) >= 3);
  const text = JSON.stringify(
    (await http("/admin/users?q=" + encodeURIComponent(email), adminCookie))
      .data,
  );
  assert(text.includes(email));
  assert(!text.includes("passwordHash"));
  console.log(
    "PASS: all admin routes require ADMIN; paginated/searchable sanitized records; frozen order price; concurrent action conflict; suspend/resume engine readback; link rotation; audit trail.",
  );
} finally {
  if (subId) {
    await db.subscription.update({
      where: { id: subId },
      data: { status: "suspended", desiredVersion: { increment: 1 } },
    });
    try {
      await syncEntitlement(subId);
    } catch {}
    const u = await engine.findUser(engineUsername(subId));
    if (u)
      await engine.updateUser(engineUsername(subId), { status: "DISABLED" });
    await db.outbox.deleteMany({ where: { aggregateId: subId } });
    await db.servicePeriod.deleteMany({ where: { subscriptionId: subId } });
    await db.subscription.delete({ where: { id: subId } });
  }
  if (userId) {
    await db.session.deleteMany({ where: { userId } });
    await db.order.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
  }
  await db.plan.deleteMany({ where: { id: planId } });
  if (adminCookie) await http("/auth/logout", adminCookie, {}, 201);
  await db.$disconnect();
}
