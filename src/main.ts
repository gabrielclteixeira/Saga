import "./style.css";
import {
  api,
  type Accounting,
  type ChatMessage,
  type ChatResponse,
  type Settings,
} from "./api";

interface Item {
  role: "user" | "assistant";
  content: string;
  meta?: ChatResponse;
  error?: boolean;
}

const state: { items: Item[]; settings: Settings | null; busy: boolean } = {
  items: [],
  settings: null,
  busy: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">⟁ <strong>Janus</strong> <span class="tag">router local ↔ Claude</span></div>
    <div class="mini" id="mini-stats"></div>
    <button class="icon-btn" id="btn-settings" title="Definições">⚙</button>
  </header>
  <main class="layout">
    <section class="chat">
      <div class="messages" id="messages">
        <div class="empty">Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.</div>
      </div>
      <form class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="Escreve uma mensagem…" autocomplete="off"></textarea>
        <button type="submit" id="send">Enviar</button>
      </form>
    </section>
    <aside class="panel">
      <h2>Painel de tokens</h2>
      <div class="cards" id="acct-cards"></div>
      <button class="ghost" id="btn-reset">Repor contadores</button>
      <h3>Memória carregada</h3>
      <pre class="mem" id="mem-preview">—</pre>
      <button class="ghost" id="btn-mem-refresh">Atualizar pré-visualização</button>
    </aside>
  </main>
  <dialog id="settings-dialog">
    <form method="dialog" class="settings" id="settings-form">
      <h2>Definições</h2>

      <fieldset>
        <legend>Modelo local (Ollama)</legend>
        <label>Endpoint <input name="ollama_endpoint" type="text" /></label>
        <label>Modelo
          <span class="row">
            <input name="ollama_model" type="text" list="ollama-models" />
            <button type="button" class="ghost" id="btn-list-models">Listar</button>
          </span>
        </label>
        <datalist id="ollama-models"></datalist>
      </fieldset>

      <fieldset>
        <legend>Claude</legend>
        <label>Modo
          <select name="claude_mode">
            <option value="off">Desligado</option>
            <option value="cli">Claude CLI (subscrição)</option>
            <option value="api">API (ANTHROPIC_API_KEY)</option>
          </select>
        </label>
        <label>Modelo
          <select id="claude-model-preset">
            <option value="claude-haiku-4-5-20251001">Haiku 4.5 — rápido e barato</option>
            <option value="claude-sonnet-4-6">Sonnet 4.6 — equilíbrio</option>
            <option value="claude-opus-4-8">Opus 4.8 — topo</option>
            <option value="claude-fable-5">Fable 5 — mais capaz</option>
            <option value="__custom__">Personalizado…</option>
          </select>
        </label>
        <label id="claude-model-custom-wrap" hidden>Modelo (ID personalizado)
          <input name="claude_model" type="text" />
        </label>
        <label>Caminho da CLI <input name="claude_cli_path" type="text" /></label>
        <label>API key <input name="claude_api_key" type="password" /></label>
        <label>Max tokens (resposta) <input name="claude_max_tokens" type="number" min="256" /></label>
      </fieldset>

      <fieldset>
        <legend>Router</legend>
        <label class="check"><input name="routing_enabled" type="checkbox" /> Router ativo</label>
        <label class="check"><input name="use_local_classifier" type="checkbox" /> Usar classificador local (LEVE/PESADO)</label>
        <label>Limite "leve" (chars) <input name="light_max_chars" type="number" min="0" /></label>
        <label>Palavras-chave → local <input name="force_local_keywords" type="text" /></label>
        <label>Palavras-chave → Claude <input name="force_claude_keywords" type="text" /></label>
      </fieldset>

      <fieldset>
        <legend>Memória</legend>
        <label>Pasta de memória <input name="memory_dir" type="text" /></label>
        <label>Caminho CLAUDE.md (opcional) <input name="claude_md_path" type="text" /></label>
      </fieldset>

      <menu>
        <button value="cancel" class="ghost">Cancelar</button>
        <button value="save" id="btn-save" class="primary">Guardar</button>
      </menu>
    </form>
  </dialog>
`;

const els = {
  messages: document.querySelector<HTMLDivElement>("#messages")!,
  composer: document.querySelector<HTMLFormElement>("#composer")!,
  input: document.querySelector<HTMLTextAreaElement>("#input")!,
  send: document.querySelector<HTMLButtonElement>("#send")!,
  acctCards: document.querySelector<HTMLDivElement>("#acct-cards")!,
  miniStats: document.querySelector<HTMLDivElement>("#mini-stats")!,
  memPreview: document.querySelector<HTMLPreElement>("#mem-preview")!,
  dialog: document.querySelector<HTMLDialogElement>("#settings-dialog")!,
  form: document.querySelector<HTMLFormElement>("#settings-form")!,
  modelsList: document.querySelector<HTMLDataListElement>("#ollama-models")!,
  claudeModelPreset: document.querySelector<HTMLSelectElement>("#claude-model-preset")!,
  claudeModelCustomWrap: document.querySelector<HTMLLabelElement>("#claude-model-custom-wrap")!,
};

const CLAUDE_MODEL_PRESETS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-fable-5",
];

/** Sincroniza o dropdown de presets com o input de texto `claude_model`. */
function syncClaudeModelControls(model: string) {
  const input = els.form.elements.namedItem("claude_model") as HTMLInputElement;
  input.value = model;
  if (CLAUDE_MODEL_PRESETS.includes(model)) {
    els.claudeModelPreset.value = model;
    els.claudeModelCustomWrap.hidden = true;
  } else {
    els.claudeModelPreset.value = "__custom__";
    els.claudeModelCustomWrap.hidden = false;
  }
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(n < 0.01 ? 5 : 4);
}

function fmtInt(n: number): string {
  return n.toLocaleString("pt-PT");
}

function renderMessages() {
  els.messages.innerHTML = "";
  if (state.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.";
    els.messages.appendChild(empty);
    return;
  }
  for (const item of state.items) {
    const row = document.createElement("div");
    row.className = `msg ${item.role}${item.error ? " error" : ""}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = item.content;
    row.appendChild(bubble);

    if (item.meta) {
      const m = item.meta;
      const meta = document.createElement("div");
      meta.className = `meta route-${m.route}`;
      const badge = m.route === "local" ? "● LOCAL" : "▲ CLAUDE";
      const bits = [
        `<span class="badge">${badge}</span>`,
        `<span>${escapeHtml(m.model)}</span>`,
        `<span>${fmtInt(m.input_tokens)}↓ / ${fmtInt(m.output_tokens)}↑ tok</span>`,
      ];
      if (m.route === "claude") {
        bits.push(`<span>${fmtUsd(m.cost_usd)}</span>`);
        if (m.tokens_saved > 0)
          bits.push(`<span class="saved">−${fmtInt(m.tokens_saved)} tok poupados</span>`);
      }
      bits.push(`<span class="reason">${escapeHtml(m.reason)}</span>`);
      meta.innerHTML = bits.join("");
      row.appendChild(meta);
    }
    els.messages.appendChild(row);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderAccounting(a: Accounting) {
  const cards: [string, string, string?][] = [
    ["Pedidos locais", fmtInt(a.local_requests), "grátis"],
    ["Pedidos Claude", fmtInt(a.claude_requests)],
    ["Tokens servidos localmente", fmtInt(a.tokens_served_local), "que não foram ao Claude"],
    ["Tokens poupados (compressão)", fmtInt(a.tokens_saved_compression)],
    ["Tokens Claude", `${fmtInt(a.claude_input_tokens)}↓ / ${fmtInt(a.claude_output_tokens)}↑`],
    ["Custo Claude", fmtUsd(a.claude_cost_usd)],
  ];
  els.acctCards.innerHTML = cards
    .map(
      ([label, value, hint]) => `
      <div class="card">
        <div class="card-value">${value}</div>
        <div class="card-label">${label}</div>
        ${hint ? `<div class="card-hint">${hint}</div>` : ""}
      </div>`
    )
    .join("");

  els.miniStats.innerHTML = `
    <span title="Tokens servidos localmente">⬡ ${fmtInt(
      a.tokens_served_local + a.tokens_saved_compression
    )} tok poupados</span>
    <span title="Custo acumulado no Claude">▲ ${fmtUsd(a.claude_cost_usd)}</span>`;
}

async function refreshMemory() {
  try {
    const preview = await api.getMemoryPreview();
    els.memPreview.textContent = preview.trim() || "(sem memória — define a pasta nas definições)";
  } catch (e) {
    els.memPreview.textContent = String(e);
  }
}

async function onSubmit(ev: Event) {
  ev.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy) return;

  state.items.push({ role: "user", content: text });
  els.input.value = "";
  els.input.style.height = "auto";

  // Payload com o histórico até à mensagem do utilizador (antes do placeholder).
  const payload: ChatMessage[] = state.items.map((i) => ({
    role: i.role,
    content: i.content,
  }));

  // Bolha do assistente (vazia) que vai receber o streaming.
  const assistant: Item = { role: "assistant", content: "" };
  state.items.push(assistant);
  renderMessages();
  setBusy(true);

  const bubbleEl = els.messages.lastElementChild?.querySelector(
    ".bubble"
  ) as HTMLDivElement | null;
  if (bubbleEl) {
    bubbleEl.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;
  }

  let start: { route: "local" | "claude"; model: string; reason: string } | null = null;
  let firstDelta = true;

  try {
    await api.sendMessageStream(payload, (evt) => {
      if (evt.kind === "Start") {
        start = { route: evt.route, model: evt.model, reason: evt.reason };
      } else if (evt.kind === "Delta") {
        if (firstDelta && bubbleEl) {
          bubbleEl.textContent = "";
          firstDelta = false;
        }
        assistant.content += evt.text;
        if (bubbleEl) bubbleEl.textContent = assistant.content;
        els.messages.scrollTop = els.messages.scrollHeight;
      } else if (evt.kind === "Done") {
        assistant.meta = {
          text: assistant.content,
          route: start?.route ?? "local",
          model: start?.model ?? "",
          input_tokens: evt.input_tokens,
          output_tokens: evt.output_tokens,
          tokens_saved: evt.tokens_saved,
          cost_usd: evt.cost_usd,
          reason: start?.reason ?? "",
          accounting: evt.accounting,
        };
        renderAccounting(evt.accounting);
      }
    });
  } catch (e) {
    assistant.content = String(e);
    assistant.error = true;
  } finally {
    setBusy(false);
    renderMessages();
  }
}

