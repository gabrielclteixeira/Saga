import "./style.css";
import { caravelLoader } from "./caravel-loader";
import { initZoom, nudgeZoom, onZoomChange, resetZoom } from "./zoom";
import { initLang, getLang, setLang, t } from "./i18n";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import mermaid from "mermaid";
import { save, open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  type Accounting,
  type ActionLogEntry,
  type Attachment,
  type ChatMessage,
  type ChatResponse,
  type ClaudeCliModelsResult,
  type ConversationMeta,
  type Diagnostics,
  type DistillProposal,
  type DocMeta,
  type McpServerConfig,
  type OllamaModel,
  type RegistryModel,
  type Schedule,
  type SearchHit,
  type Settings,
  type StoredMessage,
  type Topic,
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
  plan?: { steps: { title: string; status: "pending" | "executing" | "searching" | "done" | "error" }[] };
}

/** Nível de esforço de raciocínio (Think): off → nativo → self-consistency → debate. */
type ThinkLevel = "off" | "think" | "verify" | "debate";

const state: {
  items: Item[];
  settings: Settings | null;
  busy: boolean;
  conversations: ConversationMeta[];
  currentConversationId: number | null;
  pendingAttachments: Attachment[];
  routeMode: "local" | "claude";
  thinkLevel: ThinkLevel;
  research: boolean;
  subagents: boolean;
  plan: boolean;
  compactedSummary: string;
  compactedUpto: number; // id da última mensagem compactada (0 = sem compactação)
  activeAgent: { name: string; system: string; route: "local" | "claude"; model: string } | null;
  topics: Topic[];
  activeTopicId: number | null; // tópico onde nascem as Sagas novas (segue o chat aberto)
} = {
  items: [],
  settings: null,
  busy: false,
  conversations: [],
  currentConversationId: null,
  pendingAttachments: [],
  routeMode: "local",
  thinkLevel: "off",
  research: false,
  subagents: false,
  plan: false,
  compactedSummary: "",
  compactedUpto: 0,
  activeAgent: null,
  topics: [],
  activeTopicId: readActiveTopic(),
};

/** Tópico ativo persistido (onde nascem as Sagas novas). */
function readActiveTopic(): number | null {
  const v = localStorage.getItem("saga.activeTopic");
  return v ? Number(v) || null : null;
}
function setActiveTopic(id: number | null) {
  state.activeTopicId = id;
  if (id == null) localStorage.removeItem("saga.activeTopic");
  else localStorage.setItem("saga.activeTopic", String(id));
}

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
  download: `<path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 21h14"/>`,
  gear: `<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  export: `<path d="M12 15V3"/><polyline points="7 8 12 3 17 8"/><path d="M5 21h14a2 2 0 0 0 2-2v-4"/><path d="M3 15v4a2 2 0 0 0 2 2"/>`,
  book: `<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M19 17H6a2 2 0 0 0-2 2"/>`,
  chevron: `<polyline points="9 6 15 12 9 18"/>`,
  plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  dots: `<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  circle: `<circle cx="12" cy="12" r="8"/>`,
  info: `<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  list: `<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/>`,
  x: `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`,
};
function icon(name: string): string {
  const p = ICON_PATHS[name];
  return p
    ? `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
    : "";
}

initLang();

/** Extensões de documento aceites (texto extraído no backend). Imagens vão por `image/*`. */
const DOC_EXTS = [
  "pdf", "docx", "txt", "md", "markdown", "csv", "tsv", "json", "log",
  "xlsx", "xls", "xlsm", "ods", "yaml", "yml", "toml", "xml",
  "rs", "py", "js", "ts", "html", "css", "sql",
];
/** Filtro do seletor de ficheiros: imagens + os tipos de documento acima. */
const ATTACH_ACCEPT = "image/*," + DOC_EXTS.map((e) => "." + e).join(",");

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" class="brand-mark" alt="" /> <strong>Saga</strong></div>
    <div class="mini" id="mini-stats"></div>
    <button class="icon-btn" id="btn-export-saga" title="${t("Exportar Saga (Markdown)")}" aria-label="${t("Exportar Saga (Markdown)")}">${icon("export")}</button>
    <button class="icon-btn" id="btn-panel" title="${t("Painel de tokens")}" aria-label="${t("Painel de tokens")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg></button>
    <button class="icon-btn" id="btn-settings" title="${t("Definições")}" aria-label="${t("Definições")}">${icon("gear")}</button>
  </header>
  <main class="layout">
    <nav class="rail" id="rail">
      <button type="button" class="rail-btn active" data-view="sagas" title="Sagas"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg></span><span class="rail-lbl">${t("Sagas")}</span></button>
      <button type="button" class="rail-btn" data-view="workspace" title="${t("Workspace (skills, playbooks, workflows)")}"><span class="rail-ico">${icon("book")}</span><span class="rail-lbl">${t("Workspace")}</span></button>
      <button type="button" class="rail-btn" data-view="servers" title="${t("Servidores MCP")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="6.5" y1="7.5" x2="6.5" y2="7.5"/><line x1="6.5" y1="16.5" x2="6.5" y2="16.5"/></svg></span><span class="rail-lbl">${t("Servidores")}</span></button>
      <button type="button" class="rail-btn" data-view="activity" title="${t("Atividade (ações)")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4.5" y1="6" x2="4.5" y2="6"/><line x1="4.5" y1="12" x2="4.5" y2="12"/><line x1="4.5" y1="18" x2="4.5" y2="18"/></svg></span><span class="rail-lbl">${t("Atividade")}</span></button>
      <button type="button" class="rail-btn" data-view="automations" title="${t("Automações agendadas")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.7l3 1.8"/></svg></span><span class="rail-lbl">${t("Automações")}</span></button>
      <button type="button" class="rail-btn" data-view="models" title="${t("Modelos (instalar/configurar)")}"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg></span><span class="rail-lbl">${t("Modelos")}</span></button>
    </nav>
    <aside class="sidebar">
      <button class="new-chat" id="btn-new-chat">${t("+ Nova Saga")}</button>
      <input class="conv-search" id="conv-search" type="search" placeholder="${t("Pesquisar Sagas…")}" autocomplete="off" />
      <button class="new-topic" id="btn-new-topic" title="${t("Novo tópico")}">${icon("folder")}<span>${t("Novo tópico")}</span></button>
      <div class="conv-list" id="conv-list"></div>
    </aside>
    <div class="center" id="center">
    <section class="chat">
      <div class="find-bar" id="find-bar" hidden>
        <input id="find-input" type="text" placeholder="${t("Procurar na conversa…")}" autocomplete="off" />
        <span class="find-count" id="find-count">0/0</span>
        <button type="button" class="icon-x" id="find-prev" title="${t("Anterior")}" aria-label="${t("Anterior")}">${icon("chevron")}</button>
        <button type="button" class="icon-x" id="find-next" title="${t("Seguinte")}" aria-label="${t("Seguinte")}">${icon("chevron")}</button>
        <button type="button" class="icon-x" id="find-close" title="${t("Fechar")}" aria-label="${t("Fechar")}">${icon("x")}</button>
      </div>
      <div class="messages" id="messages">
        <div class="empty">${t("Faz uma pergunta. Corre no teu modelo local; escala para o Claude quando quiseres.")}</div>
      </div>
      <button type="button" class="scroll-bottom" id="scroll-bottom" title="${t("Ir para a mensagem mais recente")}" aria-label="${t("Ir para a mensagem mais recente")}" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>
      <div class="drop-overlay" id="drop-overlay"><div class="drop-overlay-inner">${icon("download")}<span>${t("Larga para anexar")}</span></div></div>
      <div class="attachments" id="attachments"></div>
      <div class="route-mode" id="route-mode">
        <span class="route-pick" id="route-pick" hidden>
          <button type="button" data-mode="local" class="active">${t("Local")}</button>
          <button type="button" data-mode="claude">${t("Claude")}</button>
        </span>
        <span class="composer-toggles">
          <button type="button" id="btn-agent" class="chip-toggle" title="${t("Escolher um agente (persona)")}">${icon("sparkles")}<span id="btn-agent-label">${t("Agente")}</span></button>
          <button type="button" id="btn-plan" class="chip-toggle" title="${t("Plan mode: rascunha um plano de passos, aprovas/editas, e executa passo a passo")}">${icon("list")}<span>${t("Plano")}</span></button>
          <button type="button" id="btn-subagents" class="chip-toggle" title="${t("Subagentes (API: orquestra em paralelo · CLI: ferramenta Task)")}">${icon("nodes")}<span>${t("Subagentes")}</span></button>
          <button type="button" id="btn-research" class="chip-toggle" title="${t("Pesquisa web (API: web_search · CLI: WebSearch)")}">${icon("search")}<span>${t("Pesquisar")}</span></button>
          <span class="think-split">
            <button type="button" id="btn-think" class="chip-toggle" title="${t("Nível de raciocínio (Think)")}" aria-haspopup="true">${icon("brain")}<span id="btn-think-label">${t("Think")}</span><span class="think-caret">${icon("chevron")}</span></button>
            <div class="think-menu" id="think-menu" hidden>
              <button type="button" data-level="off">${t("Desligado")}</button>
              <button type="button" data-level="think">${t("Nativo (pensar)")}</button>
              <button type="button" data-level="verify">${t("Verificar (consenso)")}</button>
              <button type="button" data-level="debate">${t("Debater")}</button>
            </div>
          </span>
        </span>
      </div>
      <div class="slash-menu" id="slash-menu" hidden></div>
      <form class="composer" id="composer">
        <button type="button" class="attach-btn" id="btn-attach" title="${t("Anexar ficheiro")}" aria-label="${t("Anexar ficheiro")}"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <input type="file" id="file-input" accept="${ATTACH_ACCEPT}" multiple hidden />
        <textarea id="input" rows="1" placeholder="${t("Escreve uma mensagem…")}" autocomplete="off"></textarea>
        <button type="submit" id="send">${t("Enviar")}</button>
      </form>
    </section>
    </div>
    <aside class="panel">
      <button class="panel-collapse" id="panel-collapse" title="${t("Ocultar painel")}" aria-label="${t("Ocultar painel")}">${icon("chevron")}</button>
      <h2>${t("Painel de tokens")}</h2>
      <div class="cards" id="acct-cards"></div>
      <div class="saga-actions">
        <span class="ctx-est" id="ctx-est" title="${t("Contexto enviado ao modelo (estimativa)")}"></span>
        <span class="saga-actions-btns">
          <button class="ghost" id="btn-compact" title="${t("Resumir as mensagens antigas com o modelo local para poupar contexto")}">${t("Compactar")}</button>
          <button class="ghost" id="btn-clear-saga" title="${t("Apagar as mensagens desta Saga")}">${t("Limpar")}</button>
        </span>
      </div>
      <h3>${t("Pesquisas web (este mês)")}</h3>
      <div class="search-usage" id="search-usage"></div>
      <h3>${t("Memória carregada")}</h3>
      <pre class="mem" id="mem-preview">—</pre>
      <button class="ghost" id="btn-mem-refresh">${t("Atualizar pré-visualização")}</button>
    </aside>
    <div class="drawer-scrim" id="drawer-scrim" aria-hidden="true"></div>
  </main>


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
        <select class="pdf-theme" id="artifact-pdf-theme" title="${t("Estilo do PDF")}" aria-label="${t("Estilo do PDF")}">
          <option value="report">${t("Relatório")}</option>
          <option value="article">${t("Artigo")}</option>
          <option value="technical">${t("Técnico")}</option>
        </select>
        <button type="button" class="ghost" id="artifact-pdf">${t("PDF")}</button>
        <button type="button" class="ghost" id="artifact-save-project" title="${t("Guardar no projeto")}" aria-label="${t("Guardar no projeto")}" hidden>${icon("folder")}</button>
        <button type="button" class="ghost" id="artifact-export">${t("Guardar")}</button>
        <button type="button" class="ghost" id="artifact-copy">${t("Copiar")}</button>
        <span class="artifact-more-wrap" id="artifact-more-wrap" hidden>
          <button type="button" class="ghost" id="artifact-more" title="${t("Mais")}" aria-haspopup="true">${icon("dots")}</button>
          <div class="artifact-more-menu" id="artifact-more-menu" hidden></div>
        </span>
        <button type="button" class="icon-x" id="artifact-close" title="${t("Fechar")}" aria-label="${t("Fechar")}">${icon("x")}</button>
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

      <fieldset>
        <legend>${t("Sistema")}</legend>
        <label class="ws-check"><input type="checkbox" id="set-autostart" /> ${t("Iniciar com o sistema")}</label>
        <p class="wiz-hint">${t("Mantém as automações agendadas a correr. Fechar a janela com automações ativas envia o Saga para a bandeja do sistema.")}</p>
        <div class="log-row">
          <span class="log-label">${t("Diagnóstico / Logs")}</span>
          <code class="log-path" id="log-path">—</code>
          <span class="row">
            <button type="button" class="ghost" id="btn-open-logs">${t("Abrir pasta de logs")}</button>
            <button type="button" class="ghost" id="btn-copy-logpath">${t("Copiar caminho")}</button>
          </span>
        </div>
        <p class="wiz-hint">${t("Se a app falhar, abre/partilha o ficheiro Saga.log desta pasta.")}</p>
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
      <div class="ws-head">
        <h2>${t("Workspace")}</h2>
        <button type="button" class="icon-x" id="ws-x" title="${t("Fechar")}" aria-label="${t("Fechar")}">${icon("x")}</button>
      </div>
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
            <div class="ws-gen-row">
              <button type="button" class="ghost" id="ws-gen-btn">${t("Gerar")}</button>
              <label class="check ws-gen-cloud" id="ws-gen-cloud-wrap" hidden title="${t("Gerar com o Claude (cloud) em vez do modelo local")}"><input type="checkbox" id="ws-gen-cloud" /> ${t("Usar Claude")}</label>
              <span class="pull-status" id="ws-gen-status"></span>
            </div>
          </div>
          <label>${t("Nome")} <input id="ws-name" type="text" placeholder="${t("nome-sem-espacos")}" /></label>
          <label>${t("Descrição")} <input id="ws-desc" type="text" placeholder="${t("o que é / quando usar")}" /></label>
          <label class="ws-inline" id="ws-topic-wrap" title="${t("Restringe este doc aos chats de um tópico; (todos) = global.")}">${t("Tópico")}
            <select id="ws-topic"><option value="">${t("(todos os tópicos)")}</option></select>
          </label>
          <label id="ws-triggers-wrap">${t("Triggers (palavras que ativam)")} <input id="ws-triggers" type="text" placeholder="${t("resumir, o que diz este link, …")}" /></label>
          <label id="ws-arghint-wrap" hidden>${t("Argumentos esperados")} <input id="ws-arghint" type="text" placeholder="${t("ex.: o URL a abrir")}" /></label>
          <label class="ws-inline" id="ws-workflow-route-wrap" hidden title="${t("Claude só se precisar de browser/ferramentas avançadas; senão corre local.")}">${t("Correr em")}
            <select id="ws-workflow-route">
              <option value="local">${t("Modelo local")}</option>
              <option value="claude">Claude</option>
            </select>
          </label>
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
            <label class="ws-check"><input type="checkbox" id="ws-agent-plan" /> ${t("Plano")}</label>
            <label class="ws-inline">${t("Think (raciocínio)")}
              <select id="ws-agent-think-level">
                <option value="off">${t("Desligado")}</option>
                <option value="think">${t("Nativo (pensar)")}</option>
                <option value="verify">${t("Verificar (consenso)")}</option>
                <option value="debate">${t("Debater")}</option>
              </select>
            </label>
            <label>${t("Modelo")} <input id="ws-agent-model" type="text" list="ollama-models" autocomplete="off" placeholder="${t("vazio = modelo ativo; cai no default se for apagado")}" /></label>
          </fieldset>
          <label id="ws-body-label">${t("Corpo (markdown)")}
            <textarea id="ws-content" rows="12" spellcheck="false" placeholder="${t("# Instruções…")}"></textarea>
          </label>
          <div class="ws-editor-bar">
            <button type="button" class="ghost" id="ws-cancel">${t("Cancelar")}</button>
            <button type="button" class="primary" id="ws-save">${t("Guardar")}</button>
          </div>
        </div>
      </div>
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
        <label>${t("Modelo")} <input id="sched-model" type="text" list="ollama-models" autocomplete="off" placeholder="${t("(default da rota)")}" /></label>
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
        </div>
        <div class="field-group" id="hub-openai-local-fields" hidden>
          <label>${t("Endpoint")} <input id="hub-oai-local-endpoint" type="text" placeholder="http://localhost:1234/v1" /></label>
          <label>${t("API key (opcional)")} <input id="hub-oai-local-key" type="password" /></label>
          <label>${t("Modelo")} <input id="hub-oai-local-model" type="text" placeholder="${t("ex.: ID no LM Studio")}" /></label>
          <p class="wiz-hint">${t("Os modelos descarregam-se na app do LM Studio. Aqui escolhes um já descarregado.")}</p>
          <div class="hub-subtitle">${t("Descarregados (LM Studio)")}</div>
          <div class="models-list" id="hub-lm-installed"></div>
          <div class="pull-status" id="hub-lm-status"></div>
          <button type="button" class="ghost" id="hub-lm-refresh">${t("Atualizar")}</button>
        </div>
      </fieldset>

      <fieldset id="hub-install">
        <legend>${t("Instalar um modelo (Ollama)")}</legend>
        <div class="search-box">
          ${icon("search")}
          <input id="hub-search" type="search" placeholder="${t("ex.: gemma, qwen, llama…")}" autocomplete="off" />
        </div>
        <div class="reg-results" id="hub-search-results"></div>
        <div class="hub-progress" id="hub-progress" hidden><div class="hub-bar" id="hub-bar"></div></div>
        <div class="pull-status" id="hub-pull-status"></div>

        <div class="hub-subtitle">${t("Instalados")}</div>
        <div class="hub-vision-warn" id="hub-vision-warn" hidden>${icon("eye")}<span>${t("Nenhum dos modelos instalados lê imagens. Instala um modelo com visão (ex.: gemma4) para poderes anexar imagens.")}</span></div>
        <div class="models-list" id="hub-installed"></div>
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
            <div class="model-pick-row">
              <select id="hub-claude-preset">
                <option value="claude-haiku-4-5-20251001">${t("Haiku 4.5 — rápido e barato")}</option>
                <option value="claude-sonnet-4-6">${t("Sonnet 4.6 — equilíbrio")}</option>
                <option value="claude-opus-4-8">${t("Opus 4.8 — topo")}</option>
                <option value="claude-fable-5">${t("Fable 5 — mais capaz")}</option>
                <option value="__custom__">${t("Personalizado…")}</option>
              </select>
              <button type="button" class="ghost" id="hub-claude-refresh-models" title="${t("Descobrir modelos pela CLI (corre o claude num terminal oculto)")}" hidden>${icon("refresh")}</button>
            </div>
          </label>
          <p class="wiz-hint" id="hub-claude-refresh-hint" hidden></p>
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
          <label class="check"><input id="hub-local-web" type="checkbox" /> ${t("Dar pesquisa web ao modelo local (corre no Ollama)")}</label>
          <p class="wiz-hint">${t("Precisa de um modelo Ollama com suporte a ferramentas (ex.: llama3.1, qwen2.5). Com isto desligado, a pesquisa força o Claude.")}</p>
          <label><span class="label-with-help">${t("Motor")} <span class="help-ic" title="${t("O DuckDuckGo é gratuito e sem chave, mas limita pesquisas em rajada — pode ficar lento ou bloquear temporariamente (a app espaça os pedidos para minimizar). Para pesquisa rápida e fiável, escolhe um motor com chave: Tavily e Brave têm tier gratuito.")}">${icon("info")}</span></span>
            <select id="hub-web-provider">
              <option value="duckduckgo">${t("DuckDuckGo (sem chave — recomendado)")}</option>
              <option value="jina">Jina</option>
              <option value="tavily">Tavily</option>
              <option value="brave">Brave</option>
              <option value="serper">Serper</option>
              <option value="exa">Exa</option>
            </select>
          </label>
          <label id="hub-web-key-wrap"><span id="hub-web-key-text"></span> <input id="hub-web-key" type="password" /></label>
          <p class="wiz-hint" id="hub-web-hint"></p>
        </fieldset>

        <fieldset>
          <legend>${t("Modelo local (avançado)")}</legend>
          <label>${t("Contexto (num_ctx)")} <input id="hub-num-ctx" type="number" min="2048" step="1024" /></label>
          <p class="wiz-hint">${t("Maior = o modelo lê mais (resultados de pesquisa + histórico). 8192 é um bom valor; usa mais RAM.")}</p>
          <label class="ws-check"><input type="checkbox" id="hub-temp-auto" /> ${t("Temperatura automática (recomendada do modelo)")}</label>
          <label id="hub-temp-wrap">${t("Temperatura")} <input id="hub-temp" type="number" min="0" max="1.5" step="0.1" /></label>
          <p class="wiz-hint">${t("Auto deixa cada modelo usar a amostragem afinada do seu Modelfile (melhor por modelo). Desliga para forçar um valor.")}</p>
          <label>${t("Clarificação (perguntar quando o pedido é vago)")}
            <select id="hub-clarify-level">
              <option value="off">${t("Desligado")}</option>
              <option value="light">${t("Leve")}</option>
              <option value="medium">${t("Médio")}</option>
              <option value="high">${t("Alto")}</option>
            </select>
          </label>
          <p class="wiz-hint">${t("Off: nunca. Leve e Médio clarificam só o pedido inicial vago (no Médio o modelo decide o que falta). Alto: também a meio da conversa. Aplica-se ao chat e ao Plan mode.")}</p>
          <p class="wiz-hint" id="hub-clarify-l2"></p>
        </fieldset>

        <fieldset>
          <legend>${t("Otimizar o Ollama (servidor)")}</legend>
          <p class="wiz-hint">${t("Acelera o Ollama e poupa VRAM (flash attention + cache KV menor — permite contexto maior na tua GPU). Define no servidor do Ollama e reinicia-o.")}</p>
          <div class="opt-actions">
            <div class="split-btn" id="opt-split" hidden>
              <button type="button" class="primary" id="opt-apply">${t("Otimizar")}</button>
              <button type="button" class="primary split-caret" id="opt-more" title="${t("Mais opções")}" aria-label="${t("Mais opções")}" aria-haspopup="true">${icon("chevron")}</button>
              <div class="split-menu" id="opt-menu" hidden>
                <button type="button" id="opt-copy">${t("Copiar comandos")}</button>
                <button type="button" id="opt-revert">${t("Reverter otimização")}</button>
              </div>
            </div>
            <button type="button" class="ghost" id="opt-copy-plain" hidden>${t("Copiar comandos")}</button>
          </div>
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

  <dialog id="topic-dialog">
    <div class="settings">
      <h2>${t("Tópico")}</h2>
      <label>${t("Nome")} <input id="topic-name" type="text" autocomplete="off" /></label>
      <label>${t("Brief (contexto partilhado)")} <textarea id="topic-brief" rows="4" placeholder="${t("Ex.: objetivo do projeto, stack, links, convenções…")}"></textarea></label>
      <label>${t("Notas fixadas")} <textarea id="topic-notes" rows="3"></textarea></label>
      <p class="wiz-hint">${t("O brief e as notas entram no contexto de todos os chats deste tópico.")}</p>

      <fieldset class="topic-project">
        <legend>${t("Projeto (pasta)")}</legend>
        <div class="topic-folder-row">
          <button type="button" class="ghost" id="topic-folder-pick">${icon("folder")}<span>${t("Escolher pasta…")}</span></button>
          <span class="topic-folder-path" id="topic-folder-path"></span>
          <button type="button" class="icon-x" id="topic-folder-clear" title="${t("Remover pasta")}" aria-label="${t("Remover pasta")}" hidden>${icon("x")}</button>
        </div>
        <label>${t("Acesso aos ficheiros")}
          <select id="topic-permission">
            <option value="read">${t("Leitura (o agente só lê a pasta — sem escrever nada)")}</option>
            <option value="ask">${t("Edição confirmada (o agente pode gravar, com aprovação)")}</option>
          </select>
        </label>
        <p class="wiz-hint">${t("Anexar uma pasta dá a árvore ao contexto. Em 'Leitura' o agente não escreve ficheiros de todo (mas continuas a poder guardar manualmente, ex. num artefacto). Em 'Edição confirmada': no modelo local (Ollama) e no Claude em modo API, cada gravação pede a tua confirmação; no Claude em modo CLI (subscrição), as escritas ficam pré-autorizadas para a sessão — sem confirmar ficheiro a ficheiro.")}</p>
      </fieldset>

      <menu>
        <button type="button" class="primary" id="topic-save">${t("Guardar")}</button>
        <button type="button" class="ghost" id="topic-cancel">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="distill-dialog">
    <div class="settings">
      <h2>${t("Capturar no Workspace")}</h2>
      <p class="distill-reason" id="distill-reason"></p>
      <label>${t("Tipo")}
        <select id="distill-type">
          <option value="skill">${t("Skill — conhecimento/técnica reutilizável")}</option>
          <option value="playbook">${t("Playbook — um how-to que repetes")}</option>
          <option value="workflow">${t("Workflow — tarefa multi-passo repetível")}</option>
        </select>
      </label>
      <label>${t("Nome")} <input id="distill-name" type="text" autocomplete="off" spellcheck="false" /></label>
      <label>${t("Descrição")} <input id="distill-desc" type="text" autocomplete="off" /></label>
      <label>${t("Conteúdo (markdown)")} <textarea id="distill-body" rows="12" spellcheck="false"></textarea></label>
      <p class="wiz-hint" id="distill-status"></p>
      <menu>
        <button type="button" class="primary" id="distill-save">${t("Guardar no Workspace")}</button>
        <button type="button" class="ghost" id="distill-redraft">${t("Voltar a gerar com este tipo")}</button>
        <button type="button" class="ghost" id="distill-discard">${t("Descartar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="project-files-dialog">
    <div class="settings">
      <h2 id="project-files-title">${t("Ficheiros do projeto")}</h2>
      <p class="wiz-hint" id="project-files-status"></p>
      <ul class="project-files-list" id="project-files-list"></ul>
      <menu>
        <button type="button" class="ghost" id="project-files-close">${t("Fechar")}</button>
      </menu>
    </div>
  </dialog>

  <dialog id="wizard-dialog">
    <div class="settings wizard">
      <div class="wiz-dots" id="wiz-dots"></div>

      <section class="wiz-step" data-step="0">
        <div class="wiz-hero">
          <img class="wiz-logo" src="/caravel-panel.svg" alt="Saga" />
          <h2>${t("Bem-vindo ao Saga")}</h2>
          <p class="wiz-intro">${t("Um assistente que corre no teu próprio computador. Sem contas, sem subscrição obrigatória — as tuas conversas ficam contigo.")}</p>
        </div>
        <ul class="wiz-points">
          <li>${icon("doc")}<div><strong>${t("Local primeiro")}</strong><span>${t("As respostas saem do modelo que corres em casa, via Ollama ou LM Studio.")}</span></div></li>
          <li>${icon("search")}<div><strong>${t("Pesquisa na web")}</strong><span>${t("Modelos com ferramentas conseguem procurar e ler páginas online.")}</span></div></li>
          <li>${icon("escalate")}<div><strong>${t("Claude opcional")}</strong><span>${t("Liga o Claude para escalar tarefas pesadas — só quando quiseres.")}</span></div></li>
        </ul>
      </section>

      <section class="wiz-step" data-step="1" hidden>
        <h2>${t("Escolhe o teu modelo local")}</h2>
        <div class="wiz-choice" id="wiz-backend">
          <button type="button" class="wiz-choice-opt active" data-backend="ollama">
            ${icon("download")}<div><strong>${t("Instalar Ollama")}</strong><span>${t("Recomendado — a Saga descarrega os modelos por ti.")}</span></div>
          </button>
          <button type="button" class="wiz-choice-opt" data-backend="lmstudio">
            ${icon("escalate")}<div><strong>${t("Já tenho o LM Studio")}</strong><span>${t("Liga ao servidor local do LM Studio.")}</span></div>
          </button>
        </div>
        <div id="wiz-ollama-panel">
          <div class="wiz-status" id="wiz-ollama-status">${t("A verificar…")}</div>
          <div id="wiz-rec" class="wiz-rec" hidden></div>
          <details class="wiz-manual">
            <summary>${t("Configuração manual")}</summary>
            <label>${t("Endpoint")} <input id="w_ollama_endpoint" type="text" /></label>
            <label>${t("Modelo ativo")} <input id="w_ollama_model" type="text" list="ollama-models" /></label>
            <p class="wiz-hint">${t("Sem Ollama? Instala em <strong>ollama.com</strong> e corre <code>ollama pull llama3.2</code>.")}</p>
          </details>
        </div>
        <div id="wiz-lm-panel" hidden>
          <label>${t("Endpoint")} <input id="w_oai_local_endpoint" type="text" placeholder="http://localhost:1234/v1" /></label>
          <label>${t("Modelo")} <input id="w_oai_local_model" type="text" placeholder="${t("ex.: ID no LM Studio")}" /></label>
          <div class="wiz-status" id="wiz-lm-status"></div>
          <div class="models-list" id="wiz-lm-installed"></div>
          <button type="button" class="ghost" id="wiz-lm-refresh">${t("Atualizar")}</button>
          <p class="wiz-hint">${t("Abre o LM Studio, carrega um modelo e liga o servidor local (porta 1234).")}</p>
        </div>
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
  topicDialog: document.querySelector<HTMLDialogElement>("#topic-dialog")!,
  distillDialog: document.querySelector<HTMLDialogElement>("#distill-dialog")!,
  projectFilesDialog: document.querySelector<HTMLDialogElement>("#project-files-dialog")!,
  projectFilesList: document.querySelector<HTMLUListElement>("#project-files-list")!,
  projectFilesStatus: document.querySelector<HTMLElement>("#project-files-status")!,
  projectFilesTitle: document.querySelector<HTMLElement>("#project-files-title")!,
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

// ---- Scroll do chat (não "puxar" quando o utilizador leu acima; botão "ir ao fundo") ----
/** O utilizador está perto do fundo? (tolerância p/ não arrastar enquanto lê mensagens acima). */
function isChatNearBottom(): boolean {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function updateScrollBtn() {
  document.querySelector("#scroll-bottom")?.toggleAttribute("hidden", isChatNearBottom());
}
function scrollChatToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  updateScrollBtn();
}

// ---- Procurar na conversa atual (Ctrl/⌘+F) ----
let findHits: HTMLElement[] = [];
let findIdx = -1;

function setFindCount() {
  const el = document.querySelector("#find-count");
  if (el) el.textContent = `${findHits.length ? findIdx + 1 : 0}/${findHits.length}`;
}

/** Desfaz os realces (substitui cada <mark> pelo seu texto) e repõe os nós. */
function clearFindHighlights() {
  els.messages.querySelectorAll<HTMLElement>("mark.find-hit").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent ?? ""));
  });
  els.messages.normalize();
  findHits = [];
  findIdx = -1;
}

