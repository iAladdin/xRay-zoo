import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Body,
  UseGuards,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { db } from "../../../packages/core/db.js";
import { currentUser } from "../../../packages/core/auth.js";
import { settings } from "../../../packages/core/config.js";
import { unseal } from "../../../packages/core/crypto.js";
import { stripeClient } from "../../../packages/core/stripe.js";
import {
  canDownload,
  sendConfig,
  changeOwnAccess,
} from "../../../packages/core/subscription-access.js";
import { healthState } from "../../../packages/core/node-health.js";
type AccountRequest = Request & {
  accountUser: { id: string; email: string; role: string };
};
@Injectable()
class AccountGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AccountRequest>();
    const u = await currentUser(req);
    req.accountUser = { id: u.id, email: u.email, role: u.role };
    return true;
  }
}
const actionInput = z
  .object({ expectedVersion: z.number().int().min(0) })
  .strict();
@Controller("account")
@UseGuards(AccountGuard)
export class AccountApi {
  @Get() async account(@Req() req: AccountRequest) {
    const user = req.accountUser;
    const [sub, orders] = await Promise.all([
      db.subscription.findUnique({ where: { userId: user.id } }),
      db.order.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          planId: true,
          createdAt: true,
          status: true,
          amountMinor: true,
          currency: true,
          provider: true,
          quotaBytes: true,
          regions: true,
          plan: { select: { name: true } },
          periods: {
            orderBy: { startAt: "desc" },
            select: { startAt: true, endAt: true },
          },
        },
      }),
    ]);
    const period = sub
      ? await db.servicePeriod.findFirst({
          where: {
            subscriptionId: sub.id,
            status: "paid",
            startAt: { lte: new Date() },
            endAt: { gt: new Date() },
          },
          orderBy: { startAt: "desc" },
          include: { order: { include: { plan: true } } },
        })
      : null;
    const nodes = sub
      ? await db.node.findMany({ where: { country: { in: sub.regions } } })
      : [];
    return {
      user,
      paymentProvider: settings.paymentProvider,
      asOf: new Date(),
      subscription: sub
        ? {
            status: sub.status,
            planName: period?.order.plan.name ?? "当前订阅",
            validUntil: sub.validUntil,
            quotaBytes: String(sub.quotaBytes),
            usedBytes: String(sub.usedBytes),
            regions: sub.regions,
            lastUsageAt: sub.lastUsageAt,
            revokedAt: sub.revokedAt,
            pending: sub.desiredVersion !== sub.appliedVersion,
            version: sub.desiredVersion,
            syncFailed: !!sub.lastError,
            canRegenerate:
              !!sub.revokedAt &&
              sub.status === "revoked" &&
              sub.desiredVersion === sub.appliedVersion &&
              !!period &&
              (period.id !== sub.currentPeriodId ||
                sub.usedBytes < period.quotaBytes),
            url:
              canDownload(sub) && sub.tokenCipher
                ? settings.subscriptionOrigin + "/s/" + unseal(sub.tokenCipher)
                : null,
          }
        : null,
      nodes: nodes
        .sort(
          (a, b) =>
            (sub?.regions.indexOf(a.country) ?? 0) -
            (sub?.regions.indexOf(b.country) ?? 0),
        )
        .map((n) => ({
          name: n.name,
          country: n.country,
          region: n.region,
          ready: healthState(n) === "READY",
          checkedAt: n.checkedAt,
        })),
      orders: orders.map((o) => ({ ...o, quotaBytes: String(o.quotaBytes) })),
    };
  }
  @Get("config") async config(
    @Req() req: AccountRequest,
    @Res() res: Response,
  ) {
    return sendConfig(
      await db.subscription.findUnique({
        where: { userId: req.accountUser.id },
      }),
      res,
    );
  }
  @Post("subscription/revoke") revoke(
    @Req() req: AccountRequest,
    @Body() body: unknown,
  ) {
    const input = actionInput.parse(body);
    return changeOwnAccess(req.accountUser.id, "revoke", input.expectedVersion);
  }
  @Post("subscription/regenerate") regenerate(
    @Req() req: AccountRequest,
    @Body() body: unknown,
  ) {
    const input = actionInput.parse(body);
    return changeOwnAccess(
      req.accountUser.id,
      "regenerate",
      input.expectedVersion,
    );
  }
  @Get("billing") async billing(@Req() req: AccountRequest) {
    const orders = await db.order.findMany({
      where: {
        userId: req.accountUser.id,
        provider: "stripe",
        providerSubscriptionId: { not: null },
      },
      distinct: ["providerSubscriptionId"],
      select: { providerSubscriptionId: true },
    });
    const result = await Promise.all(
      orders.map(async (o) => {
        const s = await stripeClient().subscriptions.retrieve(
          o.providerSubscriptionId!,
        );
        return {
          status: s.status,
          cancelAtPeriodEnd: s.cancel_at_period_end,
          endsAt: s.cancel_at ? new Date(s.cancel_at * 1000) : null,
        };
      }),
    );
    return { subscriptions: result, checkedAt: new Date() };
  }
}
