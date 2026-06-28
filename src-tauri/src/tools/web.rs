//! Ferramentas de pesquisa web para o modelo local: `web_search` (keyless via Mojeek+DuckDuckGo,
//! ou Tavily/Brave/… com chave) e `web_fetch` (página → texto). Usadas pelo loop de tool-calling
//! do Ollama (`web_agent`) e pelos andaimes `planner`/`deep_research`.

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
        _ => keyless_search(query, max).await,
    }
}

/// Pesquisa keyless (sem chave). Política: o DuckDuckGo é o motor por omissão; quando ele bloqueia
/// (202/429) entra em cooldown e o **Mojeek assume como motor durante essa janela** — re-tentando o
/// DDG só quando o cooldown expira. Assim não martelamos um IP bloqueado nem o Mojeek sem necessidade.
async fn keyless_search(query: &str, max: usize) -> Result<Vec<WebResult>> {
    // Enquanto o DDG está em cooldown pós-bloqueio, vai direto ao Mojeek (não vale a pena pedir).
    if ddg_in_cooldown().await {
        return mojeek_search(query, max).await;
    }
    match duckduckgo_search(query, max).await {
        Ok(out) if !out.is_empty() => Ok(out),
        // DDG falhou/vazio (um bloqueio já terá marcado o cooldown) → o Mojeek assume.
        _ => mojeek_search(query, max).await,
    }
}

/// Mojeek (mojeek.com) — pesquisa GET sem chave, com índice próprio. Sediado no Reino Unido (decisão
/// de adequação RGPD da UE), preferível a motores US. Estrutura: `a.title[href]` + `p.s` (snippet).
async fn mojeek_search(query: &str, max: usize) -> Result<Vec<WebResult>> {
    let resp = http()
        .get("https://www.mojeek.com/search")
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "pt-PT,pt;q=0.9,en;q=0.8")
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|e| anyhow!("Mojeek: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("Mojeek limitou o ritmo ({status})"));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| anyhow!("Mojeek resposta inválida: {e}"))?;
    Ok(parse_mojeek(&html, max))
}

