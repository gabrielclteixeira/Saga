//! Ferramentas de pesquisa web para o modelo local: `web_search` (DuckDuckGo sem
//! chave, ou Tavily com chave) e `web_fetch` (página → texto). Usadas pelo loop
//! de tool-calling do Ollama (`web_agent`).

use anyhow::{anyhow, Result};
use scraper::{Html, Selector};
use serde_json::Value;

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Cliente HTTP com User-Agent de browser (DuckDuckGo bloqueia UAs não-browser).
pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .unwrap_or_default()
}

#[derive(Clone, Debug)]
pub struct WebResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Pesquisa web. Despacha pelo `provider`; os motores com chave caem para DuckDuckGo
/// (keyless, best-effort) se a chave estiver vazia.
pub async fn web_search(
    provider: &str,
    api_key: &str,
    query: &str,
    max: usize,
) -> Result<Vec<WebResult>> {
    let has_key = !api_key.trim().is_empty();
    match provider {
        "tavily" if has_key => tavily_search(api_key, query, max).await,
        "brave" if has_key => brave_search(api_key, query, max).await,
        "serper" if has_key => serper_search(api_key, query, max).await,
        "exa" if has_key => exa_search(api_key, query, max).await,
        "jina" if has_key => jina_search(api_key, query, max).await,
        _ => duckduckgo_search(query, max).await,
    }
}

