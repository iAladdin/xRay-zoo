import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  Injectable,
  HttpException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../../../packages/core/db.js";
import { currentUser } from "../../../packages/core/auth.js";
import { azure, provisionError } from "../../../packages/core/azure.js";
import {
  lifecycleSelect,
  lifecycleView,
  retryLifecycle,
} from "../../../packages/core/node-lifecycle.js";
import {
  createMaintenance,
  maintenanceView,
} from "../../../packages/core/node-maintenance.js";
import {
  previewRotation,
  createRotation,
  retryRotation,
  rotationSelect,
  rotationView,
} from "../../../packages/core/ip-rotation.js";
import {
  previewMachine,
  createMachine,
  retryMachine,
  machineSelect,
  machineView,
} from "../../../packages/core/provisioning.js";
import {
  hashToken,
  randomToken,
  seal,
  unseal,
} from "../../../packages/core/crypto.js";
import { settings } from "../../../packages/core/config.js";
import {
  healthState,
  refreshNodeHealth,
  nodeAction,
} from "../../../packages/core/node-health.js";

@Injectable()
class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context
      .switchToHttp()
      .getRequest<Request & { adminId: string }>();
    const user = await currentUser(req);
    if (user.role !== "ADMIN")
      throw new HttpException("无权访问管理员后台", 403);
    req.adminId = user.id;
    return true;
  }
}
type AdminRequest = Request & { adminId: string };
const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  q: z.string().max(120).default(""),
});
const regions = z
  .array(z.string().regex(/^[A-Z]{2}$/))
  .min(1)
  .max(250)
  .refine((v) => new Set(v).size === v.length);
const planInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/),
  name: z.string().trim().min(2).max(80),
  amountMinor: z.number().int().min(50).max(10000000),
  currency: z.enum(["USD"]),
  quotaGB: z.number().int().min(1).max(100000),
  regions,
  active: z.boolean(),
  globalPool: z.boolean().optional(),
});
const subSelect = {
  id: true,
  userId: true,
  status: true,
  desiredVersion: true,
  appliedVersion: true,
  validUntil: true,
  quotaBytes: true,
  usedBytes: true,
  regions: true,
  lastUsageAt: true,
  lastError: true,
  createdAt: true,
  user: { select: { email: true } },
} satisfies Prisma.SubscriptionSelect;
const serial = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    ),
  );
