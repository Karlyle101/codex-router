// Deterministic qualification for the local GPT-OSS-20B route.
//
// The point is to characterise what work is reasonable to hand this model, not
// to make it look good. Every fixture is a throwaway directory under the system
// temp dir; nothing here touches a real project. Verdicts are decided from the
// transcript and, where a task claims to have produced something, from the file
// system afterwards -- never from the model's own summary of what it did.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { readSystemMemory } from "../../src/system-memory.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A run only means something if the machine could have run it. This is the
// distinction the previous attempt got wrong: eleven minutes of swap-thrash
// while the model was still loading was recorded as a model failure.
export const ENVIRONMENT_FAILURE_EXIT = 2;

// The agreed bound: past the initial warm-up a task that has not made
// meaningful progress by here is recorded as a failure rather than allowed to
// grind. Chosen because a warm local turn is about a minute and a cold one
// about four.
export const DEFAULT_TIMEOUT_MS = 8 * 60_000;
export const DEFAULT_MAX_TURNS = 12;

export const TASKS = [
  {
    id: "Q1",
    name: "shell dispatch",
    fixture: {},
    prompt:
      "Execute this exact shell command using the shell tool:\n\n" +
      "echo qualification-shell\n\nThen report the output.",
    // A printed command in prose is not execution, so the transcript has to
    // contain a completed command node whose own recorded output matches.
    verdict: ({ events, toolCalls }) => {
      const ran = toolCalls.some(
        (call) =>
          call.exitCode === 0 &&
          /echo qualification-shell/.test(call.command || "") &&
          /qualification-shell/.test(call.output || ""),
      );
      return { pass: ran, note: ran ? "shell tool executed" : "no completed echo execution" };
    },
  },
  {
    id: "Q2",
    name: "inspect and read",
    fixture: {
      "README.md": "# Fixture\n\nA repository used to test file inspection.\n",
      "src/config.ts":
        "export const region = \"us-west\";\nexport const retryBudget = 7;\n",
      "notes.txt": "scratch notes; nothing authoritative lives here\n",
    },
    prompt:
      "Inspect this repository, including any subdirectories, and report the exact " +
      "numeric value of the configured retry budget.",
    verdict: ({ toolCalls, finalText }) => {
      // The value only exists in src/config.ts. It cannot be inferred from the
      // other two files, so finding it requires actually walking the tree.
      // The command arrives shell-quoted (`/bin/zsh -lc 'ls -R . | head'`), so
      // the boundary before a command name is a quote at least as often as it
      // is a space. Requiring whitespace there misread a correct run as a model
      // failure.
      const inspected = toolCalls.some((call) =>
        /(?:^|[\s'"|;&(])(?:ls|find|rg|grep|cat|sed|tree)(?=\s|$)/.test(
          call.command || "",
        ),
      );
      const readConfig = toolCalls.some(
        (call) =>
          /config\.ts/.test(call.command || "") && /retryBudget/.test(call.output || ""),
      );
      const answered = /\b7\b/.test(finalText);
      return {
        pass: inspected && readConfig && answered,
        note: `inspected=${inspected} readConfig=${readConfig} answered=${answered}`,
      };
    },
  },
  {
    id: "Q3",
    name: "create file",
    fixture: {},
    prompt:
      "Create a file named q3-output.txt in the current working directory containing " +
      "exactly this one line:\n\nqualification-create\n\nThen read the file back and " +
      "report its contents.",
    // Checked on disk after the turn, not from the transcript.
    verdict: ({ dir }) => {
      try {
        const text = readFileSync(path.join(dir, "q3-output.txt"), "utf8");
        const pass = text.trim() === "qualification-create";
        return { pass, note: pass ? "exact content on disk" : `disk content: ${JSON.stringify(text)}` };
      } catch (error) {
        return { pass: false, note: `no file: ${error.code}` };
      }
    },
  },
  {
    id: "Q4",
    name: "targeted edit",
    fixture: {
      "config.ini": "[theme]\ncolor = red\nsize = 3\n",
    },
    prompt:
      "config.ini is wrong: the theme colour must be blue, not red. Edit the file so " +
      "it reads `color = blue`, leave every other line untouched, then show the file.",
    verdict: ({ dir }) => {
      try {
        const text = readFileSync(path.join(dir, "config.ini"), "utf8");
        const edited = /color = blue/.test(text) && !/color = red/.test(text);
        const preserved = /size = 3/.test(text) && /\[theme\]/.test(text);
        return {
          pass: edited && preserved,
          note: `edited=${edited} preserved=${preserved}`,
        };
      } catch (error) {
        return { pass: false, note: `unreadable: ${error.code}` };
      }
    },
  },
  {
    id: "Q5",
    name: "add and run a test",
    fixture: {
      "math.js": "export function add(a, b) {\n  return a + b;\n}\n",
      "math.test.mjs":
        'import assert from "node:assert/strict";\n' +
        'import test from "node:test";\n' +
        'import { add } from "./math.js";\n\n' +
        'test("adds positive numbers", () => {\n' +
        "  assert.equal(add(2, 3), 5);\n" +
        "});\n",
      "package.json": '{ "type": "module" }\n',
    },
    prompt:
      "This project runs its tests with `node --test`. The `add` function has no " +
      "coverage for a negative operand. Add one regression test to math.test.mjs " +
      "covering `add(-1, 1)` returning 0, then run the test file and report what " +
      "happened.",
    // The suite runs the model's own artefact itself; a test that only exists in
    // the transcript does not count.
    verify: async ({ dir }) => {
      let added = false;
      try {
        const text = readFileSync(path.join(dir, "math.test.mjs"), "utf8");
        added = /add\(\s*-1\s*,\s*1\s*\)/.test(text);
      } catch {
        return { added: false, runCode: undefined };
      }
      const run = await runCapture("node", ["--test", "math.test.mjs"], { cwd: dir });
      return { added, runCode: run.code };
    },
    verdict: (_session, verified = {}) => ({
      pass: verified.added === true && verified.runCode === 0,
      note: `added=${verified.added === true} runExit=${verified.runCode ?? "n/a"}`,
    }),
  },
  {
    id: "Q6",
    name: "fix and verify",
    fixture: {
      "calc.js": "export function add(a, b) {\n  return a - b;\n}\n",
      "calc.test.mjs":
        'import assert from "node:assert/strict";\n' +
        'import { add } from "./calc.js";\n\n' +
        "assert.equal(add(2, 3), 5);\n" +
        'console.log("calc ok");\n',
      "package.json": '{ "type": "module" }\n',
    },
    prompt:
      "`node calc.test.mjs` fails on this project. Work out why and fix the code " +
      "so the test passes, then run it again and report the result.",
    verify: async ({ dir }) => (await runCapture("node", ["calc.test.mjs"], { cwd: dir })).code === 0,
    verdict: ({ toolCalls }, verified) => {
      const touched = toolCalls.some((call) => /calc\.js/.test(call.command || call.patchPath || ""));
      return {
        pass: verified === true && touched,
        note: verified ? (touched ? "patched and the test passes here" : "test passes but nothing edited calc.js") : "test still fails",
      };
    },
  },
  {
    id: "Q7",
    name: "bounded failure",
    // There is no deployment target anywhere in this fixture, and nothing in it
    // lets one be inferred. The correct behaviour is to name the blocker and
    // stop, not to invent a plausible value or thrash looking for it.
    fixture: {
      "README.md": "# Fixture\n\nNotes about a service that has no deployment target.\n",
      "src/app.js": "export const name = \"fixture-app\";\nexport const port = 4321;\n",
      "package.json": '{ "type": "module", "name": "fixture" }\n',
    },
    prompt:
      "Report the deployment target this project is configured to ship to.",
    verdict: ({ turns, timedOut, finalText, toolCalls }) => {
      const stopped = !timedOut;
      // Recognising the blocker reads as an admission, not a value.
      const recognised =
        /not (be )?(found|present|configured|defined|specified)|no such|cannot find|can'?t find|does not exist|no deployment target|unable to (find|determine)|missing/i.test(
          finalText,
        );
      // A named target would be an invention: the fixture contains none.
      const invented = /\b(production|staging|prod|aws|gcp|azure|heroku|vercel|netlify)\b/i.test(
        finalText,
      );
      return {
        pass: stopped && recognised && !invented,
        note: `stopped=${stopped} recognisedBlocker=${recognised} invented=${invented} turns=${turns} tools=${toolCalls.length}`,
      };
    },
  },
];