/// Extrai resultados do HTML do Mojeek. Separado para ser testável sem rede.
fn parse_mojeek(html: &str, max: usize) -> Vec<WebResult> {
    let doc = Html::parse_document(html);
    let title_sel = Selector::parse("a.title").unwrap();
    let snip_sel = Selector::parse("p.s").unwrap();
    // Os snippets aparecem na mesma ordem dos títulos → emparelhamos por índice (como no DDG).
    let snippets: Vec<String> = doc
        .select(&snip_sel)
        .map(|s| s.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    let mut out = Vec::new();
    for (i, a) in doc.select(&title_sel).enumerate() {
        let title = a.text().collect::<String>().trim().to_string();
        let url = a.value().attr("href").unwrap_or("").trim().to_string();
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = snippets.get(i).cloned().unwrap_or_default();
        out.push(WebResult { title, url, snippet });
        if out.len() >= max {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mojeek_extracts_title_url_snippet() {
        // Fragmento representativo da estrutura real do Mojeek.
        let html = r#"
        <ul class="results-standard">
          <li><a class="ob" href="https://leak.pt/rtx-50/"></a>
            <a class="title" title="https://leak.pt/rtx-50/" href="https://leak.pt/rtx-50/">Placas RTX 50 e preços</a>
            <p class="url">leak.pt/rtx-50</p>
            <p class="s">As RTX 50 chegaram à Europa com preços a rondar os 600€.</p>
          </li>
          <li><a class="title" href="https://pcdiga.com/gpu">GPUs na PCDiga</a>
            <p class="s">Catálogo de placas gráficas.</p>
          </li>
        </ul>"#;
        let out = parse_mojeek(html, 5);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "Placas RTX 50 e preços");
        assert_eq!(out[0].url, "https://leak.pt/rtx-50/");
        assert!(out[0].snippet.contains("600€"));
        assert_eq!(out[1].url, "https://pcdiga.com/gpu");
    }

    #[test]
    fn parse_mojeek_respects_max() {
        let html = r#"<a class="title" href="https://a.pt">A</a>
                      <a class="title" href="https://b.pt">B</a>
                      <a class="title" href="https://c.pt">C</a>"#;
        assert_eq!(parse_mojeek(html, 2).len(), 2);
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

// ── Rate limiter GLOBAL do DuckDuckGo ─────────────────────────────────────────────────────
// O DDG sem chave faz deteção anti-bot: ao detetar acessos automáticos/rápidos devolve 202 e
// BLOQUEIA o IP por um tempo (não é um simples contador por minuto). Para não disparar o
// bloqueio, espaçamos TODOS os pedidos DDG (entre runs, web_agent e deep_research) e, quando
// apanhamos um bloqueio, entramos em cooldown em vez de continuar a martelar.
const DDG_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(2500);
const DDG_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(90);

struct DdgGate {
    last: Option<std::time::Instant>,
    blocked_until: Option<std::time::Instant>,
}
static DDG_GATE: std::sync::OnceLock<tokio::sync::Mutex<DdgGate>> = std::sync::OnceLock::new();
fn ddg_gate() -> &'static tokio::sync::Mutex<DdgGate> {
    DDG_GATE.get_or_init(|| {
        tokio::sync::Mutex::new(DdgGate {
            last: None,
            blocked_until: None,
        })
    })
}

/// Espaça os pedidos ao DDG (segura o lock durante a espera → serializa + ritma todos os
/// chamadores). Devolve `false` se estiver em cooldown pós-bloqueio (não vale a pena pedir).
async fn ddg_throttle() -> bool {
    let mut g = ddg_gate().lock().await;
    let now = std::time::Instant::now();
    if let Some(until) = g.blocked_until {
        if now < until {
            return false;
        }
        g.blocked_until = None;
    }
    if let Some(last) = g.last {
        let elapsed = now.saturating_duration_since(last);
        if elapsed < DDG_MIN_INTERVAL {
            tokio::time::sleep(DDG_MIN_INTERVAL - elapsed).await;
        }
    }
    g.last = Some(std::time::Instant::now());
    true
}

/// Marca um bloqueio (202/429): pausa os pedidos DDG durante o cooldown.
async fn ddg_mark_blocked() {
    ddg_gate().lock().await.blocked_until = Some(std::time::Instant::now() + DDG_COOLDOWN);
}

/// Leitura (sem consumir o throttle): o DDG está em cooldown pós-bloqueio? Usado para encaminhar a
/// pesquisa keyless para o Mojeek durante a janela de bloqueio do DuckDuckGo.
async fn ddg_in_cooldown() -> bool {
    let g = ddg_gate().lock().await;
    matches!(g.blocked_until, Some(until) if std::time::Instant::now() < until)
}

async fn duckduckgo_search(query: &str, max: usize) -> Result<Vec<WebResult>> {
    // Ritma globalmente; se estivermos em cooldown, falha já (não martela um IP bloqueado).
    if !ddg_throttle().await {
        return Err(anyhow!(
            "DuckDuckGo em pausa (cooldown após bloqueio). Aguarda ~1 min ou usa uma chave de pesquisa."
        ));
    }
    // POST ao endpoint HTML; se vier vazio (200), tenta o "lite". Um 202/429 = bloqueio → cooldown.
    match ddg_post("https://html.duckduckgo.com/html/", query, max).await {
        Ok(out) if !out.is_empty() => Ok(out),
        Ok(_) => match ddg_post("https://lite.duckduckgo.com/lite/", query, max).await {
            Ok(out) => Ok(out),
            Err(e) => {
                ddg_mark_blocked().await;
                Err(e)
            }
        },
        Err(e) => {
            ddg_mark_blocked().await;
            Err(e)
        }
    }
}

/// POST de pesquisa a um endpoint DuckDuckGo (html ou lite), com headers de browser.
async fn ddg_post(endpoint: &str, query: &str, max: usize) -> Result<Vec<WebResult>> {
    let resp = http()
        .post(endpoint)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://duckduckgo.com/")
        .header("Origin", "https://duckduckgo.com")
        .form(&[("q", query), ("kl", "wt-wt")])
        .send()
        .await
        .map_err(|e| anyhow!("DuckDuckGo: {e}"))?;
    // 202/429 = rate-limit/desafio anti-bot → falha (o chamador tenta o endpoint "lite").
    let status = resp.status();
    if status.as_u16() == 202 || status.as_u16() == 429 || !status.is_success() {
        return Err(anyhow!("DuckDuckGo limitou o ritmo ({status})"));
    }
    let html = resp
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
