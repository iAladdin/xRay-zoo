import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { db } from "../packages/core/db.js";
import { root, settings } from "../packages/core/config.js";
import { hashPassword, randomToken, unseal } from "../packages/core/crypto.js";
import {
  syncEntitlement,
  engineUsername,
} from "../packages/core/entitlements.js";
import { engine } from "../packages/engine-remnawave/client.js";
import { recordPaidInvoice } from "../packages/core/billing.js";
const exec = promisify(execFile),
  runId = randomUUID(),
  live = !!process.env.PROBE_INTERFACE,
  keep = process.env.KEEP_TEST_ACCOUNT === "1";
const fixtures: {
  userId: string;
  subId: string;
  cookie: string;
  email: string;
  password: string;
}[] = [];
const clients: ReturnType<typeof spawn>[] = [];
const binary =
  process.env.MIHOMO_BINARY ??
  "/Users/aladdin/Library/Application Support/mClash/core/mihomo";
let passed = false;
async function http(path: string, cookie = "", body?: unknown, expected = 200) {
  const response = await fetch(settings.apiOrigin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: settings.webOrigin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(
    response.status === expected,
    `${path.split("?")[0]} returned ${response.status}, expected ${expected}`,
  );
  return response;
}
async function json(path: string, cookie = "", body?: unknown, expected = 200) {
  return (await http(path, cookie, body, expected)).json();
}
async function sync(id: string) {
  for (let i = 0; i < 15; i++) {
    try {
      await syncEntitlement(id);
      return;
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "ENTITLEMENT_BUSY") throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Sync lease did not clear");
}
async function create(suffix: string) {
  const email = `customer-qa-${runId.slice(0, 8)}-${suffix}@example.com`,
    password = randomToken();
  const u = await db.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
  const plan = await db.plan.findUniqueOrThrow({ where: { id: "p0-20gb" } });
  const s = await db.subscription.create({
    data: { userId: u.id, regions: plan.regions, desiredVersion: 1 },
  });
  const item = { userId: u.id, subId: s.id, email, password, cookie: "" };
  fixtures.push(item);
  const o = await db.order.create({
    data: {
      userId: u.id,
      planId: plan.id,
      provider: "dev",
      status: "paid",
      idempotencyKey: randomUUID(),
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      quotaBytes: plan.quotaBytes,
      regions: plan.regions,
    },
  });
  await db.servicePeriod.create({
    data: {
      subscriptionId: s.id,
      orderId: o.id,
      provider: "dev",
      invoiceId: runId + suffix,
      startAt: new Date(Date.now() - 60000),
      endAt: new Date(Date.now() + 3600000),
      quotaBytes: plan.quotaBytes,
    },
  });
  await sync(s.id);
  const login = await http("/auth/login", "", { email, password }, 201);
  item.cookie = login.headers.get("set-cookie")!.split(";")[0];
  return item;
}
async function startClient(yaml: string, port: number) {
  const config = parse(yaml);
  const jp = config.proxies.find(
    (p: { name: string }) => p.name === "xz-p0-jp",
  );
  assert(jp);
  const dir = root + "/.local/account-probe/" + runId + "-" + port;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    dir + "/client.yaml",
    stringify({
      "mixed-port": port,
      "bind-address": "127.0.0.1",
      "allow-lan": false,
      mode: "rule",
      "log-level": "silent",
      proxies: [{ ...jp, "interface-name": process.env.PROBE_INTERFACE }],
      rules: ["MATCH," + jp.name],
    }),
    { mode: 0o600 },
  );
  const client = spawn(binary, ["-d", dir, "-f", dir + "/client.yaml"], {
    stdio: "ignore",
  });
  clients.push(client);
  await new Promise((r) => setTimeout(r, 1200));
  return async () => {
    const result = await exec(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "7",
        "--proxy",
        `socks5h://127.0.0.1:${port}`,
        "--noproxy",
        "",
        "https://api.ipify.org",
      ],
      { timeout: 9000 },
    );
    assert(result.stdout.trim() === jp.server, "Unexpected exit IP");
  };
}
try {
  for (const path of ["/account", "/account/config", "/account/billing"])
    await http(path, "", undefined, 401);
  for (const path of [
    "/account/subscription/revoke",
    "/account/subscription/regenerate",
  ])
    await http(path, "", {}, 401);
  const alice = await create("a"),
    bob = await create("b");
  const a = await json("/account", alice.cookie),
    b = await json("/account", bob.cookie);
  assert(
    a.user.email === alice.email &&
      a.orders.every(
        (o: { id: string }) =>
          !b.orders.some((p: { id: string }) => p.id === o.id),
      ),
    "Cross-account order leakage",
  );
  assert(a.orders.every((o: { planId: string }) => o.planId === "p0-20gb"));
  assert(
    !/"(?:passwordHash|tokenHash|tokenCipher|accessUuidCipher|engineUserId)"/.test(
      JSON.stringify(a),
    ),
    "Private fields returned",
  );
  const response = await http(
    "/account/config?userId=" + bob.userId,
    alice.cookie,
  );
  const oldYaml = await response.text();
  assert(response.headers.get("cache-control")?.includes("no-store"));
  assert(
    response.headers.get("content-disposition")?.includes("xray-zoo.yaml"),
  );
  const usageHeader = response.headers.get("subscription-userinfo");
  assert(usageHeader, "Missing subscription usage metadata");
  const metadata = Object.fromEntries(
    usageHeader.split(";").map((part) => part.trim().split("=")),
  );
  assert.equal(
    BigInt(metadata.upload) + BigInt(metadata.download),
    BigInt(a.subscription.usedBytes),
  );
  assert.equal(BigInt(metadata.total), BigInt(a.subscription.quotaBytes));
  assert.equal(
    Number(metadata.expire),
    Math.floor(new Date(a.subscription.validUntil).getTime() / 1000),
  );
  assert.equal(response.headers.get("profile-update-interval"), "1");
  assert.equal(
    response.headers.get("profile-web-page-url"),
    new URL("/account", settings.webOrigin).href,
  );
  const exposed = response.headers
    .get("access-control-expose-headers")
    ?.toLowerCase()
    .split(",")
    .map((x) => x.trim());
  for (const name of [
    "subscription-userinfo",
    "profile-update-interval",
    "profile-web-page-url",
    "content-disposition",
  ])
    assert(exposed?.includes(name), `Browser cannot read ${name}`);
  // A client imports the token URL without a login cookie. HEAD must carry the
  // same metadata and no body, while GET still produces the original YAML.
  for (const method of ["GET", "HEAD"]) {
    const imported = await fetch(a.subscription.url, {
      method,
      headers: { "User-Agent": "clash.meta", Origin: settings.webOrigin },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.headers.get("subscription-userinfo"), usageHeader);
    assert(imported.headers.get("cache-control")?.includes("no-store"));
    assert(
      (await imported.text()) === (method === "HEAD" ? "" : oldYaml),
      "Token import changed configuration or HEAD returned a body",
    );
  }
  const oldUuid = parse(oldYaml).proxies[0].uuid,
    bobYaml = await (await http("/account/config", bob.cookie)).text();
  assert(
    oldUuid !== parse(bobYaml).proxies[0].uuid,
    "Downloaded foreign identity",
  );
  await http(
    "/account/subscription/revoke",
    alice.cookie,
    { expectedVersion: a.subscription.version, userId: bob.userId },
    400,
  );
  await http(
    "/account/subscription/revoke",
    alice.cookie,
    { expectedVersion: -1 },
    400,
  );
  await http(
    "/account/subscription/regenerate",
    bob.cookie,
    { expectedVersion: b.subscription.version },
    409,
  );
  let oldRequest: (() => Promise<void>) | undefined;
  if (live) {
    oldRequest = await startClient(oldYaml, 19940);
    await oldRequest();
    await sync(alice.subId);
  }
  const before = await db.subscription.findUniqueOrThrow({
    where: { id: alice.subId },
  });
  await http(
    "/account/subscription/revoke",
    alice.cookie,
    { expectedVersion: before.desiredVersion },
    201,
  );
  for (const method of ["GET", "HEAD"]) {
    const denied = await fetch(a.subscription.url, { method });
    assert.equal(denied.status, 403, "Revoked link is still downloadable");
    assert.equal(denied.headers.get("subscription-userinfo"), null);
  }
  await http("/account/config", alice.cookie, undefined, 403);
  const revokedImmediate = await json("/account", alice.cookie);
  assert(revokedImmediate.subscription.url === null);
  assert((await json("/me", alice.cookie)).subscription.url === null);
  await sync(alice.subId);
  assert(
    (await engine.findUser(engineUsername(alice.subId)))?.status === "DISABLED",
  );
  if (oldRequest)
    await assert.rejects(oldRequest, "Cached YAML still connects after revoke");
  const revoked = await db.subscription.findUniqueOrThrow({
    where: { id: alice.subId },
  });
  assert(revoked.status === "revoked" && !!revoked.revokedAt);
  await http(
    "/account/subscription/revoke",
    alice.cookie,
    { expectedVersion: before.desiredVersion },
    201,
  );
  assert(
    (await db.subscription.findUniqueOrThrow({ where: { id: alice.subId } }))
      .desiredVersion === revoked.desiredVersion,
    "Repeated revoke changed version",
  );
  await sync(alice.subId);
  assert(
    (await db.subscription.findUniqueOrThrow({ where: { id: alice.subId } }))
      .status === "revoked",
    "Reconcile reactivated revoked access",
  );
  assert(
    (await db.subscription.findUniqueOrThrow({ where: { id: bob.subId } }))
      .status === "active",
    "Revoke affected another account",
  );
  await db.subscription.update({
    where: { id: alice.subId },
    data: { status: "suspended" },
  });
  await http(
    "/account/subscription/regenerate",
    alice.cookie,
    { expectedVersion: revoked.desiredVersion },
    403,
  );
  await db.subscription.update({
    where: { id: alice.subId },
    data: { status: "revoked" },
  });
  await http(
    "/account/subscription/regenerate",
    alice.cookie,
    { expectedVersion: revoked.desiredVersion },
    201,
  );
  // Simulate a crash after the provider accepted rotation but before our database acknowledged it.
  const lease = "account-test-" + runId;
  await db.subscription.update({
    where: { id: alice.subId },
    data: {
      syncLeaseOwner: lease,
      syncLeaseUntil: new Date(Date.now() + 30000),
    },
  });
  const engineBefore = await engine.findUser(engineUsername(alice.subId));
  assert(engineBefore);
  let rotatedUuid = engineBefore.vlessUuid;
  if (rotatedUuid === oldUuid) {
    const rotated = await engine.request<{ vlessUuid: string }>(
      `/users/${engineBefore.id}/actions/revoke`,
      "POST",
      { revokeOnlyPasswords: true },
    );
    rotatedUuid = rotated.vlessUuid;
  }
  await db.subscription.update({
    where: { id: alice.subId },
    data: { syncLeaseOwner: null, syncLeaseUntil: null },
  });
  await sync(alice.subId);
  const regenerated = await db.subscription.findUniqueOrThrow({
    where: { id: alice.subId },
  });
  assert(
    regenerated.status === "active" && !regenerated.revokedAt,
    "Regeneration did not activate",
  );
  assert(
    unseal(regenerated.accessUuidCipher!) === rotatedUuid &&
      rotatedUuid !== oldUuid,
    "Retry rotated credentials twice or reused old identity",
  );
  assert(
    regenerated.validUntil?.getTime() === before.validUntil?.getTime() &&
      regenerated.quotaBytes === before.quotaBytes &&
      regenerated.usedBytes >= before.usedBytes,
    "Rotation changed paid entitlement or reset usage",
  );
  assert(
    (await fetch(a.subscription.url)).status === 403,
    "Old URL returned after regeneration",
  );
  const newYaml = await (await http("/account/config", alice.cookie)).text();
  assert(
    parse(newYaml).proxies[0].uuid !== oldUuid,
    "New YAML reused old UUID",
  );
  await sync(alice.subId);
  assert(
    (await engine.findUser(engineUsername(alice.subId)))?.vlessUuid ===
      rotatedUuid,
    "Reconciliation rotated credentials repeatedly",
  );
  if (live) {
    const newRequest = await startClient(newYaml, 19941);
    await newRequest();
    await assert.rejects(oldRequest!, "Old cached YAML became valid again");
  }
  const bobBefore = await db.subscription.findUniqueOrThrow({
    where: { id: bob.subId },
  });
  await http(
    "/account/subscription/revoke",
    bob.cookie,
    { expectedVersion: bobBefore.desiredVersion },
    201,
  );
  await sync(bob.subId);
  const bobOrder = await db.order.findFirstOrThrow({
    where: { userId: bob.userId },
  });
  const renewalEnd = new Date(Date.now() + 7200000);
  await recordPaidInvoice({
    provider: "dev",
    invoiceId: runId + "-renewal",
    orderId: bobOrder.id,
    amountMinor: bobOrder.amountMinor,
    currency: bobOrder.currency,
    startAt: new Date(Date.now() - 1000).toISOString(),
    endAt: renewalEnd.toISOString(),
  });
  await sync(bob.subId);
  const renewed = await json("/account", bob.cookie);
  assert(
    renewed.subscription.revokedAt &&
      renewed.subscription.status === "revoked" &&
      !renewed.subscription.url,
  );
  assert(
    renewed.subscription.validUntil === renewalEnd.toISOString(),
    "Revoked account shows stale paid period after renewal",
  );
  assert(
    (await engine.findUser(engineUsername(bob.subId)))?.status === "DISABLED",
    "Renewal reactivated revoked identity",
  );
  await http("/account/config", bob.cookie, undefined, 403);
  const proof = {
    at: new Date().toISOString(),
    ownerIsolation: true,
    oldLinkDenied: true,
    oldCachedYamlDenied: live,
    newConfigConnects: live,
    quotaAndExpiryPreserved: true,
    rotationCrashRecovery: true,
    adminSuspensionRespected: true,
    renewalPreservesRevocationAndUpdatesPeriod: true,
    subscriptionUsageHeaders: true,
    cookieFreeGetAndHead: true,
  };
  writeFileSync(
    root + "/.local/account-validation.json",
    JSON.stringify(proof, null, 2),
    { mode: 0o600 },
  );
  if (keep)
    writeFileSync(root + "/.local/customer-ui.json", JSON.stringify(alice), {
      mode: 0o600,
    });
  passed = true;
  console.log(
    "PASS: subscription usage headers on GET/HEAD and browser exposure; owner-only configuration/orders; revoked URL and cached YAML; regenerate with new identity; preserved quota/expiry; durable rotation retry; administrator suspension cannot be bypassed. Live client checks: " +
      live,
  );
} finally {
  for (const c of clients) c.kill("SIGTERM");
  for (const [index, f] of fixtures.entries()) {
    if (keep && passed && index === 0) continue;
    await db.subscription.updateMany({
      where: { id: f.subId },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        syncLeaseOwner: null,
        syncLeaseUntil: null,
        desiredVersion: { increment: 1 },
      },
    });
    await sync(f.subId).catch(() => {});
    const u = await engine.findUser(engineUsername(f.subId));
    if (u)
      await engine.updateUser(engineUsername(f.subId), { status: "DISABLED" });
    await db.outbox.deleteMany({ where: { aggregateId: f.subId } });
    await db.servicePeriod.deleteMany({ where: { subscriptionId: f.subId } });
    await db.subscription.delete({ where: { id: f.subId } });
    await db.session.deleteMany({ where: { userId: f.userId } });
    await db.order.deleteMany({ where: { userId: f.userId } });
    await db.user.delete({ where: { id: f.userId } });
  }
  await db.$disconnect();
}