/** Realça as ocorrências da query nos nós de texto das mensagens. */
function runFind(q: string) {
  clearFindHighlights();
  const needle = q.trim().toLowerCase();
  if (!needle) {
    setFindCount();
    return;
  }
  const walker = document.createTreeWalker(els.messages, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.closest("pre")) return NodeFilter.FILTER_REJECT; // evita blocos de código
      return (n.textContent ?? "").toLowerCase().includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);
  for (const textNode of targets) {
    const text = textNode.textContent ?? "";
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    let m: number;
    while ((m = lower.indexOf(needle, i)) !== -1) {
      if (m > i) frag.appendChild(document.createTextNode(text.slice(i, m)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(m, m + needle.length);
      frag.appendChild(mark);
      findHits.push(mark);
      i = m + needle.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  if (findHits.length) focusFindHit(0);
  else setFindCount();
}

function focusFindHit(i: number) {
  if (!findHits.length) return;
  findIdx = (i + findHits.length) % findHits.length;
  findHits.forEach((h, j) => h.classList.toggle("find-current", j === findIdx));
  findHits[findIdx].scrollIntoView({ block: "center", behavior: "smooth" });
  setFindCount();
}

function openFind() {
  const bar = document.querySelector<HTMLElement>("#find-bar");
  const input = document.querySelector<HTMLInputElement>("#find-input");
  if (!bar || !input) return;
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value.trim()) runFind(input.value);
}

function closeFind() {
  clearFindHighlights();
  const bar = document.querySelector<HTMLElement>("#find-bar");
  if (bar) bar.hidden = true;
}

function findOpen(): boolean {
  return !document.querySelector<HTMLElement>("#find-bar")?.hidden;
}

function wireFind() {
  const input = document.querySelector<HTMLInputElement>("#find-input");
  if (!input) return;
  let deb: number | undefined;
  input.addEventListener("input", () => {
    if (deb) clearTimeout(deb);
    deb = window.setTimeout(() => runFind(input.value), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? focusFindHit(findIdx - 1) : focusFindHit(findIdx + 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  });
  document.querySelector("#find-next")?.addEventListener("click", () => focusFindHit(findIdx + 1));
  document.querySelector("#find-prev")?.addEventListener("click", () => focusFindHit(findIdx - 1));
  document.querySelector("#find-close")?.addEventListener("click", closeFind);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      const chat = document.querySelector<HTMLElement>(".chat");
      if (chat && chat.offsetParent !== null) {
        e.preventDefault();
        openFind();
      }
    } else if (e.key === "Escape" && findOpen()) {
      closeFind();
    }
  });
}

// ---- Drag & drop de ficheiros (o webview entrega caminhos, não objetos File) ----
function chatVisible(): boolean {
  const chat = document.querySelector<HTMLElement>(".chat");
  return !!chat && chat.offsetParent !== null;
}

function setDropActive(on: boolean) {
  document.body.classList.toggle("drop-active", on && chatVisible());
}

/** Anexa ficheiros largados (por caminho) à composição atual. */
async function addDroppedFiles(paths: string[]) {
  let added = 0;
  for (const path of paths) {
    try {
      state.pendingAttachments.push(await api.attachmentFromPath(path));
      added++;
    } catch (e) {
      console.error("falha a anexar ficheiro largado", e);
      const nm = path.split(/[\\/]/).pop() || path;
      showHint(t("Não foi possível ler {name}.", { name: nm }));
    }
  }
  if (added) {
    renderPendingAttachments();
    warmLocalModel();
  }
}

async function wireDragDrop() {
  try {
    await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setDropActive(true);
      } else if (p.type === "leave") {
        setDropActive(false);
      } else if (p.type === "drop") {
        setDropActive(false);
        if (chatVisible() && p.paths?.length) void addDroppedFiles(p.paths);
      }
    });
  } catch (e) {
    console.error("drag & drop indisponível", e);
  }
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(n < 0.01 ? 5 : 4);
}

function fmtInt(n: number): string {
  return n.toLocaleString("pt-PT");
}

function renderMessages() {
  try {
    renderMessagesInner();
  } catch (e) {
    // Regista falhas de render (ex.: markdown/imagem) no log — senão passam despercebidas.
    void api
      .logFrontend("error", `renderMessages: ${(e as Error)?.stack ?? String(e)}`)
      .catch(() => {});
  }
}

