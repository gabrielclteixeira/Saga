//! Provedor de modelos locais via Ollama (HTTP, por omissão em http://localhost:11434).

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::{ChatMessage, LlmResponse};

/// Opções de geração do Ollama (contexto + criatividade).
/// `temperature: None` = não sobrepor — usa o default afinado do Modelfile de cada modelo.
#[derive(Clone, Copy)]
pub struct GenOpts {
    pub num_ctx: u32,
    pub temperature: Option<f32>,
    /// Teto de tokens de resposta. `None` = sem limite (omite `num_predict`).
    pub num_predict: Option<i32>,
}
impl Default for GenOpts {
    fn default() -> Self {
        Self {
            num_ctx: 8192,
            temperature: None,
            num_predict: None,
        }
    }
}
fn opts_json(o: GenOpts) -> serde_json::Value {
    let mut v = serde_json::json!({ "num_ctx": o.num_ctx });
    if let Some(t) = o.temperature {
        v["temperature"] = serde_json::json!(t);
    }
    if let Some(n) = o.num_predict {
        v["num_predict"] = serde_json::json!(n);
    }
    v
}

/// Mantém o modelo carregado em memória entre pedidos (evita o cold-start de recarregar
/// a cada mensagem). Ollama por omissão descarrega ao fim de ~5 min.
const KEEP_ALIVE: &str = "30m";

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [WireMessage],
    stream: bool,
    options: serde_json::Value,
    keep_alive: &'a str,
    /// Pede o canal de raciocínio separado (`message.thinking`) — só para modelos que pensam.
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct WireMessage {
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
    /// Tokens de raciocínio (modelos com "thinking"); separados do `content`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    thinking: String,
}

/// Deteta, pelo nome, se um modelo Ollama faz raciocínio ("thinking") — espelha o frontend.
pub fn model_reasons(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("deepseek-r1")
        || n.contains("qwq")
        || n.contains("qwen3")
        || n.contains("gemma4")
        || n.contains("thinking")
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
            thinking: String::new(),
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
    opts: GenOpts,
) -> Result<serde_json::Value> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "options": opts_json(opts),
        "keep_alive": KEEP_ALIVE,
    });
    if let Some(t) = tools {
        body["tools"] = t;
        // Em modelos com raciocínio (gemma4, qwen3…), o "thinking" interfere com o parser de
        // tool-calling (o tool call sai como texto e não é executado). Desliga-o no loop de
        // ferramentas para que o modelo chame as ferramentas de forma limpa.
        if model_reasons(model) {
            body["think"] = serde_json::json!(false);
        }
    }
    log::debug!(
        "ollama chat_raw model={model} num_ctx={} tools={}",
        opts.num_ctx,
        body.get("tools").is_some()
    );
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

/// Embeddings via `/api/embed`. Funciona com qualquer modelo (chat incluído) → zero-setup: usa-se o
/// modelo ativo, sem instalar um modelo de embeddings dedicado. Devolve um vetor por `input`.
pub async fn embed(endpoint: &str, model: &str, inputs: &[&str]) -> Result<Vec<Vec<f32>>> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/api/embed", endpoint.trim_end_matches('/'));
    let body = serde_json::json!({ "model": model, "input": inputs, "keep_alive": KEEP_ALIVE });
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("falha a contactar o Ollama (embed) em {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama (embed) devolveu {status}: {text}"));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("resposta de embeddings inválida: {e}"))?;
    let arr = v
        .get("embeddings")
        .and_then(|e| e.as_array())
        .ok_or_else(|| anyhow!("resposta de embeddings sem campo 'embeddings'"))?;
    let out: Vec<Vec<f32>> = arr
        .iter()
        .map(|row| {
            row.as_array()
                .map(|r| r.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
                .unwrap_or_default()
        })
        .collect();
    if out.iter().any(|e| e.is_empty()) {
        return Err(anyhow!("o modelo {model} não devolveu embeddings utilizáveis"));
    }
    Ok(out)
}

/// Similaridade do cosseno entre dois vetores (0 se dimensões diferentes ou norma nula).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

pub async fn chat(
    endpoint: &str,
    model: &str,
    messages: &[ChatMessage],
    opts: GenOpts,
) -> Result<LlmResponse> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let wire = to_wire(messages);
    let body = ChatRequest {
        model,
        messages: &wire,
        stream: false,
        options: opts_json(opts),
        keep_alive: KEEP_ALIVE,
        think: None,
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

/// Conversa em streaming: `on_delta` recebe cada fragmento de texto; `on_thinking` recebe os
/// fragmentos de raciocínio (se `think` e o modelo os emitir).
pub async fn chat_stream<F: FnMut(&str), G: FnMut(&str)>(
    endpoint: &str,
    model: &str,
    messages: &[ChatMessage],
    opts: GenOpts,
    think: bool,
    mut on_delta: F,
    mut on_thinking: G,
) -> Result<LlmResponse> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let wire = to_wire(messages);
    let body = ChatRequest {
        model,
        messages: &wire,
        stream: true,
        options: opts_json(opts),
        keep_alive: KEEP_ALIVE,
        // Envia o flag SEMPRE explícito: `Some(false)` desliga mesmo o raciocínio. Omiti-lo deixava
        // modelos que pensam por defeito (qwen3…) gastar todo o num_predict a "pensar" e devolver
        // conteúdo VAZIO — no Plan mode isso dava 0 passos → eco da pergunta.
        think: Some(think),
    };
    log::debug!("ollama chat_stream model={model} num_ctx={} think={think} msgs={}", opts.num_ctx, wire.len());

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
                &mut on_thinking,
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
            &mut on_thinking,
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

fn parse_ollama_line<F: FnMut(&str), G: FnMut(&str)>(
    line: &str,
    full: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    on_delta: &mut F,
    on_thinking: &mut G,
) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if let Ok(parsed) = serde_json::from_str::<ChatResponse>(line) {
        if !parsed.message.thinking.is_empty() {
            on_thinking(&parsed.message.thinking);
        }
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
pub async fn generate(
    endpoint: &str,
    model: &str,
    prompt: &str,
    opts: GenOpts,
) -> Result<LlmResponse> {
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: prompt.to_string(),
        attachments: Vec::new(),
    }];
    chat(endpoint, model, &messages, opts).await
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

/// Pré-carrega o modelo em memória (VRAM) sem gerar nada: um pedido a `/api/generate`
/// com prompt vazio faz o Ollama carregar os pesos e mantê-lo residente (`keep_alive`).
/// Assim a 1.ª resposta evita o cold-start (segundos a ler do disco para a VRAM).
/// Aquece com o `num_ctx` base — o caminho comum (chat curto) reaproveita-o; um documento
/// grande pode obrigar a redimensionar o contexto, mas os pesos já ficam em cache.
pub async fn warm(endpoint: &str, model: &str, num_ctx: u32) -> Result<()> {
    let url = format!("{}/api/generate", endpoint.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "prompt": "",
        "stream": false,
        "keep_alive": KEEP_ALIVE,
        "options": { "num_ctx": num_ctx },
    });
    reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| anyhow!("falha a aquecer o modelo {model}: {e}"))?;
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
