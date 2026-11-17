import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "../core/config.js";

export type EngineUser = {
  id: number;
  uuid?: string;
  username: string;
  vlessUuid: string;
  status: string;
  expireAt: string;
  trafficLimitBytes: number;
  usedTrafficBytes?: number;
  userTraffic?: {
    usedTrafficBytes?: number;
    lifetimeUsedTrafficBytes?: number;
  };
  activeInternalSquads?: unknown[];
};
export class RemnawaveClient {
  private credentials() {
    if (process.env.REMNAWAVE_API_TOKEN)
      return {
        baseUrl: process.env.REMNAWAVE_BASE_URL ?? "http://127.0.0.1:3300",
        token: process.env.REMNAWAVE_API_TOKEN,
      };
    const saved = JSON.parse(
      readFileSync(resolve(root, ".local/engine-auth.json"), "utf8"),
    );
    return {
      baseUrl: saved.baseUrl as string,
      token: saved.apiToken as string,
    };
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const { baseUrl, token } = this.credentials();
    const response = await fetch(baseUrl + "/api" + path, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "127.0.0.1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`ENGINE_HTTP_${response.status}`);
    const result = (await response.json()) as { response: T };
    return result.response;
  }
  async findUser(username: string): Promise<EngineUser | null> {
    try {
      return await this.request<EngineUser>(
        `/users/by-username/${encodeURIComponent(username)}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "ENGINE_HTTP_404")
        return null;
      throw error;
    }
  }
  async ensureUser(
    username: string,
    input: Record<string, unknown>,
  ): Promise<EngineUser> {
    const existing = await this.findUser(username);
    if (existing) return existing;
    try {
      return await this.request<EngineUser>("/users", "POST", {
        username,
        ...input,
      });
    } catch (error) {
      const recovered = await this.findUser(username);
      if (recovered) return recovered;
      throw error;
    }
  }
  async updateUser(username: string, input: Record<string, unknown>) {
    return this.request<EngineUser>("/users", "PATCH", { username, ...input });
  }
}
export const engine = new RemnawaveClient();
