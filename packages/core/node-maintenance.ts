import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { Node, NodeMaintenanceBatch, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { nodeAction } from "./node-health.js";
import { createRotation, rotationView } from "./ip-rotation.js";

export const maintenanceInput = z
  .object({
    action: z.enum(["enable", "disable", "restart", "reconnect", "rotate-ip"]),
    nodeIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length, "节点不可重复"),
    idempotencyKey: z.string().uuid(),
    plans: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(100),
            planId: z.string().uuid(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.plans &&
      (v.action !== "rotate-ip" ||
        new Set(v.plans.map((p) => p.nodeId)).size !== v.plans.length ||
        v.plans.some((p) => !v.nodeIds.includes(p.nodeId)))
    )
      ctx.addIssue({ code: "custom", message: "预检与节点不匹配" });
    if (v.action === "rotate-ip" && !v.plans?.length)
      ctx.addIssue({ code: "custom", message: "请先预检轮换 IP" });
  });
type Input = z.infer<typeof maintenanceInput>;
type Action = Input["action"];
export type MaintenanceItem = {
  id: string;
  nodeId: string;
  name: string;
  planId?: string;
  rotationId?: string;
  status:
    | "queued"
    | "running"
    | "accepted"
    | "ready"
    | "failed"
    | "skipped"
    | "unknown";
  message: string;
};
const pending = (item: MaintenanceItem) =>
  ["queued", "running"].includes(item.status);
