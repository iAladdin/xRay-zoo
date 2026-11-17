import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { Prisma, IpRotation, Node } from "@prisma/client";
import { db } from "./db.js";
import { azureIp, provisionError } from "./azure.js";
import { engine } from "../engine-remnawave/client.js";
import { controlTunnels } from "./node-health.js";
import { probeNode } from "./provisioning-driver.js";

type Snapshot = {
  nodeId: string;
  nodeName: string;
  oldAddress: string;
  region: string;
  resourceGroup: string;
  vmId: string;
  nicId: string;
  oldIpId: string;
  [key: string]: Prisma.JsonValue;
};
type Checkpoint = { published?: boolean; restored?: boolean };
type Event = { at: string; message: string };
export type RotationOperation = IpRotation & {
  node: Node;
  plan: { snapshot: Prisma.JsonValue };
};
export interface RotationDriver {
  allocate(op: RotationOperation): Promise<unknown>;
  allocated(
    op: RotationOperation,
  ): Promise<{ state: string; address?: string }>;
  bind(op: RotationOperation, restore: boolean): Promise<{ done: boolean }>;
  reconnect(op: RotationOperation, restore: boolean): Promise<void>;
  verify(op: RotationOperation, restore: boolean): Promise<boolean>;
  publish(op: RotationOperation, restore: boolean): Promise<void>;
  cleanup(op: RotationOperation, rollback: boolean): Promise<{ done: boolean }>;
}
export const rotationLabels: Record<string, string> = {
  queued: "等待轮换",
  allocating: "分配新公网 IP",
  switching: "切换网卡绑定",
  reconnecting: "恢复控制连接",
  verifying: "验证新 IP 连接",
  publishing: "更新订阅配置",
  cleanup: "释放旧 IP",
  ready: "轮换完成",
  "rolling-back": "恢复原 IP",
  "rollback-reconnecting": "恢复原控制连接",
  "rollback-verifying": "验证原 IP",
  "rollback-publishing": "恢复原订阅配置",
  "rollback-cleanup": "释放本次新 IP",
  rolled_back: "已回滚原 IP",
};
export const rotationSelect = {
  id: true,
  nodeId: true,
  oldAddress: true,
  newAddress: true,
  phase: true,
  status: true,
  errorCode: true,
  events: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
} satisfies Prisma.IpRotationSelect;
export function rotationView<
  T extends { phase: string; errorCode: string | null },
