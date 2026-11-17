import { readFileSync } from "node:fs";
import { db } from "../packages/core/db.js";
import { root } from "../packages/core/config.js";
import { NodeSchema } from "../packages/subscription/index.js";
await db.plan.upsert({
  where: { id: "p0-20gb" },
  create: {
    id: "p0-20gb",
    name: "环球体验 · 20 GB",
    amountMinor: 999,
    currency: "usd",
    quotaBytes: 20_000_000_000n,
    regions: ["JP", "SG", "US", "HK", "TW"],
  },
  update: {},
});
const inventory = JSON.parse(readFileSync(root + "/.local/nodes.json", "utf8"));
for (const input of inventory.nodes) {
  const node = NodeSchema.parse(input);
  const data = {
    ...node,
    region: input.region,
    engineNodeId: input.engineNodeId,
    configProfileId: input.configProfileId,
    inboundId: input.inboundId,
    squadId: input.squadId,
    checkedAt: new Date(),
  };
  await db.node.upsert({ where: { id: node.id }, create: data, update: data });
}
console.log(`Seeded 1 test plan and ${inventory.nodes.length} nodes`);
await db.$disconnect();
