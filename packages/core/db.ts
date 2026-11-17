import "./config.js";
import { PrismaClient } from "@prisma/client";
// Expected serializable retries must not dump query inputs into application logs.
export const db = new PrismaClient();