async fn brave_search(api_key: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let v: Value = http()
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", &max.to_string())])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| anyhow!("Brave: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("Brave resposta inválida: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.pointer("/web/results").and_then(|r| r.as_array()) {
        for r in arr.iter().take(max) {
            out.push(WebResult {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: r.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                snippet: r.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

async fn serper_search(api_key: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let v: Value = http()
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", api_key)
        .json(&serde_json::json!({ "q": query, "num": max }))
        .send()
        .await
        .map_err(|e| anyhow!("Serper: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("Serper resposta inválida: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("organic").and_then(|r| r.as_array()) {
        for r in arr.iter().take(max) {
            out.push(WebResult {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: r.get("link").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                snippet: r.get("snippet").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

async fn exa_search(api_key: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let v: Value = http()
        .post("https://api.exa.ai/search")
        .header("x-api-key", api_key)
        .json(&serde_json::json!({
            "query": query,
            "numResults": max,
            "contents": { "text": { "maxCharacters": 600 } }
        }))
        .send()
        .await
        .map_err(|e| anyhow!("Exa: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("Exa resposta inválida: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("results").and_then(|r| r.as_array()) {
        for r in arr.iter().take(max) {
            let snippet = r
                .get("text")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            out.push(WebResult {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: r.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                snippet: snippet.chars().take(600).collect(),
            });
        }
    }
    Ok(out)
}

async fn jina_search(api_key: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let url = format!("https://s.jina.ai/{}", urlencoding::encode(query));
    let v: Value = http()
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("X-Respond-With", "no-content")
        .send()
        .await
        .map_err(|e| anyhow!("Jina: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("Jina resposta inválida: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("data").and_then(|r| r.as_array()) {
        for r in arr.iter().take(max) {
            out.push(WebResult {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: r.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                snippet: r
                    .get("description")
                    .or_else(|| r.get("content"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(600)
                    .collect(),
            });
        }
    }
    Ok(out)
}

async fn tavily_search(api_key: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "api_key": api_key,
        "query": query,
        "max_results": max,
        "search_depth": "basic",
    });
    let v: Value = client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Tavily: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("Tavily resposta inválida: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("results").and_then(|r| r.as_array()) {
        for r in arr.iter().take(max) {
            out.push(WebResult {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: r.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                snippet: r.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

async fn duckduckgo_search(query: &str, max: usize) -> Result<Vec<WebResult>> {
    // POST ao endpoint HTML; se vier vazio (DDG bloqueia scraping com frequência),
    // tenta o endpoint "lite". Ambos best-effort — sem chave a fiabilidade é baixa.
    let mut out = ddg_post("https://html.duckduckgo.com/html/", query, max)
        .await
        .unwrap_or_default();
    if out.is_empty() {
        out = ddg_post("https://lite.duckduckgo.com/lite/", query, max)
            .await
            .unwrap_or_default();
    }
    Ok(out)
}

/// POST de pesquisa a um endpoint DuckDuckGo (html ou lite), com headers de browser.
async fn ddg_post(endpoint: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let html = http()
        .post(endpoint)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://duckduckgo.com/")
        .form(&[("q", query), ("kl", "wt-wt")])
        .send()
        .await
        .map_err(|e| anyhow!("DuckDuckGo: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("DuckDuckGo resposta inválida: {e}"))?;

    let doc = Html::parse_document(&html);
    // Selectores do endpoint clássico e do lite (tentamos ambos).
    let link_sel = Selector::parse("a.result__a, a.result-link").unwrap();
    let snip_sel = Selector::parse(".result__snippet, .result-snippet, td.result-snippet").unwrap();
    let snippets: Vec<String> = doc
        .select(&snip_sel)
        .map(|s| s.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    let mut out = Vec::new();
    for (i, a) in doc.select(&link_sel).enumerate() {
        let title = a.text().collect::<String>().trim().to_string();
        let url = clean_ddg_url(a.value().attr("href").unwrap_or(""));
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = snippets.get(i).cloned().unwrap_or_default();
        out.push(WebResult { title, url, snippet });
        if out.len() >= max {
            break;
        }
    }
    Ok(out)
}

/// O DuckDuckGo HTML envolve os links num redirect `…/l/?uddg=<url-encoded>`.
fn clean_ddg_url(href: &str) -> String {
    let h = if let Some(stripped) = href.strip_prefix("//") {
        format!("https://{stripped}")
    } else {
        href.to_string()
    };
    if let Some(idx) = h.find("uddg=") {
        let enc = &h[idx + 5..];
        let enc = enc.split('&').next().unwrap_or(enc);
        if let Ok(dec) = urlencoding::decode(enc) {
            return dec.into_owned();
        }
    }
    h
}

/// Busca um URL e devolve texto legível. Tenta primeiro o Jina Reader (markdown limpo,
/// keyless, lida com páginas JS); se falhar/vier curto, cai para o scrape direto.
pub async fn web_fetch(url: &str) -> Result<String> {
    if let Ok(md) = jina_read(url).await {
        if md.trim().chars().count() > 200 {
            return Ok(md);
        }
    }
    direct_fetch(url).await
}

/// Jina Reader: `r.jina.ai/<url>` → markdown limpo (sem chave; ~20 req/min).
async fn jina_read(url: &str) -> Result<String> {
    let text = http()
        .get(format!("https://r.jina.ai/{url}"))
        .header("Accept", "text/plain")
        .header("X-Return-Format", "markdown")
        .send()
        .await
        .map_err(|e| anyhow!("Jina Reader: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("Jina Reader resposta inválida: {e}"))?;
    Ok(text.chars().take(8000).collect())
}

/// Scrape direto (fallback): busca o HTML e extrai o texto do body.
async fn direct_fetch(url: &str) -> Result<String> {
    let html = http()
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow!("web_fetch {url}: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("web_fetch resposta inválida: {e}"))?;

    let doc = Html::parse_document(&html);
    let body_sel = Selector::parse("body").unwrap();
    let text = if let Some(body) = doc.select(&body_sel).next() {
        body.text().collect::<Vec<_>>().join(" ")
    } else {
        doc.root_element().text().collect::<Vec<_>>().join(" ")
    };
    // Colapsa espaços em branco.
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(collapsed.chars().take(6000).collect())
}

/// Formata os resultados como texto para devolver ao modelo (tool result).
pub fn format_results(results: &[WebResult]) -> String {
    if results.is_empty() {
        return "Sem resultados.".into();
    }
    results
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}\n{}\n{}", i + 1, r.title, r.url, r.snippet))
        .collect::<Vec<_>>()
        .join("\n\n")
}
