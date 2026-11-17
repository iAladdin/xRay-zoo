import { HttpException } from "@nestjs/common";
import type { Subscription } from "@prisma/client";
import type { Response } from "express";
import { db } from "./db.js";
import { settings } from "./config.js";
import { hashToken, randomToken, seal, unseal } from "./crypto.js";
import { nodePoolWhere } from "./node-pool.js";
import {
  renderSubscription,
  type SubscriptionNode,
} from "../subscription/index.js";

export function canDownload(sub: Subscription | null): sub is Subscription {
  return (
    !!sub &&
    sub.status === "active" &&
    !sub.revokedAt &&
    !!sub.validUntil &&
    sub.validUntil > new Date() &&
    sub.usedBytes < sub.quotaBytes &&
    sub.appliedVersion === sub.desiredVersion &&
    !!sub.accessUuidCipher
  );
}
export async function sendConfig(sub: Subscription | null, res: Response) {
  if (!canDownload(sub))
    throw new HttpException("订阅尚未就绪、已撤销或已到期", 403);
  const nodes = await db.node.findMany({
    where: {
      ready: true,
      addressChanging: false,
      enabled: true,
      ...nodePoolWhere(sub),
      checkedAt: { gt: new Date(Date.now() - 120_000) },
    },
  });
  if (!nodes.length)
    throw new HttpException("节点状态正在确认，请稍后重试", 503);
  const yaml = renderSubscription(
    nodes as SubscriptionNode[],
    unseal(sub.accessUuidCipher!),
  );
  res
    .set({
      "Cache-Control": "private, no-store",
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="xray-zoo.yaml"',
      // The engine provides a combined counter, not separate upload/download meters.
      // Clients calculate used traffic as upload + download; do not count it twice.
      "subscription-userinfo": `upload=0; download=${sub.usedBytes}; total=${sub.quotaBytes}; expire=${Math.floor(sub.validUntil!.getTime() / 1000)}`,
      "profile-update-interval": "1",
      "profile-web-page-url": new URL("/account", settings.webOrigin).href,
    })
    .send(yaml);
}
export async function changeOwnAccess(
  userId: string,
  action: "revoke" | "regenerate",
  expectedVersion: number,
) {
  return db.$transaction(async (tx) => {
    // The user identity comes only from the authenticated session, never the request body.
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "userId" = ${userId} FOR UPDATE`;
    const sub = await tx.subscription.findUnique({ where: { userId } });
    if (!sub) throw new HttpException("尚未购买订阅", 404);
    if (action === "revoke" && sub.revokedAt && sub.status !== "regenerating")
      return { accepted: true, alreadyRevoked: true };
    if (sub.desiredVersion !== expectedVersion)
      throw new HttpException("订阅状态已更新，请刷新后重试", 409);
    if (sub.syncLeaseUntil && sub.syncLeaseUntil > new Date())
      throw new HttpException("订阅正在同步，请稍后重试", 409);
    if (action === "regenerate") {
      if (sub.status === "suspended")
        throw new HttpException("订阅已被管理员暂停，请联系管理员", 403);
      if (!sub.revokedAt || sub.status !== "revoked")
        throw new HttpException("请先撤销当前访问，再生成新的配置", 409);
      if (sub.appliedVersion !== sub.desiredVersion)
        throw new HttpException("撤销操作仍在同步，请稍后重试", 409);
      const period = await tx.servicePeriod.findFirst({
        where: {
          subscriptionId: sub.id,
          status: "paid",
          startAt: { lte: new Date() },
          endAt: { gt: new Date() },
        },
        orderBy: { startAt: "desc" },
      });
      if (!period)
        throw new HttpException("已付服务期已结束，请先购买套餐", 409);
      if (
        sub.currentPeriodId === period.id &&
        sub.usedBytes >= period.quotaBytes
      )
        throw new HttpException("当前服务期流量已用完", 409);
    }
    const token = action === "regenerate" ? randomToken() : null;
    const next = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status:
          action === "revoke"
            ? sub.status === "suspended"
              ? "suspended"
              : "revoked"
            : "regenerating",
        revokedAt: action === "revoke" ? new Date() : sub.revokedAt,
        tokenHash: token ? hashToken(token) : null,
        tokenCipher: token ? seal(token) : null,
        desiredVersion: { increment: 1 },
        lastError: null,
      },
    });
    await tx.outbox.create({
      data: {
        kind: "entitlement",
        aggregateId: sub.id,
        version: next.desiredVersion,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "subscription.customer-" + action,
        targetId: sub.id,
        detail: { version: next.desiredVersion },
      },
    });
    return { accepted: true, alreadyRevoked: false };
  });
}
