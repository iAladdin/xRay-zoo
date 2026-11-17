import { test } from "node:test";
import assert from "node:assert/strict";
import { healthState, FRESH_MS } from "../packages/core/node-health.js";
const now = Date.now();
const node = {
  enabled: true,
  engineConnected: true,
  engineDisabled: false,
  transportConnected: true,
  checkedAt: new Date(now),
  healthReason: "READY",
};
test("readiness distinguishes stale observations, failed control transport, engine failure and operator disable", () => {
  assert.equal(healthState(node, now), "READY");
  assert.equal(
    healthState(
      {
        ...node,
        enabled: false,
        engineConnected: false,
        engineDisabled: true,
        healthReason: "ENGINE_UNAVAILABLE",
      },
      now,
    ),
    "ENGINE_UNAVAILABLE",
  );
  assert.equal(
    healthState({ ...node, checkedAt: new Date(now - FRESH_MS - 1) }, now),
    "STALE",
  );
  assert.equal(
    healthState({ ...node, transportConnected: false }, now),
    "CONTROL_DISCONNECTED",
  );
  assert.equal(
    healthState({ ...node, healthReason: "ENGINE_UNAVAILABLE" }, now),
    "ENGINE_UNAVAILABLE",
  );
  assert.equal(
    healthState({ ...node, enabled: false }, now),
    "DISABLE_PENDING",
  );
  assert.equal(
    healthState(
      { ...node, enabled: false, engineDisabled: true, engineConnected: false },
      now,
    ),
    "DISABLED",
  );
  assert.equal(
    healthState({ ...node, engineDisabled: true }, now),
    "ENGINE_DISABLED",
  );
  assert.equal(
    healthState(
      { ...node, engineConnected: false, healthReason: "NODE_MISSING" },
      now,
    ),
    "NODE_MISSING",
  );
});
