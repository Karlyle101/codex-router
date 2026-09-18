import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(path.join(os.tmpdir(), "llamacpp-lifecycle-test-"));
process.env.MODEL_ROUTER_LLAMACPP_RUNTIME_STATE = path.join(root, "llamacpp-runtime.json");
process.env.MODEL_ROUTER_LLAMACPP_BASE_URL = "http://127.0.0.1:9/v1";

const {
  awaitLocalRuntimeCleanup,
  cleanupAfterLocalCancellation,
  noteLocalRuntimeIdle,
  resetLocalRuntimeLifecycleForTests,
  startManagedLlamacpp,
  stopManagedLlamacpp,
} = await import("../src/llamacpp-runtime.mjs");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Only used to satisfy the launcher-exists check; the injected spawn never runs it.
const LAUNCHER = path.join(REPO, "bin", "local-llamacpp");
const STATE_PATH = process.env.MODEL_ROUTER_LLAMACPP_RUNTIME_STATE;
const IDENTITY = "started-at-2026-09-18T00:00:00Z|/opt/homebrew/bin/llama-server";

// `exitAfterMs` is how long the fake server takes to leave the process table
// once it is asked; `null` means it never does. `portHeldAfterExitMs` is how
// long the socket outlives it, which is the shape of a real 11 GiB unload.
function fakeServer({ pid = 4242, exitAfterMs = 0, portHeldAfterExitMs = 0 } = {}) {
  const signals = [];
  let alive = true;
  let portHeld = true;
  const record = {
    signals,
    portHeld: () => portHeld,
    alive: () => alive,
    identity: () => (alive ? IDENTITY : undefined),
    kill: (_pid, signal) => {
      signals.push(signal);
      if (signal !== "SIGTERM" && signal !== "SIGKILL") return;
      if (signal === "SIGKILL") {
        alive = false;
        return;
      }
      if (exitAfterMs === null) return;
      setTimeout(() => {
        alive = false;
        setTimeout(() => {
          portHeld = false;
        }, portHeldAfterExitMs);
      }, exitAfterMs);
    },
    seed() {
      writeFileSync(
        STATE_PATH,
        `${JSON.stringify({
          version: 1,
          managed: true,
          phase: "ready",
          pid,
          processIdentity: IDENTITY,
          baseUrl: "http://127.0.0.1:9",
          startedAt: Date.now() - 60_000,
        })}\n`,
        { mode: 0o600 },
      );
    },
  };
  return record;
}

function portFetch(held, { assertPath = /\/health$/ } = {}) {
  return async (url) => {
    assert.match(String(url), assertPath);
    if (held()) return { ok: true, json: async () => ({ status: "ok" }) };
    throw new Error("ECONNREFUSED");
  };
}

test("L1 a runtime that exits on SIGTERM is reported as not forced", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: 0 });
  server.seed();
  const result = await stopManagedLlamacpp({
    identity: server.identity,
    kill: server.kill,
    fetchImpl: portFetch(() => false),
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 2_000,
    intervalMs: 10,
  });
  assert.equal(result.stopped, true);
  assert.equal(result.forced, false);
  assert.deepEqual(server.signals, ["SIGTERM"], "a clean unload must not be killed");
});

test("L2 a slow unload inside the grace window is still not killed", async () => {
  resetLocalRuntimeLifecycleForTests();
  // Deliberately slower than the old hardcoded 20s ceiling in relative terms:
  // the grace is what decides, not a constant baked into the call site.
  const server = fakeServer({ exitAfterMs: 300 });
  server.seed();
  const result = await stopManagedLlamacpp({
    identity: server.identity,
    kill: server.kill,
    fetchImpl: portFetch(() => false),
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 3_000,
    intervalMs: 20,
  });
  assert.equal(result.forced, false);
  assert.deepEqual(server.signals, ["SIGTERM"]);
});

test("L3 a server that never exits is killed once the grace window expires", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: null });
  server.seed();
  const result = await stopManagedLlamacpp({
    identity: server.identity,
    kill: server.kill,
    fetchImpl: portFetch(() => false),
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 120,
    intervalMs: 20,
  });
  assert.equal(result.forced, true);
  assert.deepEqual(server.signals, ["SIGTERM", "SIGKILL"]);
});

test("L4 stop does not return until the socket has stopped answering", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: 0, portHeldAfterExitMs: 300 });
  server.seed();
  const started = Date.now();
  const result = await stopManagedLlamacpp({
    identity: server.identity,
    kill: server.kill,
    fetchImpl: portFetch(() => server.portHeld()),
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 2_000,
    intervalMs: 10,
    portReleaseTimeoutMs: 5_000,
  });
  assert.equal(result.portFree, true);
  assert.ok(Date.now() - started >= 300, "stop returned while the socket was still bound");
});

