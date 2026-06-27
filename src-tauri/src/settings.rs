//! Definições persistidas da app (modelo local, modo Claude, regras do router, memória).

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub ollama_endpoint: String,
    pub ollama_model: String,
    /// Modelo de visão local (usado quando há imagens e a rota é local).
    pub ollama_vision_model: String,
    /// Janela de contexto do Ollama (num_ctx). Maior = lê mais (pesquisa/histórico).
    pub ollama_num_ctx: u32,
    /// Temperatura do Ollama (mais baixa = menos alucinação/divagação).
    pub ollama_temperature: f32,
    /// "api" | "cli" | "off"
    pub claude_mode: String,
    pub claude_api_key: String,
    pub claude_model: String,
    pub claude_cli_path: String,
    pub claude_max_tokens: u32,
    /// Orçamento de tokens para extended thinking (quando ligado no composer).
    pub thinking_budget: u32,
    /// Nº máximo de rondas de pesquisa iterativa (deep research). Default 3.
    pub research_max_rounds: u32,
    /// Provider do slot local: "ollama" | "openai".
    pub local_provider: String,
    pub openai_local_endpoint: String,
    pub openai_local_key: String,
    pub openai_local_model: String,
    /// Provider do slot de escalar: "claude" | "openai".
    pub cloud_provider: String,
    pub openai_cloud_endpoint: String,
    pub openai_cloud_key: String,
    pub openai_cloud_model: String,
    /// Pasta com ficheiros markdown de memória.
    pub memory_dir: String,
    /// Caminho opcional para um CLAUDE.md.
    pub claude_md_path: String,
    /// Ferramentas de browser (tool-calling). Só funcionam em modo Claude API.
    pub enable_browser_tools: bool,
    /// Caminho para o sidecar Node do Playwright (sidecar/index.js).
    pub browser_sidecar_script: String,
    /// Executável do Node.
    pub browser_node_path: String,
    /// Pasta de dados persistente do browser (mantém sessão/login).
    pub browser_user_data_dir: String,
    /// Servidores MCP configurados (o modelo pode chamar as ferramentas deles).
    pub mcp_servers: Vec<crate::mcp::McpServerConfig>,
    /// Pasta do workspace (skills/, playbooks/, workflows/).
    pub workspace_dir: String,
    /// Confirmação de ações: "off" | "dry_run" | "ask".
    pub confirm_mode: String,
    /// Pesquisa web para o modelo local (Ollama tool-calling).
    pub local_web_search: bool,
    /// Motor de pesquisa: "duckduckgo" (sem chave) | "tavily" | "brave" | "serper" | "exa" | "jina".
    pub web_search_provider: String,
    /// Chave por-motor (provider → chave) — cada uma guardada na keychain.
    pub web_search_keys: BTreeMap<String, String>,
    /// Onboarding (wizard de 1.º arranque) concluído.
    pub onboarding_done: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_endpoint: "http://localhost:11434".into(),
            ollama_model: "llama3.2".into(),
            ollama_vision_model: "llama3.2-vision".into(),
            ollama_num_ctx: 8192,
            ollama_temperature: 0.4,
            claude_mode: "cli".into(),
            claude_api_key: String::new(),
            claude_model: "claude-haiku-4-5-20251001".into(),
            claude_cli_path: "claude".into(),
            claude_max_tokens: 2048,
            thinking_budget: 4000,
            research_max_rounds: 3,
            local_provider: "ollama".into(),
            openai_local_endpoint: "http://localhost:1234/v1".into(),
            openai_local_key: String::new(),
            openai_local_model: String::new(),
            cloud_provider: "claude".into(),
            openai_cloud_endpoint: "https://api.openai.com/v1".into(),
            openai_cloud_key: String::new(),
            openai_cloud_model: "gpt-4o".into(),
            memory_dir: default_memory_dir().to_string_lossy().to_string(),
            claude_md_path: String::new(),
            enable_browser_tools: false,
            browser_sidecar_script: String::new(),
            browser_node_path: "node".into(),
            browser_user_data_dir: config_dir()
                .join("browser")
                .to_string_lossy()
                .to_string(),
            mcp_servers: Vec::new(),
            workspace_dir: config_dir()
                .join("workspace")
                .to_string_lossy()
                .to_string(),
            confirm_mode: "off".into(),
            local_web_search: false,
            web_search_provider: "jina".into(),
            web_search_keys: BTreeMap::new(),
            onboarding_done: false,
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("saga")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn default_memory_dir() -> PathBuf {
    config_dir().join("memory")
}

const KEYRING_SERVICE: &str = "saga";
const KC_ANTHROPIC: &str = "anthropic_api_key";
const KC_OPENAI_CLOUD: &str = "openai_cloud_key";
const KC_OPENAI_LOCAL: &str = "openai_local_key";
const KC_WEBSEARCH: &str = "web_search_api_key"; // legado (chave única Tavily) — migrado para o mapa

