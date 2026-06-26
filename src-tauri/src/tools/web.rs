//! Ferramentas de pesquisa web para o modelo local: `web_search` (DuckDuckGo sem
//! chave, ou Tavily com chave) e `web_fetch` (página → texto). Usadas pelo loop
//! de tool-calling do Ollama (`web_agent`).

use anyhow::{anyhow, Result};
use scraper::{Html, Selector};
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (compatible; Saga/1.0)";

#[derive(Clone, Debug)]
pub struct WebResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Pesquisa web. `provider` = "tavily" (com chave) | qualquer outro → DuckDuckGo.
pub async fn web_search(
    provider: &str,
    api_key: &str,
    query: &str,
    max: usize,
) -> Result<Vec<WebResult>> {
    if provider == "tavily" && !api_key.trim().is_empty() {
        tavily_search(api_key, query, max).await
    } else {
        duckduckgo_search(query, max).await
    }
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
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );
    let client = reqwest::Client::new();
    let html = client
        .get(&url)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| anyhow!("DuckDuckGo: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("DuckDuckGo resposta inválida: {e}"))?;

    let doc = Html::parse_document(&html);
    let res_sel = Selector::parse("div.result").unwrap();
    let a_sel = Selector::parse("a.result__a").unwrap();
    let snip_sel = Selector::parse(".result__snippet").unwrap();
    let mut out = Vec::new();
    for el in doc.select(&res_sel) {
        let Some(a) = el.select(&a_sel).next() else {
            continue;
        };
        let title = a.text().collect::<String>().trim().to_string();
        let href = a.value().attr("href").unwrap_or("");
        let url = clean_ddg_url(href);
        let snippet = el
            .select(&snip_sel)
            .next()
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        if !title.is_empty() && !url.is_empty() {
            out.push(WebResult { title, url, snippet });
        }
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

/// Busca um URL e devolve o texto legível (sem script/style), truncado.
pub async fn web_fetch(url: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let html = client
        .get(url)
        .header("User-Agent", UA)
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
