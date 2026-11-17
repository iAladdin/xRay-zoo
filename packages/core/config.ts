import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const root = fileURLToPath(new URL("../../", import.meta.url));
config({ path: resolve(root, ".local/app.env"), quiet: true });
config({
  path: resolve(root, ".local/stripe.env"),
  quiet: true,
  override: true,
});
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export const settings = {
  local: process.env.APP_ENV === "local",
  webOrigin: process.env.APP_ORIGIN ?? "http://localhost:3100",
  apiOrigin: process.env.API_ORIGIN ?? "http://localhost:3101",
  subscriptionOrigin:
    process.env.SUBSCRIPTION_ORIGIN ?? "http://localhost:3101",
  paymentProvider: process.env.PAYMENT_PROVIDER ?? "stripe",
  redis: new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:16379"),
};
// The initial email/password provider is explicitly confined to local P0/P1.
export function assertLocalRuntime() {
  if (!settings.local)
    throw new Error(
      "Public deployment requires OIDC/MFA and verified production configuration; this build is local P0/P1 only.",
    );
}