/// Motores de pesquisa com chave (DuckDuckGo é keyless e não entra aqui).
const WEB_PROVIDERS: [&str; 5] = ["tavily", "brave", "serper", "exa", "jina"];

/// Nome de utilizador da keychain para a chave de um motor de pesquisa.
fn web_key_user(provider: &str) -> String {
    format!("websearch_{provider}")
}

/// Nome de utilizador da keychain para o env de um servidor MCP.
fn mcp_env_user(name: &str) -> String {
    format!("mcp_env_{name}")
}

/// Lê uma credencial da keychain do SO (string vazia se não existir/erro).
fn keychain_load(user: &str) -> String {
    keyring::Entry::new(KEYRING_SERVICE, user)
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

/// Guarda (ou apaga, se vazia) uma credencial na keychain do SO.
fn keychain_store(user: &str, key: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, user) {
        if key.trim().is_empty() {
            let _ = entry.delete_credential();
        } else {
            let _ = entry.set_password(key);
        }
    }
}

impl Settings {
    pub fn load() -> Settings {
        let path = settings_path();
        let mut s: Settings = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Settings::default(),
        };
        // Resolve cada segredo a partir da keychain; migra do json em texto simples se preciso.
        let mut migrated = false;
        for (user, field) in [
            (KC_ANTHROPIC, &mut s.claude_api_key),
            (KC_OPENAI_CLOUD, &mut s.openai_cloud_key),
            (KC_OPENAI_LOCAL, &mut s.openai_local_key),
        ] {
            let kc = keychain_load(user);
            if !kc.is_empty() {
                *field = kc;
            } else if !field.is_empty() {
                keychain_store(user, field);
                migrated = true;
            }
        }
        // Chaves de pesquisa por-motor: cada uma na sua entrada da keychain.
        for p in WEB_PROVIDERS {
            let kc = keychain_load(&web_key_user(p));
            if !kc.is_empty() {
                s.web_search_keys.insert(p.to_string(), kc);
            } else if let Some(v) = s.web_search_keys.get(p) {
                if !v.is_empty() {
                    keychain_store(&web_key_user(p), v);
                    migrated = true;
                }
            }
        }
        // Migração do legado (chave única Tavily em KC_WEBSEARCH) → mapa.
        let legacy = keychain_load(KC_WEBSEARCH);
        if !legacy.is_empty() {
            let target = if WEB_PROVIDERS.contains(&s.web_search_provider.as_str()) {
                s.web_search_provider.clone()
            } else {
                "tavily".to_string()
            };
            s.web_search_keys.entry(target).or_insert(legacy);
            keychain_store(KC_WEBSEARCH, ""); // limpa o legado
            migrated = true;
        }
        // O `env` de cada servidor MCP (pode ter tokens) vive na keychain, uma entrada por servidor.
        for srv in &mut s.mcp_servers {
            if srv.name.trim().is_empty() {
                continue;
            }
            let user = mcp_env_user(&srv.name);
            let kc = keychain_load(&user);
            if !kc.is_empty() {
                if let Ok(env) = serde_json::from_str::<Vec<(String, String)>>(&kc) {
                    srv.env = env;
                }
            } else if !srv.env.is_empty() {
                keychain_store(&user, &serde_json::to_string(&srv.env).unwrap_or_default());
                migrated = true;
            }
        }
        if migrated {
            let _ = s.save();
        }
        s
    }

    pub fn save(&self) -> Result<()> {
        // Os segredos vão para a keychain — nunca para o settings.json.
        keychain_store(KC_ANTHROPIC, &self.claude_api_key);
        keychain_store(KC_OPENAI_CLOUD, &self.openai_cloud_key);
        keychain_store(KC_OPENAI_LOCAL, &self.openai_local_key);
        for p in WEB_PROVIDERS {
            keychain_store(
                &web_key_user(p),
                self.web_search_keys.get(p).map(|s| s.as_str()).unwrap_or(""),
            );
        }
        let mut to_write = self.clone();
        to_write.claude_api_key = String::new();
        to_write.openai_cloud_key = String::new();
        to_write.openai_local_key = String::new();
        to_write.web_search_keys = BTreeMap::new();
        // Guarda o env de cada servidor MCP na keychain e limpa-o do json.
        for srv in &mut to_write.mcp_servers {
            if srv.name.trim().is_empty() {
                continue;
            }
            let user = mcp_env_user(&srv.name);
            if srv.env.is_empty() {
                keychain_store(&user, "");
            } else {
                keychain_store(&user, &serde_json::to_string(&srv.env).unwrap_or_default());
                srv.env = Vec::new();
            }
        }

        let path = settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(&to_write)?;
        fs::write(&path, raw)?;
        Ok(())
    }

    /// Chave do motor de pesquisa atualmente selecionado (vazia se keyless/sem chave).
    pub fn active_web_key(&self) -> String {
        self.web_search_keys
            .get(&self.web_search_provider)
            .cloned()
            .unwrap_or_default()
    }
}
