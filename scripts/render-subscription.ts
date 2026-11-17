import { readFile, writeFile, chmod } from "node:fs/promises";
import { renderSubscription } from "../packages/subscription/index.js";
const [inventoryFile, accessFile, outputFile] = process.argv.slice(2);
if (!inventoryFile || !accessFile || !outputFile)
  throw new Error(
    "Usage: pnpm subscription:render <nodes.json> <private-access.json> <output.yaml>",
  );
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const access = JSON.parse(await readFile(accessFile, "utf8"));
const yaml = renderSubscription(inventory.nodes ?? inventory, access.vlessUuid);
await writeFile(outputFile, yaml, { mode: 0o600 });
await chmod(outputFile, 0o600);
console.log(
  `Wrote private subscription YAML to ${outputFile}; credentials were not printed.`,
);
