# ⛵ Saga

A cross-platform desktop AI assistant that runs a **local model (Ollama)** for light work and
**escalates to Claude only when it's worth it** — saving tokens (and money) on everything else.

Built with **Tauri 2** (Rust backend + web UI). Runs on Windows, macOS and Linux.

> *Saga* — the Norse goddess of wisdom, and the word for a story worth telling. Named for the ships
> where Portugal's greatest sagas were written: the assistant that navigates between local and cloud.

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
  providers/   ollama.rs · claude_api.rs · claude_cli.rs   (model backends)
  router.rs    triage → route → context compression
  memory.rs    read & expose memory / CLAUDE.md
  accounting.rs token + cost tracking (per-model pricing)
  settings.rs  persisted config
  commands.rs  Tauri command surface
src/
  main.ts      UI (chat, token panel, settings)
  api.ts       typed bindings to the Rust commands
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

## Roadmap (personal/deeper version)

`main` is the focused portfolio version (V1). The `v2` branch is a deeper personal build adding:
real-time streaming, chat history (SQLite), image attachments (vision), and an agentic browser
tool (Claude tool-calling driving Playwright). Future: deep research, extended thinking, artifacts,
tasks, chat search, scheduled automations, and **subagent orchestration** — split a complex task into
isolated phases and run focused subagents (each with only the context it needs) in parallel to finish faster.

**Rebranding follow-through (Saga):** finish the visual identity — logo/app icons (regenerate the
Tauri `icons/` from a real caravel mark via `npm run tauri icon`), a coherent color palette, polished
copy/README text, and demo GIFs/screenshots for the repo.

**All-in-one / zero-setup distribution** (goal: a non-technical user double-clicks the installer and it just works):

1. **First-run onboarding wizard** — detect what's missing, guide the user through setup, test each
   connection, and pick a mode. No empty, broken-looking screen on first launch.
2. **Bundled & managed Ollama** — ship or auto-install Ollama as a managed sidecar; auto-pull a small
   default model on first run with a progress bar; start/stop it with the app.
3. **Bundled browser sidecar** — package Node + Chromium as a Tauri sidecar (`externalBin`) so the
   browser tool needs no manual `npm install` / `playwright install`.
4. **One-step Claude setup** — paste the API key behind a guided link (or a device/OAuth-style login),
   stored in the **OS keychain** — not in plaintext `settings.json`.
5. **Signed & auto-updating** — code-sign + notarize the installers (removes the "unknown publisher"
   warnings) and add the Tauri updater plugin for in-app updates.
6. **Zero-config defaults** — usable offline via the local model the moment it finishes downloading;
   Claude stays optional.
7. **Secret hardening** — move all credentials to the OS keychain (keyring/Stronghold); no secrets on
   disk in clear. (Also a security/GDPR win.)

**Model flexibility:**

- **More providers beyond Ollama** — support OpenAI-compatible endpoints, Gemini, Mistral, and local
  runtimes (llama.cpp / LM Studio), behind the existing provider abstraction so the router can pick any.
- **In-app model downloader** — browse and pull/download models directly from Saga (with a progress
  UI), so the user never touches a terminal.

### Browser tool (v2) setup

The browser tool runs Playwright in a Node sidecar, kept Node-free in the Rust core:

```bash
cd sidecar
npm install
npx playwright install chromium
```

Then in **Settings → Browser**: enable the tool, set the sidecar path to `sidecar/index.js`, and
pick a user-data dir (the browser session/login persists there across runs). Browser tools require
**Claude API mode** (the CLI can't do tool-use here). Never hardcode credentials — log in once
interactively and the persistent context keeps the session.

## Limitations

- Streaming is real-time in API mode; the Claude **CLI** path is buffered (one chunk) — a known CLI limitation.
- Claude **CLI** mode can't accept images or drive tools; those force API mode.
- On Linux the system webview is WebKitGTK, which lags Chromium — the common Tauri/Wails trade-off.
- Token "savings" for locally-served requests are estimated (≈4 chars/token); Claude figures are exact.

## License

MIT © 2026 Gabriel Teixeira. Inspired by — but not derived from — projects like Odysseus; original code.
