//! Integração com o servidor local do LM Studio (REST beta): listar os modelos já
//! descarregados, para serem usados como provider de chat (OpenAI-compatible).
//! Os downloads fazem-se na app do LM Studio — a Saga foca a gestão de modelos no Ollama.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;

/// Base REST do LM Studio = endpoint OpenAI-compatible sem o sufixo `/v1`.
fn rest_base(endpoint: &str) -> String {
    let e = endpoint.trim().trim_end_matches('/');
    e.strip_suffix("/v1").unwrap_or(e).to_string()
}

fn req(method: reqwest::Method, url: &str, key: &str) -> reqwest::RequestBuilder {
    let rb = crate::tools::web::http().request(method, url);
    if key.trim().is_empty() {
        rb
    } else {
        rb.bearer_auth(key.trim())
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct LmModel {
    pub id: String,
    /// type: llm | vlm | embeddings
    pub kind: String,
    pub arch: String,
    pub quantization: String,
    pub state: String,
}

/// Modelos já descarregados no LM Studio (`GET /api/v0/models`).
pub async fn list_downloaded(endpoint: &str, key: &str) -> Result<Vec<LmModel>> {
    let url = format!("{}/api/v0/models", rest_base(endpoint));
    let v: Value = req(reqwest::Method::GET, &url, key)
        .send()
        .await
        .map_err(|e| anyhow!("LM Studio inacessível: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("LM Studio resposta inválida: {e}"))?;
    let s = |m: &Value, k: &str| m.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let arr = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .map(|m| LmModel {
            id: s(m, "id"),
            kind: s(m, "type"),
            arch: s(m, "arch"),
            quantization: s(m, "quantization"),
            state: s(m, "state"),
        })
        .filter(|m| !m.id.is_empty())
        .collect())
}
