import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { Prisma, ProvisionOperation } from "@prisma/client";
import { db } from "./db.js";
import { azure, type AzurePlanSnapshot, provisionError } from "./azure.js";
import { productionProvisionDriver } from "./provisioning-driver.js";

export const phases = [
  "queued",
  "provisioning",
  "installing",
  "registering",
  "verifying",
  "publishing",
  "ready",
] as const;
export const phaseLabels: Record<string, string> = {
  queued: "等待创建",
  provisioning: "创建 Azure 资源",
  installing: "自动安装节点",
  registering: "接入控制引擎",
  verifying: "验证真实连接",
  publishing: "更新订阅节点池",
  ready: "已上线",
};
export const machineSelect = {
  id: true,
  nodeName: true,
  region: true,
  country: true,
  size: true,
  phase: true,
  status: true,
  azureState: true,
  errorCode: true,
  attempts: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
  events: {
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, phase: true, message: true, createdAt: true },
  },
} satisfies Prisma.ProvisionOperationSelect;
type Checkpoint = {
  address?: string;
  vmId?: string;
  hostKey?: string;
  installSubmitted?: boolean;
  published?: boolean;
  targets?: { id: string; version: number }[];
};
export type MachineOperation = ProvisionOperation & {
  plan: { snapshot: Prisma.JsonValue };
};
export interface ProvisionDriver {
  submit(op: MachineOperation): Promise<{ azureState?: string }>;
  poll(op: MachineOperation): Promise<{
    azureState: string;
    address?: string;
    vmId?: string;
    errorCode?: string;
  }>;
  install(op: MachineOperation): Promise<unknown>;
  installed(
    op: MachineOperation,
  ): Promise<{ azureState: string; hostKey?: string }>;
  register(op: MachineOperation): Promise<void>;
  verify(op: MachineOperation): Promise<boolean>;
}
export function machineView<
  T extends { phase: string; errorCode: string | null },
