import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ResponsesHeartbeatTransform } from "../src/responses-heartbeat.mjs";

const CREATED =
  'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":' +
  '{"id":"resp_1","object":"response","created_at":1700000000,"model":"grok-4.6","status":"in_progress",' +
  '"instructions":"private-instructions-marker","tools":[{"type":"function","name":"read_file"}],"output":[]}}\n\n';
const REASONING =
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n';
const COMPLETED =
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n';
const HEARTBEAT_BLOCK = /event: response\.in_progress\ndata: [^\n]*\n\n/g;

function collect(transform) {
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")));
  return () => chunks.join("");
}

function heartbeats(text) {
  return [...text.matchAll(HEARTBEAT_BLOCK)].map((match) =>
    JSON.parse(match[0].slice(match[0].indexOf("data: ") + 6)),
  );
}

test("a silent announced stream relays identity-only heartbeats and leaves every byte intact", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 40 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED);
  heartbeat.write(REASONING);
  await delay(170);
  const beats = heartbeats(read());
  assert.ok(beats.length >= 2, read());
  assert.deepEqual(beats[0], {
    type: "response.in_progress",
    response: {
      id: "resp_1",
      object: "response",
      created_at: 1700000000,
      model: "grok-4.6",
      status: "in_progress",
      output: [],
    },
  });
  assert.doesNotMatch(JSON.stringify(beats), /private-instructions-marker|read_file|thinking/);
  heartbeat.end(COMPLETED);
  await new Promise((resolve) => heartbeat.once("end", resolve));
  const settled = read();
  assert.equal(settled.replace(HEARTBEAT_BLOCK, ""), CREATED + REASONING + COMPLETED);
  await delay(120);
  assert.equal(read(), settled, "no heartbeat after the stream ends");
});

test("no heartbeat before the client has seen response.created", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  heartbeat.write(REASONING);
  await delay(140);
  assert.equal(read(), REASONING);
  heartbeat.destroy();
});

test("no heartbeat is spliced into a partially relayed event", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  const partialEvent = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",';
  heartbeat.write(CREATED);
  await delay(80);
  const beforePartial = heartbeats(read()).length;
  assert.ok(beforePartial >= 1);
  heartbeat.write(partialEvent);
  await delay(140);
  assert.equal(heartbeats(read()).length, beforePartial, "a heartbeat interrupted a partial event");
  heartbeat.write('"delta":"hi"}\n\n');
  await delay(80);
  const text = read();
  assert.ok(heartbeats(text).length > beforePartial, "heartbeats resume at the next boundary");
  assert.ok(text.includes(`${partialEvent}"delta":"hi"}\n\n`), "the split event reached the client whole");
  heartbeat.destroy();
});

test("any terminal event, typed or untyped, stops the heartbeat", async () => {
  for (const terminal of [
    COMPLETED,
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1"}}\n\n',
    'data: {"type":"error","error":{"message":"refused"}}\n\n',
    'data: {"type":"response.incomplete","response":{"id":"resp_1"}}\n\n',
    "data: [DONE]\n\n",
  ]) {
    const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
    const read = collect(heartbeat);
    heartbeat.write(CREATED);
    heartbeat.write(terminal);
    await delay(120);
    assert.equal(read(), CREATED + terminal, terminal);
    heartbeat.destroy();
  }
});

test("a terminal too large to parse still stops the heartbeat", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  const oversized = `data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"${"x".repeat(4 * 1024 * 1024 + 16)}"}]}]}}\n\n`;
  heartbeat.write(CREATED);
  heartbeat.write(oversized);
  await delay(150);
  assert.equal(heartbeats(read()).length, 0, "a heartbeat followed an oversized terminal");
  heartbeat.destroy();
});

test("an active stream never receives a heartbeat", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 80 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED);
  for (let i = 0; i < 8; i += 1) {
    await delay(20);
    heartbeat.write(REASONING);
  }
  assert.equal(heartbeats(read()).length, 0);
  heartbeat.destroy();
});

test("CRLF-framed streams are recognized at their boundaries", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED.replaceAll("\n", "\r\n"));
  await delay(100);
  assert.ok(heartbeats(read()).length >= 1, read());
  heartbeat.destroy();
});

// The local route is the only one whose silence precedes its first event: a
// cold GPT-OSS-20B prefill reads the whole prompt before llama.cpp can emit
// `response.created`, so there is no identity to repeat and the identity-only
// heartbeat has nothing to send. It relays a bare transport-liveness event
// instead, and stops doing so the moment a real identity exists.
const KEEPALIVE_BLOCK = /event: codex\.router\.keepalive\ndata: [^\n]*\n\n/g;

