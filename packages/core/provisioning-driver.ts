import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Node } from "@prisma/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { db } from "./db.js";
import { root } from "./config.js";
import { seal, unseal } from "./crypto.js";
import { azure, type AzurePlanSnapshot } from "./azure.js";
import { engine } from "../engine-remnawave/client.js";
import { controlTunnels } from "./node-health.js";
import { buildConfig } from "../subscription/index.js";
import type { ProvisionDriver, MachineOperation } from "./provisioning.js";
const exec = promisify(execFile);
type EngineRecord = {
  uuid: string;
  name?: string;
  remark?: string;
  isConnected?: boolean;
  isDisabled?: boolean;
  inbounds?: { tag: string; uuid: string }[];
};
type PrivateState = {
  privateKey: string;
  publicKey: string;
  shortId: string;
  serverName: string;
};
async function rows(path: string, key: string) {
  const value = await engine.request<
    EngineRecord[] | Record<string, EngineRecord[]>
  >(path);
  return Array.isArray(value) ? value : value[key];
}
function input(op: MachineOperation) {
  return { operationId: op.id, nodeName: op.nodeName, plan: op.plan.snapshot };
}
async function register(op: MachineOperation) {
  const p = op.plan.snapshot as unknown as AzurePlanSnapshot;
  const state = op.checkpoint as {
    address: string;
    vmId: string;
    hostKey: string;
  };
  const retainedNode = await db.node.findUnique({ where: { id: op.nodeName } });
  await azure("tunnel", {
    operationId: op.id,
    nodeName: op.nodeName,
    address: state.address,
    hostKey: state.hostKey,
    controlPort: op.controlPort,
    rebuild: !!retainedNode?.activeLifecycleId,
  });
  const tunnels = await controlTunnels(true, op.nodeName);
  if (!tunnels.some((t) => t.id === op.nodeName && t.connected))
    throw new Error("CONTROL_TRANSPORT_UNAVAILABLE");
  let keys: PrivateState;
  if (op.privateState || retainedNode?.realityStateCipher)
    keys = JSON.parse(
      unseal(op.privateState ?? retainedNode!.realityStateCipher!),
    );
  else {
    const pair = generateKeyPairSync("x25519");
    keys = {
      privateKey: pair.privateKey.export({ format: "jwk" }).d!,
      publicKey: pair.publicKey.export({ format: "jwk" }).x!,
      shortId: randomBytes(8).toString("hex"),
      serverName: "www.cloudflare.com",
    };
    const updated = await db.provisionOperation.updateMany({
      where: { id: op.id, leaseOwner: op.leaseOwner },
      data: { privateState: seal(JSON.stringify(keys)) },
    });
    if (!updated.count) throw new Error("PROVISION_LEASE_LOST");
  }
  let profile = (await rows("/config-profiles", "configProfiles")).find(
    (x) => x.name === op.nodeName,
  );
  if (!profile) {
    profile = await engine.request<EngineRecord>("/config-profiles", "POST", {
      name: op.nodeName,
      config: {
        log: { loglevel: "warning", access: "none" },
        inbounds: [
          {
            tag: op.nodeName,
            port: 443,
            listen: "0.0.0.0",
            protocol: "vless",
            settings: { clients: [], decryption: "none" },
            sniffing: {
              enabled: true,
              destOverride: ["http", "tls"],
              routeOnly: true,
            },
            streamSettings: {
              network: "tcp",
              security: "reality",
              realitySettings: {
                show: false,
                target: keys.serverName + ":443",
                serverNames: [keys.serverName],
                privateKey: keys.privateKey,
                shortIds: [keys.shortId],
              },
            },
          },
        ],
        outbounds: [
          {
            tag: "DIRECT",
            protocol: "freedom",
            settings: {},
            streamSettings: { sockopt: { domainStrategy: "UseIP" } },
          },
          { tag: "BLOCK", protocol: "blackhole" },
        ],
        routing: {
          domainStrategy: "IPIfNonMatch",
          rules: [
            {
              type: "field",
              ip: ["geoip:private", "169.254.169.254", "168.63.129.16"],
              outboundTag: "BLOCK",
            },
          ],
        },
      },
    });
  }
  const inbound = profile.inbounds?.find((x) => x.tag === op.nodeName);
  if (!inbound) throw new Error("ENGINE_INBOUND_MISSING");
  let squad = (await rows("/internal-squads", "internalSquads")).find(
    (x) => x.name === op.nodeName,
  );
  if (!squad)
    squad = await engine.request<EngineRecord>("/internal-squads", "POST", {
      name: op.nodeName,
      inbounds: [inbound.uuid],
    });
  let node = (await rows("/nodes", "nodes")).find(
    (x) => x.name === op.nodeName,
  );
  if (!node)
    node = await engine.request<EngineRecord>("/nodes", "POST", {
      name: op.nodeName,
      address: p.controlAddress,
      port: op.controlPort,
      countryCode: op.country,
      configProfile: {
        activeConfigProfileUuid: profile.uuid,
        activeInbounds: [inbound.uuid],
      },
    });
  await engine.request("/nodes", "PATCH", {
    uuid: node.uuid,
    address: p.controlAddress,
    port: op.controlPort,
    configProfile: {
      activeConfigProfileUuid: profile.uuid,
      activeInbounds: [inbound.uuid],
    },
  });
  if (node.isDisabled)
    await engine.request(`/nodes/${node.uuid}/actions/enable`, "POST", {});
  let host = (await rows("/hosts", "hosts")).find(
    (x) => x.remark === op.nodeName,
  );
  if (!host)
    await engine.request("/hosts", "POST", {
      remark: op.nodeName,
      address: state.address,
      port: 443,
      sni: keys.serverName,
      fingerprint: "chrome",
      inbound: {
        configProfileUuid: profile.uuid,
        configProfileInboundUuid: inbound.uuid,
      },
      nodes: [node.uuid],
    });
  if (host)
    await engine.request("/hosts", "PATCH", {
      uuid: host.uuid,
      address: state.address,
      port: 443,
      sni: keys.serverName,
      nodes: [node.uuid],
      isDisabled: false,
    });
  const data = {
    name: op.nodeName,
    country: op.country,
    region: op.region,
    address: state.address,
    port: 443,
    publicKey: keys.publicKey,
    shortId: keys.shortId,
    serverName: keys.serverName,
    engineNodeId: node.uuid,
    configProfileId: profile.uuid,
    inboundId: inbound.uuid,
    squadId: squad.uuid,
    enabled: true,
    globalPool: true,
    publishedAt: null,
    ready: false,
    operationId: op.id,
    azureVmId: state.vmId,
    vmSize: op.size,
    controlPort: op.controlPort,
    realityStateCipher: seal(JSON.stringify(keys)),
    diskType: "Standard_LRS",
    diskSizeGiB: 32,
  };
  await db.node.upsert({
    where: { id: op.nodeName },
    create: { id: op.nodeName, ...data },
    update: data,
  });
}
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function verify(op: MachineOperation) {
  const node = await db.node.findUniqueOrThrow({
    where: { operationId: op.id },
  });
  return probeNode(node, op.id);
}
export async function probeNode(node: Node, probeId: string) {
  const observed = (await rows("/nodes", "nodes")).find(
    (x) => x.uuid === node.engineNodeId,
  );
  if (!observed?.isConnected || observed.isDisabled) return false;
  const username = "xzp_" + probeId.replaceAll("-", "");
  let client: ReturnType<typeof spawn> | undefined;
  try {
    await engine.ensureUser(username, {
      status: "DISABLED",
      expireAt: new Date(Date.now() + 900_000).toISOString(),
      trafficLimitBytes: 10_000_000,
      trafficLimitStrategy: "NO_RESET",
      activeInternalSquads: [node.squadId],
    });
    await engine.updateUser(username, {
      status: "ACTIVE",
      expireAt: new Date(Date.now() + 900_000).toISOString(),
      trafficLimitBytes: 10_000_000,
      activeInternalSquads: [node.squadId],
    });
    const user = await engine.findUser(username);
    if (!user) throw new Error("ENGINE_PROBE_USER_MISSING");
    const dir = root + "/.local/provisioning/" + probeId;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    let iface = process.env.PROBE_INTERFACE;
    try {
      if (!iface) {
        const config = parse(
          readFileSync(root + "/.local/control-proxy.yaml", "utf8"),
        );
        iface =
          config["interface-name"] ??
          config.proxies?.find(
            (p: Record<string, unknown>) => p["interface-name"],
          )?.["interface-name"];
      }
    } catch {}
    const proxies = buildConfig(
      [{ ...node, ready: true }],
      user.vlessUuid,
    ).proxies.map((p: Record<string, unknown>) => ({
      ...p,
      ...(iface ? { "interface-name": iface } : {}),
    }));
    const path = dir + "/probe.yaml";
    writeFileSync(
      path,
      stringify({
        "mixed-port": port,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        mode: "rule",
        "log-level": "silent",
        ipv6: false,
        proxies,
        rules: ["MATCH," + node.name],
      }),
      { mode: 0o600 },
    );
    let binary = process.env.MIHOMO_BINARY;
    if (!binary)
      binary = JSON.parse(
        readFileSync(root + "/.local/control-transport.json", "utf8"),
      ).binary;
    client = spawn(binary!, ["-d", dir, "-f", path], { stdio: "ignore" });
    let failed = false;
    client.on("error", () => {
      failed = true;
    });
    await new Promise((r) => setTimeout(r, 1000));
    if (failed || client.exitCode !== null)
      throw new Error("REALITY_CLIENT_PROBE_FAILED");
    const { stdout } = await exec(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "--proxy",
        `socks5h://127.0.0.1:${port}`,
        "--noproxy",
        "",
        "https://api.ipify.org",
      ],
      { timeout: 25_000 },
    );
    if (stdout.trim() !== node.address)
      throw new Error("REALITY_CLIENT_PROBE_FAILED");
    return true;
  } catch (error) {
    if (error instanceof Error && /^ENGINE_HTTP_\d+$/.test(error.message))
      throw error;
    throw new Error("REALITY_CLIENT_PROBE_FAILED");
  } finally {
    client?.kill("SIGTERM");
    const user = await engine.findUser(username);
    if (user) await engine.updateUser(username, { status: "DISABLED" });
  }
}
export const productionProvisionDriver: ProvisionDriver = {
  submit: (op) => azure("submit", input(op)),
  poll: (op) => azure("poll", input(op)),
  install: (op) => azure("install", input(op)),
  installed: (op) => azure("installed", input(op)),
  register,
  verify,
};
