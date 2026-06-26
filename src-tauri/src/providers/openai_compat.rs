//! Provider compatível com a API OpenAI (`/v1/chat/completions`).
//! Cobre OpenAI, Groq, Mistral, DeepSeek, OpenRouter, LM Studio, llama.cpp e
//! Gemini (via o seu endpoint compatível). Um só módulo, muitos serviços.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

use super::{ChatMessage, LlmResponse};

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Value>,
    max_tokens: u32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<Value>,
}

fn endpoint_url(endpoint: &str) -> String {
    format!("{}/chat/completions", endpoint.trim_end_matches('/'))
}

/// Converte as mensagens para o formato OpenAI (com `image_url` para anexos de imagem).
fn to_wire(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            if m.attachments.is_empty() {
                json!({ "role": m.role, "content": m.content })
            } else {
                let mut parts: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "type": "text", "text": m.content }));
                }
                for a in &m.attachments {
                    if a.kind == "image" {
                        parts.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", a.media_type, a.data_base64)
                            }
                        }));
                    }
                }
                json!({ "role": m.role, "content": parts })
            }
        })
        .collect()
}

fn post(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    body: &ChatRequest,
) -> reqwest::RequestBuilder {
    let mut rb = client
        .post(endpoint_url(endpoint))
        .header("content-type", "application/json")
        .json(body);
    if !key.trim().is_empty() {
        rb = rb.header("authorization", format!("Bearer {}", key.trim()));
    }
    rb
}

fn usage_tokens(v: &Value) -> (u64, u64) {
    let u = v.get("usage").filter(|u| u.is_object());
    let inp = u
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let out = u
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    (inp, out)
}

#[allow(dead_code)] // não-stream; reservado para usos futuros (ex.: subagentes OpenAI)
pub async fn chat(
    endpoint: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<LlmResponse> {
    let body = ChatRequest {
        model,
        messages: to_wire(messages),
        max_tokens,
        stream: false,
        stream_options: None,
    };
    let client = reqwest::Client::new();
    let resp = post(&client, endpoint, key, &body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o endpoint OpenAI-compatible: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("endpoint devolveu {status}: {text}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("resposta inválida: {e}"))?;
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let (input_tokens, output_tokens) = usage_tokens(&v);
    Ok(LlmResponse {
        text,
        input_tokens,
        output_tokens,
        reported_cost_usd: 0.0,
        sources: Vec::new(),
    })
}

pub async fn chat_stream<F: FnMut(&str)>(
    endpoint: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    mut on_delta: F,
) -> Result<LlmResponse> {
    let body = ChatRequest {
        model,
        messages: to_wire(messages),
        max_tokens,
        stream: true,
        stream_options: Some(json!({ "include_usage": true })),
    };
    let client = reqwest::Client::new();
    let resp = post(&client, endpoint, key, &body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o endpoint OpenAI-compatible: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("endpoint devolveu {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("erro no stream: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
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
                let Ok(v) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(c) = v
                    .pointer("/choices/0/delta/content")
                    .and_then(|x| x.as_str())
                {
                    on_delta(c);
                    full.push_str(c);
                }
                let (inp, out) = usage_tokens(&v);
                if inp > 0 || out > 0 {
                    input_tokens = inp;
                    output_tokens = out;
                }
            }
        }
    }

    Ok(LlmResponse {
        text: full,
        input_tokens,
        output_tokens,
        reported_cost_usd: 0.0,
        sources: Vec::new(),
    })
}