function keepalives(text) {
  return [...text.matchAll(KEEPALIVE_BLOCK)].map((match) =>
    JSON.parse(match[0].slice(match[0].indexOf("data: ") + 6)),
  );
}

function localHeartbeat(intervalMs) {
  return new ResponsesHeartbeatTransform({
    intervalMs,
    preIdentityEventType: "codex.router.keepalive",
  });
}

test("a local stream that has emitted nothing yet still relays liveness", async () => {
  const heartbeat = localHeartbeat(40);
  const read = collect(heartbeat);
  // No upstream byte arrives at all: this is the cold-prefill window, and the
  // timer has to have been armed without a chunk to arm it.
  await delay(150);
  const beats = keepalives(read());
  assert.ok(beats.length >= 2, read());
  heartbeat.destroy();
});

test("the pre-identity event carries no fabricated response identity", async () => {
  const heartbeat = localHeartbeat(30);
  const read = collect(heartbeat);
  await delay(110);
  const beats = keepalives(read());
  assert.ok(beats.length >= 1, read());
  assert.deepEqual(beats[0], { type: "codex.router.keepalive" });
  const serialized = JSON.stringify(beats);
  for (const invented of ["\"response\"", "\"id\"", "\"usage\"", "\"output\"", "resp_"]) {
    assert.equal(serialized.includes(invented), false, `${invented} was fabricated: ${serialized}`);
  }
  heartbeat.destroy();
});

test("the real response follows the pre-identity keepalives unchanged", async () => {
  const heartbeat = localHeartbeat(40);
  const read = collect(heartbeat);
  await delay(110);
  assert.ok(keepalives(read()).length >= 1, read());
  heartbeat.write(CREATED);
  heartbeat.write(REASONING);
  heartbeat.end(COMPLETED);
  await new Promise((resolve) => heartbeat.once("end", resolve));
  const text = read();
  assert.equal(
    text.replace(KEEPALIVE_BLOCK, "").replace(HEARTBEAT_BLOCK, ""),
    CREATED + REASONING + COMPLETED,
  );
});

test("a route that did not opt in stays silent through the same silence", async () => {
  // Same empty stream as the local case above; the only difference is the
  // absent opt-in. Hosted routes must gain no new bytes on the wire.
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  await delay(140);
  assert.equal(read(), "");
  heartbeat.destroy();
});

test("once an identity exists the transport event gives way to the identity heartbeat", async () => {
  const heartbeat = localHeartbeat(40);
  const read = collect(heartbeat);
  await delay(110);
  assert.ok(keepalives(read()).length >= 1, read());
  heartbeat.write(CREATED);
  await delay(140);
  const text = read();
  assert.ok(heartbeats(text).length >= 1, "expected an identity-only heartbeat after response.created");
  const afterCreated = text.slice(text.indexOf(CREATED) + CREATED.length);
  assert.equal(keepalives(afterCreated).length, 0, "the transport event must stop once identity exists");
  heartbeat.destroy();
});

test("a pre-identity keepalive is never spliced into a partially relayed event", async () => {
  const heartbeat = localHeartbeat(30);
  const read = collect(heartbeat);
  heartbeat.write('event: response.created\ndata: {"type":"response.created","response":');
  await delay(120);
  assert.equal(keepalives(read()).length, 0, "a keepalive interrupted a partial first event");
  heartbeat.write('{"id":"resp_1"}}\n\n');
  await delay(110);
  const text = read();
  assert.ok(
    keepalives(text).length + heartbeats(text).length >= 1,
    "liveness resumes at the next event boundary",
  );
  heartbeat.destroy();
});

test("the pre-identity timer stops when the stream ends", async () => {
  const heartbeat = localHeartbeat(30);
  const read = collect(heartbeat);
  await delay(70);
  assert.ok(keepalives(read()).length >= 1, read());
  heartbeat.end(COMPLETED);
  await new Promise((resolve) => heartbeat.once("end", resolve));
  const settled = read();
  await delay(140);
  assert.equal(read(), settled, "a keepalive fired after the stream ended");
});

test("the pre-identity timer stops when the stream is destroyed", async () => {
  const heartbeat = localHeartbeat(30);
  const read = collect(heartbeat);
  heartbeat.on("error", () => {});
  await delay(70);
  assert.ok(keepalives(read()).length >= 1, read());
  heartbeat.destroy(new Error("upstream failed"));
  const settled = read();
  await delay(160);
  assert.equal(read(), settled, "a keepalive fired after the stream was destroyed");
});
