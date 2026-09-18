import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

// Importing the registry validates every shipped fragment and gives the test
// the same merged view the router serves from.
const { MODEL_BY_SLUG, RUNTIME_PROVIDERS } = await import("../src/model-registry.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

// How long the fake local server stays silent before its first real byte, and
// how often the router is allowed to relay liveness during that silence. The
// silence is deliberately several heartbeat intervals long, because the whole
// point is that the client is still sent *something* while the model reads its
// prompt.
const SILENCE_MS = 1_200;
const HEARTBEAT_MS = 200;

// The router hands a routed turn to the LiteLLM gateway already in Responses
// shape and lets the gateway do the chat translation, so the fake upstream
// answers `/v1/responses` too.
const RESPONSES_SSE = [
  'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r-local","object":"response","model":"llamacpp-gpt-oss-20b","status":"in_progress","output":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"hello-from-local"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"id":"r-local","output":[]}}\n\n',
].join("");

// Stands in for llama-server: healthy before the turn, then a silent prefill,
// then a chat-completions stream the router's bridge turns back into Responses
// events. `/v1/models` answers with the served id so the runtime's identity
// check has something to compare against.
function localServer({ splitAfterBytes, seen } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      seen?.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/v1/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-oss-20b" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url.startsWith("/v1/responses")) {
        response.writeHead(404).end();
        return;
      }
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        response.flushHeaders?.();
        const timer = setTimeout(() => {
          if (splitAfterBytes === undefined) response.end(RESPONSES_SSE);
          else {
            response.write(RESPONSES_SSE.slice(0, splitAfterBytes));
            setTimeout(() => response.end(RESPONSES_SSE.slice(splitAfterBytes)), 60);
          }
        }, SILENCE_MS);
        response.on("close", () => clearTimeout(timer));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function run(env) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-keepalive-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_LOCAL_HEARTBEAT_MS: String(HEARTBEAT_MS),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function waitForModels(port, child) {
  const deadline = Date.now() + 10_000;
  const url = `${callerBaseUrl(port, CALLER_KEY)}/models`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`router exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`router never answered ${url}: ${child.testErrors()}`);
}

// Records when each piece of the response body reached us, so the assertions
// can talk about the silence window rather than just the final bytes.
function readRouted(port, body) {
  const url = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push({ at: Date.now() - started, text: chunk }));
        const done = () =>
          resolve({ status: response.statusCode, chunks, text: chunks.map((c) => c.text).join("") });
        response.once("end", done);
        response.once("error", done);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function offsetOf(text, needle) {
  return text.indexOf(needle);
}

test("a local route relays liveness while its model is still reading the prompt", async () => {
  // The published catalog is written by a separate publish step, so it is
  // empty in a fresh state dir and says nothing about this route. What has to
  // hold is that the shipped registry carries the provider and the model with
  // honest metadata, and that the route actually serves a turn.
  const model = MODEL_BY_SLUG.get("llamacpp/gpt-oss-20b");
  assert.ok(model, "the local model must be in the shipped registry");
  assert.equal(model.provider, "llamacpp");
  assert.equal(model.listed, true);
  assert.equal(model.contextWindow, 32768);
  assert.ok(RUNTIME_PROVIDERS.has("llamacpp"), "the local provider must be registered");

  const seen = [];
  const local = await localServer({ seen });
  const routerPort = await openPort();
  const health = `http://127.0.0.1:${local.port}/health`;
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    // The router lowers a Responses turn to chat-completions and hands it to
    // the gateway; pointing that at the same mock keeps the whole request
    // inside this test while leaving the router's own stages untouched.
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${local.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_API_HEALTH_URL: health,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: health,
    MODEL_ROUTER_LLAMACPP_BASE_URL: `http://127.0.0.1:${local.port}/v1`,
  });
  try {
    await waitForModels(routerPort, router);

    const result = await readRouted(routerPort, {
      model: "llamacpp/gpt-oss-20b",
      input: "hello",
      stream: true,
    });
    assert.equal(
      result.status,
      200,
      `router said ${result.status}: ${result.text.slice(0, 300)}; upstream saw ${(seen ?? []).join(", ")}; ${router.testErrors()}`,
    );

    const keepalives = [...result.text.matchAll(/event: codex\.router\.keepalive\n/g)];
    assert.ok(
      keepalives.length >= 2,
      `expected liveness during the silent prefill, saw ${keepalives.length}: ${result.text.slice(0, 400)}`,
    );

    const created = offsetOf(result.text, "event: response.created");
    assert.ok(created >= 0, `no response.created in: ${result.text.slice(0, 400)}`);
    assert.ok(
      keepalives.every((match) => match.index < created),
      "every pre-identity keepalive must precede the first real response event",
    );

    // The client has to see them *during* the silence, not flushed at the end,
    // or the idle timer they exist to reset would already have expired.
    const firstKeepalive = result.chunks.find((chunk) =>
      chunk.text.includes("event: codex.router.keepalive"),
    );
    assert.ok(firstKeepalive, "no keepalive reached the client");
    assert.ok(
      firstKeepalive.at < SILENCE_MS,
      `the first keepalive arrived at ${firstKeepalive.at}ms, after the ${SILENCE_MS}ms silence`,
    );

    // The real turn still completes normally behind the liveness traffic.
    assert.match(result.text, /hello-from-local/);
    assert.match(result.text, /event: response\.completed/);
  } finally {
    await stopChild(router);
    await new Promise((resolve) => local.server.close(resolve));
  }
});