function renderMessagesInner() {
  // Só "cola" ao fundo se o utilizador já lá estava (senão respeita onde ele leu).
  const stick = isChatNearBottom();
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
    updateScrollBtn();
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
        if (a.kind === "document") {
          const chip = document.createElement("span");
          chip.className = "doc-chip msg-doc clickable";
          chip.title = t("Abrir documento");
          chip.innerHTML = `<span class="doc-chip-ic">${icon("doc")}</span>`;
          const nm = document.createElement("span");
          nm.className = "doc-chip-name";
          nm.textContent = a.name || t("documento");
          chip.appendChild(nm);
          chip.addEventListener("click", () => openDocViewer(a));
          thumbs.appendChild(chip);
          continue;
        }
        const img = document.createElement("img");
        img.src = `data:${a.media_type};base64,${a.data_base64}`;
        img.addEventListener("click", () => openLightbox(img.src));
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

    // Resposta do assistente: separa o corpo da secção "## Fontes".
    const parsed =
      item.role === "assistant" && !item.error ? parseSources(item.content) : null;
    // Plano concluído (não a fazer stream agora) → resultado colapsável por passo.
    let planResultShown = false;

    // Plan mode: durante a execução, checklist ao vivo; concluído, resultado colapsável por passo.
    if (item.plan && item.plan.steps.length) {
      const liveStreaming = index === state.items.length - 1 && state.busy;
      let sections: string[] | null = null;
      if (item.role === "assistant" && item.content !== "" && !liveStreaming) {
        const secs = splitPlanSections(parsed ? parsed.body : item.content, item.plan.steps.length);
        if (secs.some((s) => s)) sections = secs;
      }
      if (sections) {
        row.appendChild(buildPlanResult(item, sections));
        planResultShown = true;
      } else {
        const box = document.createElement("div");
        box.className = "plan-steps";
        item.plan.steps.forEach((s, i) => {
          const line = document.createElement("div");
          line.className = `plan-step ${s.status}`;
          line.innerHTML = `<span class="ps-mark">${planStatusMark(s.status)}</span> ${i + 1}. ${escapeHtml(s.title)}`;
          box.appendChild(line);
        });
        row.appendChild(box);
      }
    }

    if (item.thinking) {
      const live = index === state.items.length - 1 && state.busy;
      const det = document.createElement("details");
      det.className = "thinking-block";
      det.open = live;
      const sum = document.createElement("summary");
      sum.innerHTML = `${icon("brain")}<span>${escapeHtml(live ? t("a raciocinar…") : t("raciocínio"))}</span>`;
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = item.thinking;
      det.appendChild(sum);
      det.appendChild(body);
      row.appendChild(det);
    }

    if ((item.content !== "" || item.role === "assistant") && !planResultShown) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const liveEmpty =
        item.role === "assistant" &&
        !item.error &&
        item.content === "" &&
        index === state.items.length - 1 &&
        state.busy;
      if (liveEmpty) {
        // Bolha de espera persistente (cobre o arranque do modelo e o raciocínio inicial).
        // Mensagem por fases + reticências animadas + contador de tempo decorrido = feedback vivo.
        bubble.innerHTML = `<span class="waiting-row">${caravelLoader(30)}<span class="status-text"></span><span class="wait-dots"><i></i><i></i><i></i></span><span class="wait-elapsed"></span></span>`;
        const ms = waitStart ? Date.now() - waitStart : 0;
        bubble.querySelector(".status-text")!.textContent = waitMessage(waitKind, ms);
        if (ms >= 2500) bubble.querySelector(".wait-elapsed")!.textContent = fmtElapsed(ms);
      } else if (item.role === "assistant" && !item.error) {
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
      ];
      // Camada "reasoning": nível de clarificação ativo + intenção classificada do pedido.
      const lvl = state.settings?.clarify_level;
      const lvlLabel =
        lvl === "light" ? t("Leve") : lvl === "medium" ? t("Médio") : lvl === "high" ? t("Alto") : null;
      const showIntent = !!m.intent && m.intent !== "general";
      // Nível Think usado neste turno (+ confiança das amostras no modo verify).
      const tl = m.thinkLevel;
      const thinkLabel = tl && tl !== "off" ? `${t("Think")}: ${tl}` : null;
      if (lvlLabel || showIntent || thinkLabel) {
        const parts: string[] = [];
        if (lvlLabel) parts.push(`${t("raciocínio")}: ${lvlLabel}`);
        if (showIntent) parts.push(t("compras"));
        if (thinkLabel) {
          parts.push(
            m.confidence != null
              ? `${thinkLabel} · ${t("confiança")} ${Math.round(m.confidence * 100)}%`
              : thinkLabel
          );
        }
        bits.push(`<span>${parts.join(" · ")}</span>`);
      }
      bits.push(
        `<span>${fmtInt(m.input_tokens)}↓ / ${fmtInt(m.output_tokens)}↑ tok</span>`
      );
      if (m.gen_ms && m.gen_ms > 0) bits.push(`<span>${fmtDuration(m.gen_ms)}</span>`);
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
      row.appendChild(buildActions(item, index));
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
  if (stick) els.messages.scrollTop = els.messages.scrollHeight;
  updateScrollBtn();
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
      return `${t("a pesquisar")}: ${detail}`;
    case "web_fetch":
      return `${t("a abrir")}: ${detail}`;
    case "create_pdf":
      return t("a criar PDF");
    case "skill":
      return `${t("Skill aplicada")}: ${detail}`;
    case "plan":
      return t("a planear…");
    case "research":
      // Fases da pesquisa fundamentada (deep_research): chaves estáveis → traduzidas aqui.
      return detail === "decompose"
        ? t("a decompor a pergunta…")
        : detail === "verify"
          ? t("a verificar os factos…")
          : detail === "synthesize"
            ? t("a escrever a resposta…")
            : detail;
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

/** Divide o corpo de um resultado de Plan mode pelas secções «## N. …» que o planner emite.
 * Mapeia cada cabeçalho ao passo pelo NÚMERO capturado (robusto a cabeçalhos extra/faltas). */
function splitPlanSections(body: string, n: number): string[] {
  const sections = new Array<string>(n).fill("");
  const re = /^##\s*(\d+)\.\s+.*$/gm;
  const heads: { num: number; matchStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    heads.push({ num: parseInt(m[1], 10), matchStart: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.num < 1 || h.num > n) continue;
    const end = i + 1 < heads.length ? heads[i + 1].matchStart : body.length;
    sections[h.num - 1] = body.slice(h.contentStart, end).trim();
  }
  return sections;
}

/** Resultado do Plan mode (concluído): a checklist vira índice — clicar num passo abre/fecha o seu
 * conteúdo. 1.º passo aberto por omissão. Pressupõe `item.plan` e `sections` (uma por passo). */
/** Marca de estado de um passo (HTML, monocromática). «A pesquisar» usa o ícone SVG, não emoji. */
function planStatusMark(status: string): string {
  switch (status) {
    case "done":
      return icon("check");
    case "searching":
      return icon("search");
    case "executing":
      return icon("play");
    case "error":
      return icon("x");
    default:
      return icon("circle");
  }
}

function buildPlanResult(item: Item, sections: string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "plan-steps plan-result";
  item.plan!.steps.forEach((s, i) => {
    const mark = planStatusMark(s.status);
    const content = sections[i] ?? "";
    const head = document.createElement("button");
    head.type = "button";
    head.className = `plan-step plan-step-head ${s.status}`;
    const open = i === 0 && !!content; // 1.º passo aberto
    head.innerHTML =
      `<span class="ps-mark">${mark}</span>` +
      `<span class="ps-title">${i + 1}. ${escapeHtml(s.title)}</span>` +
      (content ? `<span class="ps-caret">${open ? "▾" : "▸"}</span>` : "");
    box.appendChild(head);
    if (!content) {
      head.disabled = true;
      return;
    }
    const bodyEl = document.createElement("div");
    bodyEl.className = "plan-step-body markdown";
    bodyEl.hidden = !open;
    bodyEl.innerHTML = renderMarkdown(content);
    if (open) highlightWithin(bodyEl);
    let highlighted = open;
    head.addEventListener("click", () => {
      const show = bodyEl.hidden;
      bodyEl.hidden = !show;
      head.querySelector(".ps-caret")!.textContent = show ? "▾" : "▸";
      if (show && !highlighted) {
        highlightWithin(bodyEl);
        highlighted = true;
      }
    });
    box.appendChild(bodyEl);
  });
  return box;
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

/** Deteção barata e determinística (mesmo espírito do clarify::specificity no backend, nunca um
 * julgamento do modelo): a mensagem do utilizador pede claramente para criar/editar um ficheiro, mas
 * nenhum step deste turno gravou nada. Falha para o lado seguro — na dúvida, não sinaliza nada. */
function looksLikeUnfulfilledFileRequest(userText: string, steps: string[] | undefined): boolean {
  if (!userText.trim()) return false;
  const wroteFile = (steps || []).some(
    (s) => s.startsWith("project_create") || s.startsWith("project_edit") || s.startsWith("project_save_file")
  );
  if (wroteFile) return false;
  const lower = userText.toLowerCase();
  const verb =
    /\b(cria|criar|edita|editar|grava|gravar|guarda|guardar|atualiza|atualizar|create|save|write|update)\b/;
  const noun = /\b(ficheiro|arquivo|pasta|projeto|file)\b/;
  const ext = /\.[a-z]{1,5}\b/;
  return verb.test(lower) && (noun.test(lower) || ext.test(lower));
}

function buildActions(item: Item, index: number): HTMLDivElement {
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
  }

  // A/B: regenerar o MESMO prompt noutro modelo (local instalado ou Claude). Mostra-se se houver
  // modelos locais para escolher ou se o cloud estiver ligado.
  if (localModelsCache.length || cloudEnabled()) {
    const sel = document.createElement("select");
    sel.className = "model-pick";
    let opts = `<option value="">${t("Modelo")}</option>`;
    if (localModelsCache.length) {
      opts +=
        `<optgroup label="${t("Local")}">` +
        localModelsCache
          .map((m) => `<option value="local:${escapeHtml(m)}">${escapeHtml(m)}</option>`)
          .join("") +
        `</optgroup>`;
    }
    if (cloudEnabled()) {
      opts +=
        `<optgroup label="Claude">` +
        `<option value="local">${t("Tentar local")}</option>` +
        `<option value="claude-haiku-4-5-20251001">Haiku 4.5</option>` +
        `<option value="claude-sonnet-4-6">Sonnet 4.6</option>` +
        `<option value="claude-opus-4-8">Opus 4.8</option>` +
        `</optgroup>`;
    }
    sel.innerHTML = opts;
    sel.addEventListener("change", () => {
      const v = sel.value;
      sel.value = "";
      if (!v) return;
      if (v === "local") regenerate({ routeOverride: "local" });
      else if (v.startsWith("local:")) regenerate({ routeOverride: "local", modelOverride: v.slice(6) });
      else regenerate({ routeOverride: "claude", modelOverride: v });
    });
    actions.appendChild(sel);
  }

  // Sugestão de escalar: pediste um ficheiro na rota local e nada foi gravado neste turno.
  if (item.meta?.route === "local" && cloudEnabled()) {
    const conv = state.conversations.find((c) => c.id === state.currentConversationId);
    const tp = conv?.topic_id != null ? state.topics.find((t) => t.id === conv.topic_id) : null;
    const prevUser = [...state.items].slice(0, index).reverse().find((m) => m.role === "user");
    if (tp?.folder_path.trim() && prevUser && looksLikeUnfulfilledFileRequest(prevUser.content, item.steps)) {
      const hint = document.createElement("div");
      hint.className = "escalate-hint";
      hint.innerHTML = `<span>${escapeHtml(t("Pedido de ficheiro sem gravação"))}</span>`;
      const btn = mk("escalate", t("Tentar pela rota Claude"), t("Escalar esta resposta para o Claude"), () =>
        regenerate({ routeOverride: "claude" })
      );
      hint.appendChild(btn);
      actions.appendChild(hint);
    }
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
  void renderSearchUsage();
}

/** Quotas gratuitas MENSAIS conhecidas (nº de pesquisas) para mostrar "usadas / limite". */
const SEARCH_MONTHLY_LIMIT: Record<string, number> = { tavily: 1000, brave: 2000, exa: 1000 };

/** Medidor de pesquisas web do mês (contagem local; a quota real está no painel do motor). */
async function renderSearchUsage() {
  const box = document.querySelector<HTMLElement>("#search-usage");
  if (!box) return;
  let usage: import("./api").SearchUsage[] = [];
  try {
    usage = await api.getSearchUsage();
  } catch {
    return;
  }
  if (!usage.length) {
    box.innerHTML = `<div class="su-empty">${t("Ainda sem pesquisas este mês.")}</div>`;
    return;
  }
  const rows = usage
    .map((u) => {
      const label = u.provider === "duckduckgo" ? "DuckDuckGo" : (WEB_PROVIDER_META[u.provider]?.label ?? u.provider);
      const limit = SEARCH_MONTHLY_LIMIT[u.provider];
      if (limit) {
        const pct = Math.min(100, Math.round((u.count / limit) * 100));
        return `<div class="su-row"><span class="su-name">${escapeHtml(label)}</span>
          <span class="su-count">${fmtInt(u.count)} / ${fmtInt(limit)}</span>
          <span class="su-bar"><span style="width:${pct}%"></span></span></div>`;
      }
      const note = u.provider === "duckduckgo" ? t("sem limite fixo") : t("ver quota no motor");
      return `<div class="su-row"><span class="su-name">${escapeHtml(label)}</span>
        <span class="su-count">${fmtInt(u.count)}</span>
        <span class="su-note">${note}</span></div>`;
    })
    .join("");
  box.innerHTML = rows + `<div class="su-foot">${t("Contagem local (o que a Saga gastou); a quota real está no painel do motor.")}</div>`;
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
function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** É um ficheiro de imagem? (tipo MIME ou extensão conhecida) */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Aceitamos este ficheiro? Imagens ou um dos tipos de documento conhecidos. */
function isAcceptedFile(file: File): boolean {
  return isImageFile(file) || DOC_EXTS.includes(fileExt(file.name));
}

/** Lê os bytes do ficheiro como base64 (sem o cabeçalho data:). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result); // data:<media>;base64,<data>
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Converte um ficheiro em anexo: imagem (base64 p/ visão) ou documento (texto extraído). */
async function fileToAttachment(file: File): Promise<Attachment> {
  const base64 = await fileToBase64(file);
  if (isImageFile(file)) {
    return { kind: "image", media_type: file.type || "image/png", data_base64: base64 };
  }
  // Documento: o backend extrai o texto (vai para o modelo). Guardamos também os bytes
  // crus (base64) para um visor rico — ex.: ver o PDF original em vez do texto extraído.
  const text = await api.extractFileText(file.name, base64);
  const ext = fileExt(file.name);
  const media = file.type || (ext === "pdf" ? "application/pdf" : "application/octet-stream");
  return {
    kind: "document",
    media_type: media,
    data_base64: base64,
    name: file.name,
    text,
  };
}

/** Constrói um "chip" de documento (ícone + nome + remover) para as barras de anexos. */
function docChipEl(a: Attachment, onRemove: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "doc-chip clickable";
  wrap.title = t("Abrir documento");
  wrap.addEventListener("click", () => openDocViewer(a));
  const ic = document.createElement("span");
  ic.className = "doc-chip-ic";
  ic.innerHTML = icon("doc");
  const label = document.createElement("span");
  label.className = "doc-chip-name";
  label.textContent = a.name || t("documento");
  const rm = document.createElement("button");
  rm.className = "thumb-x";
  rm.innerHTML = icon("x");
  rm.title = t("Remover");
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  wrap.append(ic, label, rm);
  return wrap;
}

/** Decodifica base64 para bytes (para alimentar as bibliotecas de render). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Tipo de render rico disponível para o anexo (precisa dos bytes guardados). */
function richDocKind(a: Attachment): "pdf" | "docx" | "xlsx" | "" {
  if (!a.data_base64) return "";
  const ext = (a.name || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf" || a.media_type === "application/pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) return "xlsx";
  return "";
}

/** Render do .docx fiel ao layout (docx-preview, carregado a pedido). O `host` força
 *  um baseline de texto escuro para o conteúdo do Word não herdar a cor clara do tema. */
async function renderDocx(a: Attachment, host: HTMLElement) {
  host.classList.add("docx-host");
  const { renderAsync } = await import("docx-preview");
  const wrap = document.createElement("div");
  wrap.className = "docx-render";
  host.appendChild(wrap);
  await renderAsync(base64ToBytes(a.data_base64), wrap, undefined, {
    className: "docx",
    inWrapper: true,
    ignoreLastRenderedPageBreak: true,
  });
}

/** CSS limpo para o iframe da folha de cálculo (isolado do tema da app). */
const XLSX_FRAME_CSS =
  "body{margin:0;padding:10px;font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff}" +
  "table{border-collapse:collapse}" +
  "td,th{border:1px solid #d4d4d4;padding:3px 8px;white-space:nowrap}" +
  "tr:first-child td{background:#f2f2f2;font-weight:600}";

/** Render da folha de cálculo num iframe isolado (uma tabela por separador, SheetJS). */
async function renderXlsx(a: Attachment, host: HTMLElement) {
  host.classList.add("xlsx-host");
  const XLSX = await import("xlsx");
  const wb = XLSX.read(base64ToBytes(a.data_base64), { type: "array" });
  const frame = document.createElement("iframe");
  frame.className = "doc-viewer-frame";
  const showSheet = (sheet: string) => {
    frame.srcdoc =
      `<!doctype html><meta charset="utf-8"><style>${XLSX_FRAME_CSS}</style>` +
      XLSX.utils.sheet_to_html(wb.Sheets[sheet]);
  };
  if (wb.SheetNames.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "xlsx-tabs";
    wb.SheetNames.forEach((sheet, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = sheet;
      if (i === 0) b.classList.add("active");
      b.addEventListener("click", () => {
        tabs.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        showSheet(sheet);
      });
      tabs.appendChild(b);
    });
    host.appendChild(tabs);
  }
  host.appendChild(frame);
  showSheet(wb.SheetNames[0]);
}

/** Abre um documento num overlay com render rico (PDF nativo, Word via docx-preview,
 *  Excel via SheetJS) e um botão para alternar com o texto extraído (o que o modelo leu). */
function openDocViewer(a: Attachment) {
  document.querySelector("#doc-viewer")?.remove();
  const name = a.name || t("documento");
  const text = (a.text || "").trim();
  const rich = richDocKind(a);

  const overlay = document.createElement("div");
  overlay.id = "doc-viewer";
  overlay.className = "lightbox doc-viewer";
  const panel = document.createElement("div");
  panel.className = "doc-viewer-panel";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "doc-viewer-head";
  const title = document.createElement("span");
  title.className = "doc-viewer-title";
  title.textContent = name;
  const toggle = document.createElement("button");
  toggle.className = "ghost doc-viewer-toggle";
  const close = document.createElement("button");
  close.className = "icon-x";
  close.innerHTML = icon("x");
  close.title = t("Fechar");
  head.append(title, toggle, close);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "doc-viewer-body-wrap";
  panel.append(head, bodyWrap);
  overlay.appendChild(panel);

  let blobUrl = "";
  // "rich" = ver o documento; "text" = ver o texto extraído.
  let mode: "rich" | "text" = rich ? "rich" : "text";

  const showText = () => {
    const pre = document.createElement("pre");
    pre.className = "doc-viewer-body";
    pre.textContent = text || t("(sem texto extraído)");
    bodyWrap.appendChild(pre);
  };

  const render = async () => {
    bodyWrap.innerHTML = "";
    if (mode === "text" || !rich) {
      showText();
    } else if (rich === "pdf") {
      if (!blobUrl)
        blobUrl = URL.createObjectURL(
          new Blob([base64ToBytes(a.data_base64) as BlobPart], { type: "application/pdf" })
        );
      const frame = document.createElement("iframe");
      frame.className = "doc-viewer-pdf";
      frame.src = blobUrl;
      bodyWrap.appendChild(frame);
    } else {
      // docx / xlsx: render assíncrono com estado de carregamento + fallback para texto.
      const loading = document.createElement("div");
      loading.className = "doc-viewer-loading";
      loading.textContent = t("A carregar…");
      bodyWrap.appendChild(loading);
      const surface = document.createElement("div");
      surface.className = "doc-viewer-rich";
      try {
        if (rich === "docx") await renderDocx(a, surface);
        else await renderXlsx(a, surface);
        bodyWrap.innerHTML = "";
        bodyWrap.appendChild(surface);
      } catch (e) {
        console.error("falha a renderizar documento", e);
        bodyWrap.innerHTML = "";
        showText();
      }
    }
    // Alterna documento ↔ texto, quando há ambos.
    if (rich && text) {
      toggle.hidden = false;
      toggle.textContent = mode === "rich" ? t("Texto extraído") : t("Ver documento");
    } else {
      toggle.hidden = true;
    }
  };
  toggle.addEventListener("click", () => {
    mode = mode === "rich" ? "text" : "rich";
    void render();
  });
  void render();

  const dismiss = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  overlay.addEventListener("click", dismiss);
  close.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

function renderPendingAttachments() {
  els.attachmentsBar.innerHTML = "";
  state.pendingAttachments.forEach((a, idx) => {
    const remove = () => {
      state.pendingAttachments.splice(idx, 1);
      renderPendingAttachments();
    };
    if (a.kind === "document") {
      els.attachmentsBar.appendChild(docChipEl(a, remove));
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = `data:${a.media_type};base64,${a.data_base64}`;
    img.addEventListener("click", () => openLightbox(img.src));
    const rm = document.createElement("button");
    rm.className = "thumb-x";
    rm.innerHTML = icon("x");
    rm.title = t("Remover");
    rm.addEventListener("click", remove);
    wrap.appendChild(img);
    wrap.appendChild(rm);
    els.attachmentsBar.appendChild(wrap);
  });
}

/** Abre uma imagem em grande num overlay (clica fora / Esc para fechar). */
function openLightbox(src: string) {
  document.querySelector("#lightbox")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "lightbox";
  overlay.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  overlay.appendChild(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

async function onFilesSelected() {
  const files = els.fileInput.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!isAcceptedFile(file)) {
      showHint(t("Tipo de ficheiro não suportado: {name}", { name: file.name }));
      continue;
    }
    try {
      state.pendingAttachments.push(await fileToAttachment(file));
    } catch (e) {
      console.error("falha a ler ficheiro", e);
      showHint(t("Não foi possível ler {name}.", { name: file.name }));
    }
  }
  els.fileInput.value = "";
  renderPendingAttachments();
  warmLocalModel(); // documento grande → adianta o carregamento enquanto compõe
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

// ---- Conversas + Tópicos ----

/** Conjunto de grupos colapsados (persistido). Chave = "t<id>" ou "none". */
function collapsedTopics(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("saga.collapsedTopics") || "[]") as string[]);
  } catch {
    return new Set();
  }
}
function toggleCollapsed(key: string) {
  const s = collapsedTopics();
  if (s.has(key)) s.delete(key);
  else s.add(key);
  localStorage.setItem("saga.collapsedTopics", JSON.stringify([...s]));
}

/** Tópicos com as ações (editar/renomear/apagar) reveladas — a seta ">" na linha do tópico
 * troca o nome por estes botões em vez de os empilhar ao lado (não há espaço para os dois). */
const expandedTopicActions = new Set<number>();

/** Linha de uma conversa: título + mover + renomear + apagar. Arrastável para um grupo de tópico. */
function convRow(c: ConversationMeta): HTMLElement {
  const row = document.createElement("div");
  row.className = "conv" + (c.id === state.currentConversationId ? " active" : "");
  // Clicar em qualquer ponto da linha abre a Saga (ignora os botões de ação e o campo de renomear).
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".conv-act, .conv-rename")) return;
    selectConversation(c.id);
  });
  // Arrastar para um tópico. Pointer-based (não HTML5 DnD): o Tauri intercepta o
  // drag-drop nativo do webview para o drop de ficheiros, o que bloqueava o DnD da página.
  row.addEventListener("pointerdown", (e) => beginConvDrag(e, c.id));

  const title = document.createElement("span");
  title.className = "conv-title";
  title.textContent = c.title || t("Nova conversa");
  title.title = c.title;
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startRename(c, row, title);
  });

  const move = document.createElement("button");
  move.className = "conv-act";
  move.innerHTML = icon("folder");
  move.title = t("Mover para tópico");
  move.addEventListener("click", (e) => {
    e.stopPropagation();
    openTopicMenu(move, c);
  });

  const ren = document.createElement("button");
  ren.className = "conv-act";
  ren.innerHTML = icon("pencil");
  ren.title = t("Renomear");
  ren.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(c, row, title);
  });

  const del = document.createElement("button");
  del.className = "conv-act conv-del";
  del.innerHTML = icon("x");
  del.title = t("Apagar");
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    removeConversation(c.id);
  });

  row.append(title, move, ren, del);
  return row;
}

function renderSidebar() {
  els.convList.innerHTML = "";

  // Sem tópicos ainda → lista plana (UX inalterada até o utilizador criar o primeiro tópico).
  if (state.topics.length === 0) {
    for (const c of state.conversations) els.convList.appendChild(convRow(c));
    return;
  }

  const collapsed = collapsedTopics();
  const byTopic = new Map<number | null, ConversationMeta[]>();
  for (const c of state.conversations) {
    const k = c.topic_id ?? null;
    const arr = byTopic.get(k);
    if (arr) arr.push(c);
    else byTopic.set(k, [c]);
  }

  const renderGroup = (key: string, label: string, convs: ConversationMeta[], topic: Topic | null) => {
    const isCollapsed = collapsed.has(key);
    const group = document.createElement("div");
    group.className = "topic-group";
    // Alvo do arrasto pointer-based (ver beginConvDrag). null = sem tópico.
    group.dataset.topicId = topic ? String(topic.id) : "none";

    const head = document.createElement("div");
    head.className = "topic-head" + (topic && topic.id === state.activeTopicId ? " active" : "");
    if (topic) head.dataset.topicId = String(topic.id);
    head.addEventListener("click", () => {
      toggleCollapsed(key);
      renderSidebar();
    });

    const caret = document.createElement("span");
    caret.className = "topic-caret" + (isCollapsed ? " collapsed" : "");
    caret.innerHTML = icon("chevron");

    const actionsExpanded = !!topic && expandedTopicActions.has(topic.id);
    const name = document.createElement("span");
    name.className = "topic-name";
    name.textContent = label;
    name.hidden = actionsExpanded; // dá o espaço aos botões de ação enquanto estão revelados
    if (topic) {
      name.title = label;
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startTopicRename(topic, head, name);
      });
    }

    const count = document.createElement("span");
    count.className = "topic-count";
    count.textContent = String(convs.length);

    head.append(caret, name);
    // Badge de projeto: o tópico tem uma pasta anexada (file tools). Clicável — abre um mini
    // menu com "Abrir pasta" / "Ver ficheiros" (um só ícone para as duas ações — a linha do
    // tópico já não tinha espaço para mais um ícone fixo).
    if (topic && topic.folder_path) {
      const proj = document.createElement("button");
      proj.className = "topic-proj";
      proj.innerHTML = icon("folder");
      proj.title = t("Projeto: {p}", { p: topic.folder_path });
      proj.addEventListener("click", (e) => {
        e.stopPropagation();
        openProjectMenu(proj, topic);
      });
      head.append(proj);
    }
    // Pílula passiva de destilação: o classificador detetou um padrão por capturar.
    const hint = topic ? parseHint(topic) : null;
    if (topic && hint) {
      const pill = document.createElement("button");
      pill.className = "topic-hint";
      pill.innerHTML = icon("sparkles");
      pill.title = t("Padrão detetado — clica para capturar") + (hint.reason ? `: ${hint.reason}` : "");
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        void openDistillFor(topic.id, hint.type);
      });
      head.append(pill);
    }
    head.append(count);

    if (topic) {
      // "+" cria uma Saga neste tópico; pencil/x renomeiam/apagam o tópico (não os chats).
      const add = document.createElement("button");
      add.className = "topic-act";
      add.innerHTML = icon("plus");
      add.title = t("Nova Saga neste tópico");
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        void createConversation(topic.id);
      });

      const distill = document.createElement("button");
      distill.className = "topic-act";
      distill.innerHTML = icon("brain");
      distill.title = t("Destilar tópico (capturar um padrão no Workspace)");
      distill.addEventListener("click", (e) => {
        e.stopPropagation();
        void openDistillFor(topic.id);
      });

      const edit = document.createElement("button");
      edit.className = "topic-act";
      edit.innerHTML = icon("doc");
      edit.title = t("Editar tópico (brief/notas)");
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        openTopicEditor(topic);
      });

      const ren = document.createElement("button");
      ren.className = "topic-act";
      ren.innerHTML = icon("pencil");
      ren.title = t("Renomear tópico");
      ren.addEventListener("click", (e) => {
        e.stopPropagation();
        startTopicRename(topic, head, name);
      });

      const del = document.createElement("button");
      del.className = "topic-act topic-del";
      del.innerHTML = icon("x");
      del.title = t("Apagar tópico (mantém as conversas)");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void deleteTopicUi(topic.id);
      });

      // Seta ">" revela os botões de ação no lugar do nome; "<" volta a mostrar o nome.
      const toggle = document.createElement("button");
      toggle.className = "topic-act topic-expand" + (actionsExpanded ? " expanded" : "");
      toggle.innerHTML = icon("chevron");
      toggle.title = actionsExpanded ? t("Menos") : t("Mais ações");
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (actionsExpanded) expandedTopicActions.delete(topic.id);
        else expandedTopicActions.add(topic.id);
        renderSidebar();
      });

      if (actionsExpanded) head.append(add, distill, edit, ren, del, toggle);
      else head.append(toggle);
    }

    group.appendChild(head);
    if (!isCollapsed) for (const c of convs) group.appendChild(convRow(c));
    els.convList.appendChild(group);
  };

  for (const tp of state.topics) {
    renderGroup("t" + tp.id, tp.name || t("Tópico"), byTopic.get(tp.id) ?? [], tp);
  }
  // "(sem tópico)" mostra-se sempre que há tópicos — serve de alvo para tirar um chat de um tópico.
  renderGroup("none", t("(sem tópico)"), byTopic.get(null) ?? [], null);
}

/** Nome único para um tópico novo ("Novo tópico", "Novo tópico 2", …) — nomes são únicos no backend. */
function uniqueTopicName(base: string): string {
  const names = new Set(state.topics.map((tp) => tp.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n.toLowerCase())) return n;
  }
}

/** Renomear o tópico in-place no cabeçalho (espelha startRename das conversas). */
function startTopicRename(tp: Topic, head: HTMLElement, nameEl: HTMLElement) {
  const input = document.createElement("input");
  input.className = "conv-rename";
  input.value = tp.name;
  head.replaceChild(input, nameEl);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v.toLowerCase() !== tp.name.toLowerCase()) {
      try {
        await api.renameTopic(tp.id, v);
      } catch (e) {
        console.error(e); // ex.: nome já existe (índice único) — mantém o antigo
      }
    }
    await loadConversations();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void commit(true);
    } else if (e.key === "Escape") {
      void commit(false);
    }
  });
  input.addEventListener("blur", () => void commit(true));
}

async function deleteTopicUi(id: number) {
  try {
    await api.deleteTopic(id);
  } catch (e) {
    console.error(e);
  }
  if (state.activeTopicId === id) setActiveTopic(null);
  await loadConversations();
}

// Editor do tópico (nome + brief + notas + pasta do projeto). O brief/notas entram no contexto;
// a pasta dá file tools (ler/editar) aos chats do tópico.
let editingTopicId: number | null = null;
let editingFolder = "";
function renderTopicFolder() {
  (document.querySelector("#topic-folder-path") as HTMLElement).textContent = editingFolder;
  document.querySelector("#topic-folder-clear")!.toggleAttribute("hidden", !editingFolder);
}
function openTopicEditor(tp: Topic) {
  editingTopicId = tp.id;
  editingFolder = tp.folder_path;
  (document.querySelector("#topic-name") as HTMLInputElement).value = tp.name;
  (document.querySelector("#topic-brief") as HTMLTextAreaElement).value = tp.brief;
  (document.querySelector("#topic-notes") as HTMLTextAreaElement).value = tp.notes;
  (document.querySelector("#topic-permission") as HTMLSelectElement).value =
    tp.permission_mode || "read";
  renderTopicFolder();
  els.topicDialog.showModal();
}
async function pickTopicFolder() {
  try {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      editingFolder = picked;
      renderTopicFolder();
    }
  } catch (e) {
    console.error(e);
  }
}
async function saveTopicEditor() {
  if (editingTopicId == null) return;
  const id = editingTopicId;
  const name = (document.querySelector("#topic-name") as HTMLInputElement).value.trim();
  const brief = (document.querySelector("#topic-brief") as HTMLTextAreaElement).value;
  const notes = (document.querySelector("#topic-notes") as HTMLTextAreaElement).value;
  const permission = (document.querySelector("#topic-permission") as HTMLSelectElement).value;
  const cur = state.topics.find((tp) => tp.id === id);
  try {
    if (name && cur && name.toLowerCase() !== cur.name.toLowerCase()) {
      await api.renameTopic(id, name);
    }
    await api.updateTopic(id, brief, notes, editingFolder, permission);
  } catch (e) {
    console.error(e); // ex.: nome duplicado (índice único)
  }
  els.topicDialog.close();
  editingTopicId = null;
  await loadConversations();
}

