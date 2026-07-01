import { invoke, Channel } from "@tauri-apps/api/core";

export interface Attachment {
  kind: "image" | "document";
  media_type: string;
  data_base64: string; // dados da imagem; vazio em documentos
  name?: string; // nome do ficheiro (documentos)
  text?: string; // texto extraído (documentos)
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: Attachment[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: [string, string][];
  enabled: boolean;
}

export interface Settings {
  ollama_endpoint: string;
  ollama_model: string;
  ollama_vision_model: string;
  ollama_num_ctx: number;
  ollama_temperature: number;
  ollama_temperature_auto: boolean;
  claude_mode: "off" | "cli" | "api";
  claude_api_key: string;
  claude_model: string;
  claude_cli_path: string;
  claude_max_tokens: number;
  thinking_budget: number;
  research_max_rounds: number;
  local_provider: "ollama" | "openai";
  openai_local_endpoint: string;
  openai_local_key: string;
  openai_local_model: string;
  cloud_provider: "claude" | "openai";
  openai_cloud_endpoint: string;
  openai_cloud_key: string;
  openai_cloud_model: string;
  memory_dir: string;
  claude_md_path: string;
  enable_browser_tools: boolean;
  browser_sidecar_script: string;
  browser_node_path: string;
  browser_user_data_dir: string;
  mcp_servers: McpServerConfig[];
  workspace_dir: string;
  confirm_mode: "off" | "dry_run" | "ask";
  clarify_level: "off" | "light" | "medium" | "high";
  local_web_search: boolean;
  web_search_provider: "duckduckgo" | "tavily" | "brave" | "serper" | "exa" | "jina";
  web_search_keys: Record<string, string>;
  onboarding_done: boolean;
}

export interface DocMeta {
  name: string;
  description: string;
  enabled: boolean;
  topic: string; // "" = global; senão restrito a esse tópico
}

export interface WorkspaceIndex {
  skills: DocMeta[];
  playbooks: DocMeta[];
  workflows: DocMeta[];
  agents: DocMeta[];
}

export interface Schedule {
  id: number;
  name: string;
  workflow_name: string;
  arguments: string;
  cron: string;
  enabled: boolean;
  last_run_at: string;
  next_run_epoch: number;
  last_status: string;
  last_error: string;
  model: string; // "" = default da rota
}

export interface ActionLogEntry {
  id: number;
  conversation_id: number;
  tool: string;
  params_json: string;
  status: string;
  detail: string;
  error: string;
  created_at: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  family: string;
  parameter_size: string;
  quantization: string;
}

export interface RegistryModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

export interface RegistryTag {
  name: string; // nome completo, ex.: "gemma4:26b-a4b-it-qat"
  size: string; // ex.: "16GB" (vazio para tags cloud)
  context: string; // ex.: "256K"
}

export interface LmModel {
  id: string;
  kind: string;
  arch: string;
  quantization: string;
  state: string;
}

export interface SearchUsage {
  provider: string;
  count: number;
}

export interface SystemInfo {
  total_ram_gb: number;
  total_vram_gb: number;
  cpu_cores: number;
  recommended: string;
  note: string;
}

export interface Diagnostics {
  ollama_ok: boolean;
  ollama_models: string[];
  ollama_model_present: boolean;
  claude_mode: string;
  claude_ready: boolean;
  claude_detail: string;
}

export interface ClaudeCliModelsResult {
  models: string[];
  raw: string;
  scratch_dir: string;
}

export interface Accounting {
  local_requests: number;
  claude_requests: number;
  claude_input_tokens: number;
  claude_output_tokens: number;
  tokens_served_local: number;
  tokens_saved_compression: number;
  claude_cost_usd: number;
}

export interface ChatResponse {
  text: string;
  route: "local" | "claude";
  model: string;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
  cost_usd: number;
  reason: string;
  gen_ms?: number;
  intent?: string;
  thinkLevel?: string;
  confidence?: number | null;
  accounting: Accounting;
}

export interface ConversationMeta {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  topic_id: number | null;
}

export interface Topic {
  id: number;
  name: string;
  brief: string;
  notes: string;
  folder_path: string;
  permission_mode: string; // "read" | "ask"
  distill_hint: string; // JSON {type,name,reason} de uma dica de destilação pendente; "" = nenhuma
}

export interface DistillProposal {
  found: boolean;
  doc_type: string; // "skill" | "playbook" | "workflow"
  name: string;
  description: string;
  reason: string;
  body: string;
}

export interface Compaction {
  summary: string;
  upto: number;
}

export interface CompactResult {
  summary: string;
  upto: number;
  messages_compacted: number;
}

export interface SearchHit {
  conversation_id: number;
  title: string;
  snippet: string;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  attachments_json: string;
  route: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tokens_saved: number;
  gen_ms: number;
  steps_json: string;
  version_group_id: number;
  version_count: number;
  version_index: number;
}

export type PullEvent =
  | { kind: "Progress"; status: string; percent: number }
  | { kind: "Done" }
  | { kind: "Error"; message: string };

export type StreamEvent =
  | { kind: "Start"; route: "local" | "claude"; model: string; reason: string }
  | { kind: "Delta"; text: string }
  | { kind: "Thinking"; text: string }
  | { kind: "ToolStep"; tool: string; detail: string }
  | { kind: "ApprovalRequest"; id: number; tool: string; preview: string }
  | { kind: "Clarify"; id: number; questions: string[] }
  | { kind: "Plan"; id: number; steps: string[]; needs_web: boolean; research: boolean }
  | { kind: "PlanStep"; index: number; status: string }
  | {
      kind: "Done";
      message_id: number;
      version_group_id: number;
      version_count: number;
      version_index: number;
      input_tokens: number;
      output_tokens: number;
      tokens_saved: number;
      cost_usd: number;
      gen_ms: number;
      intent: string;
      think_level: string;
      confidence: number | null;
      accounting: Accounting;
    };

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  getAccounting: () => invoke<Accounting>("get_accounting"),
  // Diagnóstico / logs
  logFrontend: (level: "error" | "warn" | "info", message: string) =>
    invoke<void>("log_frontend", { level, message }),
  logDir: () => invoke<string>("log_dir"),
  extractFileText: (name: string, dataBase64: string) =>
    invoke<string>("extract_file_text", { name, dataBase64 }),
  attachmentFromPath: (path: string) =>
    invoke<Attachment>("attachment_from_path", { path }),
  warmModel: (model?: string) =>
    invoke<void>("warm_model", { model: model ?? null }),
  optimizeOllama: () => invoke<void>("optimize_ollama"),
  revertOllama: () => invoke<void>("revert_ollama_opt"),
  openLogs: () => invoke<void>("open_logs"),
  claudeCliModelsScratchDir: () => invoke<string>("claude_cli_models_scratch_dir"),
  openProjectFolder: (topicId: number) => invoke<void>("open_project_folder", { topicId }),
  listProjectFiles: (topicId: number) => invoke<string[]>("list_project_files", { topicId }),
  readProjectFileRaw: (topicId: number, path: string) =>
    invoke<string>("read_project_file_raw", { topicId, path }),
  startProjectWatch: (topicId: number, onEvent: () => void): Promise<void> => {
    const channel = new Channel<{ kind: "Changed" }>();
    channel.onmessage = () => onEvent();
    return invoke<void>("start_project_watch", { topicId, channel });
  },
  stopProjectWatch: (topicId: number) => invoke<void>("stop_project_watch", { topicId }),
  refreshClaudeCliModels: () => invoke<ClaudeCliModelsResult>("refresh_claude_cli_models"),
  resetAccounting: () => invoke<Accounting>("reset_accounting"),
  getMemoryPreview: () => invoke<string>("get_memory_preview"),
  diagnostics: () => invoke<Diagnostics>("diagnostics"),
  listOllamaModels: () => invoke<string[]>("list_ollama_models"),
  systemInfo: () => invoke<SystemInfo>("system_info"),
  getSearchUsage: () => invoke<SearchUsage[]>("get_search_usage"),
  listOllamaModelsDetailed: () =>
    invoke<OllamaModel[]>("list_ollama_models_detailed"),
  searchOllamaRegistry: (query: string) =>
    invoke<RegistryModel[]>("search_ollama_registry", { query }),
  ollamaRegistryTags: (model: string) =>
    invoke<RegistryTag[]>("ollama_registry_tags", { model }),
  lmstudioList: () => invoke<LmModel[]>("lmstudio_list"),
  deleteOllamaModel: (model: string) =>
    invoke<void>("delete_ollama_model", { model }),
  pullOllamaModel: (
    model: string,
    onEvent: (ev: PullEvent) => void
  ): Promise<void> => {
    const channel = new Channel<PullEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("pull_ollama_model", { model, channel });
  },
  sendMessage: (messages: ChatMessage[]) =>
    invoke<ChatResponse>("send_message", { messages }),
  sendMessageStream: (
    conversationId: number,
    messages: ChatMessage[],
    onEvent: (ev: StreamEvent) => void,
    opts?: {
      routeOverride?: "local" | "claude";
      modelOverride?: string;
      regenerate?: boolean;
      thinkLevel?: string;
      research?: boolean;
      subagents?: boolean;
      plan?: boolean;
    }
  ): Promise<void> => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("send_message_stream", {
      conversationId,
      messages,
      channel,
      routeOverride: opts?.routeOverride ?? null,
      modelOverride: opts?.modelOverride ?? null,
      regenerate: opts?.regenerate ?? false,
      thinkLevel: opts?.thinkLevel ?? "off",
      research: opts?.research ?? false,
      subagents: opts?.subagents ?? false,
      plan: opts?.plan ?? false,
    });
  },
  cancelGeneration: (conversationId: number) =>
    invoke<void>("cancel_generation", { conversationId }),
  respondPlan: (id: number, approved: boolean, steps: string[], research: boolean) =>
    invoke<void>("respond_plan", { id, approved, steps, research }),
  respondClarify: (id: number, answered: boolean, answers: string[]) =>
    invoke<void>("respond_clarify", { id, answered, answers }),
  setMessageSteps: (messageId: number, steps: string[]) =>
    invoke<void>("set_message_steps", { messageId, steps }),
  listMessageVersions: (messageId: number) =>
    invoke<StoredMessage[]>("list_message_versions", { messageId }),
  setActiveVersion: (messageId: number) => invoke<void>("set_active_version", { messageId }),
  detectEmbedModel: () => invoke<string | null>("detect_embed_model"),
  listConversations: () => invoke<ConversationMeta[]>("list_conversations"),
  getConversation: (id: number) => invoke<StoredMessage[]>("get_conversation", { id }),
  newConversation: (title?: string, topicId?: number | null) =>
    invoke<number>("new_conversation", { title: title ?? null, topicId: topicId ?? null }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_conversation", { id, title }),
  deleteConversation: (id: number) => invoke<void>("delete_conversation", { id }),
  listTopics: () => invoke<Topic[]>("list_topics"),
  createTopic: (name: string) => invoke<number>("create_topic", { name }),
  renameTopic: (id: number, name: string) => invoke<void>("rename_topic", { id, name }),
  updateTopic: (
    id: number,
    brief: string,
    notes: string,
    folderPath: string,
    permissionMode: string
  ) => invoke<void>("update_topic", { id, brief, notes, folderPath, permissionMode }),
  deleteTopic: (id: number) => invoke<void>("delete_topic", { id }),
  setConversationTopic: (conversationId: number, topicId: number | null) =>
    invoke<void>("set_conversation_topic", { conversationId, topicId }),
  distillTopic: (
    topicId: number,
    draft: boolean,
    typeHint?: string,
    useCloud = false
  ) =>
    invoke<DistillProposal>("distill_topic", {
      topicId,
      draft,
      typeHint: typeHint ?? null,
      useCloud,
    }),
  dismissDistillHint: (topicId: number) =>
    invoke<void>("dismiss_distill_hint", { topicId }),
  projectSaveFile: (conversationId: number, path: string, content: string) =>
    invoke<string>("project_save_file", { conversationId, path, content }),
  searchChats: (query: string) => invoke<SearchHit[]>("search_chats", { query }),
  conversationAccounting: (id: number) =>
    invoke<Accounting>("get_conversation_accounting", { id }),
  truncateConversation: (id: number, keep: number) =>
    invoke<void>("truncate_conversation", { id, keep }),
  getCompaction: (id: number) => invoke<Compaction>("get_compaction", { id }),
  clearConversation: (id: number) => invoke<void>("clear_conversation", { id }),
  compactConversation: (id: number, keepLast: number) =>
    invoke<CompactResult>("compact_conversation", { id, keepLast }),
  // MCP
  testMcpServer: (config: McpServerConfig) =>
    invoke<string[]>("test_mcp_server", { config }),
  // Export
  exportFile: (path: string, content: string) =>
    invoke<void>("export_file", { path, content }),
  // Workspace
  ensureWorkspaceDefaults: (lang: string) =>
    invoke<void>("ensure_workspace_defaults", { lang }),
  getWorkspaceIndex: () => invoke<WorkspaceIndex>("get_workspace_index"),
  readWorkspaceDoc: (kind: string, name: string) =>
    invoke<string>("read_workspace_doc", { kind, name }),
  saveWorkspaceDoc: (kind: string, name: string, content: string) =>
    invoke<void>("save_workspace_doc", { kind, name, content }),
  generateDoc: (kind: string, instruction: string, useCloud = false) =>
    invoke<string>("generate_doc", { kind, instruction, useCloud }),
  deleteWorkspaceDoc: (kind: string, name: string) =>
    invoke<void>("delete_workspace_doc", { kind, name }),
  // Atividade + aprovações
  getActionLog: (conversationId: number) =>
    invoke<ActionLogEntry[]>("get_action_log", { conversationId }),
  approveAction: (id: number, approved: boolean) =>
    invoke<void>("approve_action", { id, approved }),
  // Automações agendadas
  listSchedules: () => invoke<Schedule[]>("list_schedules"),
  createSchedule: (
    name: string,
    workflowName: string,
    args: string,
    cron: string,
    enabled: boolean,
    model: string
  ) =>
    invoke<number>("create_schedule", {
      name,
      workflowName,
      arguments: args,
      cron,
      enabled,
      model,
    }),
  updateSchedule: (
    id: number,
    name: string,
    workflowName: string,
    args: string,
    cron: string,
    enabled: boolean,
    model: string
  ) =>
    invoke<void>("update_schedule", {
      id,
      name,
      workflowName,
      arguments: args,
      cron,
      enabled,
      model,
    }),
  deleteSchedule: (id: number) => invoke<void>("delete_schedule", { id }),
  runScheduleNow: (id: number) => invoke<string>("run_schedule_now", { id }),
  // Arranque com o sistema
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enable: boolean) => invoke<void>("set_autostart", { enable }),
};
