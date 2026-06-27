import { invoke, Channel } from "@tauri-apps/api/core";

export interface Attachment {
  kind: "image";
  media_type: string;
  data_base64: string;
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
  local_web_search: boolean;
  web_search_provider: "duckduckgo" | "tavily" | "brave" | "serper" | "exa" | "jina";
  web_search_keys: Record<string, string>;
  onboarding_done: boolean;
}

export interface DocMeta {
  name: string;
  description: string;
}

export interface WorkspaceIndex {
  skills: DocMeta[];
  playbooks: string[];
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
  accounting: Accounting;
}

export interface ConversationMeta {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
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
  | {
      kind: "Done";
      input_tokens: number;
      output_tokens: number;
      tokens_saved: number;
      cost_usd: number;
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
  openLogs: () => invoke<void>("open_logs"),
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
      thinking?: boolean;
      research?: boolean;
      subagents?: boolean;
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
      thinking: opts?.thinking ?? false,
      research: opts?.research ?? false,
      subagents: opts?.subagents ?? false,
    });
  },
  listConversations: () => invoke<ConversationMeta[]>("list_conversations"),
  getConversation: (id: number) => invoke<StoredMessage[]>("get_conversation", { id }),
  newConversation: (title?: string) =>
    invoke<number>("new_conversation", { title: title ?? null }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_conversation", { id, title }),
  deleteConversation: (id: number) => invoke<void>("delete_conversation", { id }),
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
  generateDoc: (kind: string, instruction: string) =>
    invoke<string>("generate_doc", { kind, instruction }),
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
    enabled: boolean
  ) =>
    invoke<number>("create_schedule", {
      name,
      workflowName,
      arguments: args,
      cron,
      enabled,
    }),
  updateSchedule: (
    id: number,
    name: string,
    workflowName: string,
    args: string,
    cron: string,
    enabled: boolean
  ) =>
    invoke<void>("update_schedule", {
      id,
      name,
      workflowName,
      arguments: args,
      cron,
      enabled,
    }),
  deleteSchedule: (id: number) => invoke<void>("delete_schedule", { id }),
  runScheduleNow: (id: number) => invoke<string>("run_schedule_now", { id }),
  // Arranque com o sistema
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enable: boolean) => invoke<void>("set_autostart", { enable }),
};