function unavailable(node: Node | undefined, action: Action) {
  if (!node) return "节点不存在";
  if (!node.publishedAt) return "节点尚未上线，已跳过";
  if (!node.engineNodeId) return "节点未接入管理引擎，已跳过";
  if (
    node.activeIpRotationId ||
    (node.controlLeaseUntil && node.controlLeaseUntil > new Date())
  )
    return "节点有其他操作进行中，已跳过";
  if (action === "rotate-ip" && !node.enabled) return "请先启用节点，再轮换 IP";
  return null;
}
export function maintenanceView(batch: NodeMaintenanceBatch) {
  const items = (batch.items as unknown as MaintenanceItem[]).map(
    ({ planId, ...item }) => item,
  );
  return {
    id: batch.id,
    action: batch.action,
    status: batch.status,
    items,
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    counts: {
      total: items.length,
      pending: items.filter(pending).length,
      succeeded: items.filter((i) => ["accepted", "ready"].includes(i.status))
        .length,
      failed: items.filter((i) => ["failed", "unknown"].includes(i.status))
        .length,
      skipped: items.filter((i) => i.status === "skipped").length,
    },
  };
}
export async function createMaintenance(actorId: string, value: unknown) {
  const input = maintenanceInput.parse(value);
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        nodeIds: [...input.nodeIds].sort(),
        plans: [...(input.plans ?? [])].sort((a, b) =>
          a.nodeId.localeCompare(b.nodeId),
        ),
      }),
    )
    .digest("hex");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actorId + input.idempotencyKey}))`;
    const prior = await tx.nodeMaintenanceBatch.findUnique({
      where: {
        actorId_idempotencyKey: {
          actorId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new HttpException("请求标识已用于其他批量操作", 409);
      return maintenanceView(prior);
    }
    const nodes = await tx.node.findMany({
      where: { id: { in: input.nodeIds } },
    });
    const plans = await tx.provisionPlan.findMany({
      where: {
        id: { in: (input.plans ?? []).map((p) => p.planId) },
        actorId,
        kind: "ip-rotation",
        expiresAt: { gt: new Date() },
      },
    });
    const items: MaintenanceItem[] = input.nodeIds.map((nodeId) => {
      const node = nodes.find((n) => n.id === nodeId);
      const planId = input.plans?.find((p) => p.nodeId === nodeId)?.planId;
      const plan = plans.find((p) => p.id === planId);
      const snapshot = plan?.snapshot as
        | { nodeId?: string; oldAddress?: string }
        | undefined;
      const reason =
        unavailable(node, input.action) ??
        (input.action === "rotate-ip" &&
        (!plan ||
          snapshot?.nodeId !== nodeId ||
          snapshot.oldAddress !== node?.address)
          ? "轮换预检未通过或已过期，请重新检查"
          : null);
      return {
        id: randomUUID(),
        nodeId,
        name: node?.name ?? nodeId,
        ...(plan && !reason ? { planId: plan.id } : {}),
        status: reason ? "skipped" : "queued",
        message: reason ?? "等待执行",
      };
    });
    const complete = !items.some(pending);
    const batch = await tx.nodeMaintenanceBatch.create({
      data: {
        actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        action: input.action,
        items: items as unknown as Prisma.InputJsonValue,
        status: complete ? "complete" : "running",
        finishedAt: complete ? new Date() : null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "node.batch.requested",
        targetId: batch.id,
        detail: { action: input.action, nodeIds: input.nodeIds },
      },
    });
    return maintenanceView(batch);
  });
}

export interface MaintenanceDriver {
  execute: typeof nodeAction;
  rotate: typeof createRotation;
}
const driverDefault: MaintenanceDriver = {
  execute: nodeAction,
  rotate: createRotation,
};
export async function advanceMaintenance(id: string, driver = driverDefault) {
  const owner = randomUUID();
  const acquired = await db.nodeMaintenanceBatch.updateMany({
    where: {
      id,
      status: "running",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 300_000) },
  });
  if (!acquired.count) return;
  const fence = () => ({
    id,
    leaseOwner: owner,
    status: "running",
    leaseUntil: { gt: new Date() },
  });
  let lost = false;
  const heartbeat = setInterval(() => {
    db.nodeMaintenanceBatch
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
  try {
    const batch = await db.nodeMaintenanceBatch.findUniqueOrThrow({
      where: { id },
    });
    const action = batch.action as Action;
    const items = batch.items as unknown as MaintenanceItem[];
    async function save() {
      if (lost) throw new Error("MAINTENANCE_LEASE_LOST");
      const complete = !items.some(pending);
      const result = await db.nodeMaintenanceBatch.updateMany({
        where: fence(),
        data: {
          items: items as unknown as Prisma.InputJsonValue,
          status: complete ? "complete" : "running",
          finishedAt: complete ? new Date() : null,
        },
      });
      if (!result.count) throw new Error("MAINTENANCE_LEASE_LOST");
    }
    // An interrupted engine request may have succeeded. Never automatically replay
    // a restart (or other maintenance action) merely because its response was lost.
    for (const item of items.filter((i) => i.status === "running")) {
      if (action !== "rotate-ip") {
        item.status = "unknown";
        item.message =
          "上次执行被中断，结果待核实；请检查节点后决定是否重新操作";
      } else if (item.rotationId) {
        const op = await db.ipRotation.findUnique({
          where: { id: item.rotationId },
        });
        if (!op) {
          item.status = "unknown";
          item.message = "轮换任务记录缺失，请核对节点";
        } else if (op.status === "ready") {
          item.status = "ready";
          item.message = "新 IP 已发布，旧 IP 已释放";
        } else if (op.status === "failed" || op.status === "rolled_back") {
          item.status = "failed";
          item.message =
            op.status === "rolled_back"
              ? "已回滚原 IP"
              : (rotationView(op).error ?? "轮换暂停，请查看任务");
        } else item.message = rotationView(op).phaseLabel;
      } else item.status = "queued"; // createRotation's item UUID is its stable idempotency key.
    }
    await save();
    const item = items.find((i) => i.status === "queued");
    if (!item) return;
    // Recover an accepted IP rotation before checking a node's exclusive rotation lock.
    if (action === "rotate-ip") {
      const prior = await db.ipRotation.findUnique({
        where: {
          actorId_idempotencyKey: {
            actorId: batch.actorId,
            idempotencyKey: item.id,
          },
        },
      });
      if (prior) {
        item.rotationId = prior.id;
        item.status = "running";
        item.message = "轮换任务已接管";
        await save();
        return;
      }
    }
    const node = await db.node.findUnique({ where: { id: item.nodeId } });
    const reason = unavailable(node ?? undefined, action);
    if (reason) {
      item.status = "skipped";
      item.message = reason;
      await save();
      return;
    }
    item.status = "running";
    item.message = "正在执行";
    await save(); // Persist before the side effect; a crash becomes 'unknown', not a blind retry.
    try {
      if (action === "rotate-ip") {
        const op = await driver.rotate(
          batch.actorId,
          item.nodeId,
          item.planId!,
          item.id,
        );
        item.rotationId = op.id;
        item.message = "轮换任务已提交";
      } else {
        await driver.execute(item.nodeId, action, batch.actorId);
        item.status = "accepted";
        item.message = "操作已提交，以节点最新检测状态为准";
      }
    } catch (error) {
      if (action === "rotate-ip") {
        const accepted = await db.ipRotation.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId: batch.actorId,
              idempotencyKey: item.id,
            },
          },
        });
        if (accepted) {
          item.rotationId = accepted.id;
          item.message = "轮换任务已恢复";
          await save();
          return;
        }
      }
      const code = error instanceof Error ? error.message : "";
      item.status = code === "NODE_BUSY" ? "skipped" : "failed";
      item.message =
        code === "NODE_BUSY"
          ? "节点有其他操作进行中，已跳过"
          : action === "rotate-ip"
            ? "轮换提交未完成，请检查预览有效期和节点状态"
            : "操作未完成，请检查节点状态；停用请求可能仍在后台同步";
    }
    await save();
  } finally {
    clearInterval(heartbeat);
    await db.nodeMaintenanceBatch.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