function setBusy(b: boolean) {
  state.busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
}

// ---- Settings ----
function settingsToForm(s: Settings) {
  const f = els.form;
  (f.elements.namedItem("ollama_endpoint") as HTMLInputElement).value = s.ollama_endpoint;
  (f.elements.namedItem("ollama_model") as HTMLInputElement).value = s.ollama_model;
  (f.elements.namedItem("claude_mode") as HTMLSelectElement).value = s.claude_mode;
  syncClaudeModelControls(s.claude_model);
  (f.elements.namedItem("claude_cli_path") as HTMLInputElement).value = s.claude_cli_path;
  (f.elements.namedItem("claude_api_key") as HTMLInputElement).value = s.claude_api_key;
  (f.elements.namedItem("claude_max_tokens") as HTMLInputElement).value = String(s.claude_max_tokens);
  (f.elements.namedItem("routing_enabled") as HTMLInputElement).checked = s.routing.enabled;
  (f.elements.namedItem("use_local_classifier") as HTMLInputElement).checked =
    s.routing.use_local_classifier;
  (f.elements.namedItem("light_max_chars") as HTMLInputElement).value = String(
    s.routing.light_max_chars
  );
  (f.elements.namedItem("force_local_keywords") as HTMLInputElement).value =
    s.routing.force_local_keywords.join(", ");
  (f.elements.namedItem("force_claude_keywords") as HTMLInputElement).value =
    s.routing.force_claude_keywords.join(", ");
  (f.elements.namedItem("memory_dir") as HTMLInputElement).value = s.memory_dir;
  (f.elements.namedItem("claude_md_path") as HTMLInputElement).value = s.claude_md_path;
}

