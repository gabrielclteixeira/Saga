import "./style.css";
import { caravelLoader } from "./caravel-loader";
import { initZoom, nudgeZoom, onZoomChange, resetZoom } from "./zoom";
import { initLang, getLang, setLang, t } from "./i18n";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import mermaid from "mermaid";
import { save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  type Accounting,
  type ActionLogEntry,
  type Attachment,
  type ChatMessage,
  type ChatResponse,
  type ConversationMeta,
  type Diagnostics,
  type DocMeta,
  type McpServerConfig,
  type OllamaModel,
  type RegistryModel,
  type Schedule,
  type SearchHit,
  type Settings,
  type StoredMessage,
} from "./api";

marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if ((node as Element).tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: prefersDark ? "dark" : "neutral",
});
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}
/** Realça os blocos de código (hljs) dentro de um elemento já renderizado. */
function highlightWithin(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("pre code").forEach((el) => {
    if (el.dataset.hl) return;
    hljs.highlightElement(el);
    el.dataset.hl = "1";
  });
}

interface Item {
  id?: number; // id da mensagem na BD (ausente = ainda não persistida)
  role: "user" | "assistant";
  content: string;
  meta?: ChatResponse;
  error?: boolean;
  attachments?: Attachment[];
  steps?: string[];
  thinking?: string;
  report?: boolean;
}

const state: {
  items: Item[];
  settings: Settings | null;
  busy: boolean;
  conversations: ConversationMeta[];
  currentConversationId: number | null;
  pendingAttachments: Attachment[];
  routeMode: "local" | "claude";
  thinking: boolean;
  research: boolean;
  subagents: boolean;
  compactedSummary: string;
  compactedUpto: number; // id da última mensagem compactada (0 = sem compactação)
  activeAgent: { name: string; system: string } | null;
} = {
  items: [],
  settings: null,
  busy: false,
  conversations: [],
  currentConversationId: null,
  pendingAttachments: [],
  routeMode: "local",
  thinking: false,
  research: false,
  subagents: false,
  compactedSummary: "",
  compactedUpto: 0,
  activeAgent: null,
};

/** Ícones monocromáticos inline (estilo do rail: currentColor, 1em). Definido ANTES do
 *  template (app.innerHTML chama icon()), senão dá ReferenceError de TDZ no arranque. */