>(row: T) {
  return {
    ...row,
    phaseLabel: phaseLabels[row.phase] ?? row.phase,
    progress: Math.round(
      (Math.max(0, phases.indexOf(row.phase as (typeof phases)[number])) /
        (phases.length - 1)) *
        100,
    ),
    error: row.errorCode
      ? provisionError(new Error(row.errorCode)).message
      : null,
  };
}
export async function previewMachine(
  actorId: string,
  region: string,
  size: string,
) {
  const snapshot = await azure<AzurePlanSnapshot>("prepare", { region, size });
  const plan = await db.provisionPlan.create({
    data: { actorId, snapshot, expiresAt: new Date(Date.now() + 15 * 60_000) },
  });
  return {
    planId: plan.id,
    expiresAt: plan.expiresAt,
    subscription: snapshot.subscription,
    resourceGroup: snapshot.resourceGroup,
    region: snapshot.region,
    regionName: snapshot.regionName,
    country: snapshot.country,
    size: snapshot.size,
    vcpus: snapshot.vcpus,
    memoryGiB: snapshot.memoryGiB,
    cost: snapshot.cost,
  };
}
export async function createMachine(
  actorId: string,
  planId: string,
  idempotencyKey: string,
) {
  return db.$transaction(async (tx) => {
    // Serialize local port allocation and double-clicks, including cross-worker submissions.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(682139001)`;
    const existing = await tx.provisionOperation.findUnique({
      where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
    });
    if (existing) {
      if (existing.planId !== planId)
        throw new HttpException("请求标识已用于其他部署", 409);
      return { id: existing.id };
    }
    const duplicate = await tx.provisionOperation.findUnique({
      where: { planId },
    });
    if (duplicate) {
      if (duplicate.actorId !== actorId)
        throw new HttpException("无权使用该预览", 403);
      return { id: duplicate.id };
    }
    const plan = await tx.provisionPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.actorId !== actorId || plan.kind !== "machine")
      throw new HttpException("部署预览不存在", 404);
    if (plan.expiresAt <= new Date())
      throw new HttpException("预览已过期，请重新检查规格与费用", 409);
    const p = plan.snapshot as unknown as AzurePlanSnapshot;
    const last = await tx.provisionOperation.aggregate({
      _max: { controlPort: true },
    });
    const port = Math.max(22299, last._max.controlPort ?? 0) + 1;
    if (port >= 23000) throw new HttpException("本机控制端口已用完", 409);
    const id = randomUUID(),
      name = `xz-${p.region.slice(0, 18)}-${id.slice(0, 8)}`;
    const op = await tx.provisionOperation.create({
      data: {
        id,
        planId,
        actorId,
        idempotencyKey,
        nodeName: name,
        region: p.region,
        country: p.country,
        size: p.size,
        controlPort: port,
        events: {
          create: {
            phase: "queued",
            message: "已接受上机器请求，等待创建资源",
          },
        },
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "machine.create",
        targetId: id,
        detail: {
          region: p.region,
          size: p.size,
          nodeName: name,
          resourceGroup: p.resourceGroup,
        },
      },
    });
    return { id: op.id };
  });
}
export async function retryMachine(actorId: string, id: string) {
  return db.$transaction(async (tx) => {
    const previous = await tx.provisionOperation.findUnique({ where: { id } });
    if (!previous) throw new HttpException("任务不存在", 404);
    const phase = previous.phase === "provisioning" ? "queued" : previous.phase;
    const state = previous.checkpoint as Checkpoint;
    const changed = await tx.provisionOperation.updateMany({
      where: {
        id,
        status: "failed",
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: {
        status: "running",
        errorCode: null,
        attempts: { increment: 1 },
        phaseStartedAt: new Date(),
        finishedAt: null,
      },
    });
    if (!changed.count) throw new HttpException("任务不在可重试状态", 409);
    await tx.provisionOperation.update({
      where: { id },
      data: {
        phase,
        checkpoint: {
          ...state,
          ...(phase === "installing" ? { installSubmitted: false } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    const op = await tx.provisionOperation.findUniqueOrThrow({ where: { id } });
    await tx.provisionEvent.create({
      data: {
        operationId: id,
        phase: op.phase,
        message: "管理员请求重试，将沿用同一部署和资源名称",
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "machine.retry",
        targetId: id,
        detail: { phase: op.phase },
      },
    });
    return { id };
  });
}

// One durable step per job: Redis loss/restarts can recover from the database.
export async function advanceMachine(
  id: string,
  driver: ProvisionDriver = productionProvisionDriver,
) {
  const owner = randomUUID();
  const acquired = await db.provisionOperation.updateMany({
    where: {
      id,
      status: "running",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 300_000) },
  });
  if (!acquired.count) return;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    db.provisionOperation
      .updateMany({
        where: { id, leaseOwner: owner },
        data: { leaseUntil: new Date(Date.now() + 300_000) },
      })
      .then((x) => {
        if (!x.count) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, 30_000);
  async function checkpoint(
    phase: string,
    data: Checkpoint,
    azureState?: string,
  ) {
    if (leaseLost) throw new Error("PROVISION_LEASE_LOST");
    await db.$transaction(async (tx) => {
      const before = await tx.provisionOperation.findUniqueOrThrow({
        where: { id },
      });
      const changed = await tx.provisionOperation.updateMany({
        where: { id, leaseOwner: owner, status: "running" },
        data: {
          phase,
          checkpoint: data as Prisma.InputJsonValue,
          ...(azureState ? { azureState } : {}),
          ...(before.phase !== phase ? { phaseStartedAt: new Date() } : {}),
          ...(phase === "ready"
            ? { status: "ready", finishedAt: new Date() }
            : {}),
          errorCode: null,
        },
      });
      if (!changed.count) throw new Error("PROVISION_LEASE_LOST");
      if (before.phase !== phase)
        await tx.provisionEvent.create({
          data: { operationId: id, phase, message: phaseLabels[phase] },
        });
    });
  }
  try {
    const op = await db.provisionOperation.findUniqueOrThrow({
      where: { id },
      include: { plan: true },
    });
    const state = op.checkpoint as Checkpoint;
    if (Date.now() - op.phaseStartedAt.getTime() > 45 * 60_000)
      throw new Error("PROVISION_PHASE_TIMEOUT");
    if (op.phase === "queued") {
      const result = await driver.submit(op);
      await checkpoint("provisioning", state, result.azureState);
    } else if (op.phase === "provisioning") {
      const result = await driver.poll(op);
      if (["Failed", "Canceled"].includes(result.azureState))
        throw new Error(result.errorCode ?? "DeploymentFailed");
      if (result.azureState === "Succeeded") {
        if (!result.address || !result.vmId)
          throw new Error("AZURE_OUTPUTS_MISSING");
        await checkpoint(
          "installing",
          { ...state, address: result.address, vmId: result.vmId },
          result.azureState,
        );
      } else await checkpoint("provisioning", state, result.azureState);
    } else if (op.phase === "installing") {
      const existing = await driver.installed(op);
      if (existing.azureState === "Succeeded") {
        if (!existing.hostKey) throw new Error("SSH_HOST_KEY_NOT_REPORTED");
        await checkpoint(
          "registering",
          { ...state, hostKey: existing.hostKey },
          existing.azureState,
        );
      } else if (
        !state.installSubmitted &&
        ["NotFound", "Failed", "Canceled"].includes(existing.azureState)
      ) {
        await driver.install(op);
        await checkpoint(
          "installing",
          { ...state, installSubmitted: true },
          "Installing",
        );
      } else if (["Failed", "Canceled"].includes(existing.azureState))
        throw new Error("INSTALLATION_FAILED");
      else if (!state.installSubmitted)
        await checkpoint(
          "installing",
          { ...state, installSubmitted: true },
          existing.azureState,
        );
    } else if (op.phase === "registering") {
      await driver.register(op);
      await checkpoint("verifying", state);
    } else if (op.phase === "verifying") {
      if (await driver.verify(op)) await checkpoint("publishing", state);
    } else if (op.phase === "publishing") {
      if (!state.published) {
        await db.$transaction(async (tx) => {
          // Lock/fence this row before publishing: an expired worker cannot commit over a new owner.
          const fenced = await tx.provisionOperation.updateMany({
            where: { id, leaseOwner: owner, status: "running" },
            data: { leaseUntil: new Date(Date.now() + 300_000) },
          });
          if (!fenced.count) throw new Error("PROVISION_LEASE_LOST");
          const current = await tx.provisionOperation.findUniqueOrThrow({
            where: { id },
          });
          if (current.leaseOwner !== owner)
            throw new Error("PROVISION_LEASE_LOST");
          const prior = current.checkpoint as Checkpoint;
          if (prior.published) return;
          const node = await tx.node.findUniqueOrThrow({
            where: { operationId: id },
          });
          await tx.node.update({
            where: { id: node.id },
            data: {
              publishedAt: new Date(),
              ready: true,
              enabled: true,
              checkedAt: new Date(),
              healthReason: "READY",
              engineConnected: true,
              transportConnected: true,
              globalPool: true,
            },
          });
          const subs = await tx.subscription.findMany({
            where: {
              OR: [{ globalPool: true }, { regions: { has: op.country } }],
            },
            select: { id: true },
          });
          const targets = [];
          for (const sub of subs) {
            const s = await tx.subscription.update({
              where: { id: sub.id },
              data: { desiredVersion: { increment: 1 } },
            });
            targets.push({ id: s.id, version: s.desiredVersion });
            await tx.outbox.create({
              data: {
                kind: "entitlement",
                aggregateId: s.id,
                version: s.desiredVersion,
              },
            });
          }
          await tx.provisionOperation.update({
            where: { id },
            data: {
              checkpoint: {
                ...state,
                published: true,
                targets,
              } as Prisma.InputJsonValue,
            },
          });
          await tx.provisionEvent.create({
            data: {
              operationId: id,
              phase: "publishing",
              message: `节点已加入全局池，正在同步 ${targets.length} 份订阅；原订阅链接保持不变`,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: op.actorId,
              action: "machine.publish",
              targetId: id,
              detail: { nodeId: node.id, subscriptions: targets.length },
            },
          });
        });
      } else {
        const subs = await db.subscription.findMany({
          where: { id: { in: (state.targets ?? []).map((s) => s.id) } },
          select: { id: true, appliedVersion: true },
        });
        if (
          (state.targets ?? []).every(
            (t) =>
              !subs.some((s) => s.id === t.id && s.appliedVersion < t.version),
          )
        )
          await checkpoint("ready", state);
      }
    } else throw new Error("INVALID_PROVISION_PHASE");
  } catch (error) {
    const e = provisionError(error);
    await db.$transaction(async (tx) => {
      const changed = await tx.provisionOperation.updateMany({
        where: { id, leaseOwner: owner },
        data: { status: "failed", errorCode: e.code, finishedAt: new Date() },
      });
      if (changed.count) {
        const op = await tx.provisionOperation.findUniqueOrThrow({
          where: { id },
        });
        await tx.provisionEvent.create({
          data: { operationId: id, phase: op.phase, message: e.message },
        });
      }
    });
  } finally {
    clearInterval(heartbeat);
    await db.provisionOperation.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
