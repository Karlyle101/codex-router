---
title: "Local models"
description: "Curate and route models served from your own machine."
---
Codex Router treats Ollama as a managed, headless local runtime. The model
files remain in Ollama's store; the router only keeps selection, download
progress, benchmark, and catalog state under `~/.codex/codex-router`.

From the tray, open **Model settings → Local LLMs** and click **Download** on a
suggestion, or paste either form into the tag field:

```text
gemma4:12b
https://ollama.com/library/gemma4:12b
```

The click starts `ollama serve` detached from the UI. If the Ollama CLI is
missing, the router runs the official installer only as part of that explicit
install action (`brew install ollama` when Homebrew is available; otherwise the
official installer with `OLLAMA_NO_START=1` and native administrator
authorization on macOS, PolicyKit or an interactive terminal on Linux, or
WinGet on Windows). It never opens the Ollama chat window. A pull completes in the
background, then a tool-capable model is checked on and published to Codex.
The tray shows a persistent status card immediately—checking fit, preparing
Ollama, pulling layers, and then ready or failed—so a long download never looks
like a dead click.
While a pull or removal is active, that card includes **Cancel**. Cancellation
stops the exact detached worker (including its child process on Windows), clears
the operation card, and leaves the model in its last completed state. The
router keeps a private cancellation marker so a worker that is still unwinding
cannot resurrect its progress.
Repeated clicks or concurrent commands reuse the existing operation; they do
not start a second Ollama pull or removal.

The native macOS tray's **View more** panel and the Windows/Linux panel's
**Discover Ollama** section include the complete tag inventories captured from
the official Ollama pages for Gemma 4, Qwen 3.5/3.6/3.8, Nemotron 3 Super,
Ornith, Nemotron 3, and Muse Glimmer. They also include the Ollama-compatible
Unsloth GGUF variants of GLM-5.3 and GLM-5.3-Flash. That includes quantized,
MLX, BF16, and other published variants—not only the family aliases. Cloud
aliases are shown for completeness but are labelled **cloud only** and cannot
be downloaded as local weights. The manifest is a dated snapshot, so arbitrary
Ollama tags and ollama.com model URLs remain supported even when a newly
published tag has not been added yet.
An installed model's generation speed is measured on demand with the **Speed**
button and reported as tokens/second; unmeasured models never receive a guessed
number.

Every model in the catalog is listed and installable, including ones this
machine is rated too small for. The two shortlists above the catalog—the coding
quick picks and the image readers—are recommendations and only show what fits,
but nothing is ever removed from the catalog itself. A model that will not fit
is labelled **won't fit**; acknowledge **Allow a model larger than the router
recommends for this machine** before selecting it. The install still asks for
confirmation before spending the gigabytes.

Useful commands:

```text
./bin/control local-models list --json
./bin/control local-models inspect https://ollama.com/library/gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models install gpt-oss:20b --yes --force
./bin/control local-models cancel gemma4:12b
./bin/control local-models benchmark gemma4:12b
./bin/control local-models runtime status
./bin/control local-models runtime start
./bin/control local-models runtime update --yes
```

`install` takes two independent consent flags, and they combine:

| Flag | Consents to |
| --- | --- |
| `--yes` | installing and starting Ollama itself, headlessly, when it is missing |
| `--force` | downloading a model rated too large for this machine's memory or disk |

Checking or unchecking a model refreshes the picker and gateway routes and
restarts the router service, so the newly published `local/...` route is served
by the process already running in the background. Foreground/dev routers have
no service to restart; restart them by hand after toggling.

Updating Ollama is explicit. A normal model install reuses the installed
runtime and does not replace it behind the user's back.

# LM Studio

LM Studio is supported as a separate local OpenAI-compatible backend. It can
run alongside Ollama; models use the stable `lmstudio/<model-id>` namespace so
identical model IDs from the two backends remain distinct.

Start LM Studio's local server, enable the provider, and curate the models
reported by its `/v1/models` endpoint:

```text
./bin/model-router codex providers enable lmstudio
./bin/curate-models lmstudio
```