const ICON_PATHS: Record<string, string> = {
  search: `<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  nodes: `<circle cx="6" cy="12" r="2.3"/><circle cx="18" cy="6" r="2.3"/><circle cx="18" cy="18" r="2.3"/><line x1="8.1" y1="10.9" x2="15.9" y2="7.1"/><line x1="8.1" y1="13.1" x2="15.9" y2="16.9"/>`,
  brain: `<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.2 1 2.5h6c0-1.3.2-1.8 1-2.5A6 6 0 0 0 12 3z"/>`,
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
  tool: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.3 6.3a2.1 2.1 0 0 1-3-3l6.3-6.3a6 6 0 0 1 7.9-7.9l-3.1 3.1z"/>`,
  hash: `<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>`,
  refresh: `<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>`,
  escalate: `<line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/>`,
  pencil: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>`,
  doc: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>`,
  play: `<polygon points="6 4 20 12 6 20 6 4"/>`,
  sparkles: `<path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="M18 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`,
};
function icon(name: string): string {
  const p = ICON_PATHS[name];
  return p
    ? `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
    : "";
}

initLang();
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" class="brand-mark" alt="" /> <strong>Saga</strong></div>
    <div class="mini" id="mini-stats"></div>
    <button class="icon-btn" id="btn-export-saga" title="${t("Exportar Saga (Markdown)")}">⤓</button>
    <button class="icon-btn" id="btn-settings" title="${t("Definições")}">⚙</button>
  </header>
  <main class="layout">
    <nav class="rail" id="rail">
      <button type="button" class="rail-btn active" data-view="sagas" title="Sagas"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg></span><span class="rail-lbl">${t("Sagas")}</span></button>
      <button type="button" class="rail-btn" data-view="workspace" title="${t("Workspace (skills, playbooks, workflows)")}"><span class="rail-ico">✦</span><span class="rail-lbl">${t("Workspace")}</span></button>
      <button type="button" class="rail-btn" data-view="servers" title="${t("Servidores MCP")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="6.5" y1="7.5" x2="6.5" y2="7.5"/><line x1="6.5" y1="16.5" x2="6.5" y2="16.5"/></svg></span><span class="rail-lbl">${t("Servidores")}</span></button>
      <button type="button" class="rail-btn" data-view="activity" title="${t("Atividade (ações)")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4.5" y1="6" x2="4.5" y2="6"/><line x1="4.5" y1="12" x2="4.5" y2="12"/><line x1="4.5" y1="18" x2="4.5" y2="18"/></svg></span><span class="rail-lbl">${t("Atividade")}</span></button>
      <button type="button" class="rail-btn" data-view="automations" title="${t("Automações agendadas")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.7l3 1.8"/></svg></span><span class="rail-lbl">${t("Automações")}</span></button>
      <button type="button" class="rail-btn" data-view="models" title="${t("Modelos (instalar/configurar)")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg></span><span class="rail-lbl">${t("Modelos")}</span></button>
    </nav>
    <aside class="sidebar">
      <button class="new-chat" id="btn-new-chat">${t("+ Nova Saga")}</button>
      <input class="conv-search" id="conv-search" type="search" placeholder="${t("Pesquisar Sagas…")}" autocomplete="off" />
      <div class="conv-list" id="conv-list"></div>
    </aside>
    <div class="center" id="center">
    <section class="chat">
      <div class="messages" id="messages">
        <div class="empty">${t("Faz uma pergunta. Corre no teu modelo local; escala para o Claude quando quiseres.")}</div>
      </div>
      <div class="attachments" id="attachments"></div>
      <div class="route-mode" id="route-mode">
        <span class="route-pick" id="route-pick" hidden>
          <button type="button" data-mode="local" class="active">${t("Local")}</button>
          <button type="button" data-mode="claude">${t("Claude")}</button>
        </span>
        <span class="composer-toggles">
          <button type="button" id="btn-agent" class="chip-toggle" title="${t("Escolher um agente (persona)")}">${icon("sparkles")}<span id="btn-agent-label">${t("Agente")}</span></button>
          <button type="button" id="btn-subagents" class="chip-toggle" title="${t("Subagentes (API: orquestra em paralelo · CLI: ferramenta Task)")}">${icon("nodes")}<span>${t("Subagentes")}</span></button>
          <button type="button" id="btn-research" class="chip-toggle" title="${t("Pesquisa web (API: web_search · CLI: WebSearch)")}">${icon("search")}<span>${t("Pesquisar")}</span></button>
          <button type="button" id="btn-think" class="chip-toggle" title="${t("Extended thinking (raciocínio) — só Claude API")}">${icon("brain")}<span>${t("Think")}</span></button>
        </span>
      </div>
      <div class="slash-menu" id="slash-menu" hidden></div>
      <form class="composer" id="composer">
        <button type="button" class="attach-btn" id="btn-attach" title="${t("Anexar imagem")}" aria-label="${t("Anexar imagem")}"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <input type="file" id="file-input" accept="image/*" multiple hidden />
        <textarea id="input" rows="1" placeholder="${t("Escreve uma mensagem…")}" autocomplete="off"></textarea>
        <button type="submit" id="send">${t("Enviar")}</button>
      </form>
    </section>
    </div>
    <aside class="panel">
      <button class="panel-collapse" id="panel-collapse" title="${t("Ocultar painel")}" aria-label="${t("Ocultar painel")}">❯</button>
      <h2>${t("Painel de tokens")}</h2>
      <div class="cards" id="acct-cards"></div>
      <div class="saga-actions">
        <span class="ctx-est" id="ctx-est" title="${t("Contexto enviado ao modelo (estimativa)")}"></span>
        <span class="saga-actions-btns">
          <button class="ghost" id="btn-compact" title="${t("Resumir as mensagens antigas com o modelo local para poupar contexto")}">${t("Compactar")}</button>
          <button class="ghost" id="btn-clear-saga" title="${t("Apagar as mensagens desta Saga")}">${t("Limpar")}</button>
        </span>
      </div>
      <h3>${t("Memória carregada")}</h3>
      <pre class="mem" id="mem-preview">—</pre>
      <button class="ghost" id="btn-mem-refresh">${t("Atualizar pré-visualização")}</button>
    </aside>
  </main>

  <button class="panel-reopen" id="panel-reopen" hidden title="${t("Mostrar painel")}" aria-label="${t("Mostrar painel")}">❮</button>

  <div class="dl-toast" id="dl-toast" hidden>
    <div class="dl-toast-label" id="dl-toast-label"></div>
    <div class="dl-toast-bar-wrap"><div class="dl-toast-bar" id="dl-toast-bar"></div></div>
  </div>

  <aside class="artifact-panel" id="artifact-panel" hidden>
    <header class="artifact-head">
      <span class="artifact-title" id="artifact-title">${t("Artefacto")}</span>
      <span class="artifact-controls">
        <button type="button" class="ghost" id="artifact-gallery">${t("Galeria")}</button>
        <button type="button" class="ghost" id="artifact-toggle" hidden>${t("Código")}</button>
        <button type="button" class="ghost" id="artifact-pdf">${t("PDF")}</button>
        <button type="button" class="ghost" id="artifact-export">${t("Guardar")}</button>
        <button type="button" class="ghost" id="artifact-copy">${t("Copiar")}</button>
        <button type="button" class="ghost" id="artifact-close">✕</button>
      </span>
    </header>
    <div class="artifact-body" id="artifact-body"></div>
  </aside>
  <dialog id="settings-dialog">
    <form method="dialog" class="settings" id="settings-form">
      <h2>${t("Definições")}</h2>

      <fieldset>
        <legend>${t("Aparência")}</legend>
        <label>${t("Idioma")}
          <select id="lang-select">
            <option value="pt">${t("Português")}</option>
            <option value="en">${t("English")}</option>
          </select>
        </label>
        <label>${t("Zoom da interface")}
          <span class="row zoom-row">
            <button type="button" class="ghost" id="zoom-out" aria-label="${t("Reduzir zoom")}">−</button>
            <span class="zoom-val" id="zoom-val">100%</span>
            <button type="button" class="ghost" id="zoom-in" aria-label="${t("Aumentar zoom")}">+</button>
            <button type="button" class="ghost" id="zoom-reset">${t("Repor")}</button>
          </span>
        </label>
        <p class="wiz-hint">${t("Atalhos: <strong>Ctrl/⌘ +</strong>, <strong>Ctrl/⌘ −</strong>, <strong>Ctrl/⌘ 0</strong> (ou Ctrl/⌘ + roda do rato).")}</p>
        <label>${t("Tamanho do texto")}
          <span class="row zoom-row">
            <button type="button" class="ghost" id="font-out" aria-label="${t("Texto menor")}">A−</button>
            <span class="zoom-val" id="font-val">100%</span>
            <button type="button" class="ghost" id="font-in" aria-label="${t("Texto maior")}">A+</button>
            <button type="button" class="ghost" id="font-reset">${t("Repor")}</button>
          </span>
        </label>
        <p class="wiz-hint">${t("Ajusta só o texto das mensagens e do compositor (o zoom escala toda a interface).")}</p>
      </fieldset>

      <fieldset>
        <legend>${t("Atualizações")}</legend>
        <button type="button" class="ghost" id="btn-check-update">${t("Verificar atualizações")}</button>
        <div class="pull-status" id="update-status"></div>
      </fieldset>

      <p class="settings-about">
        <img src="/favicon.svg" alt="" class="about-mark" />
        Saga <span id="about-version"></span> · ${t("feito por")}
        <a href="https://github.com/gabrielclteixeira" target="_blank" rel="noopener noreferrer">Gabriel Teixeira</a>
      </p>

      <menu>
        <button value="cancel" class="ghost">${t("Fechar")}</button>
      </menu>
    </form>
  </dialog>

  <dialog id="workspace-dialog">
    <div class="settings ws">
      <h2>${t("Workspace")}</h2>
      <div class="ws-tabs" id="ws-tabs">
        <button type="button" class="ws-tab active" data-kind="skill">${t("Skills")}</button>
        <button type="button" class="ws-tab" data-kind="playbook">${t("Playbooks")}</button>
        <button type="button" class="ws-tab" data-kind="workflow">${t("Workflows")}</button>
        <button type="button" class="ws-tab" data-kind="agent">${t("Agents")}</button>
      </div>
      <p class="ws-help" id="ws-help"></p>
      <div class="ws-body">
        <div class="ws-list" id="ws-list"></div>
        <div class="ws-editor" id="ws-editor" hidden>
          <div class="ws-gen">
            <label>${icon("sparkles")} ${t("Gerar com IA — descreve o que queres")}
              <textarea id="ws-gen-prompt" rows="2" placeholder="${t("ex.: uma skill que resume páginas web")}"></textarea>
            </label>
            <button type="button" class="ghost" id="ws-gen-btn">${t("Gerar")}</button>
            <span class="pull-status" id="ws-gen-status"></span>
          </div>
          <label>${t("Nome")} <input id="ws-name" type="text" placeholder="${t("nome-sem-espacos")}" /></label>
          <label>${t("Descrição")} <input id="ws-desc" type="text" placeholder="${t("o que é / quando usar")}" /></label>
          <label id="ws-triggers-wrap">${t("Triggers (palavras que ativam)")} <input id="ws-triggers" type="text" placeholder="${t("resumir, o que diz este link, …")}" /></label>
          <label id="ws-arghint-wrap" hidden>${t("Argumentos esperados")} <input id="ws-arghint" type="text" placeholder="${t("ex.: o URL a abrir")}" /></label>
          <fieldset id="ws-agent-wrap" class="ws-agent-fields" hidden>
            <legend>${t("Predefinições do agente")}</legend>
            <label class="ws-inline">${t("Escalar para")}
              <select id="ws-agent-route">
                <option value="local">${t("Modelo local")}</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label class="ws-check"><input type="checkbox" id="ws-agent-tools" /> ${t("Ferramentas (web, ficheiros)")}</label>
            <label class="ws-check"><input type="checkbox" id="ws-agent-research" /> ${t("Pesquisa aprofundada")}</label>
            <label class="ws-check"><input type="checkbox" id="ws-agent-subagents" /> ${t("Subagentes")}</label>
          </fieldset>
          <label id="ws-body-label">${t("Corpo (markdown)")}
            <textarea id="ws-content" rows="12" spellcheck="false" placeholder="${t("# Instruções…")}"></textarea>
          </label>
          <div class="ws-editor-bar">
            <button type="button" class="ghost" id="ws-cancel">${t("Fechar editor")}</button>
            <button type="button" class="primary" id="ws-save">${t("Guardar")}</button>
          </div>
        </div>
      </div>
      <menu>
        <button type="button" class="ghost" id="ws-new">${t("+ Novo")}</button>
        <button type="button" class="ghost" id="ws-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="mcp-dialog">
    <div class="settings">
      <h2>${t("Servidores MCP")}</h2>
      <p class="wiz-intro">${t("A Saga liga-se a servidores MCP (stdio) e o modelo pode chamar as ferramentas deles. Os segredos do env são guardados na keychain do sistema.")}</p>
      <div class="mcp-list" id="mcp-list"></div>
      <fieldset>
        <legend id="mcp-form-legend">${t("Novo servidor")}</legend>
        <label>${t("Nome")} <input id="mcp-name" type="text" placeholder="${t("ex.: filesystem")}" /></label>
        <label>${t("Comando")} <input id="mcp-command" type="text" placeholder="${t("ex.: npx")}" /></label>
        <label>${t("Argumentos (um por linha)")} <textarea id="mcp-args" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/caminho"></textarea></label>
        <label>${t("Env (KEY=VALUE, um por linha)")} <textarea id="mcp-env" rows="2" spellcheck="false" placeholder="TOKEN=abc"></textarea></label>
        <label class="check"><input id="mcp-enabled" type="checkbox" checked /> ${t("Ativo")}</label>
        <div class="ws-editor-bar">
          <button type="button" class="ghost" id="mcp-test">${t("Testar ligação")}</button>
          <button type="button" class="primary" id="mcp-add">${t("Guardar servidor")}</button>
        </div>
        <div class="pull-status" id="mcp-status"></div>
      </fieldset>
      <menu>
        <button type="button" class="ghost" id="mcp-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="activity-dialog">
    <div class="settings">
      <h2>${t("Atividade desta Saga")}</h2>
      <div class="act-list" id="act-list"></div>
      <menu>
        <button type="button" class="ghost" id="act-refresh">${t("Atualizar")}</button>
        <button type="button" class="ghost" id="act-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="automations-dialog">
    <div class="settings">
      <h2>${t("Automações agendadas")}</h2>
      <p class="wiz-intro">${t("Corre um workflow num horário. As ações são executadas automaticamente e registadas; o resultado vai para a Saga \"Automações\" + notificação. Só corre com a app aberta.")}</p>
      <div class="mcp-list" id="sched-list"></div>
      <fieldset>
        <legend id="sched-form-legend">${t("Novo agendamento")}</legend>
        <label>${t("Nome")} <input id="sched-name" type="text" placeholder="${t("ex.: Login diário")}" /></label>
        <label>${t("Workflow")} <select id="sched-workflow"></select></label>
        <label>${t("Argumentos")} <input id="sched-args" type="text" placeholder="${t("(opcional)")}" /></label>
        <label>${t("Frequência")}
          <select id="sched-preset">
            <option value="0 0 9 * * *">${t("Todos os dias às 9h")}</option>
            <option value="0 0 9 * * Mon-Fri">${t("Dias úteis às 9h")}</option>
            <option value="0 0 * * * *">${t("De hora a hora")}</option>
            <option value="0 */5 * * * *">${t("A cada 5 minutos")}</option>
            <option value="__custom__">${t("Personalizado (cron)…")}</option>
          </select>
        </label>
        <label>${t("Expressão cron")} <input id="sched-cron" type="text" value="0 0 9 * * *" /></label>
        <label class="check"><input id="sched-enabled" type="checkbox" checked /> ${t("Ativo")}</label>
        <div class="ws-editor-bar">
          <button type="button" class="ghost" id="sched-add">${t("Guardar agendamento")}</button>
        </div>
        <div class="pull-status" id="sched-status"></div>
      </fieldset>
      <menu>
        <button type="button" class="ghost" id="sched-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="models-dialog">
    <div class="settings">
      <h2>${t("Modelos")}</h2>
      <datalist id="ollama-models"></datalist>
      <div class="pull-status" id="hub-status">—</div>
      <div class="hub-rec" id="hub-rec" hidden></div>

      <fieldset>
        <legend>${t("Provider local")}</legend>
        <label>${t("Provider")}
          <select id="hub-local-provider">
            <option value="ollama">Ollama</option>
            <option value="openai">OpenAI-compatible (LM Studio)</option>
          </select>
        </label>
        <div class="field-group" id="hub-ollama-fields">
          <label>${t("Endpoint")} <input id="hub-ollama-endpoint" type="text" placeholder="http://localhost:11434" /></label>
          <label>${t("Modelo de visão (imagens)")} <input id="hub-vision" type="text" list="ollama-models" /></label>
        </div>
        <div class="field-group" id="hub-openai-local-fields" hidden>
          <label>${t("Endpoint")} <input id="hub-oai-local-endpoint" type="text" placeholder="http://localhost:1234/v1" /></label>
          <label>${t("API key (opcional)")} <input id="hub-oai-local-key" type="password" /></label>
          <label>${t("Modelo")} <input id="hub-oai-local-model" type="text" placeholder="${t("ex.: ID no LM Studio")}" /></label>
        </div>
      </fieldset>

      <fieldset id="hub-ollama-mgmt">
        <legend>${t("Modelos Ollama")}</legend>
        <label>${t("Procurar modelos (ollama.com)")}
          <input id="hub-search" type="search" placeholder="${t("ex.: gemma, qwen, llama…")}" autocomplete="off" />
        </label>
        <div class="reg-results" id="hub-search-results" hidden></div>
        <div class="quickpicks" id="hub-quickpicks"></div>
        <div class="hub-progress" id="hub-progress" hidden><div class="hub-bar" id="hub-bar"></div></div>
        <div class="pull-status" id="hub-pull-status"></div>
        <div class="hub-subtitle">${t("Instalados")}</div>
        <div class="models-list" id="hub-installed"></div>
        <label>${t("Instalar por nome")}
          <span class="row">
            <input id="hub-pull-name" type="text" placeholder="${t("ex.: llama3.2")}" list="ollama-models" />
            <button type="button" class="ghost" id="hub-pull-btn">${t("Puxar")}</button>
          </span>
        </label>
      </fieldset>

      <fieldset id="hub-lmstudio-mgmt" hidden>
        <legend>${t("Modelos LM Studio")}</legend>
        <div class="pull-status" id="hub-lm-status"></div>
        <label>${t("Procurar catálogo (lmstudio.ai)")}
          <input id="hub-lm-search" type="search" placeholder="${t("ex.: gemma, qwen, gpt-oss…")}" autocomplete="off" />
        </label>
        <div class="reg-results" id="hub-lm-results" hidden></div>
        <label>${t("Instalar por id / URL HuggingFace")}
          <span class="row">
            <input id="hub-lm-install" type="text" placeholder="ibm/granite-4-micro" />
            <input id="hub-lm-quant" type="text" placeholder="Q4_K_M" class="quant-in" />
            <button type="button" class="ghost" id="hub-lm-install-btn">${t("Instalar")}</button>
          </span>
        </label>
        <div class="hub-subtitle">${t("Descarregados")}</div>
        <div class="models-list" id="hub-lm-installed"></div>
        <button type="button" class="ghost" id="hub-lm-refresh">${t("Atualizar")}</button>
      </fieldset>

      <fieldset>
        <legend>${t("Cloud (escalar)")}</legend>
        <label>${t("Provider")}
          <select id="hub-cloud-provider">
            <option value="claude">Claude</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <div class="field-group" id="hub-claude-fields">
          <label>${t("Modo")}
            <select id="hub-claude-mode">
              <option value="off">${t("Desligado")}</option>
              <option value="cli">${t("Claude CLI (subscrição)")}</option>
              <option value="api">${t("API (ANTHROPIC_API_KEY)")}</option>
            </select>
          </label>
          <label>${t("Modelo")}
            <select id="hub-claude-preset">
              <option value="claude-haiku-4-5-20251001">${t("Haiku 4.5 — rápido e barato")}</option>
              <option value="claude-sonnet-4-6">${t("Sonnet 4.6 — equilíbrio")}</option>
              <option value="claude-opus-4-8">${t("Opus 4.8 — topo")}</option>
              <option value="claude-fable-5">${t("Fable 5 — mais capaz")}</option>
              <option value="__custom__">${t("Personalizado…")}</option>
            </select>
          </label>
          <label id="hub-claude-custom-wrap" hidden>${t("Modelo (ID)")} <input id="hub-claude-model" type="text" /></label>
          <label>${t("Caminho da CLI")} <input id="hub-claude-cli" type="text" /></label>
          <label>${t("API key")} <input id="hub-claude-key" type="password" /></label>
          <label>${t("Max tokens")} <input id="hub-claude-maxtok" type="number" min="256" /></label>
        </div>
        <div class="field-group" id="hub-openai-cloud-fields" hidden>
          <label>${t("Endpoint")} <input id="hub-oai-cloud-endpoint" type="text" placeholder="https://api.openai.com/v1" /></label>
          <label>${t("API key")} <input id="hub-oai-cloud-key" type="password" /></label>
          <label>${t("Modelo")} <input id="hub-oai-cloud-model" type="text" placeholder="${t("ex.: gpt-4o")}" /></label>
        </div>
      </fieldset>

      <details class="hub-advanced" id="hub-advanced">
        <summary>${t("Avançado")}</summary>

        <fieldset>
          <legend>${t("Deep research (Claude)")}</legend>
          <label>${t("Rondas de pesquisa (deep research)")} <input id="hub-research-rounds" type="number" min="1" max="5" /></label>
        </fieldset>

        <fieldset>
          <legend>${t("Pesquisa web (modelo local)")}</legend>
          <label class="check"><input id="hub-local-web" type="checkbox" /> ${t("Dar pesquisa web ao modelo local (🔎 corre no Ollama)")}</label>
          <p class="wiz-hint">${t("Precisa de um modelo Ollama com suporte a ferramentas (ex.: llama3.1, qwen2.5). Com isto desligado, o 🔎 força o Claude.")}</p>
          <label>${t("Motor")}
            <select id="hub-web-provider">
              <option value="jina">${t("Jina (recomendado)")}</option>
              <option value="tavily">Tavily</option>
              <option value="brave">Brave</option>
              <option value="serper">Serper</option>
              <option value="exa">Exa</option>
              <option value="duckduckgo">${t("DuckDuckGo (sem chave — pouco fiável)")}</option>
            </select>
          </label>
          <label id="hub-web-key-wrap"><span id="hub-web-key-text"></span> <input id="hub-web-key" type="password" /></label>
          <p class="wiz-hint" id="hub-web-hint"></p>
        </fieldset>

        <fieldset>
          <legend>${t("Modelo local (avançado)")}</legend>
          <label>${t("Contexto (num_ctx)")} <input id="hub-num-ctx" type="number" min="2048" step="1024" /></label>
          <p class="wiz-hint">${t("Maior = o modelo lê mais (resultados de pesquisa + histórico). 8192 é um bom valor; usa mais RAM.")}</p>
          <label>${t("Temperatura")} <input id="hub-temp" type="number" min="0" max="1.5" step="0.1" /></label>
          <p class="wiz-hint">${t("Mais baixa (~0.4) = respostas mais factuais e menos divagantes.")}</p>
        </fieldset>

        <fieldset>
          <legend>${t("Memória")}</legend>
          <label>${t("Pasta de memória")} <input id="hub-memory-dir" type="text" /></label>
          <label>${t("Caminho CLAUDE.md (opcional)")} <input id="hub-claude-md" type="text" /></label>
        </fieldset>

        <fieldset>
          <legend>${t("Ferramentas & Workspace (só modo API)")}</legend>
          <label>${t("Pasta do workspace (skills/playbooks/workflows)")} <input id="hub-workspace-dir" type="text" /></label>
          <label>${t("Confirmação de ações")}
            <select id="hub-confirm-mode">
              <option value="off">${t("Desligada — executa direto")}</option>
              <option value="dry_run">${t("Dry-run — só pré-visualiza")}</option>
              <option value="ask">${t("Pedir aprovação a cada ação")}</option>
            </select>
          </label>
          <label class="check"><input id="hub-browser-tools" type="checkbox" /> ${t("Ativar ferramentas de browser")}</label>
          <label>${t("Caminho do sidecar (sidecar/index.js)")} <input id="hub-browser-sidecar" type="text" /></label>
          <label>${t("Executável Node")} <input id="hub-browser-node" type="text" /></label>
          <label>${t("Pasta de dados do browser (sessão persistente)")} <input id="hub-browser-data" type="text" /></label>
        </fieldset>
      </details>

      <menu>
        <button type="button" class="primary" id="hub-save">${t("Guardar")}</button>
        <button type="button" class="ghost" id="hub-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="wizard-dialog">
    <div class="settings wizard">
      <div class="wiz-dots" id="wiz-dots"></div>

      <section class="wiz-step" data-step="0">
        <div class="wiz-hero">
          <img class="wiz-logo" src="/caravel-panel.svg" alt="Saga" />
          <h2>${t("Bem-vindo ao Saga ⛵")}</h2>
          <p class="wiz-intro">${t("Um assistente que corre no teu próprio computador. Sem contas, sem subscrição obrigatória — as tuas conversas ficam contigo.")}</p>
        </div>
        <ul class="wiz-points">
          <li>${icon("doc")}<div><strong>${t("Local primeiro")}</strong><span>${t("As respostas saem do modelo que corres em casa, via Ollama.")}</span></div></li>
          <li>${icon("search")}<div><strong>${t("Pesquisa na web")}</strong><span>${t("Modelos com ferramentas conseguem procurar e ler páginas online.")}</span></div></li>
          <li>${icon("escalate")}<div><strong>${t("Claude opcional")}</strong><span>${t("Liga o Claude para escalar tarefas pesadas — só quando quiseres.")}</span></div></li>
        </ul>
      </section>

      <section class="wiz-step" data-step="1" hidden>
        <h2>${t("Escolhe o teu modelo")}</h2>
        <div class="wiz-status" id="wiz-ollama-status">${t("A verificar…")}</div>
        <div id="wiz-rec" class="wiz-rec" hidden></div>
        <details class="wiz-manual">
          <summary>${t("Configuração manual")}</summary>
          <label>${t("Endpoint")} <input id="w_ollama_endpoint" type="text" /></label>
          <label>${t("Modelo ativo")} <input id="w_ollama_model" type="text" list="ollama-models" /></label>
          <p class="wiz-hint">${t("Sem Ollama? Instala em <strong>ollama.com</strong> e corre <code>ollama pull llama3.2</code>.")}</p>
        </details>
      </section>

      <section class="wiz-step" data-step="2" hidden>
        <h2>${t("Liga o Claude (opcional)")}</h2>
        <p class="wiz-intro">${t("Podes saltar isto e ficar 100% local. Liga o Claude mais tarde nas Definições se precisares de mais potência.")}</p>
        <label>${t("Modo")}
          <select id="w_claude_mode">
            <option value="off">${t("Desligado (só local)")}</option>
            <option value="cli">${t("Claude CLI (subscrição)")}</option>
            <option value="api">${t("API (key)")}</option>
          </select>
        </label>
        <label id="wiz-key-wrap" hidden>${t("API key")} <input id="w_claude_api_key" type="password" /></label>
        <div class="wiz-status" id="wiz-claude-status">${t("Desligado — só modelo local.")}</div>
      </section>

      <menu>
        <button type="button" class="ghost" id="wiz-back" hidden>${t("Anterior")}</button>
        <span class="wiz-spacer"></span>
        <button type="button" class="ghost" id="wiz-skip">${t("Saltar configuração")}</button>
        <button type="button" class="primary" id="wiz-next">${t("Seguinte")}</button>
      </menu>
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
};

const CLAUDE_MODEL_PRESETS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-fable-5",
];

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
    p.textContent = t(
      "Faz uma pergunta. Corre no teu modelo local; escala para o Claude quando quiseres."
    );
    empty.appendChild(img);
    empty.appendChild(p);
    const chips = document.createElement("div");
    chips.className = "empty-chips";
    const suggestions = [
      t("Resume este artigo: <cola um link>"),
      t("Escreve um e-mail breve a recusar uma reunião"),
      t("Explica o que faz este código"),
    ];
    for (const s of suggestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "empty-chip";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        els.input.value = s;
        els.input.focus();
        autoGrow();
      });
      chips.appendChild(chip);
    }
    empty.appendChild(chips);
    els.messages.appendChild(empty);
    return;
  }
  const firstKept = state.compactedUpto > 0 ? state.items.findIndex((i) => !isCompacted(i)) : -1;
  state.items.forEach((item, index) => {
    if (index === firstKept && firstKept > 0) {
      els.messages.appendChild(buildCompactDivider(firstKept));
    }
    const row = document.createElement("div");
    row.className = `msg ${item.role}${item.error ? " error" : ""}${
      isCompacted(item) ? " compacted" : ""
    }`;

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
      sum.innerHTML = `${icon("brain")}<span>${escapeHtml(t("raciocínio"))}</span>`;
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = item.thinking;
      det.appendChild(sum);
      det.appendChild(body);
      row.appendChild(det);
    }

    const parsed =
      item.role === "assistant" && !item.error ? parseSources(item.content) : null;
    if (item.content !== "" || item.role === "assistant") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      if (item.role === "assistant" && !item.error) {
        bubble.classList.add("markdown");
        // Renderiza o corpo sem a secção "## Fontes" (essa vai para o disclosure de fontes).
        bubble.innerHTML = renderMarkdown(
          parsed && parsed.sources.length ? parsed.body : item.content
        );
        highlightWithin(bubble);
      } else {
        bubble.textContent = item.content;
      }
      row.appendChild(bubble);
    }
    // Fontes consultadas (verificar se o modelo pesquisou mesmo). Ausência = não pesquisou.
    if (parsed && parsed.sources.length) {
      row.appendChild(buildSources(parsed.sources));
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

    // Artefactos: qualquer resposta do assistente com blocos de código/HTML (+ relatório).
    if (item.role === "assistant" && item.content) {
      const blocks = extractCodeBlocks(item.content);
      const isReport = item.report || /(^|\n)## Fontes/.test(item.content);
      if (blocks.length || isReport) {
        const arow = document.createElement("div");
        arow.className = "artifact-actions";
        if (isReport) {
          const btn = document.createElement("button");
          btn.innerHTML = `${icon("doc")}<span>${escapeHtml(t("Relatório"))}</span>`;
          btn.addEventListener("click", () =>
            openArtifact({ lang: "markdown", code: item.content, kind: "markdown" })
          );
          arow.appendChild(btn);
        }
        blocks.forEach((b, i) => {
          const btn = document.createElement("button");
          const label =
            `${t(KIND_LABEL[b.kind])}${blocks.length > 1 ? " " + (i + 1) : ""}` +
            (b.lang ? " · " + b.lang : "");
          btn.innerHTML = `${icon("doc")}<span>${escapeHtml(label)}</span>`;
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

    // Editar a própria mensagem.
    if (item.role === "user" && !state.busy) {
      const actions = document.createElement("div");
      actions.className = "msg-actions user-actions";
      const ed = document.createElement("button");
      ed.innerHTML = `${icon("pencil")}<span>${escapeHtml(t("Editar"))}</span>`;
      ed.title = t("Editar e reenviar");
      ed.addEventListener("click", () => editUserMessage(index));
      actions.appendChild(ed);
      row.appendChild(actions);
    }

    els.messages.appendChild(row);
  });
  els.messages.scrollTop = els.messages.scrollHeight;
  updateCtxEst();
}

/** Estima e mostra o contexto (tokens) que seria enviado ao modelo, contando a compactação. */
function updateCtxEst() {
  const el = document.querySelector<HTMLElement>("#ctx-est");
  if (!el) return;
  if (state.items.length === 0) {
    el.textContent = "";
    return;
  }
  const chars = buildPayload().reduce((n, m) => n + m.content.length, 0);
  el.textContent = `~${fmtInt(Math.ceil(chars / 4))} ${t("tok no contexto")}`;
}

/** Formata um passo de ferramenta para o fluxo (traduzível; o backend manda detalhe neutro). */
function formatToolStep(tool: string, detail: string): string {
  switch (tool) {
    case "web_search":
      return `🔎 ${t("a pesquisar")}: ${detail}`;
    case "web_fetch":
      return `↗ ${t("a abrir")}: ${detail}`;
    case "create_pdf":
      return `📄 ${t("a criar PDF")}`;
    default:
      return detail ? `${tool}: ${detail}` : tool;
  }
}

interface Source {
  label: string;
  url: string;
}

/** Separa o corpo da resposta da secção "## Fontes/Sources" e extrai as fontes (título + URL). */
function parseSources(content: string): { body: string; sources: Source[] } {
  const m = content.match(/\n#{1,3}\s*(?:Fontes|Sources)\s*\n([\s\S]*)$/i);
  if (!m || m.index === undefined) return { body: content, sources: [] };
  const body = content.slice(0, m.index).trimEnd();
  const sources: Source[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[1])) !== null) {
    const url = (mm[2] || mm[3]).replace(/[).,]+$/, "");
    const label = mm[1] || url;
    if (url && !sources.some((s) => s.url === url)) sources.push({ label, url });
  }
  return { body, sources };
}

/** Disclosure com as fontes web realmente consultadas no turno (para verificação). */
function buildSources(sources: Source[]): HTMLDetailsElement {
  const det = document.createElement("details");
  det.className = "sources";
  const sum = document.createElement("summary");
  sum.innerHTML = `${icon("search")}<span>${escapeHtml(t("Fontes ({n})", { n: sources.length }))}</span>`;
  det.appendChild(sum);
  const list = document.createElement("div");
  list.className = "sources-list";
  for (const s of sources) {
    const row = document.createElement("div");
    row.className = "src-row";
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.label;
    const u = document.createElement("span");
    u.className = "src-url";
    u.textContent = s.url;
    row.appendChild(a);
    row.appendChild(u);
    list.appendChild(row);
  }
  det.appendChild(list);
  return det;
}

/** Linha divisória da compactação: turnos acima estão resumidos e fora do contexto enviado. */
function buildCompactDivider(count: number): HTMLDetailsElement {
  const det = document.createElement("details");
  det.className = "compact-divider";
  const sum = document.createElement("summary");
  sum.textContent = t("▲ {n} mensagens compactadas — resumidas, fora do contexto enviado", {
    n: count,
  });
  const body = document.createElement("div");
  body.className = "compact-summary";
  body.textContent = state.compactedSummary;
  det.appendChild(sum);
  det.appendChild(body);
  return det;
}

function buildActions(): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const mk = (ic: string, label: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.innerHTML = `${icon(ic)}<span>${escapeHtml(label)}</span>`;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };

  actions.appendChild(mk("refresh", t("Regenerar"), t("Regenerar a resposta"), () => regenerate()));

  // Escalonamento para o Claude só quando está configurado (local-first).
  if (cloudEnabled()) {
    actions.appendChild(
      mk("escalate", t("Perguntar ao Claude"), t("Escalar esta resposta para o Claude"), () =>
        regenerate({ routeOverride: "claude" })
      )
    );
    const sel = document.createElement("select");
    sel.className = "model-pick";
    sel.innerHTML = `
      <option value="">${t("Modelo ▾")}</option>
      <option value="local">${t("Tentar local")}</option>
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
  }

  return actions;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderAccounting(a: Accounting) {
  const cards: [string, string, string?][] = [
    [t("Pedidos locais"), fmtInt(a.local_requests), t("grátis")],
    [t("Pedidos Claude"), fmtInt(a.claude_requests)],
    [t("Tokens servidos localmente"), fmtInt(a.tokens_served_local), t("que não foram ao Claude")],
    [t("Tokens poupados (compressão)"), fmtInt(a.tokens_saved_compression)],
    [t("Tokens Claude"), `${fmtInt(a.claude_input_tokens)}↓ / ${fmtInt(a.claude_output_tokens)}↑`],
    [t("Custo Claude"), fmtUsd(a.claude_cost_usd)],
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
    <span title="${t("Tokens servidos localmente")}">⬡ ${fmtInt(
      a.tokens_served_local + a.tokens_saved_compression
    )} ${t("tok poupados")}</span>
    <span title="${t("Custo acumulado no Claude")}">▲ ${fmtUsd(a.claude_cost_usd)}</span>`;
}

async function refreshMemory() {
  try {
    const preview = await api.getMemoryPreview();
    els.memPreview.textContent = preview.trim() || t("(sem memória — define a pasta nas definições)");
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
    rm.title = t("Remover");
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
    title.textContent = c.title || t("Nova conversa");
    title.title = c.title;
    title.addEventListener("click", () => selectConversation(c.id));
    title.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(c, row, title);
    });

    const ren = document.createElement("button");
    ren.className = "conv-act";
    ren.textContent = "✎";
    ren.title = t("Renomear");
    ren.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(c, row, title);
    });

    const del = document.createElement("button");
    del.className = "conv-act conv-del";
    del.textContent = "×";
    del.title = t("Apagar");
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
    empty.textContent = t("Sem resultados");
    els.convList.appendChild(empty);
    return;
  }
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "conv search-hit";
    const titleEl = document.createElement("div");
    titleEl.className = "conv-title";
    titleEl.textContent = h.title || t("Nova conversa");
    const s = document.createElement("div");
    s.className = "hit-snippet";
    s.textContent = h.snippet;
    row.appendChild(titleEl);
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
      id: m.id,
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
  return { id: m.id, role: m.role, content: m.content, attachments };
}

function resetCompaction() {
  state.compactedSummary = "";
  state.compactedUpto = 0;
}

async function selectConversation(id: number) {
  if (state.busy) return;
  state.currentConversationId = id;
  const msgs = await api.getConversation(id);
  state.items = msgs.map(storedToItem);
  try {
    const c = await api.getCompaction(id);
    state.compactedSummary = c.summary;
    state.compactedUpto = c.upto;
  } catch {
    resetCompaction();
  }
  renderMessages();
  renderSidebar();
  renderAccounting(await api.conversationAccounting(id));
}

async function createConversation() {
  if (state.busy) return;
  const id = await api.newConversation();
  state.currentConversationId = id;
  state.items = [];
  resetCompaction();
  renderMessages();
  await loadConversations();
  renderAccounting(await api.conversationAccounting(id));
}

async function removeConversation(id: number) {
  await api.deleteConversation(id);
  if (state.currentConversationId === id) {
    state.currentConversationId = null;
    state.items = [];
    resetCompaction();
    renderMessages();
  }
  await loadConversations();
  if (state.currentConversationId === null && state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else if (state.conversations.length === 0) {
    await createConversation();
  }
}

/** Compacta a Saga atual: resume os turnos antigos com o modelo local (não-destrutivo). */
async function compactCurrentSaga() {
  if (state.busy || state.currentConversationId === null) return;
  const btn = document.querySelector<HTMLButtonElement>("#btn-compact")!;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("A compactar…");
  try {
    const r = await api.compactConversation(state.currentConversationId, 4);
    state.compactedSummary = r.summary;
    state.compactedUpto = r.upto;
    renderMessages();
  } catch (e) {
    alert(t("Falha a compactar: ") + e);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/** Esvazia a Saga atual (mantém-na na lista). */
async function clearCurrentSaga() {
  if (state.busy || state.currentConversationId === null) return;
  if (!confirm(t("Apagar todas as mensagens desta Saga?"))) return;
  const id = state.currentConversationId;
  try {
    await api.clearConversation(id);
    state.items = [];
    resetCompaction();
    renderMessages();
    renderAccounting(await api.conversationAccounting(id));
  } catch (e) {
    alert(t("Falha a limpar: ") + e);
  }
}

type SendOpts = {
  routeOverride?: "local" | "claude";
  modelOverride?: string;
  regenerate?: boolean;
  thinking?: boolean;
  research?: boolean;
  subagents?: boolean;
};

/** Item já compactado (resumido e fora do contexto enviado ao modelo)? */
function isCompacted(i: Item): boolean {
  return state.compactedUpto > 0 && i.id !== undefined && i.id <= state.compactedUpto;
}

function buildPayload(): ChatMessage[] {
  const kept = state.items
    .filter((i) => !isCompacted(i))
    .map((i) => ({ role: i.role, content: i.content, attachments: i.attachments }));
  const msgs: ChatMessage[] = [];
  // Agente ativo → injeta o seu system prompt à frente de tudo.
  if (state.activeAgent?.system.trim()) {
    msgs.push({ role: "system", content: state.activeAgent.system.trim() });
  }
  if (state.compactedSummary.trim()) {
    // Injeta o resumo como contexto (par user→assistant para manter alternância de papéis).
    msgs.push(
      {
        role: "user",
        content: `${t("Resumo do início desta conversa (contexto):")}\n\n${state.compactedSummary}`,
      },
      { role: "assistant", content: t("Entendido — tenho o contexto anterior.") }
    );
  }
  msgs.push(...kept);
  return msgs;
}

function routeOptsFromMode(): SendOpts {
  // Local-first: só envia override quando o utilizador escolhe Claude.
  return state.routeMode === "claude" ? { routeOverride: "claude" } : {};
}

/** Escalonamento para a cloud (Claude/OpenAI) está configurado? Se não, esconde tudo o que é Claude. */
function cloudEnabled(): boolean {
  const s = state.settings;
  if (!s) return false;
  return s.cloud_provider === "claude"
    ? s.claude_mode !== "off"
    : !!s.openai_cloud_endpoint?.trim();
}

/** Empurra uma bolha de assistente e preenche-a com o streaming. */
async function streamAssistant(payload: ChatMessage[], opts: SendOpts) {
  const conversationId = state.currentConversationId!;
  const sendOpts: SendOpts = {
    ...opts,
    thinking: opts.thinking ?? state.thinking,
    research: opts.research ?? state.research,
    subagents: opts.subagents ?? state.subagents,
  };
  // Subagentes é só Claude. Pesquisa também força Claude, EXCETO se o web search local
  // estiver ligado (Ollama) — aí o 🔎 pode correr no modelo local.
  const localWeb =
    state.settings?.local_provider === "ollama" && !!state.settings?.local_web_search;
  if (!sendOpts.routeOverride) {
    if (sendOpts.subagents) sendOpts.routeOverride = "claude";
    else if (sendOpts.research && !localWeb) sendOpts.routeOverride = "claude";
  }
  const assistant: Item = { role: "assistant", content: "", report: sendOpts.research };
  state.items.push(assistant);
  renderMessages();
  setBusy(true);

  const paintBubble = () => {
    const b = els.messages.lastElementChild?.querySelector(".bubble") as HTMLDivElement | null;
    if (b) {
      b.classList.remove("markdown"); // texto simples durante o streaming
      b.textContent = assistant.content;
    }
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const waiting = sendOpts.research
    ? t("A pesquisar na net…")
    : sendOpts.subagents
      ? t("A coordenar subagentes…")
      : sendOpts.thinking
        ? t("A pensar a fundo…")
        : t("A pensar…");
  const tb = els.messages.lastElementChild?.querySelector(".bubble") as HTMLDivElement | null;
  if (tb) {
    tb.innerHTML =
      `<span class="waiting-row">${caravelLoader(30)}<span class="status-text"></span></span>`;
    tb.querySelector(".status-text")!.textContent = waiting;
  }

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
          assistant.steps.push(formatToolStep(evt.tool, evt.detail));
          renderMessages();
          paintBubble();
        } else if (evt.kind === "ApprovalRequest") {
          showApproval(evt.id, evt.tool, evt.preview);
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
      sendOpts
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

// ---- Menu "/" (comandos + definições) ----
type SlashCmd = {
  cmd: string;
  label: string;
  kind: "create" | "setting" | "workflow";
  run?: () => void;
};
const slashMenu = document.querySelector<HTMLElement>("#slash-menu")!;
const CREATE_CMDS = ["skill", "playbook", "workflow"];
let slashWorkflows: string[] = [];
let slashItems: SlashCmd[] = [];
let slashSel = 0;

function refreshSlashWorkflows() {
  api
    .getWorkspaceIndex()
    .then((i) => {
      slashWorkflows = i.workflows.map((w) => w.name);
    })
    .catch(() => {});
}

function setRouteMode(mode: "local" | "claude") {
  if (mode === "claude" && !cloudEnabled()) return; // Claude indisponível
  state.routeMode = mode;
  els.routeModeBar
    .querySelectorAll<HTMLButtonElement>("button[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}
function toggleComposerFlag(flag: "thinking" | "research" | "subagents") {
  state[flag] = !state[flag];
  const id =
    flag === "thinking" ? "#btn-think" : flag === "research" ? "#btn-research" : "#btn-subagents";
  document.querySelector(id)!.classList.toggle("active", state[flag]);
}
function openSettingsDialog() {
  els.dialog.showModal();
}

function slashCommands(): SlashCmd[] {
  const cmds: SlashCmd[] = [
    { cmd: "skill", label: t("Criar skill com IA — /skill <descrição>"), kind: "create" },
    { cmd: "playbook", label: t("Criar playbook com IA — /playbook <descrição>"), kind: "create" },
    { cmd: "workflow", label: t("Criar workflow com IA — /workflow <descrição>"), kind: "create" },
    { cmd: t("pesquisar"), label: t("Toggle: 🔎 Pesquisar"), kind: "setting", run: () => toggleComposerFlag("research") },
    { cmd: t("modelos"), label: t("Abrir Modelos"), kind: "setting", run: () => openModels() },
    { cmd: t("definicoes"), label: t("Abrir Definições"), kind: "setting", run: openSettingsDialog },
  ];
  // Comandos só-Claude apenas quando o escalonamento está configurado.
  if (cloudEnabled()) {
    cmds.push(
      { cmd: "local", label: t("Rota: Local"), kind: "setting", run: () => setRouteMode("local") },
      { cmd: "claude", label: t("Rota: Claude"), kind: "setting", run: () => setRouteMode("claude") },
      { cmd: "think", label: t("Toggle: 🧠 Think"), kind: "setting", run: () => toggleComposerFlag("thinking") },
      { cmd: t("subagentes"), label: t("Toggle: 🧩 Subagentes"), kind: "setting", run: () => toggleComposerFlag("subagents") }
    );
  }
  for (const w of slashWorkflows) cmds.push({ cmd: w, label: t("Correr workflow: {w}", { w }), kind: "workflow" });
  return cmds;
}

function updateSlashMenu() {
  const m = els.input.value.match(/^\/([\w-]*)$/);
  if (!m) return hideSlash();
  const token = m[1].toLowerCase();
  slashItems = slashCommands().filter((c) => c.cmd.toLowerCase().startsWith(token));
  if (slashItems.length === 0) return hideSlash();
  slashSel = 0;
  renderSlash();
  slashMenu.hidden = false;
}
function renderSlash() {
  slashMenu.innerHTML = slashItems
    .map(
      (c, i) =>
        `<button type="button" class="slash-item${i === slashSel ? " sel" : ""}" data-i="${i}"><code>/${escapeHtml(c.cmd)}</code><span>${escapeHtml(c.label)}</span></button>`
    )
    .join("");
  slashMenu.querySelectorAll<HTMLButtonElement>(".slash-item").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectSlash(parseInt(b.dataset.i!));
    })
  );
}
function hideSlash() {
  slashMenu.hidden = true;
}
function slashOpen() {
  return !slashMenu.hidden;
}
function selectSlash(i: number) {
  const it = slashItems[i];
  if (!it) return;
  if (it.kind === "setting") {
    it.run!();
    els.input.value = "";
    hideSlash();
    autoGrow();
    return;
  }
  els.input.value = `/${it.cmd} `;
  hideSlash();
  els.input.focus();
  autoGrow();
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return base || "novo";
}

/** Cria um doc de workspace a partir do chat (determinístico, em qualquer modo). */
async function createDocFromChat(kind: "skill" | "playbook" | "workflow", desc: string) {
  if (state.currentConversationId === null) {
    state.currentConversationId = await api.newConversation();
    await loadConversations();
  }
  state.items.push({ role: "user", content: `/${kind} ${desc}` });
  const note: Item = { role: "assistant", content: `A gerar ${kind}…` };
  state.items.push(note);
  renderMessages();
  try {
    const md = await api.generateDoc(kind, desc);
    const f = parseDocFields(kind, md);
    const name = f.name && /^[\w-]+$/.test(f.name) ? f.name : slugify(desc);
    await api.saveWorkspaceDoc(kind, name, md);
    refreshSlashWorkflows();
    note.content = `✓ ${kind} **${name}** criada no Workspace. Abre o Workspace (rail) para rever/editar.`;
  } catch (e) {
    note.content = `✗ Falha a criar ${kind}: ${e}`;
    note.error = true;
  }
  renderMessages();
}

async function onSubmit(ev: Event) {
  ev.preventDefault();
  hideSlash();
  const text = els.input.value.trim();
  if ((!text && state.pendingAttachments.length === 0) || state.busy) return;

  // Comandos "/" (criar / definições). Workflows seguem para o envio normal (backend corre-os).
  const m = text.match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (m) {
    const cmd = m[1].toLowerCase();
    const args = m[2].trim();
    if (CREATE_CMDS.includes(cmd)) {
      els.input.value = "";
      els.input.style.height = "auto";
      if (args) {
        await createDocFromChat(cmd as "skill" | "playbook" | "workflow", args);
      } else {
        openWorkspace();
        setWsKind(cmd as "skill" | "playbook" | "workflow");
        newWsDoc();
      }
      return;
    }
    const setting = slashCommands().find((c) => c.kind === "setting" && c.cmd === cmd);
    if (setting) {
      setting.run!();
      els.input.value = "";
      els.input.style.height = "auto";
      return;
    }
  }

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

/** Edita uma mensagem do utilizador: trunca a partir dela e re-gera. */
async function editUserMessage(index: number) {
  if (state.busy || state.currentConversationId === null) return;
  const item = state.items[index];
  if (!item || item.role !== "user") return;
  const row = els.messages.children[index] as HTMLElement | undefined;
  if (!row) return;

  row.className = "msg user editing";
  row.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "edit-area";
  ta.value = item.content;
  const bar = document.createElement("div");
  bar.className = "edit-bar";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = t("Cancelar");
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = t("Guardar e reenviar");
  bar.append(cancel, save);
  row.append(ta, bar);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const commit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const attachments = item.attachments;
    try {
      await api.truncateConversation(state.currentConversationId!, index);
    } catch (e) {
      console.error(e);
    }
    state.items = state.items.slice(0, index);
    state.items.push({ role: "user", content: text, attachments });
    renderMessages();
    await streamAssistant(buildPayload(), routeOptsFromMode());
  };
  cancel.addEventListener("click", () => renderMessages());
  save.addEventListener("click", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      renderMessages();
    }
  });
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

// ---- Settings (app: aparência + atualizações; config de modelos vive no hub Modelos) ----
/**
 * Local-first: mostra o seletor Local|Claude e os toggles só-Claude (🧩/🧠) apenas quando o
 * Claude está configurado. 🔎 fica visível também em local-only se a pesquisa web local estiver ON.
 */
function applyComposerToggles() {
  const s = state.settings;
  const cloud = cloudEnabled();
  const localWeb = s?.local_provider === "ollama" && !!s?.local_web_search;
  // Seletor Local|Claude só faz sentido se houver Claude.
  document.querySelector("#route-pick")?.toggleAttribute("hidden", !cloud);
  if (!cloud && state.routeMode === "claude") setRouteMode("local");
  // Toggles: 🔎 (local ou cloud) · 🧩/🧠 (só Claude).
  document.querySelector("#btn-research")?.toggleAttribute("hidden", !(localWeb || cloud));
  document.querySelector("#btn-subagents")?.toggleAttribute("hidden", !cloud);
  document.querySelector("#btn-think")?.toggleAttribute("hidden", !cloud);
  // O picker de agente está sempre disponível (funciona em local puro), por isso a barra e o
  // contentor de toggles ficam sempre visíveis.
  els.routeModeBar.querySelector(".composer-toggles")!.removeAttribute("hidden");
  els.routeModeBar.removeAttribute("hidden");
}

// ---- Picker de agente (persona) no composer ----
function setToggle(which: "research" | "subagents" | "thinking", on: boolean) {
  state[which] = on;
  const id = which === "thinking" ? "#btn-think" : which === "research" ? "#btn-research" : "#btn-subagents";
  document.querySelector(id)?.classList.toggle("active", on);
}

function updateAgentChip() {
  const label = document.querySelector("#btn-agent-label");
  if (label) label.textContent = state.activeAgent ? state.activeAgent.name : t("Agente");
  document.querySelector("#btn-agent")?.classList.toggle("active", !!state.activeAgent);
}

async function setActiveAgent(name: string | null) {
  if (!name) {
    state.activeAgent = null;
    updateAgentChip();
    return;
  }
  try {
    const raw = await api.readWorkspaceDoc("agent", name);
    const f = parseDocFields("agent", raw);
    state.activeAgent = { name: f.name || name, system: f.body };
    // Aplica as predefinições sugeridas pelo agente.
    setRouteMode(f.agentRoute === "claude" && cloudEnabled() ? "claude" : "local");
    setToggle("research", !!f.agentResearch);
    setToggle("subagents", !!f.agentSubagents && cloudEnabled());
    updateAgentChip();
    showHint(t("Agente ativo: {n}", { n: state.activeAgent.name }));
  } catch (e) {
    showHint(t("Falha a carregar o agente: ") + e);
  }
}

/** Menu flutuante para escolher um agente (ou desligar). */
async function openAgentMenu() {
  document.querySelector("#agent-menu")?.remove();
  let agents: DocMeta[] = [];
  try {
    agents = (await api.getWorkspaceIndex()).agents;
  } catch {
    /* sem workspace */
  }
  const btn = document.querySelector<HTMLElement>("#btn-agent")!;
  const r = btn.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.id = "agent-menu";
  menu.className = "agent-menu";
  const rows = [
    `<button type="button" class="agent-row${state.activeAgent ? "" : " active"}" data-agent="">${t("Nenhum (modelo base)")}</button>`,
    ...agents.map(
      (a) =>
        `<button type="button" class="agent-row${
          state.activeAgent?.name === a.name ? " active" : ""
        }" data-agent="${escapeHtml(a.name)}"><strong>${escapeHtml(a.name)}</strong><span>${escapeHtml(a.description)}</span></button>`
    ),
  ];
  if (agents.length === 0) {
    rows.push(`<div class="agent-empty">${t("Cria agentes no Workspace → Agents.")}</div>`);
  }
  menu.innerHTML = rows.join("");
  document.body.appendChild(menu);
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener("click", onDoc, true);
  };
  const onDoc = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) close();
  };
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  menu.querySelectorAll<HTMLButtonElement>("[data-agent]").forEach((b) =>
    b.addEventListener("click", () => {
      void setActiveAgent(b.dataset.agent || null);
      close();
    })
  );
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

