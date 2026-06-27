//! Integração com o servidor local do LM Studio (REST beta): listar modelos
//! descarregados, pesquisar o catálogo (scrape de lmstudio.ai/models) e descarregar
//! modelos via `/api/v1/models/download` com poll de progresso.

use anyhow::{anyhow, Result};
use scraper::{Html, Selector};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

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

#[derive(Serialize, Clone, Debug)]
pub struct LmCatalogModel {
    pub slug: String,
    pub name: String,
    pub sizes: Vec<String>,
    pub url: String,
}

/// Pesquisa o catálogo público do LM Studio (scrape `lmstudio.ai/models`, filtra por nome).
pub async fn search_catalog(query: &str, max: usize) -> Result<Vec<LmCatalogModel>> {
    let html = crate::tools::web::http()
        .get("https://lmstudio.ai/models")
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| anyhow!("lmstudio.ai: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("lmstudio.ai resposta inválida: {e}"))?;
    let q = query.trim().to_lowercase();
    Ok(parse_catalog(&html)
        .into_iter()
        .filter(|m| q.is_empty() || m.name.to_lowercase().contains(&q) || m.slug.contains(&q))
        .take(max)
        .collect())
}

fn parse_catalog(html: &str) -> Vec<LmCatalogModel> {
    let doc = Html::parse_document(html);
    let card = Selector::parse(r#"a[href^="/models/"]"#).unwrap();
    let name = Selector::parse(".text-lg.font-medium").unwrap();
    let size = Selector::parse(r#"div[title^="Model size:"]"#).unwrap();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for el in doc.select(&card) {
        let slug = el
            .value()
            .attr("href")
            .and_then(|h| h.strip_prefix("/models/"))
            .and_then(|s| s.split(['/', '?', '#']).next())
            .unwrap_or("")
            .to_string();
        if slug.is_empty() || !seen.insert(slug.clone()) {
            continue;
        }
        let name_txt = el
            .select(&name)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| slug.clone());
        let mut sizes = Vec::new();
        for e in el.select(&size) {
            let s = e.text().collect::<String>().trim().to_string();
            if !s.is_empty() && !sizes.contains(&s) {
                sizes.push(s);
            }
        }
        out.push(LmCatalogModel {
            url: format!("https://lmstudio.ai/models/{slug}"),
            slug,
            name: name_txt,
            sizes,
        });
    }
    out
}

/// Descarrega um modelo (POST `/api/v1/models/download`) e faz poll do progresso.
pub async fn download<F: FnMut(&str, f64)>(
    endpoint: &str,
    key: &str,
    model: &str,
    quant: &str,
    mut on_progress: F,
) -> Result<()> {
    let base = rest_base(endpoint);
    let mut body = serde_json::json!({ "model": model });
    if !quant.trim().is_empty() {
        body["quantization"] = serde_json::json!(quant.trim());
    }
    let start: Value = req(
        reqwest::Method::POST,
        &format!("{base}/api/v1/models/download"),
        key,
    )
    .json(&body)
    .send()
    .await
    .map_err(|e| anyhow!("LM Studio download: {e}"))?
    .json()
    .await
    .map_err(|e| anyhow!("LM Studio resposta inválida: {e}"))?;

    if start.get("status").and_then(|x| x.as_str()) == Some("already_downloaded") {
        on_progress("já instalado", 100.0);
        return Ok(());
    }
    let job_id = start
        .get("job_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow!("sem job_id na resposta: {start}"))?
        .to_string();

    on_progress("a iniciar", -1.0);
    for _ in 0..3600 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let st: Value = req(
            reqwest::Method::GET,
            &format!("{base}/api/v1/models/download-status?job_id={job_id}"),
            key,
        )
        .send()
        .await
        .map_err(|e| anyhow!("LM Studio status: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("LM Studio status inválido: {e}"))?;

        let status = st.get("status").and_then(|x| x.as_str()).unwrap_or("");
        let pct = st
            .get("progress")
            .and_then(|x| x.as_f64())
            .map(|p| if p <= 1.0 { p * 100.0 } else { p })
            .or_else(|| {
                let d = st
                    .get("downloaded_bytes")
                    .or_else(|| st.get("bytes_downloaded"))
                    .and_then(|x| x.as_f64());
                let t = st
                    .get("total_size_bytes")
                    .or_else(|| st.get("total_bytes"))
                    .and_then(|x| x.as_f64());
                match (d, t) {
                    (Some(d), Some(t)) if t > 0.0 => Some(d / t * 100.0),
                    _ => None,
                }
            })
            .unwrap_or(-1.0);
        match status {
            "completed" | "already_downloaded" => {
                on_progress("concluído", 100.0);
                return Ok(());
            }
            "failed" => return Err(anyhow!("o download falhou no LM Studio")),
            _ => on_progress(status, pct),
        }
    }
    Err(anyhow!("timeout do download"))
}
