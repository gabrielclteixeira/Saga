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
  "Workspace (skills, playbooks, workflows)": "Workspace (skills, playbooks, workflows)",
  "Atividade (ações)": "Activity (actions)",
  "Modelos (instalar/configurar)": "Models (install/configure)",
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
  "Subagentes": "Subagents",
  "Pesquisar": "Search",
  "Think": "Think",
  "Regenerar": "Regenerate",
  "Perguntar ao Claude": "Ask Claude",
  "Relatório": "Report",
  "Fontes ({n})": "Sources ({n})",
  "raciocínio": "reasoning",
  "a raciocinar…": "reasoning…",
  "Correr": "Run",
  "Gerar com IA — descreve o que queres": "Generate with AI — describe what you want",
  "visão": "vision",
  "faz pesquisa web": "does web search",
  "raciocínio (não pesquisa)": "reasoning (no search)",
  "lê imagens": "reads images",
  "Para pesquisar, escolhe um modelo com ferramentas.": "For search, pick a model with tools.",
  "Subagentes (API: orquestra em paralelo · CLI: ferramenta Task)":
    "Subagents (API: orchestrate in parallel · CLI: Task tool)",
  "Pesquisa web (API: web_search · CLI: WebSearch)": "Web search (API: web_search · CLI: WebSearch)",
  "Extended thinking (raciocínio) — só Claude API": "Extended thinking — Claude API only",
  "Anexar imagem": "Attach image",
  "Adicionar imagem": "Add image",
  "+ Imagem": "+ Image",
  "O modelo ativo '{m}' não lê imagens e o modelo de visão '{v}' não está instalado. Troca para um modelo com visão (ex.: gemma4) ou instala-o em Modelos.":
    "The active model '{m}' can't read images and the vision model '{v}' isn't installed. Switch to a vision-capable model (e.g. gemma4) or install it in Models.",
  "Faz uma pergunta. Tarefas leves ficam no modelo local; só o que é pesado escala para o Claude.":
    "Ask a question. Light tasks stay on the local model; only heavy ones escalate to Claude.",
  "Faz uma pergunta. Corre no teu modelo local; escala para o Claude quando quiseres.":
    "Ask anything. It runs on your local model; escalate to Claude whenever you want.",
  "Regenerar a resposta": "Regenerate the answer",
  "⤴ Perguntar ao Claude": "⤴ Ask Claude",
  "Escalar esta resposta para o Claude": "Escalate this answer to Claude",
  "Deep research (Claude)": "Deep research (Claude)",
  "O Saga corre no teu modelo local. O Claude (CLI/subscrição) é opcional — liga-o para escalar tarefas mais pesadas quando quiseres. Podes mudar tudo depois nas Definições.":
    "Saga runs on your local model. Claude (CLI/subscription) is optional — connect it to escalate heavier tasks whenever you want. You can change everything later in Settings.",
  // Painel
  "Painel de tokens": "Token panel",
  "Memória carregada": "Loaded memory",
  "Atualizar pré-visualização": "Refresh preview",
  // Compactar / Limpar Saga
  "Compactar": "Compact",
  "Limpar": "Clear",
  "Contexto enviado ao modelo (estimativa)": "Context sent to the model (estimate)",
  "Resumir as mensagens antigas com o modelo local para poupar contexto":
    "Summarize older messages with the local model to save context",
  "Apagar as mensagens desta Saga": "Delete this Saga's messages",
  "tok no contexto": "tok in context",
  "Resumo do início desta conversa (contexto):": "Summary of the start of this conversation (context):",
  "Entendido — tenho o contexto anterior.": "Understood — I have the earlier context.",
  "▲ {n} mensagens compactadas — resumidas, fora do contexto enviado":
    "▲ {n} messages compacted — summarized, outside the sent context",
  "🔎 Fontes ({n})": "🔎 Sources ({n})",
  "A compactar…": "Compacting…",
  "Falha a compactar: ": "Failed to compact: ",
  "Apagar todas as mensagens desta Saga?": "Delete all messages in this Saga?",
  "Falha a limpar: ": "Failed to clear: ",
  "Ocultar painel": "Hide panel",
  "Mostrar painel": "Show panel",
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
  "Listar": "List",
  "Copiar": "Copy",
  "Editar": "Edit",
  "Remover": "Remove",
  "Renomear": "Rename",
  "Apagar": "Delete",
  "Testar ligação": "Test connection",
  "Atualizar": "Refresh",
  // Artefactos
  "Artefacto": "Artifact",
  "Galeria": "Gallery",
  "Código": "Code",
  "Pré-visualizar": "Preview",
  "Página": "Page",
  "Diagrama": "Diagram",
  "Documento": "Document",
  "Sem artefactos nesta Saga.": "No artifacts in this Saga.",
  "Erro a desenhar o diagrama: ": "Error drawing the diagram: ",
  "Falha a exportar: ": "Failed to export: ",
  "📄 Relatório": "📄 Report",
  // Settings — Modelo local
  "Modelo local": "Local model",
  "Provider": "Provider",
  "Endpoint": "Endpoint",
  "Modelo": "Model",
  "Modelo de visão (imagens)": "Vision model (images)",
  "API key (opcional)": "API key (optional)",
  "ex.: ID do modelo no LM Studio": "e.g. model ID in LM Studio",
  "ex.: ID no LM Studio": "e.g. ID in LM Studio",
  // Settings — Cloud
  "Cloud (escalar)": "Cloud (escalate)",
  "Modo": "Mode",
  "Desligado": "Off",
  "Claude CLI (subscrição)": "Claude CLI (subscription)",
  "API (ANTHROPIC_API_KEY)": "API (ANTHROPIC_API_KEY)",
  "API (key)": "API (key)",
  "Haiku 4.5 — rápido e barato": "Haiku 4.5 — fast and cheap",
  "Sonnet 4.6 — equilíbrio": "Sonnet 4.6 — balanced",
  "Opus 4.8 — topo": "Opus 4.8 — top tier",
  "Fable 5 — mais capaz": "Fable 5 — most capable",
  "Personalizado…": "Custom…",
  "Modelo (ID personalizado)": "Model (custom ID)",
  "Modelo (ID)": "Model (ID)",
  "Caminho da CLI": "CLI path",
  "API key": "API key",
  "Max tokens (resposta)": "Max tokens (response)",
  "Max tokens": "Max tokens",
  // Settings — Router
  "Router": "Router",
  "Router ativo": "Router enabled",
  "Usar classificador local (LEVE/PESADO)": "Use local classifier (LIGHT/HEAVY)",
  'Limite "leve" (chars)': '"Light" threshold (chars)',
  "Palavras-chave → local": "Keywords → local",
  "Palavras-chave → Claude": "Keywords → Claude",
  "Rondas de pesquisa (deep research)": "Research rounds (deep research)",
  // Settings — Pesquisa web
  "Pesquisa web (modelo local)": "Web search (local model)",
  "Dar pesquisa web ao modelo local (🔎 corre no Ollama)":
    "Give web search to the local model (🔎 runs on Ollama)",
  "Precisa de um modelo Ollama com suporte a ferramentas (ex.: llama3.1, qwen2.5). Com isto desligado, o 🔎 força o Claude.":
    "Requires an Ollama model with tool support (e.g. llama3.1, qwen2.5). With this off, 🔎 forces Claude.",
  "Motor": "Engine",
  "DuckDuckGo (sem chave)": "DuckDuckGo (no key)",
  "Tavily (chave — melhor qualidade)": "Tavily (key — better quality)",
  "DuckDuckGo (sem chave — pouco fiável)": "DuckDuckGo (no key — unreliable)",
  "DuckDuckGo (sem chave — recomendado)": "DuckDuckGo (no key — recommended)",
  "DuckDuckGo não precisa de chave e funciona logo; tem limites de ritmo (pode falhar em rajadas). Para mais fiabilidade/volume, escolhe um motor com chave.":
    "DuckDuckGo needs no key and works out of the box; it has rate limits (may fail in bursts). For more reliability/volume, choose a keyed engine.",
  "🔎 sem chave {p} → usa o DuckDuckGo (keyless, funciona com limites). Adiciona a chave {p} para mais fiabilidade/volume.":
    "🔎 no {p} key → using DuckDuckGo (keyless, works with limits). Add a {p} key for more reliability/volume.",
  "Tavily (chave grátis — recomendado)": "Tavily (free key — recommended)",
  "Tavily (recomendado)": "Tavily (recommended)",
  "Jina (recomendado)": "Jina (recommended)",
  "Chave {p}": "{p} key",
  "obter chave grátis": "get a free key",
  "Pesquisa fiável.": "Reliable search.",
  "Sem chave (DuckDuckGo) é pouco fiável e costuma devolver vazio. Escolhe um motor com chave para pesquisa fiável.":
    "Keyless (DuckDuckGo) is unreliable and often returns nothing. Choose a keyed engine for reliable search.",
  "Sem chave usa o DuckDuckGo, que costuma bloquear pesquisas automáticas (resultados vazios). Para pesquisa fiável, obtém uma chave grátis em tavily.com e cola-a aqui.":
    "Without a key it uses DuckDuckGo, which often blocks automated searches (empty results). For reliable search, get a free key at tavily.com and paste it here.",
  "Chave Tavily (opcional)": "Tavily key (optional)",
  // Settings — Modelo local avançado
  "Modelo local (avançado)": "Local model (advanced)",
  "Contexto (num_ctx)": "Context (num_ctx)",
  "Maior = o modelo lê mais (resultados de pesquisa + histórico). 8192 é um bom valor; usa mais RAM.":
    "Higher = the model reads more (search results + history). 8192 is a good value; uses more RAM.",
  "Temperatura": "Temperature",
  "Mais baixa (~0.4) = respostas mais factuais e menos divagantes.":
    "Lower (~0.4) = more factual, less rambling answers.",
  // Settings — Memória / Ferramentas
  "Memória": "Memory",
  "Pasta de memória": "Memory folder",
  "Caminho CLAUDE.md (opcional)": "CLAUDE.md path (optional)",
  "Ferramentas & Workspace (só modo API)": "Tools & Workspace (API mode only)",
  "Pasta do workspace (skills/playbooks/workflows)": "Workspace folder (skills/playbooks/workflows)",
  "Confirmação de ações": "Action confirmation",
  "Desligada — executa direto": "Off — run directly",
  "Dry-run — só pré-visualiza": "Dry-run — preview only",
  "Pedir aprovação a cada ação": "Ask for approval on each action",
  "Ativar ferramentas de browser": "Enable browser tools",
  "Caminho do sidecar (sidecar/index.js)": "Sidecar path (sidecar/index.js)",
  "Executável Node": "Node executable",
  "Pasta de dados do browser (sessão persistente)": "Browser data folder (persistent session)",
  // Settings — Aparência / Atualizações
  "Aparência": "Appearance",
  "Atualizações": "Updates",
  "Sistema": "System",
  "Iniciar com o sistema": "Start on login",
  "Mantém as automações agendadas a correr. Fechar a janela com automações ativas envia o Saga para a bandeja do sistema.":
    "Keeps scheduled automations running. Closing the window while automations are active sends Saga to the system tray.",
  "Falha a configurar o arranque: ": "Failed to set startup: ",
  "Idioma": "Language",
  "Português": "Portuguese",
  "English": "English",
  "Verificar atualizações": "Check for updates",
  "feito por": "made by",
  "Zoom da interface": "Interface zoom",
  "Reduzir zoom": "Zoom out",
  "Aumentar zoom": "Zoom in",
  "Tamanho do texto": "Text size",
  "Texto menor": "Smaller text",
  "Texto maior": "Larger text",
  "Atalhos: <strong>Ctrl/⌘ +</strong>, <strong>Ctrl/⌘ −</strong>, <strong>Ctrl/⌘ 0</strong> (ou Ctrl/⌘ + roda do rato).":
    "Shortcuts: <strong>Ctrl/⌘ +</strong>, <strong>Ctrl/⌘ −</strong>, <strong>Ctrl/⌘ 0</strong> (or Ctrl/⌘ + mouse wheel).",
  "Ajusta só o texto das mensagens e do compositor (o zoom escala toda a interface).":
    "Adjusts only the message and composer text (zoom scales the whole interface).",
  // Workspace
  "Skills": "Skills",
  "Playbooks": "Playbooks",
  "Workflows": "Workflows",
  "Agents": "Agents",
  "Agent — uma persona com system prompt e predefinições; escolhe-a no composer para focar o modelo numa tarefa.":
    "Agent — a persona with a system prompt and defaults; pick it in the composer to focus the model on a task.",
  "Predefinições do agente": "Agent defaults",
  "Escalar para": "Escalate to",
  "Ferramentas (web, ficheiros)": "Tools (web, files)",
  "Pesquisa aprofundada": "Deep research",
  "System prompt (markdown)": "System prompt (markdown)",
  "És um… (define o papel, o estilo e as regras do agente)":
    "You are a… (define the agent's role, style and rules)",
  "Escolher um agente (persona)": "Pick an agent (persona)",
  "Agente": "Agent",
  "Agente ativo: {n}": "Agent active: {n}",
  "Falha a carregar o agente: ": "Failed to load agent: ",
  "Nenhum (modelo base)": "None (base model)",
  "Cria agentes no Workspace → Agents.": "Create agents in Workspace → Agents.",
  "Skill — instruções que o modelo carrega sozinho quando a tarefa encaixa (auto-expostas via load_skill).":
    "Skill — instructions the model loads on its own when the task fits (auto-surfaced via load_skill).",
  "Playbook — um procedimento reutilizável que o modelo lê a pedido (read_playbook).":
    "Playbook — a reusable procedure the model reads on demand (read_playbook).",
  "Workflow — um procedimento executável: corre-o com /<nome> e o agente segue os passos.":
    "Workflow — a runnable procedure: run it with /<name> and the agent follows the steps.",
  "Nome": "Name",
  "Descrição": "Description",
  "Fechar editor": "Close editor",
  "✨ Gerar com IA — descreve o que queres": "✨ Generate with AI — describe what you want",
  "ex.: uma skill que resume páginas web": "e.g. a skill that summarizes web pages",
  "nome-sem-espacos": "name-without-spaces",
  "o que é / quando usar": "what it is / when to use",
  "Triggers (palavras que ativam)": "Triggers (activation words)",
  "resumir, o que diz este link, …": "summarize, what does this link say, …",
  "Argumentos esperados": "Expected arguments",
  "ex.: o URL a abrir": "e.g. the URL to open",
  "Corpo (markdown)": "Body (markdown)",
  "# Instruções…": "# Instructions…",
  "Nada ainda. Cria o primeiro com “+ Novo”.": "Nothing yet. Create the first one with “+ New”.",
  "▶ Correr": "▶ Run",
  "Procedimento (markdown)": "Procedure (markdown)",
  "Passos (markdown — usa $ARGUMENTS)": "Steps (markdown — use $ARGUMENTS)",
  "Instruções (markdown)": "Instructions (markdown)",
  "Passos a executar (usa $ARGUMENTS para os argumentos)…":
    "Steps to run (use $ARGUMENTS for the arguments)…",
  "Instruções passo a passo…": "Step-by-step instructions…",
  "Procedimento reutilizável…": "Reusable procedure…",
  "Falha a abrir: ": "Failed to open: ",
  "Descreve o que queres.": "Describe what you want.",
  "A gerar…": "Generating…",
  "✓ Gerado — revê e guarda": "✓ Generated — review and save",
  "Indica um nome (sem espaços).": "Enter a name (no spaces).",
  "Falha a guardar: ": "Failed to save: ",
  "Apagar “{name}”?": "Delete “{name}”?",
  "Falha a apagar: ": "Failed to delete: ",
  // Servidores MCP
  "Servidores MCP": "MCP servers",
  "A Saga liga-se a servidores MCP (stdio) e o modelo pode chamar as ferramentas deles. Os segredos do env são guardados na keychain do sistema.":
    "Saga connects to MCP servers (stdio) and the model can call their tools. The env secrets are stored in the system keychain.",
  "Novo servidor": "New server",
  "Editar servidor": "Edit server",
  "ex.: filesystem": "e.g. filesystem",
  "Comando": "Command",
  "ex.: npx": "e.g. npx",
  "Argumentos (um por linha)": "Arguments (one per line)",
  "Env (KEY=VALUE, um por linha)": "Env (KEY=VALUE, one per line)",
  "Ativo": "Enabled",
  "Guardar servidor": "Save server",
  "Sem servidores. Adiciona um abaixo.": "No servers. Add one below.",
  "Nome e comando são obrigatórios.": "Name and command are required.",
  "Remover este servidor?": "Remove this server?",
  "Indica o comando.": "Enter the command.",
  "A ligar…": "Connecting…",
  "✓ {n} ferramentas: {list}": "✓ {n} tools: {list}",
  "(nenhuma)": "(none)",
  "Falha: ": "Error: ",
  // Atividade
  "Atividade desta Saga": "Activity for this Saga",
  "Sem Saga selecionada.": "No Saga selected.",
  "Sem ações registadas nesta Saga.": "No actions logged in this Saga.",
  // Automações
  "Automações agendadas": "Scheduled automations",
  "Corre um workflow num horário. As ações são executadas automaticamente e registadas; o resultado vai para a Saga \"Automações\" + notificação. Só corre com a app aberta.":
    "Runs a workflow on a schedule. Actions are executed automatically and logged; the result goes to the \"Automations\" Saga + a notification. Only runs while the app is open.",
  "Novo agendamento": "New schedule",
  "Editar agendamento": "Edit schedule",
  "ex.: Login diário": "e.g. Daily login",
  "Workflow": "Workflow",
  "Argumentos": "Arguments",
  "(opcional)": "(optional)",
  "Frequência": "Frequency",
  "Todos os dias às 9h": "Every day at 9am",
  "Dias úteis às 9h": "Weekdays at 9am",
  "De hora a hora": "Hourly",
  "A cada 5 minutos": "Every 5 minutes",
  "Personalizado (cron)…": "Custom (cron)…",
  "Expressão cron": "Cron expression",
  "Guardar agendamento": "Save schedule",
  "(sem workflows — cria um no Workspace)": "(no workflows — create one in Workspace)",
  "Sem agendamentos. Cria um abaixo.": "No schedules. Create one below.",
  "próx:": "next:",
  "Nome, workflow e cron são obrigatórios.": "Name, workflow and cron are required.",
  "Remover este agendamento?": "Remove this schedule?",
  "A correr…": "Running…",
  // Hub Modelos
  "Avançado": "Advanced",
  "Provider local": "Local provider",
  "Modelos Ollama instalados": "Installed Ollama models",
  "Modelos Ollama": "Ollama models",
  "Procurar modelos (ollama.com)": "Search models (ollama.com)",
  "ex.: gemma, qwen, llama…": "e.g. gemma, qwen, llama…",
  "A procurar…": "Searching…",
  "Não foi possível contactar o ollama.com.": "Couldn't reach ollama.com.",
  "Sem resultados.": "No results.",
  "Instalados": "Installed",
  "Instalar por nome": "Install by name",
  "Modelos LM Studio": "LM Studio models",
  "Procurar catálogo (lmstudio.ai)": "Search catalog (lmstudio.ai)",
  "ex.: gemma, qwen, gpt-oss…": "e.g. gemma, qwen, gpt-oss…",
  "Instalar por id / URL HuggingFace": "Install by id / HuggingFace URL",
  "Descarregados": "Downloaded",
  "Instalar": "Install",
  "Instalar um modelo": "Install a model",
  "Tamanhos": "Sizes",
  "Clica num tamanho para instalar:": "Click a size to install:",
  "Usar id": "Use id",
  "Todas as variantes": "All variants",
  "Instalar um modelo (Ollama)": "Install a model (Ollama)",
  "Os modelos descarregam-se na app do LM Studio. Aqui escolhes um já descarregado.":
    "Models are downloaded in the LM Studio app. Here you pick one already downloaded.",
  "Descarregados (LM Studio)": "Downloaded (LM Studio)",
  "Temperatura automática (recomendada do modelo)": "Automatic temperature (model recommended)",
  "Auto deixa cada modelo usar a amostragem afinada do seu Modelfile (melhor por modelo). Desliga para forçar um valor.":
    "Auto lets each model use its Modelfile's tuned sampling (best per model). Turn off to force a value.",
  "Otimizar o Ollama (servidor)": "Optimize Ollama (server)",
  "Acelera o Ollama e poupa VRAM (flash attention + cache KV menor — permite contexto maior na tua GPU). Define no servidor do Ollama e reinicia-o.":
    "Speeds up Ollama and saves VRAM (flash attention + smaller KV cache — fits more context on your GPU). Set these on the Ollama server and restart it.",
  "Copiar comandos": "Copy commands",
  "Comandos copiados.": "Commands copied.",
  "Ir para a mensagem mais recente": "Jump to latest message",
  "Diagnóstico / Logs": "Diagnostics / Logs",
  "Abrir pasta de logs": "Open logs folder",
  "Copiar caminho": "Copy path",
  "Se a app falhar, abre/partilha o ficheiro Saga.log desta pasta.":
    "If the app fails, open/share the Saga.log file in this folder.",
  "Falha a abrir os logs: ": "Failed to open logs: ",
  "Caminho copiado.": "Path copied.",
  "Pesquisas web (este mês)": "Web searches (this month)",
  "Ainda sem pesquisas este mês.": "No searches yet this month.",
  "sem limite fixo": "no fixed limit",
  "ver quota no motor": "check engine quota",
  "Contagem local (o que a Saga gastou); a quota real está no painel do motor.":
    "Local count (what Saga used); the real quota is in the engine's dashboard.",
  "🔎 falta a chave {p}: adiciona-a em Modelos → Avançado para pesquisa fiável (sem chave usa o DuckDuckGo, pouco fiável).":
    "🔎 missing {p} key: add it in Models → Advanced for reliable search (without a key it uses DuckDuckGo, unreliable).",
  "A carregar…": "Loading…",
  "Sem variantes.": "No variants.",
  "Não foi possível obter as variantes.": "Couldn't load variants.",
  "Pesquisa o catálogo do LM Studio (lmstudio.ai) ou instala por id abaixo.":
    "Search the LM Studio catalog (lmstudio.ai), or install by id below.",
  "Abre a página para confirmar o id; “Usar id” preenche o campo de instalação abaixo.":
    "Open the page to confirm the id; “Use id” fills the install field below.",
  "Usar": "Use",
  "LM Studio inacessível — abre a app e liga o servidor (Developer).":
    "LM Studio unreachable — open the app and start the server (Developer tab).",
  "Nenhum modelo no LM Studio. Instala um abaixo.": "No models in LM Studio. Install one below.",
  "Abre a página para copiar o id e instalar abaixo.":
    "Open the page to copy the id, then install below.",
  "Não foi possível contactar o lmstudio.ai.": "Couldn't reach lmstudio.ai.",
  "Embeddings": "Embeddings",
  "Instalar modelo": "Install model",
  "ex.: llama3.2": "e.g. llama3.2",
  "ativo": "active",
  "Recomendado para a tua máquina": "Recommended for your machine",
  "Não sabes qual escolher?": "Not sure which to pick?",
  "A tua máquina": "Your machine",
  "sugestão": "suggestion",
  "Escolhe pela memória da tua placa gráfica (VRAM) — ou pela RAM se não tiveres GPU:":
    "Pick by your graphics card memory (VRAM) — or by RAM if you have no GPU:",
  "Instalar e usar": "Install & use",
  "Máquina fraca ou sem GPU": "Low-end machine or no GPU",
  "Sem GPU (CPU) ou GPU pequena (~8 GB)": "No GPU (CPU) or small GPU (~8 GB)",
  "GPU média (~12 GB)": "Mid-range GPU (~12 GB)",
  "GPU grande (16 GB+)": "Large GPU (16 GB+)",
  "leve — corre em quase qualquer máquina": "lightweight — runs on almost anything",
  "rápido e com ferramentas/web": "fast, with tools/web",
  "melhor equilíbrio": "best balance",
  "mais capaz (ou qwen3:32b)": "more capable (or qwen3:32b)",
  "multimodal: lê imagens, ferramentas e raciocínio": "multimodal: reads images, tools and reasoning",
  "MoE rápido e multimodal (ou qwen3:32b)": "fast MoE, multimodal (or qwen3:32b)",
  "🛠 faz pesquisa web · 🧠 raciocínio (não pesquisa) · 👁 lê imagens. Para o 🔎 funcionar, escolhe um modelo 🛠.":
    "🛠 does web search · 🧠 reasoning (no search) · 👁 reads images. For 🔎 to work, pick a 🛠 model.",
  "não consegui ler a RAM — sugestão equilibrada": "couldn't read the RAM — balanced suggestion",
  "RAM limitada — modelo pequeno e rápido": "limited RAM — small, fast model",
  "RAM média — 7-8B com ferramentas é confortável": "medium RAM — 7-8B with tools is comfortable",
  "boa RAM — 14B é viável": "good RAM — 14B is viable",
  "muita RAM — podes ir além (ex.: 32B)": "plenty of RAM — you can go bigger (e.g. 32B)",
  "✓ Guardado": "✓ Saved",
  "⚠ '{m}' é pequeno — respostas e pesquisa web podem falhar; experimenta llama3.1 ou qwen2.5.":
    "⚠ '{m}' is small — answers and web search may fail; try llama3.1 or qwen2.5.",
  "Ollama ligado · {n} modelos": "Ollama connected · {n} models",
  "Ollama não acessível — instala em ollama.com e confirma o endpoint":
    "Ollama not reachable — install from ollama.com and check the endpoint",
  "Sem modelos. Puxa um abaixo.": "No models. Pull one below.",
  'Apagar o modelo "{name}"?': 'Delete the model "{name}"?',
  "Catálogo — clica para descarregar": "Catalog — click to download",
  "🛠 ferramentas/web · 👁 visão · 🧠 raciocínio": "🛠 tools/web · 👁 vision · 🧠 reasoning",
  "Ferramentas / pesquisa web": "Tools / web search",
  "Visão (imagens)": "Vision (images)",
  "⚠ '{m}' não chama ferramentas — a pesquisa web não funciona; usa um modelo 🛠 (ex.: qwen3, llama3.1).":
    "⚠ '{m}' can't call tools — web search won't work; use a 🛠 model (e.g. qwen3, llama3.1).",
  "🔎 não vai pesquisar: ativa a Pesquisa web (Modelos → Avançado) para o modelo local pesquisar.":
    "🔎 won't search: enable Web search (Models → Advanced) so the local model can search.",
  "🔎 vai usar o Claude. Para pesquisar com o modelo local, ativa a Pesquisa web em Modelos → Avançado.":
    "🔎 will use Claude. To search with the local model, enable Web search in Models → Advanced.",
  "🔎 pode não pesquisar: '{m}' não chama ferramentas — usa qwen3/llama3.1.":
    "🔎 may not search: '{m}' can't call tools — use qwen3/llama3.1.",
  "🔎 pode não pesquisar: '{m}' não chama ferramentas — usa qwen3 ou llama3.1.":
    "🔎 may not search: '{m}' can't call tools — use qwen3 or llama3.1.",
  "🔎 o Gemma chama ferramentas de forma inconsistente — pode responder sem pesquisar. Para pesquisa fiável, usa qwen3 ou llama3.1.":
    "🔎 Gemma calls tools inconsistently — it may answer without searching. For reliable search, use qwen3 or llama3.1.",
  "🔎 sem fontes: o modelo respondeu sem pesquisar (modelos médios nem sempre chamam ferramentas). Para pesquisa fiável, usa qwen3/llama3.1 ou adiciona uma chave de motor.":
    "🔎 no sources: the model answered without searching (mid-size models don't always call tools). For reliable search, use qwen3/llama3.1 or add an engine key.",
  "🔎 não pesquisa com o LM Studio — usa o Ollama ou ativa o Claude.":
    "🔎 can't search with LM Studio — use Ollama or enable Claude.",
  "🔎 pode não pesquisar: '{m}' não chama ferramentas — usa qwen3/llama3.1/gemma4.":
    "🔎 may not search: '{m}' can't call tools — use qwen3/llama3.1/gemma4.",
  "🔎 sem chave: configura um motor de pesquisa (Tavily/Brave/…) em Modelos → Avançado para resultados fiáveis.":
    "🔎 no key: set a search engine (Tavily/Brave/…) in Models → Advanced for reliable results.",
  "Geral + ferramentas/web": "General + tools/web",
  "Pequenos / rápidos": "Small / fast",
  "Raciocínio": "Reasoning",
  "Visão": "Vision",
  "ferramentas/web": "tools/web",
  "Indica um modelo (ex.: llama3.2)": "Enter a model (e.g. llama3.2)",
  "A iniciar descarga…": "Starting download…",
  "✓ Descarregado": "✓ Downloaded",
  "Falha a listar modelos do Ollama: ": "Failed to list Ollama models: ",
  // Download toast
  "A descarregar": "Downloading",
  "descarregado": "downloaded",
  // Wizard
  "Bem-vindo ao Saga ⛵": "Welcome to Saga ⛵",
  "O Saga corre um modelo local para tarefas leves e escala para o Claude quando compensa. Vamos configurar o que precisas — podes mudar tudo depois nas Definições.":
    "Saga runs a local model for light tasks and escalates to Claude when it's worth it. Let's set up what you need — you can change everything later in Settings.",
  "Modelo local (Ollama)": "Local model (Ollama)",
  "A verificar…": "Checking…",
  "Sem Ollama? Instala em <strong>ollama.com</strong> e corre <code>ollama pull llama3.2</code>.":
    "No Ollama? Install from <strong>ollama.com</strong> and run <code>ollama pull llama3.2</code>.",
  "Testar ligações": "Test connections",
  "Começar a usar": "Get started",
  "Saltar por agora": "Skip for now",
  "Um assistente que corre no teu próprio computador. Sem contas, sem subscrição obrigatória — as tuas conversas ficam contigo.":
    "An assistant that runs on your own computer. No accounts, no mandatory subscription — your conversations stay with you.",
  "Local primeiro": "Local first",
  "As respostas saem do modelo que corres em casa, via Ollama.":
    "Answers come from the model you run at home, via Ollama.",
  "Pesquisa na web": "Web search",
  "Modelos com ferramentas conseguem procurar e ler páginas online.":
    "Models with tools can search and read pages online.",
  "Claude opcional": "Claude optional",
  "Liga o Claude para escalar tarefas pesadas — só quando quiseres.":
    "Connect Claude to escalate heavy tasks — only when you want to.",
  "Escolhe o teu modelo": "Choose your model",
  "Configuração manual": "Manual setup",
  "Modelo ativo": "Active model",
  "Liga o Claude (opcional)": "Connect Claude (optional)",
  "Podes saltar isto e ficar 100% local. Liga o Claude mais tarde nas Definições se precisares de mais potência.":
    "You can skip this and stay 100% local. Connect Claude later in Settings if you need more power.",
  "Desligado (só local)": "Off (local only)",
  "Desligado — só modelo local.": "Off — local model only.",
  "Anterior": "Back",
  "Saltar configuração": "Skip setup",
  "Seguinte": "Next",
  "Percebi": "Got it",
  "Aqui ficam os Modelos, Workspace e Automações.":
    "Models, Workspace and Automations live here.",
  "Escreve a tua pergunta aqui. Boa viagem! ⛵":
    "Type your question here. Bon voyage! ⛵",
  "Resume este artigo: <cola um link>": "Summarize this article: <paste a link>",
  "Escreve um e-mail breve a recusar uma reunião":
    "Write a short email declining a meeting",
  "Explica o que faz este código": "Explain what this code does",
  "✓ Ollama ligado — {n} modelo(s)": "✓ Ollama connected — {n} model(s)",
  " · modelo configurado não encontrado": " · configured model not found",
  "✗ Ollama não detetado neste endpoint": "✗ Ollama not detected at this endpoint",
  // Mensagens / ações dinâmicas
  "🧠 raciocínio": "🧠 reasoning",
  "✎ Editar": "✎ Edit",
  "Editar e reenviar": "Edit and resend",
  "↻ Regenerar": "↻ Regenerate",
  "Regenerar com a mesma rota": "Regenerate with the same route",
  "⤴ Claude": "⤴ Claude",
  "Escalar para o Claude": "Escalate to Claude",
  "Modelo ▾": "Model ▾",
  "Tentar local": "Try local",
  "Cancelar e voltar": "Cancel and return",
  "Guardar e reenviar": "Save and resend",
  "(sem memória — define a pasta nas definições)": "(no memory — set the folder in settings)",
  "Nova conversa": "New conversation",
  "Sem resultados": "No results",
  // Passos de ferramentas
  "a pesquisar": "searching",
  "a abrir": "opening",
  "a criar PDF": "creating PDF",
  // Estados de espera
  "A pesquisar na net…": "Searching the web…",
  "A coordenar subagentes…": "Coordinating subagents…",
  "A pensar a fundo…": "Thinking deeply…",
  "A pensar…": "Thinking…",
  // Contabilidade
  "Pedidos locais": "Local requests",
  "grátis": "free",
  "Pedidos Claude": "Claude requests",
  "Tokens servidos localmente": "Tokens served locally",
  "que não foram ao Claude": "that didn't go to Claude",
  "Tokens poupados (compressão)": "Tokens saved (compression)",
  "Tokens Claude": "Claude tokens",
  "Custo Claude": "Claude cost",
  "tok poupados": "tok saved",
  "Custo acumulado no Claude": "Cumulative Claude cost",
  // Menu "/" — tokens dos comandos (têm de bater com o que o utilizador escreve)
  "pesquisar": "search",
  "subagentes": "subagents",
  "modelos": "models",
  "definicoes": "settings",
  "Criar skill com IA — /skill <descrição>": "Create skill with AI — /skill <description>",
  "Criar playbook com IA — /playbook <descrição>": "Create playbook with AI — /playbook <description>",
  "Criar workflow com IA — /workflow <descrição>": "Create workflow with AI — /workflow <description>",
  "Rota: Auto": "Route: Auto",
  "Rota: Local": "Route: Local",
  "Rota: Claude": "Route: Claude",
  "Toggle: 🧠 Think": "Toggle: 🧠 Think",
  "Toggle: 🔎 Pesquisar": "Toggle: 🔎 Search",
  "Toggle: 🧩 Subagentes": "Toggle: 🧩 Subagents",
  "Abrir Modelos": "Open Models",
  "Abrir Definições": "Open Settings",
  "Correr workflow: {w}": "Run workflow: {w}",
  // Exportar Saga
  "Falha a ler a Saga: ": "Failed to read the Saga: ",
  "Tu": "You",
  // Atualizações (runtime)
  "Falha a guardar definições: ": "Failed to save settings: ",
  "Estás na versão mais recente.": "You're on the latest version.",
  "A descarregar atualização {v}…": "Downloading update {v}…",
  "Atualização {v} instalada.": "Update {v} installed.",
  "Reiniciar": "Restart",
  "Mais tarde": "Later",
  "Nova versão {v} — a descarregar…": "New version {v} — downloading…",
  "Instalado. A reiniciar…": "Installed. Restarting…",
  "Auto-update ainda não está ativo (instaladores sem assinatura). Descarrega a versão mais recente em github.com/gabrielclteixeira/Saga/releases.":
    "Auto-update isn't active yet (unsigned installers). Download the latest version at github.com/gabrielclteixeira/Saga/releases.",
  "Não foi possível verificar atualizações: ": "Couldn't check for updates: ",
  "Não foi possível contactar o servidor de atualizações. Verifica a ligação e tenta de novo.":
    "Couldn't reach the update server. Check your connection and try again.",
  // Aprovação de ações
  "Aprovar ação?": "Approve action?",
  "Recusar": "Decline",
  "Aprovar": "Approve",
  // Placeholders técnicos
  "ex.: gpt-4o": "e.g. gpt-4o",
};