/** Toast transitório (avisos não-bloqueantes). */
let hintTimer: number | undefined;
function showHint(msg: string) {
  let el = document.querySelector<HTMLElement>("#hint-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "hint-toast";
    el.className = "hint-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    if (el) el.hidden = true;
  }, 6000);
}

/** Avisa quando o 🔎 não vai realmente pesquisar localmente (setting off ou modelo sem tools). */
function maybeWarnSearch() {
  const s = state.settings;
  if (!s) return;
  const localModel = s.local_provider === "ollama" ? s.ollama_model : s.openai_local_model;
  if (!s.local_web_search) {
    showHint(
      state.routeMode === "local"
        ? t("🔎 não vai pesquisar: ativa a Pesquisa web (Modelos → Avançado) para o modelo local pesquisar.")
        : t("🔎 vai usar o Claude. Para pesquisar com o modelo local, ativa a Pesquisa web em Modelos → Avançado.")
    );
  } else if (s.local_provider === "ollama" && state.routeMode !== "claude" && !modelHasTools(localModel)) {
    showHint(t("🔎 pode não pesquisar: '{m}' não chama ferramentas — usa qwen3/llama3.1.", { m: localModel }));
  }
}

// ---- Artefactos ----
type ArtifactKind = "html" | "mermaid" | "markdown" | "code";
interface Artifact {
  lang: string;
  code: string;
  kind: ArtifactKind;
}

