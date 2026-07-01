<p align="center">
  <img src="assets/brand/caravel-mark-wave.svg" width="92" alt="Saga" />
</p>

<h1 align="center">Saga</h1>

<p align="center">
  A cross-platform desktop AI assistant with a <strong>local&nbsp;↔&nbsp;Claude router</strong> —
  runs a local model for the light work and escalates to Claude only when it's worth it,
  saving tokens (and money) on everything else.
</p>

<p align="center">
  <em>Built with Tauri 2 (Rust + web UI) · Windows · macOS · Linux</em>
</p>

<p align="center">
  <img src="assets/brand/caravel-panel.svg" width="300" alt="Azulejo caravel panel — Saga" />
</p>

<p align="center">
  <em>Saga — the Norse goddess of wisdom, and a story worth telling. Named for the ships
  where Portugal's greatest sagas were written: an assistant that navigates between local and cloud.</em>
</p>

---

## Why

Most "chat with an LLM" apps send every keystroke to a paid frontier model — including trivial
work like reading your notes, summarizing, or classifying. Saga is **local-first**: your **Ollama
model is the assistant**, and **Claude is an optional escalation** you reach for on purpose.

- **Everything runs locally by default** on Ollama. Free, private, offline-capable.
- **Claude (CLI subscription or API) is optional.** With no Claude configured, Saga is a complete
  local assistant. Connect it to **escalate** a heavy turn — explicitly, not by a guess.
- **Escalate when you decide:** flip a turn to **Claude**, or hit **⤴ Ask Claude** on any local answer
  to re-run it on Claude. Before escalating, the local model **compresses the context** so fewer tokens are billed.

A live panel shows **tokens served locally (free)** against the actual **Claude cost**.

## Local-first, escalate on demand

```
                ┌───────────────┐
   user prompt  │  local model  │   default: runs on Ollama (free)
 ─────────────► │   (Ollama)    │
                └───────┬───────┘
                        │   you choose to escalate (Local|Claude switch, or ⤴ Ask Claude)
                        ▼
                ┌────────────────────────────┐
                │  compress context (local)   │
                │            ↓                │
                │  Claude  ── API  or  CLI ── │   optional — hidden when not configured
                └────────────────────────────┘
                        │
                        ▼
                  accounting: local (free) · Claude $
```

## Beyond chat — an agentic workspace

Conversations are **Sagas**. A left nav rail opens the workspace surfaces:

