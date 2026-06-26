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
work like reading your notes, summarizing, or classifying. Saga puts a **router** in front:

- **Light tasks** (short prompts, "summarize my memory", reading `CLAUDE.md`) → handled **locally** by Ollama. Free.
- **Heavy tasks** (code, refactors, complex reasoning) → **escalated to Claude**.
- Before escalating, the local model **compresses the context** so fewer tokens are billed.

A live panel shows **tokens served locally** and **tokens saved by compression** against the actual **Claude cost**.

## How the router works

```
                ┌──────────────────────────────────────────────┐
   user prompt  │                  ROUTER                       │
 ─────────────► │                                              │
                │  1. keyword rules  (force local / force claude)│
                │  2. length heuristic (light_max_chars)         │
                │  3. optional local classifier  (LEVE / PESADO) │
                └───────────────┬──────────────┬─────────────────┘
                                │              │
                       light    │              │   heavy
                                ▼              ▼
                        ┌──────────────┐   ┌────────────────────────────┐
                        │   Ollama     │   │  compress context (local)   │
                        │ (local, free)│   │            ↓                │
                        └──────────────┘   │  Claude  ── API  or  CLI ── │
                                           └────────────────────────────┘
                                │              │
                                ▼              ▼
                          accounting: tokens served local · tokens saved · Claude $
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

**Done:** local↔Claude router with context compression · real-time streaming · Sagas history + full-text
search (SQLite/FTS5) · image attachments (vision) · extended thinking & deep research · subagent
orchestration · agentic **browser tool** · **MCP host** · **skills / playbooks / workflows** · **action log +
confirm/dry-run** · side rail · interface zoom · OpenAI-compatible providers · in-app model downloader ·
azulejo identity + animated caravel loader · OS-keychain secrets · CI release builds.

**Next:**

- **Zero-setup distribution** — bundle/auto-install Ollama as a managed sidecar (auto-pull a small default
  model on first run), package the Playwright sidecar (`externalBin`) so the browser tool needs no manual
  install, and round off the first-run wizard. Goal: double-click the installer and it just works.
- **Signed & auto-updating** — code-sign + notarize installers (drops the "unknown publisher" warnings) and
  turn the Tauri updater back on.
- **Local web search** — give the local model web access via Rust-side `web_search`/`web_fetch` tools, so
  research can run fully local (today web search is Claude-only; enabling 🔎 forces the Claude route).
- **More** — artifacts, scheduled automations, richer deep-research depth.

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