function classifyArtifact(lang: string, code: string): ArtifactKind {
  if (lang === "mermaid") return "mermaid";
  if (lang === "md" || lang === "markdown") return "markdown";
  if (lang === "html" || /^\s*<!doctype html|^\s*<html[\s>]/i.test(code)) return "html";
  return "code";
}

function extractCodeBlocks(content: string): Artifact[] {
  const re = /```(\w*)\n([\s\S]*?)```/g;
  const out: Artifact[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const code = m[2].trim();
    const lang = (m[1] || "").toLowerCase();
    if (code.length >= 20) out.push({ lang, code, kind: classifyArtifact(lang, code) });
  }
  return out;
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: "Página",
  mermaid: "Diagrama",
  markdown: "Documento",
  code: "Artefacto",
};

let artifactMode: "preview" | "code" = "preview";
let artifactCurrent: Artifact | null = null;
let mermaidSeq = 0;

function renderArtifactBody() {
  if (!artifactCurrent) return;
  const a = artifactCurrent;
  const body = els.artifactBody;
  body.innerHTML = "";
  const hasPreview = a.kind !== "code";
  els.artifactToggle.hidden = !hasPreview;
  els.artifactToggle.textContent = artifactMode === "preview" ? t("Código") : t("Pré-visualizar");

  if (hasPreview && artifactMode === "preview") {
    if (a.kind === "html") {
      const iframe = document.createElement("iframe");
      iframe.className = "artifact-frame";
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.srcdoc = a.code;
      body.appendChild(iframe);
    } else if (a.kind === "markdown") {
      const div = document.createElement("div");
      div.className = "artifact-doc bubble markdown";
      div.innerHTML = renderMarkdown(a.code);
      highlightWithin(div);
      body.appendChild(div);
    } else if (a.kind === "mermaid") {
      const div = document.createElement("div");
      div.className = "artifact-mermaid";
      body.appendChild(div);
      const id = `mmd-${++mermaidSeq}`;
      mermaid
        .render(id, a.code)
        .then(({ svg }) => {
          div.innerHTML = svg;
        })
        .catch((e) => {
          div.textContent = t("Erro a desenhar o diagrama: ") + e;
        });
    }
  } else {
    const pre = document.createElement("pre");
    pre.className = "artifact-code";
    const codeEl = document.createElement("code");
    if (a.lang) codeEl.className = "language-" + a.lang;
    codeEl.textContent = a.code;
    pre.appendChild(codeEl);
    body.appendChild(pre);
    highlightWithin(pre);
  }
}

function openArtifact(a: Artifact) {
  artifactCurrent = a;
  artifactMode = a.kind === "code" ? "code" : "preview";
  els.artifactTitle.textContent = `${t(KIND_LABEL[a.kind])}` + (a.lang ? ` · ${a.lang}` : "");
  els.artifactPanel.hidden = false;
  renderArtifactBody();
}

function closeArtifact() {
  els.artifactPanel.hidden = true;
  artifactCurrent = null;
}

/** Exporta o artefacto atual para um ficheiro (save dialog). */
async function exportArtifact() {
  if (!artifactCurrent) return;
  const ext =
    artifactCurrent.kind === "html"
      ? "html"
      : artifactCurrent.kind === "markdown"
        ? "md"
        : artifactCurrent.lang || "txt";
  const path = await save({ defaultPath: `artefacto.${ext}` });
  if (path) {
    try {
      await api.exportFile(path, artifactCurrent.code);
    } catch (e) {
      alert(t("Falha a exportar: ") + e);
    }
  }
}

/** Exporta o artefacto atual como PDF via impressão do webview (Guardar como PDF). */
function exportArtifactPdf() {
  if (!artifactCurrent) return;
  const a = artifactCurrent;
  if (a.kind === "html") {
    printHtml(a.code, true);
    return;
  }
  let inner: string;
  if (a.kind === "markdown") {
    inner = renderMarkdown(a.code);
  } else if (a.kind === "mermaid") {
    inner = els.artifactBody.querySelector(".artifact-mermaid")?.innerHTML ?? `<pre>${escapeHtml(a.code)}</pre>`;
  } else {
    inner = `<pre>${escapeHtml(a.code)}</pre>`;
  }
  printHtml(inner, false, deriveDocTitle(a));
}

/** Deriva um título para a capa: 1.º heading do markdown, senão o tipo de artefacto. */
function deriveDocTitle(a: Artifact): string {
  if (a.kind === "markdown") {
    const m = a.code.match(/^\s*#\s+(.+)$/m);
    if (m) return m[1].trim();
  }
  return t("Documento");
}

/** Tema de impressão polido, partilhado pelo Export PDF e pelo create_pdf (sidecar). */
const PRINT_CSS = `
  :root { --ink: #1c2b3a; --accent: #2f6ea5; --muted: #5a6b7d; --line: #d8e0e8; --soft: #f3f6fa; }
  @page { margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font: 11.5pt/1.65 "Segoe UI", -apple-system, Roboto, sans-serif;
    color: var(--ink); margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc-cover {
    border-bottom: 3px solid var(--accent); padding-bottom: 14px; margin-bottom: 26px;
    page-break-after: avoid;
  }
  .doc-cover .eyebrow {
    text-transform: uppercase; letter-spacing: 0.14em; font-size: 8.5pt; font-weight: 700;
    color: var(--accent); margin: 0 0 6px;
  }
  .doc-cover h1 { font-size: 26pt; line-height: 1.12; margin: 0; color: var(--ink); }
  .doc-cover .doc-date { font-size: 9.5pt; color: var(--muted); margin-top: 10px; }
  h1, h2, h3, h4 { line-height: 1.22; color: var(--ink); page-break-after: avoid; }
  h1 { font-size: 20pt; margin: 1.4em 0 0.5em; }
  h2 { font-size: 15pt; margin: 1.5em 0 0.4em; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 12.5pt; margin: 1.2em 0 0.3em; color: var(--accent); }
  p { margin: 0 0 0.8em; }
  a { color: var(--accent); text-decoration: none; }
  ul, ol { margin: 0 0 0.9em; padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  li::marker { color: var(--accent); }
  blockquote {
    margin: 1em 0; padding: 0.4em 1em; border-left: 3px solid var(--accent);
    background: var(--soft); color: var(--muted); page-break-inside: avoid;
  }
  pre {
    background: var(--soft); border: 1px solid var(--line); padding: 12px 14px; border-radius: 8px;
    white-space: pre-wrap; word-wrap: break-word; font-size: 9.5pt; page-break-inside: avoid;
  }
  code { font-family: "Cascadia Code", ui-monospace, Menlo, monospace; font-size: 9.5pt; }
  p code, li code { background: var(--soft); padding: 1px 5px; border-radius: 4px; }
  img, svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 10pt; page-break-inside: avoid; }
  thead { background: var(--accent); color: #fff; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
  tbody tr:nth-child(even) { background: var(--soft); }
  hr { border: none; border-top: 1px solid var(--line); margin: 1.6em 0; }
`;

/** Imprime HTML num iframe oculto (o webview oferece "Guardar como PDF"). */
function printHtml(bodyHtml: string, isFullDoc: boolean, title?: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  const today = new Date().toLocaleDateString(getLang() === "pt" ? "pt-PT" : "en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const cover = title
    ? `<header class="doc-cover"><p class="eyebrow">Saga</p><h1>${escapeHtml(title)}</h1><div class="doc-date">${today}</div></header>`
    : "";
  const wrapped = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title || "Saga"
  )}</title><style>${PRINT_CSS}</style></head><body>${cover}${bodyHtml}</body></html>`;
  doc.open();
  doc.write(isFullDoc ? bodyHtml : wrapped);
  doc.close();
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 1500);
  };
  // Dá tempo ao layout/imagens; usa onload quando disponível, com fallback.
  iframe.onload = () => setTimeout(go, 100);
  setTimeout(go, 500);
}

/** Galeria: lista os artefactos da Saga atual (varre as mensagens guardadas). */
async function openGallery() {
  if (state.currentConversationId === null) return;
  let msgs: StoredMessage[] = [];
  try {
    msgs = await api.getConversation(state.currentConversationId);
  } catch {
    return;
  }
  const arts: Artifact[] = [];
  for (const m of msgs) {
    if (m.role === "assistant") arts.push(...extractCodeBlocks(m.content));
  }
  const body = els.artifactBody;
  els.artifactTitle.textContent = `${t("Galeria")} · ${arts.length}`;
  els.artifactToggle.hidden = true;
  els.artifactPanel.hidden = false;
  body.innerHTML = "";
  if (arts.length === 0) {
    body.innerHTML = `<div class="empty-sm">${t("Sem artefactos nesta Saga.")}</div>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "gallery-list";
  arts.forEach((a, i) => {
    const item = document.createElement("button");
    item.className = "gallery-item";
    item.textContent = `${t(KIND_LABEL[a.kind])}${a.lang ? " · " + a.lang : ""} #${i + 1}`;
    item.addEventListener("click", () => openArtifact(a));
    list.appendChild(item);
  });
  body.appendChild(list);
}

/** Exporta a Saga atual para Markdown (papel + conteúdo + meta). */
async function exportSaga() {
  if (state.currentConversationId === null) return;
  let msgs: StoredMessage[] = [];
  try {
    msgs = await api.getConversation(state.currentConversationId);
  } catch (e) {
    alert(t("Falha a ler a Saga: ") + e);
    return;
  }
  const title =
    state.conversations.find((c) => c.id === state.currentConversationId)?.title || "Saga";
  const lines = [`# ${title}`, ""];
  for (const m of msgs) {
    const who = m.role === "user" ? t("Tu") : "Saga";
    const tag = m.role === "assistant" && m.model ? ` _(${m.route}/${m.model})_` : "";
    lines.push(`## ${who}${tag}`, "", m.content, "");
  }
  const path = await save({ defaultPath: `${title.replace(/[^\w-]+/g, "_")}.md` });
  if (path) {
    try {
      await api.exportFile(path, lines.join("\n"));
    } catch (e) {
      alert(t("Falha a exportar: ") + e);
    }
  }
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
      t("✓ Ollama ligado — {n} modelo(s)", { n: d.ollama_models.length }) +
      (d.ollama_model_present ? "" : t(" · modelo configurado não encontrado"));
    els.modelsList.innerHTML = d.ollama_models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join("");
  } else {
    o.className = "wiz-status bad";
    o.textContent = t("✗ Ollama não detetado neste endpoint");
  }
  const c = document.querySelector("#wiz-claude-status")!;
  c.className = "wiz-status " + (d.claude_ready ? "ok" : "bad");
  c.textContent = (d.claude_ready ? "✓ " : "✗ ") + d.claude_detail;
}

const WIZ_STEPS = 3;
let wizStep = 0;

/** Persiste o que está nos campos e atualiza os diagnósticos visíveis. */
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

function renderWizDots() {
  const dots = document.querySelector("#wiz-dots")!;
  dots.innerHTML = Array.from({ length: WIZ_STEPS }, (_, i) =>
    `<span class="wiz-dot${i === wizStep ? " active" : ""}${i < wizStep ? " done" : ""}"></span>`
  ).join("");
}

