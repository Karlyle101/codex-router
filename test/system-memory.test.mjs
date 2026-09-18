import assert from "node:assert/strict";
import test from "node:test";

import { classifyMemory, readSystemMemory } from "../src/system-memory.mjs";

const GIB = 1024 ** 3;

test("a machine with room and an untouched swap file is normal", () => {
  const result = classifyMemory({
    totalBytes: 16 * GIB,
    availableBytes: 6 * GIB,
    swapUsedBytes: 0,
  });
  assert.equal(result.pressure, "normal");
  assert.deepEqual(result.reasons, []);
});

test("the state that produced the bad qualification run is critical", () => {
  // Swap pinned near its ceiling with single-digit free memory: this is what a
  // six-minute load-and-timeout was actually measuring.
  const result = classifyMemory({
    totalBytes: 16 * GIB,
    availableBytes: 0.8 * GIB,
    swapUsedBytes: 12 * GIB,
  });
  assert.equal(result.pressure, "critical");
  assert.ok(result.reasons.length >= 1);
});

test("a heavy swap file alone warns without blocking", () => {
  const result = classifyMemory({
    totalBytes: 16 * GIB,
    availableBytes: 8 * GIB,
    swapUsedBytes: 3 * GIB,
  });
  assert.equal(result.pressure, "warning");
  assert.match(result.reasons[0], /swap/);
});

test("the live reading names the machine's real shape", () => {
  const live = readSystemMemory();
  assert.ok(["normal", "warning", "critical", "unknown"].includes(live.pressure));
  if (live.totalBytes) {
    assert.ok(live.availableBytes > 0);
    assert.ok(live.availablePercent >= 0 && live.availablePercent <= 100);
  }
});

test("an unanswerable machine is unknown, not a failure", () => {
  const live = readSystemMemory({
    platform: "darwin",
    spawn: () => {
      throw new Error("no vm_stat here");
    },
  });
  assert.equal(live.pressure, "unknown");
  assert.deepEqual(live.reasons, []);
});
