import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { engine, type EngineUser } from "../engine-remnawave/client.js";
import { randomToken, hashToken, seal, unseal } from "./crypto.js";

export const engineUsername = (subscriptionId: string) =>
  "xz_" + subscriptionId.replaceAll("-", "");
export function usageOf(user: EngineUser): bigint {
  const value =
    user.userTraffic?.lifetimeUsedTrafficBytes ??
    user.usedTrafficBytes ??
    user.userTraffic?.usedTrafficBytes;
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new Error("ENGINE_USAGE_UNAVAILABLE");
  return BigInt(value);
}

export async function syncEntitlement(subscriptionId: string) {
  const leaseOwner = randomUUID();
  const acquired = await db.subscription.updateMany({
    where: {
      id: subscriptionId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: new Date() } }],
    },
    data: {
      syncLeaseOwner: leaseOwner,
      syncLeaseUntil: new Date(Date.now() + 90_000),
    },
  });
  if (!acquired.count) throw new Error("ENTITLEMENT_BUSY");
  try {
    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    const period = await db.servicePeriod.findFirst({
      where: {
        subscriptionId,
        status: "paid",
        startAt: { lte: new Date() },
        endAt: { gt: new Date() },
      },
      orderBy: { startAt: "desc" },
      include: { order: true },
    });
    const username = engineUsername(sub.id);
    let user = await engine.findUser(username);
    const regenerating = sub.status === "regenerating";
    if (
      !period ||
      sub.status === "suspended" ||
      (sub.revokedAt && !regenerating)
    ) {
      if (user) {
        await engine.updateUser(username, { status: "DISABLED" });
        const observed = await engine.findUser(username);
        if (observed?.status === "ACTIVE")
          throw new Error("ENGINE_REVOCATION_PENDING");
        user = observed;
      }
      // Paid periods can renew while access remains revoked. Keep the customer's
      // entitlement display and meter current without granting access again.
      const lifetime = user ? usageOf(user) : null;
      const baseline =
        period && sub.currentPeriodId !== period.id
          ? (lifetime ?? 0n)
          : sub.meterBaseline;
      if (lifetime !== null && lifetime < baseline)
        throw new Error("ENGINE_COUNTER_RESET_REQUIRES_RECONCILIATION");
      const revokedPeriod =
        period && sub.revokedAt
          ? {
              validUntil: period.endAt,
              quotaBytes: period.quotaBytes,
              regions: period.order.regions,
              currentPeriodId: period.id,
              meterBaseline: baseline,
              usedBytes:
                lifetime !== null
                  ? lifetime - baseline
                  : sub.currentPeriodId === period.id
                    ? sub.usedBytes
                    : 0n,
              ...(user ? { lastUsageAt: new Date() } : {}),
            }
          : {};
      await db.subscription.updateMany({
        where: {
          id: sub.id,
          desiredVersion: sub.desiredVersion,
          syncLeaseOwner: leaseOwner,
        },
        data: {
          ...revokedPeriod,
          status:
            sub.status === "suspended"
              ? "suspended"
              : sub.revokedAt
                ? "revoked"
                : "expired",
          appliedVersion: sub.desiredVersion,
          lastError: null,
        },
      });
      return;
    }
    const nodes = await db.node.findMany({
      where: { enabled: true, country: { in: period.order.regions } },
    });
    const squads = [
      ...new Set(nodes.map((n) => n.squadId).filter((s): s is string => !!s)),
    ];
    // Transient control outages must not remove paid users from regional squads.
    // No enabled regions: retain entitlement, disable access until an operator enables a node.
    if (!squads.length) {
      if (user)
        await engine.updateUser(username, {
          status: "DISABLED",
          activeInternalSquads: [],
        });
      throw new Error("NO_ENABLED_NODES");
    }
    if (!user)
      user = await engine.ensureUser(username, {
        status: "DISABLED",
        expireAt: period.endAt.toISOString(),
        trafficLimitBytes: Number(period.quotaBytes),
        trafficLimitStrategy: "NO_RESET",
        activeInternalSquads: squads,
      });
    // Remember the previous UUID in accessUuidCipher until the whole rotation is applied.
    // A retry after the provider rotated successfully detects the changed UUID and does not rotate twice.
    if (regenerating && sub.accessUuidCipher) {
      const previous = unseal(sub.accessUuidCipher);
      if (user.vlessUuid === previous)
        await engine.request(`/users/${user.id}/actions/revoke`, "POST", {
          revokeOnlyPasswords: true,
        });
      const rotated = await engine.findUser(username);
      if (!rotated || rotated.vlessUuid === previous)
        throw new Error("ENGINE_ROTATION_PENDING");
      user = rotated;
    }
    const lifetime = usageOf(user);
    const baseline =
      sub.currentPeriodId === period.id ? sub.meterBaseline : lifetime;
    if (lifetime < baseline)
      throw new Error("ENGINE_COUNTER_RESET_REQUIRES_RECONCILIATION");
    const used = lifetime - baseline;
    const remaining = period.quotaBytes > used ? period.quotaBytes - used : 0n;
    // Remnawave's current counter limit differs from its lifetime counter.
    const current = BigInt(
      user.usedTrafficBytes ??
        user.userTraffic?.usedTrafficBytes ??
        Number(lifetime),
    );
    const limit = current + remaining;
    if (limit > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("ENGINE_QUOTA_OVERFLOW");
    await engine.updateUser(username, {
      status: remaining > 0n ? "ACTIVE" : "DISABLED",
      expireAt: period.endAt.toISOString(),
      trafficLimitBytes: Number(limit || 1n),
      trafficLimitStrategy: "NO_RESET",
      activeInternalSquads: squads,
    });
    const observed = await engine.findUser(username);
    if (
      !observed ||
      (remaining > 0n && observed.status !== "ACTIVE") ||
      (remaining === 0n && observed.status === "ACTIVE") ||
      new Date(observed.expireAt).getTime() !== period.endAt.getTime()
    )
      throw new Error("ENGINE_APPLY_UNVERIFIED");
    const token = sub.tokenCipher ? null : randomToken();
    await db.subscription.updateMany({
      where: {
        id: sub.id,
        desiredVersion: sub.desiredVersion,
        syncLeaseOwner: leaseOwner,
      },
      data: {
        engineUserId: String(user.id),
        revokedAt: null,
        accessUuidCipher: seal(observed.vlessUuid),
        ...(token
          ? { tokenHash: hashToken(token), tokenCipher: seal(token) }
          : {}),
        status: remaining > 0n ? "active" : "exhausted",
        validUntil: period.endAt,
        regions: period.order.regions,
        quotaBytes: period.quotaBytes,
        usedBytes: used,
        currentPeriodId: period.id,
        meterBaseline: baseline,
        lastUsageAt: new Date(),
        appliedVersion: sub.desiredVersion,
        lastError: null,
      },
    });
  } catch (error) {
    await db.subscription.updateMany({
      where: { id: subscriptionId, syncLeaseOwner: leaseOwner },
      data: {
        lastError:
          error instanceof Error ? error.message.slice(0, 150) : "SYNC_FAILED",
      },
    });
    throw error;
  } finally {
    await db.subscription.updateMany({
      where: { id: subscriptionId, syncLeaseOwner: leaseOwner },
      data: { syncLeaseOwner: null, syncLeaseUntil: null },
    });
  }
}