The default endpoint is `http://127.0.0.1:1234/v1`. Override it with
`MODEL_ROUTER_LMSTUDIO_BASE_URL`. LM Studio models use the generic Chat
Completions path; Ollama continues using its native route and context handling.

The desktop companion and browser panel list the models LM Studio is currently
serving under Local LLMs, and checking one publishes it to the picker without
the interactive terminal:

```text
./bin/control local-models list            # includes the LM Studio section
./bin/control local-models lmstudio-set <model-id> on|off
```

Both doors write the same user-model overlay, so a model curated in the
terminal can be unchecked in the panel and vice versa. Loading and unloading
the weights stays in LM Studio; the checkbox only controls whether the model
is offered in the picker.

## Qwen3.8 27B Uncensored MLX

The supported one-command path installs the 4-bit MLX weights from
`orcarouter/Qwen3.8-27B-Uncensored-MLX`, loads them into LM Studio with a stable
API identifier and a 32,768-token context, starts the loopback-only server, and
publishes `lmstudio/qwen38-27b-uncensored-mlx` to Codex:

```text
./bin/control local-models mlx-install --yes   # detached one-click UI path
./bin/control local-models mlx-status
./bin/control local-models mlx-cancel

./bin/model-router codex local-mlx install --yes
./bin/local-mlx status
```

The native macOS tray and Electron control center expose the detached path as
an **Install and add to Codex** button. That click is explicit consent to fetch
and run the official per-user LM Studio/llmster and `uv` installers when either
prerequisite is missing, download about 15 GB of weights, and publish the
verified route. Both surfaces poll the same private operation record, show each
phase, allow cancellation and retry, and refuse to overlap an Ollama model
mutation. MLX installation is offered only on Apple Silicon Macs; the backend
enforces the same restriction before it downloads or executes anything.

You can also supply the repository URL explicitly:

```text
./bin/model-router codex local-mlx install \
  https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX --yes
```

The upstream repository contains separate nested `2-bit/`, `4-bit/`, `6-bit/`,
and `8-bit/` trees. The command deliberately downloads only `4-bit/**` with the
official Hugging Face CLI run through `uvx`, stores it under the router's private
state directory, and gives LM Studio that exact directory. It does not use the
router's universal Python lock. The direct `bin/local-mlx` CLI expects `lms`
and `uvx` to exist and stops with their official installation locations when
they do not. The tray/control-center path may install those two official
prerequisites only after the operator clicks the consent-bearing install
button; tokens are never accepted by either UI.

A 27B model at 4-bit is a sensible fit for a 64 GB Apple Silicon machine; the
weights, runtime, 32K KV cache, Codex prompt, and normal application headroom
all share unified memory. Smaller-memory machines may load it with heavy memory
pressure or fail LM Studio's resource guardrails.

This is an uncensored/abliterated community model. Treat its output as
untrusted: it may ignore safety constraints, produce offensive material, or
confidently suggest destructive code. Keep LM Studio bound to `127.0.0.1` and
review every proposed command or patch before running it.

If Hugging Face reports that the repository is missing, private, or gated,
authenticate with the official Hugging Face CLI used by this command, then
retry. The router never asks for, reads, copies, logs, or forwards your Hugging
Face token.

After installation, fully quit every Codex window and process, reopen Codex,
create a new task, and select `lmstudio/qwen38-27b-uncensored-mlx`. Model size
and a tool template do not prove that it can reliably drive a coding agent. Run
the real Codex agent check, which uses a scratch workspace and requires two
successful tool-using runs:

```text
node src/agent-check.mjs lmstudio/qwen38-27b-uncensored-mlx
```

Only a `2/2` agent verdict should be treated as evidence that this model can
operate Codex tools consistently.

Downloads rated too large for the machine are stopped unless `--force` is
present; `--yes` alone does not override the fit check, because consenting to
install Ollama is not the same as consenting to a model that will not run. A
single `install <tag> --yes --force` covers both, so a machine with no Ollama
can still install an oversized model in one command.

