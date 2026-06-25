//! Provedores de modelos (locais e Claude) e tipos partilhados.

pub mod claude_api;
pub mod claude_cli;
pub mod ollama;

use serde::{Deserialize, Serialize};

/// Anexo de uma mensagem (atualmente só imagens, em base64).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attachment {
    pub kind: String,       // "image"
    pub media_type: String, // ex.: "image/png"
    pub data_base64: String,
}

/// Mensagem de conversa, partilhada entre frontend, router e providers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// Resposta normalizada de qualquer provedor de modelo.
#[derive(Clone, Debug)]
pub struct LlmResponse {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Custo reportado pelo provedor, se disponível (ex.: Claude CLI). 0.0 caso contrário.
    pub reported_cost_usd: f64,
}

/// Estimativa grosseira de tokens (≈ 4 chars por token) para fins de contabilidade.
pub fn estimate_tokens(text: &str) -> u64 {
    ((text.chars().count() as f64) / 4.0).ceil() as u64
}
