// Cloud mutations are replaced by a driver; all database writes use a disposable schema.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { root } from "../packages/core/config.js";
import type { AzurePlanSnapshot } from "../packages/core/azure.js";
import type {
  ProvisionDriver,
  MachineOperation,
} from "../packages/core/provisioning.js";
const schema = "qa_provision_" + randomUUID().replaceAll("-", "");
const admin = new PrismaClient();
const liveNode = process.argv.includes("--live-probe")
  ? await admin.node.findFirstOrThrow({
      where: { id: "xz-p0-jp", ready: true },
    })
  : null;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("schema", schema);
process.env.DATABASE_URL = url.toString();
const { db } = await import("../packages/core/db.js");
const {
  createMachine,
  advanceMachine,
  retryMachine,
  machineSelect,
  machineView,
} = await import("../packages/core/provisioning.js");
const { nodePoolWhere } = await import("../packages/core/node-pool.js");
const { healthState } = await import("../packages/core/node-health.js");
const fixture = {
  subscription: randomUUID(),
  resourceGroup: "qa-only",
  managementSourceCidr: "192.0.2.1/32",
  controlAddress: "127.0.0.1",
  region: "germanywestcentral",
  country: "DE",
  regionName: "Germany West Central",
  size: "Standard_B2ats_v2",
  vcpus: 2,
  memoryGiB: 1,
  imageVersion: "qa",
  templateHash: "qa",
  cloudInitHash: "qa",
  nodeImage: "qa",
  cost: {
    currency: "USD",
    computeHourly: 0.01,
    computeMonthly: 7.3,
    excludes: [],
  },
} satisfies AzurePlanSnapshot;
async function plan(actorId = "qa-admin", expiry = 60_000) {
  return db.provisionPlan.create({
    data: {
      actorId,
      snapshot: fixture,
      expiresAt: new Date(Date.now() + expiry),
    },
  });
}
async function row(id: string) {
  return db.provisionOperation.findUniqueOrThrow({ where: { id } });
}
async function runSteps(id: string, driver: ProvisionDriver, count: number) {
  for (let i = 0; i < count; i++) await advanceMachine(id, driver);
}
let submits = 0,
  installs = 0,
  registrations = 0,
  verified = false;
let deploymentFailed = false,
  installationFailed = false,
  installationExists = false;
