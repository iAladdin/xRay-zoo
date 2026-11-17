import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { root } from "../packages/core/config.js";
import type { LifecycleDriver } from "../packages/core/node-lifecycle.js";
import type { AzurePlanSnapshot } from "../packages/core/azure.js";
const admin = new PrismaClient(),
  schema = "qa_lifecycle_" + randomUUID().replaceAll("-", "");
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("schema", schema);
process.env.DATABASE_URL = url.toString();
const { db } = await import("../packages/core/db.js");
const {
  createLifecycle,
  advanceLifecycle,
  retryLifecycle,
  lifecycleSelect,
  lifecycleView,
} = await import("../packages/core/node-lifecycle.js");
const { createMaintenance, advanceMaintenance } = await import(
  "../packages/core/node-maintenance.js"
);
const { nodePoolWhere } = await import("../packages/core/node-pool.js");
const { retryMachine } = await import("../packages/core/provisioning.js");
const calls: string[] = [];
let done = false,
  failed = false;
const plan = {
  region: "japaneast",
  country: "JP",
  regionName: "Japan East",
  size: "Standard_B2ats_v2",
  subscription: randomUUID(),
  resourceGroup: "qa",
  managementSourceCidr: "192.0.2.1/32",
  controlAddress: "127.0.0.1",
  vcpus: 2,
  memoryGiB: 1,
  imageVersion: "qa",
  templateHash: "qa",
  cloudInitHash: "qa",
  nodeImage: "qa",
  diskType: "Standard_LRS",
  diskSizeGiB: 32,
  cost: {
    currency: "USD",
    computeHourly: 0.01,
    computeMonthly: 7.3,
    excludes: [],
  },
} satisfies AzurePlanSnapshot;
const driver: LifecycleDriver = {
  async inspect(n) {
    calls.push("inspect");
    return {
      region: n.region,
      size: plan.size,
      vmId: "qa-vm",
      resources: ["vm", "disk", "ip"],
    };
  },
  async preserve() {
    return "PRIVATE_CIPHER";
  },
  async drain() {
    calls.push("drain");
  },
  async meter() {
    calls.push("meter");
  },
  async suspend() {
    calls.push("suspend");
  },
  async release() {
    calls.push("release");
    if (failed) throw new Error("RELEASE_RESOURCE_CONFLICT");
    return { done, remaining: done ? 0 : 2 };
  },
  async verify() {
    return { done };
  },
  async prepare() {
    return plan;
  },
};
const row = (id: string) =>
  db.nodeLifecycle.findUniqueOrThrow({ where: { id } });
const batch = (id: string) =>
  db.nodeMaintenanceBatch.findUniqueOrThrow({ where: { id } });
