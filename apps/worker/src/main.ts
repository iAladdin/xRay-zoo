import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { db } from "../../../packages/core/db.js";
import { settings, assertLocalRuntime } from "../../../packages/core/config.js";
import { processPayment } from "../../../packages/core/billing.js";
import { syncEntitlement } from "../../../packages/core/entitlements.js";
import { engine } from "../../../packages/engine-remnawave/client.js";
assertLocalRuntime();
const connection = new Redis(settings.redis.toString(), {
  maxRetriesPerRequest: null,
});
const queue = new Queue("xray-zoo", { connection });
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
        const response = await engine.request<
          | { uuid: string; isConnected: boolean; isDisabled: boolean }[]
          | {
              nodes: {
                uuid: string;
                isConnected: boolean;
                isDisabled: boolean;
              }[];
            }
        >("/nodes");
        const nodes = Array.isArray(response) ? response : response.nodes;
        await db.node.updateMany({ data: { ready: false } });
        for (const node of nodes)
          await db.node.updateMany({
            where: { engineNodeId: node.uuid },
            data: {
              ready: node.isConnected && !node.isDisabled,
              checkedAt: new Date(),
            },
          });
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
  await queue.close();
  await db.$disconnect();
  process.exit(0);
});
console.log("xRay-zoo worker ready");
