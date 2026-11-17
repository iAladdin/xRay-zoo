import type { Prisma } from "@prisma/client";

export function nodePoolWhere(entitlement: {
  regions: string[];
  globalPool: boolean;
}): Prisma.NodeWhereInput {
  return {
    publishedAt: { not: null },
    ...(entitlement.globalPool
      ? { OR: [{ globalPool: true }, { country: { in: entitlement.regions } }] }
      : { country: { in: entitlement.regions } }),
  };
}
