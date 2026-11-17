import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { z } from "zod";

export const NodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  country: z.string().regex(/^[A-Z]{2}$/),
  address: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/),
  port: z.number().int().min(1).max(65535),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  shortId: z
    .string()
    .regex(/^[0-9a-f]{2,16}$/)
    .refine((v) => v.length % 2 === 0),
  serverName: z.string().regex(/^[A-Za-z0-9.-]+$/),
  ready: z.boolean(),
});
export type SubscriptionNode = z.infer<typeof NodeSchema>;
export const UUID = z.string().uuid();
const baseline = JSON.parse(
  readFileSync(new URL("./rules/tc-split.json", import.meta.url), "utf8"),
);
const categories = [
  ...new Set(
    (baseline.rules as string[])
      .filter((r) => r.startsWith("GEOSITE,"))
      .map((r) => r.split(",")[1]),
  ),
];
const ruleProviders = Object.fromEntries(
  categories.map((category) => [
    "xz-" + category,
    {
      type: "http",
      behavior: "domain",
      format: "mrs",
      url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/${encodeURIComponent(category)}.mrs`,
      path: `./ruleset/xray-zoo/${category}.mrs`,
      interval: 86400,
    },
  ]),
);

export function buildConfig(input: SubscriptionNode[], accessUuid: string) {
  UUID.parse(accessUuid);
  const nodes = input.map((v) => NodeSchema.parse(v)).filter((n) => n.ready);
  if (!nodes.length) throw new Error("NO_READY_NODES");
  const names = nodes.map((n) => n.name);
  if (new Set(names).size !== names.length)
    throw new Error("DUPLICATE_NODE_NAME");
  const ai = nodes
    .filter((n) => ["JP", "SG", "US"].includes(n.country))
    .map((n) => n.name);
  const tg = nodes
    .filter((n) => ["HK", "TW"].includes(n.country))
    .map((n) => n.name);
  const select = (name: string, options: string[]) => ({
    name,
    type: "select",
    proxies: options.length ? options : ["REJECT"],
  });
  const auto = (name: string, options: string[]) =>
    options.length
      ? {
          name,
          type: "url-test",
          url: "https://www.gstatic.com/generate_204",
          interval: 300,
          tolerance: 50,
          proxies: options,
        }
      : select(name, ["REJECT"]);
  const general = ["🚀 节点选择", "♻️ 自动选择", ...names, "DIRECT"];
  const directFirst = ["DIRECT", "🚀 节点选择", "♻️ 自动选择", ...names];
  return {
    ...structuredClone(baseline),
    "log-level": "warning",
    // Preserve tc rule order while avoiding stale GeoSite files missing newer categories.
    "rule-providers": structuredClone(ruleProviders),
    "geox-url": {
      geosite:
        "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
      mmdb: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb",
    },
    rules: [
      ...nodes.map((n) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(n.address)
          ? `IP-CIDR,${n.address}/32,DIRECT,no-resolve`
          : `DOMAIN,${n.address},DIRECT`,
      ),
      ...(baseline.rules as string[]).map((rule) =>
        rule.startsWith("GEOSITE,")
          ? rule.replace("GEOSITE,", "RULE-SET,xz-")
          : rule,
      ),
    ],
    "proxy-groups": [
      select("🚀 节点选择", ["♻️ 自动选择", ...names, "DIRECT"]),
      auto("♻️ 自动选择", names),
      auto("🤖 AI 自动", ai),
      select("🤖 AI 服务", ai.length ? ["🤖 AI 自动", ...ai] : ["REJECT"]),
      auto("✈️ TG 自动", tg),
      select("✈️ Telegram", tg.length ? ["✈️ TG 自动", ...tg] : ["REJECT"]),
      ...[
        "🔍 Google",
        "📺 YouTube",
        "🎬 流媒体",
        "🎵 Spotify",
        "🐙 GitHub",
        "🐟 漏网之鱼",
      ].map((n) => select(n, general)),
      ...["🍎 Apple", "🪟 Microsoft", "🎮 游戏平台"].map((n) =>
        select(n, directFirst),
      ),
    ],
    proxies: nodes.map((n) => ({
      name: n.name,
      type: "vless",
      server: n.address,
      port: n.port,
      uuid: accessUuid,
      network: "tcp",
      tls: true,
      udp: true,
      flow: "xtls-rprx-vision",
      "packet-encoding": "xudp",
      servername: n.serverName,
      "client-fingerprint": "chrome",
      "reality-opts": {
        "public-key": n.publicKey,
        "short-id": n.shortId,
        "support-x25519mlkem768": true,
      },
    })),
  };
}
export function renderSubscription(
  nodes: SubscriptionNode[],
  uuid: string,
): string {
  return (
    "# xRay-zoo · tc split · AI=JP/SG/US · Telegram=HK/TW\n" +
    stringify(buildConfig(nodes, uuid), { lineWidth: 0 })
  );
}