const driver: ProvisionDriver = {
  async submit() {
    submits++;
    return { azureState: "Accepted" };
  },
  async poll() {
    return deploymentFailed
      ? { azureState: "Failed", errorCode: "AllocationFailed" }
      : { azureState: "Succeeded", address: "192.0.2.2", vmId: "qa-vm" };
  },
  async install() {
    installs++;
    installationExists = true;
  },
  async installed() {
    return {
      azureState: installationFailed
        ? "Failed"
        : installationExists
          ? "Succeeded"
          : "NotFound",
      hostKey: "ssh-ed25519 fake-qa",
    };
  },
  async register(op) {
    registrations++;
    await db.node.upsert({
      where: { operationId: op.id },
      create: {
        id: op.nodeName,
        name: op.nodeName,
        region: op.region,
        country: op.country,
        address: "192.0.2.2",
        publicKey: "a".repeat(43),
        shortId: "abcd",
        serverName: "example.com",
        publishedAt: null,
        globalPool: true,
        operationId: op.id,
      },
      update: {},
    });
  },
  async verify() {
    if (!verified) throw new Error("REALITY_CLIENT_PROBE_FAILED");
    return true;
  },
};
try {
  execFileSync(
    process.execPath,
    [root + "node_modules/prisma/build/index.js", "migrate", "deploy"],
    { cwd: root, env: process.env, stdio: "pipe", timeout: 60_000 },
  );
  assert.equal(await db.node.count(), 0);
  const p = await plan(),
    key = randomUUID();
  const results = await Promise.all([
    createMachine("qa-admin", p.id, key),
    createMachine("qa-admin", p.id, key),
    createMachine("qa-admin", p.id, randomUUID()),
  ]);
  assert(results.every((x) => x.id === results[0].id));
  const id = results[0].id;
  assert.equal(await db.provisionOperation.count(), 1);
  await assert.rejects(() => createMachine("other", p.id, randomUUID()));
  await assert.rejects(() => createMachine("qa-admin", randomUUID(), key));
  const expired = await plan("qa-admin", -1000);
  await assert.rejects(() =>
    createMachine("qa-admin", expired.id, randomUUID()),
  );
  const p2 = await plan();
  const second = await createMachine("qa-admin", p2.id, randomUUID());
  assert.notEqual(
    (await row(id)).controlPort,
    (await row(second.id)).controlPort,
  );
  // A live lease prevents another worker from performing a cloud side effect.
  await db.provisionOperation.update({
    where: { id },
    data: { leaseOwner: "other", leaseUntil: new Date(Date.now() + 30_000) },
  });
  await advanceMachine(id, driver);
  assert.equal(submits, 0);
  await db.provisionOperation.update({
    where: { id },
    data: { leaseUntil: new Date(Date.now() - 1) },
  });
  await advanceMachine(id, driver);
  assert.equal(submits, 1);
  deploymentFailed = true;
  await advanceMachine(id, driver);
  assert.equal((await row(id)).status, "failed");
  await retryMachine("qa-admin", id);
  assert.equal((await row(id)).phase, "queued");
  deploymentFailed = false;
  await runSteps(id, driver, 2);
  assert.equal(submits, 2);
  assert.equal((await row(id)).phase, "installing");
  await advanceMachine(id, driver);
  assert.equal(installs, 1);
  installationFailed = true;
  await advanceMachine(id, driver);
  assert.equal((await row(id)).status, "failed");
  assert.equal(installs, 1);
  await retryMachine("qa-admin", id);
  await advanceMachine(id, driver);
  assert.equal(installs, 2);
  installationFailed = false;
  await runSteps(id, driver, 2);
  assert.equal(registrations, 1);
  assert.equal((await row(id)).phase, "verifying");
  await advanceMachine(id, driver);
  assert.equal((await row(id)).status, "failed");
  const unpublished = await db.node.findUniqueOrThrow({
    where: { operationId: id },
  });
  assert.equal(healthState(unpublished), "PROVISIONING");
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ regions: ["DE"], globalPool: true }),
    }),
    0,
  );
  const subscribers = await Promise.all([
    db.user.create({
      data: {
        email: "global@example.test",
        passwordHash: "qa",
        subscription: {
          create: {
            globalPool: true,
            regions: ["JP"],
            tokenHash: "keep-global-link",
          },
        },
      },
      include: { subscription: true },
    }),
    db.user.create({
      data: {
        email: "restricted@example.test",
        passwordHash: "qa",
        subscription: {
          create: {
            globalPool: false,
            regions: ["JP"],
            tokenHash: "keep-restricted-link",
          },
        },
      },
      include: { subscription: true },
    }),
    db.user.create({
      data: {
        email: "regional@example.test",
        passwordHash: "qa",
        subscription: {
          create: {
            globalPool: false,
            regions: ["DE"],
            tokenHash: "keep-regional-link",
          },
        },
      },
      include: { subscription: true },
    }),
  ]);
  await retryMachine("qa-admin", id);
  verified = true;
  await runSteps(id, driver, 2); // Verification, then atomic publication and entitlement outbox.
  assert.equal((await row(id)).phase, "publishing");
  assert.equal(await db.outbox.count(), 2);
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ regions: ["JP"], globalPool: false }),
    }),
    0,
  );
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ regions: ["JP"], globalPool: true }),
    }),
    1,
  );
  assert.equal(
    await db.node.count({
      where: nodePoolWhere({ regions: ["DE"], globalPool: false }),
    }),
    1,
  );
  assert.equal(
    (
      await db.subscription.findUniqueOrThrow({
        where: { id: subscribers[0].subscription!.id },
      })
    ).tokenHash,
    "keep-global-link",
  );
  await advanceMachine(id, driver);
  assert.equal((await row(id)).phase, "publishing");
  assert.equal(await db.outbox.count(), 2);
  await db.subscription.updateMany({
    where: { desiredVersion: 1 },
    data: { appliedVersion: 1 },
  });
  await advanceMachine(id, driver);
  assert.equal((await row(id)).status, "ready");
  await db.provisionOperation.update({
    where: { id },
    data: {
      privateState: "SECRET_SENTINEL",
      checkpoint: { secret: "SECRET_SENTINEL" },
    },
  });
  const publicRow = machineView(
    await db.provisionOperation.findUniqueOrThrow({
      where: { id },
      select: machineSelect,
    }),
  );
  assert(!JSON.stringify(publicRow).includes("SECRET_SENTINEL"));
  // A lost worker after ARM accepted: same identity is passed again, never a new VM name.
  const seen: string[] = [];
  await advanceMachine(second.id, {
    ...driver,
    async submit(op) {
      seen.push(op.nodeName);
      throw new Error("AZURE_REQUEST_TIMEOUT");
    },
  });
  await retryMachine("qa-admin", second.id);
  await advanceMachine(second.id, {
    ...driver,
    async submit(op) {
      seen.push(op.nodeName);
      return { azureState: "Succeeded" };
    },
  });
  assert.equal(seen[0], seen[1]);
  // Lost response after extension submission: observe the running extension without installing twice.
  await db.provisionOperation.update({
    where: { id: second.id },
    data: { phase: "installing", checkpoint: {}, status: "running" },
  });
  const beforeInstalls = installs;
  await advanceMachine(second.id, {
    ...driver,
    async installed() {
      return { azureState: "Creating" };
    },
  });
  assert.equal(installs, beforeInstalls);
  assert.equal(
    ((await row(second.id)).checkpoint as { installSubmitted: boolean })
      .installSubmitted,
    true,
  );
  if (liveNode) {
    const { productionProvisionDriver } = await import(
      "../packages/core/provisioning-driver.js"
    );
    const { engine } = await import("../packages/engine-remnawave/client.js");
    const liveId = randomUUID();
    await db.node.create({
      data: {
        ...liveNode,
        id: "qa-live-probe",
        name: liveNode.name,
        operationId: liveId,
        controlPort: null,
      },
    });
    const op = {
      ...(await row(id)),
      id: liveId,
      plan: { snapshot: fixture },
    } as MachineOperation;
    try {
      assert.equal(await productionProvisionDriver.verify(op), true);
      console.log(
        "PASS real Mihomo/REALITY probe: JP exit IP matched; temporary identity disabled",
      );
    } finally {
      const user = await engine.findUser("xzp_" + liveId.replaceAll("-", ""));
      if (user?.uuid) await engine.request("/users/" + user.uuid, "DELETE");
    }
  }
  console.log(
    "PASS isolated provisioning: idempotency, ownership, expiry, leases, deployment/install/probe failures, retries, pool scope, publication outbox, unchanged links, secret projection, crash recovery",
  );
} finally {
  await db.$disconnect();
  // Only the random schema created by this invocation is removed.
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
}
