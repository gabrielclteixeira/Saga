import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RoutingConfig {
  enabled: boolean;
  light_max_chars: number;
  force_local_keywords: string[];
  force_claude_keywords: string[];
  use_local_classifier: boolean;
}

export interface Settings {
  ollama_endpoint: string;
  ollama_model: string;
  claude_mode: "off" | "cli" | "api";
  claude_api_key: string;
  claude_model: string;
  claude_cli_path: string;
  claude_max_tokens: number;
  routing: RoutingConfig;
  memory_dir: string;
  claude_md_path: string;
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

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  getAccounting: () => invoke<Accounting>("get_accounting"),
  resetAccounting: () => invoke<Accounting>("reset_accounting"),
  getMemoryPreview: () => invoke<string>("get_memory_preview"),
  listOllamaModels: () => invoke<string[]>("list_ollama_models"),
  sendMessage: (messages: ChatMessage[]) =>
    invoke<ChatResponse>("send_message", { messages }),
};
