//! Definições persistidas da app (modelo local, modo Claude, regras do router, memória).

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingConfig {
    /// Se falso, todos os pedidos vão para o destino por omissão (Claude se configurado, senão local).
    pub enabled: bool,
    /// Prompts até este nº de caracteres são considerados "leves" → local.
    pub light_max_chars: usize,
    /// Palavras-chave que forçam ficar no modelo local (ex.: "memória", "resume").
    pub force_local_keywords: Vec<String>,
    /// Palavras-chave que forçam escalar para o Claude (ex.: "refatora", "debug").
    pub force_claude_keywords: Vec<String>,
    /// Se verdadeiro, usa o modelo local para classificar a dificuldade (LEVE/PESADO).
    pub use_local_classifier: bool,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            light_max_chars: 280,
            force_local_keywords: vec![
                "memória".into(),
                "memoria".into(),
                "memory".into(),
                "claude.md".into(),
                "resume".into(),
                "resumir".into(),
                "lista".into(),
                "traduz".into(),
            ],
            force_claude_keywords: vec![
                "refatora".into(),
                "refactor".into(),
                "código".into(),
                "codigo".into(),
                "code".into(),
                "debug".into(),
                "arquitetura".into(),
                "implementa".into(),
                "claude".into(),
                "escala".into(),
                "pesquisa".into(),
                "como faço".into(),
                "como desativar".into(),
                "passos".into(),
                "github".into(),
                "api".into(),
                "documentação".into(),
                "documentacao".into(),
            ],
            use_local_classifier: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub ollama_endpoint: String,
    pub ollama_model: String,
    /// Modelo de visão local (usado quando há imagens e a rota é local).
    pub ollama_vision_model: String,
    /// "api" | "cli" | "off"
    pub claude_mode: String,
    pub claude_api_key: String,
    pub claude_model: String,
    pub claude_cli_path: String,
    pub claude_max_tokens: u32,
    /// Orçamento de tokens para extended thinking (quando ligado no composer).
    pub thinking_budget: u32,
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
    pub routing: RoutingConfig,
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
    /// Onboarding (wizard de 1.º arranque) concluído.
    pub onboarding_done: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_endpoint: "http://localhost:11434".into(),
            ollama_model: "llama3.2".into(),
            ollama_vision_model: "llama3.2-vision".into(),
            claude_mode: "cli".into(),
            claude_api_key: String::new(),
            claude_model: "claude-haiku-4-5-20251001".into(),
            claude_cli_path: "claude".into(),
            claude_max_tokens: 2048,
            thinking_budget: 4000,
            local_provider: "ollama".into(),
            openai_local_endpoint: "http://localhost:1234/v1".into(),
            openai_local_key: String::new(),
            openai_local_model: String::new(),
            cloud_provider: "claude".into(),
            openai_cloud_endpoint: "https://api.openai.com/v1".into(),
            openai_cloud_key: String::new(),
            openai_cloud_model: "gpt-4o".into(),
            routing: RoutingConfig::default(),
            memory_dir: default_memory_dir().to_string_lossy().to_string(),
            claude_md_path: String::new(),
            enable_browser_tools: false,
            browser_sidecar_script: String::new(),
            browser_node_path: "node".into(),
            browser_user_data_dir: config_dir()
                .join("browser")
                .to_string_lossy()
                .to_string(),
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
        let mut to_write = self.clone();
        to_write.claude_api_key = String::new();
        to_write.openai_cloud_key = String::new();
        to_write.openai_local_key = String::new();

        let path = settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(&to_write)?;
        fs::write(&path, raw)?;
        Ok(())
    }

    pub fn claude_enabled(&self) -> bool {
        self.claude_mode == "api" || self.claude_mode == "cli"
    }
}
