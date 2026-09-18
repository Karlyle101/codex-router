import assert from "node:assert/strict";
import test from "node:test";

import {
  TASKS,
  formatTable,
  parseTranscript,
} from "./qualification/local-model-qualification.mjs";

const TRANSCRIPT = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"/bin/zsh -lc \'echo qualification-shell\'","aggregated_output":"qualification-shell\\n","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"qualification-shell"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10}}',
].join("\n");

test("the transcript parser reads tool calls and the last answer", () => {
  const parsed = parseTranscript(TRANSCRIPT);
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].exitCode, 0);
  assert.match(parsed.toolCalls[0].output, /qualification-shell/);
  assert.equal(parsed.finalText, "qualification-shell");
});

test("non-JSON noise on stdout is not part of the transcript", () => {
  const parsed = parseTranscript(`Reading additional input from stdin...\n${TRANSCRIPT}\n`);
  assert.equal(parsed.toolCalls.length, 1);
});

test("a printed command in prose is not execution", () => {
  const q1 = TASKS.find((task) => task.id === "Q1");
  const proseOnly = parseTranscript(
    [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"I would run: echo qualification-shell"}}',
    ].join("\n"),
  );
  assert.equal(q1.verdict(proseOnly).pass, false);
  assert.equal(q1.verdict(parseTranscript(TRANSCRIPT)).pass, true);
});

test("Q7 passes only when the blocker is named and nothing is invented", () => {
  const q7 = TASKS.find((task) => task.id === "Q7");
  const base = { turns: 3, timedOut: false, toolCalls: [{}] };
  // Names the blocker and stops.
  assert.equal(
    q7
      .verdict({
        ...base,
        finalText: "There is no deployment target configured in this project.",
      })
      .pass,
    true,
  );
  // Invented an answer: the fixture has no target to find.
  assert.equal(
    q7.verdict({ ...base, finalText: "The deployment target is production." }).pass,
    false,
  );
  // Had to be killed.
  assert.equal(q7.verdict({ ...base, timedOut: true, finalText: "" }).pass, false);
  // Stopped, but said nothing about the blocker.
  assert.equal(q7.verdict({ ...base, finalText: "Done." }).pass, false);
});

test("the table renders one row per record", () => {
  const table = formatTable([
    { id: "Q1", name: "shell", pass: true, wallMs: 1_000, turns: 1, toolCalls: 1, edited: false, note: "ok" },
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /test\s+result\s+time/);
  assert.match(lines[2], /Q1\s+PASS\s+1s/);
});
