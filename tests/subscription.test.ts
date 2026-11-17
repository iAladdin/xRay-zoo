import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfig,
  type SubscriptionNode,
} from "../packages/subscription/index.js";
const uuid = "00000000-0000-4000-8000-000000000001";
const nodes: SubscriptionNode[] = ["JP", "SG", "US", "HK", "TW"].map(
  (country) => ({
    id: country,
    name: `zoo-${country}`,
    country: country as SubscriptionNode["country"],
    address: "192.0.2.1",
    port: 443,
    publicKey: "a".repeat(43),
    shortId: "abcd",
    serverName: "example.com",
    ready: true,
  }),
);
function leaves(
  config: ReturnType<typeof buildConfig>,
  name: string,
): string[] {
  const group = config["proxy-groups"].find(
    (g: { name: string; proxies: string[] }) => g.name === name,
  );
  return group
    ? group.proxies.flatMap((p: string) => leaves(config, p))
    : [name];
}
test("AI and Telegram cannot fall through to a general or direct group", () => {
  const config = buildConfig(nodes, uuid);
  assert.deepEqual(
    new Set(leaves(config, "🤖 AI 服务")),
    new Set(["zoo-JP", "zoo-SG", "zoo-US"]),
  );
  assert.deepEqual(
    new Set(leaves(config, "✈️ Telegram")),
    new Set(["zoo-HK", "zoo-TW"]),
  );
  assert.equal(config.rules.at(-1), "MATCH,🐟 漏网之鱼");
});
test("unavailable Telegram regions fail closed instead of silently using Japan", () => {
  const config = buildConfig(
    nodes.filter((n) => n.country === "JP"),
    uuid,
  );
  assert.deepEqual(leaves(config, "✈️ Telegram"), ["REJECT"]);
});
test("unready and duplicate nodes cannot leak into the configuration", () => {
  assert.throws(
    () =>
      buildConfig(
        nodes.map((n) => ({ ...n, ready: false })),
        uuid,
      ),
    /NO_READY_NODES/,
  );
  assert.throws(
    () => buildConfig([nodes[0], nodes[0]], uuid),
    /DUPLICATE_NODE_NAME/,
  );
});
