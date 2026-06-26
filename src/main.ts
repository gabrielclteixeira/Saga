import "./style.css";
import {
  api,
  type Accounting,
  type Attachment,
  type ChatMessage,
  type ChatResponse,
  type ConversationMeta,
  type Diagnostics,
  type SearchHit,
  type Settings,
  type StoredMessage,
} from "./api";

interface Item {
  role: "user" | "assistant";
  content: string;
  meta?: ChatResponse;
  error?: boolean;
  attachments?: Attachment[];
  steps?: string[];
  thinking?: string;
}

const state: {
  items: Item[];
  settings: Settings | null;
  busy: boolean;
  conversations: ConversationMeta[];
  currentConversationId: number | null;
  pendingAttachments: Attachment[];
  routeMode: "auto" | "local" | "claude";
  thinking: boolean;
} = {
  items: [],
  settings: null,
  busy: false,
  conversations: [],
  currentConversationId: null,
  pendingAttachments: [],
  routeMode: "auto",
  thinking: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" class="brand-mark" alt="" /> <strong>Saga</strong> <span class="tag">router local ↔ Claude</span></div>
    <div class="mini" id="mini-stats"></div>
    <button class="icon-btn" id="btn-settings" title="Definições">⚙</button>
  </header>
  <main class="layout">
    <aside class="sidebar">
      <button class="new-chat" id="btn-new-chat">+ Nova conversa</button>
      <input class="conv-search" id="conv-search" type="search" placeholder="Pesquisar conversas…" autocomplete="off" />
      <div class="conv-list" id="conv-list"></div>
    </aside>
    <section class="chat">
      <div class="messages" id="messages">
        <div class="empty">Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.</div>
      </div>
      <div class="attachments" id="attachments"></div>
      <div class="route-mode" id="route-mode">
        <button type="button" data-mode="auto" class="active">Auto</button>
        <button type="button" data-mode="local">Local</button>
        <button type="button" data-mode="claude">Claude</button>
        <button type="button" id="btn-think" class="think-toggle" title="Extended thinking (raciocínio) — só Claude API">🧠 Think</button>
      </div>
      <form class="composer" id="composer">
        <button type="button" class="attach-btn" id="btn-attach" title="Anexar imagem">📎</button>
        <input type="file" id="file-input" accept="image/*" multiple hidden />
        <textarea id="input" rows="1" placeholder="Escreve uma mensagem…" autocomplete="off"></textarea>
        <button type="submit" id="send">Enviar</button>
      </form>
    </section>
    <aside class="panel">
      <button class="panel-collapse" id="panel-collapse" title="Ocultar painel" aria-label="Ocultar painel">❯</button>
      <h2>Painel de tokens</h2>
      <div class="cards" id="acct-cards"></div>
      <h3>Memória carregada</h3>
      <pre class="mem" id="mem-preview">—</pre>
      <button class="ghost" id="btn-mem-refresh">Atualizar pré-visualização</button>
    </aside>
  </main>

  <button class="panel-reopen" id="panel-reopen" hidden title="Mostrar painel" aria-label="Mostrar painel">❮</button>

  <aside class="artifact-panel" id="artifact-panel" hidden>
    <header class="artifact-head">
      <span class="artifact-title" id="artifact-title">Artefacto</span>
      <span class="artifact-controls">
        <button type="button" class="ghost" id="artifact-toggle" hidden>Código</button>
        <button type="button" class="ghost" id="artifact-copy">Copiar</button>
        <button type="button" class="ghost" id="artifact-close">✕</button>
      </span>
    </header>
    <div class="artifact-body" id="artifact-body"></div>
  </aside>
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
        <label>Modelo de visão (imagens) <input name="ollama_vision_model" type="text" /></label>
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

      <fieldset>
        <legend>Browser (ferramentas — só modo API)</legend>
        <label class="check"><input name="enable_browser_tools" type="checkbox" /> Ativar ferramentas de browser</label>
        <label>Caminho do sidecar (sidecar/index.js) <input name="browser_sidecar_script" type="text" /></label>
        <label>Executável Node <input name="browser_node_path" type="text" /></label>
        <label>Pasta de dados do browser (sessão persistente) <input name="browser_user_data_dir" type="text" /></label>
      </fieldset>

      <menu>
        <button value="cancel" class="ghost">Cancelar</button>
        <button value="save" id="btn-save" class="primary">Guardar</button>
      </menu>
    </form>
  </dialog>

  <dialog id="wizard-dialog">
    <div class="settings wizard">
      <h2>Bem-vindo ao Saga ⛵</h2>
      <p class="wiz-intro">O Saga corre um modelo local para tarefas leves e escala para o Claude
      quando compensa. Vamos configurar o que precisas — podes mudar tudo depois nas Definições.</p>

      <fieldset>
        <legend>Modelo local (Ollama)</legend>
        <div class="wiz-status" id="wiz-ollama-status">A verificar…</div>
        <label>Endpoint <input id="w_ollama_endpoint" type="text" /></label>
        <label>Modelo <input id="w_ollama_model" type="text" list="ollama-models" /></label>
        <p class="wiz-hint">Sem Ollama? Instala em <strong>ollama.com</strong> e corre
        <code>ollama pull llama3.2</code>.</p>
      </fieldset>

      <fieldset>
        <legend>Claude</legend>
        <div class="wiz-status" id="wiz-claude-status">A verificar…</div>
        <label>Modo
          <select id="w_claude_mode">
            <option value="off">Desligado</option>
            <option value="cli">Claude CLI (subscrição)</option>
            <option value="api">API (key)</option>
          </select>
        </label>
        <label id="wiz-key-wrap" hidden>API key <input id="w_claude_api_key" type="password" /></label>
      </fieldset>

      <menu>
        <button type="button" class="ghost" id="wiz-test">Testar ligações</button>
        <button type="button" class="primary" id="wiz-finish">Começar a usar</button>
      </menu>
      <p class="wiz-skip"><a href="#" id="wiz-skip">Saltar por agora</a></p>
    </div>
  </dialog>
`;

const els = {
  layout: document.querySelector<HTMLElement>(".layout")!,
  messages: document.querySelector<HTMLDivElement>("#messages")!,
  composer: document.querySelector<HTMLFormElement>("#composer")!,
  input: document.querySelector<HTMLTextAreaElement>("#input")!,
  send: document.querySelector<HTMLButtonElement>("#send")!,
  acctCards: document.querySelector<HTMLDivElement>("#acct-cards")!,
  miniStats: document.querySelector<HTMLDivElement>("#mini-stats")!,
  memPreview: document.querySelector<HTMLPreElement>("#mem-preview")!,
  dialog: document.querySelector<HTMLDialogElement>("#settings-dialog")!,
  wizard: document.querySelector<HTMLDialogElement>("#wizard-dialog")!,
  form: document.querySelector<HTMLFormElement>("#settings-form")!,
  modelsList: document.querySelector<HTMLDataListElement>("#ollama-models")!,
  convList: document.querySelector<HTMLDivElement>("#conv-list")!,
  convSearch: document.querySelector<HTMLInputElement>("#conv-search")!,
  attachmentsBar: document.querySelector<HTMLDivElement>("#attachments")!,
  fileInput: document.querySelector<HTMLInputElement>("#file-input")!,
  routeModeBar: document.querySelector<HTMLDivElement>("#route-mode")!,
  artifactPanel: document.querySelector<HTMLElement>("#artifact-panel")!,
  artifactTitle: document.querySelector<HTMLSpanElement>("#artifact-title")!,
  artifactBody: document.querySelector<HTMLDivElement>("#artifact-body")!,
  artifactToggle: document.querySelector<HTMLButtonElement>("#artifact-toggle")!,
  artifactCopy: document.querySelector<HTMLButtonElement>("#artifact-copy")!,
  artifactClose: document.querySelector<HTMLButtonElement>("#artifact-close")!,
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
    const img = document.createElement("img");
    img.className = "empty-panel";
    img.src = "/caravel-panel.svg";
    img.alt = "Saga";
    const p = document.createElement("p");
    p.textContent =
      "Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.";
    empty.appendChild(img);
    empty.appendChild(p);
    els.messages.appendChild(empty);
    return;
  }
  state.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `msg ${item.role}${item.error ? " error" : ""}`;

    if (item.attachments && item.attachments.length) {
      const thumbs = document.createElement("div");
      thumbs.className = "msg-thumbs";
      for (const a of item.attachments) {
        const img = document.createElement("img");
        img.src = `data:${a.media_type};base64,${a.data_base64}`;
        thumbs.appendChild(img);
      }
      row.appendChild(thumbs);
    }

    if (item.steps && item.steps.length) {
      const steps = document.createElement("div");
      steps.className = "tool-steps";
      for (const s of item.steps) {
        const line = document.createElement("div");
        line.className = "tool-step";
        line.textContent = "› " + s;
        steps.appendChild(line);
      }
      row.appendChild(steps);
    }

    if (item.thinking) {
      const det = document.createElement("details");
      det.className = "thinking-block";
      det.open = index === state.items.length - 1 && state.busy;
      const sum = document.createElement("summary");
      sum.textContent = "🧠 raciocínio";
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = item.thinking;
      det.appendChild(sum);
      det.appendChild(body);
      row.appendChild(det);
    }

    if (item.content !== "" || item.role === "assistant") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = item.content;
      row.appendChild(bubble);
    }

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

    // Artefactos: qualquer resposta do assistente com blocos de código/HTML.
    if (item.role === "assistant" && item.content) {
      const blocks = extractCodeBlocks(item.content);
      if (blocks.length) {
        const arow = document.createElement("div");
        arow.className = "artifact-actions";
        blocks.forEach((b, i) => {
          const btn = document.createElement("button");
          btn.textContent =
            `📄 Artefacto${blocks.length > 1 ? " " + (i + 1) : ""}` +
            (b.lang ? " · " + b.lang : "");
          btn.addEventListener("click", () => openArtifact(b));
          arow.appendChild(btn);
        });
        row.appendChild(arow);
      }
    }

    // Barra de ações: só na última resposta do assistente e fora de streaming.
    const isLast = index === state.items.length - 1;
    if (item.role === "assistant" && isLast && !state.busy && !item.error) {
      row.appendChild(buildActions());
    }

    els.messages.appendChild(row);
  });
  els.messages.scrollTop = els.messages.scrollHeight;
}

function buildActions(): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const mk = (label: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };

  actions.appendChild(mk("↻ Regenerar", "Regenerar com a mesma rota", () => regenerate()));
  actions.appendChild(
    mk("⤴ Claude", "Escalar para o Claude", () => regenerate({ routeOverride: "claude" }))
  );

  const sel = document.createElement("select");
  sel.className = "model-pick";
  sel.innerHTML = `
    <option value="">Modelo ▾</option>
    <option value="local">Tentar local</option>
    <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
    <option value="claude-sonnet-4-6">Sonnet 4.6</option>
    <option value="claude-opus-4-8">Opus 4.8</option>`;
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (!v) return;
    if (v === "local") regenerate({ routeOverride: "local" });
    else regenerate({ routeOverride: "claude", modelOverride: v });
    sel.value = "";
  });
  actions.appendChild(sel);

  return actions;
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

// ---- Anexos ----
function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result); // data:<media>;base64,<data>
      const comma = result.indexOf(",");
      const header = result.slice(0, comma);
      const data = result.slice(comma + 1);
      const semi = header.indexOf(";");
      const media = header.slice(5, semi > 0 ? semi : undefined) || file.type || "image/png";
      resolve({ kind: "image", media_type: media, data_base64: data });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderPendingAttachments() {
  els.attachmentsBar.innerHTML = "";
  state.pendingAttachments.forEach((a, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = `data:${a.media_type};base64,${a.data_base64}`;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = "Remover";
    rm.addEventListener("click", () => {
      state.pendingAttachments.splice(idx, 1);
      renderPendingAttachments();
    });
    wrap.appendChild(img);
    wrap.appendChild(rm);
    els.attachmentsBar.appendChild(wrap);
  });
}

async function onFilesSelected() {
  const files = els.fileInput.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    try {
      state.pendingAttachments.push(await fileToAttachment(file));
    } catch (e) {
      console.error("falha a ler ficheiro", e);
    }
  }
  els.fileInput.value = "";
  renderPendingAttachments();
}

/** Colar imagens do clipboard (Ctrl+V / prints). */
async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (const it of Array.from(items)) {
    if (it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (file) {
        handled = true;
        try {
          state.pendingAttachments.push(await fileToAttachment(file));
        } catch (err) {
          console.error("falha a colar imagem", err);
        }
      }
    }
  }
  if (handled) {
    e.preventDefault();
    renderPendingAttachments();
  }
}

// ---- Conversas ----
function renderSidebar() {
  els.convList.innerHTML = "";
  for (const c of state.conversations) {
    const row = document.createElement("div");
    row.className = "conv" + (c.id === state.currentConversationId ? " active" : "");

    const title = document.createElement("span");
    title.className = "conv-title";
    title.textContent = c.title || "Nova conversa";
    title.title = c.title;
    title.addEventListener("click", () => selectConversation(c.id));
    title.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(c, row, title);
    });

    const ren = document.createElement("button");
    ren.className = "conv-act";
    ren.textContent = "✎";
    ren.title = "Renomear";
    ren.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(c, row, title);
    });

    const del = document.createElement("button");
    del.className = "conv-act conv-del";
    del.textContent = "×";
    del.title = "Apagar";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeConversation(c.id);
    });

    row.appendChild(title);
    row.appendChild(ren);
    row.appendChild(del);
    els.convList.appendChild(row);
  }
}

function startRename(c: ConversationMeta, row: HTMLElement, titleEl: HTMLElement) {
  const input = document.createElement("input");
  input.className = "conv-rename";
  input.value = c.title || "";
  row.replaceChild(input, titleEl);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== c.title) {
      try {
        await api.renameConversation(c.id, v);
      } catch (e) {
        console.error(e);
      }
    }
    await loadConversations();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

async function loadConversations() {
  state.conversations = await api.listConversations();
  if (!els.convSearch.value.trim()) renderSidebar();
}

async function onSearch() {
  const q = els.convSearch.value.trim();
  if (!q) {
    renderSidebar();
    return;
  }
  try {
    renderSearchResults(await api.searchChats(q));
  } catch (e) {
    console.error(e);
  }
}

function renderSearchResults(hits: SearchHit[]) {
  els.convList.innerHTML = "";
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "conv-empty";
    empty.textContent = "Sem resultados";
    els.convList.appendChild(empty);
    return;
  }
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "conv search-hit";
    const t = document.createElement("div");
    t.className = "conv-title";
    t.textContent = h.title || "Nova conversa";
    const s = document.createElement("div");
    s.className = "hit-snippet";
    s.textContent = h.snippet;
    row.appendChild(t);
    row.appendChild(s);
    row.addEventListener("click", () => {
      els.convSearch.value = "";
      selectConversation(h.conversation_id);
    });
    els.convList.appendChild(row);
  }
}

function storedToItem(m: StoredMessage): Item {
  let attachments: Attachment[] | undefined;
  if (m.attachments_json && m.attachments_json !== "[]") {
    try {
      attachments = JSON.parse(m.attachments_json) as Attachment[];
    } catch {
      /* ignora JSON inválido */
    }
  }
  if (m.role === "assistant" && m.route) {
    return {
      role: "assistant",
      content: m.content,
      attachments,
      meta: {
        text: m.content,
        route: (m.route as "local" | "claude") || "local",
        model: m.model,
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        tokens_saved: m.tokens_saved,
        cost_usd: m.cost_usd,
        reason: "",
        accounting: {} as Accounting,
      },
    };
  }
  return { role: m.role, content: m.content, attachments };
}

async function selectConversation(id: number) {
  if (state.busy) return;
  state.currentConversationId = id;
  const msgs = await api.getConversation(id);
  state.items = msgs.map(storedToItem);
  renderMessages();
  renderSidebar();
  renderAccounting(await api.conversationAccounting(id));
}

async function createConversation() {
  if (state.busy) return;
  const id = await api.newConversation();
  state.currentConversationId = id;
  state.items = [];
  renderMessages();
  await loadConversations();
  renderAccounting(await api.conversationAccounting(id));
}

async function removeConversation(id: number) {
  await api.deleteConversation(id);
  if (state.currentConversationId === id) {
    state.currentConversationId = null;
    state.items = [];
    renderMessages();
  }
  await loadConversations();
  if (state.currentConversationId === null && state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else if (state.conversations.length === 0) {
    await createConversation();
  }
}

type SendOpts = {
  routeOverride?: "local" | "claude";
  modelOverride?: string;
  regenerate?: boolean;
  thinking?: boolean;
};

function buildPayload(): ChatMessage[] {
  return state.items.map((i) => ({
    role: i.role,
    content: i.content,
    attachments: i.attachments,
  }));
}

function routeOptsFromMode(): SendOpts {
  return state.routeMode === "auto" ? {} : { routeOverride: state.routeMode };
}

/** Empurra uma bolha de assistente e preenche-a com o streaming. */
async function streamAssistant(payload: ChatMessage[], opts: SendOpts) {
  const conversationId = state.currentConversationId!;
  const assistant: Item = { role: "assistant", content: "" };
  state.items.push(assistant);
  renderMessages();
  setBusy(true);

  const paintBubble = () => {
    const b = els.messages.lastElementChild?.querySelector(".bubble") as HTMLDivElement | null;
    if (b) b.textContent = assistant.content;
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const tb = els.messages.lastElementChild?.querySelector(".bubble") as HTMLDivElement | null;
  if (tb) tb.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;

  let start: { route: "local" | "claude"; model: string; reason: string } | null = null;

  try {
    await api.sendMessageStream(
      conversationId,
      payload,
      (evt) => {
        if (evt.kind === "Start") {
          start = { route: evt.route, model: evt.model, reason: evt.reason };
        } else if (evt.kind === "Delta") {
          assistant.content += evt.text;
          paintBubble();
        } else if (evt.kind === "Thinking") {
          assistant.thinking = (assistant.thinking ?? "") + evt.text;
          renderMessages();
        } else if (evt.kind === "ToolStep") {
          assistant.steps = assistant.steps ?? [];
          assistant.steps.push(`${evt.tool} ${evt.detail}`);
          renderMessages();
          paintBubble();
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
        }
      },
      { ...opts, thinking: opts.thinking ?? state.thinking }
    );
  } catch (e) {
    assistant.content = String(e);
    assistant.error = true;
  } finally {
    setBusy(false);
    renderMessages();
    loadConversations(); // atualiza título/ordem na sidebar
    try {
      renderAccounting(await api.conversationAccounting(conversationId));
    } catch {
      /* ignora */
    }
  }
}

async function onSubmit(ev: Event) {
  ev.preventDefault();
  const text = els.input.value.trim();
  if ((!text && state.pendingAttachments.length === 0) || state.busy) return;

  if (state.currentConversationId === null) {
    state.currentConversationId = await api.newConversation();
    await loadConversations();
  }

  const attachments = state.pendingAttachments.slice();
  state.items.push({ role: "user", content: text, attachments });
  state.pendingAttachments = [];
  renderPendingAttachments();
  els.input.value = "";
  els.input.style.height = "auto";

  await streamAssistant(buildPayload(), routeOptsFromMode());
}

/** Regenera a última resposta do assistente (opcionalmente forçando rota/modelo). */
async function regenerate(opts: SendOpts = {}) {
  if (state.busy || state.currentConversationId === null) return;
  if (state.items.length && state.items[state.items.length - 1].role === "assistant") {
    state.items.pop();
  }
  renderMessages();
  await streamAssistant(buildPayload(), { ...opts, regenerate: true });
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
  (f.elements.namedItem("ollama_vision_model") as HTMLInputElement).value = s.ollama_vision_model;
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
  (f.elements.namedItem("enable_browser_tools") as HTMLInputElement).checked =
    s.enable_browser_tools;
  (f.elements.namedItem("browser_sidecar_script") as HTMLInputElement).value =
    s.browser_sidecar_script;
  (f.elements.namedItem("browser_node_path") as HTMLInputElement).value = s.browser_node_path;
  (f.elements.namedItem("browser_user_data_dir") as HTMLInputElement).value =
    s.browser_user_data_dir;
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
    ollama_vision_model: val("ollama_vision_model"),
    claude_mode: val("claude_mode") as Settings["claude_mode"],
    claude_model: val("claude_model"),
    claude_cli_path: val("claude_cli_path"),
    claude_api_key: val("claude_api_key"),
    claude_max_tokens: parseInt(val("claude_max_tokens")) || 2048,
    memory_dir: val("memory_dir"),
    claude_md_path: val("claude_md_path"),
    enable_browser_tools: checked("enable_browser_tools"),
    browser_sidecar_script: val("browser_sidecar_script"),
    browser_node_path: val("browser_node_path"),
    browser_user_data_dir: val("browser_user_data_dir"),
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

// ---- Artefactos ----
function extractCodeBlocks(content: string): { lang: string; code: string }[] {
  const re = /```(\w*)\n([\s\S]*?)```/g;
  const out: { lang: string; code: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const code = m[2].trim();
    if (code.length >= 20) out.push({ lang: (m[1] || "").toLowerCase(), code });
  }
  return out;
}

function isHtmlArtifact(a: { lang: string; code: string }): boolean {
  return a.lang === "html" || /^\s*<!doctype html|^\s*<html[\s>]/i.test(a.code);
}

let artifactMode: "preview" | "code" = "preview";
let artifactCurrent: { lang: string; code: string } | null = null;

function renderArtifactBody() {
  if (!artifactCurrent) return;
  const body = els.artifactBody;
  body.innerHTML = "";
  const html = isHtmlArtifact(artifactCurrent);
  els.artifactToggle.hidden = !html;
  els.artifactToggle.textContent = artifactMode === "preview" ? "Código" : "Pré-visualizar";
  if (html && artifactMode === "preview") {
    const iframe = document.createElement("iframe");
    iframe.className = "artifact-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc = artifactCurrent.code;
    body.appendChild(iframe);
  } else {
    const pre = document.createElement("pre");
    pre.className = "artifact-code";
    pre.textContent = artifactCurrent.code;
    body.appendChild(pre);
  }
}

function openArtifact(a: { lang: string; code: string }) {
  artifactCurrent = a;
  artifactMode = isHtmlArtifact(a) ? "preview" : "code";
  els.artifactTitle.textContent = "Artefacto" + (a.lang ? ` · ${a.lang}` : "");
  els.artifactPanel.hidden = false;
  renderArtifactBody();
}

function closeArtifact() {
  els.artifactPanel.hidden = true;
  artifactCurrent = null;
}

// ---- Wizard de 1.º arranque ----
function wizInput(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("#" + id)!;
}

function mergeWizardSettings(base: Settings): Settings {
  return {
    ...base,
    ollama_endpoint: wizInput("w_ollama_endpoint").value,
    ollama_model: wizInput("w_ollama_model").value,
    claude_mode: document.querySelector<HTMLSelectElement>("#w_claude_mode")!
      .value as Settings["claude_mode"],
    claude_api_key: wizInput("w_claude_api_key").value,
  };
}

function renderDiagnostics(d: Diagnostics) {
  const o = document.querySelector("#wiz-ollama-status")!;
  if (d.ollama_ok) {
    o.className = "wiz-status ok";
    o.textContent =
      `✓ Ollama ligado — ${d.ollama_models.length} modelo(s)` +
      (d.ollama_model_present ? "" : " · modelo configurado não encontrado");
    els.modelsList.innerHTML = d.ollama_models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join("");
  } else {
    o.className = "wiz-status bad";
    o.textContent = "✗ Ollama não detetado neste endpoint";
  }
  const c = document.querySelector("#wiz-claude-status")!;
  c.className = "wiz-status " + (d.claude_ready ? "ok" : "bad");
  c.textContent = (d.claude_ready ? "✓ " : "✗ ") + d.claude_detail;
}

async function runWizardTest() {
  const next = mergeWizardSettings(state.settings!);
  try {
    await api.saveSettings(next);
    state.settings = next;
  } catch (e) {
    console.error(e);
  }
  try {
    renderDiagnostics(await api.diagnostics());
  } catch (e) {
    console.error(e);
  }
}

async function openWizard() {
  const s = state.settings!;
  wizInput("w_ollama_endpoint").value = s.ollama_endpoint;
  wizInput("w_ollama_model").value = s.ollama_model;
  document.querySelector<HTMLSelectElement>("#w_claude_mode")!.value = s.claude_mode;
  wizInput("w_claude_api_key").value = s.claude_api_key;
  document.querySelector("#wiz-key-wrap")!.toggleAttribute("hidden", s.claude_mode !== "api");
  els.wizard.showModal();
  runWizardTest();
}

async function finishWizard() {
  const next = { ...mergeWizardSettings(state.settings!), onboarding_done: true };
  try {
    await api.saveSettings(next);
    state.settings = next;
  } catch (e) {
    alert("Falha a guardar definições: " + e);
  }
  els.wizard.close();
  await refreshMemory();
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
  document.querySelector("#btn-mem-refresh")!.addEventListener("click", refreshMemory);
  document.querySelector("#btn-new-chat")!.addEventListener("click", createConversation);
  els.convSearch.addEventListener("input", onSearch);
  document.querySelector("#btn-attach")!.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", onFilesSelected);
  els.input.addEventListener("paste", onPaste);
  const panelReopen = document.querySelector<HTMLElement>("#panel-reopen")!;
  const setPanel = (collapsed: boolean) => {
    els.layout.classList.toggle("panel-collapsed", collapsed);
    panelReopen.hidden = !collapsed;
    localStorage.setItem("saga.panelCollapsed", collapsed ? "1" : "0");
  };
  document.querySelector("#panel-collapse")!.addEventListener("click", () => setPanel(true));
  panelReopen.addEventListener("click", () => setPanel(false));
  setPanel(localStorage.getItem("saga.panelCollapsed") === "1");
  document.querySelector("#wiz-test")!.addEventListener("click", runWizardTest);
  document.querySelector("#wiz-finish")!.addEventListener("click", finishWizard);
  document.querySelector("#wiz-skip")!.addEventListener("click", (e) => {
    e.preventDefault();
    finishWizard();
  });
  document.querySelector("#w_claude_mode")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    document.querySelector("#wiz-key-wrap")!.toggleAttribute("hidden", v !== "api");
  });
  els.routeModeBar.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.routeMode = (btn.dataset.mode as "auto" | "local" | "claude") ?? "auto";
      els.routeModeBar
        .querySelectorAll("button[data-mode]")
        .forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  document.querySelector("#btn-think")!.addEventListener("click", (e) => {
    state.thinking = !state.thinking;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.thinking);
  });
  els.artifactClose.addEventListener("click", closeArtifact);
  els.artifactToggle.addEventListener("click", () => {
    artifactMode = artifactMode === "preview" ? "code" : "preview";
    renderArtifactBody();
  });
  els.artifactCopy.addEventListener("click", () => {
    if (artifactCurrent) navigator.clipboard?.writeText(artifactCurrent.code);
  });
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
    await refreshMemory();
    await loadConversations();
    if (state.conversations.length === 0) {
      await createConversation();
    } else {
      await selectConversation(state.conversations[0].id);
    }
    if (state.settings && !state.settings.onboarding_done) {
      openWizard();
    }
  } catch (e) {
    console.error(e);
  }
}

init();
