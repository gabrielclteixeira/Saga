//! Provedor de modelos locais via Ollama (HTTP, por omissão em http://localhost:11434).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::{ChatMessage, LlmResponse};

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [WireMessage],
    stream: bool,
}

#[derive(Serialize, Deserialize)]
struct WireMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: WireMessage,
    #[serde(default)]
    prompt_eval_count: u64,
    #[serde(default)]
    eval_count: u64,
}

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
}

fn to_wire(messages: &[ChatMessage]) -> Vec<WireMessage> {
    messages
        .iter()
        .map(|m| WireMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect()
}

/// Conversa completa (não-streaming) com um modelo Ollama.
pub async fn chat(endpoint: &str, model: &str, messages: &[ChatMessage]) -> Result<LlmResponse> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let wire = to_wire(messages);
    let body = ChatRequest {
        model,
        messages: &wire,
        stream: false,
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama em {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama devolveu {status}: {text}"));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("resposta do Ollama inválida: {e}"))?;

    Ok(LlmResponse {
        text: parsed.message.content,
        input_tokens: parsed.prompt_eval_count,
        output_tokens: parsed.eval_count,
        reported_cost_usd: 0.0,
    })
}

/// Atalho: um único prompt de utilizador, sem histórico.
pub async fn generate(endpoint: &str, model: &str, prompt: &str) -> Result<LlmResponse> {
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: prompt.to_string(),
    }];
    chat(endpoint, model, &messages).await
}

/// Lista os modelos disponíveis localmente (/api/tags).
pub async fn list_models(endpoint: &str) -> Result<Vec<String>> {
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama em {url}: {e}"))?;
    let parsed: TagsResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("resposta /api/tags inválida: {e}"))?;
    Ok(parsed.models.into_iter().map(|m| m.name).collect())
}
