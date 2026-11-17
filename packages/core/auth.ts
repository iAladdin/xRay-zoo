import { HttpException } from "@nestjs/common";
import type { Request } from "express";
import { db } from "./db.js";
import { hashToken } from "./crypto.js";
export async function currentUser(req: Request) {
  const token = req.cookies?.xz_session;
  if (typeof token !== "string") throw new HttpException("请先登录", 401);
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date())
    throw new HttpException("登录已过期", 401);
  return session.user;
}
