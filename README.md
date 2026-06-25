# ⟁ Janus

A cross-platform desktop AI assistant that runs a **local model (Ollama)** for light work and
**escalates to Claude only when it's worth it** — saving tokens (and money) on everything else.

Built with **Tauri 2** (Rust backend + web UI). Runs on Windows, macOS and Linux.

> Janus, the two-faced Roman god: one face on the local model, one on the cloud.

---

## Why

Most "chat with an LLM" apps send every keystroke to a paid frontier model — including trivial
work like reading your notes, summarizing, or classifying. Janus puts a **router** in front:

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

This repo is the focused portfolio version. A deeper personal build is planned: streaming responses,
tool calling / MCP, conversation persistence, and richer routing.

## Limitations

- Responses are non-streaming in this version (request → full reply).
- On Linux the system webview is WebKitGTK, which lags Chromium — the common Tauri/Wails trade-off.
- Token "savings" for locally-served requests are estimated (≈4 chars/token); Claude figures are exact.

## License

MIT © 2026 Gabriel Teixeira. Inspired by — but not derived from — projects like Odysseus; original code.