test("the local route's upstream hop honours its own idle bound", async () => {
  // The client-side keepalive cannot save a turn whose socket the router
  // already dropped. This pins the wiring: the local route's upstream fetch
  // uses the long-idle pool, so lowering that bound lowers the point at which
  // the router abandons a silent upstream. Without the wiring, the shared
  // pool's 300s default would outlast this 1.5s silence and the turn would
  // simply succeed, so a fast failure here is the proof.
  const BOUND_MS = 500;
  const local = await localServer({ seen: [] });
  const routerPort = await openPort();
  const health = `http://127.0.0.1:${local.port}/health`;
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${local.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_API_HEALTH_URL: health,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: health,
    MODEL_ROUTER_LLAMACPP_BASE_URL: `http://127.0.0.1:${local.port}/v1`,
    CODEX_ROUTER_LOCAL_TRANSPORT_IDLE_MS: String(BOUND_MS),
  });
  try {
    await waitForModels(routerPort, router);
    const started = Date.now();
    const result = await readRouted(routerPort, {
      model: "llamacpp/gpt-oss-20b",
      input: "hello",
      stream: true,
    });
    const elapsed = Date.now() - started;
    // The keepalives have already flushed the response head by the time the
    // bound expires, so the turn ends as a streamed error rather than a
    // different status code.
    assert.match(
      result.text,
      /local_router_stream_failed/,
      `expected the bound to end the turn: ${result.text.slice(0, 300)}`,
    );
    assert.ok(
      // Generous on purpose: the assertion above is what proves the wiring
      // (an unwired route would have delivered real content here). This only
      // rules out a machine that took the shared 300s default instead.
      elapsed < 60_000,
      `the router held the turn for ${elapsed}ms despite a ${BOUND_MS}ms bound`,
    );
  } finally {
    await stopChild(router);
    await new Promise((resolve) => local.server.close(resolve));
  }
});

test("a hosted route gains no liveness traffic from the same silence", async () => {
  // The same silence that the local route keeps alive. A hosted route is
  // expected to send nothing extra: the pre-identity event is opt-in per route,
  // and this is the regression guard for that.
  const gateway = await new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.flushHeaders?.();
        setTimeout(() => {
          response.end(
            [
              'event: response.created\ndata: {"type":"response.created","response":{"id":"r-hosted"}}\n\n',
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hosted"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r-hosted","output":[]}}\n\n',
            ].join(""),
          );
        }, SILENCE_MS);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

  const routerPort = await openPort();
  const health = `http://127.0.0.1:${gateway.port}/health`;
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    // DeepSeek's route bypasses LiteLLM and goes straight to the shared API
    // forwarder, so that leg has to be redirected too or the test would reach
    // the operator's real forwarder.
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_API_HEALTH_URL: health,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: health,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: health,
  });
  try {
    await waitForModels(routerPort, router);
    const result = await readRouted(routerPort, {
      model: "deepseek/deepseek-v4.1-flash",
      input: "hello",
      stream: true,
    });
    assert.equal(
      result.status,
      200,
      `router said ${result.status}: ${result.text.slice(0, 300)}; ${router.testErrors()}`,
    );
    assert.equal(
      result.text.includes("codex.router.keepalive"),
      false,
      `a hosted route must not receive local liveness traffic: ${result.text.slice(0, 400)}`,
    );
    assert.match(result.text, /event: response\.created/);
  } finally {
    await stopChild(router);
    await new Promise((resolve) => gateway.server.close(resolve));
  }
});
