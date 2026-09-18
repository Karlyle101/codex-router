import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// The runtime module resolves its state path once, at import time, so the
// redirection has to be in place before the import. Nothing here may touch the
// operator's real runtime state file or the real llama.cpp on port 8080.
const root = mkdtempSync(path.join(os.tmpdir(), "llamacpp-cancel-test-"));
const statePath = path.join(root, "llamacpp-runtime.json");
process.env.MODEL_ROUTER_LLAMACPP_RUNTIME_STATE = statePath;
process.env.MODEL_ROUTER_LLAMACPP_BASE_URL = "http://127.0.0.1:9/v1";

const {
  awaitLocalRuntimeCleanup,
  cleanupAfterLocalCancellation,
  llamacppSlotActivity,
  localRuntimeCleanupInProgress,
  noteLocalRuntimeIdle,
  resetLocalRuntimeLifecycleForTests,
  stopManagedLlamacpp,
  waitForLlamacppPortFree,
} = await import("../src/llamacpp-runtime.mjs");

const IDENTITY = "started-at-2026-09-18T00:00:00Z|/opt/homebrew/bin/llama-server";

// A managed runtime the module is allowed to believe it owns, plus the two
// process hooks it uses. `alive` flips on the first signal so a stop settles
// immediately instead of waiting out the real 20s escalation ceiling.
function fakeRuntime() {
  const signals = [];
  let alive = true;
  return {
    signals,
    seed() {
      writeFileSync(
        statePath,
        `${JSON.stringify({
          version: 1,
          managed: true,
          phase: "ready",
          pid: 4242,
          processIdentity: IDENTITY,
          baseUrl: "http://127.0.0.1:9",
          startedAt: Date.now() - 60_000,
        })}\n`,
        { mode: 0o600 },
      );
    },
    identity: () => (alive ? IDENTITY : undefined),
    kill: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") alive = false;
    },
  };
}

function slotsFetch(busy) {
  return async (url) => {
    assert.match(String(url), /\/slots$/, `unexpected probe: ${url}`);
    return { ok: true, json: async () => [{ id: 0, is_processing: busy() }] };
  };
}

test("C1 a cancelled turn whose slot stays busy stops the managed runtime", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  const result = await cleanupAfterLocalCancellation({
    fetchImpl: slotsFetch(() => true),
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 60,
    pollMs: 15,
    otherTurnsActive: () => false,
  });

  assert.equal(result.reason, "runtime-stopped");
  assert.equal(result.cleaned, true);
  assert.deepEqual(runtime.signals, ["SIGTERM"], "inference never stopped, so it must be stopped");
});

test("C2 a cancelled turn whose inference stops on its own leaves the server up", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  // Generation had begun, then the abort propagated and the slot went idle
  // inside the grace period. Nothing should be killed.
  let busy = true;
  setTimeout(() => {
    busy = false;
  }, 20);
  const result = await cleanupAfterLocalCancellation({
    fetchImpl: slotsFetch(() => busy),
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 400,
    pollMs: 15,
    otherTurnsActive: () => false,
  });

  assert.equal(result.reason, "inference-stopped");
  assert.equal(result.cleaned, false);
  assert.deepEqual(runtime.signals, []);
});

test("C3 an unreachable server is not busy, and nothing is signalled", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();
  const unreachable = async () => {
    throw new Error("ECONNREFUSED");
  };
  const activity = await llamacppSlotActivity({ fetchImpl: unreachable });
  assert.equal(activity.reachable, false);
  assert.equal(activity.busy, false);

  const result = await cleanupAfterLocalCancellation({
    fetchImpl: unreachable,
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 60,
    pollMs: 15,
    otherTurnsActive: () => false,
  });
  assert.equal(result.reason, "inference-stopped");
  assert.deepEqual(runtime.signals, []);
});

test("C5 a busy slot belonging to another live turn is never killed", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  const result = await cleanupAfterLocalCancellation({
    fetchImpl: slotsFetch(() => true),
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 50,
    pollMs: 10,
    otherTurnsActive: () => true,
  });

  assert.equal(result.reason, "another-turn-active");
  assert.equal(result.cleaned, false);
  assert.deepEqual(runtime.signals, [], "kill-the-next-request is a worse bug than the one being fixed");
});