function formToSettings(base: Settings): Settings {
  const f = els.form;
  const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
  const checked = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).checked;
  const csv = (n: string) =>
    val(n)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return {
    ...base,
    ollama_endpoint: val("ollama_endpoint"),
    ollama_model: val("ollama_model"),
    claude_mode: val("claude_mode") as Settings["claude_mode"],
    claude_model: val("claude_model"),
    claude_cli_path: val("claude_cli_path"),
    claude_api_key: val("claude_api_key"),
    claude_max_tokens: parseInt(val("claude_max_tokens")) || 2048,
    memory_dir: val("memory_dir"),
    claude_md_path: val("claude_md_path"),
    routing: {
      enabled: checked("routing_enabled"),
      use_local_classifier: checked("use_local_classifier"),
      light_max_chars: parseInt(val("light_max_chars")) || 280,
      force_local_keywords: csv("force_local_keywords"),
      force_claude_keywords: csv("force_claude_keywords"),
    },
  };
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

async function init() {
  els.composer.addEventListener("submit", onSubmit);
  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  document.querySelector("#btn-settings")!.addEventListener("click", () => {
    if (state.settings) settingsToForm(state.settings);
    els.dialog.showModal();
  });
  document.querySelector("#btn-reset")!.addEventListener("click", async () => {
    renderAccounting(await api.resetAccounting());
  });
  document.querySelector("#btn-mem-refresh")!.addEventListener("click", refreshMemory);
  els.claudeModelPreset.addEventListener("change", () => {
    const v = els.claudeModelPreset.value;
    const input = els.form.elements.namedItem("claude_model") as HTMLInputElement;
    if (v === "__custom__") {
      els.claudeModelCustomWrap.hidden = false;
      input.focus();
    } else {
      els.claudeModelCustomWrap.hidden = true;
      input.value = v;
    }
  });
  document.querySelector("#btn-list-models")!.addEventListener("click", async () => {
    try {
      const models = await api.listOllamaModels();
      els.modelsList.innerHTML = models
        .map((m) => `<option value="${escapeHtml(m)}"></option>`)
        .join("");
    } catch (e) {
      alert("Falha a listar modelos do Ollama: " + e);
    }
  });

  els.form.addEventListener("submit", async (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "save" && state.settings) {
      const next = formToSettings(state.settings);
      try {
        await api.saveSettings(next);
        state.settings = next;
        await refreshMemory();
      } catch (err) {
        alert("Falha a guardar definições: " + err);
      }
    }
  });

  try {
    state.settings = await api.getSettings();
    renderAccounting(await api.getAccounting());
    await refreshMemory();
  } catch (e) {
    console.error(e);
  }
}

init();