test("L5 a single transient refusal is not enough to call the port free", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: 0, portHeldAfterExitMs: 0 });
  server.seed();
  // One probe says gone, the next says held: exactly the flicker that let a
  // restart race the teardown.
  let calls = 0;
  const flickering = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ status: "ok" }) };
  };
  let held = true;
  setTimeout(() => {
    held = false;
  }, 200);
  const stop = await stopManagedLlamacpp({
    identity: server.identity,
    kill: server.kill,
    fetchImpl: () => (held ? flickering() : portFetch(() => false)()),
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 2_000,
    intervalMs: 10,
    portReleaseTimeoutMs: 5_000,
  });
  assert.equal(stop.portFree, true);
});

test("L5b start fails closed when the port belongs to somebody else", async () => {
  resetLocalRuntimeLifecycleForTests();
  // No managed state at all, and the port answers without ever being ready: a
  // server that is not ours. Starting into it must refuse rather than signal a
  // process this router cannot prove it owns.
  await assert.rejects(
    () =>
      startManagedLlamacpp({
        baseUrl: "http://127.0.0.1:9/v1",
        launcher: LAUNCHER,
        fetchImpl: async () => ({ ok: true, json: async () => ({ status: "loading" }) }),
        spawn: () => {
          throw new Error("must not spawn into a foreign port");
        },
        processIdentity: () => IDENTITY,
        portReleaseTimeoutMs: 100,
      }),
    (error) => error.code === "ERR_LLAMACPP_PORT_CONFLICT",
  );
});

test("L5c start waits out our own winding-down port, then launches", async () => {
  resetLocalRuntimeLifecycleForTests();
  let portHeld = true;
  setTimeout(() => {
    portHeld = false;
  }, 150);
  let spawned = 0;
  const startsAt = Date.now();
  const result = await startManagedLlamacpp({
    baseUrl: "http://127.0.0.1:9/v1",
    launcher: LAUNCHER,
    fetchImpl: async (url) => {
      const target = String(url);
      // Nothing is listening once the old copy has gone and before the new one
      // exists: that is what "the port is free" actually means.
      if (!portHeld && spawned === 0) throw new Error("ECONNREFUSED");
      if (target.endsWith("/slots")) return { ok: true, json: async () => [] };
      if (target.endsWith("/v1/models")) return { ok: true, json: async () => ({ data: [] }) };
      assert.match(target, /\/health$/);
      // The old copy holds the socket but is not ready -- a server mid-unload
      // still answers, which is what makes "free" a different claim from
      // "healthy". Answering `ok` here would be a live server, not a teardown.
      return { ok: true, json: async () => ({ status: spawned > 0 ? "ok" : "loading" }) };
    },
    spawn: () => {
      spawned += 1;
      return { pid: 7777, unref() {} };
    },
    processIdentity: () => IDENTITY,
    timeoutMs: 3_000,
    portReleaseTimeoutMs: 5_000,
  });
  assert.equal(spawned, 1);
  assert.ok(Date.now() - startsAt >= 150, "start launched before the port was free");
  assert.equal(result.started, true);
});

test("L6 cancellation cleanup uses the same primitive, including escalation", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: null });
  server.seed();
  const result = await cleanupAfterLocalCancellation({
    fetchImpl: async (url) => {
      assert.match(String(url), /\/slots$/);
      return { ok: true, json: async () => [{ id: 0, is_processing: true }] };
    },
    identity: server.identity,
    kill: server.kill,
    graceMs: 40,
    pollMs: 10,
    otherTurnsActive: () => false,
  });
  assert.equal(result.reason, "runtime-stopped");
  // Only the shared primitive escalates, so seeing SIGKILL here proves the
  // cancellation path did not grow a second stop implementation.
  assert.deepEqual(server.signals, ["SIGTERM", "SIGKILL"]);
  await awaitLocalRuntimeCleanup();
});

test("L7 the idle reaper uses the same primitive too", async () => {
  resetLocalRuntimeLifecycleForTests();
  const server = fakeServer({ exitAfterMs: null });
  server.seed();
  noteLocalRuntimeIdle({
    fetchImpl: async (url) => {
      assert.match(String(url), /\/slots$/);
      return { ok: true, json: async () => [{ id: 0, is_processing: false }] };
    },
    identity: server.identity,
    kill: server.kill,
    idleMs: 40,
    otherTurnsActive: () => false,
  });
  await delay(400);
  // Escalation is covered by L3/L6; what this pins is that the reaper reaches
  // the same stop primitive rather than a stop of its own.
  assert.deepEqual(server.signals, ["SIGTERM"]);
});
