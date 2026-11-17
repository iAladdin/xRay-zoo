import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { root } from "../packages/core/config.js";
import type {
  MaintenanceItem,
  MaintenanceDriver,
} from "../packages/core/node-maintenance.js";
const admin = new PrismaClient();
const schema = "qa_maintenance_" + randomUUID().replaceAll("-", "");
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("schema", schema);
process.env.DATABASE_URL = url.toString();
const { db } = await import("../packages/core/db.js");
const { createMaintenance, advanceMaintenance, maintenanceView } = await import(
  "../packages/core/node-maintenance.js"
);
const { createRotation } = await import("../packages/core/ip-rotation.js");
const calls: string[] = [];
const driver: MaintenanceDriver = {
  async execute(id, action) {
    calls.push(id + ":" + action);
    if (id === "qa-fails") throw new Error("PRIVATE_ERROR_MUST_NOT_LEAK");
  },
  rotate: createRotation,
};
const row = (id: string) =>
  db.nodeMaintenanceBatch.findUniqueOrThrow({ where: { id } });
const items = async (id: string) =>
  (await row(id)).items as unknown as MaintenanceItem[];
const request = (nodeIds: string[], action = "reconnect") => ({
  nodeIds,
  action,
  idempotencyKey: randomUUID(),
});
async function step(id: string, count = 1) {
  for (let i = 0; i < count; i++) await advanceMaintenance(id, driver);
}
try {
  execFileSync(
    process.execPath,
    [root + "node_modules/prisma/build/index.js", "migrate", "deploy"],
    { cwd: root, env: process.env, stdio: "pipe", timeout: 60_000 },
  );
  for (const id of ["qa-good", "qa-fails", "qa-busy", "qa-new"])
    await db.node.create({
      data: {
        id,
        name: id,
        country: "JP",
        region: "japaneast",
        address: "8.8.8.8",
        publicKey: "a".repeat(43),
        shortId: "abcd",
        serverName: "example.com",
        engineNodeId: randomUUID(),
        squadId: randomUUID(),
        ...(id === "qa-busy" ? { activeIpRotationId: randomUUID() } : {}),
        ...(id === "qa-new" ? { publishedAt: null } : {}),
      },
    });
  for (const input of [
    request([]),
    request(["qa-good", "qa-good"]),
    request(["qa-good"], "delete"),
    request(["qa-good"], "rotate-ip"),
    { ...request(["qa-good"]), script: "untrusted" },
    request(Array.from({ length: 51 }, (_, i) => "n" + i)),
  ])
    await assert.rejects(() => createMaintenance("operator", input));
  const input = request([
    "qa-fails",
    "qa-good",
    "qa-busy",
    "qa-new",
    "missing",
  ]);
  const duplicates = await Promise.all([
    createMaintenance("operator", input),
    createMaintenance("operator", input),
  ]);
  assert.equal(duplicates[0].id, duplicates[1].id);
  assert.equal(await db.nodeMaintenanceBatch.count(), 1);
  await assert.rejects(() =>
    createMaintenance("operator", { ...input, action: "restart" }),
  );
  const batch = duplicates[0];
  assert.equal(batch.counts.skipped, 3);
  await db.nodeMaintenanceBatch.update({
    where: { id: batch.id },
    data: {
      leaseOwner: "another-worker",
      leaseUntil: new Date(Date.now() + 100_000),
    },
  });
  await step(batch.id);
  assert.equal(calls.length, 0);
  await db.nodeMaintenanceBatch.update({
    where: { id: batch.id },
    data: { leaseUntil: new Date(Date.now() - 1) },
  });
  await step(batch.id, 2);
  const result = maintenanceView(await row(batch.id));
  assert.equal(result.status, "complete");
  assert.equal(result.counts.succeeded, 1);
  assert.equal(result.counts.failed, 1);
  assert(!JSON.stringify(result).includes("PRIVATE_ERROR"));
  assert.deepEqual(calls, ["qa-fails:reconnect", "qa-good:reconnect"]);
  await step(batch.id);
  assert.equal(calls.length, 2);
  // State may change after submission: re-check before sending the side effect.
  const later = await createMaintenance("operator", request(["qa-good"]));
  await db.node.update({
    where: { id: "qa-good" },
    data: { activeIpRotationId: randomUUID() },
  });
  await step(later.id);
  assert.equal((await items(later.id))[0].status, "skipped");
  assert.equal(calls.length, 2);
  await db.node.update({
    where: { id: "qa-good" },
    data: { activeIpRotationId: null },
  });
  // Interrupted command: preserve uncertainty, never replay a restart automatically.
  const interrupted = await createMaintenance(
    "operator",
    request(["qa-good"], "restart"),
  );
  const interruptedItems = await items(interrupted.id);
  interruptedItems[0].status = "running";
  await db.nodeMaintenanceBatch.update({
    where: { id: interrupted.id },
    data: { items: interruptedItems },
  });
  await step(interrupted.id);
  assert.equal((await items(interrupted.id))[0].status, "unknown");
  assert.equal(calls.length, 2);
  // All four ordinary actions use the same node-level executor and actor.
  for (const action of ["enable", "disable", "restart", "reconnect"]) {
    const b = await createMaintenance("operator", request(["qa-good"], action));
    await step(b.id);
    assert.equal((await items(b.id))[0].status, "accepted");
    assert.equal(calls.at(-1), "qa-good:" + action);
  }
  // Reusing an IP preflight from another operator must never submit a rotation.
  async function plan(actorId = "operator") {
    return db.provisionPlan.create({
      data: {
        actorId,
        kind: "ip-rotation",
        expiresAt: new Date(Date.now() + 600_000),
        snapshot: {
          nodeId: "qa-good",
          oldAddress: "8.8.8.8",
          hostKey: "PRIVATE_PLAN_SENTINEL",
        },
      },
    });
  }
  const foreign = await plan("another");
  const denied = await createMaintenance("operator", {
    ...request(["qa-good"], "rotate-ip"),
    plans: [{ nodeId: "qa-good", planId: foreign.id }],
  });
  assert.equal(denied.counts.skipped, 1);
  assert.equal(await db.ipRotation.count(), 0);
  const p = await plan();
  const rotation = await createMaintenance("operator", {
    ...request(["qa-good"], "rotate-ip"),
    plans: [{ nodeId: "qa-good", planId: p.id }],
  });
  // Simulate acceptance followed by a lost response. Recover the original rotation.
  await advanceMaintenance(rotation.id, {
    ...driver,
    async rotate(...args) {
      await createRotation(...args);
      throw new Error("RESPONSE_LOST");
    },
  });
  const rotating = (await items(rotation.id))[0];
  assert(rotating.rotationId);
  assert.equal(rotating.status, "running");
  assert.equal(await db.ipRotation.count(), 1);
  const view = maintenanceView(await row(rotation.id));
  assert(!JSON.stringify(view).includes(p.id));
  assert(!JSON.stringify(view).includes("PRIVATE_PLAN"));
  await db.ipRotation.update({
    where: { id: rotating.rotationId },
    data: { status: "ready", phase: "ready" },
  });
  await step(rotation.id);
  assert.equal((await items(rotation.id))[0].status, "ready");
  assert.equal((await row(rotation.id)).status, "complete");
  // A process crash before writing rotationId can also recover via the item UUID.
  await db.node.update({
    where: { id: "qa-good" },
    data: { activeIpRotationId: null },
  });
  const p2 = await plan(),
    crash = await createMaintenance("operator", {
      ...request(["qa-good"], "rotate-ip"),
      plans: [{ nodeId: "qa-good", planId: p2.id }],
    });
  const crashItems = await items(crash.id);
  crashItems[0].status = "running";
  await db.nodeMaintenanceBatch.update({
    where: { id: crash.id },
    data: { items: crashItems },
  });
  const existing = await createRotation(
    "operator",
    "qa-good",
    p2.id,
    crashItems[0].id,
  );
  await step(crash.id);
  assert.equal((await items(crash.id))[0].rotationId, existing.id);
  assert.equal(await db.ipRotation.count(), 2);
  await db.ipRotation.update({
    where: { id: existing.id },
    data: { status: "failed", errorCode: "IP_ROTATION_TIMEOUT" },
  });
  await step(crash.id);
  assert.equal((await items(crash.id))[0].status, "failed");
  console.log(
    "PASS isolated batch maintenance: validation, idempotency, mixed results, node conflicts, leases, crash uncertainty, four actions, IP preflight ownership, rotation recovery and secret projection; no live node actions",
  );
} finally {
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