// One command shape for both the model-driven CLI and the suite's own checks.
export function runCapture(command, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// The Codex transcript is newline-delimited JSON. A turn's tool calls are
// `item.completed` nodes of type `command_execution`; patch edits arrive as
// reasoning-free apply_patch invocations inside the same command stream.
export function parseTranscript(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON log noise on stdout is not part of the transcript.
    }
  }
  const toolCalls = [];
  let finalText = "";
  let turns = 0;
  for (const event of events) {
    if (event.type === "turn.started") turns += 1;
    if (event.type !== "item.completed") continue;
    const item = event.item || {};
    if (item.type === "command_execution") {
      toolCalls.push({
        command: item.command,
        output: item.aggregated_output,
        exitCode: item.exit_code,
      });
      if (/apply_patch|\bpatch\b/.test(item.command || "")) {
        toolCalls[toolCalls.length - 1].patchPath = item.aggregated_output;
      }
    }
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      finalText = item.text;
    }
  }
  return {
    events,
    toolCalls,
    turns,
    finalText,
    lastCommand: toolCalls.length ? toolCalls[toolCalls.length - 1].command : undefined,
  };
}

// Every task runs from the same working root with its own subdirectory. The
// cwd is part of Codex's environment context, so a fresh directory per task
// would change the prompt prefix and make the local model re-read its whole
// 8.5K-token preamble seven times. Holding the root steady keeps the prefix in
// llama.cpp's cache, which is also how a person actually uses the model: one
// workspace, many tasks.
async function runTask(task, { model, timeoutMs, codexBin, root }) {
  const dir = path.join(root, task.id.toLowerCase());
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(task.fixture || {})) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // The task text names only bare filenames; the prompt is prefixed with the
  // one absolute path the model needs so it does not have to guess or `cd`.
  const prompt = `Work in this directory: ${dir}\n\n${task.prompt}`;

  const started = Date.now();
  const memoryAtStart = readSystemMemory();
  const run = await runCapture(
    codexBin,
    [
      "exec",
      "--json",
      "-m",
      model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      root,
      prompt,
    ],
    { cwd: root, timeoutMs },
  );
  const wallMs = Date.now() - started;
  const parsed = parseTranscript(run.stdout);

  let verified;
  if (task.verify) {
    try {
      verified = await task.verify({ dir, toolCalls: parsed.toolCalls });
    } catch {
      verified = false;
    }
  }
  const outcome = task.verdict({ ...parsed, dir, timedOut: run.timedOut }, verified);

  const record = {
    id: task.id,
    name: task.name,
    pass: outcome.pass,
    note: outcome.note,
    wallMs,
    turns: parsed.turns,
    toolCalls: parsed.toolCalls.length,
    edited: parsed.toolCalls.some((call) => /apply_patch|>|>>|sed -i|printf/.test(call.command || "")),
    timedOut: run.timedOut,
    // A timeout on a machine that was out of memory is not evidence about the
    // model. Keeping the reason beside the verdict is what stops the two being
    // read as the same thing.
    memoryAtStart,
    classification: !outcome.pass && run.timedOut && memoryAtStart.pressure !== "normal"
      ? "environment"
      : run.timedOut
        ? "runtime"
        : outcome.pass
          ? "pass"
          : "model",
  };
  // Classifying a FAIL needs the raw evidence: "edited the wrong line" and "the
  // suite checked the wrong thing" look identical in a one-line note.
  const debugDir = process.env.QUALIFY_DEBUG_DIR;
  if (debugDir) {
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(path.join(debugDir, `${task.id}.stdout.jsonl`), run.stdout);
    writeFileSync(path.join(debugDir, `${task.id}.stderr.txt`), run.stderr);
    writeFileSync(path.join(debugDir, `${task.id}.record.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  rmSync(dir, { recursive: true, force: true });
  return record;
}

export function formatTable(records) {
  const header = ["test", "result", "time", "turns", "tools", "edited", "notes"];
  const rows = records.map((record) => [
    record.id,
    record.pass ? "PASS" : "FAIL",
    `${Math.round(record.wallMs / 1000)}s`,
    String(record.turns),
    String(record.toolCalls),
    record.edited ? "yes" : "no",
    record.note,
  ]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

async function main() {
  const model = process.env.QUALIFY_MODEL || "llamacpp/gpt-oss-20b";
  const codexBin =
    process.env.QUALIFY_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
  const only = process.env.QUALIFY_ONLY ? new Set(process.env.QUALIFY_ONLY.split(",")) : null;
  const timeoutMs = Number(process.env.QUALIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  const { llamacppStatus, startManagedLlamacpp, stopManagedLlamacpp } = await import(
    "../../src/llamacpp-runtime.mjs"
  );

  async function snapshot(at) {
    const system = readSystemMemory();
    const status = await llamacppStatus().catch(() => ({}));
    return {
      at,
      pressure: system.pressure,
      availablePercent: system.availablePercent,
      swapUsedBytes: system.swapUsedBytes,
      // A stopped runtime has no resident set; `undefined` would vanish from
      // the JSON, so say nothing rather than leaving a hole.
      llamaResidentBytes: status.residentBytes ?? null,
      activeInference: status.activeInference,
    };
  }

  const statusBefore = await llamacppStatus().catch(() => ({}));
  const runtimeAlreadyWarm = Boolean(statusBefore.ready);

  // Refuse before spending minutes on a load the machine cannot afford, and
  // never let that refusal look like a model verdict.
  //
  // The gate is about paying for a load, so it only applies when there is one
  // to pay for. An already-resident model is *why* free memory looks alarming:
  // 11.5 GiB of a 16 GB machine is legitimately unavailable while it is loaded,
  // and refusing on that reading would make the harness unusable in the exact
  // state it is designed to measure.
  const before = readSystemMemory();
  if (before.pressure === "critical" && !runtimeAlreadyWarm) {
    process.stdout.write(
      `\nENVIRONMENT NOT SUITABLE FOR FAIR QUALIFICATION\n` +
        `${before.reasons.map((reason) => `  - ${reason}`).join("\n")}\n\n` +
        "No task was run, so no task is recorded as a failure. Close what you can " +
        "and run again; `local-llamacpp doctor` reports the same reading.\n",
    );
    const out = path.join(REPO, "test", "qualification", "last-run.json");
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          model,
          at: new Date().toISOString(),
          environmentFailure: true,
          reasons: before.reasons,
          system: before,
          records: [],
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`wrote ${out}\n`);
    process.exitCode = ENVIRONMENT_FAILURE_EXIT;
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "localq-root-"));

  // Load once, up front, so no task's clock includes an 11 GiB read. Measuring
  // how often macOS can load that file is a different experiment.
  process.stdout.write("\n--- warming the local runtime ---\n");
  const loadStarted = Date.now();
  const warm = await startManagedLlamacpp();
  const loadMs = Date.now() - loadStarted;
  process.stdout.write(
    `${JSON.stringify({ loaded: warm.started, alreadyRunning: warm.alreadyRunning, loadMs })}\n`,
  );

  const snapshots = [await snapshot("before-load")];
  const records = [];
  for (const task of TASKS) {
    if (only && !only.has(task.id)) continue;
    process.stdout.write(`\n--- ${task.id} ${task.name} ---\n`);
    const record = await runTask(task, { model, timeoutMs, codexBin, root });
    records.push(record);
    snapshots.push(await snapshot(`after-${task.id}`));
    process.stdout.write(`${formatTable([record])}\n`);
    await delay(1_000);
  }
  rmSync(root, { recursive: true, force: true });

  process.stdout.write(`\n${formatTable(records)}\n`);

  // One stop at the end, measured. Repeated load/unload is exactly what the
  // machine cannot afford, so the suite never does it between fixtures.
  const stopStarted = Date.now();
  const stopped = await stopManagedLlamacpp();
  const stopMs = Date.now() - stopStarted;
  snapshots.push(await snapshot("after-stop"));
  process.stdout.write(`\nstop: ${JSON.stringify({ ...stopped, stopMs })}\n`);

  const out = path.join(REPO, "test", "qualification", "last-run.json");
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        model,
        at: new Date().toISOString(),
        loadMs,
        stop: { ...stopped, stopMs },
        environmentBefore: before,
        snapshots,
        records,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\nwrote ${out}\n`);
  process.exitCode = records.every((record) => record.pass) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
