import { db } from "./db.js";

// Pricing assumption, not an Azure invoice or fully allocated business cost.
// Verified 2026-11-18: Asia Internet Egress, Microsoft Premium Global Network,
// next 10 TB tier. Do not allocate the shared 100 GB free allowance per customer.
export const defaultPricing = {
  basis: "full-quota-egress",
  checkedAt: "2026-11-18",
  currency: "usd",
  interval: "month",
  egressCostMinorPerGB: 12,
  billedEgressGBPerQuotaGB: 1,
  multiplier: 10,
  source: "https://azure.microsoft.com/en-us/pricing/details/bandwidth/",
} as const;

export const defaultPlans = [
  { id: "global-50gb", name: "环球轻量 · 50 GB", quotaGB: 50 },
  { id: "global-150gb", name: "环球标准 · 150 GB", quotaGB: 150 },
  { id: "global-300gb", name: "环球充裕 · 300 GB", quotaGB: 300 },
].map(({ quotaGB, ...p }) => ({
  ...p,
  amountMinor:
    quotaGB *
    defaultPricing.billedEgressGBPerQuotaGB *
    defaultPricing.egressCostMinorPerGB *
    defaultPricing.multiplier,
  currency: defaultPricing.currency,
  quotaBytes: BigInt(quotaGB) * 1_000_000_000n,
  regions: ["JP", "SG", "US", "HK", "TW"],
  active: true,
  globalPool: true,
}));

export async function seedDefaultPlans() {
  return db.$transaction(async (tx) => {
    let created = 0;
    for (const plan of defaultPlans) {
      // An initializer must not overwrite later operator edits or republish a disabled plan.
      const inserted = await tx.plan.createMany({
        data: [plan],
        skipDuplicates: true,
      });
      if (!inserted.count) continue;
      created++;
      await tx.auditLog.create({
        data: {
          actorId: "system:default-plans",
          action: "plan.create",
          targetId: plan.id,
          detail: {
            name: plan.name,
            amountMinor: plan.amountMinor,
            quotaGB: Number(plan.quotaBytes / 1_000_000_000n),
            pricing: defaultPricing,
          },
        },
      });
    }
    // Keep the historical plan and all frozen orders/Stripe contracts; stop new sales only.
    const retired = await tx.plan.updateMany({
      where: { id: "p0-20gb", active: true },
      data: { active: false },
    });
    if (retired.count)
      await tx.auditLog.create({
        data: {
          actorId: "system:default-plans",
          action: "plan.update",
          targetId: "p0-20gb",
          detail: {
            active: false,
            reason: "Replaced by 50 / 150 / 300 GB monthly defaults",
          },
        },
      });
    return { created, retired: retired.count };
  });
}
