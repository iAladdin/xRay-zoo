import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import type { Response } from "express";
import { root } from "../packages/core/config.js";
import type { RotationDriver } from "../packages/core/ip-rotation.js";
const schema = "qa_ip_" + randomUUID().replaceAll("-", "");
const admin = new PrismaClient();
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("schema", schema);
process.env.DATABASE_URL = url.toString();
const { db } = await import("../packages/core/db.js");
const {
  createRotation,
  retryRotation,
  advanceRotation,
  rotationSelect,
  rotationView,
} = await import("../packages/core/ip-rotation.js");
const { createMachine } = await import("../packages/core/provisioning.js");
const { nodeAction, healthState } = await import(
  "../packages/core/node-health.js"
);
const { sendConfig } = await import("../packages/core/subscription-access.js");
const { seal } = await import("../packages/core/crypto.js");
const accessIdentity = seal(randomUUID());
let newAddress = "8.8.4.4",
  bound = "8.8.8.8",
  probeFails = false,
  bindTimeout = false,
  cleanupFails = false;
const calls: string[] = [];
const driver: RotationDriver = {
  async allocate(op) {
    calls.push("allocate:" + op.id);
  },
  async allocated() {
    return { state: "Succeeded", address: newAddress };
  },
  async bind(op, restore) {
    calls.push(restore ? "bind-old" : "bind-new");
    bound = restore ? op.oldAddress : newAddress;
    if (bindTimeout) {
      bindTimeout = false;
      throw new Error("AZURE_REQUEST_TIMEOUT");
    }
    return { done: true };
  },
  async reconnect(_op, restore) {
    calls.push(restore ? "reconnect-old" : "reconnect-new");
  },
  async verify(op, restore) {
    calls.push(restore ? "verify-old" : "verify-new");
    if (probeFails && !restore) throw new Error("REALITY_CLIENT_PROBE_FAILED");
    assert.equal(bound, restore ? op.oldAddress : newAddress);
    return true;
  },
  async publish(_op, restore) {
    calls.push(restore ? "publish-old" : "publish-new");
  },
  async cleanup(_op, rollback) {
    calls.push(rollback ? "delete-new" : "delete-old");
    if (cleanupFails) {
      cleanupFails = false;
      throw new Error("AZURE_REQUEST_TIMEOUT");
    }
    return { done: true };
  },
};
const row = (id: string) => db.ipRotation.findUniqueOrThrow({ where: { id } });
const node = () => db.node.findUniqueOrThrow({ where: { id: "qa-jp" } });
async function plan(expiry = 600_000) {
  const n = await node();
  return db.provisionPlan.create({
    data: {
      actorId: "qa-admin",
      kind: "ip-rotation",
      expiresAt: new Date(Date.now() + expiry),
      snapshot: {
        nodeId: n.id,
        nodeName: n.name,
        oldAddress: n.address,
        hostKey: "PRIVATE_STATE_SENTINEL",
      },
    },
  });
}
async function step(id: string, count = 1) {
  for (let i = 0; i < count; i++) await advanceRotation(id, driver);
}
try {
  execFileSync(
    process.execPath,
    [root + "node_modules/prisma/build/index.js", "migrate", "deploy"],
    { cwd: root, env: process.env, stdio: "pipe", timeout: 60_000 },
  );
  await db.node.create({
    data: {
      id: "qa-jp",
      name: "qa-jp",
      country: "JP",
      region: "japaneast",
      address: bound,
      publicKey: "a".repeat(43),
      shortId: "abcd",
      serverName: "example.com",
      ready: true,
      engineConnected: true,
      transportConnected: true,
      checkedAt: new Date(),
      engineNodeId: randomUUID(),
      squadId: randomUUID(),
    },
  });
  const user = await db.user.create({
    data: {
      email: "rotation@example.test",
      passwordHash: "qa",
      subscription: {
        create: {
          regions: ["JP"],
          tokenHash: "keep-original-link",
          accessUuidCipher: accessIdentity,
          status: "active",
          validUntil: new Date(Date.now() + 600_000),
          quotaBytes: 1_000_000_000n,
          desiredVersion: 3,
          appliedVersion: 3,
        },
      },
    },
    include: { subscription: true },
  });
  async function yaml() {
    let body = "";
    const response = {
      set() {
        return this;
      },
      send(value: string) {
        body = value;
      },
    } as unknown as Response;
    await sendConfig(user.subscription, response);
    return body;
  }
  assert((await yaml()).includes("server: 8.8.8.8"));
  const p = await plan(),
    key = randomUUID();
  await assert.rejects(() =>
    createRotation("other", "qa-jp", p.id, randomUUID()),
  );
  await assert.rejects(() => createMachine("qa-admin", p.id, randomUUID()));
  const expired = await plan(-100);
  await assert.rejects(() =>
    createRotation("qa-admin", "qa-jp", expired.id, randomUUID()),
  );
  const results = await Promise.all([
    createRotation("qa-admin", "qa-jp", p.id, key),
    createRotation("qa-admin", "qa-jp", p.id, key),
    createRotation("qa-admin", "qa-jp", p.id, randomUUID()),
  ]);
  assert(results.every((x) => x.id === results[0].id));
  const id = results[0].id;
  const conflict = await plan();
  await assert.rejects(() =>
    createRotation("qa-admin", "qa-jp", conflict.id, randomUUID()),
  );
  await assert.rejects(
    () => nodeAction("qa-jp", "disable", "qa-admin"),
    /NODE_BUSY/,
  );
  await db.ipRotation.update({
    where: { id },
    data: { leaseOwner: "other", leaseUntil: new Date(Date.now() + 30_000) },
  });
  await step(id);
  assert.equal(calls.length, 0);
  await db.ipRotation.update({
    where: { id },
    data: { leaseUntil: new Date(Date.now() - 1) },
  });
  await step(id, 2);
  assert.equal((await row(id)).phase, "switching");
  assert.equal((await node()).ready, true);
  bindTimeout = true;
  await step(id);
  assert.equal((await row(id)).status, "failed");
  assert.equal(bound, newAddress);
  assert.equal((await node()).address, "8.8.8.8");
  assert.equal(healthState(await node()), "ROTATING_IP");
  await assert.rejects(() => yaml(), /节点状态正在确认/);
  assert.equal(
    await db.node.count({ where: { ready: true, addressChanging: false } }),
    0,
  );
  await retryRotation("qa-admin", id);
  await step(id, 2);
  assert.equal((await row(id)).phase, "verifying");
  probeFails = true;
  await step(id);
  assert.equal((await row(id)).status, "failed");
  assert(!calls.includes("delete-old"));
  assert(!calls.includes("publish-new"));
  const view = rotationView(
    await db.ipRotation.findUniqueOrThrow({
      where: { id },
      select: rotationSelect,
    }),
  );
  assert(view.canRollback);
  assert(!JSON.stringify(view).includes("PRIVATE_STATE_SENTINEL"));
  await retryRotation("qa-admin", id);
  probeFails = false;
  await step(id, 2);
  assert.equal((await node()).address, newAddress);
  assert.equal((await node()).addressChanging, false);
  assert.equal((await row(id)).phase, "cleanup");
  const updatedYaml = await yaml();
  assert(updatedYaml.includes("server: " + newAddress));
  assert(!updatedYaml.includes("server: 8.8.8.8"));
  cleanupFails = true;
  await step(id);
  assert.equal((await row(id)).status, "failed");
  assert.equal((await node()).ready, true);
  await assert.rejects(() => retryRotation("qa-admin", id, true));
  await retryRotation("qa-admin", id);
  await step(id);
  assert.equal((await row(id)).status, "ready");
  assert.equal((await node()).activeIpRotationId, null);
  assert(calls.indexOf("publish-new") > calls.indexOf("verify-new"));
  assert(calls.indexOf("delete-old") > calls.indexOf("publish-new"));
  const sub = await db.subscription.findUniqueOrThrow({
    where: { id: user.subscription!.id },
  });
  assert.equal(sub.tokenHash, "keep-original-link");
  assert.equal(sub.accessUuidCipher, accessIdentity);
  assert.equal(sub.desiredVersion, 3);
  // A later failed rotation can restore the current address without releasing it.
  const oldAddress = newAddress;
  newAddress = "8.8.4.5";
  const p2 = await plan();
  const second = await createRotation("qa-admin", "qa-jp", p2.id, randomUUID());
  await step(second.id, 4);
  probeFails = true;
  await step(second.id);
  assert.equal((await row(second.id)).status, "failed");
  assert.equal((await node()).address, oldAddress);
  await retryRotation("qa-admin", second.id, true);
  await step(second.id, 5);
  assert.equal((await row(second.id)).status, "rolled_back");
  assert.equal((await node()).address, oldAddress);
  assert.equal((await node()).ready, true);
  assert.equal((await node()).activeIpRotationId, null);
  assert.equal(calls.at(-1), "delete-new");
  assert((await yaml()).includes("server: " + oldAddress));
  assert(!(await yaml()).includes("server: " + newAddress));
  assert(calls.includes("verify-old"));
  // Allocator failures restart the allocation step under the same operation ID.
  const p3 = await plan();
  const third = await createRotation("qa-admin", "qa-jp", p3.id, randomUUID());
  await step(third.id);
  await advanceRotation(third.id, {
    ...driver,
    async allocated() {
      return { state: "Failed" };
    },
  });
  await retryRotation("qa-admin", third.id);
  assert.equal((await row(third.id)).phase, "queued");
  // A stale worker must not advance or fail a task after another worker owns it.
  await advanceRotation(third.id, {
    ...driver,
    async allocate() {
      await db.ipRotation.update({
        where: { id: third.id },
        data: {
          leaseOwner: "replacement",
          leaseUntil: new Date(Date.now() + 300_000),
        },
      });
    },
  });
  const replaced = await row(third.id);
  assert.equal(replaced.leaseOwner, "replacement");
  assert.equal(replaced.phase, "queued");
  assert.equal(replaced.status, "running");
  console.log(
    "PASS isolated IP rotation: immutable plans, idempotency, node/worker locks, lost bind response, fail-closed probe, publication order, cleanup retries, unchanged subscription, rollback and allocation recovery",
  );
} finally {
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