// ---- Self-distilling: propor um doc do Workspace a partir dos padrões de um tópico ----

let distillTopicId: number | null = null;
let distillFields: DocFields | null = null; // campos preservados do draft (triggers/route/etc.)

/** Lê a dica de destilação pendente de um tópico (JSON do classificador passivo). */
function parseHint(tp: Topic): { type: string; name: string; reason: string } | null {
  const raw = (tp.distill_hint || "").trim();
  if (!raw) return null;
  try {
    const h = JSON.parse(raw);
    return { type: h.type || "playbook", name: h.name || "", reason: h.reason || "" };
  } catch {
    return null;
  }
}

/** Corre a destilação (draft) de um tópico e abre a proposta. `typeHint` força o tipo. */
async function openDistillFor(topicId: number, typeHint?: string) {
  showHint(t("A destilar…"));
  let p: DistillProposal;
  try {
    p = await api.distillTopic(topicId, true, typeHint, false);
  } catch (e) {
    alert(t("Falha a destilar: ") + e);
    return;
  }
  if (!p.found) {
    // Sem padrão → não abre nada; limpa a dica para não insistir.
    await api.dismissDistillHint(topicId).catch(() => {});
    await loadConversations();
    alert(t("Sem padrão claro para capturar neste tópico."));
    return;
  }
  const kind = (["skill", "playbook", "workflow"].includes(p.doc_type) ? p.doc_type : "playbook") as WsKind;
  const fields = parseDocFields(kind, p.body);
  // Nome/descrição do draft, com fallback ao palpite do classificador.
  fields.name = (fields.name || p.name || "").trim();
  if (!fields.desc) fields.desc = p.description || "";
  fillDistillDialog(topicId, kind, fields, p.reason);
}

function fillDistillDialog(topicId: number, kind: WsKind, fields: DocFields, reason: string) {
  distillTopicId = topicId;
  distillFields = fields;
  (document.querySelector("#distill-type") as HTMLSelectElement).value = kind;
  (document.querySelector("#distill-name") as HTMLInputElement).value = fields.name || "";
  (document.querySelector("#distill-desc") as HTMLInputElement).value = fields.desc || "";
  (document.querySelector("#distill-body") as HTMLTextAreaElement).value = fields.body || "";
  (document.querySelector("#distill-reason") as HTMLElement).textContent = reason || "";
  (document.querySelector("#distill-status") as HTMLElement).textContent = "";
  if (!els.distillDialog.open) els.distillDialog.showModal();
}

/** Volta a gerar o draft com o tipo atualmente selecionado. */
async function redraftDistill() {
  if (distillTopicId == null) return;
  const kind = (document.querySelector("#distill-type") as HTMLSelectElement).value;
  const status = document.querySelector("#distill-status") as HTMLElement;
  status.textContent = t("A destilar…");
  try {
    const p = await api.distillTopic(distillTopicId, true, kind, false);
    if (!p.found) {
      status.textContent = t("Sem padrão claro para capturar neste tópico.");
      return;
    }
    const k = (p.doc_type || kind) as WsKind;
    const fields = parseDocFields(k, p.body);
    fields.name = (fields.name || p.name || "").trim();
    if (!fields.desc) fields.desc = p.description || "";
    fillDistillDialog(distillTopicId, k, fields, p.reason);
  } catch (e) {
    status.textContent = "" + e;
  }
}

/** Guarda a proposta como doc do Workspace, com âmbito do tópico. */
async function saveDistill() {
  if (distillTopicId == null || !distillFields) return;
  const kind = (document.querySelector("#distill-type") as HTMLSelectElement).value as WsKind;
  const name = (document.querySelector("#distill-name") as HTMLInputElement).value.trim();
  const desc = (document.querySelector("#distill-desc") as HTMLInputElement).value.trim();
  const body = (document.querySelector("#distill-body") as HTMLTextAreaElement).value;
  if (!name) {
    alert(t("Indica um nome (sem espaços)."));
    return;
  }
  const topicName = state.topics.find((tp) => tp.id === distillTopicId)?.name || "";
  // Dedupe: avisa se já existe um doc do mesmo tipo e nome (não bloqueia — pode ser atualizar).
  try {
    const idx = await api.getWorkspaceIndex();
    const list = kind === "skill" ? idx.skills : kind === "workflow" ? idx.workflows : idx.playbooks;
    if (list.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      if (!confirm(t("Já existe um {kind} com este nome — substituir?", { kind }))) return;
    }
  } catch {
    /* a verificação é só um aviso */
  }
  const fields: DocFields = { ...distillFields, name, desc, body, enabled: true, topic: topicName };
  try {
    await api.saveWorkspaceDoc(kind, name, assembleDoc(kind, fields));
  } catch (e) {
    alert(t("Falha a guardar: ") + e);
    return;
  }
  await api.dismissDistillHint(distillTopicId).catch(() => {});
  els.distillDialog.close();
  distillTopicId = null;
  distillFields = null;
  await loadConversations();
}

/** Descarta a proposta e limpa a dica do tópico. */
async function discardDistill() {
  const id = distillTopicId;
  els.distillDialog.close();
  distillTopicId = null;
  distillFields = null;
  if (id != null) {
    await api.dismissDistillHint(id).catch(() => {});
    await loadConversations();
  }
}

/** Cria um tópico, opcionalmente atribui-lhe um chat, e entra em renomear no novo cabeçalho. */
async function createTopicInteractive(assignConvId?: number) {
  let id: number;
  try {
    id = await api.createTopic(uniqueTopicName(t("Novo tópico")));
  } catch (e) {
    console.error(e);
    return;
  }
  if (assignConvId != null) {
    try {
      await api.setConversationTopic(assignConvId, id);
    } catch (e) {
      console.error(e);
    }
    if (state.currentConversationId === assignConvId) setActiveTopic(id);
  }
  await loadConversations();
  const head = els.convList.querySelector<HTMLElement>(`.topic-head[data-topic-id="${id}"]`);
  const nameEl = head?.querySelector<HTMLElement>(".topic-name");
  const tp = state.topics.find((x) => x.id === id);
  if (head && nameEl && tp) startTopicRename(tp, head, nameEl);
}

async function assignTopic(convId: number, topicId: number | null) {
  try {
    await api.setConversationTopic(convId, topicId);
  } catch (e) {
    console.error(e);
  }
  if (state.currentConversationId === convId) setActiveTopic(topicId);
  await loadConversations();
}

// ---- Arrastar uma conversa para um tópico (pointer-based) ----
// O Tauri intercepta o drag-drop nativo do webview (para o drop de ficheiros do SO), o que
// impede o HTML5 DnD interno. Implementamos o arrasto com pointer events + elementFromPoint.
let convDrag: {
  convId: number;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLElement | null;
} | null = null;

function beginConvDrag(e: PointerEvent, convId: number) {
  if (e.button !== 0) return; // só botão esquerdo
  if ((e.target as HTMLElement).closest(".conv-act, .conv-rename")) return; // ações/renomear não arrastam
  convDrag = { convId, startX: e.clientX, startY: e.clientY, active: false, ghost: null };
  window.addEventListener("pointermove", onConvDragMove);
  window.addEventListener("pointerup", onConvDragUp);
}

function highlightGroupAt(x: number, y: number) {
  document
    .querySelectorAll(".topic-group.drop-target")
    .forEach((el) => el.classList.remove("drop-target"));
  (document.elementFromPoint(x, y) as HTMLElement | null)
    ?.closest(".topic-group")
    ?.classList.add("drop-target");
}

function onConvDragMove(e: PointerEvent) {
  if (!convDrag) return;
  if (!convDrag.active) {
    if (Math.hypot(e.clientX - convDrag.startX, e.clientY - convDrag.startY) < 5) return; // limiar clique→arrasto
    convDrag.active = true;
    document.body.classList.add("dragging-conv");
    const g = document.createElement("div");
    g.className = "drag-ghost";
    g.textContent =
      state.conversations.find((c) => c.id === convDrag!.convId)?.title || t("Nova conversa");
    document.body.appendChild(g);
    convDrag.ghost = g;
  }
  if (convDrag.ghost) {
    convDrag.ghost.style.left = `${e.clientX + 14}px`;
    convDrag.ghost.style.top = `${e.clientY + 14}px`;
  }
  highlightGroupAt(e.clientX, e.clientY);
}

function onConvDragUp(e: PointerEvent) {
  window.removeEventListener("pointermove", onConvDragMove);
  window.removeEventListener("pointerup", onConvDragUp);
  const ds = convDrag;
  convDrag = null;
  document
    .querySelectorAll(".topic-group.drop-target")
    .forEach((el) => el.classList.remove("drop-target"));
  document.body.classList.remove("dragging-conv");
  ds?.ghost?.remove();
  if (!ds || !ds.active) return; // foi um clique, não um arrasto

  // Suprime o clique que se segue ao pointerup (senão abria a conversa).
  const suppress = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    window.removeEventListener("click", suppress, true);
  };
  window.addEventListener("click", suppress, true);
  setTimeout(() => window.removeEventListener("click", suppress, true), 0);

  const group = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
    ".topic-group"
  ) as HTMLElement | null;
  if (group) {
    const tid = group.dataset.topicId;
    void assignTopic(ds.convId, tid && tid !== "none" ? Number(tid) : null);
  }
}

/** Popover para mover uma conversa: (sem tópico) + tópicos existentes + novo tópico. */
function openTopicMenu(anchor: HTMLElement, c: ConversationMeta) {
  document.querySelector(".topic-menu")?.remove(); // só um aberto de cada vez
  const menu = document.createElement("div");
  menu.className = "topic-menu";
  const addItem = (label: string, onClick: () => void, active = false) => {
    const b = document.createElement("button");
    b.className = "topic-menu-item" + (active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.remove();
      onClick();
    });
    menu.appendChild(b);
  };
  addItem(t("(sem tópico)"), () => void assignTopic(c.id, null), c.topic_id == null);
  for (const tp of state.topics) {
    addItem(tp.name, () => void assignTopic(c.id, tp.id), c.topic_id === tp.id);
  }
  const sep = document.createElement("div");
  sep.className = "topic-menu-sep";
  menu.appendChild(sep);
  addItem(t("Novo tópico…"), () => void createTopicInteractive(c.id));

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** Menu do ícone de pasta do tópico: "Abrir pasta" / "Ver ficheiros" — um só ícone para as duas
 * ações, para não sobrecarregar a linha do tópico com mais um botão fixo. */
