//! Provedor Claude via API HTTP direta (Messages API).
//! Requer uma ANTHROPIC_API_KEY. Devolve contagem de tokens precisa (campo `usage`).

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
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
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<serde_json::Value>,
}

/// Ferramenta de pesquisa web server-side da Anthropic (o modelo pesquisa e cita).
fn web_search_tools() -> serde_json::Value {
    serde_json::json!([
        { "type": "web_search_20250305", "name": "web_search", "max_uses": 6 }
    ])
}

#[derive(Serialize)]
struct WireMessage {
    role: String,
    content: serde_json::Value,
}

/// Conteúdo: string simples, ou array de blocos (imagens + texto) quando há anexos.
fn content_value(m: &ChatMessage) -> serde_json::Value {
    use serde_json::json;
    if m.attachments.is_empty() {
        return json!(m.content);
    }
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    for a in &m.attachments {
        if a.kind == "image" {
            blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": a.media_type,
                    "data": a.data_base64,
                }
            }));
        }
    }
    if !m.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": m.content }));
    }
    json!(blocks)
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
                content: content_value(m),
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
    web_search: bool,
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
        stream: false,
        thinking: None,
        tools: if web_search {
            Some(web_search_tools())
        } else {
            None
        },
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

/// Versão em streaming (SSE). Chama `on_delta` para cada fragmento de texto.
#[allow(clippy::too_many_arguments)]
pub async fn messages_stream<F: FnMut(&str), G: FnMut(&str), H: FnMut(&str, &str)>(
    api_key: &str,
    model: &str,
    max_tokens: u32,
    messages: &[ChatMessage],
    thinking_budget: Option<u32>,
    web_search: bool,
    mut on_delta: F,
    mut on_thinking: G,
    mut on_tool: H,
) -> Result<LlmResponse> {
    if api_key.trim().is_empty() {
        return Err(anyhow!("ANTHROPIC_API_KEY não configurada (modo API)"));
    }

    let (system, wire) = split_messages(messages);
    // Com thinking, max_tokens tem de ser > budget_tokens.
    let (thinking, effective_max) = match thinking_budget {
        Some(b) => (
            Some(serde_json::json!({ "type": "enabled", "budget_tokens": b })),
            b + max_tokens,
        ),
        None => (None, max_tokens),
    };
    let body = MessagesRequest {
        model,
        max_tokens: effective_max,
        system: system.as_deref(),
        messages: wire,
        stream: true,
        thinking,
        tools: if web_search {
            Some(web_search_tools())
        } else {
            None
        },
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

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("erro no stream da API Anthropic: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Eventos SSE são separados por linha em branco ("\n\n").
        while let Some(idx) = buf.find("\n\n") {
            let event: String = buf[..idx].to_string();
            buf.drain(..idx + 2);
            for line in event.lines() {
                let line = line.trim_start();
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                    continue;
                };
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("message_start") => {
                        if let Some(u) = v
                            .pointer("/message/usage/input_tokens")
                            .and_then(|x| x.as_u64())
                        {
                            input_tokens = u;
                        }
                    }
                    Some("content_block_start") => {
                        // Pesquisa web server-side a começar.
                        if v.pointer("/content_block/type").and_then(|x| x.as_str())
                            == Some("server_tool_use")
                            && v.pointer("/content_block/name").and_then(|x| x.as_str())
                                == Some("web_search")
                        {
                            on_tool("web_search", "a pesquisar na web…");
                        }
                    }
                    Some("content_block_delta") => {
                        if let Some(t) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
                            on_delta(t);
                            full.push_str(t);
                        } else if let Some(th) =
                            v.pointer("/delta/thinking").and_then(|x| x.as_str())
                        {
                            on_thinking(th);
                        }
                    }
                    Some("message_delta") => {
                        if let Some(u) =
                            v.pointer("/usage/output_tokens").and_then(|x| x.as_u64())
                        {
                            output_tokens = u;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(LlmResponse {
        text: full,
        input_tokens,
        output_tokens,
        reported_cost_usd: 0.0,
    })
}

/// Converte mensagens em (system, lista JSON {role, content}) para pedidos com ferramentas.
pub fn to_request_messages(messages: &[ChatMessage]) -> (Option<String>, Vec<serde_json::Value>) {
    let (system, wire) = split_messages(messages);
    let msgs = wire
        .into_iter()
        .map(|w| serde_json::json!({ "role": w.role, "content": w.content }))
        .collect();
    (system, msgs)
}

/// POST genérico à Messages API com um corpo já montado; devolve o JSON da resposta.
pub async fn raw_request(api_key: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    if api_key.trim().is_empty() {
        return Err(anyhow!("ANTHROPIC_API_KEY não configurada (modo API)"));
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar a API Anthropic: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("API Anthropic devolveu {status}: {text}"));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("resposta da API Anthropic inválida: {e}"))
}