async function wizGoTo(step: number) {
  wizStep = Math.max(0, Math.min(WIZ_STEPS - 1, step));
  els.wizard
    .querySelectorAll<HTMLElement>(".wiz-step")
    .forEach((s) => s.toggleAttribute("hidden", Number(s.dataset.step) !== wizStep));
  document.querySelector("#wiz-back")!.toggleAttribute("hidden", wizStep === 0);
  document.querySelector("#wiz-next")!.textContent =
    wizStep === WIZ_STEPS - 1 ? t("Começar a usar") : t("Seguinte");
  renderWizDots();
  if (wizStep === 1) {
    // Passo do modelo: testa o Ollama e mostra a recomendação consciente do hardware.
    void runWizardTest();
    void renderRecommendation("#wiz-rec");
  } else if (wizStep === 2) {
    void runWizardTest();
  }
}

async function wizNext() {
  // Guarda o que está nos campos antes de avançar (não perde escolhas).
  await runWizardTest();
  if (wizStep >= WIZ_STEPS - 1) {
    await finishWizard();
  } else {
    await wizGoTo(wizStep + 1);
  }
}

async function openWizard() {
  const s = state.settings!;
  wizInput("w_ollama_endpoint").value = s.ollama_endpoint;
  wizInput("w_ollama_model").value = s.ollama_model;
  document.querySelector<HTMLSelectElement>("#w_claude_mode")!.value = s.claude_mode;
  wizInput("w_claude_api_key").value = s.claude_api_key;
  document.querySelector("#wiz-key-wrap")!.toggleAttribute("hidden", s.claude_mode !== "api");
  await wizGoTo(0);
  els.wizard.showModal();
}

async function finishWizard() {
  const next = { ...mergeWizardSettings(state.settings!), onboarding_done: true };
  try {
    await api.saveSettings(next);
    state.settings = next;
  } catch (e) {
    alert(t("Falha a guardar definições: ") + e);
  }
  els.wizard.close();
  await refreshMemory();
  applyComposerToggles();
  // Em vez de mandar para o hub Modelos, aterra num chat com empty state amigável + mini-tour.
  showView(null);
  renderMessages();
  maybeMiniTour();
}

/** Mini-tour: 1–2 dicas curtas apontando ao rail e ao composer (uma só vez). */
function maybeMiniTour() {
  if (localStorage.getItem("saga.tourDone") === "1") return;
  localStorage.setItem("saga.tourDone", "1");
  const tip = (anchorSel: string, text: string, place: "right" | "top") =>
    new Promise<void>((resolve) => {
      const anchor = document.querySelector<HTMLElement>(anchorSel);
      if (!anchor) return resolve();
      const r = anchor.getBoundingClientRect();
      const pop = document.createElement("div");
      pop.className = `mini-tour ${place}`;
      pop.innerHTML = `<p>${text}</p><button type="button" class="primary">${t("Percebi")}</button>`;
      document.body.appendChild(pop);
      if (place === "right") {
        pop.style.left = `${r.right + 12}px`;
        pop.style.top = `${r.top}px`;
      } else {
        pop.style.left = `${Math.max(12, r.left)}px`;
        pop.style.bottom = `${window.innerHeight - r.top + 12}px`;
      }
      anchor.classList.add("tour-glow");
      pop.querySelector("button")!.addEventListener("click", () => {
        anchor.classList.remove("tour-glow");
        pop.remove();
        resolve();
      });
    });
  void (async () => {
    await tip("#rail", t("Aqui ficam os Modelos, Workspace e Automações."), "right");
    await tip("#composer", t("Escreve a tua pergunta aqui. Boa viagem! ⛵"), "top");
  })();
}

async function checkForUpdates() {
  const status = document.querySelector("#update-status")!;
  status.textContent = t("A verificar…");
  try {
    const update = await check();
    if (!update) {
      status.textContent = t("Estás na versão mais recente.");
      return;
    }
    status.textContent = t("Nova versão {v} — a descarregar…", { v: update.version });
    await update.downloadAndInstall();
    status.textContent = t("Instalado. A reiniciar…");
    await relaunch();
  } catch (e) {
    const msg = String(e);
    status.textContent = /release json|404|fetch|endpoint|not found/i.test(msg)
      ? t("Não foi possível contactar o servidor de atualizações. Verifica a ligação e tenta de novo.")
      : t("Não foi possível verificar atualizações: ") + msg;
  }
}

/** No arranque: verifica, descarrega e instala a atualização em fundo, depois oferece reiniciar. */
async function autoUpdate() {
  try {
    const update = await check();
    if (!update) return;
    showHint(t("A descarregar atualização {v}…", { v: update.version }));
    await update.downloadAndInstall();
    showUpdateReady(update.version);
  } catch {
    /* silencioso no arranque — o feed pode ainda não existir / instaladores sem assinatura */
  }
}

/** Banner não-bloqueante: atualização instalada, oferece reiniciar para aplicar. */
function showUpdateReady(version: string) {
  let el = document.querySelector<HTMLElement>("#update-ready");
  if (!el) {
    el = document.createElement("div");
    el.id = "update-ready";
    el.className = "update-ready";
    document.body.appendChild(el);
  }
  el.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = t("Atualização {v} instalada.", { v: version });
  const restart = document.createElement("button");
  restart.className = "primary";
  restart.textContent = t("Reiniciar");
  restart.addEventListener("click", () => relaunch());
  const later = document.createElement("button");
  later.className = "ghost";
  later.textContent = t("Mais tarde");
  later.addEventListener("click", () => (el!.hidden = true));
  el.append(span, restart, later);
  el.hidden = false;
}

// ---- Aprovação de ações (modo "ask") ----
function showApproval(id: number, tool: string, preview: string) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML = `
    <div class="approval-head">${t("Aprovar ação?")}</div>
    <div class="approval-tool">${escapeHtml(tool)}</div>
    <pre class="approval-preview">${escapeHtml(preview)}</pre>
    <div class="approval-bar">
      <button type="button" class="ghost" data-ok="0">${t("Recusar")}</button>
      <button type="button" class="primary" data-ok="1">${t("Aprovar")}</button>
    </div>`;
  const done = (ok: boolean) => {
    api.approveAction(id, ok).catch(() => {});
    card.remove();
  };
  card.querySelector('[data-ok="1"]')!.addEventListener("click", () => done(true));
  card.querySelector('[data-ok="0"]')!.addEventListener("click", () => done(false));
  els.messages.appendChild(card);
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ---- Workspace (skills / playbooks / workflows) ----
const wsDialog = document.querySelector<HTMLDialogElement>("#workspace-dialog")!;
type WsKind = "skill" | "playbook" | "workflow" | "agent";
let wsKind: WsKind = "skill";

async function openWorkspace() {
  setWsKind("skill");
  showView("workspace");
}

const WS_HELP: Record<string, string> = {
  skill: t("Skill — instruções que o modelo carrega sozinho quando a tarefa encaixa (auto-expostas via load_skill)."),
  playbook: t("Playbook — um procedimento reutilizável que o modelo lê a pedido (read_playbook)."),
  workflow: t("Workflow — um procedimento executável: corre-o com /<nome> e o agente segue os passos."),
  agent: t("Agent — uma persona com system prompt e predefinições; escolhe-a no composer para focar o modelo numa tarefa."),
};

function setWsKind(kind: WsKind) {
  wsKind = kind;
  wsDialog
    .querySelectorAll<HTMLButtonElement>(".ws-tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  const help = document.querySelector("#ws-help");
  if (help) help.textContent = WS_HELP[kind] ?? "";
  document.querySelector("#ws-editor")!.setAttribute("hidden", "");
  void renderWorkspaceList();
}

async function renderWorkspaceList() {
  const list = document.querySelector<HTMLDivElement>("#ws-list")!;
  let idx;
  try {
    idx = await api.getWorkspaceIndex();
  } catch {
    idx = { skills: [], playbooks: [], workflows: [], agents: [] };
  }
  const items =
    wsKind === "skill"
      ? idx.skills
      : wsKind === "workflow"
        ? idx.workflows
        : wsKind === "agent"
          ? idx.agents
          : idx.playbooks.map((n) => ({ name: n, description: "" }));
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Nada ainda. Cria o primeiro com “+ Novo”.")}</div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (it) => `
    <div class="ws-item">
      <div class="ws-item-main"><strong>${escapeHtml(it.name)}</strong><span>${escapeHtml(it.description)}</span></div>
      <div class="ws-item-actions">
        ${wsKind === "workflow" ? `<button type="button" class="ghost" data-run="${escapeHtml(it.name)}">${icon("play")}<span>${t("Correr")}</span></button>` : ""}
        <button type="button" class="ghost" data-edit="${escapeHtml(it.name)}">${t("Editar")}</button>
        <button type="button" class="ghost" data-del="${escapeHtml(it.name)}">✕</button>
      </div>
    </div>`
    )
    .join("");
  list
    .querySelectorAll<HTMLButtonElement>("[data-edit]")
    .forEach((b) => b.addEventListener("click", () => editWsDoc(b.dataset.edit!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-del]")
    .forEach((b) => b.addEventListener("click", () => delWsDoc(b.dataset.del!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-run]")
    .forEach((b) => b.addEventListener("click", () => runWorkflow(b.dataset.run!)));
}

interface DocFields {
  name: string;
  desc: string;
  triggers: string;
  arghint: string;
  body: string;
  // Predefinições de agente (só para kind "agent").
  agentRoute?: "local" | "claude";
  agentTools?: boolean;
  agentResearch?: boolean;
  agentSubagents?: boolean;
}

const wsq = <T extends HTMLElement>(id: string) => document.querySelector<T>(id)!;

/** Mostra/esconde os campos do editor conforme o tipo e ajusta o rótulo do corpo. */
function applyDocKindFields() {
  const isSkill = wsKind === "skill";
  const isWorkflow = wsKind === "workflow";
  const isPlaybook = wsKind === "playbook";
  const isAgent = wsKind === "agent";
  wsq("#ws-triggers-wrap").toggleAttribute("hidden", !isSkill);
  wsq("#ws-arghint-wrap").toggleAttribute("hidden", !isWorkflow);
  wsq("#ws-agent-wrap").toggleAttribute("hidden", !isAgent);
  (wsq<HTMLInputElement>("#ws-desc").closest("label") as HTMLElement).toggleAttribute(
    "hidden",
    isPlaybook
  );
  const bl = wsq("#ws-body-label").childNodes[0];
  if (bl)
    bl.nodeValue = isPlaybook
      ? t("Procedimento (markdown)")
      : isWorkflow
        ? t("Passos (markdown — usa $ARGUMENTS)")
        : isAgent
          ? t("System prompt (markdown)")
          : t("Instruções (markdown)");
}

/** Parser simples de frontmatter (espelha workspace.rs). */
function tsFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const t = raw.replace(/^﻿/, "");
  const m = t.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { fm: {}, body: t.trim() };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: t.slice(m[0].length).trim() };
}

function parseDocFields(kind: WsKind, raw: string): DocFields {
  const { fm, body } = tsFrontmatter(raw);
  let desc = fm["description"] || "";
  let triggers = "";
  if (kind === "skill") {
    const idx = desc.search(/triggers:/i);
    if (idx >= 0) {
      triggers = desc.slice(idx).replace(/triggers:/i, "").trim();
      desc = desc.slice(0, idx).replace(/[.\s]+$/, "").trim();
    }
  }
  const truthy = (v: string | undefined) => /^(true|1|sim|yes)$/i.test((v || "").trim());
  return {
    name: fm["name"] || "",
    desc,
    triggers,
    arghint: fm["argument-hint"] || "",
    body,
    agentRoute: fm["route"] === "claude" ? "claude" : "local",
    agentTools: truthy(fm["tools"]),
    agentResearch: truthy(fm["research"]),
    agentSubagents: truthy(fm["subagents"]),
  };
}

function assembleDoc(kind: WsKind, f: DocFields): string {
  if (kind === "playbook") return f.body.trim() + "\n";
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const lines = ["---", `name: ${f.name}`];
  if (kind === "skill") {
    const d = f.triggers ? `${f.desc} Triggers: ${f.triggers}` : f.desc;
    lines.push(`description: "${esc(d)}"`);
  } else if (kind === "agent") {
    lines.push(
      `description: "${esc(f.desc)}"`,
      `tools: ${f.agentTools ? "true" : "false"}`,
      `research: ${f.agentResearch ? "true" : "false"}`,
      `subagents: ${f.agentSubagents ? "true" : "false"}`,
      `route: ${f.agentRoute === "claude" ? "claude" : "local"}`
    );
  } else {
    lines.push(`description: "${esc(f.desc)}"`, `argument-hint: ${f.arghint}`);
  }
  lines.push("---", "", f.body.trim(), "");
  return lines.join("\n");
}

function fillEditorFields(f: Partial<DocFields>) {
  wsq<HTMLInputElement>("#ws-desc").value = f.desc || "";
  wsq<HTMLInputElement>("#ws-triggers").value = f.triggers || "";
  wsq<HTMLInputElement>("#ws-arghint").value = f.arghint || "";
  wsq<HTMLTextAreaElement>("#ws-content").value = f.body || "";
  wsq<HTMLSelectElement>("#ws-agent-route").value = f.agentRoute || "local";
  wsq<HTMLInputElement>("#ws-agent-tools").checked = !!f.agentTools;
  wsq<HTMLInputElement>("#ws-agent-research").checked = !!f.agentResearch;
  wsq<HTMLInputElement>("#ws-agent-subagents").checked = !!f.agentSubagents;
}

function readEditorFields(): DocFields {
  return {
    name: wsq<HTMLInputElement>("#ws-name").value.trim(),
    desc: wsq<HTMLInputElement>("#ws-desc").value.trim(),
    triggers: wsq<HTMLInputElement>("#ws-triggers").value.trim(),
    arghint: wsq<HTMLInputElement>("#ws-arghint").value.trim(),
    body: wsq<HTMLTextAreaElement>("#ws-content").value,
    agentRoute: wsq<HTMLSelectElement>("#ws-agent-route").value === "claude" ? "claude" : "local",
    agentTools: wsq<HTMLInputElement>("#ws-agent-tools").checked,
    agentResearch: wsq<HTMLInputElement>("#ws-agent-research").checked,
    agentSubagents: wsq<HTMLInputElement>("#ws-agent-subagents").checked,
  };
}

function newWsDoc() {
  const nameEl = wsq<HTMLInputElement>("#ws-name");
  nameEl.value = "";
  nameEl.readOnly = false;
  fillEditorFields({
    body:
      wsKind === "workflow"
        ? t("Passos a executar (usa $ARGUMENTS para os argumentos)…")
        : wsKind === "skill"
          ? t("Instruções passo a passo…")
          : wsKind === "agent"
            ? t("És um… (define o papel, o estilo e as regras do agente)")
            : t("Procedimento reutilizável…"),
    agentRoute: "local",
  });
  wsq<HTMLTextAreaElement>("#ws-gen-prompt").value = "";
  wsq("#ws-gen-status").textContent = "";
  applyDocKindFields();
  wsq("#ws-editor").removeAttribute("hidden");
}

async function editWsDoc(name: string) {
  try {
    const content = await api.readWorkspaceDoc(wsKind, name);
    const nameEl = wsq<HTMLInputElement>("#ws-name");
    nameEl.value = name;
    nameEl.readOnly = true;
    fillEditorFields(parseDocFields(wsKind, content));
    wsq<HTMLTextAreaElement>("#ws-gen-prompt").value = "";
    wsq("#ws-gen-status").textContent = "";
    applyDocKindFields();
    wsq("#ws-editor").removeAttribute("hidden");
  } catch (e) {
    alert(t("Falha a abrir: ") + e);
  }
}

async function genWsDoc() {
  const prompt = wsq<HTMLTextAreaElement>("#ws-gen-prompt").value.trim();
  const status = wsq("#ws-gen-status");
  if (!prompt) {
    status.textContent = t("Descreve o que queres.");
    return;
  }
  status.textContent = t("A gerar…");
  try {
    const md = await api.generateDoc(wsKind, prompt);
    const f = parseDocFields(wsKind, md);
    const nameEl = wsq<HTMLInputElement>("#ws-name");
    if (f.name && !nameEl.value.trim()) nameEl.value = f.name;
    fillEditorFields(f);
    applyDocKindFields();
    status.textContent = t("✓ Gerado — revê e guarda");
  } catch (e) {
    status.textContent = "✗ " + e;
  }
}

async function saveWsDoc() {
  const f = readEditorFields();
  if (!f.name) {
    alert(t("Indica um nome (sem espaços)."));
    return;
  }
  try {
    await api.saveWorkspaceDoc(wsKind, f.name, assembleDoc(wsKind, f));
    wsq("#ws-editor").setAttribute("hidden", "");
    await renderWorkspaceList();
  } catch (e) {
    alert(t("Falha a guardar: ") + e);
  }
}

async function delWsDoc(name: string) {
  if (!confirm(t("Apagar “{name}”?", { name }))) return;
  try {
    await api.deleteWorkspaceDoc(wsKind, name);
    await renderWorkspaceList();
  } catch (e) {
    alert(t("Falha a apagar: ") + e);
  }
}

async function runWorkflow(name: string) {
  showView(null);
  if (state.currentConversationId === null) {
    state.currentConversationId = await api.newConversation();
    await loadConversations();
  }
  els.input.value = `/${name} `;
  els.input.focus();
  autoGrow();
}

// ---- Servidores MCP ----
const mcpDialog = document.querySelector<HTMLDialogElement>("#mcp-dialog")!;
let mcpEditingIndex: number | null = null;

function mcpServers(): McpServerConfig[] {
  return state.settings?.mcp_servers ?? [];
}

function openMcp() {
  clearMcpForm();
  renderMcpList();
  showView("servers");
}

function renderMcpList() {
  const list = document.querySelector<HTMLDivElement>("#mcp-list")!;
  const srvs = mcpServers();
  if (srvs.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Sem servidores. Adiciona um abaixo.")}</div>`;
    return;
  }
  list.innerHTML = srvs
    .map(
      (s, i) => `
    <div class="mcp-item">
      <label class="check"><input type="checkbox" data-toggle="${i}" ${s.enabled ? "checked" : ""} /> <strong>${escapeHtml(s.name)}</strong></label>
      <code>${escapeHtml(s.command)} ${escapeHtml(s.args.join(" "))}</code>
      <div class="mcp-item-actions">
        <button type="button" class="ghost" data-edit="${i}">${t("Editar")}</button>
        <button type="button" class="ghost" data-del="${i}">✕</button>
      </div>
    </div>`
    )
    .join("");
  list
    .querySelectorAll<HTMLInputElement>("[data-toggle]")
    .forEach((b) => b.addEventListener("change", () => toggleMcp(parseInt(b.dataset.toggle!), b.checked)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-edit]")
    .forEach((b) => b.addEventListener("click", () => editMcp(parseInt(b.dataset.edit!))));
  list
    .querySelectorAll<HTMLButtonElement>("[data-del]")
    .forEach((b) => b.addEventListener("click", () => delMcp(parseInt(b.dataset.del!))));
}

function clearMcpForm() {
  mcpEditingIndex = null;
  (document.querySelector("#mcp-name") as HTMLInputElement).value = "";
  (document.querySelector("#mcp-command") as HTMLInputElement).value = "";
  (document.querySelector("#mcp-args") as HTMLTextAreaElement).value = "";
  (document.querySelector("#mcp-env") as HTMLTextAreaElement).value = "";
  (document.querySelector("#mcp-enabled") as HTMLInputElement).checked = true;
  document.querySelector("#mcp-status")!.textContent = "";
  document.querySelector("#mcp-form-legend")!.textContent = t("Novo servidor");
}

function readMcpForm(): McpServerConfig {
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const env = lines((document.querySelector("#mcp-env") as HTMLTextAreaElement).value)
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    })
    .filter(([k]) => k.length > 0);
  return {
    name: (document.querySelector("#mcp-name") as HTMLInputElement).value.trim(),
    command: (document.querySelector("#mcp-command") as HTMLInputElement).value.trim(),
    args: lines((document.querySelector("#mcp-args") as HTMLTextAreaElement).value),
    env,
    enabled: (document.querySelector("#mcp-enabled") as HTMLInputElement).checked,
  };
}

