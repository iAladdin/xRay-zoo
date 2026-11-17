import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { root } from "../packages/core/config.js";
import {
  buildConfig,
  type SubscriptionNode,
} from "../packages/subscription/index.js";
const exec = promisify(execFile);
const binary =
  process.env.MIHOMO_BINARY ??
  "/Users/aladdin/Library/Application Support/mClash/core/mihomo";
const nodes: SubscriptionNode[] = JSON.parse(
  readFileSync(root + "/.local/nodes.json", "utf8"),
).nodes;
const access = JSON.parse(
  readFileSync(
    process.env.PROBE_ACCESS_FILE ?? root + "/.local/p0-access.json",
    "utf8",
  ),
);
const transportPort = Number(process.env.PROBE_SOCKS_PORT || 0);
const results = await Promise.all(
  nodes.map(async (node, index) => {
    const dir = resolve(root, ".local/probes/" + node.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const port = 19790 + index;
    const full = buildConfig([{ ...node, ready: true }], access.vlessUuid);
    const path = dir + "/probe.yaml";
    const proxies = transportPort
      ? [
          ...full.proxies.map((p: object) => ({
            ...p,
            "dialer-proxy": "p0-transport",
          })),
          {
            name: "p0-transport",
            type: "socks5",
            server: "127.0.0.1",
            port: transportPort,
          },
        ]
      : full.proxies;
    writeFileSync(
      path,
      stringify({
        "mixed-port": port,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        mode: "rule",
        "log-level": "warning",
        ipv6: false,
        proxies,
        rules: ["MATCH," + node.name],
      }),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    const client = spawn(binary, ["-d", dir, "-f", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    client.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    client.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const args = [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "--proxy",
        `socks5h://127.0.0.1:${port}`,
        "--noproxy",
        "",
      ];
      let trace: Record<string, string>,
        source = "cloudflare";
      try {
        const { stdout } = await exec(
          "curl",
          [...args, "https://www.cloudflare.com/cdn-cgi/trace"],
          { timeout: 25_000 },
        );
        trace = Object.fromEntries(
          stdout
            .trim()
            .split("\n")
            .map((line) => line.split("=")),
        );
      } catch {
        const { stdout } = await exec(
          "curl",
          [...args, "https://ipinfo.io/json"],
          { timeout: 25_000 },
        );
        const result = JSON.parse(stdout);
        trace = { ip: result.ip, loc: result.country };
        source = "ipinfo";
      }
      return {
        node: node.name,
        expectedCountry: node.country,
        observedCountry: trace.loc,
        expectedIp: node.address,
        observedIp: trace.ip,
        source,
        transport: transportPort
          ? "SSH SOCKS relay to public REALITY endpoint"
          : "direct",
        success: trace.ip === node.address,
        at: new Date().toISOString(),
      };
    } catch (error) {
      if (error && typeof error === "object" && "stderr" in error)
        logs += "\nHTTP probe: " + String(error.stderr);
      writeFileSync(dir + "/client.log", logs, { mode: 0o600 });
      return {
        node: node.name,
        expectedCountry: node.country,
        success: false,
        error: "REALITY_CLIENT_PROBE_FAILED",
        at: new Date().toISOString(),
      };
    } finally {
      client.kill("SIGTERM");
    }
  }),
);
writeFileSync(
  root + "/.local/probe-results.json",
  JSON.stringify(results, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => !r.success)) process.exitCode = 1;
