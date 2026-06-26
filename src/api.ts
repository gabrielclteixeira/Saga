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

export interface RoutingConfig {
  enabled: boolean;
  light_max_chars: number;
  force_local_keywords: string[];
  force_claude_keywords: string[];
  use_local_classifier: boolean;
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
  claude_mode: "off" | "cli" | "api";
  claude_api_key: string;
  claude_model: string;
  claude_cli_path: string;
  claude_max_tokens: number;
  thinking_budget: number;
  local_provider: "ollama" | "openai";
  openai_local_endpoint: string;
  openai_local_key: string;
  openai_local_model: string;
  cloud_provider: "claude" | "openai";
  openai_cloud_endpoint: string;
  openai_cloud_key: string;
  openai_cloud_model: string;
  routing: RoutingConfig;
  memory_dir: string;
  claude_md_path: string;
  enable_browser_tools: boolean;
  browser_sidecar_script: string;
  browser_node_path: string;
  browser_user_data_dir: string;
  mcp_servers: McpServerConfig[];
  workspace_dir: string;
  confirm_mode: "off" | "dry_run" | "ask";
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
  resetAccounting: () => invoke<Accounting>("reset_accounting"),
  getMemoryPreview: () => invoke<string>("get_memory_preview"),
  diagnostics: () => invoke<Diagnostics>("diagnostics"),
  listOllamaModels: () => invoke<string[]>("list_ollama_models"),
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
  // MCP
  testMcpServer: (config: McpServerConfig) =>
    invoke<string[]>("test_mcp_server", { config }),
  // Export
  exportFile: (path: string, content: string) =>
    invoke<void>("export_file", { path, content }),
  // Workspace
  getWorkspaceIndex: () => invoke<WorkspaceIndex>("get_workspace_index"),
  readWorkspaceDoc: (kind: string, name: string) =>
    invoke<string>("read_workspace_doc", { kind, name }),
  saveWorkspaceDoc: (kind: string, name: string, content: string) =>
    invoke<void>("save_workspace_doc", { kind, name, content }),
  deleteWorkspaceDoc: (kind: string, name: string) =>
    invoke<void>("delete_workspace_doc", { kind, name }),
  // Atividade + aprovações
  getActionLog: (conversationId: number) =>
    invoke<ActionLogEntry[]>("get_action_log", { conversationId }),
  approveAction: (id: number, approved: boolean) =>
    invoke<void>("approve_action", { id, approved }),
};