function openProjectMenu(anchor: HTMLElement, topic: Topic) {
  document.querySelector(".topic-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "topic-menu";
  const addItem = (label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "topic-menu-item";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.remove();
      onClick();
    });
    menu.appendChild(b);
  };
  addItem(t("Abrir pasta"), () => {
    api.openProjectFolder(topic.id).catch((err) => showHint(String(err)));
  });
  addItem(t("Ver ficheiros"), () => void openProjectFilesDialog(topic));

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
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
  const [convs, topics] = await Promise.all([api.listConversations(), api.listTopics()]);
  state.conversations = convs;
  state.topics = topics;
  // O tópico ativo persistido pode já não existir (apagado) — limpa-o.
  if (state.activeTopicId != null && !topics.some((t) => t.id === state.activeTopicId)) {
    setActiveTopic(null);
  }
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
    let steps: string[] | undefined;
    if (m.steps_json && m.steps_json !== "[]") {
      try {
        const arr = JSON.parse(m.steps_json);
        if (Array.isArray(arr) && arr.length) steps = arr as string[];
      } catch {
        /* ignora JSON inválido */
      }
    }
    return {
      id: m.id,
      role: "assistant",
      content: m.content,
      attachments,
      steps,
      meta: {
        text: m.content,
        route: (m.route as "local" | "claude") || "local",
        model: m.model,
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        tokens_saved: m.tokens_saved,
        cost_usd: m.cost_usd,
        reason: "",
        gen_ms: m.gen_ms,
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
  // Bloqueia só quando há um cartão à espera de resposta (não durante streaming normal).
  if (awaitingPrompt) return;
  closeDrawers(); // ecrã estreito: escolher uma conversa fecha a gaveta da lista
  // Guarda de corrida: cliques rápidos disparam várias cargas; só a última vence.
  const seq = ++selectSeq;
  state.currentConversationId = id;
  // O tópico ativo segue o chat aberto (as Sagas novas nascem nele).
  setActiveTopic(state.conversations.find((c) => c.id === id)?.topic_id ?? null);
  renderSidebar(); // realce imediato na barra lateral
  const msgs = await api.getConversation(id);
  if (seq !== selectSeq) return;
  state.items = msgs.map(storedToItem);
  // Se esta Saga está a gerar agora (em fundo), re-anexa a bolha em curso para se ver ao vivo.
  if (streamingConvId === id && streamingItem) state.items.push(streamingItem);
  try {
    const c = await api.getCompaction(id);
    if (seq !== selectSeq) return;
    state.compactedSummary = c.summary;
    state.compactedUpto = c.upto;
  } catch {
    if (seq !== selectSeq) return;
    resetCompaction();
  }
  renderMessages();
  scrollChatToBottom(); // ao abrir uma Saga, mostra a mensagem mais recente
  renderSidebar();
  try {
    const acct = await api.conversationAccounting(id);
    if (seq !== selectSeq) return;
    renderAccounting(acct);
  } catch {
    /* ignora */
  }
}

async function createConversation(topicId?: number | null) {
  if (state.busy) return;
  closeDrawers(); // ecrã estreito: nova Saga fecha a gaveta da lista
  // Sem argumento → herda o tópico ativo (que segue o chat aberto); o "+" de um grupo passa o seu id.
  const topic = topicId !== undefined ? topicId : state.activeTopicId;
  const id = await api.newConversation(undefined, topic);
  setActiveTopic(topic ?? null);
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
  thinkLevel?: ThinkLevel;
  research?: boolean;
  subagents?: boolean;
  plan?: boolean;
};

/** Item já compactado (resumido e fora do contexto enviado ao modelo)? */
function isCompacted(i: Item): boolean {
  return state.compactedUpto > 0 && i.id !== undefined && i.id <= state.compactedUpto;
}

function buildPayload(): ChatMessage[] {
  const live = state.items.filter((i) => !isCompacted(i));
  // Os bytes (data_base64) dos documentos só são precisos no anexo novo (persistência) e no visor
  // (que lê de state.items, não daqui). Reenviar ~25 MB de base64 do histórico a cada turno é puro
  // desperdício → tira-os de todas as mensagens menos a última do utilizador. O texto extraído fica.
  const lastUserIdx = live.map((i) => i.role).lastIndexOf("user");
  const kept = live.map((i, idx) => {
    let attachments = i.attachments;
    if (attachments && idx !== lastUserIdx && attachments.some((a) => a.kind === "document")) {
      attachments = attachments.map((a) =>
        a.kind === "document" ? { ...a, data_base64: "" } : a
      );
    }
    return { role: i.role, content: i.content, attachments };
  });
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

/** Modelo fixado pelo agente ativo, se aplicável à rota efetiva. Local: valida instalados (fallback
 *  ao default + aviso se foi apagado). Claude: passa o id tal como está. */
async function agentModelOverride(effectiveRoute: "local" | "claude"): Promise<string | undefined> {
  const a = state.activeAgent;
  if (!a?.model || a.route !== effectiveRoute) return undefined;
  if (a.route === "claude") return a.model; // ids Claude não são "instalados"
  try {
    const installed = await api.listOllamaModels();
    const base = (x: string) => x.split(":")[0];
    if (installed.some((m) => m === a.model || base(m) === base(a.model))) return a.model;
    showHint(t("Modelo '{m}' do agente não está instalado — a usar o default.", { m: a.model }));
  } catch {
    /* sem Ollama / lista falhou → usa o default */
  }
  return undefined;
}

/** Escalonamento para a cloud (Claude/OpenAI) está configurado? Se não, esconde tudo o que é Claude. */
function cloudEnabled(): boolean {
  const s = state.settings;
  if (!s) return false;
  if (s.cloud_provider === "claude") {
    if (s.claude_mode === "off") return false;
    // Modo API precisa mesmo de uma chave — senão escalar (subagentes/pesquisa) falha com
    // "ANTHROPIC_API_KEY não configurada". CLI usa a subscrição, não precisa de chave aqui.
    if (s.claude_mode === "api") return !!s.claude_api_key?.trim();
    return true;
  }
  return !!s.openai_cloud_endpoint?.trim();
}

/** Empurra uma bolha de assistente e preenche-a com o streaming. */
/** Estado de espera (antes do 1.º token): o quê + desde quando, para dar feedback vivo. */
type WaitKind = "plan" | "research" | "subagents" | "doc" | "think" | "normal";
let waitKind: WaitKind = "normal";
let waitStart = 0;
let waitTicker: number | undefined;

/** Mensagem de espera; para documentos avança por fases conforme o tempo passa. */
function waitMessage(kind: WaitKind, ms: number): string {
  switch (kind) {
    case "plan":
      return t("A planear…");
    case "research":
      return t("A pesquisar na net…");
    case "subagents":
      return t("A coordenar subagentes…");
    case "doc":
      if (ms >= 12000) return t("Quase a responder…");
      if (ms >= 5000) return t("A processar o conteúdo…");
      return t("A ler o documento…");
    case "think":
      return t("A pensar a fundo…");
    default:
      return t("A pensar…");
  }
}

/** Tempo decorrido formatado (ex.: "8s", "1m04"). */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/** Duração de geração para o rodapé da mensagem (1 casa decimal abaixo de 10s). */
function fmtDuration(ms: number): string {
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  }
  return fmtElapsed(ms);
}

/** Atualiza a mensagem + contador da bolha de espera; pára-se sozinho quando esta desaparece. */
function paintWait() {
  const row = els.messages.lastElementChild?.querySelector(".waiting-row");
  const status = row?.querySelector(".status-text") as HTMLElement | null;
  const elapsed = row?.querySelector(".wait-elapsed") as HTMLElement | null;
  if (!status) {
    stopWaitTicker();
    return;
  }
  const ms = waitStart ? Date.now() - waitStart : 0;
  status.textContent = waitMessage(waitKind, ms);
  if (elapsed) elapsed.textContent = ms >= 2500 ? fmtElapsed(ms) : "";
}

function startWaitTicker() {
  stopWaitTicker();
  waitTicker = window.setInterval(paintWait, 1000);
}
function stopWaitTicker() {
  if (waitTicker) {
    clearInterval(waitTicker);
    waitTicker = undefined;
  }
}

// Cache dos modelos locais instalados (para o A/B no chat e o autocomplete do agente). Atualizado
// no arranque e quando a vista Modelos lista os instalados.
let localModelsCache: string[] = [];
function setLocalModelsCache(ms: string[]) {
  localModelsCache = ms;
  els.modelsList.innerHTML = ms.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("");
}

// Pré-aquecimento do modelo local: carrega-o em VRAM antes do 1.º envio para a resposta
// não ter de esperar pelo cold-start. Throttle por modelo (o keep_alive mantém-no residente).
let lastWarm = { model: "", at: 0 };
function warmLocalModel(model?: string, force = false) {
  if (state.busy) return; // já está a gerar (modelo carregado)
  if (state.routeMode === "claude") return; // só faz sentido para o modelo local
  const s = state.settings;
  if (!s || s.local_provider !== "ollama") return;
  const m = model || s.ollama_model;
  if (!m) return;
  const now = Date.now();
  // `force` ignora o throttle (ex.: acabou de instalar → queremos aquecer já, mesmo que
  // uma tentativa anterior — falhada por o modelo ainda não existir — tenha marcado o tempo).
  if (!force && m === lastWarm.model && now - lastWarm.at < 60_000) return; // no máx. 1×/min
  lastWarm = { model: m, at: now };
  void api.warmModel(m).catch(() => {});
}

// Troca de Saga: corrida (cliques rápidos) + streaming em fundo.
// `selectSeq` deixa só o clique mais recente aplicar-se; `streamingConvId`/`streamingItem` permitem
// continuar a gerar numa Saga enquanto se vê outra (e re-anexar a bolha ao voltar).
let selectSeq = 0;
let streamingConvId: number | null = null;
let streamingItem: Item | null = null;
let awaitingPrompt = false; // há um cartão (plano/esclarecimento/aprovação) à espera de resposta

async function streamAssistant(payload: ChatMessage[], opts: SendOpts) {
  const conversationId = state.currentConversationId!;
  const sendOpts: SendOpts = {
    ...opts,
    thinkLevel: opts.thinkLevel ?? state.thinkLevel,
    research: opts.research ?? state.research,
    subagents: opts.subagents ?? state.subagents,
    plan: opts.plan ?? state.plan,
  };
  // A pesquisa (🔎) corre localmente no Ollama (loop de ferramentas web_search/web_fetch);
  // subagentes são só Claude. Só escala para o Claude se ele estiver mesmo utilizável e o
  // provider local não souber pesquisar (ex.: LM Studio).
  const canLocalSearch = state.settings?.local_provider === "ollama";
  if (!sendOpts.routeOverride && cloudEnabled()) {
    if (sendOpts.subagents) sendOpts.routeOverride = "claude";
    else if (sendOpts.research && !canLocalSearch) sendOpts.routeOverride = "claude";
  }
  // Modelo fixado pelo agente → override (só se a rota efetiva for a do agente; valida instalados).
  if (!sendOpts.modelOverride) {
    const effRoute = sendOpts.routeOverride === "claude" ? "claude" : "local";
    sendOpts.modelOverride = await agentModelOverride(effRoute);
  }
  // Estado de espera mostrado na bolha vazia (persistente entre re-renders) até chegar conteúdo.
  const localReasons =
    state.routeMode !== "claude" &&
    !!state.settings?.ollama_model &&
    modelCapabilities(state.settings.ollama_model).reasoning;
  // O documento (prefill de um prompt grande) é a maior causa de espera antes do 1.º token.
  const lastUser = [...payload].reverse().find((m) => m.role === "user");
  const hasDoc = !!lastUser?.attachments?.some((a) => a.kind === "document");
  waitKind = sendOpts.plan
    ? "plan"
    : sendOpts.research
      ? "research"
      : sendOpts.subagents
        ? "subagents"
        : hasDoc
          ? "doc"
          : (sendOpts.thinkLevel && sendOpts.thinkLevel !== "off") || localReasons
            ? "think"
            : "normal";
  waitStart = Date.now();
  const assistant: Item = { role: "assistant", content: "", report: sendOpts.research };
  state.items.push(assistant);
  streamingConvId = conversationId;
  streamingItem = assistant;
  // Esta Saga ainda está a ser vista? (permite gerar em fundo enquanto se navega para outra)
  const viewing = () => state.currentConversationId === conversationId;
  setBusy(true);
  renderMessages();
  scrollChatToBottom(); // novo turno (envio/regenerar) = salta para o fim
  startWaitTicker();
  // Pesquisa fundamentada local (decompõe → pesquisa → verifica → sintetiza) demora — avisa.
  if (sendOpts.research && sendOpts.routeOverride !== "claude" && canLocalSearch) {
    showHint(
      t("Pesquisa fundamentada — pode demorar um pouco (decompõe, pesquisa cada parte e verifica). Vês o progresso à medida que avança.")
    );
  }

  const paintBubble = () => {
    if (!viewing()) return; // a gerar em fundo: acumula em `assistant`, sem tocar no DOM
    const stick = isChatNearBottom();
    const b = els.messages.lastElementChild?.querySelector(".bubble") as HTMLDivElement | null;
    if (b) {
      b.classList.remove("markdown"); // texto simples durante o streaming
      b.textContent = assistant.content;
    }
    if (stick) els.messages.scrollTop = els.messages.scrollHeight;
    else updateScrollBtn();
  };
  // Atualiza só o texto do bloco de raciocínio (NÃO re-renderiza tudo — modelos que pensam
  // emitem centenas de fragmentos; um renderMessages() por fragmento congelava a UI).
  const paintThinking = () => {
    if (!viewing()) return;
    const stick = isChatNearBottom();
    const body = els.messages.lastElementChild?.querySelector(
      ".thinking-block .thinking-body"
    ) as HTMLElement | null;
    if (body) body.textContent = assistant.thinking ?? "";
    if (stick) els.messages.scrollTop = els.messages.scrollHeight;
  };

  let start: { route: "local" | "claude"; model: string; reason: string } | null = null;

  try {
    await api.sendMessageStream(
      conversationId,
      payload,
      async (evt) => {
        // Eventos interativos bloqueiam o backend à espera de resposta → garante que a Saga certa
        // está à vista (re-anexa a bolha) antes de mostrar o cartão, mesmo que se tenha navegado.
        if (evt.kind === "ApprovalRequest" || evt.kind === "Clarify" || evt.kind === "Plan") {
          if (!viewing()) await selectConversation(conversationId);
          awaitingPrompt = true;
        }
        if (evt.kind === "Start") {
          start = { route: evt.route, model: evt.model, reason: evt.reason };
        } else if (evt.kind === "Delta") {
          if (!assistant.content) stopWaitTicker(); // 1.º token real → fim da espera
          assistant.content += evt.text;
          paintBubble();
        } else if (evt.kind === "Thinking") {
          const firstChunk = !assistant.thinking;
          assistant.thinking = (assistant.thinking ?? "") + evt.text;
          // 1.º fragmento → cria o bloco (1 render); seguintes → atualização incremental barata.
          if (firstChunk) {
            if (viewing()) renderMessages();
          } else paintThinking();
        } else if (evt.kind === "ToolStep") {
          assistant.steps = assistant.steps ?? [];
          assistant.steps.push(formatToolStep(evt.tool, evt.detail));
          if (viewing()) renderMessages();
          paintBubble();
        } else if (evt.kind === "ApprovalRequest") {
          showApproval(evt.id, evt.tool, evt.preview);
        } else if (evt.kind === "Clarify") {
          stopWaitTicker(); // agora espera-se o utilizador
          showClarifyCard(evt.id, evt.questions);
        } else if (evt.kind === "Plan") {
          stopWaitTicker(); // agora espera-se o utilizador (não o modelo)
          showPlanCard(evt.id, evt.steps, assistant, evt.needs_web, evt.research);
        } else if (evt.kind === "PlanStep") {
          if (assistant.plan?.steps[evt.index]) {
            assistant.plan.steps[evt.index].status =
              evt.status as "pending" | "executing" | "searching" | "done" | "error";
            if (viewing()) renderMessages();
            paintBubble();
          }
        } else if (evt.kind === "Done") {
          assistant.id = evt.message_id || assistant.id;
          assistant.meta = {
            text: assistant.content,
            route: start?.route ?? "local",
            model: start?.model ?? "",
            input_tokens: evt.input_tokens,
            output_tokens: evt.output_tokens,
            tokens_saved: evt.tokens_saved,
            cost_usd: evt.cost_usd,
            reason: start?.reason ?? "",
            gen_ms: evt.gen_ms,
            intent: evt.intent,
            thinkLevel: evt.think_level, // o que REALMENTE correu (não só o selecionado)
            confidence: evt.confidence,
            accounting: evt.accounting,
          };
          // Persiste os breadcrumbs de ferramentas para sobreviverem a reinícios.
          if (evt.message_id && assistant.steps?.length) {
            void api
              .setMessageSteps(evt.message_id, assistant.steps)
              .catch((e) => api.logFrontend("warn", `setMessageSteps: ${e}`));
          }
        }
      },
      sendOpts
    );
  } catch (e) {
    assistant.content = String(e);
    assistant.error = true;
    void api.logFrontend("warn", `stream erro: ${String(e)}`).catch(() => {});
    // Falha a carregar o modelo de visão (ex.: arquitetura mllama do llama3.2-vision que o Ollama
    // não suporta) numa conversa com imagens → dica acionável em vez de só o 500 cru.
    const hasImg = state.items.some((i) => i.attachments?.some((a) => a.kind === "image"));
    if (hasImg && /loading model|architecture|mllama|terminated/i.test(String(e))) {
      showHint(
        t("O modelo de visão não carregou no Ollama. Escolhe outro em Modelos → Modelo de visão (ex.: gemma4).")
      );
    }
  } finally {
    setBusy(false);
    stopWaitTicker();
    if (streamingItem === assistant) {
      streamingConvId = null;
      streamingItem = null;
    }
    // Cancelado antes do 1.º token → bolha vazia sem utilidade: remove-a.
    if (!assistant.content && !assistant.thinking && !assistant.steps?.length && !assistant.error) {
      const i = state.items.indexOf(assistant);
      if (i >= 0) state.items.splice(i, 1);
    }
    awaitingPrompt = false;
    // Breadcrumb: última ação antes de um eventual crash do renderer (render pesado com imagem).
    const hasImg = state.items.some((i) => i.attachments && i.attachments.length);
    void api
      .logFrontend(
        "info",
        `turn done: a renderizar ${state.items.length} msgs (img=${hasImg}, content=${assistant.content.length}c, thinking=${(assistant.thinking ?? "").length}c)`
      )
      .catch(() => {});
    if (viewing()) renderMessages();
    loadConversations(); // atualiza título/ordem na sidebar
    if (viewing()) {
      try {
        renderAccounting(await api.conversationAccounting(conversationId));
      } catch {
        /* ignora */
      }
    }
  }
  // Pediste pesquisa mas a resposta local não traz fontes → o modelo não chamou a ferramenta
  // (ou a pesquisa veio vazia). Diz porquê, em vez de deixar parecer que pesquisou.
  if (
    viewing() &&
    sendOpts.research &&
    !assistant.error &&
    (assistant.meta?.route ?? "local") === "local" &&
    parseSources(assistant.content).sources.length === 0
  ) {
    showHint(
      t("Sem fontes: o modelo respondeu sem pesquisar (modelos médios nem sempre chamam ferramentas). Para pesquisa fiável, usa qwen3/llama3.1 ou adiciona uma chave de motor.")
    );
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
function toggleComposerFlag(flag: "research" | "subagents") {
  state[flag] = !state[flag];
  const id = flag === "research" ? "#btn-research" : "#btn-subagents";
  document.querySelector(id)!.classList.toggle("active", state[flag]);
}
function openSettingsDialog() {
  els.dialog.showModal();
  // Reflete o estado real do arranque com o sistema (pode falhar em ambientes sem suporte).
  api
    .getAutostart()
    .then((on) => {
      const cb = document.querySelector<HTMLInputElement>("#set-autostart");
      if (cb) cb.checked = on;
    })
    .catch(() => {});
  // Mostra o caminho da pasta de logs (para o utilizador abrir/partilhar em caso de crash).
  api
    .logDir()
    .then((dir) => {
      const el = document.querySelector("#log-path");
      if (el) el.textContent = dir;
    })
    .catch(() => {});
}

function slashCommands(): SlashCmd[] {
  const cmds: SlashCmd[] = [
    { cmd: "skill", label: t("Criar skill com IA — /skill <descrição>"), kind: "create" },
    { cmd: "playbook", label: t("Criar playbook com IA — /playbook <descrição>"), kind: "create" },
    { cmd: "workflow", label: t("Criar workflow com IA — /workflow <descrição>"), kind: "create" },
    { cmd: t("pesquisar"), label: t("Toggle: Pesquisar"), kind: "setting", run: () => toggleComposerFlag("research") },
    { cmd: t("modelos"), label: t("Abrir Modelos"), kind: "setting", run: () => openModels() },
    { cmd: t("definicoes"), label: t("Abrir Definições"), kind: "setting", run: openSettingsDialog },
  ];
  // Comandos só-Claude apenas quando o escalonamento está configurado.
  if (cloudEnabled()) {
    cmds.push(
      { cmd: "local", label: t("Rota: Local"), kind: "setting", run: () => setRouteMode("local") },
      { cmd: "claude", label: t("Rota: Claude"), kind: "setting", run: () => setRouteMode("claude") },
      { cmd: "think", label: t("Toggle: Think"), kind: "setting", run: () => setThinkLevel(state.thinkLevel === "off" ? "think" : "off") },
      { cmd: t("subagentes"), label: t("Toggle: Subagentes"), kind: "setting", run: () => toggleComposerFlag("subagents") }
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
    note.content = `${kind} **${name}** criada no Workspace. Abre o Workspace (rail) para rever/editar.`;
  } catch (e) {
    note.content = `Falha a criar ${kind}: ${e}`;
    note.error = true;
  }
  renderMessages();
}

/** Avisa quando uma imagem não terá modelo que a leia (ativo sem visão + visão não instalado). */
async function warnIfNoVisionModel(activeModel: string, visionModel: string) {
  if (modelCapabilities(activeModel).vision) return; // o ativo já vê
  const vis = (visionModel || "").trim();
  let installed: string[] = [];
  try {
    installed = await api.listOllamaModels();
  } catch {
    return; // sem lista, não arrisca falso alarme
  }
  const visInstalled = !!vis && installed.some((m) => m === vis || m.startsWith(vis + ":"));
  if (!visInstalled) {
    showHint(
      t(
        "O modelo ativo '{m}' não lê imagens e o modelo de visão '{v}' não está instalado. Troca para um modelo com visão (ex.: gemma4) ou instala-o em Modelos.",
        { m: activeModel, v: vis || "—" }
      )
    );
  }
}

async function onSubmit(ev: Event) {
  ev.preventDefault();
  // A gerar → o botão é "Parar": cancela em vez de enviar (só por clique no botão, não por Enter).
  if (state.busy) {
    if ((ev as SubmitEvent).submitter === els.send) cancelCurrentGeneration();
    return;
  }
  hideSlash();
  const text = els.input.value.trim();
  if (!text && state.pendingAttachments.length === 0) return;

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

  // Aviso (não bloqueia): imagem + modelo local sem visão + modelo de visão não instalado → 404 certo.
  // Só relevante para imagens — documentos são texto e não exigem visão.
  if (
    attachments.some((a) => a.kind === "image") &&
    state.routeMode !== "claude" &&
    state.settings?.local_provider === "ollama"
  ) {
    void warnIfNoVisionModel(state.settings.ollama_model, state.settings.ollama_vision_model);
  }

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

  // Anexos editáveis (remover existentes / adicionar novos).
  const editAtts: Attachment[] = [...(item.attachments ?? [])];
  const thumbs = document.createElement("div");
  thumbs.className = "edit-thumbs attachments";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ATTACH_ACCEPT;
  fileInput.multiple = true;
  fileInput.hidden = true;
  const renderEditThumbs = () => {
    thumbs.innerHTML = "";
    editAtts.forEach((a, i) => {
      const remove = () => {
        editAtts.splice(i, 1);
        renderEditThumbs();
      };
      if (a.kind === "document") {
        thumbs.appendChild(docChipEl(a, remove));
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      const img = document.createElement("img");
      img.src = `data:${a.media_type};base64,${a.data_base64}`;
      img.addEventListener("click", () => openLightbox(img.src));
      const rm = document.createElement("button");
      rm.innerHTML = icon("x");
      rm.title = t("Remover");
      rm.addEventListener("click", remove);
      wrap.append(img, rm);
      thumbs.appendChild(wrap);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "edit-add-img";
    add.textContent = t("+ Ficheiro");
    add.title = t("Anexar ficheiro");
    add.addEventListener("click", () => fileInput.click());
    thumbs.appendChild(add);
  };
  fileInput.addEventListener("change", async () => {
    const files = fileInput.files;
    if (files) {
      for (const f of Array.from(files)) {
        if (isAcceptedFile(f)) editAtts.push(await fileToAttachment(f));
      }
    }
    fileInput.value = "";
    renderEditThumbs();
  });
  renderEditThumbs();

  const bar = document.createElement("div");
  bar.className = "edit-bar";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = t("Cancelar");
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = t("Guardar e reenviar");
  bar.append(cancel, save);
  row.append(ta, thumbs, fileInput, bar);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const commit = async () => {
    const text = ta.value.trim();
    if (!text && editAtts.length === 0) return;
    const attachments = editAtts.length ? editAtts.slice() : undefined;
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
  // Durante a geração, o botão Enviar transforma-se em "Parar" (cancela a geração, mantendo o
  // texto já produzido). O input permanece ativo para se redigir a próxima mensagem entretanto.
  els.send.textContent = b ? t("Parar") : t("Enviar");
  els.send.classList.toggle("stop", b);
  els.send.disabled = false;
}

/** Cancela a geração em curso (botão "Parar"). O backend finaliza com o parcial já gerado. */
function cancelCurrentGeneration() {
  if (streamingConvId == null) return;
  void api.cancelGeneration(streamingConvId).catch(() => {});
  showHint(t("Geração parada."));
}

// ---- Settings (app: aparência + atualizações; config de modelos vive no hub Modelos) ----
/**
 * Local-first: mostra o seletor Local|Claude e os toggles só-Claude (🧩/🧠) apenas quando o
 * Claude está configurado. 🔎 fica visível também em local-only se a pesquisa web local estiver ON.
 */
function applyComposerToggles() {
  const s = state.settings;
  const cloud = cloudEnabled();
  // 🔎 corre no Ollama (loop de ferramentas) ou no Claude — disponível a pedido, sem depender
  // de a Pesquisa web estar sempre-ligada nas Definições.
  const canSearch = s?.local_provider === "ollama" || cloud;
  // Seletor Local|Claude só faz sentido se houver Claude.
  document.querySelector("#route-pick")?.toggleAttribute("hidden", !cloud);
  if (!cloud && state.routeMode === "claude") setRouteMode("local");
  // Toggles: 🔎 (Ollama ou cloud) · 🧩/🧠 (só Claude).
  document.querySelector("#btn-research")?.toggleAttribute("hidden", !canSearch);
  document.querySelector("#btn-subagents")?.toggleAttribute("hidden", !cloud);
  document.querySelector("#btn-think")?.toggleAttribute("hidden", !cloud);
  // Plan mode corre no modelo local (Ollama) ou no Claude.
  document.querySelector("#btn-plan")?.toggleAttribute("hidden", !(s?.local_provider === "ollama" || cloud));
  // O picker de agente está sempre disponível (funciona em local puro), por isso a barra e o
  // contentor de toggles ficam sempre visíveis.
  els.routeModeBar.querySelector(".composer-toggles")!.removeAttribute("hidden");
  els.routeModeBar.removeAttribute("hidden");
}

// ---- Picker de agente (persona) no composer ----
function setToggle(which: "research" | "subagents" | "plan", on: boolean) {
  state[which] = on;
  const id =
    which === "research" ? "#btn-research" : which === "plan" ? "#btn-plan" : "#btn-subagents";
  document.querySelector(id)?.classList.toggle("active", on);
}

const THINK_LABELS: Record<ThinkLevel, string> = {
  off: "off",
  think: "think",
  verify: "verify",
  debate: "debate",
};

/** Define o nível de Think (escala de esforço) e atualiza o chip + o menu. */
function setThinkLevel(level: ThinkLevel) {
  state.thinkLevel = level;
  const btn = document.querySelector("#btn-think");
  btn?.classList.toggle("active", level !== "off");
  const lbl = document.querySelector("#btn-think-label");
  if (lbl) lbl.textContent = level === "off" ? t("Think") : `${t("Think")}: ${THINK_LABELS[level]}`;
  document
    .querySelectorAll<HTMLElement>("#think-menu [data-level]")
    .forEach((el) => el.classList.toggle("active", el.dataset.level === level));
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
    state.activeAgent = {
      name: f.name || name,
      system: f.body,
      route: f.agentRoute === "claude" ? "claude" : "local",
      model: f.agentModel || "",
    };
    // Aplica as predefinições sugeridas pelo agente — só ativa o que é realmente utilizável
    // (🔎 corre no Ollama ou no Claude; subagentes precisam do Claude).
    const canSearch = state.settings?.local_provider === "ollama" || cloudEnabled();
    setRouteMode(f.agentRoute === "claude" && cloudEnabled() ? "claude" : "local");
    setToggle("research", !!f.agentResearch && canSearch);
    setToggle("subagents", !!f.agentSubagents && cloudEnabled());
    setToggle("plan", !!f.agentPlan);
    setThinkLevel(f.agentThinkLevel ?? "off");
    updateAgentChip();
    showHint(t("Agente ativo: {n}", { n: state.activeAgent.name }));
    if (state.research) maybeWarnSearch(); // avisa se faltar chave de pesquisa
  } catch (e) {
    showHint(t("Falha a carregar o agente: ") + e);
  }
}

/** Menu flutuante para escolher um agente (ou desligar). */
async function openAgentMenu() {
  document.querySelector("#agent-menu")?.remove();
  let agents: DocMeta[] = [];
  try {
    agents = (await api.getWorkspaceIndex()).agents.filter((a) => a.enabled);
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
  // Com Claude, a pesquisa funciona (web_search nativo).
  if (state.routeMode === "claude" && cloudEnabled()) return;
  // O 🔎 local só funciona no Ollama (o LM Studio não corre o loop de ferramentas).
  if (s.local_provider !== "ollama") {
    showHint(t("Sem pesquisa com o LM Studio — usa o Ollama ou ativa o Claude."));
    return;
  }
  if (!modelHasTools(s.ollama_model)) {
    showHint(t("Pode não pesquisar: '{m}' não chama ferramentas — usa qwen3 ou llama3.1.", { m: s.ollama_model }));
    return;
  }
  // Gemma tem "tools" mas chama-as de forma inconsistente no Ollama (costuma responder de
  // memória). Avisa proativamente — os mais fiáveis a pesquisar são o qwen3 e o llama3.1.
  if (/gemma/.test(s.ollama_model.toLowerCase())) {
    showHint(t("O Gemma chama ferramentas de forma inconsistente — pode responder sem pesquisar. Para pesquisa fiável, usa qwen3 ou llama3.1."));
    return;
  }
  // DuckDuckGo é keyless e funciona (com limites de ritmo) → sem aviso.
  // Um motor com chave mas sem chave definida cai para o DuckDuckGo — nota suave, não alarme.
  const p = s.web_search_provider;
  const hasKey = !!s.web_search_keys?.[p];
  if (p !== "duckduckgo" && !hasKey) {
    const label = WEB_PROVIDER_META[p]?.label ?? p;
    showHint(t("Sem chave {p} — usa o DuckDuckGo (keyless, funciona com limites). Adiciona a chave {p} para mais fiabilidade/volume.", { p: label }));
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

/** Classifica um ficheiro do projeto pela extensão (mesmas categorias dos artefactos do chat). */
function classifyByExtension(path: string): ArtifactKind {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "mmd" || ext === "mermaid") return "mermaid";
  return "code";
}

/** Lista os ficheiros da pasta do projeto do tópico; clicar num abre-o no painel de artefactos. */
async function openProjectFilesDialog(topic: Topic) {
  els.projectFilesTitle.textContent = t("Ficheiros do projeto: {p}", { p: topic.folder_path });
  els.projectFilesList.innerHTML = "";
  els.projectFilesStatus.textContent = t("A carregar…");
  if (!els.projectFilesDialog.open) els.projectFilesDialog.showModal();
  try {
    const files = await api.listProjectFiles(topic.id);
    els.projectFilesStatus.textContent = files.length
      ? ""
      : t("Pasta vazia (ou só tem subpastas ignoradas, como node_modules).");
    for (const path of files) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = path;
      btn.addEventListener("click", () => void previewProjectFile(topic, path));
      li.appendChild(btn);
      els.projectFilesList.appendChild(li);
    }
  } catch (e) {
    els.projectFilesStatus.textContent = String(e);
  }
}

/** Lê um ficheiro do projeto e abre-o no painel de artefactos (mesmo visor dos artefactos do chat). */
async function previewProjectFile(topic: Topic, path: string) {
  try {
    const code = await api.readProjectFileRaw(topic.id, path);
    openArtifact({ lang: path.split(".").pop() || "", code, kind: classifyByExtension(path) });
    // "Guardar no projeto" não faz sentido aqui — o ficheiro já está gravado (é isto que estamos
    // a pré-visualizar); esconder evita gravar por engano na pasta de OUTRO projeto se a conversa
    // aberta neste momento pertencer a um tópico diferente.
    document.querySelector("#artifact-save-project")?.setAttribute("hidden", "");
    els.projectFilesDialog.close();
  } catch (e) {
    showHint(String(e));
  }
}

function openArtifact(a: Artifact) {
  artifactCurrent = a;
  artifactMode = a.kind === "code" ? "code" : "preview";
  els.artifactTitle.textContent = `${t(KIND_LABEL[a.kind])}` + (a.lang ? ` · ${a.lang}` : "");
  els.artifactPanel.hidden = false;
  // "Guardar no projeto" só aparece quando a conversa é um projeto editável.
  document
    .querySelector("#artifact-save-project")
    ?.toggleAttribute("hidden", !currentProjectTopic());
  renderArtifactBody();
  reflowArtifactControls();
}

// Overflow da barra de controlos: os botões que não couberem vão para um menu "⋯".
const ARTIFACT_COLLAPSIBLE = [
  "artifact-gallery",
  "artifact-toggle",
  "artifact-pdf-theme",
  "artifact-pdf",
  "artifact-save-project",
  "artifact-export",
  "artifact-copy",
];
function reflowArtifactControls() {
  const head = document.querySelector<HTMLElement>(".artifact-head");
  const bar = document.querySelector<HTMLElement>(".artifact-controls");
  const wrap = document.querySelector<HTMLElement>("#artifact-more-wrap");
  const menu = document.querySelector<HTMLElement>("#artifact-more-menu");
  if (!head || !bar || !wrap || !menu || els.artifactPanel.hidden) return;
  // Reset: tudo de volta à barra (antes do ⋯); menu fechado.
  for (const id of ARTIFACT_COLLAPSIBLE) {
    const el = document.getElementById(id);
    if (el) bar.insertBefore(el, wrap);
  }
  wrap.hidden = true;
  menu.hidden = true;
  if (head.scrollWidth <= head.clientWidth + 1) return; // cabe tudo
  wrap.hidden = false; // mostra o ⋯
  // Move do fim para o início até caber (saltando os que já estão ocultos).
  for (let i = ARTIFACT_COLLAPSIBLE.length - 1; i >= 0; i--) {
    if (head.scrollWidth <= head.clientWidth + 1) break;
    const el = document.getElementById(ARTIFACT_COLLAPSIBLE[i]);
    if (!el || el.hasAttribute("hidden")) continue;
    menu.prepend(el);
  }
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

/** O tópico-projeto (pasta anexada) da conversa atual, se houver. Independente do permission_mode:
 * gravar manualmente via diálogo nativo é o próprio utilizador a confirmar, não uma escrita autónoma. */
function currentProjectTopic(): Topic | null {
  const conv = state.conversations.find((c) => c.id === state.currentConversationId);
  if (!conv || conv.topic_id == null) return null;
  const tp = state.topics.find((t) => t.id === conv.topic_id);
  return tp && tp.folder_path.trim() ? tp : null;
}

/** Grava o artefacto atual diretamente na pasta do projeto (escolhe o nome via diálogo nativo). */
async function saveArtifactToProject() {
  if (!artifactCurrent) return;
  const tp = currentProjectTopic();
  if (!tp) return;
  const ext =
    artifactCurrent.kind === "html"
      ? "html"
      : artifactCurrent.kind === "markdown"
        ? "md"
        : artifactCurrent.lang || "txt";
  const root = tp.folder_path.replace(/[\\/]+$/, "");
  const chosen = await save({
    defaultPath: `${root}/${slugify(deriveDocTitle(artifactCurrent)) || "ficheiro"}.${ext}`,
    title: t("Guardar no projeto"),
  });
  if (!chosen) return;
  // Caminho relativo à pasta do projeto (o backend é sandboxed à pasta).
  if (!chosen.startsWith(root)) {
    showHint(t("Escolhe um local dentro da pasta do projeto."));
    return;
  }
  const rel = chosen.slice(root.length).replace(/^[\\/]+/, "");
  try {
    await api.projectSaveFile(state.currentConversationId!, rel, artifactCurrent.code);
    showHint(t("Guardado em {p}", { p: rel }));
  } catch (e) {
    showHint(t("Falha a guardar: ") + e);
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
  const sel = document.querySelector<HTMLSelectElement>("#artifact-pdf-theme");
  const theme = (sel?.value as PdfTheme) || "report";
  let inner: string;
  if (a.kind === "markdown") {
    inner = renderMarkdown(a.code);
  } else if (a.kind === "mermaid") {
    inner = els.artifactBody.querySelector(".artifact-mermaid")?.innerHTML ?? `<pre>${escapeHtml(a.code)}</pre>`;
  } else {
    inner = `<pre>${escapeHtml(a.code)}</pre>`;
  }
  printHtml(inner, false, deriveDocTitle(a), theme);
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

  /* ── Tema "Artigo" — editorial, serifado, medida estreita ── */
  body[data-theme="article"] {
    --ink: #241f1c; --accent: #7a2e3a; --muted: #6a5d57; --line: #e0d6cf; --soft: #f6f1ec;
    font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
    font-size: 12pt; line-height: 1.7;
  }
  body[data-theme="article"] { max-width: 165mm; margin: 0 auto; }
  body[data-theme="article"] .doc-cover { text-align: center; border-bottom-width: 1px; padding-bottom: 20px; }
  body[data-theme="article"] .doc-cover h1 { font-size: 30pt; }
  body[data-theme="article"] h2 { border-bottom: none; font-style: italic; }
  body[data-theme="article"] thead { background: transparent; color: var(--ink); border-bottom: 2px solid var(--accent); }
  body[data-theme="article"] th { border: none; border-bottom: 1px solid var(--line); }
  body[data-theme="article"] td { border: none; border-bottom: 1px solid var(--line); }

  /* ── Tema "Técnico" — monoespaçado nos títulos, denso, grelha ── */
  body[data-theme="technical"] {
    --ink: #16201f; --accent: #0f6e6e; --muted: #4c5a59; --line: #cdd9d8; --soft: #eef4f4;
    font-size: 10.5pt; line-height: 1.55;
  }
  body[data-theme="technical"] h1,
  body[data-theme="technical"] h2,
  body[data-theme="technical"] h3,
  body[data-theme="technical"] .doc-cover .eyebrow {
    font-family: "Cascadia Code", ui-monospace, Menlo, monospace;
  }
  body[data-theme="technical"] .doc-cover { border-bottom-style: double; border-bottom-width: 4px; }
  body[data-theme="technical"] h2 {
    background: var(--soft); padding: 5px 10px; border-bottom: none; border-left: 4px solid var(--accent);
  }
  body[data-theme="technical"] th, body[data-theme="technical"] td { border: 1px solid var(--accent); }
  body[data-theme="technical"] pre { border-color: var(--accent); }
`;

type PdfTheme = "report" | "article" | "technical";

/** Imprime HTML num iframe oculto (o webview oferece "Guardar como PDF"). */
function printHtml(bodyHtml: string, isFullDoc: boolean, title?: string, theme: PdfTheme = "report") {
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
  )}</title><style>${PRINT_CSS}</style></head><body data-theme="${theme}">${cover}${bodyHtml}</body></html>`;
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
    local_provider: wizBackend === "lmstudio" ? "openai" : "ollama",
    ollama_endpoint: wizInput("w_ollama_endpoint").value,
    ollama_model: wizInput("w_ollama_model").value,
    openai_local_endpoint:
      wizInput("w_oai_local_endpoint").value.trim() || "http://localhost:1234/v1",
    openai_local_model: wizInput("w_oai_local_model").value.trim(),
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
      t("Ollama ligado — {n} modelo(s)", { n: d.ollama_models.length }) +
      (d.ollama_model_present ? "" : t(" · modelo configurado não encontrado"));
    els.modelsList.innerHTML = d.ollama_models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join("");
  } else {
    o.className = "wiz-status bad";
    o.textContent = t("Ollama não detetado neste endpoint");
  }
  const c = document.querySelector("#wiz-claude-status")!;
  c.className = "wiz-status " + (d.claude_ready ? "ok" : "bad");
  c.textContent = d.claude_detail;
}

const WIZ_STEPS = 3;
let wizStep = 0;
let wizBackend: "ollama" | "lmstudio" = "ollama";

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

/** Caminho LM Studio do wizard: guarda as settings e lista os modelos carregados (sem diagnostics do Ollama). */
async function runWizardLmTest() {
  const next = mergeWizardSettings(state.settings!);
  try {
    await api.saveSettings(next);
    state.settings = next;
  } catch (e) {
    console.error(e);
  }
  await renderLmInstalled("#wiz-lm-installed", "#wiz-lm-status", (id) => {
    wizInput("w_oai_local_model").value = id;
    void runWizardLmTest();
  });
}

/** Alterna o backend do passo 1 (Ollama vs LM Studio): painéis + teste do escolhido. */
function setWizBackend(b: "ollama" | "lmstudio") {
  wizBackend = b;
  document
    .querySelectorAll<HTMLElement>("#wiz-backend .wiz-choice-opt")
    .forEach((el) => el.classList.toggle("active", el.dataset.backend === b));
  document.querySelector("#wiz-ollama-panel")?.toggleAttribute("hidden", b !== "ollama");
  document.querySelector("#wiz-lm-panel")?.toggleAttribute("hidden", b !== "lmstudio");
  if (wizStep === 1) {
    if (b === "ollama") {
      void runWizardTest();
      void renderRecommendation("#wiz-rec");
    } else {
      void runWizardLmTest();
    }
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
    // Passo do modelo: testa o backend escolhido (Ollama: diagnostics + recomendação; LM Studio: lista).
    if (wizBackend === "ollama") {
      void runWizardTest();
      void renderRecommendation("#wiz-rec");
    } else {
      void runWizardLmTest();
    }
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
  wizInput("w_oai_local_endpoint").value = s.openai_local_endpoint || "http://localhost:1234/v1";
  wizInput("w_oai_local_model").value = s.openai_local_model;
  document.querySelector<HTMLSelectElement>("#w_claude_mode")!.value = s.claude_mode;
  wizInput("w_claude_api_key").value = s.claude_api_key;
  document.querySelector("#wiz-key-wrap")!.toggleAttribute("hidden", s.claude_mode !== "api");
  setWizBackend(s.local_provider === "openai" ? "lmstudio" : "ollama");
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
    await tip("#composer", t("Escreve a tua pergunta aqui. Boa viagem!"), "top");
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
    awaitingPrompt = false;
    api.approveAction(id, ok).catch(() => {});
    card.remove();
  };
  card.querySelector('[data-ok="1"]')!.addEventListener("click", () => done(true));
  card.querySelector('[data-ok="0"]')!.addEventListener("click", () => done(false));
  els.messages.appendChild(card);
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** Cartão de esclarecimento (Plan mode): perguntas com campos de resposta + Responder/Saltar.
 * Saltar planeia na mesma com o que houver. */
function showClarifyCard(id: number, questions: string[]) {
  const card = document.createElement("div");
  card.className = "approval-card plan-card";
  card.innerHTML = `
    <div class="approval-head">${t("Antes de continuar — esclarece")}</div>
    <div class="plan-hint">${t("Responde ao que souberes; salta o resto.")}</div>
    <div class="clarify-list"></div>
    <div class="approval-bar">
      <button type="button" class="ghost" data-ok="0">${t("Saltar")}</button>
      <button type="button" class="primary" data-ok="1">${t("Responder")}</button>
    </div>`;
  const list = card.querySelector<HTMLDivElement>(".clarify-list")!;
  const inputs: HTMLTextAreaElement[] = [];
  for (const q of questions) {
    const row = document.createElement("div");
    row.className = "clarify-row";
    const label = document.createElement("div");
    label.className = "clarify-q";
    label.textContent = q;
    const ta = document.createElement("textarea");
    ta.className = "pe-input";
    ta.rows = 1;
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    };
    ta.addEventListener("input", grow);
    requestAnimationFrame(grow);
    inputs.push(ta);
    row.append(label, ta);
    list.appendChild(row);
  }
  const done = (answered: boolean) => {
    awaitingPrompt = false;
    const answers = inputs.map((i) => i.value.trim());
    api.respondClarify(id, answered, answered ? answers : []).catch(() => {});
    card.remove();
    renderMessages();
    scrollChatToBottom();
  };
  card.querySelector('[data-ok="1"]')!.addEventListener("click", () => done(true));
  card.querySelector('[data-ok="0"]')!.addEventListener("click", () => done(false));
  els.messages.appendChild(card);
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** Cartão de plano editável (Plan mode): textarea com 1 passo por linha + Aprovar/Rejeitar.
 * Quando o modelo sinaliza que precisa de dados atuais (`needsWeb`) e o 🔎 está desligado,
 * o cartão pede para escalar para pesquisa web (checkbox pré-marcada). */
function showPlanCard(
  id: number,
  steps: string[],
  assistant: Item,
  needsWeb: boolean,
  research: boolean,
) {
  const card = document.createElement("div");
  card.className = "approval-card plan-card";
  const askWeb = needsWeb && !research; // só pergunta se ainda não está fundamentado
  const webRow = askWeb
    ? `<label class="plan-web"><input type="checkbox" class="plan-web-cb" checked />` +
      `<span class="plan-web-ic">${icon("search")}</span>` +
      `<span>${t("Pesquisar na web durante a execução (recomendado)")}</span></label>`
    : "";
  card.innerHTML = `
    <div class="approval-head">${t("Plano — revê, edita e aprova")}</div>
    <div class="plan-hint">${t("Edita, remove ou adiciona passos antes de executar.")}</div>
    <div class="plan-editor"></div>
    <button type="button" class="pe-add">+ ${t("Adicionar passo")}</button>
    ${webRow}
    <div class="approval-bar">
      <button type="button" class="ghost" data-ok="0">${t("Rejeitar")}</button>
      <button type="button" class="primary" data-ok="1">${t("Aprovar e executar")}</button>
    </div>`;
  const editor = card.querySelector<HTMLDivElement>(".plan-editor")!;
  const webCb = card.querySelector<HTMLInputElement>(".plan-web-cb");

  // Renumera os marcadores «N» após adicionar/remover passos.
  const renumber = () =>
    editor.querySelectorAll<HTMLElement>(".pe-num").forEach((el, i) => (el.textContent = String(i + 1)));

  // Cria uma linha editável (número + input + remover). Enter adiciona um passo a seguir.
  const makeRow = (value: string): HTMLDivElement => {
    const rowEl = document.createElement("div");
    rowEl.className = "plan-edit-row";
    const num = document.createElement("span");
    num.className = "pe-num";
    const input = document.createElement("textarea");
    input.className = "pe-input";
    input.rows = 1;
    input.value = value;
    // Cresce para mostrar o passo inteiro; o CSS limita a altura (max-height → scroll).
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    input.addEventListener("input", grow);
    requestAnimationFrame(grow); // mede depois de estar no DOM
    input.addEventListener("keydown", (e) => {
      // Enter adiciona um passo a seguir; Shift+Enter insere uma quebra de linha.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const nr = makeRow("");
        rowEl.after(nr);
        renumber();
        nr.querySelector<HTMLTextAreaElement>(".pe-input")!.focus();
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pe-del";
    del.title = t("Remover passo");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      rowEl.remove();
      renumber();
    });
    rowEl.append(num, input, del);
    return rowEl;
  };
  steps.forEach((s) => editor.appendChild(makeRow(s)));
  renumber();

  card.querySelector(".pe-add")!.addEventListener("click", () => {
    const nr = makeRow("");
    editor.appendChild(nr);
    renumber();
    nr.querySelector<HTMLTextAreaElement>(".pe-input")!.focus();
  });

  const done = (ok: boolean) => {
    const edited = Array.from(editor.querySelectorAll<HTMLTextAreaElement>(".pe-input"))
      .map((i) => i.value.trim())
      .filter(Boolean);
    // Executa fundamentado se o 🔎 já estava ligado, ou se o utilizador aceitou a escalada.
    const useWeb = research || (askWeb && !!webCb?.checked);
    if (ok && edited.length) {
      // Guarda os passos na mensagem → render da checklist com estado durante a execução.
      assistant.plan = { steps: edited.map((title) => ({ title, status: "pending" })) };
    }
    awaitingPrompt = false;
    api.respondPlan(id, ok, edited, useWeb).catch(() => {});
    card.remove();
    renderMessages();
    scrollChatToBottom();
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
  wsEditorOpen(false);
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
          : idx.playbooks;
  const addLabel =
    wsKind === "skill"
      ? t("Nova skill")
      : wsKind === "playbook"
        ? t("Novo playbook")
        : wsKind === "workflow"
          ? t("Novo workflow")
          : t("Novo agente");
  const itemsHtml = items
    .map((it) => {
      const on = it.enabled;
      const toggleTitle = on ? t("Desativar") : t("Ativar");
      return `
    <div class="ws-item${on ? "" : " disabled"}">
      <label class="ws-item-toggle" title="${toggleTitle}" aria-label="${toggleTitle}"><input type="checkbox" data-toggle="${escapeHtml(it.name)}" ${on ? "checked" : ""} /></label>
      <div class="ws-item-main"><strong>${escapeHtml(it.name)}${it.topic ? ` <span class="ws-topic-badge" title="${t("Só no tópico")}: ${escapeHtml(it.topic)}">${escapeHtml(it.topic)}</span>` : ""}</strong><span>${escapeHtml(it.description)}</span></div>
      <div class="ws-item-actions">
        ${wsKind === "workflow" && on ? `<button type="button" class="ghost" data-run="${escapeHtml(it.name)}">${icon("play")}<span>${t("Correr")}</span></button>` : ""}
        <button type="button" class="ghost" data-edit="${escapeHtml(it.name)}">${t("Editar")}</button>
        <button type="button" class="icon-x" data-del="${escapeHtml(it.name)}" title="${t("Apagar")}" aria-label="${t("Apagar")}">${icon("x")}</button>
      </div>
    </div>`;
    })
    .join("");
  // Card "+" no fim da lista — substitui o antigo botão "+ Novo".
  const addCard = `<button type="button" class="ws-add-card" id="ws-add-card"><span class="ws-add-plus">+</span><span>${escapeHtml(addLabel)}</span></button>`;
  list.innerHTML = itemsHtml + addCard;
  list.querySelector("#ws-add-card")?.addEventListener("click", () => newWsDoc());
  list
    .querySelectorAll<HTMLButtonElement>("[data-edit]")
    .forEach((b) => b.addEventListener("click", () => editWsDoc(b.dataset.edit!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-del]")
    .forEach((b) => b.addEventListener("click", () => delWsDoc(b.dataset.del!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-run]")
    .forEach((b) => b.addEventListener("click", () => runWorkflow(b.dataset.run!)));
  list
    .querySelectorAll<HTMLInputElement>("[data-toggle]")
    .forEach((c) =>
      c.addEventListener("change", () => toggleWsDoc(c.dataset.toggle!, c.checked))
    );
}

/** Liga/desliga um item do Workspace (estado no frontmatter `enabled`). Reusa o pipeline do editor. */
async function toggleWsDoc(name: string, enabled: boolean) {
  try {
    const raw = await api.readWorkspaceDoc(wsKind, name);
    const f = parseDocFields(wsKind, raw);
    f.enabled = enabled;
    await api.saveWorkspaceDoc(wsKind, name, assembleDoc(wsKind, f));
  } catch (e) {
    await api.logFrontend("error", `toggleWsDoc ${name}: ${e}`);
  }
  renderWorkspaceList();
}

interface DocFields {
  name: string;
  desc: string;
  triggers: string;
  arghint: string;
  body: string;
  enabled: boolean;
  // Rota de execução do workflow (só para kind "workflow"): local (default) | claude.
  workflowRoute?: "local" | "claude";
  // Predefinições de agente (só para kind "agent").
  agentRoute?: "local" | "claude";
  agentTools?: boolean;
  agentResearch?: boolean;
  agentSubagents?: boolean;
  agentPlan?: boolean;
  agentThinkLevel?: ThinkLevel;
  agentModel?: string;
  topic?: string; // restringe o doc a um tópico ("" = global)
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
  wsq("#ws-workflow-route-wrap").toggleAttribute("hidden", !isWorkflow);
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
    // Ausente = ativo (retrocompatível); só false desativa.
    enabled: fm["enabled"] === undefined ? true : truthy(fm["enabled"]),
    workflowRoute: fm["route"] === "claude" ? "claude" : "local",
    agentRoute: fm["route"] === "claude" ? "claude" : "local",
    agentTools: truthy(fm["tools"]),
    agentResearch: truthy(fm["research"]),
    agentSubagents: truthy(fm["subagents"]),
    agentPlan: truthy(fm["plan"]),
    // `think` passou de bool para nível; retrocompatível: true→think, false/ausente→off.
    agentThinkLevel: ((): ThinkLevel => {
      const v = (fm["think"] ?? "").toString().trim().toLowerCase();
      if (v === "verify" || v === "debate" || v === "think") return v;
      return truthy(fm["think"]) ? "think" : "off";
    })(),
    agentModel: (fm["model"] ?? "").toString().trim(),
    topic: (fm["topic"] ?? "").toString().trim(),
  };
}

function assembleDoc(kind: WsKind, f: DocFields): string {
  // Só se escreve frontmatter (enabled/topic) quando preciso — mantém os ficheiros limpos.
  const disabled = f.enabled === false;
  const topic = (f.topic || "").trim();
  if (kind === "playbook") {
    const fm: string[] = [];
    if (disabled) fm.push("enabled: false");
    if (topic) fm.push(`topic: ${topic}`);
    return (fm.length ? `---\n${fm.join("\n")}\n---\n\n` : "") + f.body.trim() + "\n";
  }
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const lines = ["---", `name: ${f.name}`];
  if (disabled) lines.push("enabled: false");
  if (kind === "skill") {
    const d = f.triggers ? `${f.desc} Triggers: ${f.triggers}` : f.desc;
    lines.push(`description: "${esc(d)}"`);
  } else if (kind === "agent") {
    lines.push(
      `description: "${esc(f.desc)}"`,
      `tools: ${f.agentTools ? "true" : "false"}`,
      `research: ${f.agentResearch ? "true" : "false"}`,
      `subagents: ${f.agentSubagents ? "true" : "false"}`,
      `plan: ${f.agentPlan ? "true" : "false"}`,
      `think: ${f.agentThinkLevel || "off"}`,
      `route: ${f.agentRoute === "claude" ? "claude" : "local"}`
    );
    // Só escreve `model:` quando fixado (vazio = usa o modelo ativo).
    if (f.agentModel && f.agentModel.trim()) {
      lines.push(`model: ${f.agentModel.trim()}`);
    }
  } else {
    lines.push(
      `description: "${esc(f.desc)}"`,
      `argument-hint: ${f.arghint}`,
      `route: ${f.workflowRoute === "claude" ? "claude" : "local"}`
    );
  }
  if (topic) lines.push(`topic: ${topic}`);
  lines.push("---", "", f.body.trim(), "");
  return lines.join("\n");
}

function fillEditorFields(f: Partial<DocFields>) {
  wsq<HTMLInputElement>("#ws-desc").value = f.desc || "";
  wsq<HTMLInputElement>("#ws-triggers").value = f.triggers || "";
  wsq<HTMLInputElement>("#ws-arghint").value = f.arghint || "";
  wsq<HTMLTextAreaElement>("#ws-content").value = f.body || "";
  wsq<HTMLSelectElement>("#ws-workflow-route").value = f.workflowRoute || "local";
  wsq<HTMLSelectElement>("#ws-agent-route").value = f.agentRoute || "local";
  wsq<HTMLInputElement>("#ws-agent-tools").checked = !!f.agentTools;
  wsq<HTMLInputElement>("#ws-agent-research").checked = !!f.agentResearch;
  wsq<HTMLInputElement>("#ws-agent-subagents").checked = !!f.agentSubagents;
  wsq<HTMLInputElement>("#ws-agent-plan").checked = !!f.agentPlan;
  wsq<HTMLSelectElement>("#ws-agent-think-level").value = f.agentThinkLevel || "off";
  wsq<HTMLInputElement>("#ws-agent-model").value = f.agentModel || "";
  // Tópico: (todos) + os tópicos existentes (+ o atual se já não existir, para não o perder).
  const topicSel = wsq<HTMLSelectElement>("#ws-topic");
  const cur = (f.topic || "").trim();
  let opts = `<option value="">${t("(todos os tópicos)")}</option>`;
  for (const tp of state.topics) opts += `<option value="${escapeHtml(tp.name)}">${escapeHtml(tp.name)}</option>`;
  if (cur && !state.topics.some((tp) => tp.name.toLowerCase() === cur.toLowerCase())) {
    opts += `<option value="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`;
  }
  topicSel.innerHTML = opts;
  topicSel.value = cur;
}

// Estado ativo/inativo do doc em edição — preservado no save (o toggle vive na lista, não no editor).
let wsEditingEnabled = true;

function readEditorFields(): DocFields {
  return {
    name: wsq<HTMLInputElement>("#ws-name").value.trim(),
    desc: wsq<HTMLInputElement>("#ws-desc").value.trim(),
    triggers: wsq<HTMLInputElement>("#ws-triggers").value.trim(),
    arghint: wsq<HTMLInputElement>("#ws-arghint").value.trim(),
    body: wsq<HTMLTextAreaElement>("#ws-content").value,
    enabled: wsEditingEnabled,
    workflowRoute:
      wsq<HTMLSelectElement>("#ws-workflow-route").value === "claude" ? "claude" : "local",
    agentRoute: wsq<HTMLSelectElement>("#ws-agent-route").value === "claude" ? "claude" : "local",
    agentTools: wsq<HTMLInputElement>("#ws-agent-tools").checked,
    agentResearch: wsq<HTMLInputElement>("#ws-agent-research").checked,
    agentSubagents: wsq<HTMLInputElement>("#ws-agent-subagents").checked,
    agentPlan: wsq<HTMLInputElement>("#ws-agent-plan").checked,
    agentThinkLevel: wsq<HTMLSelectElement>("#ws-agent-think-level").value as ThinkLevel,
    agentModel: wsq<HTMLInputElement>("#ws-agent-model").value.trim(),
    topic: wsq<HTMLSelectElement>("#ws-topic").value.trim(),
  };
}

/** Alterna entre a LISTA (cards + card "+") e o EDITOR. A editar mostra só o editor (com Cancelar/Guardar);
 * caso contrário, a lista. Fechar o diálogo é o X no cabeçalho. */
function wsEditorOpen(open: boolean) {
  document.querySelector("#ws-editor")?.toggleAttribute("hidden", !open);
  document.querySelector("#ws-list")?.toggleAttribute("hidden", open);
  // A opção "Usar Claude" só aparece se o cloud estiver configurado (senão é sempre local).
  if (open) {
    document.querySelector("#ws-gen-cloud-wrap")?.toggleAttribute("hidden", !cloudEnabled());
  }
}

function newWsDoc() {
  wsEditingEnabled = true;
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
  wsEditorOpen(true);
}

async function editWsDoc(name: string) {
  try {
    const content = await api.readWorkspaceDoc(wsKind, name);
    const nameEl = wsq<HTMLInputElement>("#ws-name");
    nameEl.value = name;
    nameEl.readOnly = true;
    const f = parseDocFields(wsKind, content);
    wsEditingEnabled = f.enabled;
    fillEditorFields(f);
    wsq<HTMLTextAreaElement>("#ws-gen-prompt").value = "";
    wsq("#ws-gen-status").textContent = "";
    applyDocKindFields();
    wsEditorOpen(true);
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
  const useCloud = wsq<HTMLInputElement>("#ws-gen-cloud").checked;
  status.textContent = useCloud ? t("A gerar (Claude)…") : t("A gerar…");
  try {
    const md = await api.generateDoc(wsKind, prompt, useCloud);
    const f = parseDocFields(wsKind, md);
    const nameEl = wsq<HTMLInputElement>("#ws-name");
    if (f.name && !nameEl.value.trim()) nameEl.value = f.name;
    fillEditorFields(f);
    applyDocKindFields();
    status.textContent = t("Gerado — revê e guarda");
  } catch (e) {
    status.textContent = "" +e;
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
    wsEditorOpen(false);
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
        <button type="button" class="icon-x" data-del="${i}" title="${t("Apagar")}" aria-label="${t("Apagar")}">${icon("x")}</button>
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
    status.textContent = t("{n} ferramentas: {list}", {
      n: tools.length,
      list: tools.join(", ") || t("(nenhuma)"),
    });
  } catch (e) {
    status.textContent = "" +e;
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
    list.innerHTML = `<div class="empty-sm">${t("Sem ações registadas nesta Saga.")}<br><span class="muted-sm">${t("As automações registam-se na Saga “Automações”.")}</span></div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (r) => `
    <div class="act-row status-${escapeHtml(r.status.toLowerCase())}" title="${t("Clicar para expandir")}">
      <span class="act-status">${escapeHtml(r.status)}</span>
      <span class="act-tool">${escapeHtml(r.tool)}</span>
      <span class="act-detail">${escapeHtml(r.error || r.detail || r.params_json)}</span>
      <span class="act-time">${escapeHtml(r.created_at)}</span>
    </div>`
    )
    .join("");
  list
    .querySelectorAll<HTMLElement>(".act-row")
    .forEach((r) => r.addEventListener("click", () => r.classList.toggle("expanded")));
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
  (document.querySelector("#sched-model") as HTMLInputElement).value = "";
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
  const statusCls = (st: string) =>
    st === "OK" ? "ok" : st === "ERRO" ? "err" : "muted";
  list.innerHTML = rows
    .map((s) => {
      const last = s.last_status
        ? `<div class="sched-last"><span class="sched-status ${statusCls(s.last_status)}">${escapeHtml(s.last_status)}</span>${s.last_error ? " " + escapeHtml(s.last_error) : ""}</div>`
        : "";
      return `
    <div class="mcp-item">
      <div class="sched-main">
        <label class="check"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} /> <strong>${escapeHtml(s.name)}</strong></label>
        <code>${escapeHtml(s.workflow_name)} · ${escapeHtml(s.cron)} · ${t("próx:")} ${escapeHtml(fmtEpoch(s.next_run_epoch))}</code>
        ${last}
      </div>
      <div class="mcp-item-actions">
        <button type="button" class="ghost" data-run="${s.id}" title="${t("Correr agora")}" aria-label="${t("Correr agora")}">${icon("play")}</button>
        <button type="button" class="ghost" data-edit="${s.id}">${t("Editar")}</button>
        <button type="button" class="icon-x" data-del="${s.id}" title="${t("Apagar")}" aria-label="${t("Apagar")}">${icon("x")}</button>
      </div>
    </div>`;
    })
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
  (document.querySelector("#sched-model") as HTMLInputElement).value = s.model || "";
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
  const model = (document.querySelector("#sched-model") as HTMLInputElement).value.trim();
  const cron = (document.querySelector("#sched-cron") as HTMLInputElement).value.trim();
  const enabled = (document.querySelector("#sched-enabled") as HTMLInputElement).checked;
  const status = document.querySelector("#sched-status")!;
  if (!name || !workflow || !cron) {
    status.textContent = t("Nome, workflow e cron são obrigatórios.");
    return;
  }
  try {
    if (schedEditingId !== null) {
      await api.updateSchedule(schedEditingId, name, workflow, args, cron, enabled, model);
    } else {
      await api.createSchedule(name, workflow, args, cron, enabled, model);
    }
    clearSchedForm();
    await renderSchedules();
  } catch (e) {
    status.textContent = t("Falha: ") + e;
  }
}

async function toggleSchedule(s: Schedule, enabled: boolean) {
  try {
    await api.updateSchedule(s.id, s.name, s.workflow_name, s.arguments, s.cron, enabled, s.model);
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
  void renderInstalled();
  showView("models");
  void renderHubStatus();
  void renderRecommendation();
}

/** Guia "qual escolher": escolhe pela VRAM da placa gráfica (ou RAM se não houver GPU). */
const PICK_TIERS: { hw: string; model: string; note: string }[] = [
  { hw: "Máquina fraca ou sem GPU", model: "llama3.2:3b", note: "leve — corre em quase qualquer máquina" },
  { hw: "Sem GPU (CPU) ou GPU pequena (~8 GB)", model: "qwen3:8b", note: "rápido e com ferramentas/web" },
  { hw: "GPU média (~12 GB)", model: "gemma4:12b", note: "multimodal: lê imagens, ferramentas e raciocínio" },
  { hw: "GPU grande (16 GB+)", model: "gemma4:26b-a4b-it-qat", note: "MoE rápido e multimodal (ou qwen3:32b)" },
];

/** Secção de recomendação para quem não sabe que modelo escolher. */
async function renderRecommendation(targetSel = "#hub-rec") {
  const box = document.querySelector<HTMLElement>(targetSel)!;
  if (!box) return;
  box.hidden = false;
  let machine = "";
  try {
    const info = await api.systemInfo();
    const vram = info.total_vram_gb > 0 ? ` · ${info.total_vram_gb} GB VRAM` : "";
    machine =
      `<div class="hub-rec-line">${t("A tua máquina")}: ${info.total_ram_gb} GB RAM${vram} · ${info.cpu_cores} cores — ` +
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
  // O modelo de visão de recurso é definido na lista de instalados (toggle 👁), não num campo aqui.
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
  hubSel("#hub-clarify-level").value = s.clarify_level || "light";
  // Estado da clarificação semântica (L2): mostra o modelo de embeddings detetado, ou como ativá-la.
  api
    .detectEmbedModel()
    .then((m) => {
      const el = document.querySelector("#hub-clarify-l2");
      if (el)
        el.textContent = m
          ? t("Clarificação semântica (L2) ativa via {m}.", { m })
          : t("Para clarificação mais precisa, instala um modelo de embeddings (ex.: nomic-embed-text) no separador Modelos — sem ele, usa só heurística.");
    })
    .catch(() => {});
  hubSel("#hub-web-provider").value = s.web_search_provider;
  applyWebProviderUi(true);
  hubIn("#hub-num-ctx").value = String(s.ollama_num_ctx);
  hubIn("#hub-temp").value = String(s.ollama_temperature);
  hubIn("#hub-temp-auto").checked = s.ollama_temperature_auto;
  document.querySelector("#hub-temp-wrap")!.toggleAttribute("hidden", s.ollama_temperature_auto);
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
    hint.textContent = t("DuckDuckGo não precisa de chave e funciona logo; tem limites de ritmo (pode falhar em rajadas). Para mais fiabilidade/volume, escolhe um motor com chave.");
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
  document.querySelector("#hub-openai-local-fields")!.toggleAttribute("hidden", lp !== "openai");
  // O navegador "Instalar (Ollama)" só faz sentido com o Ollama ativo.
  document.querySelector("#hub-install")!.toggleAttribute("hidden", lp !== "ollama");
  if (lp === "openai") void renderLmInstalled(); // lista de descarregados do LM Studio
  document.querySelector("#hub-claude-fields")!.toggleAttribute("hidden", cp !== "claude");
  document.querySelector("#hub-openai-cloud-fields")!.toggleAttribute("hidden", cp !== "openai");
  // Descobrir modelos pela CLI só faz sentido em modo CLI/subscrição (a API tem chave própria).
  const isClaudeCli = cp === "claude" && hubSel("#hub-claude-mode").value === "cli";
  document.querySelector("#hub-claude-refresh-models")!.toggleAttribute("hidden", !isClaudeCli);
  const hint = document.querySelector<HTMLElement>("#hub-claude-refresh-hint")!;
  if (isClaudeCli) {
    hint.hidden = false;
    void primeClaudeRefreshHint();
  } else {
    hint.hidden = true;
  }
}

/** Mostra a pasta scratch (para o utilizador a confiar manualmente uma vez) antes do 1.º refresh. */
let claudeScratchDirCache: string | null = null;
async function primeClaudeRefreshHint() {
  const hint = document.querySelector<HTMLElement>("#hub-claude-refresh-hint")!;
  if (hint.dataset.state === "result" || hint.dataset.state === "busy") return; // não pisar um resultado/estado em curso
  try {
    if (!claudeScratchDirCache) claudeScratchDirCache = await api.claudeCliModelsScratchDir();
    hint.textContent = t(
      "Descobre os modelos correndo a tua sessão da CLI (subscrição). 1.ª vez: corre `claude` num terminal normal na pasta {p} e aceita o diálogo de confiança — o Saga nunca responde a esse diálogo por ti.",
      { p: claudeScratchDirCache }
    );
  } catch {
    hint.textContent = "";
  }
}

async function refreshClaudeCliModels() {
  const btn = document.querySelector<HTMLButtonElement>("#hub-claude-refresh-models")!;
  const hint = document.querySelector<HTMLElement>("#hub-claude-refresh-hint")!;
  btn.disabled = true;
  hint.dataset.state = "busy";
  hint.textContent = t("A correr o Claude CLI para descobrir modelos… (até 20s)");
  try {
    const r: ClaudeCliModelsResult = await api.refreshClaudeCliModels();
    hint.dataset.state = "result";
    if (r.models.length) {
      hint.textContent = t(
        "Encontrado(s): {m} — confirma o ID exato antes de usar (o menu da CLI pode mostrar nomes amigáveis, não o ID da API); cola o valor certo em \"Personalizado…\".",
        { m: r.models.join(", ") }
      );
    } else {
      hint.textContent = t(
        "Não consegui reconhecer modelos na resposta. Saída bruta nos logs do Saga (Definições → Diagnóstico → Abrir logs)."
      );
      void api.logFrontend("warn", `[claude-cli-models] saída não reconhecida:\n${r.raw}`);
    }
  } catch (e) {
    hint.dataset.state = "result";
    hint.textContent = String(e);
  } finally {
    btn.disabled = false;
  }
}

async function saveModelsSettings(patch: Partial<Settings>) {
  if (!state.settings) return;
  const updated = { ...state.settings, ...patch };
  await api.saveSettings(updated);
  state.settings = updated;
  applyComposerToggles();
  warmLocalModel(); // modelo/endpoint pode ter mudado → aquece o novo
}

async function hubSave() {
  const presetVal = hubSel("#hub-claude-preset").value;
  const claudeModel =
    presetVal === "__custom__" ? hubIn("#hub-claude-model").value.trim() : presetVal;
  try {
    await saveModelsSettings({
      local_provider: hubSel("#hub-local-provider").value as Settings["local_provider"],
      ollama_endpoint: hubIn("#hub-ollama-endpoint").value.trim(),
      // ollama_vision_model é definido na lista de instalados (toggle 👁), não aqui.
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
      clarify_level: hubSel("#hub-clarify-level").value as Settings["clarify_level"],
      web_search_provider: hubSel("#hub-web-provider").value as Settings["web_search_provider"],
      web_search_keys: webSearchKeysPatch(),
      ollama_num_ctx: Math.max(2048, parseInt(hubIn("#hub-num-ctx").value) || 8192),
      ollama_temperature: Math.min(1.5, Math.max(0, parseFloat(hubIn("#hub-temp").value) || 0.4)),
      ollama_temperature_auto: hubIn("#hub-temp-auto").checked,
      memory_dir: hubIn("#hub-memory-dir").value,
      claude_md_path: hubIn("#hub-claude-md").value,
      workspace_dir: hubIn("#hub-workspace-dir").value,
      confirm_mode: hubSel("#hub-confirm-mode").value as Settings["confirm_mode"],
      enable_browser_tools: hubIn("#hub-browser-tools").checked,
      browser_sidecar_script: hubIn("#hub-browser-sidecar").value,
      browser_node_path: hubIn("#hub-browser-node").value,
      browser_user_data_dir: hubIn("#hub-browser-data").value,
    });
    document.querySelector("#hub-status")!.textContent = t("Guardado");
    void renderHubStatus();
    // Feedback junto ao botão (o #hub-status fica no topo, fora de vista depois do scroll).
    const saveBtn = document.querySelector<HTMLButtonElement>("#hub-save")!;
    saveBtn.innerHTML = `${icon("check")}${t("Guardado")}`;
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.textContent = t("Guardar");
    }, 1600);
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
      t("'{m}' não chama ferramentas — a pesquisa web não funciona; usa um modelo com ferramentas (ex.: qwen3, llama3.1).", {
        m: active,
      });
  } else if (isOllama && isWeakModel(active)) {
    warn =
      " " +
      t("'{m}' é pequeno — respostas e pesquisa web podem falhar; experimenta llama3.1 ou qwen2.5.", {
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
  // alimenta o datalist partilhado (#ollama-models) + cache (A/B no chat / autocomplete do agente)
  els.modelsList.innerHTML = models.map((m) => `<option value="${escapeHtml(m.name)}"></option>`).join("");
  localModelsCache = models.map((m) => m.name);
  // Aviso: nenhum modelo instalado lê imagens → não dá para anexar imagens com nenhum.
  const anyVision = models.some((m) => modelCapabilities(m.name).vision);
  document.querySelector("#hub-vision-warn")?.toggleAttribute("hidden", models.length === 0 || anyVision);
  if (models.length === 0) {
    list.innerHTML = `<div class="empty-sm">${t("Sem modelos. Instala um acima.")}</div>`;
    return;
  }
  const active = state.settings?.ollama_model;
  const vision = state.settings?.ollama_vision_model?.trim() ?? "";
  list.innerHTML = models
    .map((m) => {
      // Toggle de visão (👁) só em modelos que veem: marca qual é o modelo de visão de recurso.
      const visionToggle = modelCapabilities(m.name).vision
        ? `<button type="button" class="vision-toggle${m.name === vision ? " on" : ""}" data-vision="${escapeHtml(m.name)}" title="${m.name === vision ? t("Modelo de visão atual (clica para remover)") : t("Usar como modelo de visão")}" aria-label="${t("Usar como modelo de visão")}">${icon("eye")}</button>`
        : "";
      return `
    <div class="model-item${m.name === active ? " active" : ""}">
      <div class="model-main">
        <strong>${escapeHtml(m.name)} <span class="qp-caps">${capBadges(m.name)}</span></strong>
        <span>${escapeHtml([m.parameter_size, fmtSize(m.size), m.quantization].filter(Boolean).join(" · "))}</span>
      </div>
      <div class="model-actions">
        ${m.name === active ? `<span class="model-badge">${t("ativo")}</span>` : `<button type="button" class="ghost" data-activate="${escapeHtml(m.name)}">${t("Ativar")}</button>`}
        ${visionToggle}
        <button type="button" class="icon-x" data-del="${escapeHtml(m.name)}" title="${t("Apagar")}" aria-label="${t("Apagar")}">${icon("x")}</button>
      </div>
    </div>`;
    })
    .join("");
  list
    .querySelectorAll<HTMLButtonElement>("[data-activate]")
    .forEach((b) => b.addEventListener("click", () => setActiveModel(b.dataset.activate!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-vision]")
    .forEach((b) => b.addEventListener("click", () => setVisionModel(b.dataset.vision!)));
  list
    .querySelectorAll<HTMLButtonElement>("[data-del]")
    .forEach((b) => b.addEventListener("click", () => deleteModelUi(b.dataset.del!)));
}

async function setActiveModel(name: string) {
  await saveModelsSettings({ ollama_model: name, local_provider: "ollama" });
  await renderInstalled();
}

/** Define (ou remove, se já for) o modelo de visão de recurso a partir da lista de instalados. */
async function setVisionModel(name: string) {
  const current = state.settings?.ollama_vision_model?.trim() ?? "";
  await saveModelsSettings({ ollama_vision_model: current === name ? "" : name });
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

let modelSearchTimer: number | undefined;
/** Caixa de pesquisa do registo do Ollama (ollama.com). */
function wireModelSearch() {
  const box = document.querySelector<HTMLInputElement>("#hub-search");
  const results = document.querySelector<HTMLElement>("#hub-search-results");
  if (!box || !results) return;
  box.addEventListener("input", () => {
    const q = box.value.trim();
    if (modelSearchTimer) clearTimeout(modelSearchTimer);
    if (!q) {
      renderQuickPicks();
      return;
    }
    results.innerHTML = `<div class="reg-loading">${t("A procurar…")}</div>`;
    modelSearchTimer = window.setTimeout(async () => {
      try {
        renderRegistryResults(await api.searchOllamaRegistry(q));
      } catch {
        results.innerHTML = `<div class="empty-sm">${t("Não foi possível contactar o ollama.com.")}</div>`;
      }
    }, 300);
  });
}

/** Liga os botões "Tamanhos" (expandir) e os pills de instalação dentro de um contentor de cartões. */
function wireModelCards(box: HTMLElement) {
  box.querySelectorAll<HTMLButtonElement>("[data-expand]").forEach((b) =>
    b.addEventListener("click", () => {
      const sizes = b.closest(".reg-card")?.querySelector(".reg-card-sizes");
      sizes?.toggleAttribute("hidden");
      b.classList.toggle("open", !sizes?.hasAttribute("hidden"));
    })
  );
  box
    .querySelectorAll<HTMLButtonElement>("[data-pull]")
    .forEach((b) => b.addEventListener("click", () => pullModelUi(b.dataset.pull!, b.dataset.size)));
  // "Todas as variantes": lazy-fetch da lista completa de tags (com tamanhos), cache por cartão.
  box.querySelectorAll<HTMLButtonElement>("[data-all-tags]").forEach((b) =>
    b.addEventListener("click", async () => {
      const model = b.dataset.allTags!;
      const list = b.closest(".reg-card")?.querySelector<HTMLElement>(".reg-tag-list");
      if (!list) return;
      if (list.dataset.loaded === "1") {
        list.toggleAttribute("hidden");
        b.classList.toggle("open", !list.hasAttribute("hidden"));
        return;
      }
      list.hidden = false;
      b.classList.add("open");
      list.innerHTML = `<div class="reg-loading">${t("A carregar…")}</div>`;
      try {
        const tags = await api.ollamaRegistryTags(model);
        if (!tags.length) {
          list.innerHTML = `<div class="empty-sm">${t("Sem variantes.")}</div>`;
          return;
        }
        list.innerHTML = tags
          .map((tg) => {
            const meta = [tg.size || "—", tg.context].filter(Boolean).join(" · ");
            return `<div class="reg-tag-row">
              <span class="reg-tag-name">${escapeHtml(tg.name)}</span>
              <span class="reg-tag-meta">${escapeHtml(meta)}</span>
              <button type="button" class="size-pill" data-pull="${escapeHtml(tg.name)}" data-size="${escapeHtml(tg.size || "")}">${icon("download")}<span>${t("Instalar")}</span></button>
            </div>`;
          })
          .join("");
        list.dataset.loaded = "1";
        list
          .querySelectorAll<HTMLButtonElement>("[data-pull]")
          .forEach((p) => p.addEventListener("click", () => pullModelUi(p.dataset.pull!, p.dataset.size)));
      } catch {
        list.innerHTML = `<div class="empty-sm">${t("Não foi possível obter as variantes.")}</div>`;
      }
    })
  );
}

/** Cartão de modelo do ollama.com (estilo navegador): nome + caps, descrição, métricas e tamanhos. */
function ollamaCard(m: RegistryModel): string {
  const meta = [m.pulls ? `${escapeHtml(m.pulls)} ↓` : "", escapeHtml(m.updated)]
    .filter(Boolean)
    .join(" · ");
  const pills = (m.sizes.length ? m.sizes : [""])
    .map((s) => {
      const tag = s ? `${escapeHtml(m.name)}:${escapeHtml(s)}` : escapeHtml(m.name);
      const label = s ? escapeHtml(s) : t("Instalar");
      return `<button type="button" class="size-pill" data-pull="${tag}">${icon("download")}<span>${label}</span></button>`;
    })
    .join("");
  return `<div class="reg-card">
    <div class="reg-card-top">
      <div class="reg-id">
        <a class="reg-name" href="https://ollama.com/library/${escapeHtml(m.name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.name)}</a>
        <span class="qp-caps">${regCapBadges(m.capabilities)}</span>
      </div>
      <button type="button" class="reg-sizes-btn" data-expand>${icon("download")}<span>${t("Tamanhos")}</span></button>
    </div>
    ${m.description ? `<div class="reg-desc">${escapeHtml(m.description)}</div>` : ""}
    ${meta ? `<div class="reg-metrics">${meta}</div>` : ""}
    <div class="reg-card-sizes" hidden>
      <div class="reg-sizes-label">${t("Clica num tamanho para instalar:")}</div>
      <div class="reg-sizes">${pills}</div>
      <button type="button" class="reg-all-btn" data-all-tags="${escapeHtml(m.name)}">${t("Todas as variantes")}</button>
      <div class="reg-tag-list" hidden></div>
    </div>
  </div>`;
}

/** Render dos resultados de pesquisa do ollama.com (cartões; 1.º expandido). */
function renderRegistryResults(models: RegistryModel[]) {
  const box = document.querySelector<HTMLElement>("#hub-search-results")!;
  if (!models.length) {
    box.innerHTML = `<div class="empty-sm">${t("Sem resultados.")}</div>`;
    return;
  }
  box.innerHTML = models.map(ollamaCard).join("");
  wireModelCards(box);
  // Auto-expande o 1.º cartão (como o Job Radar).
  const first = box.querySelector(".reg-card-sizes");
  first?.removeAttribute("hidden");
  box.querySelector<HTMLElement>(".reg-sizes-btn")?.classList.add("open");
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
async function renderLmInstalled(
  listSel = "#hub-lm-installed",
  statusSel = "#hub-lm-status",
  onPick?: (id: string) => void
) {
  const list = document.querySelector<HTMLDivElement>(listSel);
  const status = document.querySelector<HTMLElement>(statusSel);
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
  list.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((b) =>
    b.addEventListener("click", () => {
      if (onPick) onPick(b.dataset.use!);
      else void setActiveLmModel(b.dataset.use!);
    })
  );
}

/** Badges de capacidade (tools · visão · raciocínio) com tooltip. */
function capBadges(name: string): string {
  const c = modelCapabilities(name);
  const parts: string[] = [];
  if (c.tools) parts.push(`<span class="cap" title="${t("Ferramentas / pesquisa web")}">${icon("tool")}</span>`);
  if (c.vision) parts.push(`<span class="cap" title="${t("Visão (imagens)")}">${icon("eye")}</span>`);
  if (c.reasoning) parts.push(`<span class="cap" title="${t("Raciocínio")}">${icon("brain")}</span>`);
  return parts.join("");
}

/** Estado vazio do Ollama: catálogo curado em cartões compactos, agrupado por uso. */
function renderQuickPicks() {
  const box = document.querySelector<HTMLDivElement>("#hub-search-results")!;
  box.innerHTML =
    `<div class="catalog-legend">${icon("tool")} ${t("ferramentas/web")} · ${icon("eye")} ${t("visão")} · ${icon("brain")} ${t("raciocínio")}</div>` +
    MODEL_CATALOG.map(
      (g) =>
        `<div class="catalog-group">${escapeHtml(t(g.group))}</div>` +
        g.models
          .map((m) => {
            const base = escapeHtml(m.name.split(":")[0]); // base p/ "Todas as variantes"
            return `<div class="reg-card compact">
                <div class="reg-card-top">
                  <div class="reg-id">
                    <span class="reg-name plain">${escapeHtml(m.name)}</span>
                    <span class="qp-size">${m.size}</span>
                    <span class="qp-caps">${capBadges(m.name)}</span>
                  </div>
                  <button type="button" class="size-pill" data-pull="${escapeHtml(m.name)}">${icon("download")}<span>${t("Instalar")}</span></button>
                </div>
                <button type="button" class="reg-all-btn" data-all-tags="${base}">${t("Todas as variantes")}</button>
                <div class="reg-tag-list" hidden></div>
              </div>`;
          })
          .join("")
    ).join("");
  wireModelCards(box);
}

/** Comandos para ativar as otimizações do servidor Ollama, consoante o SO. */
function ollamaOptCommands(): string {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) {
    return [
      "setx OLLAMA_FLASH_ATTENTION 1",
      "setx OLLAMA_KV_CACHE_TYPE q8_0",
      "setx OLLAMA_KEEP_ALIVE 30m",
      ":: depois fecha o Ollama (tray) e abre de novo",
    ].join("\n");
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return [
      "launchctl setenv OLLAMA_FLASH_ATTENTION 1",
      "launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0",
      "launchctl setenv OLLAMA_KEEP_ALIVE 30m",
      "# depois reinicia a app do Ollama",
    ].join("\n");
  }
  return [
    "# sudo systemctl edit ollama   →   [Service]",
    'Environment="OLLAMA_FLASH_ATTENTION=1"',
    'Environment="OLLAMA_KV_CACHE_TYPE=q8_0"',
    'Environment="OLLAMA_KEEP_ALIVE=30m"',
    "# depois: sudo systemctl restart ollama",
  ].join("\n");
}

// ---- Aviso de recursos ao instalar (não bloqueia) ----
let sysInfoCache: import("./api").SystemInfo | null = null;
async function getSysInfo() {
  if (!sysInfoCache) {
    try {
      sysInfoCache = await api.systemInfo();
    } catch {
      return null;
    }
  }
  return sysInfoCache;
}

/** "16 GB" / "4.7GB" / "820 MB" → GB (number); 0 se não der. */
function parseSizeGb(s?: string): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([gm])b/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === "m" ? n / 1024 : n;
}

/** Estima o tamanho em disco/memória a partir da contagem de parâmetros no nome (Q4 ≈ 0.65 GB/B). */
function estimateSizeGb(name: string): number {
  const m = name.match(/[:\-](\d+(?:\.\d+)?)\s*b\b/i);
  if (!m) return 0;
  return parseFloat(m[1]) * 0.65;
}

/** Compara o tamanho do modelo com VRAM/RAM e devolve um aviso (ou null se couber). */
function resourceWarning(info: import("./api").SystemInfo, needGb: number): string | null {
  if (needGb <= 0) return null;
  const sz = `~${needGb.toFixed(needGb < 10 ? 1 : 0)} GB`;
  if (info.total_ram_gb > 0 && needGb > info.total_ram_gb) {
    return t("{sz} pode exceder a RAM ({ram} GB) — a instalação prossegue, mas o modelo pode não correr.", {
      sz,
      ram: String(info.total_ram_gb),
    });
  }
  if (info.total_vram_gb > 0 && needGb > info.total_vram_gb * 0.9) {
    return t("{sz} excede a VRAM ({vram} GB) — corre na CPU/RAM, mais lento. A instalação prossegue.", {
      sz,
      vram: String(info.total_vram_gb),
    });
  }
  return null;
}

async function pullModelUi(name: string, sizeStr?: string) {
  name = name.trim();
  if (!name) return;
  // Aviso de recursos não-bloqueante (cabe na VRAM? na RAM?).
  void getSysInfo().then((info) => {
    if (!info) return;
    const need = parseSizeGb(sizeStr) || estimateSizeGb(name);
    const warn = resourceWarning(info, need);
    if (warn) showHint(warn);
  });
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
        label.textContent = `${name} ${t("descarregado")}`;
        void renderInstalled();
        void renderHubStatus();
        // Acabou de instalar: se for o modelo ativo, aquece-o já (1.ª conversa sem cold-start).
        if (name === state.settings?.ollama_model) warmLocalModel(name, true);
        hideSoon(2500);
      } else {
        label.textContent = "" +ev.message;
        hideSoon(5000);
      }
    });
  } catch (e) {
    label.textContent = "" +e;
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

// ---- Gavetas em ecrã estreito (painel/lista flutuam por cima do chat) ----
const mqPanelDrawer = window.matchMedia("(max-width: 1080px)");
const mqSidebarDrawer = window.matchMedia("(max-width: 840px)");
function closeDrawers() {
  els.layout.classList.remove("drawer-panel", "drawer-sidebar");
}
/** Alterna uma gaveta; só uma fica aberta de cada vez. */
function toggleDrawer(name: "panel" | "sidebar") {
  const cls = `drawer-${name}`;
  const open = els.layout.classList.contains(cls);
  closeDrawers();
  els.layout.classList.toggle(cls, !open);
}

/** Mostra uma vista no centro (ou o chat, se null/"sagas"). */
function showView(view: string | null) {
  closeDrawers(); // mudar de vista fecha qualquer gaveta aberta
  const inView = view !== null && view !== "sagas";
  for (const [name, el] of Object.entries(CENTER_VIEWS)) el.open = name === view;
  const chat = document.querySelector<HTMLElement>(".chat")!;
  chat.hidden = inView;
  // A lista de conversas e o painel de tokens (por Saga) só fazem sentido nas Sagas.
  els.layout.classList.toggle("viewing", inView);
  // O botão do painel (topbar) só faz sentido nas Sagas (nas vistas do rail o painel não aparece).
  document.querySelector("#btn-panel")?.toggleAttribute("hidden", inView);
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
  document.querySelector("#ws-save")!.addEventListener("click", saveWsDoc);
  document.querySelector("#ws-gen-btn")!.addEventListener("click", genWsDoc);
  document.querySelector("#ws-cancel")!.addEventListener("click", () => wsEditorOpen(false));
  document.querySelector("#ws-x")!.addEventListener("click", () => showView(null));

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
  document.querySelector("#hub-claude-mode")!.addEventListener("change", applyHubProviderFields);
  document
    .querySelector("#hub-claude-refresh-models")!
    .addEventListener("click", () => void refreshClaudeCliModels());
  document.querySelector("#hub-web-provider")!.addEventListener("change", () => applyWebProviderUi(true));
  document.querySelector("#hub-claude-preset")!.addEventListener("change", () => {
    const v = hubSel("#hub-claude-preset").value;
    document.querySelector("#hub-claude-custom-wrap")!.toggleAttribute("hidden", v !== "__custom__");
    if (v !== "__custom__") hubIn("#hub-claude-model").value = v;
  });
  wireModelSearch();
  document.querySelector("#hub-lm-refresh")!.addEventListener("click", () => void renderLmInstalled());
  document.querySelector("#hub-temp-auto")!.addEventListener("change", (e) => {
    const auto = (e.target as HTMLInputElement).checked;
    document.querySelector("#hub-temp-wrap")!.toggleAttribute("hidden", auto);
  });
  const copyOptCmds = () => {
    navigator.clipboard?.writeText(ollamaOptCommands());
    showHint(t("Comandos copiados."));
  };
  document.querySelector("#opt-copy")!.addEventListener("click", copyOptCmds);
  if (/Windows/i.test(navigator.userAgent)) {
    // Windows: split button — "Otimizar" + caret (▼) com "Copiar comandos" e "Reverter".
    document.querySelector("#opt-split")!.removeAttribute("hidden");
    const menu = document.querySelector<HTMLElement>("#opt-menu")!;
    const runOpt = async (btn: HTMLButtonElement, revert: boolean) => {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = revert ? t("A reverter…") : t("A otimizar…");
      menu.setAttribute("hidden", "");
      try {
        if (revert) await api.revertOllama();
        else await api.optimizeOllama();
        showHint(
          (revert ? t("Otimização revertida") : t("Otimizações aplicadas")) +
            ". " +
            t("Reinicia o Ollama (fecha e reabre) para ter efeito.")
        );
      } catch (e) {
        showHint(t("Não foi possível otimizar: ") + String(e));
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    const optApply = document.querySelector<HTMLButtonElement>("#opt-apply")!;
    optApply.addEventListener("click", () => void runOpt(optApply, false));
    document.querySelector<HTMLButtonElement>("#opt-revert")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void runOpt(optApply, true);
    });
    document.querySelector("#opt-more")!.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.toggleAttribute("hidden");
    });
    document.addEventListener("click", () => menu.setAttribute("hidden", ""));
  } else {
    // Outros SO: só o "Copiar comandos" (não dá para reiniciar o Ollama de forma fiável).
    const plain = document.querySelector<HTMLButtonElement>("#opt-copy-plain")!;
    plain.removeAttribute("hidden");
    plain.addEventListener("click", copyOptCmds);
  }

  document.querySelectorAll<HTMLButtonElement>(".rail-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      if (v === "workspace") openWorkspace();
      else if (v === "servers") openMcp();
      else if (v === "activity") openActivity();
      else if (v === "automations") openAutomations();
      else if (v === "models") openModels();
      // "sagas": se já estamos nas Sagas e o ecrã é estreito, alterna a gaveta da lista;
      // senão volta ao chat.
      else if (mqSidebarDrawer.matches && b.classList.contains("active")) toggleDrawer("sidebar");
      else showView(null);
    })
  );
}

async function init() {
  // Captura erros de JS / promessas rejeitadas para o log (diagnóstico de crashes).
  window.addEventListener("error", (e) => {
    const stack = (e.error as Error | undefined)?.stack ?? "";
    void api.logFrontend("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${stack}`).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r);
    void api.logFrontend("error", `unhandledrejection: ${msg}`).catch(() => {});
  });
  mountViewsInCenter();
  els.composer.addEventListener("submit", onSubmit);
  els.messages.addEventListener("scroll", updateScrollBtn, { passive: true });
  document.querySelector("#scroll-bottom")!.addEventListener("click", scrollChatToBottom);
  wireFind();
  void wireDragDrop();
  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("input", updateSlashMenu);
  // Foco no compositor = intenção de escrever → aquece o modelo enquanto o utilizador digita.
  els.input.addEventListener("focus", () => warmLocalModel());
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
      // A gerar → Enter não envia nem cancela (deixa redigir a próxima mensagem); só o botão Parar.
      if (!state.busy) els.composer.requestSubmit();
    }
  });

  document.querySelector("#btn-settings")!.addEventListener("click", () => {
    els.dialog.showModal();
  });
  document.querySelector("#btn-mem-refresh")!.addEventListener("click", refreshMemory);
  document.querySelector("#btn-compact")!.addEventListener("click", compactCurrentSaga);
  document.querySelector("#btn-clear-saga")!.addEventListener("click", clearCurrentSaga);
  document.querySelector("#btn-new-chat")!.addEventListener("click", () => void createConversation());
  document
    .querySelector("#btn-new-topic")!
    .addEventListener("click", () => void createTopicInteractive());
  document.querySelector("#topic-save")!.addEventListener("click", () => void saveTopicEditor());
  document.querySelector("#topic-cancel")!.addEventListener("click", () => els.topicDialog.close());
  document.querySelector("#topic-folder-pick")!.addEventListener("click", () => void pickTopicFolder());
  document.querySelector("#distill-save")!.addEventListener("click", () => void saveDistill());
  document.querySelector("#distill-redraft")!.addEventListener("click", () => void redraftDistill());
  document.querySelector("#distill-discard")!.addEventListener("click", () => void discardDistill());
  document
    .querySelector("#project-files-close")!
    .addEventListener("click", () => els.projectFilesDialog.close());
  document.querySelector("#topic-folder-clear")!.addEventListener("click", () => {
    editingFolder = "";
    renderTopicFolder();
  });
  els.convSearch.addEventListener("input", onSearch);
  document.querySelector("#btn-attach")!.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", onFilesSelected);
  els.input.addEventListener("paste", onPaste);
  const setPanel = (collapsed: boolean) => {
    els.layout.classList.toggle("panel-collapsed", collapsed);
    localStorage.setItem("saga.panelCollapsed", collapsed ? "1" : "0");
  };
  // Ecrã estreito: o painel é uma gaveta sobreposta; largo: colapsa/expande a coluna (persistido).
  document.querySelector("#panel-collapse")!.addEventListener("click", () => {
    if (mqPanelDrawer.matches) els.layout.classList.remove("drawer-panel");
    else setPanel(true);
  });
  document.querySelector("#btn-panel")!.addEventListener("click", () => {
    if (mqPanelDrawer.matches) toggleDrawer("panel");
    else setPanel(!els.layout.classList.contains("panel-collapsed"));
  });
  document.querySelector("#drawer-scrim")!.addEventListener("click", closeDrawers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.layout.matches(".drawer-panel, .drawer-sidebar")) closeDrawers();
  });
  // Ao alargar para lá de cada breakpoint, fecha a gaveta que deixou de fazer sentido.
  mqPanelDrawer.addEventListener("change", (e) => {
    if (!e.matches) closeDrawers();
  });
  mqSidebarDrawer.addEventListener("change", (e) => {
    if (!e.matches) els.layout.classList.remove("drawer-sidebar");
  });
  setPanel(localStorage.getItem("saga.panelCollapsed") === "1");
  document.querySelector("#wiz-next")!.addEventListener("click", () => void wizNext());
  document.querySelector("#wiz-back")!.addEventListener("click", () => void wizGoTo(wizStep - 1));
  document
    .querySelectorAll<HTMLButtonElement>("#wiz-backend .wiz-choice-opt")
    .forEach((b) =>
      b.addEventListener("click", () => setWizBackend(b.dataset.backend as "ollama" | "lmstudio"))
    );
  document.querySelector("#wiz-lm-refresh")?.addEventListener("click", () => void runWizardLmTest());
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
  // Chip Think: a seta (inline) abre o menu de níveis; o resto do chip alterna off↔native think.
  const thinkMenu = document.querySelector<HTMLElement>("#think-menu")!;
  document.querySelector("#btn-think")!.addEventListener("click", (e) => {
    e.stopPropagation();
    if ((e.target as HTMLElement).closest(".think-caret")) {
      thinkMenu.toggleAttribute("hidden");
    } else {
      thinkMenu.setAttribute("hidden", "");
      setThinkLevel(state.thinkLevel === "off" ? "think" : "off");
    }
  });
  thinkMenu.querySelectorAll<HTMLButtonElement>("[data-level]").forEach((b) =>
    b.addEventListener("click", () => {
      setThinkLevel(b.dataset.level as ThinkLevel);
      thinkMenu.setAttribute("hidden", "");
    })
  );
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".think-split")) thinkMenu.setAttribute("hidden", "");
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
  document.querySelector("#btn-plan")!.addEventListener("click", (e) => {
    state.plan = !state.plan;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.plan);
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
  document.querySelector("#artifact-save-project")!.addEventListener("click", () => void saveArtifactToProject());
  document.querySelector("#artifact-pdf")!.addEventListener("click", exportArtifactPdf);
  document.querySelector("#artifact-gallery")!.addEventListener("click", openGallery);
  // Menu de overflow (⋯) da barra de controlos: abre os botões que não couberam; fecha ao clicar fora.
  const artifactMoreMenu = document.querySelector<HTMLElement>("#artifact-more-menu")!;
  document.querySelector("#artifact-more")!.addEventListener("click", (e) => {
    e.stopPropagation();
    artifactMoreMenu.toggleAttribute("hidden");
  });
  // Clicar num botão do menu executa a ação e fecha o menu (o select fica para escolher o tema).
  artifactMoreMenu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) artifactMoreMenu.setAttribute("hidden", "");
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".artifact-more-wrap")) artifactMoreMenu.setAttribute("hidden", "");
  });
  new ResizeObserver(() => reflowArtifactControls()).observe(els.artifactPanel);
  document.querySelector("#btn-export-saga")!.addEventListener("click", exportSaga);
  document.querySelector("#btn-check-update")!.addEventListener("click", checkForUpdates);
  document.querySelector("#set-autostart")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    api.setAutostart(on).catch((err) => {
      showHint(t("Falha a configurar o arranque: ") + err);
      (e.target as HTMLInputElement).checked = !on;
    });
  });
  document.querySelector("#btn-open-logs")!.addEventListener("click", () => {
    api.openLogs().catch((err) => showHint(t("Falha a abrir os logs: ") + err));
  });
  document.querySelector("#btn-copy-logpath")!.addEventListener("click", () => {
    const p = document.querySelector("#log-path")?.textContent ?? "";
    if (p && p !== "—") {
      navigator.clipboard?.writeText(p);
      showHint(t("Caminho copiado."));
    }
  });
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
    // Semeia/atualiza os defaults do workspace no idioma da UI (skill pdf + agentes).
    api.ensureWorkspaceDefaults(getLang()).catch(() => {});
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
    // Aquece o modelo local logo no arranque → 1.ª resposta sem cold-start.
    warmLocalModel();
    // Alimenta o datalist partilhado (#ollama-models) + cache para o A/B no chat e o autocomplete.
    // Re-renderiza a conversa quando chega (corrida com o 1.º render) p/ o picker ter os modelos locais.
    api
      .listOllamaModels()
      .then((ms) => {
        setLocalModelsCache(ms);
        if (state.items.length) renderMessages();
      })
      .catch(() => {});
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
