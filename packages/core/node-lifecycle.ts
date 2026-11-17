import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { Node, NodeLifecycle, Prisma } from "@prisma/client";
import { db } from "./db.js";
import {
  azure,
  runAzure,
  provisionError,
  type AzurePlanSnapshot,
} from "./azure.js";
import { seal } from "./crypto.js";
import { engine } from "../engine-remnawave/client.js";
import { engineUsername, usageOf } from "./entitlements.js";

export const DEFAULT_SIZE = "Standard_B2ats_v2";
export const lifecycleLabels: Record<string, string> = {
  queued: "保存重建配置",
  draining: "停止代理并结算用量",
  releasing: "释放机器、磁盘和 IP",
  released: "已回收，配置已保留",
  preparing: "核验区域、配额和镜像",
  deploying: "重建并验证节点",
  ready: "已上线并更新订阅",
};
export const lifecycleSelect = {
  id: true,
  nodeId: true,
  action: true,
  phase: true,
  status: true,
  machineId: true,
  events: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
} satisfies Prisma.NodeLifecycleSelect;
export function lifecycleView<
  T extends { phase: string; errorCode: string | null },
>(op: T) {
  return {
    ...op,
    phaseLabel: lifecycleLabels[op.phase] ?? op.phase,
    error: op.errorCode
      ? provisionError(new Error(op.errorCode)).message
      : null,
  };
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
type Snapshot = Record<string, unknown> & {
  region: string;
  size: string;
  vmId: string;
};
type State = {
  snapshot?: Snapshot;
  drainStartedAt?: string;
  drained?: boolean;
  remaining?: number;
};
export type LifecycleOperation = NodeLifecycle & { node: Node };
export interface LifecycleDriver {
  inspect(node: Node): Promise<Snapshot>;
  preserve(node: Node): Promise<string | null>;
  drain(node: Node): Promise<void>;
  meter(node: Node): Promise<void>;
  suspend(node: Node): Promise<void>;
  release(snapshot: Snapshot): Promise<{ done: boolean; remaining: number }>;
  verify(snapshot: Snapshot): Promise<{ done: boolean }>;
  prepare(node: Node): Promise<AzurePlanSnapshot>;
}
const cloud = <T>(command: string, input: unknown) =>
  runAzure<T>("azure-lifecycle.py", command, input);
export const productionLifecycleDriver: LifecycleDriver = {
  inspect: (node) =>
    cloud("inspect", {
      nodeName: node.name,
      vmId: node.azureVmId,
      region: node.region,
      size: node.vmSize ?? DEFAULT_SIZE,
    }),
  async preserve(node) {
    if (node.realityStateCipher) return node.realityStateCipher;
    if (!node.configProfileId) {
      if (node.engineNodeId) throw new Error("NODE_CONFIG_MISSING");
      return null;
    }
    const profile = await engine.request<{
      config: {
        inbounds: {
          tag: string;
          streamSettings?: {
            realitySettings?: {
              privateKey: string;
              shortIds: string[];
              serverNames: string[];
            };
          };
        }[];
      };
    }>("/config-profiles/" + node.configProfileId);
    const settings = profile.config.inbounds.find((x) => x.tag === node.name)
      ?.streamSettings?.realitySettings;
    if (
      !settings?.privateKey ||
      !settings.shortIds.includes(node.shortId) ||
      !settings.serverNames.includes(node.serverName)
    )
      throw new Error("NODE_CONFIG_MISSING");
    return seal(
      JSON.stringify({
        privateKey: settings.privateKey,
        publicKey: node.publicKey,
        shortId: node.shortId,
        serverName: node.serverName,
      }),
    );
  },
  async drain(node) {
    if (node.engineNodeId)
      await engine.request(
        `/nodes/${node.engineNodeId}/actions/disable`,
        "POST",
        {},
      );
  },
  async meter(node) {
    if (node.engineNodeId) {
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
      const actual = (Array.isArray(response) ? response : response.nodes).find(
        (n) => n.uuid === node.engineNodeId,
      );
      if (actual && (actual.isConnected || !actual.isDisabled))
        throw new Error("NODE_DRAIN_PENDING");
    }
    // Read the durable engine lifetime meter. Never revoke users or reset a quota here.
    const subs = await db.subscription.findMany({
      where: { engineUserId: { not: null } },
    });
    for (const sub of subs) {
      const user = await engine.findUser(engineUsername(sub.id));
      if (!user) throw new Error("ENGINE_USAGE_UNAVAILABLE");
      const total = usageOf(user);
      if (total < sub.meterBaseline)
        throw new Error("ENGINE_COUNTER_RESET_REQUIRES_RECONCILIATION");
      const used = total - sub.meterBaseline;
      await db.subscription.updateMany({
        where: {
          id: sub.id,
          currentPeriodId: sub.currentPeriodId,
          meterBaseline: sub.meterBaseline,
          usedBytes: { lte: used },
        },
        data: { usedBytes: used, lastUsageAt: new Date() },
      });
    }
  },
  async suspend(node) {
    await cloud("suspend", { nodeName: node.name });
  },
  release: (snapshot) => cloud("release", { snapshot }),
  verify: (snapshot) => cloud("verify", { snapshot }),
  prepare: (node) =>
    azure("prepare", {
      region: node.region,
      size: node.vmSize ?? DEFAULT_SIZE,
    }),
};
export async function createLifecycle(
  actorId: string,
  nodeId: string,
  action: "release" | "rebuild",
  idempotencyKey: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"lifecycle:" + nodeId}))`;
    const prior = await tx.nodeLifecycle.findUnique({
      where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
    });
    if (prior) {
      if (prior.nodeId !== nodeId || prior.action !== action)
        throw new HttpException("请求标识已用于其他操作", 409);
      return { id: prior.id };
    }
    const node = await tx.node.findUnique({ where: { id: nodeId } });
    if (!node) throw new HttpException("节点不存在", 404);
    if (node.activeLifecycleId) {
      const active = await tx.nodeLifecycle.findUniqueOrThrow({
        where: { id: node.activeLifecycleId },
      });
      if (active.action === action && active.status === "running")
        return { id: active.id };
      if (active.action === action && active.status === "failed") {
        if (active.leaseUntil && active.leaseUntil > new Date())
          throw new HttpException("节点任务尚未退出，请稍后重试", 409);
        if (active.machineId) {
          const m = await tx.provisionOperation.findUniqueOrThrow({
            where: { id: active.machineId },
          });
          if (m.status === "failed") {
            if (m.leaseUntil && m.leaseUntil > new Date())
              throw new HttpException("部署任务尚未退出", 409);
            const phase = m.phase === "provisioning" ? "queued" : m.phase;
            await tx.provisionOperation.update({
              where: { id: m.id },
              data: {
                status: "running",
                phase,
                errorCode: null,
                finishedAt: null,
                phaseStartedAt: new Date(),
                attempts: { increment: 1 },
                checkpoint: {
                  ...(m.checkpoint as object),
                  ...(phase === "installing"
                    ? { installSubmitted: false }
                    : {}),
                },
              },
            });
          }
        }
        await tx.nodeLifecycle.update({
          where: { id: active.id },
          data: {
            status: "running",
            errorCode: null,
            finishedAt: null,
            phaseStartedAt: new Date(),
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: "node.lifecycle.retry",
            targetId: active.id,
            detail: { action },
          },
        });
        return { id: active.id };
      }
      if (
        action === "release" &&
        active.action === "rebuild" &&
        active.status === "failed"
      ) {
        if (active.leaseUntil && active.leaseUntil > new Date())
          throw new HttpException("部署任务尚未退出", 409);
        if (active.machineId) {
          const m = await tx.provisionOperation.findUniqueOrThrow({
            where: { id: active.machineId },
          });
          if (
            m.status === "running" ||
            (m.leaseUntil && m.leaseUntil > new Date())
          )
            throw new HttpException("部署仍在运行，请稍后回收", 409);
          await tx.provisionOperation.update({
            where: { id: m.id },
            data: { status: "canceled", finishedAt: new Date() },
          });
        }
        await tx.nodeLifecycle.update({
          where: { id: active.id },
          data: { status: "canceled", finishedAt: new Date() },
        });
        await tx.node.update({
          where: { id: nodeId },
          data: { activeLifecycleId: null },
        });
      } else
        throw new HttpException("节点有生命周期任务进行中，请查看进度", 409);
    }
    if (action === "release" && node.resourceState === "released")
      throw new HttpException("节点已经回收", 409);
    if (action === "rebuild" && node.resourceState !== "released")
      throw new HttpException("请先回收节点，再重建", 409);
    if (
      node.operationId &&
      (await tx.provisionOperation.count({
        where: { id: node.operationId, status: "running" },
      }))
    )
      throw new HttpException("节点仍在部署中", 409);
    const id = randomUUID();
    const locked = await tx.node.updateMany({
      where: {
        id: nodeId,
        activeIpRotationId: null,
        activeLifecycleId: null,
        OR: [
          { controlLeaseUntil: null },
          { controlLeaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        activeLifecycleId: id,
        resourceState: action === "release" ? "releasing" : "rebuilding",
        enabled: false,
        ready: false,
        publishedAt: null,
      },
    });
    if (!locked.count) throw new HttpException("节点正在维护，请稍后重试", 409);
    await tx.nodeLifecycle.create({
      data: {
        id,
        nodeId,
        actorId,
        idempotencyKey,
        action,
        phase: action === "release" ? "queued" : "preparing",
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "node." + action + ".requested",
        targetId: nodeId,
        detail: { operationId: id },
      },
    });
    return { id };
  });
}
export async function advanceLifecycle(
  id: string,
  driver = productionLifecycleDriver,
) {
  const owner = randomUUID();
  const claimed = await db.nodeLifecycle.updateMany({
    where: {
      id,
      status: "running",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 300_000) },
  });
  if (!claimed.count) return;
  const fence = () => ({
    id,
    leaseOwner: owner,
    status: "running",
    leaseUntil: { gt: new Date() },
  });
  let lost = false;
  const heartbeat = setInterval(() => {
    db.nodeLifecycle
      .updateMany({
        where: fence(),
        data: { leaseUntil: new Date(Date.now() + 300_000) },
      })
      .then((r) => {
        if (!r.count) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, 30_000);
  async function save(phase: string, state: State, complete = false) {
    if (lost) throw new Error("LIFECYCLE_LEASE_LOST");
    await db.$transaction(async (tx) => {
      const op = await tx.nodeLifecycle.findUniqueOrThrow({ where: { id } });
      const events = op.events as { at: string; message: string }[];
      const r = await tx.nodeLifecycle.updateMany({
        where: fence(),
        data: {
          phase,
          checkpoint: json(state),
          ...(op.phase !== phase
            ? {
                phaseStartedAt: new Date(),
                events: [
                  ...events,
                  {
                    at: new Date().toISOString(),
                    message: lifecycleLabels[phase] ?? phase,
                  },
                ],
              }
            : {}),
          ...(complete ? { status: "complete", finishedAt: new Date() } : {}),
        },
      });
      if (!r.count) throw new Error("LIFECYCLE_LEASE_LOST");
      if (complete) {
        await tx.node.updateMany({
          where: { id: op.nodeId, activeLifecycleId: id },
          data: {
            activeLifecycleId: null,
            resourceState: phase === "released" ? "released" : "active",
            ...(phase === "released"
              ? {
                  releasedAt: new Date(),
                  address: "",
                  azureVmId: null,
                  enabled: false,
                  ready: false,
                  publishedAt: null,
                  engineConnected: false,
                  transportConnected: false,
                  healthReason: "RELEASED",
                }
              : { releasedAt: null }),
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: op.actorId,
            action: "node." + op.action + ".completed",
            targetId: op.nodeId,
            detail: { operationId: id },
          },
        });
      }
    });
  }
  try {
    const op = await db.nodeLifecycle.findUniqueOrThrow({
      where: { id },
      include: { node: true },
    });
    const state = op.checkpoint as State;
    if (Date.now() - op.phaseStartedAt.getTime() > 90 * 60_000)
      throw new Error("LIFECYCLE_TIMEOUT");
    if (op.node.activeLifecycleId !== id)
      throw new Error("LIFECYCLE_LEASE_LOST");
    if (op.phase === "queued") {
      const snapshot = await driver.inspect(op.node),
        secret = await driver.preserve(op.node);
      await db.node.updateMany({
        where: { id: op.nodeId, activeLifecycleId: id },
        data: {
          deploymentConfig: json(snapshot),
          realityStateCipher: secret,
          vmSize: snapshot.size,
          azureVmId: snapshot.vmId,
        },
      });
      await save("draining", { snapshot });
    } else if (op.phase === "draining") {
      if (!state.drainStartedAt) {
        await driver.drain(op.node);
        await save("draining", {
          ...state,
          drainStartedAt: new Date().toISOString(),
        });
        return;
      }
      if (Date.now() - new Date(state.drainStartedAt).getTime() < 15_000)
        return;
      await driver.meter(op.node);
      await driver.suspend(op.node);
      await save("releasing", { ...state, drained: true });
    } else if (op.phase === "releasing") {
      if (!state.snapshot || !state.drained)
        throw new Error("NODE_CONFIG_MISSING");
      const result = await driver.release(state.snapshot);
      await save(
        result.done ? "released" : "releasing",
        { ...state, remaining: result.remaining },
        result.done,
      );
    } else if (op.phase === "preparing") {
      const retained = op.node.deploymentConfig as Snapshot | null;
      if (retained && !(await driver.verify(retained)).done)
        throw new Error("RELEASE_INCOMPLETE");
      const plan = await driver.prepare(op.node);
      if (plan.country !== op.node.country || plan.region !== op.node.region)
        throw new Error("CONNECTION_CHANGED");
      await driver.suspend(op.node);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(682139001)`;
        const lock = await tx.nodeLifecycle.updateMany({
          where: fence(),
          data: { leaseUntil: new Date(Date.now() + 300_000) },
        });
        if (!lock.count || lost) throw new Error("LIFECYCLE_LEASE_LOST");
        const current = await tx.nodeLifecycle.findUniqueOrThrow({
          where: { id },
        });
        if (current.machineId) return;
        const p = await tx.provisionPlan.create({
          data: {
            actorId: op.actorId,
            snapshot: json(plan),
            expiresAt: new Date(Date.now() + 900_000),
          },
        });
        const last = await tx.provisionOperation.aggregate({
          _max: { controlPort: true },
        });
        const lastNode = await tx.node.aggregate({
          _max: { controlPort: true },
        });
        const port =
          op.node.controlPort ??
          Math.max(
            22299,
            last._max.controlPort ?? 0,
            lastNode._max.controlPort ?? 0,
          ) + 1;
        if (port >= 23000) throw new Error("CONTROL_PORTS_EXHAUSTED");
        const machine = await tx.provisionOperation.create({
          data: {
            planId: p.id,
            actorId: op.actorId,
            idempotencyKey: op.id,
            nodeName: op.node.name,
            region: op.node.region,
            country: op.node.country,
            size: plan.size,
            controlPort: port,
            privateState: op.node.realityStateCipher,
            events: {
              create: {
                phase: "queued",
                message: "按保留配置重建，默认 32 GiB Standard HDD",
              },
            },
          },
        });
        await tx.node.update({
          where: { id: op.nodeId },
          data: {
            operationId: machine.id,
            controlPort: port,
            vmSize: plan.size,
          },
        });
        await tx.nodeLifecycle.update({
          where: { id },
          data: {
            machineId: machine.id,
            phase: "deploying",
            phaseStartedAt: new Date(),
            events: [
              ...(op.events as object[]),
              {
                at: new Date().toISOString(),
                message: "开始重建，验证成功后发布订阅",
              },
            ],
          },
        });
      });
    } else if (op.phase === "deploying") {
      if (!op.machineId) throw new Error("NODE_CONFIG_MISSING");
      const machine = await db.provisionOperation.findUniqueOrThrow({
        where: { id: op.machineId },
      });
      if (machine.status === "failed")
        throw new Error(machine.errorCode ?? "DeploymentFailed");
      if (machine.status === "ready") await save("ready", state, true);
    }
  } catch (error) {
    // Draining is asynchronous; give the engine time to flush its last counters.
    if (error instanceof Error && error.message === "NODE_DRAIN_PENDING")
      return;
    const code = provisionError(error).code;
    await db.nodeLifecycle.updateMany({
      where: fence(),
      data: { status: "failed", errorCode: code, finishedAt: new Date() },
    });
  } finally {
    clearInterval(heartbeat);
    await db.nodeLifecycle.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
export async function retryLifecycle(actorId: string, id: string) {
  const op = await db.nodeLifecycle.findUniqueOrThrow({ where: { id } });
  if (op.status !== "failed")
    throw new HttpException("任务不在可重试状态", 409);
  return createLifecycle(
    actorId,
    op.nodeId,
    op.action as "release" | "rebuild",
    randomUUID(),
  );
}
