//! Provedor Claude via API HTTP direta (Messages API).
//! Requer uma ANTHROPIC_API_KEY. Devolve contagem de tokens precisa (campo `usage`).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::{ChatMessage, LlmResponse};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<WireMessage>,
}

#[derive(Serialize)]
struct WireMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    content: Vec<ContentBlock>,
    #[serde(default)]
    usage: Usage,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default, rename = "type")]
    _block_type: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

/// Apenas as mensagens user/assistant vão no array; o conteúdo "system" vai no campo próprio.
fn split_messages(messages: &[ChatMessage]) -> (Option<String>, Vec<WireMessage>) {
    let mut system_parts = Vec::new();
    let mut wire = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_parts.push(m.content.clone());
        } else {
            wire.push(WireMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            });
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (system, wire)
}

pub async fn messages(
    api_key: &str,
    model: &str,
    max_tokens: u32,
    messages: &[ChatMessage],
) -> Result<LlmResponse> {
    if api_key.trim().is_empty() {
        return Err(anyhow!("ANTHROPIC_API_KEY não configurada (modo API)"));
    }

    let (system, wire) = split_messages(messages);
    let body = MessagesRequest {
        model,
        max_tokens,
        system: system.as_deref(),
        messages: wire,
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar a API Anthropic: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("API Anthropic devolveu {status}: {text}"));
    }

    let parsed: MessagesResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("resposta da API Anthropic inválida: {e}"))?;

    let text = parsed
        .content
        .into_iter()
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");

    Ok(LlmResponse {
        text,
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        reported_cost_usd: 0.0,
    })
}
