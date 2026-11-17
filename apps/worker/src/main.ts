import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "../../../packages/core/db.js";
import { settings, assertLocalRuntime } from "../../../packages/core/config.js";
import { processPayment } from "../../../packages/core/billing.js";
import { syncEntitlement } from "../../../packages/core/entitlements.js";
import { advanceMachine } from "../../../packages/core/provisioning.js";
import { advanceRotation } from "../../../packages/core/ip-rotation.js";
import { advanceLifecycle } from "../../../packages/core/node-lifecycle.js";
import { advanceMaintenance } from "../../../packages/core/node-maintenance.js";
import {
  refreshNodeHealth,
  reconcileDisabledNodes,
} from "../../../packages/core/node-health.js";
assertLocalRuntime();
const connection = new Redis(settings.redis.toString(), {
  maxRetriesPerRequest: null,
});
const queue = new Queue("xray-zoo", { connection });
const machineQueue = new Queue("xray-zoo-machines", { connection });
const machineWorker = new Worker(
  "xray-zoo-machines",
  async (job) =>
    job.name === "lifecycle"
      ? advanceLifecycle(job.data.id)
      : job.name === "rotate-ip"
        ? advanceRotation(job.data.id)
        : job.name === "maintenance"
          ? advanceMaintenance(job.data.id)
          : advanceMachine(job.data.id),
  { connection, concurrency: 1 },
);
machineWorker.on("failed", () =>
  console.error("machine step deferred; database or queue unavailable"),
);
const worker = new Worker(
  "xray-zoo",
  async (job) => {
    if (job.name === "payment") await processPayment(job.data.id);
    if (job.name === "entitlement") await syncEntitlement(job.data.id);
  },
  { connection, concurrency: 3 },
);
worker.on("failed", (job, error) =>
  console.error(
    "job failed",
    job?.name,
    error.message.replace(/[^A-Z0-9_]/g, "").slice(0, 80),
  ),
);
let running = false,
  tick = 0;
async function reconcile() {
  if (running) return;
  running = true;
  try {
    const lifecycles = await db.nodeLifecycle.findMany({
      where: {
        status: "running",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const op of lifecycles)
      await machineQueue.add(
        "lifecycle",
        { id: op.id },
        {
          jobId: `lifecycle-${op.id}-${Math.floor(Date.now() / 5000)}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    const batches = await db.nodeMaintenanceBatch.findMany({
      where: {
        status: "running",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const batch of batches)
      await machineQueue.add(
        "maintenance",
        { id: batch.id },
        {
          jobId: `maintenance-${batch.id}-${Math.floor(Date.now() / 5000)}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    const rotations = await db.ipRotation.findMany({
      where: {
        status: "running",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const op of rotations)
      await machineQueue.add(
        "rotate-ip",
        { id: op.id },
        {
          jobId: `ip-${op.id}-${Math.floor(Date.now() / 5000)}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    const machines = await db.provisionOperation.findMany({
      where: {
        status: "running",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    });
    for (const machine of machines)
      await machineQueue.add(
        "advance",
        { id: machine.id },
        {
          jobId: `machine-${machine.id}-${Math.floor(Date.now() / 5000)}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    const outbox = await db.outbox.findMany({
      where: { deliveredAt: null },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
    for (const item of outbox) {
      await queue.add(
        item.kind,
        { id: item.aggregateId },
        {
          jobId: "outbox-" + item.id,
          attempts: 8,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      await db.outbox.update({
        where: { id: item.id },
        data: { deliveredAt: new Date() },
      });
    }
    if (tick++ % 6 === 0) {
      try {
        try {
          await reconcileDisabledNodes();
        } finally {
          await refreshNodeHealth(true);
        }
      } catch {
        console.error("node health refresh failed");
      }
      const subs = await db.subscription.findMany({ select: { id: true } });
      for (const sub of subs)
        await queue.add(
          "entitlement",
          { id: sub.id },
          {
            jobId: `reconcile-${sub.id}-${Math.floor(Date.now() / 30_000)}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
      const pending = await db.providerEvent.findMany({
        where: { status: "pending" },
        take: 100,
      });
      for (const event of pending)
        await queue.add(
          "payment",
          { id: event.id },
          {
            jobId: `recover-${event.id}-${Math.floor(Date.now() / 30_000)}`,
            attempts: 3,
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
    }
  } catch {
    console.error("reconciliation deferred; database/queue unavailable");
  } finally {
    running = false;
  }
}
await reconcile();
const interval = setInterval(reconcile, 5000);
process.on("SIGTERM", async () => {
  clearInterval(interval);
  await worker.close();
  await machineWorker.close();
  await machineQueue.close();
  await queue.close();
  await db.$disconnect();
  process.exit(0);
});
console.log("xRay-zoo worker ready");
