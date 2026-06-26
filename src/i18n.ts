//! i18n simples PT/EN. A string PT é a própria chave; o dicionário EN traduz.
//! O que não estiver traduzido cai para PT (nunca mostra chaves cruas).

export type Lang = "pt" | "en";

let lang: Lang = "pt";

/** Idioma inicial: localStorage, senão deteta do SO (pt* → pt, resto → en). */
export function initLang() {
  const saved = localStorage.getItem("saga.lang");
  if (saved === "pt" || saved === "en") {
    lang = saved;
  } else {
    lang = (navigator.language || "").toLowerCase().startsWith("pt") ? "pt" : "en";
  }
}

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  localStorage.setItem("saga.lang", l);
}

/** Traduz `pt` para o idioma atual; `vars` interpola `{nome}`. */
export function t(pt: string, vars?: Record<string, string | number>): string {
  let s = lang === "en" ? EN[pt] ?? pt : pt;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

/** Dicionário PT → EN. Acrescenta entradas para traduzir mais strings. */
const EN: Record<string, string> = {
  // Topbar / rail
  "router local ↔ Claude": "local ↔ Claude router",
  "Sagas": "Sagas",
  "Workspace": "Workspace",
  "Servidores": "Servers",
  "Atividade": "Activity",
  "Automações": "Automations",
  "Modelos": "Models",
  "Definições": "Settings",
  "Exportar Saga (Markdown)": "Export Saga (Markdown)",
  // Sidebar / composer
  "+ Nova Saga": "+ New Saga",
  "Pesquisar Sagas…": "Search Sagas…",
  "Escreve uma mensagem…": "Type a message…",
  "Enviar": "Send",
  "Auto": "Auto",
  "Local": "Local",
  "Claude": "Claude",
  "🧩 Subagentes": "🧩 Subagents",
  "🔎 Pesquisar": "🔎 Search",
  "🧠 Think": "🧠 Think",
  "Anexar imagem": "Attach image",
  "Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.":
    "Ask a question. Light tasks stay on the local model; only heavy ones escalate to Claude.",
  // Painel
  "Painel de tokens": "Token panel",
  "Memória carregada": "Loaded memory",
  "Atualizar pré-visualização": "Refresh preview",
  // Comuns
  "Fechar": "Close",
  "Guardar": "Save",
  "Cancelar": "Cancel",
  "+ Novo": "+ New",
  "Gerar": "Generate",
  "Descarregar": "Download",
  "Ativar": "Activate",
  "Repor": "Reset",
  "Puxar": "Pull",
  "Testar ligação": "Test connection",
  "Atualizar": "Refresh",
  // Settings
  "Modelo local": "Local model",
  "Provider": "Provider",
  "Endpoint": "Endpoint",
  "Modelo": "Model",
  "Cloud (escalar)": "Cloud (escalate)",
  "Router": "Router",
  "Memória": "Memory",
  "Aparência": "Appearance",
  "Atualizações": "Updates",
  "Idioma": "Language",
  "Português": "Portuguese",
  "English": "English",
  "Verificar atualizações": "Check for updates",
  "Zoom da interface": "Interface zoom",
  "Tamanho do texto": "Text size",
  "Pesquisa web (modelo local)": "Web search (local model)",
  "Modelo local (avançado)": "Local model (advanced)",
  "Contexto (num_ctx)": "Context (num_ctx)",
  "Temperatura": "Temperature",
  // Hub Modelos
  "Provider local": "Local provider",
  "Modelos Ollama instalados": "Installed Ollama models",
  "Instalar modelo": "Install model",
  "ativo": "active",
  "Galeria": "Gallery",
  "Código": "Code",
  "Pré-visualizar": "Preview",
  // Workspace
  "Skills": "Skills",
  "Playbooks": "Playbooks",
  "Workflows": "Workflows",
  "Nome": "Name",
  "Descrição": "Description",
  "Fechar editor": "Close editor",
  "✨ Gerar com IA — descreve o que queres": "✨ Generate with AI — describe what you want",
  // Automações
  "Automações agendadas": "Scheduled automations",
  "Novo agendamento": "New schedule",
  "Workflow": "Workflow",
  "Argumentos": "Arguments",
  "Frequência": "Frequency",
  "Ativo": "Enabled",
  "Guardar agendamento": "Save schedule",
  // Atividade
  "Atividade desta Saga": "Activity for this Saga",
  // Servidores
  "Servidores MCP": "MCP servers",
  // Download toast
  "A descarregar": "Downloading",
  "descarregado": "downloaded",
};
