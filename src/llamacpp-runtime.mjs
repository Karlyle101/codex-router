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
const START_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_TIMEOUT_MS = 20_000;
const STOP_POLL_MS = 250;

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
export async function stopManagedLlamacpp({
  identity = processStartIdentity,
  kill = process.kill,
  timeoutMs = STOP_TIMEOUT_MS,
  intervalMs = STOP_POLL_MS,
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
  return { stopped: true, pid: state.pid, forced };
}

function startingStateOwnedByLiveProcess({ identity }) {
  const state = readLlamacppRuntimeState();
  if (!llamacppRuntimeStateOwnsProcess(state, { identity })) return undefined;
  return state;
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
  timeoutMs = START_TIMEOUT_MS,
  expectedModel = DEFAULT_LLAMACPP_MODEL,
} = {}) {
  const initial = await probeLlamacpp({ baseUrl, fetchImpl });
  if (initial.ready) {
    return { started: false, alreadyRunning: true, ...initial };
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
    const state = readLlamacppRuntimeState();
    if (llamacppRuntimeStateOwnsProcess(state, { identity: processIdentity })) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Best effort.
      }
    }
    clearLlamacppRuntimeState();
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
