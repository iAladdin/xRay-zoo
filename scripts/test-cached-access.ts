import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { db } from "../packages/core/db.js";
import { root } from "../packages/core/config.js";
import { syncEntitlement } from "../packages/core/entitlements.js";
import { unseal } from "../packages/core/crypto.js";
import {
  buildConfig,
  type SubscriptionNode,
} from "../packages/subscription/index.js";
const exec = promisify(execFile);
const sub = await db.subscription.findFirstOrThrow({
  where: {
    user: { email: { startsWith: "integration-" } },
    validUntil: { gt: new Date() },
  },
  orderBy: { createdAt: "desc" },
});
async function sync() {
  for (let i = 0; i < 15; i++) {
    try {
      await syncEntitlement(sub.id);
      return;
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "ENTITLEMENT_BUSY") throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("LEASE_TIMEOUT");
}
const dir = root + "/.local/revocation-test";
mkdirSync(dir, { recursive: true, mode: 0o700 });
let client: ReturnType<typeof spawn> | undefined;
try {
  await db.subscription.update({
    where: { id: sub.id },
    data: { status: "pending", desiredVersion: { increment: 1 } },
  });
  await sync();
  const active = await db.subscription.findUniqueOrThrow({
    where: { id: sub.id },
  });
  const node = await db.node.findFirstOrThrow({
    where: { country: "JP", ready: true },
  });
  const full = buildConfig(
    [node as SubscriptionNode],
    unseal(active.accessUuidCipher!),
  );
  const port = Number(process.env.PROBE_SOCKS_PORT || 0);
  const outbound = full.proxies.map((p: Record<string, unknown>) => ({
    ...p,
    ...(process.env.PROBE_INTERFACE
      ? { "interface-name": process.env.PROBE_INTERFACE }
      : {}),
  }));
  const proxies = port
    ? [
        ...outbound.map((p: object) => ({
          ...p,
          "dialer-proxy": "transport",
        })),
        { name: "transport", type: "socks5", server: "127.0.0.1", port },
      ]
    : outbound;
  writeFileSync(
    dir + "/cached.yaml",
    stringify({
      "mixed-port": 19850,
      "allow-lan": false,
      mode: "rule",
      "log-level": "silent",
      proxies,
      rules: ["MATCH," + node.name],
    }),
    { mode: 0o600 },
  );
  client = spawn(
    process.env.MIHOMO_BINARY ??
      "/Users/aladdin/Library/Application Support/mClash/core/mihomo",
    ["-d", dir, "-f", dir + "/cached.yaml"],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 1200));
  const request = () =>
    exec(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "8",
        "--proxy",
        "socks5h://127.0.0.1:19850",
        "--noproxy",
        "",
        "https://api.ipify.org",
      ],
      { timeout: 10_000 },
    );
  assert.equal((await request()).stdout.trim(), node.address);
  const start = Date.now();
  await db.subscription.update({
    where: { id: sub.id },
    data: { status: "suspended", desiredVersion: { increment: 1 } },
  });
  await sync();
  let denied = false;
  for (let i = 0; i < 8; i++) {
    try {
      await request();
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      denied = true;
      break;
    }
  }
  assert.ok(
    denied,
    "Cached credentials still establish new connections after revocation",
  );
  const report = {
    activeRequestPassed: true,
    cachedYamlNewConnectionDenied: true,
    observedWithinMs: Date.now() - start,
    existingLongLivedConnection: "not measured",
    at: new Date().toISOString(),
  };
  writeFileSync(
    root + "/.local/revocation-result.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await db.subscription.update({
    where: { id: sub.id },
    data: { status: "suspended", desiredVersion: { increment: 1 } },
  });
  await sync().catch(() => {});
  client?.kill("SIGTERM");
  await db.$disconnect();
}
