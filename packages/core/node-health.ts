import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { root, settings } from "./config.js";
import { engine } from "../engine-remnawave/client.js";
export type EngineNode = {
  uuid: string;
  isConnected: boolean;
  isDisabled: boolean;
  trafficUsedBytes?: number;
  versions?: { xray?: string };
};
type Transport = { id: string; connected: boolean; error: string | null };
const exec = promisify(execFile);
export const FRESH_MS = 120_000;
export function healthState(
  node: {
    enabled: boolean;
    engineConnected: boolean;
    engineDisabled: boolean;
    transportConnected: boolean | null;
    checkedAt: Date | null;
    healthReason: string;
    publishedAt?: Date | null;
    addressChanging?: boolean;
  },
  now = Date.now(),
) {
  if (node.publishedAt === null) return "PROVISIONING";
  if (node.addressChanging) return "ROTATING_IP";
  if (node.healthReason === "ENGINE_UNAVAILABLE") return "ENGINE_UNAVAILABLE";
  if (!node.enabled)
    return node.checkedAt &&
      now - node.checkedAt.getTime() <= FRESH_MS &&
      node.engineDisabled &&
      !node.engineConnected
      ? "DISABLED"
      : "DISABLE_PENDING";
  if (!node.checkedAt || now - node.checkedAt.getTime() > FRESH_MS)
    return "STALE";
  if (node.transportConnected === false) return "CONTROL_DISCONNECTED";
  if (node.engineDisabled) return "ENGINE_DISABLED";
  if (!node.engineConnected)
    return node.healthReason === "NODE_MISSING"
      ? "NODE_MISSING"
      : "NODE_DISCONNECTED";
  return "READY";
}
export async function controlTunnels(
  repair = false,
  id?: string,
): Promise<Transport[]> {
  if (!settings.local) return [];
  const { stdout } = await exec(
    "python3",
    [
      resolve(root, "scripts/control-tunnels.py"),
      repair ? "ensure" : "status",
      "--json",
      ...(id ? ["--node", id] : []),
    ],
    { cwd: root, timeout: 25_000, maxBuffer: 64 * 1024 },
  );
  return JSON.parse(stdout);
}
let inFlight: Promise<void> | null = null;
export function refreshNodeHealth(repair = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = refresh(repair).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
async function refresh(repair: boolean) {
  let transport: Transport[] = [];
  try {
    transport = await controlTunnels(repair);
  } catch {
    /* unknown is distinct from disconnected */
  }
  const now = new Date();
  let observed: EngineNode[];
  try {
    const response = await engine.request<
      EngineNode[] | { nodes: EngineNode[] }
    >("/nodes");
    observed = Array.isArray(response) ? response : response.nodes;
    if (!Array.isArray(observed)) throw new Error("INVALID_NODE_SNAPSHOT");
  } catch {
    await db.node.updateMany({
      data: {
        ready: false,
        healthReason: "ENGINE_UNAVAILABLE",
        checkedAt: now,
      },
    });
    return;
  }
  const local = await db.node.findMany();
  await db.$transaction(async (tx) => {
    for (const node of local) {
      const actual = observed.find((n) => n.uuid === node.engineNodeId);
      const tunnel = transport.find((n) => n.id === node.id);
      const connected = actual?.isConnected === true,
        disabled = actual?.isDisabled === true;
      const reason = !actual
        ? "NODE_MISSING"
        : tunnel?.connected === false
          ? "CONTROL_DISCONNECTED"
          : disabled
            ? "ENGINE_DISABLED"
            : connected
              ? "READY"
              : "NODE_DISCONNECTED";
      const validUsage =
        typeof actual?.trafficUsedBytes === "number" &&
        Number.isSafeInteger(actual.trafficUsedBytes) &&
        actual.trafficUsedBytes >= 0;
      // Predicate is evaluated in the database; a concurrent operator disable cannot be overwritten.
      const data = {
        engineConnected: connected,
        engineDisabled: disabled,
        transportConnected: tunnel?.connected ?? null,
        healthReason: reason,
        checkedAt: now,
        ...(reason === "READY" && node.enabled ? { lastHealthyAt: now } : {}),
        ...(validUsage
          ? {
              usageBytes: BigInt(actual!.trafficUsedBytes!),
              usageUpdatedAt: now,
            }
          : {}),
        xrayVersion: actual?.versions?.xray ?? null,
      };
      await tx.node.update({
        where: { id: node.id },
        data: { ...data, ready: false },
      });
      if (reason === "READY" && node.publishedAt !== null)
        await tx.node.updateMany({
          where: { id: node.id, enabled: true, addressChanging: false },
          data: { ready: true },
        });
    }
  });
}
export async function nodeAction(
  id: string,
  action: "enable" | "disable" | "restart" | "reconnect",
  actorId: string,
) {
  const owner = randomUUID();
  const locked = await db.node.updateMany({
    where: {
      id,
      activeIpRotationId: null,
      OR: [
        { controlLeaseUntil: null },
        { controlLeaseUntil: { lt: new Date() } },
      ],
    },
    data: {
      controlLeaseOwner: owner,
      controlLeaseUntil: new Date(Date.now() + 90_000),
    },
  });
  if (!locked.count) throw new Error("NODE_BUSY");
  try {
    const node = await db.node.findUniqueOrThrow({ where: { id } });
    if (!node.publishedAt) throw new Error("NODE_NOT_PUBLISHED");
    if (!node.engineNodeId) throw new Error("NODE_UNMANAGED");
    await db.auditLog.create({
      data: {
        actorId,
        action: "node." + action + ".requested",
        targetId: id,
        detail: {},
      },
    });
    // Fail closed immediately. Keep disabled desired state if provider update fails; the worker retries.
    if (action === "disable")
      await db.node.update({
        where: { id },
        data: { enabled: false, ready: false },
      });
    if (action === "reconnect") {
      const result = await controlTunnels(true, id);
      if (!result.some((t) => t.id === id && t.connected))
        throw new Error("CONTROL_TRANSPORT_UNAVAILABLE");
    } else
      await engine.request(
        `/nodes/${node.engineNodeId}/actions/${action}`,
        "POST",
        action === "restart" ? { forceRestart: true } : {},
      );
    if (action === "enable")
      await db.node.update({
        where: { id },
        data: { enabled: true, ready: false },
      });
    await refreshNodeHealth();
    await db.auditLog.create({
      data: {
        actorId,
        action: "node." + action + ".accepted",
        targetId: id,
        detail: {},
      },
    });
  } catch (error) {
    await db.auditLog.create({
      data: {
        actorId,
        action: "node." + action + ".failed",
        targetId: id,
        detail: { reason: "CONTROL_ACTION_FAILED" },
      },
    });
    throw error;
  } finally {
    await db.node.updateMany({
      where: { id, controlLeaseOwner: owner },
      data: { controlLeaseOwner: null, controlLeaseUntil: null },
    });
  }
}
export async function reconcileDisabledNodes() {
  const candidates = await db.node.findMany({
    where: {
      enabled: false,
      engineDisabled: false,
      publishedAt: { not: null },
      activeIpRotationId: null,
    },
  });
  for (const node of candidates) {
    const owner = randomUUID();
    const acquired = await db.node.updateMany({
      where: {
        id: node.id,
        enabled: false,
        activeIpRotationId: null,
        OR: [
          { controlLeaseUntil: null },
          { controlLeaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        controlLeaseOwner: owner,
        controlLeaseUntil: new Date(Date.now() + 60_000),
      },
    });
    if (!acquired.count) continue;
    try {
      if (node.engineNodeId)
        await engine.request(
          `/nodes/${node.engineNodeId}/actions/disable`,
          "POST",
          {},
        );
    } finally {
      await db.node.updateMany({
        where: { id: node.id, controlLeaseOwner: owner },
        data: { controlLeaseOwner: null, controlLeaseUntil: null },
      });
    }
  }
}