const paging = (page: number, total: number, items: unknown) => ({
  page,
  pageSize: 20,
  total,
  items: serial(items),
});
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminApi {
  @Get("azure/locations") async azureLocations() {
    try {
      return await azure("catalog");
    } catch (e) {
      throw new HttpException(provisionError(e).message, 503);
    }
  }
  @Get("azure/skus") async azureSkus(@Query() query: unknown) {
    const { region } = z
      .object({ region: z.string().regex(/^[a-z0-9]{2,40}$/) })
      .strict()
      .parse(query);
    try {
      return await azure("skus", { region });
    } catch (e) {
      throw new HttpException(provisionError(e).message, 503);
    }
  }
  @Post("machines/preview") async preview(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    const { region, size } = z
      .object({
        region: z.string().regex(/^[a-z0-9]{2,40}$/),
        size: z.string().regex(/^Standard_[A-Za-z0-9_-]{1,70}$/),
      })
      .strict()
      .parse(body);
    try {
      return await previewMachine(req.adminId, region, size);
    } catch (e) {
      throw new HttpException(provisionError(e).message, 409);
    }
  }
  @Post("machines") async createMachine(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    const v = z
      .object({ planId: z.string().uuid(), idempotencyKey: z.string().uuid() })
      .strict()
      .parse(body);
    return createMachine(req.adminId, v.planId, v.idempotencyKey);
  }
  @Get("machines") async machines() {
    const [pending, recent] = await Promise.all([
      db.provisionOperation.findMany({
        where: { status: { not: "ready" } },
        orderBy: { createdAt: "desc" },
        select: machineSelect,
      }),
      db.provisionOperation.findMany({
        where: { status: "ready" },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: machineSelect,
      }),
    ]);
    return [...pending, ...recent]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(machineView);
  }
  @Get("machines/:id") async machine(@Param("id") id: string) {
    const row = await db.provisionOperation.findUnique({
      where: { id: z.string().uuid().parse(id) },
      select: machineSelect,
    });
    if (!row) throw new HttpException("部署任务不存在", 404);
    return machineView(row);
  }
  @Post("machines/:id/retry") retryMachine(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    return retryMachine(req.adminId, z.string().uuid().parse(id));
  }
  @Get("overview") async overview() {
    const [
      nodes,
      users,
      subscriptions,
      orders,
      pendingEvents,
      usage,
      paidPeriods,
      audit,
    ] = await Promise.all([
      db.node.findMany(),
      db.user.count({ where: { role: "CUSTOMER" } }),
      db.subscription.groupBy({ by: ["status"], _count: true }),
      db.order.groupBy({ by: ["status"], _count: true }),
      db.providerEvent.count({ where: { status: "pending" } }),
      db.subscription.aggregate({
        _sum: { usedBytes: true, quotaBytes: true },
        _max: { lastUsageAt: true },
      }),
      db.servicePeriod.findMany({
        where: { status: "paid" },
        select: {
          provider: true,
          order: { select: { currency: true, amountMinor: true } },
        },
      }),
      db.auditLog.findMany({
        take: 8,
        orderBy: { createdAt: "desc" },
        select: { id: true, action: true, targetId: true, createdAt: true },
      }),
    ]);
    const receipts: Record<string, number> = {};
    for (const p of paidPeriods) {
      const key = p.provider + ":" + p.order.currency;
      receipts[key] = (receipts[key] ?? 0) + p.order.amountMinor;
    }
    return serial({
      asOf: new Date(),
      paymentMode:
        settings.paymentProvider === "stripe" ? "Stripe Sandbox" : "模拟支付",
      nodes: {
        total: nodes.length,
        ready: nodes.filter((n) => healthState(n) === "READY").length,
      },
      users,
      subscriptions,
      orders,
      pendingEvents,
      usage: {
        usedBytes: usage._sum.usedBytes ?? 0n,
        quotaBytes: usage._sum.quotaBytes ?? 0n,
        lastUsageAt: usage._max.lastUsageAt,
      },
      receipts,
      audit,
    });
  }
  @Get("nodes") async nodes() {
    const nodes = await db.node.findMany({
      orderBy: { name: "asc" },
      include: {
        lifecycles: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: lifecycleSelect,
        },
        ipRotations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: rotationSelect,
        },
      },
    });
    const order = ["JP", "SG", "US", "HK", "TW"];
    nodes.sort((a, b) => order.indexOf(a.country) - order.indexOf(b.country));
    return serial(
      nodes.map((n) => ({
        id: n.id,
        name: n.name,
        country: n.country,
        region: n.region,
        address: n.address,
        port: n.port,
        enabled: n.enabled,
        ready: healthState(n) === "READY",
        state: healthState(n),
        engineConnected: n.engineConnected,
        engineDisabled: n.engineDisabled,
        transportConnected: n.transportConnected,
        checkedAt: n.checkedAt,
        lastHealthyAt: n.lastHealthyAt,
        usageBytes: n.usageBytes,
        usageUpdatedAt: n.usageUpdatedAt,
        xrayVersion: n.xrayVersion,
        busy:
          !!n.activeLifecycleId ||
          !!n.activeIpRotationId ||
          (!!n.controlLeaseUntil && n.controlLeaseUntil > new Date()),
        resourceState: n.resourceState,
        activeLifecycleId: n.activeLifecycleId,
        lifecycle: n.lifecycles[0] ? lifecycleView(n.lifecycles[0]) : null,
        diskType: n.diskType,
        diskSizeGiB: n.diskSizeGiB,
        activeIpRotationId: n.activeIpRotationId,
        ipRotation: n.ipRotations[0] ? rotationView(n.ipRotations[0]) : null,
        publishedAt: n.publishedAt,
        vmSize: n.vmSize,
        globalPool: n.globalPool,
      })),
    );
  }
  @Post("nodes/refresh") async refresh() {
    await refreshNodeHealth(true);
    return { ok: true };
  }
  @Post("node-maintenance") maintenance(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    return createMaintenance(req.adminId, body);
  }
  @Get("node-lifecycles/:id") async lifecycle(@Param("id") id: string) {
    const op = await db.nodeLifecycle.findUnique({
      where: { id: z.string().uuid().parse(id) },
      select: lifecycleSelect,
    });
    if (!op) throw new HttpException("任务不存在", 404);
    return lifecycleView(op);
  }
  @Post("node-lifecycles/:id/retry") retryLifecycle(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    return retryLifecycle(req.adminId, z.string().uuid().parse(id));
  }
  @Get("node-maintenance") async maintenanceList() {
    const [running, recent] = await Promise.all([
      db.nodeMaintenanceBatch.findMany({
        where: { status: "running" },
        orderBy: { createdAt: "desc" },
      }),
      db.nodeMaintenanceBatch.findMany({
        where: { status: "complete" },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return [...running, ...recent].map(maintenanceView);
  }
  @Get("node-maintenance/:id") async maintenanceDetail(
    @Param("id") id: string,
  ) {
    const batch = await db.nodeMaintenanceBatch.findUnique({
      where: { id: z.string().uuid().parse(id) },
    });
    if (!batch) throw new HttpException("批量维护任务不存在", 404);
    return maintenanceView(batch);
  }
  @Post("nodes/:id/ip-rotation/preview") async rotationPreview(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    try {
      return await previewRotation(req.adminId, id);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new HttpException(provisionError(e).message, 409);
    }
  }
  @Post("nodes/:id/ip-rotation") rotateIp(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({ planId: z.string().uuid(), idempotencyKey: z.string().uuid() })
      .strict()
      .parse(body);
    return createRotation(req.adminId, id, v.planId, v.idempotencyKey);
  }
  @Get("ip-rotations/:id") async rotation(@Param("id") id: string) {
    const op = await db.ipRotation.findUnique({
      where: { id: z.string().uuid().parse(id) },
      select: rotationSelect,
    });
    if (!op) throw new HttpException("轮换任务不存在", 404);
    return rotationView(op);
  }
  @Post("ip-rotations/:id/retry") retryRotation(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    return retryRotation(req.adminId, z.string().uuid().parse(id));
  }
  @Post("ip-rotations/:id/rollback") rollbackRotation(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    return retryRotation(req.adminId, z.string().uuid().parse(id), true);
  }
  @Post("nodes/:id/action") async node(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { action } = z
      .object({
        action: z.enum([
          "enable",
          "disable",
          "restart",
          "reconnect",
          "release",
          "rebuild",
        ]),
      })
      .parse(body);
    if (!(await db.node.findUnique({ where: { id } })))
      throw new HttpException("节点不存在", 404);
    if (action === "release" || action === "rebuild")
      return createMaintenance(req.adminId, {
        action,
        nodeIds: [id],
        idempotencyKey: crypto.randomUUID(),
      });
    try {
      await nodeAction(id, action, req.adminId);
    } catch (e) {
      throw new HttpException(
        e instanceof Error && e.message === "NODE_BUSY"
          ? "节点有操作正在执行，请稍后刷新"
          : "节点操作未完成，已记录结果；请检查控制连接",
        409,
      );
    }
    return { ok: true, message: "操作已提交，以下次检测结果为准" };
  }
  @Get("users") async users(@Query() query: unknown) {
    const { page, q } = pageInput.parse(query);
    const where = { email: { contains: q, mode: "insensitive" as const } };
    const [total, items] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        skip: (page - 1) * 20,
        take: 20,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          _count: { select: { orders: true } },
          subscription: {
            select: {
              id: true,
              status: true,
              validUntil: true,
              usedBytes: true,
              quotaBytes: true,
            },
          },
        },
      }),
    ]);
    return paging(page, total, items);
  }
  @Get("plans") async plans() {
    return serial(
      await db.plan.findMany({
        orderBy: [{ active: "desc" }, { quotaBytes: "asc" }, { id: "asc" }],
        include: { _count: { select: { orders: true } } },
      }),
    );
  }
  @Post("plans") async savePlan(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    const { quotaGB, ...input } = planInput.parse(body);
    const quotaBytes = BigInt(quotaGB) * 1_000_000_000n;
    await db.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id: input.id } });
      await tx.plan.upsert({
        where: { id: input.id },
        create: { ...input, quotaBytes },
        update: { ...input, quotaBytes },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.adminId,
          action: before ? "plan.update" : "plan.create",
          targetId: input.id,
          detail: {
            name: input.name,
            active: input.active,
            amountMinor: input.amountMinor,
            quotaGB,
            regions: input.regions,
            globalPool: input.globalPool,
          },
        },
      });
    });
    return { ok: true };
  }
  @Get("orders") async orders(@Query() query: unknown) {
    const { page, q } = pageInput.parse(query);
    const where: Prisma.OrderWhereInput = {
      OR: [
        { id: { contains: q } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ],
    };
    const [total, items] = await Promise.all([
      db.order.count({ where }),
      db.order.findMany({
        where,
        skip: (page - 1) * 20,
        take: 20,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          provider: true,
          amountMinor: true,
          currency: true,
          quotaBytes: true,
          regions: true,
          createdAt: true,
          user: { select: { email: true } },
          plan: { select: { name: true } },
          periods: { select: { startAt: true, endAt: true, status: true } },
        },
      }),
    ]);
    return paging(page, total, items);
  }
  @Get("subscriptions") async subscriptions(@Query() query: unknown) {
    const { page, q } = pageInput.parse(query);
    const where: Prisma.SubscriptionWhereInput = {
      OR: [
        { id: { contains: q } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ],
    };
    const [total, items] = await Promise.all([
      db.subscription.count({ where }),
      db.subscription.findMany({
        where,
        skip: (page - 1) * 20,
        take: 20,
        orderBy: { createdAt: "desc" },
        select: subSelect,
      }),
    ]);
    return paging(page, total, items);
  }
  @Post("subscriptions/:id/link") async subscriptionLink(
    @Req() req: AdminRequest,
    @Param("id") id: string,
  ) {
    const sub = await db.subscription.findUnique({ where: { id } });
    if (!sub) throw new HttpException("订阅不存在", 404);
    if (
      sub.status !== "active" ||
      !!sub.revokedAt ||
      !sub.validUntil ||
      sub.validUntil <= new Date() ||
      sub.usedBytes >= sub.quotaBytes ||
      sub.appliedVersion !== sub.desiredVersion ||
      !sub.tokenCipher
    )
      throw new HttpException("订阅尚未就绪或已失效，不能获取有效链接", 409);
    await db.auditLog.create({
      data: {
        actorId: req.adminId,
        action: "subscription.copy-link",
        targetId: id,
        detail: {},
      },
    });
    return {
      url: settings.subscriptionOrigin + "/s/" + unseal(sub.tokenCipher),
    };
  }
  @Post("subscriptions/:id/action") async subscription(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        action: z.enum(["suspend", "resume", "retry", "rotate-link"]),
        expectedVersion: z.number().int().min(0),
        reason: z.string().trim().min(2).max(240),
      })
      .parse(body);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${id} FOR UPDATE`;
      const sub = await tx.subscription.findUnique({ where: { id } });
      if (!sub) throw new HttpException("订阅不存在", 404);
      if (sub.desiredVersion !== input.expectedVersion)
        throw new HttpException("订阅已变更，请刷新后重试", 409);
      if (sub.syncLeaseUntil && sub.syncLeaseUntil > new Date())
        throw new HttpException("订阅正在同步，请稍后重试", 409);
      if (input.action === "resume") {
        const paid = await tx.servicePeriod.findFirst({
          where: {
            subscriptionId: id,
            status: "paid",
            startAt: { lte: new Date() },
            endAt: { gt: new Date() },
          },
        });
        if (!paid)
          throw new HttpException("没有有效的已付服务期，不能恢复", 409);
        if (sub.status !== "suspended")
          throw new HttpException("只有暂停的订阅可以恢复", 409);
      }
      const token = input.action === "rotate-link" ? randomToken() : null;
      const next = await tx.subscription.update({
        where: { id },
        data: {
          desiredVersion: { increment: 1 },
          lastError: null,
          ...(input.action === "suspend"
            ? { status: "suspended" }
            : input.action === "resume"
              ? { status: "pending" }
              : {}),
          ...(token
            ? { tokenHash: hashToken(token), tokenCipher: seal(token) }
            : {}),
        },
      });
      await tx.outbox.create({
        data: {
          kind: "entitlement",
          aggregateId: id,
          version: next.desiredVersion,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.adminId,
          action: "subscription." + input.action,
          targetId: id,
          detail: {
            reason: input.reason,
            fromStatus: sub.status,
            version: next.desiredVersion,
          },
        },
      });
    });
    return {
      ok: true,
      message:
        input.action === "rotate-link"
          ? "旧订阅链接已失效，用户可在账户页获取新链接。已下载配置仍有效。"
          : "操作已排队，等待节点同步",
    };
  }
  @Get("audit") async audit(@Query() query: unknown) {
    const { page } = pageInput.parse(query);
    const [total, items] = await Promise.all([
      db.auditLog.count(),
      db.auditLog.findMany({
        skip: (page - 1) * 20,
        take: 20,
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const ids = [...new Set(items.map((i) => i.actorId))];
    const users = await db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });
    return paging(
      page,
      total,
      items.map((i) => ({
        ...i,
        actor: users.find((u) => u.id === i.actorId)?.email ?? i.actorId,
      })),
    );
  }
}