function editMcp(i: number) {
  const s = mcpServers()[i];
  if (!s) return;
  mcpEditingIndex = i;
  (document.querySelector("#mcp-name") as HTMLInputElement).value = s.name;
  (document.querySelector("#mcp-command") as HTMLInputElement).value = s.command;
  (document.querySelector("#mcp-args") as HTMLTextAreaElement).value = s.args.join("\n");
  (document.querySelector("#mcp-env") as HTMLTextAreaElement).value = s.env
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  (document.querySelector("#mcp-enabled") as HTMLInputElement).checked = s.enabled;
  document.querySelector("#mcp-form-legend")!.textContent = t("Editar servidor");
}

async function persistServers(next: McpServerConfig[]) {
  if (!state.settings) return;
  const updated = { ...state.settings, mcp_servers: next };
  await api.saveSettings(updated);
  state.settings = updated;
}

async function addOrUpdateMcp() {
  const cfg = readMcpForm();
  const status = document.querySelector("#mcp-status")!;
  if (!cfg.name || !cfg.command) {
    status.textContent = t("Nome e comando são obrigatórios.");
    return;
  }
  const next = mcpServers().slice();
  if (mcpEditingIndex !== null) next[mcpEditingIndex] = cfg;
  else next.push(cfg);
  try {
    await persistServers(next);
    clearMcpForm();
    renderMcpList();
  } catch (e) {
    status.textContent = t("Falha a guardar: ") + e;
  }
}

async function toggleMcp(i: number, enabled: boolean) {
  const next = mcpServers().slice();
  if (!next[i]) return;
  next[i] = { ...next[i], enabled };
  try {
    await persistServers(next);
  } catch (e) {
    alert(t("Falha: ") + e);
  }
}

async function delMcp(i: number) {
  if (!confirm(t("Remover este servidor?"))) return;
  const next = mcpServers().slice();
  next.splice(i, 1);
  try {
    await persistServers(next);
    renderMcpList();
  } catch (e) {
    alert(t("Falha: ") + e);
  }
}

async function testMcp() {
  const cfg = readMcpForm();
  const status = document.querySelector("#mcp-status")!;
  if (!cfg.command) {
    status.textContent = t("Indica o comando.");
    return;
  }
  status.textContent = t("A ligar…");
  try {
    const tools = await api.testMcpServer(cfg);
    status.textContent = t("✓ {n} ferramentas: {list}", {
      n: tools.length,
      list: tools.join(", ") || t("(nenhuma)"),
    });
  } catch (e) {
    status.textContent = "✗ " + e;
  }
}