async function fastDrain(id: string) {
  const op = await row(id);
  await db.nodeLifecycle.update({
    where: { id },
    data: {
      checkpoint: {
        ...(op.checkpoint as object),
        drainStartedAt: new Date(Date.now() - 20_000).toISOString(),
      },
    },
  });
}
try {
  execFileSync(
    process.execPath,
    [root + "node_modules/prisma/build/index.js", "migrate", "deploy"],
    { cwd: root, env: process.env, stdio: "pipe", timeout: 60_000 },
  );
  await db.node.create({
    data: {
      id: "xz-qa-jp",
      name: "xz-qa-jp",
      region: "japaneast",
      country: "JP",
      address: "192.0.2.1",
      publicKey: "a".repeat(43),
      shortId: "abcd",
      serverName: "example.com",
      engineNodeId: randomUUID(),
      ready: true,
      enabled: true,
      globalPool: true,
      vmSize: plan.size,
    },
  });
  const user = await db.user.create({
    data: { email: "qa@local.invalid", passwordHash: "qa" },
  });
  const sub = await db.subscription.create({
    data: {
      userId: user.id,
      status: "active",
      quotaBytes: 50_000n,
      usedBytes: 1234n,
      meterBaseline: 100n,
      validUntil: new Date(Date.now() + 86_400_000),
      regions: ["JP"],
    },
  });
  const key = randomUUID(),
    a = await createLifecycle("operator", "xz-qa-jp", "release", key);
  assert.equal(
    (await createLifecycle("operator", "xz-qa-jp", "release", key)).id,
    a.id,
  );
  await assert.rejects(() =>
    createLifecycle("operator", "xz-qa-jp", "rebuild", key),
  );
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ globalPool: true, regions: [] }),
    }),
    0,
    "release withdraws publication immediately",
  );
  await advanceLifecycle(a.id, driver);
  await advanceLifecycle(a.id, driver);
  await fastDrain(a.id);
  await advanceLifecycle(a.id, driver);
  assert.deepEqual(calls.slice(0, 4), ["inspect", "drain", "meter", "suspend"]);
  failed = true;
  await advanceLifecycle(a.id, driver);
  assert.equal((await row(a.id)).status, "failed");
  await retryLifecycle("operator", a.id);
  failed = false;
  await advanceLifecycle(a.id, driver);
  assert.equal(
    (await row(a.id)).status,
    "running",
    "disk and IP must be gone too",
  );
  done = true;
  await advanceLifecycle(a.id, driver);
  assert.equal((await row(a.id)).status, "complete");
  const released = await db.node.findUniqueOrThrow({
    where: { id: "xz-qa-jp" },
  });
  assert.equal(released.resourceState, "released");
  assert.equal(released.address, "");
  assert.equal(released.publicKey, "a".repeat(43));
  assert.equal(released.realityStateCipher, "PRIVATE_CIPHER");
  assert.equal(
    (await db.subscription.findUniqueOrThrow({ where: { id: sub.id } }))
      .usedBytes,
    1234n,
  );
  assert(
    !JSON.stringify(
      lifecycleView(
        await db.nodeLifecycle.findUniqueOrThrow({
          where: { id: a.id },
          select: lifecycleSelect,
        }),
      ),
    ).includes("PRIVATE"),
  );
  const rebuild = await createLifecycle(
    "operator",
    released.id,
    "rebuild",
    randomUUID(),
  );
  await advanceLifecycle(rebuild.id, driver);
  const rebuilding = await row(rebuild.id);
  assert(rebuilding.machineId);
  const machine = await db.provisionOperation.findUniqueOrThrow({
    where: { id: rebuilding.machineId },
  });
  assert.equal(machine.nodeName, released.name);
  assert.equal(machine.privateState, "PRIVATE_CIPHER");
  assert.equal(machine.size, "Standard_B2ats_v2");
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ globalPool: true, regions: [] }),
    }),
    0,
    "never publish before probe succeeds",
  );
  await db.provisionOperation.update({
    where: { id: machine.id },
    data: {
      status: "failed",
      errorCode: "AllocationFailed",
      phase: "provisioning",
    },
  });
  await advanceLifecycle(rebuild.id, driver);
  assert.equal((await row(rebuild.id)).status, "failed");
  await retryLifecycle("operator", rebuild.id);
  assert.equal(
    (
      await db.provisionOperation.findUniqueOrThrow({
        where: { id: machine.id },
      })
    ).phase,
    "queued",
  );
  await db.provisionOperation.update({
    where: { id: machine.id },
    data: { status: "ready", phase: "ready" },
  });
  await db.node.update({
    where: { id: released.id },
    data: {
      address: "192.0.2.2",
      resourceState: "active",
      publishedAt: new Date(),
      ready: true,
    },
  });
  await advanceLifecycle(rebuild.id, driver);
  assert.equal((await row(rebuild.id)).status, "complete");
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ globalPool: true, regions: [] }),
    }),
    1,
  );
  const after = await db.subscription.findUniqueOrThrow({
    where: { id: sub.id },
  });
  assert.equal(after.usedBytes, sub.usedBytes);
  assert.equal(after.quotaBytes, sub.quotaBytes);
  assert.equal(after.validUntil?.getTime(), sub.validUntil?.getTime());
  const catalog = async () => ({
    locations: [
      { name: "japaneast", country: "JP", available: true },
      { name: "eastasia", country: "HK", available: true },
    ],
  });
  const input = {
    action: "rebuild",
    regions: ["japaneast", "eastasia"],
    idempotencyKey: randomUUID(),
  };
  const regionBatch = await createMaintenance("operator", input, catalog);
  assert.equal(regionBatch.counts.skipped, 1);
  assert.equal(regionBatch.counts.pending, 1);
  assert.equal(
    (await createMaintenance("operator", input, catalog)).id,
    regionBatch.id,
  );
  await assert.rejects(() =>
    createMaintenance("operator", { ...input, regions: ["invalid"] }, catalog),
  );
  assert.equal(await db.node.count({ where: { region: "eastasia" } }), 1);
  const stale = await createMaintenance("operator", {
    action: "release",
    nodeIds: [released.id],
    idempotencyKey: randomUUID(),
  });
  await db.node.update({
    where: { id: released.id },
    data: { operationId: randomUUID() },
  });
  await advanceMaintenance(stale.id);
  assert.equal(
    ((await batch(stale.id)).items as unknown as { status: string }[])[0]
      .status,
    "skipped",
    "old batch cannot delete a replacement VM",
  );
  await db.node.update({
    where: { id: released.id },
    data: { operationId: machine.id },
  });
  // All recycling excludes retained-only configurations; mixed completion stays durable.
  const all = await createMaintenance("operator", {
    action: "release",
    all: true,
    idempotencyKey: randomUUID(),
  });
  assert.equal(all.counts.total, 1);
  await advanceMaintenance(all.id);
  const item = (await batch(all.id)).items as unknown as {
    id: string;
    lifecycleId: string;
    status: string;
  }[];
  assert(item[0].lifecycleId);
  await db.nodeLifecycle.update({
    where: { id: item[0].lifecycleId },
    data: { status: "complete", phase: "released" },
  });
  await advanceMaintenance(all.id);
  assert.equal((await batch(all.id)).status, "complete");
  // Old generations cannot be resurrected once a release/rebuild owns the node.
  await db.provisionOperation.update({
    where: { id: machine.id },
    data: { status: "failed" },
  });
  await assert.rejects(() => retryMachine("operator", machine.id));
  // An unsuccessful build can be retired instead of leaving paid remnants forever.
  const hk = await db.node.findUniqueOrThrow({ where: { id: "xz-eastasia" } });
  const broken = await createLifecycle(
    "operator",
    hk.id,
    "rebuild",
    randomUUID(),
  );
  await advanceLifecycle(broken.id, {
    ...driver,
    async prepare(n) {
      return { ...plan, region: n.region, country: n.country };
    },
  });
  const brokenMachine = (await row(broken.id)).machineId!;
  await db.provisionOperation.update({
    where: { id: brokenMachine },
    data: {
      status: "failed",
      phase: "installing",
      errorCode: "INSTALLATION_FAILED",
    },
  });
  await advanceLifecycle(broken.id, driver);
  const cleanup = await createLifecycle(
    "operator",
    hk.id,
    "release",
    randomUUID(),
  );
  assert.notEqual(cleanup.id, broken.id);
  assert.equal((await row(broken.id)).status, "canceled");
  assert.equal(
    (
      await db.provisionOperation.findUniqueOrThrow({
        where: { id: brokenMachine },
      })
    ).status,
    "canceled",
  );
  await assert.rejects(() => retryMachine("operator", brokenMachine));
  console.log(
    "PASS lifecycle: retained config, ordered release, failure retry, rebuild generations, quota preservation, region/all batches and stale-generation guards",
  );
} finally {
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