>(op: T) {
  return {
    ...op,
    phaseLabel: rotationLabels[op.phase] ?? op.phase,
    error: op.errorCode
      ? provisionError(new Error(op.errorCode)).message
      : null,
    canRollback:
      !["cleanup", "ready", "rolled_back"].includes(op.phase) &&
      !op.phase.startsWith("rollback") &&
      op.phase !== "rolling-back",
  };
}
function events(
  previous: Prisma.JsonValue,
  message: string,
): Prisma.InputJsonValue {
  return [
    ...(previous as Event[]),
    { at: new Date().toISOString(), message },
  ].slice(-40);
}
export async function previewRotation(actorId: string, nodeId: string) {
  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) throw new HttpException("节点不存在", 404);
  if (!node.publishedAt || !node.enabled || !node.engineNodeId || !node.squadId)
    throw new HttpException("仅可轮换已发布且启用的托管节点", 409);
  if (
    node.activeIpRotationId ||
    (node.controlLeaseUntil && node.controlLeaseUntil > new Date())
  )
    throw new HttpException("节点有操作进行中，请先查看当前任务", 409);
  const snapshot = await azureIp<Snapshot>("preview", {
    nodeName: node.name,
    address: node.address,
    vmId: node.azureVmId,
  });
  const plan = await db.provisionPlan.create({
    data: {
      actorId,
      kind: "ip-rotation",
      snapshot: { ...snapshot, nodeId },
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  return {
    planId: plan.id,
    expiresAt: plan.expiresAt,
    nodeName: node.name,
    oldAddress: node.address,
    region: node.region,
    resourceGroup: snapshot.resourceGroup,
  };
}
export async function createRotation(
  actorId: string,
  nodeId: string,
  planId: string,
  idempotencyKey: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(682139002)`;
    const prior = await tx.ipRotation.findUnique({
      where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
    });
    if (prior) {
      if (prior.nodeId !== nodeId || prior.planId !== planId)
        throw new HttpException("请求标识已用于其他轮换", 409);
      return { id: prior.id };
    }
    const existing = await tx.ipRotation.findUnique({ where: { planId } });
    if (existing) {
      if (existing.actorId !== actorId || existing.nodeId !== nodeId)
        throw new HttpException("无权使用此预览", 403);
      return { id: existing.id };
    }
    const plan = await tx.provisionPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.actorId !== actorId || plan.kind !== "ip-rotation")
      throw new HttpException("轮换预览不存在", 404);
    if (plan.expiresAt <= new Date())
      throw new HttpException("预览已过期，请重新检查", 409);
    const snapshot = plan.snapshot as Snapshot;
    if (snapshot.nodeId !== nodeId)
      throw new HttpException("预览与节点不匹配", 409);
    const id = randomUUID();
    const locked = await tx.node.updateMany({
      where: {
        id: nodeId,
        activeIpRotationId: null,
        publishedAt: { not: null },
        enabled: true,
        address: snapshot.oldAddress,
        OR: [
          { controlLeaseUntil: null },
          { controlLeaseUntil: { lt: new Date() } },
        ],
      },
      data: { activeIpRotationId: id },
    });
    if (!locked.count)
      throw new HttpException("节点状态已变化或有操作进行中，请刷新", 409);
    await tx.ipRotation.create({
      data: {
        id,
        nodeId,
        planId,
        actorId,
        idempotencyKey,
        oldAddress: snapshot.oldAddress,
        events: events([], "已提交 IP 轮换，分配新 IP 期间原节点保持服务"),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "ip-rotation.create",
        targetId: id,
        detail: { nodeId, oldAddress: snapshot.oldAddress },
      },
    });
    return { id };
  });
}
export async function retryRotation(
  actorId: string,
  id: string,
  rollback = false,
) {
  return db.$transaction(async (tx) => {
    const locked = await tx.ipRotation.updateMany({
      where: {
        id,
        status: "failed",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: {
        status: "running",
        errorCode: null,
        phaseStartedAt: new Date(),
        finishedAt: null,
      },
    });
    if (!locked.count) throw new HttpException("任务不在可重试状态", 409);
    const op = await tx.ipRotation.findUniqueOrThrow({ where: { id } });
    const state = op.checkpoint as Checkpoint;
    if (
      rollback &&
      (state.published || state.restored || !rotationView(op).canRollback)
    )
      throw new HttpException(
        "该任务已进入资源清理，无法回滚；请重试清理",
        409,
      );
    await tx.ipRotation.update({
      where: { id },
      data: {
        ...(rollback
          ? { phase: "rolling-back" }
          : op.phase === "allocating"
            ? { phase: "queued" }
            : {}),
        events: events(
          op.events,
          rollback
            ? "管理员请求恢复原 IP；验证后释放本次新 IP"
            : "管理员重试当前阶段，沿用已有 IP 资源",
        ),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: rollback ? "ip-rotation.rollback" : "ip-rotation.retry",
        targetId: id,
        detail: { nodeId: op.nodeId },
      },
    });
    return { id };
  });
}
const input = (op: RotationOperation) => ({
  snapshot: op.plan.snapshot,
  operationId: op.id,
});
const productionDriver: RotationDriver = {
  allocate: (op) => azureIp("allocate", input(op)),
  allocated: (op) => azureIp("allocated", input(op)),
  bind: (op, restore) => azureIp(restore ? "restore" : "bind", input(op)),
  async reconnect(op, restore) {
    await azureIp(restore ? "restore-route" : "route", input(op));
    const tunnels = await controlTunnels(true, op.nodeId);
    if (!tunnels.some((t) => t.id === op.nodeId && t.connected))
      throw new Error("CONTROL_TRANSPORT_UNAVAILABLE");
  },
  verify: (op, restore) =>
    probeNode(
      { ...op.node, address: restore ? op.oldAddress : op.newAddress! },
      op.id,
    ),
  async publish(op, restore) {
    const response = await engine.request<
      | {
          uuid: string;
          remark: string;
          address: string;
          inbound?: { configProfileInboundUuid: string };
        }[]
      | {
          hosts: {
            uuid: string;
            remark: string;
            address: string;
            inbound?: { configProfileInboundUuid: string };
          }[];
        }
    >("/hosts");
    const hosts = Array.isArray(response) ? response : response.hosts;
    const matches = hosts.filter((h) => h.remark === op.node.name);
    if (
      matches.length !== 1 ||
      ![op.oldAddress, op.newAddress].includes(matches[0].address) ||
      matches[0].inbound?.configProfileInboundUuid !== op.node.inboundId
    )
      throw new Error("IP_HOST_MISMATCH");
    await engine.request("/hosts", "PATCH", {
      uuid: matches[0].uuid,
      address: restore ? op.oldAddress : op.newAddress,
    });
  },
  cleanup: (op, rollback) =>
    azureIp(rollback ? "rollback-cleanup" : "cleanup", input(op)),
};

export async function advanceRotation(
  id: string,
  driver: RotationDriver = productionDriver,
) {
  const owner = randomUUID();
  const acquired = await db.ipRotation.updateMany({
    where: {
      id,
      status: "running",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 300_000) },
  });
  if (!acquired.count) return;
  let leaseLost = false;
  const leaseWhere = () => ({
    id,
    leaseOwner: owner,
    status: "running",
    leaseUntil: { gt: new Date() },
  });
  async function renewLease() {
    if (leaseLost) throw new Error("PROVISION_LEASE_LOST");
    const renewed = await db.ipRotation.updateMany({
      where: leaseWhere(),
      data: { leaseUntil: new Date(Date.now() + 300_000) },
    });
    if (!renewed.count) {
      leaseLost = true;
      throw new Error("PROVISION_LEASE_LOST");
    }
  }
  const heartbeat = setInterval(() => {
    renewLease().catch(() => {
      leaseLost = true;
    });
  }, 30_000);
  async function change(
    phase: string,
    data: Prisma.IpRotationUpdateManyMutationInput = {},
  ) {
    await db.$transaction(async (tx) => {
      const locked = await tx.ipRotation.updateMany({
        where: leaseWhere(),
        data: { ...data, phase, phaseStartedAt: new Date() },
      });
      if (!locked.count) throw new Error("PROVISION_LEASE_LOST");
      const op = await tx.ipRotation.findUniqueOrThrow({ where: { id } });
      await tx.ipRotation.update({
        where: { id },
        data: { events: events(op.events, rotationLabels[phase]) },
      });
    });
  }
  async function maintenance(nodeId: string) {
    await db.$transaction(async (tx) => {
      const fenced = await tx.ipRotation.updateMany({
        where: leaseWhere(),
        data: { leaseUntil: new Date(Date.now() + 300_000) },
      });
      if (!fenced.count) throw new Error("PROVISION_LEASE_LOST");
      const changed = await tx.node.updateMany({
        where: { id: nodeId, activeIpRotationId: id },
        data: { addressChanging: true, ready: false },
      });
      if (!changed.count) throw new Error("PROVISION_LEASE_LOST");
    });
  }
  async function publish(op: RotationOperation, restore: boolean) {
    await driver.publish(op, restore);
    await db.$transaction(async (tx) => {
      const fenced = await tx.ipRotation.updateMany({
        where: leaseWhere(),
        data: { leaseUntil: new Date(Date.now() + 300_000) },
      });
      if (!fenced.count) throw new Error("PROVISION_LEASE_LOST");
      const address = restore ? op.oldAddress : op.newAddress!;
      const changed = await tx.node.updateMany({
        where: { id: op.nodeId, activeIpRotationId: id },
        data: {
          address,
          addressChanging: false,
          ready: true,
          checkedAt: new Date(),
          lastHealthyAt: new Date(),
          healthReason: "READY",
          transportConnected: true,
          engineConnected: true,
          engineDisabled: false,
        },
      });
      if (!changed.count) throw new Error("PROVISION_LEASE_LOST");
      await tx.ipRotation.update({
        where: { id },
        data: {
          phase: restore ? "rollback-cleanup" : "cleanup",
          phaseStartedAt: new Date(),
          checkpoint: restore ? { restored: true } : { published: true },
          events: events(
            op.events,
            restore
              ? "原 IP 已恢复；清理本次新 IP"
              : "新 IP 验证通过，订阅配置已更新；开始释放旧 IP",
          ),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: op.actorId,
          action: restore ? "ip-rotation.restored" : "ip-rotation.published",
          targetId: id,
          detail: { nodeId: op.nodeId, address },
        },
      });
    });
  }
  async function finish(op: RotationOperation, restore: boolean) {
    await db.$transaction(async (tx) => {
      const status = restore ? "rolled_back" : "ready";
      const changed = await tx.ipRotation.updateMany({
        where: leaseWhere(),
        data: {
          phase: status,
          status,
          finishedAt: new Date(),
          errorCode: null,
          events: events(op.events, rotationLabels[status]),
        },
      });
      if (!changed.count) throw new Error("PROVISION_LEASE_LOST");
      await tx.node.updateMany({
        where: { id: op.nodeId, activeIpRotationId: id },
        data: { activeIpRotationId: null },
      });
    });
  }
  try {
    const op = await db.ipRotation.findUniqueOrThrow({
      where: { id },
      include: { node: true, plan: true },
    });
    if (op.node.activeIpRotationId !== id)
      throw new Error("PROVISION_LEASE_LOST");
    if (Date.now() - op.phaseStartedAt.getTime() > 30 * 60_000)
      throw new Error("IP_ROTATION_TIMEOUT");
    await renewLease();
    if (op.phase === "queued") {
      await driver.allocate(op);
      await change("allocating");
    } else if (op.phase === "allocating") {
      const current = await driver.allocated(op);
      if (current.state === "Failed") throw new Error("IP_ALLOCATION_FAILED");
      if (current.state === "Succeeded") {
        if (!current.address || current.address === op.oldAddress)
          throw new Error("IP_ALLOCATION_INVALID");
        await change("switching", { newAddress: current.address });
      }
    } else if (op.phase === "switching" || op.phase === "rolling-back") {
      const restore = op.phase === "rolling-back";
      await maintenance(op.nodeId);
      if (await driver.bind(op, restore).then((x) => x.done))
        await change(restore ? "rollback-reconnecting" : "reconnecting");
    } else if (
      op.phase === "reconnecting" ||
      op.phase === "rollback-reconnecting"
    ) {
      const restore = op.phase.startsWith("rollback");
      await driver.reconnect(op, restore);
      await change(restore ? "rollback-verifying" : "verifying");
    } else if (op.phase === "verifying" || op.phase === "rollback-verifying") {
      const restore = op.phase.startsWith("rollback");
      if (await driver.verify(op, restore))
        await change(restore ? "rollback-publishing" : "publishing");
    } else if (op.phase === "publishing" || op.phase === "rollback-publishing")
      await publish(op, op.phase.startsWith("rollback"));
    else if (op.phase === "cleanup" || op.phase === "rollback-cleanup") {
      const restore = op.phase.startsWith("rollback");
      if (await driver.cleanup(op, restore).then((x) => x.done))
        await finish(op, restore);
    } else throw new Error("INVALID_PROVISION_PHASE");
  } catch (error) {
    const e = provisionError(error);
    await db.$transaction(async (tx) => {
      const changed = await tx.ipRotation.updateMany({
        where: leaseWhere(),
        data: { status: "failed", errorCode: e.code, finishedAt: new Date() },
      });
      if (changed.count) {
        const op = await tx.ipRotation.findUniqueOrThrow({ where: { id } });
        await tx.ipRotation.update({
          where: { id },
          data: { events: events(op.events, e.message) },
        });
      }
    });
  } finally {
    clearInterval(heartbeat);
    await db.ipRotation.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