// ---- Atividade ----
const activityDialog = document.querySelector<HTMLDialogElement>("#activity-dialog")!;
async function openActivity() {
  await renderActivity();
  showView("activity");
}
async function renderActivity() {
  const list = document.querySelector<HTMLDivElement>("#act-list")!;
  if (state.currentConversationId === null) {
    list.innerHTML = `<div class="empty-sm">${t("Sem Saga selecionada.")}</div>`;
    return;
  }
  let rows: ActionLogEntry[] = [];
  try {
    rows = await api.getActionLog(state.currentConversationId);
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Sem ações registadas nesta Saga.")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (r) => `
    <div class="act-row status-${escapeHtml(r.status.toLowerCase())}">
      <span class="act-status">${escapeHtml(r.status)}</span>
      <span class="act-tool">${escapeHtml(r.tool)}</span>
      <span class="act-detail">${escapeHtml(r.error || r.detail || r.params_json)}</span>
      <span class="act-time">${escapeHtml(r.created_at)}</span>
    </div>`
    )
    .join("");
}

// ---- Automações agendadas ----
const automationsDialog = document.querySelector<HTMLDialogElement>("#automations-dialog")!;
let schedEditingId: number | null = null;

async function openAutomations() {
  schedEditingId = null;
  // popular o dropdown de workflows
  const sel = document.querySelector<HTMLSelectElement>("#sched-workflow")!;
  try {
    const idx = await api.getWorkspaceIndex();
    sel.innerHTML = idx.workflows
      .map((w) => `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)}</option>`)
      .join("");
    if (idx.workflows.length === 0) {
      sel.innerHTML = `<option value="">${t("(sem workflows — cria um no Workspace)")}</option>`;
    }
  } catch {
    sel.innerHTML = "";
  }
  clearSchedForm();
  await renderSchedules();
  showView("automations");
}

function clearSchedForm() {
  schedEditingId = null;
  (document.querySelector("#sched-name") as HTMLInputElement).value = "";
  (document.querySelector("#sched-args") as HTMLInputElement).value = "";
  (document.querySelector("#sched-preset") as HTMLSelectElement).value = "0 0 9 * * *";
  (document.querySelector("#sched-cron") as HTMLInputElement).value = "0 0 9 * * *";
  (document.querySelector("#sched-enabled") as HTMLInputElement).checked = true;
  document.querySelector("#sched-status")!.textContent = "";
  document.querySelector("#sched-form-legend")!.textContent = t("Novo agendamento");
}

function fmtEpoch(epoch: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString();
}

async function renderSchedules() {
  const list = document.querySelector<HTMLDivElement>("#sched-list")!;
  let rows: Schedule[] = [];
  try {
    rows = await api.listSchedules();
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Sem agendamentos. Cria um abaixo.")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (s) => `
    <div class="mcp-item">
      <label class="check"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} /> <strong>${escapeHtml(s.name)}</strong></label>
      <code>${escapeHtml(s.workflow_name)} · ${escapeHtml(s.cron)} · ${t("próx:")} ${escapeHtml(fmtEpoch(s.next_run_epoch))}</code>
      <div class="mcp-item-actions">
        <button type="button" class="ghost" data-run="${s.id}">▶</button>
        <button type="button" class="ghost" data-edit="${s.id}">${t("Editar")}</button>
        <button type="button" class="ghost" data-del="${s.id}">✕</button>
      </div>
    </div>`
    )
    .join("");
  const byId = new Map(rows.map((s) => [s.id, s]));
  list.querySelectorAll<HTMLInputElement>("[data-toggle]").forEach((b) =>
    b.addEventListener("change", () => toggleSchedule(byId.get(parseInt(b.dataset.toggle!))!, b.checked))
  );
  list.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => editSchedule(byId.get(parseInt(b.dataset.edit!))!))
  );
  list.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
    b.addEventListener("click", () => delSchedule(parseInt(b.dataset.del!)))
  );
  list.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) =>
    b.addEventListener("click", () => runScheduleNow(parseInt(b.dataset.run!)))
  );
}

function editSchedule(s: Schedule) {
  schedEditingId = s.id;
  (document.querySelector("#sched-name") as HTMLInputElement).value = s.name;
  (document.querySelector("#sched-args") as HTMLInputElement).value = s.arguments;
  (document.querySelector("#sched-cron") as HTMLInputElement).value = s.cron;
  (document.querySelector("#sched-preset") as HTMLSelectElement).value = "__custom__";
  (document.querySelector("#sched-enabled") as HTMLInputElement).checked = s.enabled;
  const sel = document.querySelector<HTMLSelectElement>("#sched-workflow")!;
  if ([...sel.options].some((o) => o.value === s.workflow_name)) sel.value = s.workflow_name;
  document.querySelector("#sched-form-legend")!.textContent = t("Editar agendamento");
}

async function addOrUpdateSchedule() {
  const name = (document.querySelector("#sched-name") as HTMLInputElement).value.trim();
  const workflow = (document.querySelector("#sched-workflow") as HTMLSelectElement).value;
  const args = (document.querySelector("#sched-args") as HTMLInputElement).value.trim();
  const cron = (document.querySelector("#sched-cron") as HTMLInputElement).value.trim();
  const enabled = (document.querySelector("#sched-enabled") as HTMLInputElement).checked;
  const status = document.querySelector("#sched-status")!;
  if (!name || !workflow || !cron) {
    status.textContent = t("Nome, workflow e cron são obrigatórios.");
    return;
  }
  try {
    if (schedEditingId !== null) {
      await api.updateSchedule(schedEditingId, name, workflow, args, cron, enabled);
    } else {
      await api.createSchedule(name, workflow, args, cron, enabled);
    }
    clearSchedForm();
    await renderSchedules();
  } catch (e) {
    status.textContent = t("Falha: ") + e;
  }
}

async function toggleSchedule(s: Schedule, enabled: boolean) {
  try {
    await api.updateSchedule(s.id, s.name, s.workflow_name, s.arguments, s.cron, enabled);
    await renderSchedules();
  } catch (e) {
    alert(t("Falha: ") + e);
  }
}

async function delSchedule(id: number) {
  if (!confirm(t("Remover este agendamento?"))) return;
  try {
    await api.deleteSchedule(id);
    await renderSchedules();
  } catch (e) {
    alert(t("Falha: ") + e);
  }
}

async function runScheduleNow(id: number) {
  const status = document.querySelector("#sched-status")!;
  status.textContent = t("A correr…");
  try {
    status.textContent = await api.runScheduleNow(id);
    await renderSchedules();
  } catch (e) {
    status.textContent = t("Falha: ") + e;
  }
}

// ---- Hub "Modelos" ----
const modelsDialog = document.querySelector<HTMLDialogElement>("#models-dialog")!;
interface CatalogModel {
  name: string;
  size: string;
}

interface Caps {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

/**
 * Deteta capacidades de um modelo local pela família (regex), robusto a versões.
 * Baseado nas páginas de capacidades do ollama.com (tools / vision / thinking).
 */
function modelCapabilities(name: string): Caps {
  const n = name.toLowerCase();
  const isVision =
    /(-vl(:|$)|\dvl(:|$)|llama3\.2-vision|llava|moondream|minicpm-v|granite[\d.]*-vision|-vision|gemma4)/.test(n) ||
    /gemma3:(4b|12b|27b)/.test(n);
  const reasoning = /(deepseek-r1|qwq|qwen3|gemma4|-thinking|thinking)/.test(n);
  // Famílias com function-calling treinado; exclui visão-pura e raciocínio-puro.
  // (Gemma 4 tem tools nativos — ao contrário do Gemma 2/3.)
  const tools =
    /(qwen3|qwen2\.5|qwen[\w.]*coder|llama3\.1|llama3\.3|llama3\.2:3b|mistral|mixtral|ministral|devstral|granite3|gemma4|command-?r|hermes|firefunction|smollm2)/.test(n) &&
    !/(-vision|vl(:|$)|\dvl(:|$)|llava|moondream)/.test(n);
  return { tools, vision: isVision, reasoning };
}

/** Modelo ativo suporta tool-calling? (necessário para a pesquisa web local). */
function modelHasTools(name: string): boolean {
  return modelCapabilities(name).tools;
}

const MODEL_CATALOG: { group: string; models: CatalogModel[] }[] = [
  {
    group: "Geral + ferramentas/web", /* i18n: traduzido via t(g.group) em renderQuickPicks */
    models: [
      { name: "llama3.3:70b", size: "70B" },
      { name: "llama3.1:8b", size: "8B" },
      { name: "qwen3:8b", size: "8B" },
      { name: "qwen3:14b", size: "14B" },
      { name: "gemma4:12b", size: "12B" },
      { name: "qwen2.5:7b", size: "7B" },
      { name: "qwen2.5:14b", size: "14B" },
      { name: "mistral-small", size: "24B" },
      { name: "mistral-nemo", size: "12B" },
      { name: "granite3.3:8b", size: "8B" },
      { name: "command-r7b", size: "7B" },
    ],
  },
  {
    group: "Pequenos / rápidos",
    models: [
      { name: "llama3.2:3b", size: "3B" },
      { name: "qwen3:1.7b", size: "1.7B" },
      { name: "qwen2.5:3b", size: "3B" },
      { name: "phi4-mini", size: "3.8B" },
      { name: "gemma3:1b", size: "1B" },
      { name: "granite3.3:2b", size: "2B" },
    ],
  },
  {
    group: "Código",
    models: [
      { name: "qwen2.5-coder:7b", size: "7B" },
      { name: "qwen2.5-coder:14b", size: "14B" },
      { name: "deepseek-coder-v2", size: "16B" },
    ],
  },
  {
    group: "Raciocínio",
    models: [
      { name: "deepseek-r1:8b", size: "8B" },
      { name: "deepseek-r1:14b", size: "14B" },
      { name: "qwq", size: "32B" },
      { name: "qwen3:32b", size: "32B" },
    ],
  },
  {
    group: "Visão",
    models: [
      { name: "qwen2.5vl:7b", size: "7B" },
      { name: "llama3.2-vision", size: "11B" },
      { name: "gemma3:4b", size: "4B" },
      { name: "gemma3:12b", size: "12B" },
      { name: "minicpm-v", size: "8B" },
      { name: "moondream", size: "1.8B" },
      { name: "llava:7b", size: "7B" },
    ],
  },
];

/** Heurística: o modelo ativo é pequeno/fraco (respostas e pesquisa podem falhar)? */
function isWeakModel(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /(^|[^0-9])llama3\.2(:latest)?$/.test(n) ||
    /:1b|:1\.7b|:2b|:3b/.test(n) ||
    n.includes("phi3") ||
    n.includes("gemma2:2b") ||
    n.includes("gemma3:1b") ||
    n.includes("moondream")
  );
}

const hubIn = (id: string) => document.querySelector<HTMLInputElement>(id)!;
const hubSel = (id: string) => document.querySelector<HTMLSelectElement>(id)!;

function fmtSize(b: number): string {
  if (!b) return "";
  const gb = b / 1e9;
  return gb >= 1 ? gb.toFixed(1) + " GB" : (b / 1e6).toFixed(0) + " MB";
}

async function openModels() {
  if (!state.settings) return;
  hubLoad(state.settings);
  applyHubProviderFields();
  renderQuickPicks();
  showView("models");
  void renderHubStatus();
  void renderInstalled();
  void renderRecommendation();
}

/** Guia "qual escolher": escolhe pela VRAM da placa gráfica (ou RAM se não houver GPU). */
const PICK_TIERS: { hw: string; model: string; note: string }[] = [
  { hw: "Máquina fraca ou sem GPU", model: "llama3.2:3b", note: "leve — corre em quase qualquer máquina" },
  { hw: "Sem GPU (CPU) ou GPU pequena (~8 GB)", model: "qwen3:8b", note: "rápido e com ferramentas/web" },
  { hw: "GPU média (~12 GB)", model: "qwen3:14b", note: "melhor equilíbrio" },
  { hw: "GPU grande (16 GB+)", model: "mistral-small", note: "mais capaz (ou qwen3:32b)" },
];

/** Secção de recomendação para quem não sabe que modelo escolher. */
async function renderRecommendation(targetSel = "#hub-rec") {
  const box = document.querySelector<HTMLElement>(targetSel)!;
  if (!box) return;
  box.hidden = false;
  let machine = "";
  try {
    const info = await api.systemInfo();
    machine =
      `<div class="hub-rec-line">${t("A tua máquina")}: ${info.total_ram_gb} GB RAM · ${info.cpu_cores} cores — ` +
      `${t("sugestão")}: <code>${escapeHtml(info.recommended)}</code> <span class="rec-cap">${capBadges(info.recommended)}</span></div>`;
  } catch {
    /* sem info de sistema — mostra só os escalões */
  }
  const tiers = PICK_TIERS.map(
    (p) =>
      `<div class="rec-tier">
        <span class="rec-hw">${escapeHtml(t(p.hw))}</span>
        <span class="rec-model"><code>${escapeHtml(p.model)}</code> ${capBadges(p.model)} <span class="rec-note">${escapeHtml(t(p.note))}</span></span>
        <button type="button" class="ghost rec-use" data-model="${escapeHtml(p.model)}">${t("Instalar e usar")}</button>
      </div>`
  ).join("");
  box.innerHTML =
    `<div class="hub-rec-head"><strong>${t("Não sabes qual escolher?")}</strong></div>` +
    machine +
    `<div class="hub-rec-sub">${t("Escolhe pela memória da tua placa gráfica (VRAM) — ou pela RAM se não tiveres GPU:")}</div>` +
    tiers +
    `<div class="rec-tip">${icon("tool")} ${t("faz pesquisa web")} · ${icon("brain")} ${t("raciocínio (não pesquisa)")} · ${icon("eye")} ${t("lê imagens")}. ${t("Para pesquisar, escolhe um modelo com ferramentas.")}</div>`;
  box.querySelectorAll<HTMLButtonElement>(".rec-use").forEach((b) =>
    b.addEventListener("click", () => {
      const m = b.dataset.model!;
      setActiveModel(m); // fica ativo (aplica-se assim que o download terminar)
      pullModelUi(m);
    })
  );
}

function hubLoad(s: Settings) {
  hubSel("#hub-local-provider").value = s.local_provider;
  hubIn("#hub-ollama-endpoint").value = s.ollama_endpoint;
  hubIn("#hub-vision").value = s.ollama_vision_model;
  hubIn("#hub-oai-local-endpoint").value = s.openai_local_endpoint;
  hubIn("#hub-oai-local-key").value = s.openai_local_key;
  hubIn("#hub-oai-local-model").value = s.openai_local_model;
  hubSel("#hub-cloud-provider").value = s.cloud_provider;
  hubSel("#hub-claude-mode").value = s.claude_mode;
  const preset = hubSel("#hub-claude-preset");
  const customWrap = document.querySelector<HTMLElement>("#hub-claude-custom-wrap")!;
  if (CLAUDE_MODEL_PRESETS.includes(s.claude_model)) {
    preset.value = s.claude_model;
    customWrap.hidden = true;
  } else {
    preset.value = "__custom__";
    customWrap.hidden = false;
  }
  hubIn("#hub-claude-model").value = s.claude_model;
  hubIn("#hub-claude-cli").value = s.claude_cli_path;
  hubIn("#hub-claude-key").value = s.claude_api_key;
  hubIn("#hub-claude-maxtok").value = String(s.claude_max_tokens);
  hubIn("#hub-oai-cloud-endpoint").value = s.openai_cloud_endpoint;
  hubIn("#hub-oai-cloud-key").value = s.openai_cloud_key;
  hubIn("#hub-oai-cloud-model").value = s.openai_cloud_model;
  // Avançado
  hubIn("#hub-research-rounds").value = String(s.research_max_rounds);
  hubIn("#hub-local-web").checked = s.local_web_search;
  hubSel("#hub-web-provider").value = s.web_search_provider;
  applyWebProviderUi(true);
  hubIn("#hub-num-ctx").value = String(s.ollama_num_ctx);
  hubIn("#hub-temp").value = String(s.ollama_temperature);
  hubIn("#hub-memory-dir").value = s.memory_dir;
  hubIn("#hub-claude-md").value = s.claude_md_path;
  hubIn("#hub-workspace-dir").value = s.workspace_dir;
  hubSel("#hub-confirm-mode").value = s.confirm_mode;
  hubIn("#hub-browser-tools").checked = s.enable_browser_tools;
  hubIn("#hub-browser-sidecar").value = s.browser_sidecar_script;
  hubIn("#hub-browser-node").value = s.browser_node_path;
  hubIn("#hub-browser-data").value = s.browser_user_data_dir;
}

/** Metadados por motor de pesquisa: rótulo, página da chave e free tier (null = keyless). */
const WEB_PROVIDER_META: Record<string, { label: string; url: string; free: string } | null> = {
  duckduckgo: null,
  tavily: { label: "Tavily", url: "https://tavily.com", free: "~1000/mês" },
  brave: { label: "Brave", url: "https://brave.com/search/api/", free: "~2000/mês" },
  serper: { label: "Serper", url: "https://serper.dev", free: "~2500" },
  exa: { label: "Exa", url: "https://exa.ai", free: "~1000/mês" },
  jina: { label: "Jina", url: "https://jina.ai/reader", free: "10M tokens" },
};

/** Atualiza o campo de chave (rótulo, link, valor) ao motor selecionado; esconde-o no keyless. */
function applyWebProviderUi(loadValue: boolean) {
  const p = hubSel("#hub-web-provider").value;
  const meta = WEB_PROVIDER_META[p] ?? null;
  const wrap = document.querySelector<HTMLElement>("#hub-web-key-wrap")!;
  const hint = document.querySelector<HTMLElement>("#hub-web-hint")!;
  if (!meta) {
    wrap.hidden = true;
    hint.textContent = t("Sem chave (DuckDuckGo) é pouco fiável e costuma devolver vazio. Escolhe um motor com chave para pesquisa fiável.");
    return;
  }
  wrap.hidden = false;
  document.querySelector("#hub-web-key-text")!.textContent = t("Chave {p}", { p: meta.label });
  if (loadValue) hubIn("#hub-web-key").value = state.settings?.web_search_keys?.[p] ?? "";
  const a = document.createElement("a");
  a.href = meta.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = `${t("obter chave grátis")} →`;
  hint.textContent = `${t("Pesquisa fiável.")} `;
  hint.appendChild(a);
  hint.appendChild(document.createTextNode(` (${t("grátis")}: ${meta.free})`));
}

/** Constrói o mapa de chaves a guardar: preserva as outras e atualiza a do motor atual. */
function webSearchKeysPatch(): Record<string, string> {
  const keys = { ...(state.settings?.web_search_keys ?? {}) };
  const p = hubSel("#hub-web-provider").value;
  if (p !== "duckduckgo") keys[p] = hubIn("#hub-web-key").value;
  return keys;
}

function applyHubProviderFields() {
  const lp = hubSel("#hub-local-provider").value;
  const cp = hubSel("#hub-cloud-provider").value;
  document.querySelector("#hub-ollama-fields")!.toggleAttribute("hidden", lp !== "ollama");
  document.querySelector("#hub-ollama-mgmt")!.toggleAttribute("hidden", lp !== "ollama");
  document.querySelector("#hub-openai-local-fields")!.toggleAttribute("hidden", lp !== "openai");
  document.querySelector("#hub-lmstudio-mgmt")!.toggleAttribute("hidden", lp !== "openai");
  if (lp === "openai") void renderLmInstalled();
  document.querySelector("#hub-claude-fields")!.toggleAttribute("hidden", cp !== "claude");
  document.querySelector("#hub-openai-cloud-fields")!.toggleAttribute("hidden", cp !== "openai");
}

async function saveModelsSettings(patch: Partial<Settings>) {
  if (!state.settings) return;
  const updated = { ...state.settings, ...patch };
  await api.saveSettings(updated);
  state.settings = updated;
  applyComposerToggles();
}

async function hubSave() {
  const presetVal = hubSel("#hub-claude-preset").value;
  const claudeModel =
    presetVal === "__custom__" ? hubIn("#hub-claude-model").value.trim() : presetVal;
  try {
    await saveModelsSettings({
      local_provider: hubSel("#hub-local-provider").value as Settings["local_provider"],
      ollama_endpoint: hubIn("#hub-ollama-endpoint").value.trim(),
      ollama_vision_model: hubIn("#hub-vision").value.trim(),
      openai_local_endpoint: hubIn("#hub-oai-local-endpoint").value.trim(),
      openai_local_key: hubIn("#hub-oai-local-key").value,
      openai_local_model: hubIn("#hub-oai-local-model").value.trim(),
      cloud_provider: hubSel("#hub-cloud-provider").value as Settings["cloud_provider"],
      claude_mode: hubSel("#hub-claude-mode").value as Settings["claude_mode"],
      claude_model: claudeModel,
      claude_cli_path: hubIn("#hub-claude-cli").value.trim(),
      claude_api_key: hubIn("#hub-claude-key").value,
      claude_max_tokens: parseInt(hubIn("#hub-claude-maxtok").value) || 2048,
      openai_cloud_endpoint: hubIn("#hub-oai-cloud-endpoint").value.trim(),
      openai_cloud_key: hubIn("#hub-oai-cloud-key").value,
      openai_cloud_model: hubIn("#hub-oai-cloud-model").value.trim(),
      // Avançado
      research_max_rounds: Math.min(5, Math.max(1, parseInt(hubIn("#hub-research-rounds").value) || 3)),
      local_web_search: hubIn("#hub-local-web").checked,
      web_search_provider: hubSel("#hub-web-provider").value as Settings["web_search_provider"],
      web_search_keys: webSearchKeysPatch(),
      ollama_num_ctx: Math.max(2048, parseInt(hubIn("#hub-num-ctx").value) || 8192),
      ollama_temperature: Math.min(1.5, Math.max(0, parseFloat(hubIn("#hub-temp").value) || 0.4)),
      memory_dir: hubIn("#hub-memory-dir").value,
      claude_md_path: hubIn("#hub-claude-md").value,
      workspace_dir: hubIn("#hub-workspace-dir").value,
      confirm_mode: hubSel("#hub-confirm-mode").value as Settings["confirm_mode"],
      enable_browser_tools: hubIn("#hub-browser-tools").checked,
      browser_sidecar_script: hubIn("#hub-browser-sidecar").value,
      browser_node_path: hubIn("#hub-browser-node").value,
      browser_user_data_dir: hubIn("#hub-browser-data").value,
    });
    document.querySelector("#hub-status")!.textContent = t("✓ Guardado");
    void renderHubStatus();
  } catch (e) {
    alert(t("Falha a guardar: ") + e);
  }
}

async function renderHubStatus() {
  const el = document.querySelector("#hub-status")!;
  const s = state.settings;
  const active = s?.ollama_model ?? "";
  const isOllama = s?.local_provider === "ollama";
  let warn = "";
  if (isOllama && s?.local_web_search && active && !modelHasTools(active)) {
    // Pesquisa web ligada mas o modelo não chama ferramentas → nunca vai pesquisar.
    warn =
      " " +
      t("⚠ '{m}' não chama ferramentas — a pesquisa web não funciona; usa um modelo 🛠 (ex.: qwen3, llama3.1).", {
        m: active,
      });
  } else if (isOllama && isWeakModel(active)) {
    warn =
      " " +
      t("⚠ '{m}' é pequeno — respostas e pesquisa web podem falhar; experimenta llama3.1 ou qwen2.5.", {
        m: active,
      });
  }
  try {
    const d = await api.diagnostics();
    el.textContent =
      (d.ollama_ok
        ? t("Ollama ligado · {n} modelos", { n: d.ollama_models.length })
        : t("Ollama não acessível — instala em ollama.com e confirma o endpoint")) + warn;
  } catch {
    el.textContent = "—" + warn;
  }
}

async function renderInstalled() {
  const list = document.querySelector<HTMLDivElement>("#hub-installed")!;
  let models: OllamaModel[] = [];
  try {
    models = await api.listOllamaModelsDetailed();
  } catch {
    models = [];
  }
  // alimenta o datalist partilhado (#ollama-models) para os campos com sugestões
  els.modelsList.innerHTML = models.map((m) => `<option value="${escapeHtml(m.name)}"></option>`).join("");
  if (models.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Sem modelos. Puxa um abaixo.")}</div>`;
    return;
  }
  const active = state.settings?.ollama_model;
  list.innerHTML = models
    .map(
      (m) => `
    <div class="model-item${m.name === active ? " active" : ""}">
      <div class="model-main">
        <strong>${escapeHtml(m.name)} <span class="qp-caps">${capBadges(m.name)}</span></strong>
        <span>${escapeHtml([m.parameter_size, fmtSize(m.size), m.quantization].filter(Boolean).join(" · "))}</span>
      </div>
      <div class="model-actions">
        ${m.name === active ? `<span class="model-badge">${t("ativo")}</span>` : `<button type="button" class="ghost" data-activate="${escapeHtml(m.name)}">${t("Ativar")}</button>`}
        <button type="button" class="ghost" data-del="${escapeHtml(m.name)}">✕</button>
      </div>
    </div>`
    )
    .join("");
  list
    .querySelectorAll<HTMLButtonElement>("[data-activate]")
    .forEach((b) => b.addEventListener("click", () => setActiveModel(b.dataset.activate!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-del]")
    .forEach((b) => b.addEventListener("click", () => deleteModelUi(b.dataset.del!)));
}

async function setActiveModel(name: string) {
  await saveModelsSettings({ ollama_model: name, local_provider: "ollama" });
  await renderInstalled();
}

async function deleteModelUi(name: string) {
  if (!confirm(t("Apagar o modelo \"{name}\"?", { name }))) return;
  try {
    await api.deleteOllamaModel(name);
    await renderInstalled();
  } catch (e) {
    alert(t("Falha a apagar: ") + e);
  }
}

/** Badges a partir de capacidades já conhecidas (do registo ollama.com). */
function regCapBadges(caps: string[]): string {
  const map: Record<string, [string, string]> = {
    vision: ["eye", t("Visão (imagens)")],
    tools: ["tool", t("Ferramentas / pesquisa web")],
    thinking: ["brain", t("Raciocínio")],
    embedding: ["hash", t("Embeddings")],
  };
  return caps
    .map((c) => (map[c] ? `<span class="cap" title="${map[c][1]}">${icon(map[c][0])}</span>` : ""))
    .join("");
}

let regSearchTimer: number | undefined;
/** Liga a caixa de pesquisa do ollama.com (debounced) à lista de resultados. */
function wireOllamaSearch() {
  const box = document.querySelector<HTMLInputElement>("#hub-search");
  const results = document.querySelector<HTMLElement>("#hub-search-results");
  const quick = document.querySelector<HTMLElement>("#hub-quickpicks");
  if (!box || !results || !quick) return;
  box.addEventListener("input", () => {
    const q = box.value.trim();
    if (regSearchTimer) clearTimeout(regSearchTimer);
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      quick.hidden = false;
      return;
    }
    quick.hidden = true;
    results.hidden = false;
    results.innerHTML = `<div class="reg-loading">${t("A procurar…")}</div>`;
    regSearchTimer = window.setTimeout(async () => {
      try {
        renderRegistryResults(await api.searchOllamaRegistry(q));
      } catch {
        results.innerHTML = `<div class="empty-sm">${t("Não foi possível contactar o ollama.com.")}</div>`;
      }
    }, 300);
  });
}

/** Render dos resultados de pesquisa do ollama.com (estilo LM Studio). */
function renderRegistryResults(models: RegistryModel[]) {
  const box = document.querySelector<HTMLElement>("#hub-search-results")!;
  if (!models.length) {
    box.innerHTML = `<div class="empty-sm">${t("Sem resultados.")}</div>`;
    return;
  }
  box.innerHTML = models
    .map((m) => {
      const meta = [m.pulls ? `${escapeHtml(m.pulls)} ↓` : "", escapeHtml(m.updated)]
        .filter(Boolean)
        .join(" · ");
      const sizes = m.sizes.length
        ? m.sizes
            .map((s) => `<button type="button" class="quickpick" data-pull="${escapeHtml(m.name)}:${escapeHtml(s)}">${escapeHtml(s)}</button>`)
            .join("")
        : `<button type="button" class="quickpick" data-pull="${escapeHtml(m.name)}">${t("Puxar")}</button>`;
      return `<div class="reg-item">
        <div class="reg-head">
          <a class="reg-name" href="https://ollama.com/library/${escapeHtml(m.name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.name)}</a>
          <span class="qp-caps">${regCapBadges(m.capabilities)}</span>
          <span class="reg-meta">${meta}</span>
        </div>
        ${m.description ? `<div class="reg-desc">${escapeHtml(m.description)}</div>` : ""}
        <div class="reg-sizes">${sizes}</div>
      </div>`;
    })
    .join("");
  box
    .querySelectorAll<HTMLButtonElement>("[data-pull]")
    .forEach((b) => b.addEventListener("click", () => pullModelUi(b.dataset.pull!)));
}

// ---- LM Studio (catálogo + instalados) ----
/** Define o modelo LM Studio ativo (e muda o provider para openai). */
async function setActiveLmModel(id: string) {
  await saveModelsSettings({ local_provider: "openai", openai_local_model: id });
  hubSel("#hub-local-provider").value = "openai";
  applyHubProviderFields();
  void renderLmInstalled();
}