Checking a model uses one canonical tag. `devstral` and `devstral:latest` are
the same weights, so checking or unchecking through either spelling affects the
same entry, and selection files written by older versions are normalized on the
next write.





## GPT-OSS-20B on llama.cpp

`llamacpp/gpt-oss-20b` is a local route served by llama.cpp rather than Ollama
or LM Studio. It exists because Ollama mangles GPT-OSS tool-call arguments in
some multi-turn agent loops (ollama/ollama#17638), while llama.cpp's own
`--jinja` function-calling path survives them.

```text
model id      llamacpp/gpt-oss-20b
gateway id    llamacpp-gpt-oss-20b
upstream id   gpt-oss-20b
provider      llamacpp (protocol: openai, loopback only, no credential)
endpoint      http://127.0.0.1:8080/v1
weights       ggml-org/gpt-oss-20b-GGUF, gpt-oss-20b-MXFP4.gguf (about 11.3 GiB)
context       32,768 tokens
```

### The launcher and why its flags matter

The weights and the memory flags live outside this repository, in the operator's
own script:

```text
~/Documents/ChatGPT/dev-workspace/local-models/start-gpt-oss.sh
```

Point `MODEL_ROUTER_LLAMACPP_LAUNCHER` somewhere else to use a different one.
Its flags are not preferences. On a 16 GB Apple Silicon Mac:

| Flag | Why |
| --- | --- |
| `--load-mode none` | mmap makes llama.cpp map the whole 11.3 GiB file into the Metal buffer, which overflows the ~12.1 GiB GPU budget and aborts with `kIOGPUCommandBufferCallbackErrorOutOfMemory` on the first token. |
| `--parallel 1` | the default of 4 multiplies KV-cache allocation for no benefit here; one Codex turn uses one slot. |
| `--cache-ram 2048` | caps the host-side prompt cache so it cannot crowd out the model. |
| `--cache-type-k q8_0 --cache-type-v q8_0` | halves KV memory; requires `--flash-attn on`. |
| `--ctx-size 32768` | a routed prompt runs 8-18K tokens before the conversation, so the old 16K window was refused outright. |

### On-demand, not resident

GPT-OSS-20B holds roughly 11 GiB of unified memory, which is not a cost to pay
while it sits idle. Nothing starts it at login. The first routed turn that
selects `llamacpp/gpt-oss-20b` starts it, waits for `/health` to report ready,
and then streams the turn. A second request arriving at the same time joins the
start already in progress instead of launching a rival copy, and the runtime
records the exact process identity it started so stop only ever signals its own.

Manual control, from this repository:

```text
./bin/local-llamacpp status     # or ./bin/codex-router local-llamacpp status
./bin/local-llamacpp health
./bin/local-llamacpp start
./bin/local-llamacpp stop
./bin/local-llamacpp logs 40
```

`stop` releases the memory; there is no idle-timeout reaper, so the model stays
resident from the first use until you stop it.

### Cold prefill, and the two limits it used to hit

A local model cannot emit its first byte until it has read the entire prompt.
Measured on this M4 16 GB machine at a 32K window: roughly 44-49 tokens/second
while prompt processing, so a cold 8.7K-token prompt is about three minutes of
complete silence on the wire, and a warm follow-up with the prefix already
cached is around fifty seconds end to end.

Two different five-minute bounds used to end those turns, and both are handled:

* **The client's stream-idle timer.** Codex abandons a routed stream after five
  minutes without a complete SSE data event. The router's heartbeat emits a
  `codex.router.keepalive` data event every `CODEX_ROUTER_LOCAL_HEARTBEAT_MS`
  (default 60s) while the local route has produced nothing yet. It carries no
  response object, no id, no usage, and no content: it says only that the socket
  is open. Once llama.cpp emits `response.created`, the ordinary
  identity-bearing heartbeat takes over. Only routes that opt in receive it, so
  hosted providers are byte-for-byte unchanged.
* **The router's own outbound hop.** Undici ends a body that stays silent for
  300s, and that leg is silent during the same prefill. A real routed turn died
  at 336s with `UND_ERR_BODY_TIMEOUT` while llama.cpp was still at 48% of its
  prompt. The local route now uses a separate connection pool whose bound
  outlasts the local prelude budget (`CODEX_ROUTER_LOCAL_TRANSPORT_IDLE_MS`,
  default prelude + 60s) instead of the shared one.

A routed local turn crosses four hops, and every one of them has to outlast the
prefill or the pause ends at whichever times out first:

```text
Codex  ->  router  ->  litellm  ->  api-forwarder  ->  llama.cpp
```

The router hop is handled above. The two below it are not yet raised, and both
are 300s-class defaults rather than anything this route chose: the api-forwarder
was observed ending a silent hop with `UND_ERR_HEADERS_TIMEOUT`, and
`litellm.yaml` sets `request_timeout: 600`. So the practical limit today is a
cold prefill of roughly five minutes, which the lean local tool surface keeps
comfortably inside at about three. Raising those two is the next change if a
larger local prompt ever needs to be served.

Neither is a timeout change for anything else. `stream_idle_timeout_ms` is not
raised anywhere, and hosted routes keep both the shared pool and the shared
heartbeat behaviour.

### What it is good at, and what it is not

It genuinely drives Codex tools: shell execution, file creation, reading a file
back, and recovering from its own bad path all worked through the routed path
with real `exit_code` values. It is not a strong autonomous engineer. A
targeted bug-fix-and-test task was given twenty-five minutes and produced no
edit. Expect it to be a useful local coding and tool worker for bounded,
well-specified work, not a replacement for a hosted frontier model.

Two practical limits on this hardware:

* Tool loops are slow. A three-tool-turn edit took six minutes, most of it
  generation at 0.3-2 tokens/second once the machine was tight on memory. Only
  about 10% of system memory is free while the model's buffer is wired, so run
  it when you are not also pushing a build through the machine.
* Large `mcp__` connector namespaces are filtered out of the default local tool
  surface. Dropping the unreferenced ones took one measured request from
  628,616 to 71,095 bytes. A conversation that actually calls an app tool still
  gets that tool's definition.

### Direct fallback

`codex -p local-oss` still points straight at llama.cpp, bypassing the router
entirely, using `~/.codex/local-oss.config.toml`. It is the control group: if a
turn fails through the router and succeeds directly, the fault is in the router
leg, not the model or llama.cpp. Keep it.

It is not the better route, though, and on a loaded machine it is the worse one.
Measured on a memory-tight M4 with the model resident, a direct turn whose
prefill ran slower than 45 tokens/second hit Codex's own five-minute SSE idle
bound and started re-sending the whole prompt ("Reconnecting... 1/5"). The
routed path survived the same kind of prefill because the router keeps the
client's stream alive; nothing keeps it alive when the client talks to
llama.cpp directly. Use the direct profile to isolate a fault, not as the
everyday path.

### Stopping a local turn

llama.cpp does not cancel inference when its caller disappears, and version
0.4.1 has no conversation-id or resumable-stream API to cancel it with. A
cancelled Codex turn therefore used to leave the model generating into an empty
room: one stranded generation was observed still running **25 minutes** after
its client was gone, holding the single slot and about 11 GiB of a 16 GB
machine.

What happens now, from the moment you press Stop or close the window:

```text
client disconnects
  → router records canceled / client_disconnected   (measured: 141 ms)
  → aborts its own upstream request
  → waits CODEX_ROUTER_LOCAL_CANCEL_GRACE_MS        (default 10 s)
       polling /slots for `is_processing`
  → if the slot is still generating: stop the managed runtime
  → wait for port 8080 to stop answering, then release
```

Measured end to end on this machine: cancel at 18:55:37, the server was gone by
18:56:22, and system memory went from 6% free to 30% as the 11 GiB came back.

Cancellation is request-scoped. Each turn carries its own controller, and the
timer, the heartbeat, and the cleanup all belong to that request. Two rules keep
the cleanup from becoming a worse bug than the one it fixes:

* a slot that is busy with **another live local turn** is never reclaimed, so a
  cancellation cannot kill the next request;
* a request arriving during a teardown **waits** for it, then takes the ordinary
  on-demand start, so it can never attach to a half-dead server.

### Idle shutdown

The model does not need to hold 11 GiB while you are doing something else. After
the last local turn ends, an idle timer starts; a new local turn cancels it by
arriving, and it never fires while the slot is busy or a teardown is running.

```text
CODEX_ROUTER_LOCAL_IDLE_MS              900000   (15 minutes; 0 disables)
CODEX_ROUTER_LOCAL_CANCEL_GRACE_MS       10000
CODEX_ROUTER_LOCAL_TRANSPORT_IDLE_MS   prelude + 60 s
CODEX_ROUTER_LOCAL_START_TIMEOUT_MS     180000
```

Nothing starts at login, and manual start/stop still work exactly as before.

### Qualification

`test/qualification/local-model-qualification.mjs` is the reproducible
capability check. It builds throwaway fixtures under the system temp directory
(never a real project), runs each task through the routed model, and decides
PASS from the transcript and the file system afterwards -- a command printed in
prose is not execution, and a test that only exists in the transcript does not
count.

```text
node test/qualification/local-model-qualification.mjs
```

The run prints a table and writes `test/qualification/last-run.json`.

`QUALIFY_ONLY=Q1,Q3`, `QUALIFY_TIMEOUT_MS`, and `QUALIFY_MODEL` narrow a run.
Tasks share one working root on purpose: the cwd is part of Codex's environment
context, so a fresh directory per task would make the model re-read its whole
8.5K-token preamble seven times.

**It has not produced a clean run yet, and no capability profile exists.** In
the most recent attempt Q1 hit its eight-minute bound with zero tool calls. That
was measured while the machine had a resident 11.5 GiB model, roughly 4-10%
memory available, and swap in use, and while individual routed turns were taking
142-441 seconds where a clean machine does the same work in 47-229. The record
is therefore classified `environment`, not `model`.

Until the suite runs on a machine that has been restarted and is otherwise
quiet, treat every capability statement about this model as unqualified. The one
thing that is established is that it genuinely drives Codex tools, from the
earlier routed shell, warm shell, and file-creation proofs.

### Stopping gracefully, and starting safely

Stopping is one operation shared by the CLI, the cancellation cleanup, and the
idle reaper. It sends `SIGTERM`, waits out `CODEX_ROUTER_LOCAL_STOP_GRACE_MS`
(default 60000) for the process to leave, and only then escalates to `SIGKILL`.
The twenty-second ceiling it replaced was too tight for an 11 GiB unload on a
busy machine, which is why stops used to report `forced: true`. A normal stop
now reports:

```json
{"stopped":true,"pid":7031,"forced":false,"portFree":true}
```

measured at 3.9 seconds end to end, with memory returning to 83% free.

Two things that look like the same event are not: the process leaving the
process table, and the port becoming usable again. A single refused connection
is a transient, so `STOPPED` now requires the socket to stay free across a
second look. That is what closes the old sequence of stop, immediate start, bind
failure, second start succeeds.

Starting has its own barrier. It waits for any teardown still in flight, then:

```text
port answering, and it is our managed process  → wait for it, or use it
port answering, and nothing here owns it        → FAIL CLOSED
nothing answering                               → launch
```

A foreign server on the port is never signalled; the start fails with
`ERR_LLAMACPP_PORT_CONFLICT` and says which setting to change. An unattended
router should not be guessing about process ownership.

### Resource preflight

```text
./bin/local-llamacpp doctor
```

reports available memory, swap in use, compression, wired memory, and the
runtime's own state, and exits non-zero when the machine is in no shape to load
an 11 GiB model. `status` carries the same reading under `system`.

It is advisory for normal use. The measurement harness is the one caller that
treats it as a gate, because spending minutes loading a model into a thrashing
machine and then recording a timeout as a model failure is a bad experiment.
When a task does time out, the qualification record carries
`classification: "environment"` rather than a silent FAIL, so the two are never
read as the same thing. The gate does not apply when the model is already
resident: 11.5 GiB of a 16 GB machine is legitimately unavailable, and that is
the state the harness most wants to measure in.
