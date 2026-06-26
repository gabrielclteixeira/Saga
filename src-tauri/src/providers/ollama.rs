//! Provedor de modelos locais via Ollama (HTTP, por omissão em http://localhost:11434).

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
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
    #[serde(default)]
    size: u64,
    #[serde(default)]
    details: TagDetails,
}

#[derive(Deserialize, Default)]
struct TagDetails {
    #[serde(default)]
    family: String,
    #[serde(default)]
    parameter_size: String,
    #[serde(default)]
    quantization_level: String,
}

/// Modelo Ollama com metadados (para o hub "Modelos").
#[derive(Serialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub family: String,
    pub parameter_size: String,
    pub quantization: String,
}

fn to_wire(messages: &[ChatMessage]) -> Vec<WireMessage> {
    messages
        .iter()
        .map(|m| WireMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            images: m
                .attachments
                .iter()
                .filter(|a| a.kind == "image")
                .map(|a| a.data_base64.clone())
                .collect(),
        })
        .collect()
}

/// Conversa completa (não-streaming) com um modelo Ollama.
/// Chamada crua a `/api/chat` (não-stream) com `messages` em JSON e `tools` opcionais.
/// Devolve o JSON da resposta (para ler `message.content`, `message.tool_calls`, usage).
/// Usado pelo loop de tool-calling local (`web_agent`).
pub async fn chat_raw(
    endpoint: &str,
    model: &str,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    if let Some(t) = tools {
        body["tools"] = t;
    }
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
    resp.json()
        .await
        .map_err(|e| anyhow!("resposta do Ollama inválida: {e}"))
}

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
        sources: Vec::new(),
    })
}

/// Conversa em streaming: chama `on_delta` para cada fragmento de texto recebido.
pub async fn chat_stream<F: FnMut(&str)>(
    endpoint: &str,
    model: &str,
    messages: &[ChatMessage],
    mut on_delta: F,
) -> Result<LlmResponse> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let wire = to_wire(messages);
    let body = ChatRequest {
        model,
        messages: &wire,
        stream: true,
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

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("erro no stream do Ollama: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf[..nl].to_string();
            buf.drain(..=nl);
            parse_ollama_line(
                &line,
                &mut full,
                &mut input_tokens,
                &mut output_tokens,
                &mut on_delta,
            );
        }
    }
    // Última linha sem '\n' final.
    if !buf.trim().is_empty() {
        let leftover = buf.clone();
        parse_ollama_line(
            &leftover,
            &mut full,
            &mut input_tokens,
            &mut output_tokens,
            &mut on_delta,
        );
    }

    Ok(LlmResponse {
        text: full,
        input_tokens,
        output_tokens,
        reported_cost_usd: 0.0,
        sources: Vec::new(),
    })
}

fn parse_ollama_line<F: FnMut(&str)>(
    line: &str,
    full: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    on_delta: &mut F,
) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if let Ok(parsed) = serde_json::from_str::<ChatResponse>(line) {
        if !parsed.message.content.is_empty() {
            on_delta(&parsed.message.content);
            full.push_str(&parsed.message.content);
        }
        if parsed.prompt_eval_count > 0 {
            *input_tokens = parsed.prompt_eval_count;
        }
        if parsed.eval_count > 0 {
            *output_tokens = parsed.eval_count;
        }
    }
}

/// Atalho: um único prompt de utilizador, sem histórico.
pub async fn generate(endpoint: &str, model: &str, prompt: &str) -> Result<LlmResponse> {
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: prompt.to_string(),
        attachments: Vec::new(),
    }];
    chat(endpoint, model, &messages).await
}

#[derive(Serialize)]
struct PullRequest<'a> {
    name: &'a str,
    stream: bool,
}

#[derive(Deserialize)]
struct PullLine {
    #[serde(default)]
    status: String,
    #[serde(default)]
    total: u64,
    #[serde(default)]
    completed: u64,
}

/// Descarrega um modelo (/api/pull); chama `on_progress(status, percent)` (percent -1 se desconhecido).
pub async fn pull_model<F: FnMut(&str, f64)>(
    endpoint: &str,
    model: &str,
    mut on_progress: F,
) -> Result<()> {
    let url = format!("{}/api/pull", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&PullRequest {
            name: model,
            stream: true,
        })
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama em {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama devolveu {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("erro no stream do Ollama: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf[..nl].to_string();
            buf.drain(..=nl);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(p) = serde_json::from_str::<PullLine>(line) {
                let percent = if p.total > 0 {
                    (p.completed as f64 / p.total as f64) * 100.0
                } else {
                    -1.0
                };
                on_progress(&p.status, percent);
            }
        }
    }
    Ok(())
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

/// Lista os modelos locais com metadados (nome, tamanho, parâmetros, quantização).
pub async fn list_models_detailed(endpoint: &str) -> Result<Vec<OllamaModel>> {
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
    Ok(parsed
        .models
        .into_iter()
        .map(|m| OllamaModel {
            name: m.name,
            size: m.size,
            family: m.details.family,
            parameter_size: m.details.parameter_size,
            quantization: m.details.quantization_level,
        })
        .collect())
}

/// Apaga um modelo local (DELETE /api/delete).
pub async fn delete_model(endpoint: &str, name: &str) -> Result<()> {
    let url = format!("{}/api/delete", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let send = |body: serde_json::Value| {
        client.delete(&url).json(&body).send()
    };
    let resp = send(serde_json::json!({ "model": name }))
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama em {url}: {e}"))?;
    if resp.status().is_success() {
        return Ok(());
    }
    // Versões antigas usavam o campo "name".
    let resp2 = send(serde_json::json!({ "name": name }))
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama em {url}: {e}"))?;
    if resp2.status().is_success() {
        Ok(())
    } else {
        Err(anyhow!("Ollama recusou apagar '{name}': {}", resp2.status()))
    }
}
