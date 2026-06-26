import "./style.css";
import { caravelLoader } from "./caravel-loader";
import { initZoom, nudgeZoom, onZoomChange, resetZoom } from "./zoom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import mermaid from "mermaid";
import { save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  api,
  type Accounting,
  type ActionLogEntry,
  type Attachment,
  type ChatMessage,
  type ChatResponse,
  type ConversationMeta,
  type Diagnostics,
  type McpServerConfig,
  type OllamaModel,
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
  routeMode: "auto" | "local" | "claude";
  thinking: boolean;
  research: boolean;
  subagents: boolean;
} = {
  items: [],
  settings: null,
  busy: false,
  conversations: [],
  currentConversationId: null,
  pendingAttachments: [],
  routeMode: "auto",
  thinking: false,
  research: false,
  subagents: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" class="brand-mark" alt="" /> <strong>Saga</strong> <span class="tag">router local ↔ Claude</span></div>
    <div class="mini" id="mini-stats"></div>
    <button class="icon-btn" id="btn-export-saga" title="Exportar Saga (Markdown)">⤓</button>
    <button class="icon-btn" id="btn-settings" title="Definições">⚙</button>
  </header>
  <main class="layout">
    <nav class="rail" id="rail">
      <button type="button" class="rail-btn active" data-view="sagas" title="Sagas"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg></span><span class="rail-lbl">Sagas</span></button>
      <button type="button" class="rail-btn" data-view="workspace" title="Workspace (skills, playbooks, workflows)"><span class="rail-ico">✦</span><span class="rail-lbl">Workspace</span></button>
      <button type="button" class="rail-btn" data-view="servers" title="Servidores MCP"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="6.5" y1="7.5" x2="6.5" y2="7.5"/><line x1="6.5" y1="16.5" x2="6.5" y2="16.5"/></svg></span><span class="rail-lbl">Servidores</span></button>
      <button type="button" class="rail-btn" data-view="activity" title="Atividade (ações)"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><line x1="4.5" y1="6" x2="4.5" y2="6"/><line x1="4.5" y1="12" x2="4.5" y2="12"/><line x1="4.5" y1="18" x2="4.5" y2="18"/></svg></span><span class="rail-lbl">Atividade</span></button>
      <button type="button" class="rail-btn" data-view="automations" title="Automações agendadas"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.7l3 1.8"/></svg></span><span class="rail-lbl">Automações</span></button>
      <button type="button" class="rail-btn" data-view="models" title="Modelos (instalar/configurar)"><span class="rail-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg></span><span class="rail-lbl">Modelos</span></button>
    </nav>
    <aside class="sidebar">
      <button class="new-chat" id="btn-new-chat">+ Nova Saga</button>
      <input class="conv-search" id="conv-search" type="search" placeholder="Pesquisar Sagas…" autocomplete="off" />
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
        <span class="composer-toggles">
          <button type="button" id="btn-subagents" class="chip-toggle" title="Subagentes (API: orquestra em paralelo · CLI: ferramenta Task)">🧩 Subagentes</button>
          <button type="button" id="btn-research" class="chip-toggle" title="Pesquisa web (API: web_search · CLI: WebSearch)">🔎 Pesquisar</button>
          <button type="button" id="btn-think" class="chip-toggle" title="Extended thinking (raciocínio) — só Claude API">🧠 Think</button>
        </span>
      </div>
      <form class="composer" id="composer">
        <button type="button" class="attach-btn" id="btn-attach" title="Anexar imagem" aria-label="Anexar imagem"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
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
        <button type="button" class="ghost" id="artifact-gallery">Galeria</button>
        <button type="button" class="ghost" id="artifact-toggle" hidden>Código</button>
        <button type="button" class="ghost" id="artifact-export">Guardar</button>
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
        <legend>Modelo local</legend>
        <label>Provider
          <select name="local_provider" id="local-provider">
            <option value="ollama">Ollama</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <div class="field-group" id="ollama-local-fields">
          <label>Endpoint <input name="ollama_endpoint" type="text" /></label>
          <label>Modelo
            <span class="row">
              <input name="ollama_model" type="text" list="ollama-models" />
              <button type="button" class="ghost" id="btn-list-models">Listar</button>
              <button type="button" class="ghost" id="btn-pull-model">Puxar</button>
            </span>
          </label>
          <datalist id="ollama-models"></datalist>
          <div class="pull-status" id="pull-status"></div>
          <label>Modelo de visão (imagens) <input name="ollama_vision_model" type="text" /></label>
        </div>
        <div class="field-group" id="openai-local-fields" hidden>
          <label>Endpoint <input name="openai_local_endpoint" type="text" placeholder="http://localhost:1234/v1" /></label>
          <label>API key (opcional) <input name="openai_local_key" type="password" /></label>
          <label>Modelo <input name="openai_local_model" type="text" placeholder="ex.: ID do modelo no LM Studio" /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Cloud (escalar)</legend>
        <label>Provider
          <select name="cloud_provider" id="cloud-provider">
            <option value="claude">Claude</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <div class="field-group" id="claude-cloud-fields">
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
        </div>
        <div class="field-group" id="openai-cloud-fields" hidden>
          <label>Endpoint <input name="openai_cloud_endpoint" type="text" placeholder="https://api.openai.com/v1" /></label>
          <label>API key <input name="openai_cloud_key" type="password" /></label>
          <label>Modelo <input name="openai_cloud_model" type="text" placeholder="ex.: gpt-4o" /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Router</legend>
        <label class="check"><input name="routing_enabled" type="checkbox" /> Router ativo</label>
        <label class="check"><input name="use_local_classifier" type="checkbox" /> Usar classificador local (LEVE/PESADO)</label>
        <label>Limite "leve" (chars) <input name="light_max_chars" type="number" min="0" /></label>
        <label>Palavras-chave → local <input name="force_local_keywords" type="text" /></label>
        <label>Palavras-chave → Claude <input name="force_claude_keywords" type="text" /></label>
        <label>Rondas de pesquisa (deep research) <input name="research_max_rounds" type="number" min="1" max="5" /></label>
      </fieldset>

      <fieldset>
        <legend>Memória</legend>
        <label>Pasta de memória <input name="memory_dir" type="text" /></label>
        <label>Caminho CLAUDE.md (opcional) <input name="claude_md_path" type="text" /></label>
      </fieldset>

      <fieldset>
        <legend>Ferramentas &amp; Workspace (só modo API)</legend>
        <label>Pasta do workspace (skills/playbooks/workflows) <input name="workspace_dir" type="text" /></label>
        <label>Confirmação de ações
          <select name="confirm_mode">
            <option value="off">Desligada — executa direto</option>
            <option value="dry_run">Dry-run — só pré-visualiza</option>
            <option value="ask">Pedir aprovação a cada ação</option>
          </select>
        </label>
        <label class="check"><input name="enable_browser_tools" type="checkbox" /> Ativar ferramentas de browser</label>
        <label>Caminho do sidecar (sidecar/index.js) <input name="browser_sidecar_script" type="text" /></label>
        <label>Executável Node <input name="browser_node_path" type="text" /></label>
        <label>Pasta de dados do browser (sessão persistente) <input name="browser_user_data_dir" type="text" /></label>
      </fieldset>

      <fieldset>
        <legend>Aparência</legend>
        <label>Zoom da interface
          <span class="row zoom-row">
            <button type="button" class="ghost" id="zoom-out" aria-label="Reduzir zoom">−</button>
            <span class="zoom-val" id="zoom-val">100%</span>
            <button type="button" class="ghost" id="zoom-in" aria-label="Aumentar zoom">+</button>
            <button type="button" class="ghost" id="zoom-reset">Repor</button>
          </span>
        </label>
        <p class="wiz-hint">Atalhos: <strong>Ctrl/⌘ +</strong>, <strong>Ctrl/⌘ −</strong>, <strong>Ctrl/⌘ 0</strong> (ou Ctrl/⌘ + roda do rato).</p>
        <label>Tamanho do texto
          <span class="row zoom-row">
            <button type="button" class="ghost" id="font-out" aria-label="Texto menor">A−</button>
            <span class="zoom-val" id="font-val">100%</span>
            <button type="button" class="ghost" id="font-in" aria-label="Texto maior">A+</button>
            <button type="button" class="ghost" id="font-reset">Repor</button>
          </span>
        </label>
        <p class="wiz-hint">Ajusta só o texto das mensagens e do compositor (o zoom escala toda a interface).</p>
      </fieldset>

      <fieldset>
        <legend>Atualizações</legend>
        <button type="button" class="ghost" id="btn-check-update">Verificar atualizações</button>
        <div class="pull-status" id="update-status"></div>
      </fieldset>

      <menu>
        <button value="cancel" class="ghost">Cancelar</button>
        <button value="save" id="btn-save" class="primary">Guardar</button>
      </menu>
    </form>
  </dialog>

  <dialog id="workspace-dialog">
    <div class="settings ws">
      <h2>Workspace</h2>
      <div class="ws-tabs" id="ws-tabs">
        <button type="button" class="ws-tab active" data-kind="skill">Skills</button>
        <button type="button" class="ws-tab" data-kind="playbook">Playbooks</button>
        <button type="button" class="ws-tab" data-kind="workflow">Workflows</button>
      </div>
      <div class="ws-body">
        <div class="ws-list" id="ws-list"></div>
        <div class="ws-editor" id="ws-editor" hidden>
          <label>Nome <input id="ws-name" type="text" placeholder="nome-sem-espacos" /></label>
          <textarea id="ws-content" rows="16" spellcheck="false" placeholder="# Markdown…"></textarea>
          <div class="ws-editor-bar">
            <button type="button" class="ghost" id="ws-cancel">Fechar editor</button>
            <button type="button" class="primary" id="ws-save">Guardar</button>
          </div>
        </div>
      </div>
      <menu>
        <button type="button" class="ghost" id="ws-new">+ Novo</button>
        <button type="button" class="ghost" id="ws-close">Fechar</button>
      </menu>
    </div>
  </dialog>

  <dialog id="mcp-dialog">
    <div class="settings">
      <h2>Servidores MCP</h2>
      <p class="wiz-intro">A Saga liga-se a servidores MCP (stdio) e o modelo pode chamar as ferramentas deles.
      Os segredos do <em>env</em> são guardados na keychain do sistema.</p>
      <div class="mcp-list" id="mcp-list"></div>
      <fieldset>
        <legend id="mcp-form-legend">Novo servidor</legend>
        <label>Nome <input id="mcp-name" type="text" placeholder="ex.: filesystem" /></label>
        <label>Comando <input id="mcp-command" type="text" placeholder="ex.: npx" /></label>
        <label>Argumentos (um por linha) <textarea id="mcp-args" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/caminho"></textarea></label>
        <label>Env (KEY=VALUE, um por linha) <textarea id="mcp-env" rows="2" spellcheck="false" placeholder="TOKEN=abc"></textarea></label>
        <label class="check"><input id="mcp-enabled" type="checkbox" checked /> Ativo</label>
        <div class="ws-editor-bar">
          <button type="button" class="ghost" id="mcp-test">Testar ligação</button>
          <button type="button" class="primary" id="mcp-add">Guardar servidor</button>
        </div>
        <div class="pull-status" id="mcp-status"></div>
      </fieldset>
      <menu>
        <button type="button" class="ghost" id="mcp-close">Fechar</button>
      </menu>
    </div>
  </dialog>

  <dialog id="activity-dialog">
    <div class="settings">
      <h2>Atividade desta Saga</h2>
      <div class="act-list" id="act-list"></div>
      <menu>
        <button type="button" class="ghost" id="act-refresh">Atualizar</button>
        <button type="button" class="ghost" id="act-close">Fechar</button>
      </menu>
    </div>
  </dialog>

  <dialog id="automations-dialog">
    <div class="settings">
      <h2>Automações agendadas</h2>
      <p class="wiz-intro">Corre um workflow num horário. As ações são <strong>executadas
      automaticamente</strong> e registadas; o resultado vai para a Saga "Automações" + notificação.
      Só corre com a app aberta.</p>
      <div class="mcp-list" id="sched-list"></div>
      <fieldset>
        <legend id="sched-form-legend">Novo agendamento</legend>
        <label>Nome <input id="sched-name" type="text" placeholder="ex.: Login diário" /></label>
        <label>Workflow <select id="sched-workflow"></select></label>
        <label>Argumentos <input id="sched-args" type="text" placeholder="(opcional)" /></label>
        <label>Frequência
          <select id="sched-preset">
            <option value="0 0 9 * * *">Todos os dias às 9h</option>
            <option value="0 0 9 * * Mon-Fri">Dias úteis às 9h</option>
            <option value="0 0 * * * *">De hora a hora</option>
            <option value="0 */5 * * * *">A cada 5 minutos</option>
            <option value="__custom__">Personalizado (cron)…</option>
          </select>
        </label>
        <label>Expressão cron <input id="sched-cron" type="text" value="0 0 9 * * *" /></label>
        <label class="check"><input id="sched-enabled" type="checkbox" checked /> Ativo</label>
        <div class="ws-editor-bar">
          <button type="button" class="ghost" id="sched-add">Guardar agendamento</button>
        </div>
        <div class="pull-status" id="sched-status"></div>
      </fieldset>
      <menu>
        <button type="button" class="ghost" id="sched-close">Fechar</button>
      </menu>
    </div>
  </dialog>

  <dialog id="models-dialog">
    <div class="settings">
      <h2>Modelos</h2>
      <div class="pull-status" id="hub-status">—</div>

      <fieldset>
        <legend>Provider local</legend>
        <label>Provider
          <select id="hub-local-provider">
            <option value="ollama">Ollama</option>
            <option value="openai">OpenAI-compatible (LM Studio)</option>
          </select>
        </label>
        <div class="field-group" id="hub-ollama-fields">
          <label>Endpoint <input id="hub-ollama-endpoint" type="text" placeholder="http://localhost:11434" /></label>
          <label>Modelo de visão (imagens) <input id="hub-vision" type="text" list="ollama-models" /></label>
        </div>
        <div class="field-group" id="hub-openai-local-fields" hidden>
          <label>Endpoint <input id="hub-oai-local-endpoint" type="text" placeholder="http://localhost:1234/v1" /></label>
          <label>API key (opcional) <input id="hub-oai-local-key" type="password" /></label>
          <label>Modelo <input id="hub-oai-local-model" type="text" placeholder="ex.: ID no LM Studio" /></label>
        </div>
      </fieldset>

      <fieldset id="hub-ollama-mgmt">
        <legend>Modelos Ollama instalados</legend>
        <div class="models-list" id="hub-installed"></div>
        <label>Instalar modelo
          <span class="row">
            <input id="hub-pull-name" type="text" placeholder="ex.: llama3.2" list="ollama-models" />
            <button type="button" class="ghost" id="hub-pull-btn">Puxar</button>
          </span>
        </label>
        <div class="hub-progress" id="hub-progress" hidden><div class="hub-bar" id="hub-bar"></div></div>
        <div class="pull-status" id="hub-pull-status"></div>
        <div class="quickpicks" id="hub-quickpicks"></div>
      </fieldset>

      <fieldset>
        <legend>Cloud (escalar)</legend>
        <label>Provider
          <select id="hub-cloud-provider">
            <option value="claude">Claude</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <div class="field-group" id="hub-claude-fields">
          <label>Modo
            <select id="hub-claude-mode">
              <option value="off">Desligado</option>
              <option value="cli">Claude CLI (subscrição)</option>
              <option value="api">API (ANTHROPIC_API_KEY)</option>
            </select>
          </label>
          <label>Modelo
            <select id="hub-claude-preset">
              <option value="claude-haiku-4-5-20251001">Haiku 4.5 — rápido e barato</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6 — equilíbrio</option>
              <option value="claude-opus-4-8">Opus 4.8 — topo</option>
              <option value="claude-fable-5">Fable 5 — mais capaz</option>
              <option value="__custom__">Personalizado…</option>
            </select>
          </label>
          <label id="hub-claude-custom-wrap" hidden>Modelo (ID) <input id="hub-claude-model" type="text" /></label>
          <label>Caminho da CLI <input id="hub-claude-cli" type="text" /></label>
          <label>API key <input id="hub-claude-key" type="password" /></label>
          <label>Max tokens <input id="hub-claude-maxtok" type="number" min="256" /></label>
        </div>
        <div class="field-group" id="hub-openai-cloud-fields" hidden>
          <label>Endpoint <input id="hub-oai-cloud-endpoint" type="text" placeholder="https://api.openai.com/v1" /></label>
          <label>API key <input id="hub-oai-cloud-key" type="password" /></label>
          <label>Modelo <input id="hub-oai-cloud-model" type="text" placeholder="ex.: gpt-4o" /></label>
        </div>
      </fieldset>

      <menu>
        <button type="button" class="primary" id="hub-save">Guardar</button>
        <button type="button" class="ghost" id="hub-close">Fechar</button>
      </menu>
    </div>
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
      if (item.role === "assistant" && !item.error) {
        bubble.classList.add("markdown");
        bubble.innerHTML = renderMarkdown(item.content);
        highlightWithin(bubble);
      } else {
        bubble.textContent = item.content;
      }
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

    // Artefactos: qualquer resposta do assistente com blocos de código/HTML (+ relatório).
    if (item.role === "assistant" && item.content) {
      const blocks = extractCodeBlocks(item.content);
      const isReport = item.report || /(^|\n)## Fontes/.test(item.content);
      if (blocks.length || isReport) {
        const arow = document.createElement("div");
        arow.className = "artifact-actions";
        if (isReport) {
          const btn = document.createElement("button");
          btn.textContent = "📄 Relatório";
          btn.addEventListener("click", () =>
            openArtifact({ lang: "markdown", code: item.content, kind: "markdown" })
          );
          arow.appendChild(btn);
        }
        blocks.forEach((b, i) => {
          const btn = document.createElement("button");
          btn.textContent =
            `📄 ${KIND_LABEL[b.kind]}${blocks.length > 1 ? " " + (i + 1) : ""}` +
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

    // Editar a própria mensagem.
    if (item.role === "user" && !state.busy) {
      const actions = document.createElement("div");
      actions.className = "msg-actions user-actions";
      const ed = document.createElement("button");
      ed.textContent = "✎ Editar";
      ed.title = "Editar e reenviar";
      ed.addEventListener("click", () => editUserMessage(index));
      actions.appendChild(ed);
      row.appendChild(actions);
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
  research?: boolean;
  subagents?: boolean;
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
  const sendOpts: SendOpts = {
    ...opts,
    thinking: opts.thinking ?? state.thinking,
    research: opts.research ?? state.research,
    subagents: opts.subagents ?? state.subagents,
  };
  // Pesquisa web e subagentes são caminhos só de Claude API → forçam a rota.
  if ((sendOpts.research || sendOpts.subagents) && !sendOpts.routeOverride) {
    sendOpts.routeOverride = "claude";
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
    ? "A pesquisar na net…"
    : sendOpts.subagents
      ? "A coordenar subagentes…"
      : sendOpts.thinking
        ? "A pensar a fundo…"
        : "A pensar…";
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
          assistant.steps.push(`${evt.tool} ${evt.detail}`);
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
  cancel.textContent = "Cancelar";
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Guardar e reenviar";
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
  (f.elements.namedItem("research_max_rounds") as HTMLInputElement).value = String(
    s.research_max_rounds
  );
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
  (f.elements.namedItem("workspace_dir") as HTMLInputElement).value = s.workspace_dir;
  (f.elements.namedItem("confirm_mode") as HTMLSelectElement).value = s.confirm_mode;
  (f.elements.namedItem("local_provider") as HTMLSelectElement).value = s.local_provider;
  (f.elements.namedItem("openai_local_endpoint") as HTMLInputElement).value =
    s.openai_local_endpoint;
  (f.elements.namedItem("openai_local_key") as HTMLInputElement).value = s.openai_local_key;
  (f.elements.namedItem("openai_local_model") as HTMLInputElement).value = s.openai_local_model;
  (f.elements.namedItem("cloud_provider") as HTMLSelectElement).value = s.cloud_provider;
  (f.elements.namedItem("openai_cloud_endpoint") as HTMLInputElement).value =
    s.openai_cloud_endpoint;
  (f.elements.namedItem("openai_cloud_key") as HTMLInputElement).value = s.openai_cloud_key;
  (f.elements.namedItem("openai_cloud_model") as HTMLInputElement).value = s.openai_cloud_model;
  applyProviderFields();
}

function applyProviderFields() {
  const lp = (els.form.elements.namedItem("local_provider") as HTMLSelectElement).value;
  const cp = (els.form.elements.namedItem("cloud_provider") as HTMLSelectElement).value;
  document.querySelector("#ollama-local-fields")!.toggleAttribute("hidden", lp !== "ollama");
  document.querySelector("#openai-local-fields")!.toggleAttribute("hidden", lp !== "openai");
  document.querySelector("#claude-cloud-fields")!.toggleAttribute("hidden", cp !== "claude");
  document.querySelector("#openai-cloud-fields")!.toggleAttribute("hidden", cp !== "openai");
}

/** Esconde os toggles só-Claude (🔎/🧩/🧠) quando o cloud não é Claude. */
function applyComposerToggles() {
  const isClaude = !state.settings || state.settings.cloud_provider === "claude";
  els.routeModeBar
    .querySelector(".composer-toggles")!
    .toggleAttribute("hidden", !isClaude);
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
    research_max_rounds: Math.min(5, Math.max(1, parseInt(val("research_max_rounds")) || 3)),
    memory_dir: val("memory_dir"),
    claude_md_path: val("claude_md_path"),
    enable_browser_tools: checked("enable_browser_tools"),
    browser_sidecar_script: val("browser_sidecar_script"),
    browser_node_path: val("browser_node_path"),
    browser_user_data_dir: val("browser_user_data_dir"),
    workspace_dir: val("workspace_dir"),
    confirm_mode: val("confirm_mode") as Settings["confirm_mode"],
    local_provider: val("local_provider") as Settings["local_provider"],
    openai_local_endpoint: val("openai_local_endpoint"),
    openai_local_key: val("openai_local_key"),
    openai_local_model: val("openai_local_model"),
    cloud_provider: val("cloud_provider") as Settings["cloud_provider"],
    openai_cloud_endpoint: val("openai_cloud_endpoint"),
    openai_cloud_key: val("openai_cloud_key"),
    openai_cloud_model: val("openai_cloud_model"),
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
  els.artifactToggle.textContent = artifactMode === "preview" ? "Código" : "Pré-visualizar";

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
          div.textContent = "Erro a desenhar o diagrama: " + e;
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
  els.artifactTitle.textContent = `${KIND_LABEL[a.kind]}` + (a.lang ? ` · ${a.lang}` : "");
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
      alert("Falha a exportar: " + e);
    }
  }
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
  els.artifactTitle.textContent = `Galeria · ${arts.length}`;
  els.artifactToggle.hidden = true;
  els.artifactPanel.hidden = false;
  body.innerHTML = "";
  if (arts.length === 0) {
    body.innerHTML = `<div class="empty-sm">Sem artefactos nesta Saga.</div>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "gallery-list";
  arts.forEach((a, i) => {
    const item = document.createElement("button");
    item.className = "gallery-item";
    item.textContent = `${KIND_LABEL[a.kind]}${a.lang ? " · " + a.lang : ""} #${i + 1}`;
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
    alert("Falha a ler a Saga: " + e);
    return;
  }
  const title =
    state.conversations.find((c) => c.id === state.currentConversationId)?.title || "Saga";
  const lines = [`# ${title}`, ""];
  for (const m of msgs) {
    const who = m.role === "user" ? "Tu" : "Saga";
    const tag = m.role === "assistant" && m.model ? ` _(${m.route}/${m.model})_` : "";
    lines.push(`## ${who}${tag}`, "", m.content, "");
  }
  const path = await save({ defaultPath: `${title.replace(/[^\w-]+/g, "_")}.md` });
  if (path) {
    try {
      await api.exportFile(path, lines.join("\n"));
    } catch (e) {
      alert("Falha a exportar: " + e);
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

async function checkForUpdates() {
  const status = document.querySelector("#update-status")!;
  status.textContent = "A verificar…";
  try {
    const update = await check();
    if (!update) {
      status.textContent = "Estás na versão mais recente.";
      return;
    }
    status.textContent = `Nova versão ${update.version} — a descarregar…`;
    await update.downloadAndInstall();
    status.textContent = "Instalado. A reiniciar…";
    await relaunch();
  } catch (e) {
    status.textContent = "Atualizações indisponíveis: " + e;
  }
}

// ---- Aprovação de ações (modo "ask") ----
function showApproval(id: number, tool: string, preview: string) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML = `
    <div class="approval-head">Aprovar ação?</div>
    <div class="approval-tool">${escapeHtml(tool)}</div>
    <pre class="approval-preview">${escapeHtml(preview)}</pre>
    <div class="approval-bar">
      <button type="button" class="ghost" data-ok="0">Recusar</button>
      <button type="button" class="primary" data-ok="1">Aprovar</button>
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
let wsKind: "skill" | "playbook" | "workflow" = "skill";

async function openWorkspace() {
  setWsKind("skill");
  await wsDialog.showModal();
}

function setWsKind(kind: "skill" | "playbook" | "workflow") {
  wsKind = kind;
  wsDialog
    .querySelectorAll<HTMLButtonElement>(".ws-tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  document.querySelector("#ws-editor")!.setAttribute("hidden", "");
  void renderWorkspaceList();
}

async function renderWorkspaceList() {
  const list = document.querySelector<HTMLDivElement>("#ws-list")!;
  let idx;
  try {
    idx = await api.getWorkspaceIndex();
  } catch {
    idx = { skills: [], playbooks: [], workflows: [] };
  }
  const items =
    wsKind === "skill"
      ? idx.skills
      : wsKind === "workflow"
        ? idx.workflows
        : idx.playbooks.map((n) => ({ name: n, description: "" }));
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-sm">Nada ainda. Cria o primeiro com “+ Novo”.</div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (it) => `
    <div class="ws-item">
      <div class="ws-item-main"><strong>${escapeHtml(it.name)}</strong><span>${escapeHtml(it.description)}</span></div>
      <div class="ws-item-actions">
        ${wsKind === "workflow" ? `<button type="button" class="ghost" data-run="${escapeHtml(it.name)}">▶ Correr</button>` : ""}
        <button type="button" class="ghost" data-edit="${escapeHtml(it.name)}">Editar</button>
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

function newWsDoc() {
  const nameEl = document.querySelector("#ws-name") as HTMLInputElement;
  nameEl.value = "";
  nameEl.readOnly = false;
  (document.querySelector("#ws-content") as HTMLTextAreaElement).value =
    wsKind === "skill"
      ? '---\nname: nome\ndescription: "Quando usar isto. Triggers: …"\n---\n\n# Instruções\n'
      : wsKind === "workflow"
        ? '---\nname: nome\ndescription: "O que faz"\nargument-hint: argumentos\n---\n\nPassos a executar com $ARGUMENTS…\n'
        : "# Playbook\n\nProcedimento reutilizável…\n";
  document.querySelector("#ws-editor")!.removeAttribute("hidden");
}

async function editWsDoc(name: string) {
  try {
    const content = await api.readWorkspaceDoc(wsKind, name);
    const nameEl = document.querySelector("#ws-name") as HTMLInputElement;
    nameEl.value = name;
    nameEl.readOnly = true;
    (document.querySelector("#ws-content") as HTMLTextAreaElement).value = content;
    document.querySelector("#ws-editor")!.removeAttribute("hidden");
  } catch (e) {
    alert("Falha a abrir: " + e);
  }
}

async function saveWsDoc() {
  const name = (document.querySelector("#ws-name") as HTMLInputElement).value.trim();
  const content = (document.querySelector("#ws-content") as HTMLTextAreaElement).value;
  if (!name) {
    alert("Indica um nome (sem espaços).");
    return;
  }
  try {
    await api.saveWorkspaceDoc(wsKind, name, content);
    document.querySelector("#ws-editor")!.setAttribute("hidden", "");
    await renderWorkspaceList();
  } catch (e) {
    alert("Falha a guardar: " + e);
  }
}

async function delWsDoc(name: string) {
  if (!confirm(`Apagar “${name}”?`)) return;
  try {
    await api.deleteWorkspaceDoc(wsKind, name);
    await renderWorkspaceList();
  } catch (e) {
    alert("Falha a apagar: " + e);
  }
}

async function runWorkflow(name: string) {
  wsDialog.close();
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
  mcpDialog.showModal();
}

function renderMcpList() {
  const list = document.querySelector<HTMLDivElement>("#mcp-list")!;
  const srvs = mcpServers();
  if (srvs.length === 0) {
    list.innerHTML = `<div class="empty-sm">Sem servidores. Adiciona um abaixo.</div>`;
    return;
  }
  list.innerHTML = srvs
    .map(
      (s, i) => `
    <div class="mcp-item">
      <label class="check"><input type="checkbox" data-toggle="${i}" ${s.enabled ? "checked" : ""} /> <strong>${escapeHtml(s.name)}</strong></label>
      <code>${escapeHtml(s.command)} ${escapeHtml(s.args.join(" "))}</code>
      <div class="mcp-item-actions">
        <button type="button" class="ghost" data-edit="${i}">Editar</button>
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
  document.querySelector("#mcp-form-legend")!.textContent = "Novo servidor";
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
  document.querySelector("#mcp-form-legend")!.textContent = "Editar servidor";
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
    status.textContent = "Nome e comando são obrigatórios.";
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
    status.textContent = "Falha a guardar: " + e;
  }
}

async function toggleMcp(i: number, enabled: boolean) {
  const next = mcpServers().slice();
  if (!next[i]) return;
  next[i] = { ...next[i], enabled };
  try {
    await persistServers(next);
  } catch (e) {
    alert("Falha: " + e);
  }
}

async function delMcp(i: number) {
  if (!confirm("Remover este servidor?")) return;
  const next = mcpServers().slice();
  next.splice(i, 1);
  try {
    await persistServers(next);
    renderMcpList();
  } catch (e) {
    alert("Falha: " + e);
  }
}

async function testMcp() {
  const cfg = readMcpForm();
  const status = document.querySelector("#mcp-status")!;
  if (!cfg.command) {
    status.textContent = "Indica o comando.";
    return;
  }
  status.textContent = "A ligar…";
  try {
    const tools = await api.testMcpServer(cfg);
    status.textContent = `✓ ${tools.length} ferramentas: ${tools.join(", ") || "(nenhuma)"}`;
  } catch (e) {
    status.textContent = "✗ " + e;
  }
}

// ---- Atividade ----
const activityDialog = document.querySelector<HTMLDialogElement>("#activity-dialog")!;
async function openActivity() {
  await renderActivity();
  activityDialog.showModal();
}
async function renderActivity() {
  const list = document.querySelector<HTMLDivElement>("#act-list")!;
  if (state.currentConversationId === null) {
    list.innerHTML = `<div class="empty-sm">Sem Saga selecionada.</div>`;
    return;
  }
  let rows: ActionLogEntry[] = [];
  try {
    rows = await api.getActionLog(state.currentConversationId);
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-sm">Sem ações registadas nesta Saga.</div>`;
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
      sel.innerHTML = `<option value="">(sem workflows — cria um no Workspace)</option>`;
    }
  } catch {
    sel.innerHTML = "";
  }
  clearSchedForm();
  await renderSchedules();
  automationsDialog.showModal();
}

function clearSchedForm() {
  schedEditingId = null;
  (document.querySelector("#sched-name") as HTMLInputElement).value = "";
  (document.querySelector("#sched-args") as HTMLInputElement).value = "";
  (document.querySelector("#sched-preset") as HTMLSelectElement).value = "0 0 9 * * *";
  (document.querySelector("#sched-cron") as HTMLInputElement).value = "0 0 9 * * *";
  (document.querySelector("#sched-enabled") as HTMLInputElement).checked = true;
  document.querySelector("#sched-status")!.textContent = "";
  document.querySelector("#sched-form-legend")!.textContent = "Novo agendamento";
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
    list.innerHTML = `<div class="empty-sm">Sem agendamentos. Cria um abaixo.</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (s) => `
    <div class="mcp-item">
      <label class="check"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} /> <strong>${escapeHtml(s.name)}</strong></label>
      <code>${escapeHtml(s.workflow_name)} · ${escapeHtml(s.cron)} · próx: ${escapeHtml(fmtEpoch(s.next_run_epoch))}</code>
      <div class="mcp-item-actions">
        <button type="button" class="ghost" data-run="${s.id}">▶</button>
        <button type="button" class="ghost" data-edit="${s.id}">Editar</button>
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
  document.querySelector("#sched-form-legend")!.textContent = "Editar agendamento";
}

async function addOrUpdateSchedule() {
  const name = (document.querySelector("#sched-name") as HTMLInputElement).value.trim();
  const workflow = (document.querySelector("#sched-workflow") as HTMLSelectElement).value;
  const args = (document.querySelector("#sched-args") as HTMLInputElement).value.trim();
  const cron = (document.querySelector("#sched-cron") as HTMLInputElement).value.trim();
  const enabled = (document.querySelector("#sched-enabled") as HTMLInputElement).checked;
  const status = document.querySelector("#sched-status")!;
  if (!name || !workflow || !cron) {
    status.textContent = "Nome, workflow e cron são obrigatórios.";
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
    status.textContent = "Falha: " + e;
  }
}

async function toggleSchedule(s: Schedule, enabled: boolean) {
  try {
    await api.updateSchedule(s.id, s.name, s.workflow_name, s.arguments, s.cron, enabled);
    await renderSchedules();
  } catch (e) {
    alert("Falha: " + e);
  }
}

async function delSchedule(id: number) {
  if (!confirm("Remover este agendamento?")) return;
  try {
    await api.deleteSchedule(id);
    await renderSchedules();
  } catch (e) {
    alert("Falha: " + e);
  }
}

async function runScheduleNow(id: number) {
  const status = document.querySelector("#sched-status")!;
  status.textContent = "A correr…";
  try {
    status.textContent = await api.runScheduleNow(id);
    await renderSchedules();
  } catch (e) {
    status.textContent = "Falha: " + e;
  }
}

// ---- Hub "Modelos" ----
const modelsDialog = document.querySelector<HTMLDialogElement>("#models-dialog")!;
const QUICK_PICKS = [
  { name: "llama3.2", note: "3B · geral leve" },
  { name: "qwen2.5", note: "7B · forte" },
  { name: "phi3.5", note: "3.8B · pequeno" },
  { name: "gemma2", note: "9B" },
  { name: "mistral", note: "7B" },
  { name: "llama3.2-vision", note: "11B · visão" },
];

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
  modelsDialog.showModal();
  void renderHubStatus();
  void renderInstalled();
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
}

function applyHubProviderFields() {
  const lp = hubSel("#hub-local-provider").value;
  const cp = hubSel("#hub-cloud-provider").value;
  document.querySelector("#hub-ollama-fields")!.toggleAttribute("hidden", lp !== "ollama");
  document.querySelector("#hub-ollama-mgmt")!.toggleAttribute("hidden", lp !== "ollama");
  document.querySelector("#hub-openai-local-fields")!.toggleAttribute("hidden", lp !== "openai");
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
    });
    document.querySelector("#hub-status")!.textContent = "✓ Guardado";
    void renderHubStatus();
  } catch (e) {
    alert("Falha a guardar: " + e);
  }
}

async function renderHubStatus() {
  const el = document.querySelector("#hub-status")!;
  try {
    const d = await api.diagnostics();
    el.textContent = d.ollama_ok
      ? `Ollama ligado · ${d.ollama_models.length} modelos`
      : "Ollama não acessível — instala em ollama.com e confirma o endpoint";
  } catch {
    el.textContent = "—";
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
    list.innerHTML = `<div class="empty-sm">Sem modelos. Puxa um abaixo.</div>`;
    return;
  }
  const active = state.settings?.ollama_model;
  list.innerHTML = models
    .map(
      (m) => `
    <div class="model-item${m.name === active ? " active" : ""}">
      <div class="model-main">
        <strong>${escapeHtml(m.name)}</strong>
        <span>${escapeHtml([m.parameter_size, fmtSize(m.size), m.quantization].filter(Boolean).join(" · "))}</span>
      </div>
      <div class="model-actions">
        ${m.name === active ? `<span class="model-badge">ativo</span>` : `<button type="button" class="ghost" data-activate="${escapeHtml(m.name)}">Ativar</button>`}
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
  if (!confirm(`Apagar o modelo "${name}"?`)) return;
  try {
    await api.deleteOllamaModel(name);
    await renderInstalled();
  } catch (e) {
    alert("Falha a apagar: " + e);
  }
}

function renderQuickPicks() {
  const box = document.querySelector<HTMLDivElement>("#hub-quickpicks")!;
  box.innerHTML = QUICK_PICKS.map(
    (q) =>
      `<button type="button" class="quickpick" data-pull="${escapeHtml(q.name)}" title="${escapeHtml(q.note)}">${escapeHtml(q.name)}</button>`
  ).join("");
  box
    .querySelectorAll<HTMLButtonElement>("[data-pull]")
    .forEach((b) => b.addEventListener("click", () => pullModelUi(b.dataset.pull!)));
}

async function pullModelUi(name: string) {
  name = name.trim();
  if (!name) return;
  const status = document.querySelector("#hub-pull-status")!;
  const wrap = document.querySelector<HTMLElement>("#hub-progress")!;
  const bar = document.querySelector<HTMLElement>("#hub-bar")!;
  wrap.hidden = false;
  bar.style.width = "0%";
  status.textContent = "A iniciar…";
  try {
    await api.pullOllamaModel(name, (ev) => {
      if (ev.kind === "Progress") {
        if (ev.percent >= 0) bar.style.width = ev.percent.toFixed(0) + "%";
        status.textContent =
          ev.percent >= 0 ? `${ev.status} — ${ev.percent.toFixed(0)}%` : ev.status;
      } else if (ev.kind === "Done") {
        bar.style.width = "100%";
        status.textContent = "✓ Descarregado";
        void renderInstalled();
        void renderHubStatus();
      } else {
        status.textContent = "✗ " + ev.message;
      }
    });
  } catch (e) {
    status.textContent = "✗ " + e;
  }
}

function wireWorkspaceUi() {
  wsDialog
    .querySelectorAll<HTMLButtonElement>(".ws-tab")
    .forEach((b) => b.addEventListener("click", () => setWsKind(b.dataset.kind as typeof wsKind)));
  document.querySelector("#ws-new")!.addEventListener("click", newWsDoc);
  document.querySelector("#ws-save")!.addEventListener("click", saveWsDoc);
  document
    .querySelector("#ws-cancel")!
    .addEventListener("click", () => document.querySelector("#ws-editor")!.setAttribute("hidden", ""));
  document.querySelector("#ws-close")!.addEventListener("click", () => wsDialog.close());

  document.querySelector("#mcp-add")!.addEventListener("click", addOrUpdateMcp);
  document.querySelector("#mcp-test")!.addEventListener("click", testMcp);
  document.querySelector("#mcp-close")!.addEventListener("click", () => mcpDialog.close());

  document.querySelector("#act-refresh")!.addEventListener("click", renderActivity);
  document.querySelector("#act-close")!.addEventListener("click", () => activityDialog.close());

  document.querySelector("#sched-add")!.addEventListener("click", addOrUpdateSchedule);
  document.querySelector("#sched-close")!.addEventListener("click", () => automationsDialog.close());
  document.querySelector("#sched-preset")!.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v !== "__custom__") (document.querySelector("#sched-cron") as HTMLInputElement).value = v;
  });

  // Hub Modelos
  document.querySelector("#hub-save")!.addEventListener("click", hubSave);
  document.querySelector("#hub-close")!.addEventListener("click", () => modelsDialog.close());
  document.querySelector("#hub-local-provider")!.addEventListener("change", applyHubProviderFields);
  document.querySelector("#hub-cloud-provider")!.addEventListener("change", applyHubProviderFields);
  document.querySelector("#hub-claude-preset")!.addEventListener("change", () => {
    const v = hubSel("#hub-claude-preset").value;
    document.querySelector("#hub-claude-custom-wrap")!.toggleAttribute("hidden", v !== "__custom__");
    if (v !== "__custom__") hubIn("#hub-claude-model").value = v;
  });
  document.querySelector("#hub-pull-btn")!.addEventListener("click", () =>
    pullModelUi(hubIn("#hub-pull-name").value)
  );

  document.querySelectorAll<HTMLButtonElement>(".rail-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      if (v === "workspace") openWorkspace();
      else if (v === "servers") openMcp();
      else if (v === "activity") openActivity();
      else if (v === "automations") openAutomations();
      else if (v === "models") openModels();
    })
  );
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
  document.querySelector("#btn-research")!.addEventListener("click", (e) => {
    state.research = !state.research;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.research);
  });
  document.querySelector("#btn-subagents")!.addEventListener("click", (e) => {
    state.subagents = !state.subagents;
    (e.currentTarget as HTMLElement).classList.toggle("active", state.subagents);
  });
  els.artifactClose.addEventListener("click", closeArtifact);
  els.artifactToggle.addEventListener("click", () => {
    artifactMode = artifactMode === "preview" ? "code" : "preview";
    renderArtifactBody();
  });
  els.artifactCopy.addEventListener("click", () => {
    if (artifactCurrent) navigator.clipboard?.writeText(artifactCurrent.code);
  });
  document.querySelector("#artifact-export")!.addEventListener("click", exportArtifact);
  document.querySelector("#artifact-gallery")!.addEventListener("click", openGallery);
  document.querySelector("#btn-export-saga")!.addEventListener("click", exportSaga);
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
  document.querySelector("#btn-pull-model")!.addEventListener("click", async () => {
    const model = (els.form.elements.namedItem("ollama_model") as HTMLInputElement).value.trim();
    const status = document.querySelector("#pull-status")!;
    if (!model) {
      status.textContent = "Indica um modelo (ex.: llama3.2)";
      return;
    }
    status.textContent = "A iniciar descarga…";
    try {
      await api.pullOllamaModel(model, (ev) => {
        if (ev.kind === "Progress") {
          status.textContent =
            ev.percent >= 0 ? `${ev.status} — ${ev.percent.toFixed(0)}%` : ev.status;
        } else if (ev.kind === "Done") {
          status.textContent = "✓ Descarregado";
          api.listOllamaModels()
            .then((models) => {
              els.modelsList.innerHTML = models
                .map((m) => `<option value="${escapeHtml(m)}"></option>`)
                .join("");
            })
            .catch(() => {});
        } else {
          status.textContent = "✗ " + ev.message;
        }
      });
    } catch (e) {
      status.textContent = "✗ " + e;
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
        applyComposerToggles();
        await refreshMemory();
      } catch (err) {
        alert("Falha a guardar definições: " + err);
      }
    }
  });
  document.querySelector("#local-provider")!.addEventListener("change", applyProviderFields);
  document.querySelector("#cloud-provider")!.addEventListener("change", applyProviderFields);
  document.querySelector("#btn-check-update")!.addEventListener("click", checkForUpdates);
  wireWorkspaceUi();

  // Zoom da interface (Ctrl/⌘ +/−/0) + controlos nas definições.
  initZoom();
  onZoomChange((z) => {
    const el = document.querySelector("#zoom-val");
    if (el) el.textContent = Math.round(z * 100) + "%";
  });
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