/** Lista os modelos descarregados no LM Studio (servidor REST local). */
async function renderLmInstalled() {
  const list = document.querySelector<HTMLDivElement>("#hub-lm-installed");
  const status = document.querySelector<HTMLElement>("#hub-lm-status");
  if (!list) return;
  let models: import("./api").LmModel[] = [];
  try {
    models = await api.lmstudioList();
    if (status) status.textContent = "";
  } catch {
    list.innerHTML = "";
    if (status)
      status.textContent = t("LM Studio inacessível — abre a app e liga o servidor (Developer).");
    return;
  }
  const active = state.settings?.openai_local_model;
  if (!models.length) {
    list.innerHTML = `<div class="empty-sm">${t("Nenhum modelo no LM Studio. Instala um abaixo.")}</div>`;
    return;
  }
  list.innerHTML = models
    .map((m) => {
      const tags = [m.kind, m.quantization].filter(Boolean).join(" · ");
      return `<div class="model-item${m.id === active ? " active" : ""}">
        <div class="model-main"><strong>${escapeHtml(m.id)} <span class="qp-caps">${regCapBadges(m.kind === "vlm" ? ["vision"] : m.kind === "embeddings" ? ["embedding"] : [])}</span></strong>
          <span>${escapeHtml(tags)}</span></div>
        <div class="model-actions">
          ${m.id === active ? `<span class="model-badge">${t("ativo")}</span>` : `<button type="button" class="ghost" data-use="${escapeHtml(m.id)}">${t("Usar")}</button>`}
        </div>
      </div>`;
    })
    .join("");
  list
    .querySelectorAll<HTMLButtonElement>("[data-use]")
    .forEach((b) => b.addEventListener("click", () => setActiveLmModel(b.dataset.use!)));
}

let lmSearchTimer: number | undefined;
/** Liga a pesquisa do catálogo LM Studio (lmstudio.ai) — descoberta + abrir página. */
function wireLmStudioSearch() {
  const box = document.querySelector<HTMLInputElement>("#hub-lm-search");
  const results = document.querySelector<HTMLElement>("#hub-lm-results");
  if (!box || !results) return;
  box.addEventListener("input", () => {
    const q = box.value.trim();
    if (lmSearchTimer) clearTimeout(lmSearchTimer);
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    results.hidden = false;
    results.innerHTML = `<div class="reg-loading">${t("A procurar…")}</div>`;
    lmSearchTimer = window.setTimeout(async () => {
      try {
        const models = await api.lmstudioSearch(q);
        results.innerHTML = models.length
          ? models
              .map(
                (m) => `<div class="reg-item">
                  <div class="reg-head">
                    <a class="reg-name" href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.name)}</a>
                    <span class="reg-meta">${m.sizes.map(escapeHtml).join(" · ")}</span>
                  </div>
                  <div class="reg-desc">${t("Abre a página para copiar o id e instalar abaixo.")}</div>
                </div>`
              )
              .join("")
          : `<div class="empty-sm">${t("Sem resultados.")}</div>`;
      } catch {
        results.innerHTML = `<div class="empty-sm">${t("Não foi possível contactar o lmstudio.ai.")}</div>`;
      }
    }, 300);
  });
}

/** Instala um modelo no LM Studio por id/URL, com progresso no toast global. */
async function lmInstallUi() {
  const model = (document.querySelector("#hub-lm-install") as HTMLInputElement).value.trim();
  const quant = (document.querySelector("#hub-lm-quant") as HTMLInputElement).value.trim();
  if (!model) return;
  const toast = document.querySelector<HTMLElement>("#dl-toast")!;
  const label = document.querySelector<HTMLElement>("#dl-toast-label")!;
  const bar = document.querySelector<HTMLElement>("#dl-toast-bar")!;
  toast.hidden = false;
  bar.style.width = "0%";
  label.textContent = `${t("A descarregar")} ${model}…`;
  const hideSoon = (ms: number) => setTimeout(() => (toast.hidden = true), ms);
  try {
    await api.lmstudioDownload(model, quant, (ev) => {
      if (ev.kind === "Progress") {
        if (ev.percent >= 0) bar.style.width = ev.percent.toFixed(0) + "%";
        label.textContent = `${model}: ${ev.status}${ev.percent >= 0 ? ` — ${ev.percent.toFixed(0)}%` : ""}`;
      } else if (ev.kind === "Done") {
        bar.style.width = "100%";
        label.textContent = `✓ ${model} ${t("descarregado")}`;
        void renderLmInstalled();
        hideSoon(2500);
      } else {
        label.textContent = "✗ " + ev.message;
        hideSoon(6000);
      }
    });
  } catch (e) {
    label.textContent = "✗ " + e;
    hideSoon(6000);
  }
}

/** Badges de capacidade (🛠 tools · 👁 visão · 🧠 raciocínio) com tooltip. */
function capBadges(name: string): string {
  const c = modelCapabilities(name);
  const parts: string[] = [];
  if (c.tools) parts.push(`<span class="cap" title="${t("Ferramentas / pesquisa web")}">${icon("tool")}</span>`);
  if (c.vision) parts.push(`<span class="cap" title="${t("Visão (imagens)")}">${icon("eye")}</span>`);
  if (c.reasoning) parts.push(`<span class="cap" title="${t("Raciocínio")}">${icon("brain")}</span>`);
  return parts.join("");
}

function renderQuickPicks() {
  const box = document.querySelector<HTMLDivElement>("#hub-quickpicks")!;
  box.innerHTML =
    `<div class="catalog-title">${t("Catálogo — clica para descarregar")}</div>` +
    `<div class="catalog-legend">${icon("tool")} ${t("ferramentas/web")} · ${icon("eye")} ${t("visão")} · ${icon("brain")} ${t("raciocínio")}</div>` +
    MODEL_CATALOG.map(
      (g) =>
        `<div class="catalog-group">${escapeHtml(t(g.group))}</div><div class="quickpicks">` +
        g.models
          .map(
            (m) =>
              `<button type="button" class="quickpick" data-pull="${escapeHtml(m.name)}" title="${escapeHtml(m.name)} · ${m.size}">${escapeHtml(m.name)} <span class="qp-size">${m.size}</span> <span class="qp-caps">${capBadges(m.name)}</span></button>`
          )
          .join("") +
        `</div>`
    ).join("");
  box
    .querySelectorAll<HTMLButtonElement>("[data-pull]")
    .forEach((b) => b.addEventListener("click", () => pullModelUi(b.dataset.pull!)));
}

async function pullModelUi(name: string) {
  name = name.trim();
  if (!name) return;
  // Toast global de download (visível em qualquer vista/scroll).
  const toast = document.querySelector<HTMLElement>("#dl-toast")!;
  const label = document.querySelector<HTMLElement>("#dl-toast-label")!;
  const bar = document.querySelector<HTMLElement>("#dl-toast-bar")!;
  toast.hidden = false;
  bar.style.width = "0%";
  label.textContent = `${t("A descarregar")} ${name}…`;
  const hideSoon = (ms: number) => setTimeout(() => (toast.hidden = true), ms);
  try {
    await api.pullOllamaModel(name, (ev) => {
      if (ev.kind === "Progress") {
        if (ev.percent >= 0) bar.style.width = ev.percent.toFixed(0) + "%";
        label.textContent = `${name}: ${ev.status}${ev.percent >= 0 ? ` — ${ev.percent.toFixed(0)}%` : ""}`;
      } else if (ev.kind === "Done") {
        bar.style.width = "100%";
        label.textContent = `✓ ${name} ${t("descarregado")}`;
        void renderInstalled();
        void renderHubStatus();
        hideSoon(2500);
      } else {
        label.textContent = "✗ " + ev.message;
        hideSoon(5000);
      }
    });
  } catch (e) {
    label.textContent = "✗ " + e;
    hideSoon(5000);
  }
}

// ---- Vistas no centro (os itens do rail abrem aqui, não em popup) ----
const CENTER_VIEWS: Record<string, HTMLDialogElement> = {
  workspace: wsDialog,
  servers: mcpDialog,
  activity: activityDialog,
  automations: automationsDialog,
  models: modelsDialog,
};

/** Mostra uma vista no centro (ou o chat, se null/"sagas"). */
function showView(view: string | null) {
  const inView = view !== null && view !== "sagas";
  for (const [name, el] of Object.entries(CENTER_VIEWS)) el.open = name === view;
  const chat = document.querySelector<HTMLElement>(".chat")!;
  chat.hidden = inView;
  // A lista de conversas e o painel de tokens (por Saga) só fazem sentido nas Sagas.
  els.layout.classList.toggle("viewing", inView);
  const reopen = document.querySelector<HTMLElement>("#panel-reopen");
  if (reopen) {
    reopen.hidden = inView || localStorage.getItem("saga.panelCollapsed") !== "1";
  }
  const active = view ?? "sagas";
  document
    .querySelectorAll<HTMLButtonElement>(".rail-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === active));
}

/** Move os painéis (ex-popups) para dentro do centro, na 1.ª vez. */
function mountViewsInCenter() {
  const center = document.querySelector("#center")!;
  for (const el of Object.values(CENTER_VIEWS)) center.appendChild(el);
}

function wireWorkspaceUi() {
  wsDialog
    .querySelectorAll<HTMLButtonElement>(".ws-tab")
    .forEach((b) => b.addEventListener("click", () => setWsKind(b.dataset.kind as typeof wsKind)));
  document.querySelector("#ws-new")!.addEventListener("click", newWsDoc);
  document.querySelector("#ws-save")!.addEventListener("click", saveWsDoc);
  document.querySelector("#ws-gen-btn")!.addEventListener("click", genWsDoc);
  document
    .querySelector("#ws-cancel")!
    .addEventListener("click", () => document.querySelector("#ws-editor")!.setAttribute("hidden", ""));
  document.querySelector("#ws-close")!.addEventListener("click", () => showView(null));

  document.querySelector("#mcp-add")!.addEventListener("click", addOrUpdateMcp);
  document.querySelector("#mcp-test")!.addEventListener("click", testMcp);
  document.querySelector("#mcp-close")!.addEventListener("click", () => showView(null));

  document.querySelector("#act-refresh")!.addEventListener("click", renderActivity);
  document.querySelector("#act-close")!.addEventListener("click", () => showView(null));

  document.querySelector("#sched-add")!.addEventListener("click", addOrUpdateSchedule);
  document.querySelector("#sched-close")!.addEventListener("click", () => showView(null));
  document.querySelector("#sched-preset")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v !== "__custom__") (document.querySelector("#sched-cron") as HTMLInputElement).value = v;
  });

  // Hub Modelos
  document.querySelector("#hub-save")!.addEventListener("click", hubSave);
  document.querySelector("#hub-close")!.addEventListener("click", () => showView(null));
  document.querySelector("#hub-local-provider")!.addEventListener("change", applyHubProviderFields);
  document.querySelector("#hub-cloud-provider")!.addEventListener("change", applyHubProviderFields);
  document.querySelector("#hub-web-provider")!.addEventListener("change", () => applyWebProviderUi(true));
  document.querySelector("#hub-claude-preset")!.addEventListener("change", () => {
    const v = hubSel("#hub-claude-preset").value;
    document.querySelector("#hub-claude-custom-wrap")!.toggleAttribute("hidden", v !== "__custom__");
    if (v !== "__custom__") hubIn("#hub-claude-model").value = v;
  });
  document.querySelector("#hub-pull-btn")!.addEventListener("click", () =>
    pullModelUi(hubIn("#hub-pull-name").value)
  );
  wireOllamaSearch();
  wireLmStudioSearch();
  document.querySelector("#hub-lm-install-btn")!.addEventListener("click", lmInstallUi);
  document.querySelector("#hub-lm-refresh")!.addEventListener("click", () => void renderLmInstalled());

  document.querySelectorAll<HTMLButtonElement>(".rail-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      if (v === "workspace") openWorkspace();
      else if (v === "servers") openMcp();
      else if (v === "activity") openActivity();
      else if (v === "automations") openAutomations();
      else if (v === "models") openModels();
      else showView(null); // "sagas" → volta ao chat
    })
  );
}

async function init() {
  mountViewsInCenter();
  els.composer.addEventListener("submit", onSubmit);
  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("input", updateSlashMenu);
  els.input.addEventListener("blur", () => setTimeout(hideSlash, 150));
  els.input.addEventListener("keydown", (e) => {
    if (slashOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSel = (slashSel + 1) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSel = (slashSel - 1 + slashItems.length) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSlash(slashSel);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlash();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  document.querySelector("#btn-settings")!.addEventListener("click", () => {
    els.dialog.showModal();
  });
  document.querySelector("#btn-mem-refresh")!.addEventListener("click", refreshMemory);
  document.querySelector("#btn-compact")!.addEventListener("click", compactCurrentSaga);
  document.querySelector("#btn-clear-saga")!.addEventListener("click", clearCurrentSaga);
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
  document.querySelector("#wiz-next")!.addEventListener("click", () => void wizNext());
  document.querySelector("#wiz-back")!.addEventListener("click", () => void wizGoTo(wizStep - 1));
  document.querySelector("#wiz-skip")!.addEventListener("click", (e) => {
    e.preventDefault();
    void finishWizard();
  });
  document.querySelector("#w_claude_mode")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    document.querySelector("#wiz-key-wrap")!.toggleAttribute("hidden", v !== "api");
  });
  els.routeModeBar.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setRouteMode((btn.dataset.mode as "local" | "claude") ?? "local"));
  });
  document.querySelector("#btn-think")!.addEventListener("click", (e) => {
    state.thinking = !state.thinking;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.thinking);
  });
  document.querySelector("#btn-research")!.addEventListener("click", (e) => {
    state.research = !state.research;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.research);
    if (state.research) maybeWarnSearch();
  });
  document.querySelector("#btn-subagents")!.addEventListener("click", (e) => {
    state.subagents = !state.subagents;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.subagents);
  });
  document.querySelector("#btn-agent")!.addEventListener("click", () => void openAgentMenu());
  els.artifactClose.addEventListener("click", closeArtifact);
  els.artifactToggle.addEventListener("click", () => {
    artifactMode = artifactMode === "preview" ? "code" : "preview";
    renderArtifactBody();
  });
  els.artifactCopy.addEventListener("click", () => {
    if (artifactCurrent) navigator.clipboard?.writeText(artifactCurrent.code);
  });
  document.querySelector("#artifact-export")!.addEventListener("click", exportArtifact);
  document.querySelector("#artifact-pdf")!.addEventListener("click", exportArtifactPdf);
  document.querySelector("#artifact-gallery")!.addEventListener("click", openGallery);
  document.querySelector("#btn-export-saga")!.addEventListener("click", exportSaga);
  document.querySelector("#btn-check-update")!.addEventListener("click", checkForUpdates);
  // Abre QUALQUER link externo (Sobre, Fontes, markdown) no browser do sistema (Tauri não o faz sozinho).
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (a && /^https?:\/\//i.test(a.href)) {
      e.preventDefault();
      openUrl(a.href).catch((err) => console.error("openUrl", err));
    }
  });
  wireWorkspaceUi();
  refreshSlashWorkflows();

  // Zoom da interface (Ctrl/⌘ +/−/0) + controlos nas definições.
  initZoom();
  onZoomChange((z) => {
    const el = document.querySelector("#zoom-val");
    if (el) el.textContent = Math.round(z * 100) + "%";
  });
  const langSel = document.querySelector<HTMLSelectElement>("#lang-select");
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener("change", () => {
      setLang(langSel.value as "pt" | "en");
      location.reload(); // re-monta o template no novo idioma
    });
  }
  document.querySelector("#zoom-in")!.addEventListener("click", () => nudgeZoom(0.1));
  document.querySelector("#zoom-out")!.addEventListener("click", () => nudgeZoom(-0.1));
  document.querySelector("#zoom-reset")!.addEventListener("click", resetZoom);

  // Tamanho do texto do chat (CSS var --font-scale), separado do zoom da interface.
  const FONT_KEY = "saga.fontScale";
  const applyFontScale = (s: number): number => {
    const v = Math.min(1.6, Math.max(0.8, Math.round(s * 20) / 20));
    document.documentElement.style.setProperty("--font-scale", String(v));
    localStorage.setItem(FONT_KEY, String(v));
    const lbl = document.querySelector("#font-val");
    if (lbl) lbl.textContent = Math.round(v * 100) + "%";
    return v;
  };
  let fontScale = applyFontScale(parseFloat(localStorage.getItem(FONT_KEY) || "1") || 1);
  document.querySelector("#font-in")!.addEventListener("click", () => {
    fontScale = applyFontScale(fontScale + 0.1);
  });
  document.querySelector("#font-out")!.addEventListener("click", () => {
    fontScale = applyFontScale(fontScale - 0.1);
  });
  document.querySelector("#font-reset")!.addEventListener("click", () => {
    fontScale = applyFontScale(1);
  });

  try {
    state.settings = await api.getSettings();
    applyComposerToggles();
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
  } finally {
    hideSplash();
  }
  // Mostra a versão no rodapé "Sobre" das Definições.
  getVersion()
    .then((v) => {
      const el = document.querySelector("#about-version");
      if (el) el.textContent = "v" + v;
    })
    .catch(() => {});
  // Verifica/descarrega atualizações em fundo, sem atrasar o arranque.
  setTimeout(autoUpdate, 4000);
}

/** Esconde o splash de arranque com fade e remove-o do DOM. */
function hideSplash() {
  const splash = document.querySelector<HTMLElement>("#splash");
  if (!splash) return;
  // pequena espera para o splash não "piscar" em arranques muito rápidos
  setTimeout(() => {
    splash.classList.add("splash-hide");
    setTimeout(() => splash.remove(), 450);
  }, 250);
}

init();
