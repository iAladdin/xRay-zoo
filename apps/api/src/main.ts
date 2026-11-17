import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Module,
  HttpException,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import type { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../../../packages/core/db.js";
import { assertLocalRuntime, settings } from "../../../packages/core/config.js";
import {
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
  unseal,
} from "../../../packages/core/crypto.js";
import { receiveInvoiceEvent } from "../../../packages/core/billing.js";
import {
  createStripeCheckout,
  acceptStripeEvent,
  stripeClient,
} from "../../../packages/core/stripe.js";
import {
  renderSubscription,
  type SubscriptionNode,
} from "../../../packages/subscription/index.js";

assertLocalRuntime();
const credentials = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(12).max(128),
});
const publicUser = (u: { id: string; email: string; role: string }) => ({
  id: u.id,
  email: u.email,
  role: u.role,
});
async function currentUser(req: Request) {
  const token = req.cookies?.xz_session;
  if (!token) throw new HttpException("请先登录", 401);
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date())
    throw new HttpException("登录已过期", 401);
  return session.user;
}
async function issueSession(userId: string, res: Response) {
  const token = randomToken();
  await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 86400_000),
    },
  });
  res.cookie("xz_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 86400_000,
  });
}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException)
      return res.status(error.getStatus()).json({ error: error.message });
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: "输入格式不正确" });
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return res.status(409).json({ error: "记录已存在" });
    // Never return tokens, raw provider responses or database connection details.
    console.error(
      "request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    res.status(503).json({ error: "操作暂未完成，请稍后重试" });
  }
}
@Controller()
class Api {
  @Get("health") health() {
    return {
      ok: true,
      environment: "local",
      paymentProvider: settings.paymentProvider,
    };
  }
  @Post("auth/register") async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = credentials.parse(body);
    const user = await db.user.create({
      data: {
        email: input.email,
        passwordHash: await hashPassword(input.password),
      },
    });
    await issueSession(user.id, res);
    return publicUser(user);
  }
  @Post("auth/login") async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = credentials.parse(body);
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash)))
      throw new HttpException("邮箱或密码错误", 401);
    await issueSession(user.id, res);
    return publicUser(user);
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.cookies?.xz_session)
      await db.session.deleteMany({
        where: { tokenHash: hashToken(req.cookies.xz_session) },
      });
    res.clearCookie("xz_session");
    return { ok: true };
  }
  @Get("me") async me(@Req() req: Request) {
    const user = await currentUser(req);
    const subscription = await db.subscription.findUnique({
      where: { userId: user.id },
    });
    const active =
      subscription?.status === "active" &&
      subscription.validUntil &&
      subscription.validUntil > new Date() &&
      subscription.appliedVersion === subscription.desiredVersion;
    return {
      user: publicUser(user),
      subscription: subscription
        ? {
            status: subscription.status,
            validUntil: subscription.validUntil,
            quotaBytes: String(subscription.quotaBytes),
            usedBytes: String(subscription.usedBytes),
            regions: subscription.regions,
            lastUsageAt: subscription.lastUsageAt,
            pending:
              subscription.appliedVersion !== subscription.desiredVersion,
            url:
              active && subscription.tokenCipher
                ? settings.subscriptionOrigin +
                  "/s/" +
                  unseal(subscription.tokenCipher)
                : null,
          }
        : null,
    };
  }
  @Get("plans") async plans() {
    const plans = await db.plan.findMany({ where: { active: true } });
    return {
      provider: settings.paymentProvider,
      plans: plans.map((p) => ({ ...p, quotaBytes: String(p.quotaBytes) })),
    };
  }
  @Post("checkout") async checkout(@Req() req: Request, @Body() body: unknown) {
    const user = await currentUser(req);
    const input = z
      .object({ planId: z.string(), idempotencyKey: z.string().uuid() })
      .parse(body);
    const order = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
      const sub = await tx.subscription.findUnique({
        where: { userId: user.id },
      });
      if (sub?.validUntil && sub.validUntil > new Date())
        throw new HttpException(
          "已有有效套餐，请在当前服务期结束后再购买",
          409,
        );
      const existing = await tx.order.findFirst({
        where: {
          userId: user.id,
          provider: settings.paymentProvider,
          status: "pending",
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        if (existing.planId !== input.planId)
          throw new HttpException("请先处理已有订单", 409);
        return existing;
      }
      const paidPending = await tx.order.findFirst({
        where: {
          userId: user.id,
          status: "paid",
          periods: { some: { endAt: { gt: new Date() } } },
        },
      });
      if (paidPending) throw new HttpException("付款已收到，正在开通", 409);
      const plan = await tx.plan.findFirst({
        where: { id: input.planId, active: true },
      });
      if (!plan) throw new HttpException("套餐不存在", 404);
      return tx.order.create({
        data: {
          userId: user.id,
          planId: plan.id,
          provider: settings.paymentProvider,
          idempotencyKey: input.idempotencyKey,
          amountMinor: plan.amountMinor,
          currency: plan.currency,
          quotaBytes: plan.quotaBytes,
          regions: plan.regions,
        },
      });
    });
    if (settings.paymentProvider === "dev")
      return {
        orderId: order.id,
        provider: "dev",
        url: settings.webOrigin + "/?devCheckout=" + order.id,
      };
    if (settings.paymentProvider !== "stripe")
      throw new HttpException("支付方式未配置", 503);
    const updated = order.checkoutUrl
      ? order
      : await createStripeCheckout(order.id);
    return { orderId: order.id, provider: "stripe", url: updated.checkoutUrl };
  }
  @Post("dev/pay/:id") async devPay(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    if (!settings.local || settings.paymentProvider !== "dev")
      throw new HttpException("Not found", 404);
    const user = await currentUser(req);
    const order = await db.order.findFirst({
      where: { id, userId: user.id, provider: "dev" },
    });
    if (!order) throw new HttpException("订单不存在", 404);
    // Deterministic period makes repeated clicks/retries the same invoice.
    const start = order.createdAt;
    await receiveInvoiceEvent("dev", "dev-" + order.id, {
      provider: "dev",
      invoiceId: "dev-" + order.id,
      orderId: order.id,
      amountMinor: order.amountMinor,
      currency: order.currency,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 30 * 86400_000).toISOString(),
    });
    return { accepted: true, simulated: true };
  }
  @Post("webhooks/stripe") async webhook(
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    if (settings.paymentProvider !== "stripe")
      throw new HttpException("Not found", 404);
    const signature = req.headers["stripe-signature"];
    if (!signature || Array.isArray(signature) || !req.rawBody)
      throw new HttpException("签名缺失", 400);
    try {
      return await acceptStripeEvent(req.rawBody, signature);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "STRIPE_SIGNATURE_INVALID"
      )
        throw new HttpException("签名无效", 400);
      throw error;
    }
  }
  @Post("billing/cancel-renewal") async cancelRenewal(@Req() req: Request) {
    const user = await currentUser(req);
    const orders = await db.order.findMany({
      where: {
        userId: user.id,
        provider: "stripe",
        providerSubscriptionId: { not: null },
      },
    });
    for (const order of orders)
      await stripeClient().subscriptions.update(order.providerSubscriptionId!, {
        cancel_at_period_end: true,
      });
    return { ok: true, message: "当前已付服务期保留，到期不再续费" };
  }
  @Get("s/:token") async subscription(
    @Param("token") token: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HttpException("Not found", 404);
    const sub = await db.subscription.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (
      !sub ||
      sub.status !== "active" ||
      !sub.validUntil ||
      sub.validUntil <= new Date() ||
      sub.usedBytes >= sub.quotaBytes ||
      sub.appliedVersion !== sub.desiredVersion ||
      !sub.accessUuidCipher
    )
      throw new HttpException("订阅无效或已到期", 403);
    const nodes = await db.node.findMany({
      where: {
        ready: true,
        country: { in: sub.regions },
        checkedAt: { gt: new Date(Date.now() - 120_000) },
      },
    });
    if (!nodes.length) throw new HttpException("节点状态正在确认", 503);
    const yaml = renderSubscription(
      nodes as SubscriptionNode[],
      unseal(sub.accessUuidCipher),
    );
    res
      .set({
        "Cache-Control": "private, no-store",
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": 'attachment; filename="xray-zoo.yaml"',
        "subscription-userinfo": `upload=0; download=${sub.usedBytes}; total=${sub.quotaBytes}; expire=${Math.floor(sub.validUntil.getTime() / 1000)}`,
        "profile-update-interval": "1",
      })
      .send(yaml);
  }
  @Get("admin/nodes") async adminNodes(@Req() req: Request) {
    if ((await currentUser(req)).role !== "ADMIN")
      throw new HttpException("无权访问", 403);
    return db.node.findMany({
      select: {
        id: true,
        name: true,
        country: true,
        region: true,
        ready: true,
        checkedAt: true,
      },
    });
  }
}
@Module({ controllers: [Api] })
class AppModule {}
const app = await NestFactory.create(AppModule, {
  rawBody: true,
  logger: ["error", "warn"],
});
app.use(cookieParser());
app.enableCors({ origin: settings.webOrigin, credentials: true });
// Exact browser Origin and loopback binding confine dev payment/auth to this machine.
const attempts = new Map<string, { count: number; until: number }>();
app.use((req: Request, res: Response, next: () => void) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.path !== "/webhooks/stripe" &&
    req.headers.origin !== settings.webOrigin
  )
    return res.status(403).json({ error: "Origin rejected" });
  if (req.path.startsWith("/auth/")) {
    const key = req.ip ?? "local";
    const now = Date.now();
    const previous = attempts.get(key);
    const rate =
      previous && previous.until > now
        ? previous
        : { count: 0, until: now + 60_000 };
    attempts.set(key, rate);
    if (++rate.count > 20) return res.status(429).json({ error: "请稍后重试" });
  }
  next();
});
app.useGlobalFilters(new Errors());
await app.listen(3101, "127.0.0.1");
console.log(
  "xRay-zoo API ready on http://localhost:3101 (local test environment)",
);
