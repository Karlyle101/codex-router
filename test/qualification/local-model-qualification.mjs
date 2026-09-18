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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
      "alpha.txt": "operator token: QUA-7742\n",
      "beta.txt": "unrelated\n",
      "notes/inner.txt": "also unrelated\n",
    },
    prompt:
      "List the files in the current working directory, read alpha.txt, and report " +
      "the operator token it contains.",
    verdict: ({ toolCalls, finalText }) => {
      const listed = toolCalls.some((call) => /(^|\s)ls(\s|$)/.test(call.command || ""));
      const read = toolCalls.some(
        (call) => /alpha\.txt/.test(call.command || "") && /QUA-7742/.test(call.output || ""),
      );
      const answered = /QUA-7742/.test(finalText);
      return {
        pass: listed && read && answered,
        note: `list=${listed} read=${read} answered=${answered}`,
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
      "package.json": '{ "type": "module" }\n',
    },
    prompt:
      "Create a file check.mjs that imports `add` from ./math.js and exits 0 when " +
      "add(2, 3) is 5, otherwise exits 1. Then run `node check.mjs` and report the " +
      "exit code.",
    // The suite runs the model's own artefact itself; a test that only exists in
    // the transcript does not count.
    verify: async ({ dir }) => {
      if (!readdirSync(dir).includes("check.mjs")) return false;
      return (await runCapture("node", ["check.mjs"], { cwd: dir })).code === 0;
    },
    verdict: ({ toolCalls }, verified) => ({
      pass: verified === true,
      note: verified ? "test written and passes when run here" : "missing or failing test",
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
      "calc.test.mjs fails. Diagnose the fault in calc.js, fix it, then run " +
      "`node calc.test.mjs` and report the result.",
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
    // The command cannot succeed: `false` exits 1 and nothing can change that.
    // The question is whether the model stops and says so, or grinds.
    fixture: {},
    prompt:
      "Run this exact shell command and confirm it exited with status 0:\n\n" +
      "false\n\nIf it did not exit 0, say so plainly and stop.",
    verdict: ({ turns, timedOut, lastCommand, finalText }) => ({
      // A pass here is the harness's behaviour, not the model's success: the
      // run has to end inside the bound instead of looping. Whether the model
      // reported the truth is recorded separately.
      pass: !timedOut,
      note: `turns=${turns} lastCommand=${lastCommand || "none"} honest=${/not|failed|1|non-?zero/i.test(finalText)}`,
    }),
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
  };
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

  const root = mkdtempSync(path.join(os.tmpdir(), "localq-root-"));
  // A warmed prefix is the difference between a two-minute task and a
  // fifteen-minute one, so the first task pays the cold read for the rest.
  const records = [];
  for (const task of TASKS) {
    if (only && !only.has(task.id)) continue;
    process.stdout.write(`\n--- ${task.id} ${task.name} ---\n`);
    const record = await runTask(task, { model, timeoutMs, codexBin, root });
    records.push(record);
    process.stdout.write(`${formatTable([record])}\n`);
    await delay(1_000);
  }
  rmSync(root, { recursive: true, force: true });

  process.stdout.write(`\n${formatTable(records)}\n`);
  const out = path.join(REPO, "test", "qualification", "last-run.json");
  writeFileSync(out, `${JSON.stringify({ model, at: new Date().toISOString(), records }, null, 2)}\n`);
  process.stdout.write(`\nwrote ${out}\n`);
  process.exitCode = records.every((record) => record.pass) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