- **MCP host** — Saga is a [Model Context Protocol](https://modelcontextprotocol.io) client: point it at any
  stdio MCP server (filesystem, GitHub, Playwright, your own) and the model can call its tools
  (`mcp__<server>__<tool>`). Add and test servers under **Servidores**.
- **Skills & Playbooks** — reusable Markdown in your workspace. Skills auto-surface to the model
  (`load_skill`); playbooks are pulled on demand (`read_playbook`). The model can **create/edit** them on request.
- **Workflows** — saved agentic procedures. Type `/<name> args` to run one; it executes step-by-step with the
  available tools.
- **Browser tool** — a Playwright session (navigate / read / click / fill / screenshot) driven by tool-calling.
- **Web search** — toggle 🔎 to give the **local** model live web access (needs a tool-capable model like
  qwen3 / llama3.1). Pick an engine in **Models → Advanced**: **Jina** (default), Tavily, Brave, Serper or Exa
  (each with its own free-tier key, stored in the OS keychain), plus keyless DuckDuckGo as a best-effort
  fallback. Keyless scraping is unreliable in 2026, so a free key is recommended. Page fetching uses **Jina
  Reader** (`r.jina.ai`, keyless). Sources consulted are shown under each answer to verify the model searched.

Every tool call is **logged** (per-Saga *Atividade* view), and a **confirmation mode** (off / dry-run / ask)
can preview or require approval before any action runs. Workspace files live under a configurable folder
(`skills/`, `playbooks/`, `workflows/`) — editable in-app or in your own editor. Tools require **Claude API mode**.

## Two ways to reach Claude (user-selectable)

| Mode | How | Pros |
|------|-----|------|
| **Claude CLI** | spawns `claude -p … --output-format json` | reuses your Claude Code subscription, no API key |
| **API** | Anthropic Messages API over HTTPS | precise per-request token usage, no subprocess overhead |

Switch in **Settings → Claude → Mode**.

## Tech

- **Tauri 2** — Rust core, system webview, ~15 MB binaries, no Node.js runtime shipped.
- **Rust backend** — `reqwest` (Ollama + Anthropic HTTP), provider abstraction, router, token accounting.
- **Vanilla TypeScript + Vite** frontend — no heavy framework.
- Settings persisted as JSON under the OS config dir.

```
src-tauri/src/
  providers/   ollama · claude_api · claude_cli · openai_compat   (model backends)
  mcp/         MCP client + manager (stdio JSON-RPC host)
  tools/       browser sidecar + dispatcher (ToolHost)
  agent.rs     tool-use loop      orchestrator.rs  subagents
  workspace.rs skills / playbooks / workflows
  router.rs    triage → route → context compression
  store.rs     SQLite: Sagas, messages (FTS5), action log
  memory.rs · accounting.rs · settings.rs · commands.rs
src/
  main.ts      UI (rail, chat, managers, settings)
  api.ts       typed bindings   ·   caravel-loader.ts · zoom.ts
```

## Run it

Prerequisites: [Rust](https://rustup.rs), [Node.js](https://nodejs.org), and
[Ollama](https://ollama.com) with a model pulled (e.g. `ollama pull llama3.2`).
For Claude, either the [Claude CLI](https://docs.claude.com/claude-code) installed, or an
`ANTHROPIC_API_KEY`.

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production bundles for your OS
```

In **Settings**, point *Memory folder* at any directory of `.md` files (try `examples/memory/`)
and optionally a `CLAUDE.md`.

## Releasing

Pushing a `v*` tag triggers the GitHub Actions build (macOS Apple Silicon · Windows · Linux), which
**drafts** a release with the installers (`.dmg`, `.exe`/`.msi`, `.AppImage`/`.deb`/`.rpm`):

```bash
git tag v0.2.3 && git push origin v0.2.3
```

When the run is green, **publish the draft** from the Releases page — don't "create a new release" from the
tag, or you get an empty one without the installers.

Installers are currently **unsigned** (Windows SmartScreen / macOS Gatekeeper will warn — "More info → Run
anyway" / right-click → Open). To sign and re-enable **in-app auto-update**: set
`bundle.createUpdaterArtifacts: true`, generate an updater key (`npx @tauri-apps/cli signer generate`), put
the public key in `tauri.conf.json` → `plugins.updater.pubkey`, and add the `TAURI_SIGNING_PRIVATE_KEY` /
`_PASSWORD` CI secrets. For full code signing, add OS certs (Windows OV/EV; Apple Developer + notarization).

## Identity

Saga wears a **Portuguese _azulejo_** identity built on its caravel mark — cobalt-blue tilework with a
single ochre accent, the palette of the Age-of-Discovery tile panels. The app defaults to a light
"glaze" theme and switches to a dark "cobalt night" under `prefers-color-scheme: dark`.

<p align="center"><img src="assets/brand/palette.svg" width="620" alt="Saga palette" /></p>

| Asset | File |
|---|---|
| Hero panel (splash / empty state) | `assets/brand/caravel-panel.svg` |
| App icon mark (on the wave) | `assets/brand/caravel-mark-wave.svg` |
| Reference panel | `docs/brand/reference-caravel-panel.jpg` |

The SVG masters are the source of truth — platform icons are regenerated from them with
`npm run tauri icon`.

## Roadmap

**Done:** local-first assistant (Ollama) with optional one-click Claude escalation + context compression · real-time streaming · Sagas history + full-text
search (SQLite/FTS5) · image attachments (vision) · extended thinking & deep research · subagent
orchestration · agentic **browser tool** · **MCP host** · **skills / playbooks / workflows** · **action log +
confirm/dry-run** · side rail · interface zoom · OpenAI-compatible providers · in-app model downloader ·
azulejo identity + animated caravel loader · OS-keychain secrets · CI release builds ·
**rich artifacts** (Markdown/Mermaid/syntax-highlight, export, gallery) · **Saga export** ·
**iterative cited deep-research** · **scheduled automations** (cron, background runner + notifications) ·
**local web search** (Jina · Tavily · Brave · Serper · Exa, + keyless DuckDuckGo; **Jina Reader** for page fetch) ·
**compact / clear a Saga** (local-model summarization) · **PDF export** (print-to-PDF + `create_pdf` tool + bundled
skill) · **English / Portuguese UI** · per-provider keychain keys · **signed auto-update** (minisign artifacts +
`latest.json`, background download on launch) · external links open in the system browser ·
**live Ollama model browser** (search ollama.com with capability badges, full per-model variant/quant list, one-click
pull; per-model tuning via Modelfile defaults; VRAM-aware suggestion; LM Studio supported for chat, downloads via its own app) ·
**monochrome inline-SVG icon set** (`currentColor`, matching the side rail) ·
**clear Skills / Playbooks / Workflows / Agents distinction** (per-type help in the workspace) ·
**rich first-time experience** (multi-step welcome, hardware-aware model pick with one-click install, optional
Claude, friendly empty state + mini-tour) · **Agents** (reusable personas — *Software Engineer*, *Expert Web
Researcher*, *Writer* — system prompt + suggested toggles/route, picked in the composer) ·
**rich PDF design** (polished print theme: cover, type scale, styled headings/tables/callouts/code, page-break
control + page numbers via the `page.pdf()` path) · **system tray & start-on-login** (close-to-tray when
automations are scheduled) · **document attachments** (PDF / Word / Excel / text — extracted to text in Rust and
folded into context; images still go to vision) · **drag & drop** files onto the chat · **in-chat find**
(Ctrl/⌘+F over the current conversation) · **rich PDF templates** (Report / Article / Technical) ·
**resource-aware install warning** (flags models that likely exceed VRAM/RAM, non-blocking) ·
**rich document viewer** (open an attachment as the real file — PDF in the webview's native viewer, Word via
docx-preview, Excel via SheetJS — with a toggle to the extracted text the model actually read) ·
**grounded local deep-research** (small-model Self-Ask: decompose the question → search each sub-question →
Chain-of-Verification → answer only from the gathered evidence, anchored to today's date — closes the
current-facts gap at $0) · **adaptive context window** (sizes Ollama `num_ctx` to the prompt so long inputs don't
truncate the reply) · **model warm-up** (preloads the local model into VRAM on composer focus / launch for a
near-instant first token) · **live working feedback** (animated dots + ticking elapsed timer + phased status while
the model works) · **per-message generation time** · **vision model picker** (choose the image fallback from the
installed vision models; warns when none of the installed models can see) · **Claude CLI vision** (the CLI reads
image attachments; the prompt is piped via stdin so long conversations don't hit the command-line length limit) ·
**one-click Ollama optimize** (flash attention + q8_0 KV cache env vars, Windows) · **DuckDuckGo rate limiter**
(global request pacing + cooldown to avoid the keyless anti-bot blocks) ·
**Plan mode** (the model drafts an actionable step-by-step plan you **approve / edit / reject**, then executes it
step by step with a live status checklist; each step is reasoned/written, or grounded via the 🔎 toggle;
local-first on Ollama or on Claude — the planning sibling of grounded deep-research) ·
**keyless Mojeek failover** (when DuckDuckGo's anti-bot blocks, Mojeek takes over for a cooldown window —
grounding keeps working with no API key) · **per-step collapsible plan result** (the checklist becomes an
index: click a step to expand its content) + **numbered editable plan editor** ·
**clarification before planning** (a *deterministic* ambiguity gate — cheap text features, **not** model
self-judgment, which research shows over-flags — asks 1-3 slot-based questions only when the request is vague,
then plans with your answers; the planning counterpart of asking-before-acting) ·
**embedding-refined clarification** (an embedding classifier — auto-detecting any installed embed model — settles
the borderline cases the deterministic gate can't; degrades safely to L1 when none is installed) +
**adaptive per-model sensitivity** (answering/skipping the clarify card nudges a per-model threshold) ·
**focused per-step search queries** (keyword + clarified-region queries — e.g. "RTX 4090 price Portugal" — instead
of the verbose step label) · **live token streaming during Plan execution** ·
**Topics** (group Sagas under a topic with a side-rail collapsible group, drag-and-drop to move, a shared
**brief + pinned notes** injected into every chat's context, and a per-topic editor) ·
**topic-scoped Workspace docs** (a `topic:` frontmatter restricts a skill/playbook/workflow/agent to that topic's
chats; empty = global — with a topic selector in the editor and a badge in the list) ·
**Projects** (attach a folder to a topic → the model gets the **file tree** as context + **file tools**
`project_tree`/`read`/`edit`/`create`/`delete` sandboxed to the folder, on the **Claude API route**, the
**Claude CLI (subscription) route**, and the **local Ollama route** — CLI-mode writes are pre-authorized for the
session, since headless mode can't pause for a per-file confirmation dialog the way the API route's
**ActionGate** does, and leave an audit trail in the **Action Log** via before/after folder snapshots; a project
in "Leitura" mode gets an honest **"this project is read-only"** message instead of a local model inventing
route excuses; **"Save to project"** on any artifact works regardless of permission mode, since a manual,
dialog-confirmed save isn't an autonomous write; a **live file explorer** (real filesystem watcher, collapsible
tree) plus one-click **open folder**; per-turn **tool pruning** on the local route so `web_search`/`web_fetch`
aren't offered when the message clearly doesn't need them; a seeded **project-files** skill that reinforces
using the tools instead of paste-the-code) ·
**self-distilling Workspace docs** (the model watches a topic's chats and, when it spots a replicable pattern,
proposes capturing it as the right doc type — playbook / skill / workflow — drafted via the AI doc generator,
scoped to the topic, and surfaced for **approve / edit before saving**, never silently; triggered by an explicit
"Destilar" button or a passive pill from the compaction pass) ·
**regenerate keeps history** (ChatGPT-style ‹previous/next› version cycling on any regenerated message instead
of discarding the old response — works on any turn with alternates, not just the latest) ·
**Stop button** (cancel an in-flight generation on any route while keeping the partial text already produced) ·
**true per-conversation generation** (generating in one Saga no longer blocks the UI or actions in another;
Claude generations run fully concurrent since they don't share local hardware, local generations queue —
one at a time — since parallel Ollama requests compete for the same GPU/VRAM and get slower, not faster) ·
**Claude CLI model discovery** (a refresh button drives the CLI interactively via a real PTY to list the
models available on your subscription, for users without an API key) ·
**local "Think" effort scale** (the Think chip becomes off → native → **verify** (self-consistency: sample N,
measure agreement = confidence, synthesize) → **debate** (proponent → skeptic → judge), pickable per message and
as an agent default) ·
**per-agent defaults** (route, tools, deep research, subagents, **Plan**, **Think level**, and a **model** —
with fallback to the default if the pinned model was deleted) ·
**per-context model selection** (in-chat A/B: regenerate the same prompt on another installed local model or
Claude; plus a **model field on scheduled automations**) ·
**artifact toolbar overflow menu** ("⋯" collapses controls that don't fit when the panel is narrow) ·
**richer first-time experience** (optional one-click **embed-model install** in the wizard, with a passive
Settings hint when none is detected; an actionable "Ollama isn't running" hint on connection-refused instead of
the raw error; seeded example **playbook + workflow** so the Workspace isn't empty on first run; a **replayable
mini-tour** covering the route picker, Workspace and Automations, not just the rail/composer) ·
**save a Saga to memory on delete** (deleting a chat with real content offers to **distil it into memory** first
— scope pre-filled from the topic name when there is one, editable — instead of losing it silently when you
clean up; reuses the local-model summarization from **compact**) ·
**Clarification v3 — self-consistency** (an **L3 signal** for the hardest borderline calls left undecided by the
L1/L2 gate: sample a few short "what would you assume" completions at different temperatures and measure
embedding agreement — high agreement means the model would answer the same way regardless, so it skips the
clarify card even when L1/L2 leaned vague; local route + `high` level only, since the Claude API has no
per-request temperature to sample with) ·
**Smart Saga** (in normal chat, not just Plan mode, a deterministic **fail-closed** detector asks before
searching the web when a request looks like it needs current external facts — a price, a result, today's news —
and the turn has no web access yet; answering "yes" turns on grounded search for that turn only, "no" tells the
model to admit uncertainty instead of guessing — never a silent search, never a model self-judgment call).

**Next:**

- **Zero-setup distribution** — bundle/auto-install Ollama as a managed sidecar (auto-pull a small default
  model on first run), package the Playwright sidecar (`externalBin`) so the browser tool needs no manual
  install. Goal: double-click the installer and it just works.
- **Code-sign & notarize installers** *(current focus)* — the updater is signed and auto-update is live; still
  pending is OS-level **code-signing + notarization** (Apple Developer ID / Windows Authenticode) to drop the
  "unknown publisher" warnings.
- **Projects — auto mode & rollback** — Projects now cover all three routes (Claude API, Claude
  CLI, local Ollama), with a live file explorer and an audit trail. The remaining piece is an **auto** permission
  mode: after you **approve a plan**, the agent runs the file edits unattended to the end (extending Plan mode's
  draft → approve → execute to real edits), with the folder **snapshotted before the run** so **rollback** undoes
  the whole thing in one click. This is the home for **Agentic Plan execution (v2)** below. Open: rollback via
  per-run shadow git (stash/commit) vs a filesystem snapshot copy; how to combine the multi-step tool loop with
  the (currently separate) verify/debate.
- **Agentic Plan execution (v2)** — today Plan mode *generates* each step (reasoning/writing, optionally web-grounded);
  a v2 would let approved steps take **real actions** via the agentic tool loop (browser, workspace, MCP, files) on
  the Claude route, with per-step approval for risky ones.

**Open questions:**

- **High-performance inference backend?** — worth supporting **TabbyAPI / ExLlama (EXL3)** alongside Ollama, for
  ~2× single-stream speed and larger models within 12 GB VRAM? Trade-off: more setup vs more speed. The app already
  speaks OpenAI-compatible APIs, so a backend can be A/B-tested behind the same endpoint with **no code change**.
  (vLLM / TGI / SGLang are throughput/server engines — Linux-first, batching wasted for a single desktop user — so
  likely not the fit here. Internal-activation methods like sparse-neuron ambiguity probes stay out of reach until/unless
  the inference stack exposes hidden states.)

### Browser tool setup

The browser tool runs Playwright in a Node sidecar, kept Node-free in the Rust core:

```bash
cd sidecar
npm install
npx playwright install chromium
```

Then in **Settings → Ferramentas & Workspace**: enable the tool, set the sidecar path to `sidecar/index.js`,
and pick a user-data dir (the browser session/login persists there across runs). Browser tools require
**Claude API mode** (the CLI can't do tool-use here). Never hardcode credentials — log in once
interactively and the persistent context keeps the session.

## Limitations

- Streaming is real-time in API mode; the Claude **CLI** path is buffered (one chunk) — a known CLI limitation.
- Claude **CLI** mode can't accept images or drive tools; those force API mode.
- On Linux the system webview is WebKitGTK, which lags Chromium — the common Tauri/Wails trade-off.
- Token "savings" for locally-served requests are estimated (≈4 chars/token); Claude figures are exact.

## License

MIT © 2026 Gabriel Teixeira. Inspired by — but not derived from — projects like Odysseus; original code.
