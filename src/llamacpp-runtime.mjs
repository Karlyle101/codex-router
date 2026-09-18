import { spawn as spawnChild, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { processStartIdentity, stateOwnsProcess } from "./process-identity.mjs";
import { readSystemMemory } from "./system-memory.mjs";

// GPT-OSS-20B on llama.cpp is the heaviest thing this router can start: the
// MXFP4 weights are 11.27 GiB and the machine is 16 GB. Everything here exists
// to make sure the operator gets exactly one copy of it, that the copy is
// provably ours before anything signals it, and that the memory is released
// again when it is no longer needed.

export const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_LLAMACPP_MODEL = "gpt-oss-20b";

export const LLAMACPP_RUNTIME_STATE_PATH =
  process.env.MODEL_ROUTER_LLAMACPP_RUNTIME_STATE ||
  path.join(STATE_DIR, "llamacpp-runtime.json");
export const LLAMACPP_LOG_PATH =
  process.env.MODEL_ROUTER_LLAMACPP_LOG || path.join(STATE_DIR, "llamacpp.log");

// The launcher is deliberately outside this repository. It is the operator's
// own script and the single source of truth for the memory flags that make the
// model fit -- `--load-mode none` in particular, without which llama.cpp maps
// the whole 11.3 GiB file into the Metal buffer and dies on the first token.
// Rewriting those flags here would fork the one thing that must not fork.
export const LLAMACPP_LAUNCHER =
  process.env.MODEL_ROUTER_LLAMACPP_LAUNCHER ||
  path.join(
    os.homedir(),
    "Documents",
    "ChatGPT",
    "dev-workspace",
    "local-models",
    "start-gpt-oss.sh",
  );

// Codex's system prompt and tool definitions run about 20K tokens before any
// conversation, and the routed path injects the full app toolset on top, so a
// 16K window is refused before the model sees the turn. The router states the
// window it needs rather than inheriting whatever default the operator's
// launcher happens to carry -- the route's advertised contextWindow and the
// server's real one have to agree or every turn fails at the provider.
export const LLAMACPP_CTX_SIZE = String(
  process.env.MODEL_ROUTER_LLAMACPP_CTX_SIZE || "32768",
);

// Loading 11.27 GiB from disk takes tens of seconds on a warm page cache and
// considerably longer when the machine has been doing other work, so the
// readiness wait is generous. It is a ceiling, not an expectation.
const START_TIMEOUT_MS = Number(process.env.CODEX_ROUTER_LOCAL_START_TIMEOUT_MS) > 0
  ? Number(process.env.CODEX_ROUTER_LOCAL_START_TIMEOUT_MS)
  : 180_000;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_POLL_MS = 250;
// An 11 GiB unload is not a 20-second operation once macOS is short on memory,
// and a stop that escalates to SIGKILL mid-unload is the path the comments
// above warn about. The grace window is therefore generous by default and
// configurable, while SIGKILL stays as the last resort.
const STOP_GRACE_MS = Number(process.env.CODEX_ROUTER_LOCAL_STOP_GRACE_MS) > 0
  ? Number(process.env.CODEX_ROUTER_LOCAL_STOP_GRACE_MS)
  : 60_000;
// "The port answered a moment ago" and "the port is free" are different
// claims. A single ECONNREFUSED is a transient, and the restart that follows
// one used to die on a bind error; quiescence means the socket stayed free.
const PORT_QUIESCENCE_MS = 1_000;
// Releasing the port is not the same event as the process leaving the process
// table. An 11 GiB unload takes real time, and during that window a fresh server
// binds nothing and dies at once with "couldn't bind HTTP server socket". A
// retry storm followed one real slow start: every attempt spawned a server that
// exited in four seconds, and the route stayed down until the port came back.
const PORT_RELEASE_TIMEOUT_MS = 45_000;
const PORT_RELEASE_POLL_MS = 500;

// A cancelled Codex turn used to leave the model generating into the void.
// llama.cpp 0.4.1 has no conversation-id or resumable-stream API to cancel
// inference with, and it does not stop on its own when its HTTP caller
// disappears: one stranded generation was still running 25 minutes after its
// client was gone, holding a single slot and roughly 11 GiB of a 16 GB machine.
// So after a cancellation the router waits out a short grace period and then
// stops the runtime it started. Losing the prompt cache costs one cold start;
// leaving the machine thrashing costs the machine.
const CANCEL_GRACE_MS = Math.max(
  0,
  Number(process.env.CODEX_ROUTER_LOCAL_CANCEL_GRACE_MS ?? 10_000) || 0,
);
const CANCEL_POLL_MS = 1_000;

// How long a managed runtime may sit with nothing to do before it gives the
// memory back. Zero (or a negative value) disables the reaper and leaves the
// model resident until the operator stops it.
const IDLE_STOP_MS = Math.max(
  0,
  Number(process.env.CODEX_ROUTER_LOCAL_IDLE_MS ?? 15 * 60_000) || 0,
);

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function llamacppRootUrl(baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL) {
  return String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function llamacppLauncherPath({ launcher = LLAMACPP_LAUNCHER } = {}) {
  try {
    const stat = statSync(launcher);
    if (!stat.isFile()) return undefined;
    return launcher;
  } catch {
    return undefined;
  }
}

export function llamacppLauncherProblem(launcher = LLAMACPP_LAUNCHER) {
  if (llamacppLauncherPath({ launcher })) return undefined;
  return (
    `The llama.cpp launcher was not found at ${launcher}. ` +
    "Point MODEL_ROUTER_LLAMACPP_LAUNCHER at the script that starts llama-server."
  );
}

// `/health` answers 200 {"status":"ok"} once the weights are resident and 503
// while they are still loading. The difference matters: a 503 means "wait",
// not "broken", and reporting it as broken would make the router start a
// second copy on top of the one that is already loading.
export async function probeLlamacpp({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const root = llamacppRootUrl(baseUrl);
  try {
    const response = await fetchImpl(`${root}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const ready = response.ok && String(body?.status || "").toLowerCase() === "ok";
    return {
      reachable: true,
      ready,
      status: response.status,
      detail: body?.error?.message,
    };
  } catch (error) {
    return { reachable: false, ready: false, error: message(error) };
  }
}

// A second llama.cpp server answering on our port is not our server, and its
// model is very likely not the one this route promises. Read the served id so
// the difference is visible instead of silently routed around.
export async function llamacppServedModels({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const root = llamacppRootUrl(baseUrl);
  try {
    const response = await fetchImpl(`${root}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: true, models: [] };
    const payload = await response.json().catch(() => ({}));
    const data = Array.isArray(payload) ? payload : payload?.data;
    const models = Array.isArray(data)
      ? [...new Set(data.map((item) => String(item?.id || "").trim()).filter(Boolean))]
      : [];
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

export function readLlamacppRuntimeState() {
  try {
    const parsed = JSON.parse(readFileSync(LLAMACPP_RUNTIME_STATE_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function writeLlamacppRuntimeState(value) {
  writePrivateJson(LLAMACPP_RUNTIME_STATE_PATH, value);
  return value;
}

export function clearLlamacppRuntimeState() {
  try {
    unlinkSync(LLAMACPP_RUNTIME_STATE_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function pidAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else; either way
    // it is alive, and "alive but not ours" is resolved by the identity check.
    return error?.code === "EPERM";
  }
}

// The operator's launcher ends in `exec llama-server`, so the interpreter that
// was spawned is replaced by the server under the same pid. The pid therefore
// survives, but the process identity -- start time plus executable name -- does
// not, because the executable changes underneath it. Identity is re-captured
// once the server is ready, and until then a live pid is treated as ours: the
// window is tens of seconds, the state file is private to this user, and
// refusing ownership there would strand 11 GiB with nothing able to stop it.
export function llamacppRuntimeStateOwnsProcess(
  state = readLlamacppRuntimeState(),
  { identity = processStartIdentity, kill = process.kill } = {},
) {
  if (stateOwnsProcess(state, { identity })) return true;
  return Boolean(state?.managed && state.phase === "starting" && pidAlive(state.pid, { kill }));
}

function processResidentBytes(pid, { spawn = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const result = spawn("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const kilobytes = Number(String(result.stdout || "").trim());
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : undefined;
  } catch {
    return undefined;
  }
}

// Stop only the exact server this router started. A healthy llama.cpp on our
// port that carries no matching identity belongs to the operator or to another
// tool, and is deliberately left running.
//
// The process leaving the process table and the port coming back are two
// different moments, and the second one is what a restart actually needs. Every
// path that stops our own server therefore waits for the port to stop answering
// before it reports success; without that, the very next start races the
// unload and dies on a bind error.
export async function waitForLlamacppPortFree({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = PORT_RELEASE_TIMEOUT_MS,
  intervalMs = PORT_RELEASE_POLL_MS,
  stableMs = PORT_QUIESCENCE_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeLlamacpp({ baseUrl, fetchImpl });
    // Any HTTP answer, healthy or not, means somebody still holds the socket.
    if (!probe.reachable) {
      // One refusal can be a transient. Free means it stays free across a
      // second look, which is the claim a restart actually depends on.
      if (stableMs > 0) {
        await wait(stableMs);
        const confirm = await probeLlamacpp({ baseUrl, fetchImpl });
        if (confirm.reachable) continue;
      }
      return true;
    }
    if (Date.now() >= deadline) return false;
    await wait(intervalMs);
  }
}

export async function stopManagedLlamacpp({
  identity = processStartIdentity,
  kill = process.kill,
  timeoutMs = STOP_GRACE_MS,
  intervalMs = STOP_POLL_MS,
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  portReleaseTimeoutMs = PORT_RELEASE_TIMEOUT_MS,
  waitForPort = true,
} = {}) {
  const state = readLlamacppRuntimeState();
  if (!state?.managed) return { stopped: false, reason: "external-or-unmanaged" };
  if (!llamacppRuntimeStateOwnsProcess(state, { identity })) {
    clearLlamacppRuntimeState();
    return { stopped: false, reason: "ownership-lost" };
  }

  try {
    kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      clearLlamacppRuntimeState();
      return { stopped: false, reason: "already-stopped" };
    }
    throw error;
  }

  // llama.cpp releases roughly 11 GiB on the way out; give it real time before
  // escalating, because a SIGKILL mid-unload is the one path that can leave the
  // unified-memory accounting looking wrong until the next boot.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && llamacppRuntimeStateOwnsProcess(state, { identity })) {
    await wait(intervalMs);
  }
  const forced = llamacppRuntimeStateOwnsProcess(state, { identity });
  if (forced) {
    try {
      kill(state.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  clearLlamacppRuntimeState();
  const portFree = waitForPort
    ? await waitForLlamacppPortFree({ baseUrl, fetchImpl, timeoutMs: portReleaseTimeoutMs })
    : true;
  return { stopped: true, pid: state.pid, forced, portFree };
}

function startingStateOwnedByLiveProcess({ identity }) {
  const state = readLlamacppRuntimeState();
  if (!llamacppRuntimeStateOwnsProcess(state, { identity })) return undefined;
  return state;
}

// The cheapest honest answer to "is the model still working?". llama.cpp
// reports `is_processing` per slot, which is the same signal its own callers
// read, and it costs one loopback GET. `busy: undefined` means the server
// answered but the answer was unreadable; callers must treat that as unknown
// rather than as evidence of an idle model.
export async function llamacppSlotActivity({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const root = llamacppRootUrl(baseUrl);
  try {
    const response = await fetchImpl(`${root}/slots`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: true, busy: undefined };
    const payload = await response.json().catch(() => undefined);
    if (!Array.isArray(payload)) return { reachable: true, busy: undefined };
    return { reachable: true, busy: payload.some((slot) => slot?.is_processing === true) };
  } catch {
    // Nothing is listening, so nothing is generating.
    return { reachable: false, busy: false };
  }
}

// Serializes cancellation cleanup against the start path. A request that
// arrives while a teardown is running waits for it rather than racing it into a
// half-dead server, and the ordinary on-demand start then brings up a clean one.
let cancellationCleanup = null;
let idleTimer = null;

export function localRuntimeCleanupInProgress() {
  return cancellationCleanup !== null;
}

export function awaitLocalRuntimeCleanup() {
  return cancellationCleanup ?? Promise.resolve({ cleaned: false, reason: "nothing-to-clean" });
}

// Test seam: the module holds process-wide state, and a suite that imports it
// repeatedly must be able to start from a known place.
export function resetLocalRuntimeLifecycleForTests() {
  cancellationCleanup = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

// `otherTurnsActive` is the one thing this module cannot know on its own: with
// `--parallel 1`, a slot that is busy might be busy with somebody else's turn,
// and stopping the server would kill that turn instead of the stranded one.
export function cleanupAfterLocalCancellation({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  identity = processStartIdentity,
  kill = process.kill,
  graceMs = CANCEL_GRACE_MS,
  pollMs = CANCEL_POLL_MS,
  otherTurnsActive = () => false,
} = {}) {
  if (cancellationCleanup) return cancellationCleanup;

  const startedAt = Date.now();
  const tracked = (async () => {
    let last;
    while (Date.now() - startedAt < graceMs) {
      last = await llamacppSlotActivity({ baseUrl, fetchImpl });
      // A model that stopped by itself needs nothing from us, and neither does
      // a server that is no longer there.
      if (last.busy !== true) {
        return { cleaned: false, reason: "inference-stopped", waitedMs: Date.now() - startedAt };
      }
      await wait(pollMs);
    }
    if (otherTurnsActive()) {
      // The slot is busy with a turn that is still wanted. Stopping the server
      // would be a worse bug than the one being fixed.
      return { cleaned: false, reason: "another-turn-active", waitedMs: Date.now() - startedAt };
    }
    const stopped = await stopManagedLlamacpp({ identity, kill });
    return {
      cleaned: Boolean(stopped.stopped),
      reason: "runtime-stopped",
      waitedMs: Date.now() - startedAt,
      stopped,
    };
  })().finally(() => {
    if (cancellationCleanup === tracked) cancellationCleanup = null;
  });

  cancellationCleanup = tracked;
  return tracked;
}

async function stopIdleLlamacpp({
  baseUrl,
  fetchImpl,
  identity,
  kill,
  otherTurnsActive,
} = {}) {
  // A teardown or a live turn outranks the idle timer; the timer is re-armed by
  // whichever of them finishes last.
  if (cancellationCleanup || otherTurnsActive?.()) return;
  const activity = await llamacppSlotActivity({ baseUrl, fetchImpl });
  if (activity.busy === true) return;
  await stopManagedLlamacpp({ identity, kill });
}

// Re-armed on every local turn boundary, so a new request cancels the
// countdown simply by arriving.
export function noteLocalRuntimeIdle({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  identity = processStartIdentity,
  kill = process.kill,
  idleMs = IDLE_STOP_MS,
  otherTurnsActive = () => false,
} = {}) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!(idleMs > 0)) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stopIdleLlamacpp({ baseUrl, fetchImpl, identity, kill, otherTurnsActive }).catch(() => {
      // A reaper that throws must not take the router down with it; the next
      // turn boundary arms another one.
    });
  }, idleMs);
  idleTimer.unref?.();
}

export function localRuntimeIdleStopMs() {
  return IDLE_STOP_MS;
}

async function waitForLlamacppReady({
  baseUrl,
  fetchImpl,
  timeoutMs,
  intervalMs = 1_000,
  processIdentity,
  pid,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probeLlamacpp({ baseUrl, fetchImpl });
    if (last.ready) return last;
    // A server that has exited will never become ready; failing fast beats
    // holding a Codex turn open for the full three-minute ceiling.
    if (pid && processIdentity && !processIdentity(pid)) {
      return { reachable: false, ready: false, error: "llama-server exited during startup" };
    }
    await wait(intervalMs);
  }
  return last || { reachable: false, ready: false, error: "Timed out waiting for llama.cpp." };
}

// Idempotent start. Safe to call from the CLI, from the tray, and from the
// request path at the same time: the lock plus a re-probe inside it means at
// most one llama-server is ever spawned, and a copy that is merely still
// loading is waited on rather than duplicated.
export async function startManagedLlamacpp({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  spawn = spawnChild,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  launcher = LLAMACPP_LAUNCHER,
  processIdentity = (pid) =>
    processStartIdentity(pid, { spawn: spawnSyncImpl, platform }),
  kill = process.kill,
  timeoutMs = START_TIMEOUT_MS,
  expectedModel = DEFAULT_LLAMACPP_MODEL,
  portReleaseTimeoutMs = PORT_RELEASE_TIMEOUT_MS,
} = {}) {
  const initial = await probeLlamacpp({ baseUrl, fetchImpl });
  if (initial.ready) {
    return { started: false, alreadyRunning: true, ...initial };
  }

  // The start barrier. A teardown still in flight owns this port, and nothing
  // good comes from racing it: that is what produced a storm of servers that
  // bound nothing and exited in four seconds.
  await awaitLocalRuntimeCleanup();

  // Somebody is answering on our port and it is not the process this router
  // started. Either it is our own previous copy still winding down -- in which
  // case wait it out -- or it belongs to somebody else, in which case fail
  // closed and name it. Never signal a process we cannot prove is ours.
  const occupant = await probeLlamacpp({ baseUrl, fetchImpl });
  if (occupant.reachable) {
    const freed = await waitForLlamacppPortFree({
      baseUrl,
      fetchImpl,
      timeoutMs: portReleaseTimeoutMs,
    });
    if (!freed && !startingStateOwnedByLiveProcess({ identity: processIdentity })) {
      const error = new Error(
        `${llamacppRootUrl(baseUrl)} is answering but Codex Router has no managed ` +
          "llama.cpp process that owns it. Refusing to start into a port that " +
          "belongs to another process; stop that server or point " +
          "MODEL_ROUTER_LLAMACPP_BASE_URL at a free port.",
      );
      error.code = "ERR_LLAMACPP_PORT_CONFLICT";
      throw error;
    }
  }

  let spawnedPid;
  let spawnError;

  await withAtomicStateLock(LLAMACPP_RUNTIME_STATE_PATH, () => {
    // Re-probe under the lock: another caller may have finished starting the
    // server while this one was waiting to acquire it.
    const existing = startingStateOwnedByLiveProcess({ identity: processIdentity });
    if (existing) {
      // Already ours and still coming up. Do not start a second copy.
      spawnedPid = existing.pid;
      spawnError = undefined;
      return;
    }

    const problem = llamacppLauncherProblem(launcher);
    if (problem) throw new Error(problem);

    mkdirSync(path.dirname(LLAMACPP_LOG_PATH), { recursive: true, mode: 0o700 });
    const logFd = openSync(LLAMACPP_LOG_PATH, "a", 0o600);
    let child;
    try {
      // `detached` + `unref` so the server outlives the CLI invocation or the
      // router worker that started it; the launcher `exec`s llama-server, so
      // this pid is the server itself and identity checks apply to it directly.
      child = spawn(launcher, [], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        env: {
          ...process.env,
          CTX_SIZE: LLAMACPP_CTX_SIZE,
          PORT: String(new URL(llamacppRootUrl(baseUrl)).port || "8080"),
        },
      });
    } finally {
      closeSync(logFd);
    }
    child?.unref?.();
    spawnedPid = child?.pid;
    if (!spawnedPid) throw new Error("llama.cpp launcher did not report a pid.");

    const identity = processIdentity(spawnedPid);
    if (!identity) {
      try {
        process.kill(spawnedPid, "SIGTERM");
      } catch {
        // Best effort: a launcher that died on its own needs no cleanup.
      }
      throw new Error(
        "llama.cpp started, but Codex Router could not verify ownership of its process.",
      );
    }
    try {
      writeLlamacppRuntimeState({
        version: 1,
        managed: true,
        phase: "starting",
        pid: spawnedPid,
        processIdentity: identity,
        command: launcher,
        baseUrl: llamacppRootUrl(baseUrl),
        startedAt: Date.now(),
        logPath: LLAMACPP_LOG_PATH,
      });
    } catch (error) {
      // An unrecorded server would be indistinguishable from an external one on
      // the next stop, so never leave it behind after a failed start.
      try {
        process.kill(spawnedPid, "SIGTERM");
      } catch {
        // Best effort.
      }
      throw error;
    }
  });

  const ready = await waitForLlamacppReady({
    baseUrl,
    fetchImpl,
    timeoutMs,
    processIdentity,
    pid: spawnedPid,
  });
  if (!ready.ready) {
    // Give up on this attempt, but leave the port actually free: a retry that
    // arrives while the failed server is still unholding 8080 would die on a
    // bind error and look like a second, unrelated failure.
    await stopManagedLlamacpp({
      identity: processIdentity,
      kill,
      baseUrl,
      fetchImpl,
    }).catch(() => {
      // A stop that cannot even find its own state still has to report the
      // original startup failure.
      clearLlamacppRuntimeState();
    });
    throw new Error(
      `llama.cpp was started but never became healthy${ready.error ? `: ${ready.error}` : "."} ` +
        `Logs: ${LLAMACPP_LOG_PATH}`,
    );
  }

  if (expectedModel) {
    const served = await llamacppServedModels({ baseUrl, fetchImpl });
    if (served.models.length > 0 && !served.models.includes(expectedModel)) {
      throw new Error(
        `llama.cpp is healthy but serves ${served.models.join(", ")} rather than ` +
          `${expectedModel}. Refusing to advertise the route under the wrong model.`,
      );
    }
  }

  const state = readLlamacppRuntimeState();
  if (state?.managed && state.pid === spawnedPid) {
    // Re-capture now that the launcher has exec'd into llama-server and the
    // executable name has stopped moving.
    const settled = processIdentity(spawnedPid);
    writeLlamacppRuntimeState({
      ...state,
      phase: "ready",
      processIdentity: settled || state.processIdentity,
      readyAt: Date.now(),
    });
  }
  return { started: true, alreadyRunning: false, pid: spawnedPid, ...ready };
}

export async function llamacppStatus({
  baseUrl = process.env.MODEL_ROUTER_LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
  fetchImpl = fetch,
  identity = processStartIdentity,
  spawn = spawnSync,
  expectedModel = DEFAULT_LLAMACPP_MODEL,
} = {}) {
  const probe = await probeLlamacpp({ baseUrl, fetchImpl });
  const state = readLlamacppRuntimeState();
  const owned = llamacppRuntimeStateOwnsProcess(state, { identity });
  if (state && !owned) clearLlamacppRuntimeState();

  let served;
  if (probe.ready) served = await llamacppServedModels({ baseUrl, fetchImpl });
  const activity = probe.ready ? await llamacppSlotActivity({ baseUrl, fetchImpl }) : undefined;
  const systemMemory = readSystemMemory();
  const mismatched =
    Boolean(probe.ready && expectedModel && served?.models?.length) &&
    !served.models.includes(expectedModel);

  let stateName;
  if (probe.ready) stateName = mismatched ? "wrong-model" : "healthy";
  else if (owned && state?.phase === "starting") stateName = "starting";
  else if (owned) stateName = "unhealthy";
  else if (probe.reachable) stateName = "unhealthy";
  else stateName = "stopped";

  return {
    state: stateName,
    running: probe.ready,
    managed: owned,
    reachable: probe.reachable,
    ready: probe.ready,
    httpStatus: probe.status,
    detail: probe.detail,
    error: probe.error,
    pid: owned ? state.pid : undefined,
    endpoint: `${llamacppRootUrl(baseUrl)}/v1`,
    baseUrl: llamacppRootUrl(baseUrl),
    model: expectedModel,
    servedModels: served?.models,
    // Whether the one slot is actually generating. This is the reading that
    // explains a machine that feels busy while `local-llamacpp status` says
    // healthy, and the reading a cancelled turn should have left false.
    activeInference: activity?.busy,
    cleanupInProgress: localRuntimeCleanupInProgress(),
    idleStopMs: localRuntimeIdleStopMs(),
    stopGraceMs: STOP_GRACE_MS,
    // What the machine has left, so "why is this slow" has an answer that is
    // not a guess. Advisory only: nothing refuses to run because of it.
    system: systemMemory,
    uptimeMs: owned && state?.startedAt ? Date.now() - state.startedAt : undefined,
    // Deliberately named for what it is. This is the server process's resident
    // set, and llama.cpp's Metal buffers are not all counted in it, so the
    // unified memory the model actually holds is higher -- about 10.8 GiB of
    // model buffer at load on this machine. Treat this as a floor, not a budget.
    residentBytes: owned ? processResidentBytes(state.pid, { spawn }) : undefined,
    logPath: LLAMACPP_LOG_PATH,
    launcher: LLAMACPP_LAUNCHER,
  };
}
