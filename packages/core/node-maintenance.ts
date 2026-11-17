import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { Node, NodeMaintenanceBatch, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { phaseLabels } from "./provisioning.js";
import { nodeAction } from "./node-health.js";
import { azure, provisionError } from "./azure.js";
import {
  createLifecycle,
  lifecycleView,
  DEFAULT_SIZE,
} from "./node-lifecycle.js";
import { createRotation, rotationView } from "./ip-rotation.js";

export const maintenanceInput = z
  .object({
    action: z.enum([
      "enable",
      "disable",
      "restart",
      "reconnect",
      "rotate-ip",
      "release",
      "rebuild",
    ]),
    nodeIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length, "节点不可重复")
      .optional(),
    regions: z
      .array(z.string().regex(/^[a-z0-9]{2,40}$/))
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    all: z.literal(true).optional(),
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
      Number(!!v.nodeIds) + Number(!!v.regions) + Number(!!v.all) !== 1 ||
      (v.regions && v.action !== "rebuild") ||
      (v.all && v.action !== "release")
    )
      ctx.addIssue({
        code: "custom",
        message: "请选择节点，或指定启动区域，或回收全部机器",
      });
    if (
      v.plans &&
      (v.action !== "rotate-ip" ||
        new Set(v.plans.map((p) => p.nodeId)).size !== v.plans.length ||
        v.plans.some((p) => !v.nodeIds?.includes(p.nodeId)))
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
  lifecycleId?: string;
  expectedOperationId?: string | null;
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
  if (action === "release" || action === "rebuild") {
    if (
      node.activeIpRotationId ||
      (node.controlLeaseUntil && node.controlLeaseUntil > new Date())
    )
      return "节点有其他操作进行中，已跳过";
    if (node.activeLifecycleId) return null;
    if (action === "release" && node.resourceState === "released")
      return "节点已经回收";
    if (action === "rebuild" && node.resourceState !== "released")
      return "该区域已有机器，已跳过；需要更换时请先回收";
    return null;
  }
  if (node.activeLifecycleId || node.resourceState !== "active")
    return "节点正在回收/重建或已释放，已跳过";
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
    ({ planId, expectedOperationId, ...item }) => item,
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
export async function createMaintenance(
  actorId: string,
  value: unknown,
  catalog = () =>
    azure<{
      locations: { name: string; country: string | null; available: boolean }[];
    }>("catalog"),
) {
  const input = maintenanceInput.parse(value);
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        nodeIds: [...(input.nodeIds ?? [])].sort(),
        ...(input.regions ? { regions: [...input.regions].sort() } : {}),
        ...(input.all ? { all: true } : {}),
        plans: [...(input.plans ?? [])].sort((a, b) =>
          a.nodeId.localeCompare(b.nodeId),
        ),
      }),
    )
    .digest("hex");
  const accepted = await db.nodeMaintenanceBatch.findUnique({
    where: {
      actorId_idempotencyKey: { actorId, idempotencyKey: input.idempotencyKey },
    },
  });
  if (accepted) {
    if (accepted.requestHash !== requestHash)
      throw new HttpException("请求标识已用于其他批量操作", 409);
    return maintenanceView(accepted);
  }
  const locations = input.regions ? (await catalog()).locations : [];
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
    let nodeIds = input.nodeIds ?? [];
    if (input.all)
      nodeIds = (
        await tx.node.findMany({
          where: { resourceState: { not: "released" } },
          select: { id: true },
          orderBy: { name: "asc" },
        })
      ).map((n) => n.id);
    if (input.regions) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(682139003)`;
      for (const region of [...input.regions].sort()) {
        const loc = locations.find(
          (l) => l.name === region && l.available && l.country,
        );
        if (!loc) throw new HttpException("Azure 区域不可用：" + region, 409);
        const existing = await tx.node.findMany({
          where: { region },
          orderBy: { name: "asc" },
        });
        let node =
          existing.find((n) => n.resourceState !== "released") ?? existing[0];
        if (!node)
          node = await tx.node.create({
            data: {
              id: "xz-" + region,
              name: "xz-" + region,
              region,
              country: loc.country!,
              address: "",
              publicKey: "",
              shortId: "",
              serverName: "www.cloudflare.com",
              publishedAt: null,
              enabled: false,
              ready: false,
              resourceState: "released",
              vmSize: DEFAULT_SIZE,
              diskType: "Standard_LRS",
              globalPool: true,
            },
          });
        nodeIds.push(node.id);
      }
    }
    const nodes = await tx.node.findMany({ where: { id: { in: nodeIds } } });
    const plans = await tx.provisionPlan.findMany({
      where: {
        id: { in: (input.plans ?? []).map((p) => p.planId) },
        actorId,
        kind: "ip-rotation",
        expiresAt: { gt: new Date() },
      },
    });
    const items: MaintenanceItem[] = nodeIds.map((nodeId) => {
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
        ...(["release", "rebuild"].includes(input.action)
          ? { expectedOperationId: node?.operationId ?? null }
          : {}),
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
        detail: { action: input.action, nodeIds },
      },
    });
    return maintenanceView(batch);
  });
}

export interface MaintenanceDriver {
  execute: typeof nodeAction;
  rotate: typeof createRotation;
  lifecycle?: typeof createLifecycle;
}
const driverDefault: MaintenanceDriver = {
  execute: nodeAction,
  rotate: createRotation,
  lifecycle: createLifecycle,
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
      if (action === "release" || action === "rebuild") {
        const op = item.lifecycleId
          ? await db.nodeLifecycle.findUnique({
              where: { id: item.lifecycleId },
            })
          : await db.nodeLifecycle.findUnique({
              where: {
                actorId_idempotencyKey: {
                  actorId: batch.actorId,
                  idempotencyKey: item.id,
                },
              },
            });
        if (!op) {
          item.status = "queued";
          continue;
        }
        item.lifecycleId = op.id;
        item.status =
          op.status === "complete"
            ? "ready"
            : op.status === "failed"
              ? "failed"
              : "running";
        item.message =
          op.status === "failed"
            ? (lifecycleView(op).error ?? "任务失败，可重试")
            : lifecycleView(op).phaseLabel;
        if (op.status === "running" && op.machineId) {
          const m = await db.provisionOperation.findUnique({
            where: { id: op.machineId },
            select: { phase: true },
          });
          if (m) item.message += " · " + (phaseLabels[m.phase] ?? m.phase);
        }
      } else if (action !== "rotate-ip") {
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
    const changedGeneration =
      (action === "release" || action === "rebuild") &&
      item.expectedOperationId !== undefined &&
      node &&
      node.operationId !== item.expectedOperationId;
    const reason = changedGeneration
      ? "节点已由其他任务重新部署，请重新选择；本次操作已跳过"
      : unavailable(node ?? undefined, action);
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
      if (action === "release" || action === "rebuild") {
        const op = await (driver.lifecycle ?? createLifecycle)(
          batch.actorId,
          item.nodeId,
          action,
          item.id,
        );
        item.lifecycleId = op.id;
        item.message = action === "release" ? "正在回收资源" : "正在重建机器";
      } else if (action === "rotate-ip") {
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
      if (action === "release" || action === "rebuild") {
        const accepted = await db.nodeLifecycle.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId: batch.actorId,
              idempotencyKey: item.id,
            },
          },
        });
        if (accepted) {
          item.lifecycleId = accepted.id;
          item.message = "任务已恢复";
          await save();
          return;
        }
        item.status = "failed";
        item.message =
          error instanceof HttpException
            ? error.message
            : provisionError(error).message;
        await save();
        return;
      }
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
