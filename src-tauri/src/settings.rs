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
            ],
            use_local_classifier: false,
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
    pub routing: RoutingConfig,
    /// Pasta com ficheiros markdown de memória.
    pub memory_dir: String,
    /// Caminho opcional para um CLAUDE.md.
    pub claude_md_path: String,
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
            routing: RoutingConfig::default(),
            memory_dir: default_memory_dir().to_string_lossy().to_string(),
            claude_md_path: String::new(),
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("janus")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn default_memory_dir() -> PathBuf {
    config_dir().join("memory")
}

impl Settings {
    pub fn load() -> Settings {
        let path = settings_path();
        match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(&path, raw)?;
        Ok(())
    }

    pub fn claude_enabled(&self) -> bool {
        self.claude_mode == "api" || self.claude_mode == "cli"
    }
}