test("C6 repeated cancellation is idempotent and finishes exactly once", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  const options = {
    fetchImpl: slotsFetch(() => true),
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 60,
    pollMs: 15,
    otherTurnsActive: () => false,
  };
  const first = cleanupAfterLocalCancellation(options);
  const second = cleanupAfterLocalCancellation(options);
  assert.equal(first, second, "a second signal joins the first cleanup rather than starting another");
  assert.equal(localRuntimeCleanupInProgress(), true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(runtime.signals, ["SIGTERM"]);
  assert.equal(localRuntimeCleanupInProgress(), false);
  await assert.doesNotReject(() => awaitLocalRuntimeCleanup());
});

test("a new request waits for the teardown instead of racing it", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  const cleanup = cleanupAfterLocalCancellation({
    fetchImpl: slotsFetch(() => true),
    identity: runtime.identity,
    kill: runtime.kill,
    graceMs: 80,
    pollMs: 15,
    otherTurnsActive: () => false,
  });
  let cleanupSettled = false;
  void cleanup.then(() => {
    cleanupSettled = true;
  });

  await awaitLocalRuntimeCleanup();
  assert.equal(cleanupSettled, true, "the barrier returned before the teardown finished");
  assert.equal(localRuntimeCleanupInProgress(), false);
});

test("the idle reaper stops a managed runtime that has nothing to do", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  noteLocalRuntimeIdle({
    fetchImpl: slotsFetch(() => false),
    identity: runtime.identity,
    kill: runtime.kill,
    idleMs: 40,
    otherTurnsActive: () => false,
  });
  await delay(160);

  assert.deepEqual(runtime.signals, ["SIGTERM"]);
});

test("a new local turn cancels the idle countdown by arriving", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  const options = {
    fetchImpl: slotsFetch(() => false),
    identity: runtime.identity,
    kill: runtime.kill,
    otherTurnsActive: () => false,
  };
  noteLocalRuntimeIdle({ ...options, idleMs: 40 });
  await delay(20);
  noteLocalRuntimeIdle({ ...options, idleMs: 5_000 });
  await delay(140);

  assert.deepEqual(runtime.signals, [], "the first countdown survived the arrival of a new turn");
});

test("the idle reaper leaves a busy slot alone", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();

  noteLocalRuntimeIdle({
    fetchImpl: slotsFetch(() => true),
    identity: runtime.identity,
    kill: runtime.kill,
    idleMs: 40,
    otherTurnsActive: () => false,
  });
  await delay(160);

  assert.deepEqual(runtime.signals, []);
});

// The process leaving the process table and the port coming back are two
// different moments, and a restart needs the second one. A real slow start
// produced a retry storm where every attempt bound nothing and died in four
// seconds with "couldn't bind HTTP server socket".
function portFetch({ held }) {
  return async (url) => {
    assert.match(String(url), /\/health$/);
    if (held()) return { ok: true, json: async () => ({ status: "ok" }) };
    throw new Error("ECONNREFUSED");
  };
}

test("the port probe reports free only once the socket stops answering", async () => {
  let held = true;
  setTimeout(() => {
    held = false;
  }, 60);
  const free = await waitForLlamacppPortFree({
    fetchImpl: portFetch({ held: () => held }),
    timeoutMs: 4_000,
    intervalMs: 10,
  });
  assert.equal(free, true);

  const stillHeld = await waitForLlamacppPortFree({
    fetchImpl: portFetch({ held: () => true }),
    timeoutMs: 60,
    intervalMs: 10,
  });
  assert.equal(stillHeld, false, "a held port must never be reported free");
});

test("stopping does not report success until the port is actually free", async () => {
  resetLocalRuntimeLifecycleForTests();
  const runtime = fakeRuntime();
  runtime.seed();
  let held = true;
  // The process leaves the table at SIGTERM, exactly as before; the socket
  // lingers, which is what used to strand the next start.
  setTimeout(() => {
    held = false;
  }, 100);

  const result = await stopManagedLlamacpp({
    identity: runtime.identity,
    kill: runtime.kill,
    fetchImpl: portFetch({ held: () => held }),
    baseUrl: "http://127.0.0.1:9/v1",
    portReleaseTimeoutMs: 4_000,
  });

  assert.equal(result.stopped, true);
  assert.equal(result.portFree, true);
  assert.equal(held, false, "stop returned while the socket was still bound");
});
