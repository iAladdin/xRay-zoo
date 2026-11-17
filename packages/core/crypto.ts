import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { required } from "./config.js";
const derive = promisify(scrypt);
export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, encoded] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !encoded) return false;
  const actual = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(encoded, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function key() {
  const value = Buffer.from(required("ENCRYPTION_KEY"), "hex");
  if (value.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
  return value;
}
export function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal(value: string) {
  const [iv, tag, body] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  if (!iv || !tag || !body) throw new Error("Invalid ciphertext");
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8");
}
