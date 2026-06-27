//! Pesquisa no registo público do Ollama (ollama.com/search). O Ollama não tem API
//! de pesquisa JSON, por isso raspamos a página (hooks estáveis `x-test-*`).

use anyhow::{anyhow, Result};
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct RegistryModel {
    pub name: String,
    pub description: String,
    /// vision | tools | thinking | embedding | audio …
    pub capabilities: Vec<String>,
    /// e2b, 7b, 12b, 26b, 31b …
    pub sizes: Vec<String>,
    pub pulls: String,
    pub updated: String,
}

/// Uma variante (tag) de um modelo, da página `/library/<model>/tags`.
#[derive(Serialize, Clone, Debug)]
pub struct RegistryTag {
    /// Nome completo, pronto para `ollama pull` (ex.: "gemma4:26b-a4b-it-qat").
    pub name: String,
    /// Tamanho em disco (ex.: "16GB"); vazio nas tags cloud.
    pub size: String,
    /// Janela de contexto (ex.: "256K").
    pub context: String,
}

/// Pesquisa modelos no ollama.com (query vazia → populares). Limita a `max` resultados.
pub async fn search(query: &str, max: usize) -> Result<Vec<RegistryModel>> {
    let url = format!(
        "https://ollama.com/search?q={}",
        urlencoding::encode(query.trim())
    );
    let html = crate::tools::web::http()
        .get(&url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| anyhow!("ollama.com: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("ollama.com resposta inválida: {e}"))?;
    Ok(parse(&html, max))
}

fn parse(html: &str, max: usize) -> Vec<RegistryModel> {
    let doc = Html::parse_document(html);
    let card = Selector::parse("li[x-test-model]").unwrap();
    let link = Selector::parse(r#"a[href^="/library/"]"#).unwrap();
    let title = Selector::parse("[x-test-search-response-title]").unwrap();
    let desc = Selector::parse("p").unwrap();
    let cap = Selector::parse("[x-test-capability]").unwrap();
    let size = Selector::parse("[x-test-size]").unwrap();
    let pulls = Selector::parse("[x-test-pull-count]").unwrap();
    let updated = Selector::parse("[x-test-updated]").unwrap();

    let one = |el: ElementRef, sel: &Selector| -> String {
        el.select(sel)
            .next()
            .map(|e| e.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    };
    let many = |el: ElementRef, sel: &Selector| -> Vec<String> {
        el.select(sel)
            .map(|e| e.text().collect::<String>().trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    };

    let mut out = Vec::new();
    for el in doc.select(&card) {
        // nome = slug do href /library/<slug>; fallback ao título.
        let name = el
            .select(&link)
            .next()
            .and_then(|a| a.value().attr("href"))
            .and_then(|h| h.strip_prefix("/library/"))
            .map(|s| s.split(['/', '?', '#']).next().unwrap_or(s).to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| one(el, &title));
        if name.is_empty() {
            continue;
        }
        out.push(RegistryModel {
            name,
            description: one(el, &desc),
            capabilities: many(el, &cap),
            sizes: many(el, &size),
            pulls: one(el, &pulls),
            updated: one(el, &updated),
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

/// Lista todas as variantes (tags) de um modelo a partir de `ollama.com/library/<model>/tags`.
pub async fn fetch_tags(model: &str) -> Result<Vec<RegistryTag>> {
    let model = model.trim();
    let url = format!("https://ollama.com/library/{model}/tags");
    let html = crate::tools::web::http()
        .get(&url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| anyhow!("ollama.com/library/{model}/tags: {e}"))?
        .text()
        .await
        .map_err(|e| anyhow!("ollama.com resposta inválida: {e}"))?;
    Ok(parse_tags(&html, model))
}

/// "16GB"/"512MB" → tamanho em MB, para ordenar (None se não for tamanho).
fn size_to_mb(s: &str) -> Option<u64> {
    let up = s.to_uppercase();
    let (num, mult) = if let Some(n) = up.strip_suffix("GB") {
        (n, 1000.0)
    } else if let Some(n) = up.strip_suffix("MB") {
        (n, 1.0)
    } else {
        return None;
    };
    num.trim().parse::<f64>().ok().map(|v| (v * mult) as u64)
}

/// Token de contexto tipo "256K"/"128K" (dígitos seguidos de 'K').
fn is_context(s: &str) -> bool {
    s.len() >= 2
        && s.ends_with('K')
        && s[..s.len() - 1].chars().all(|c| c.is_ascii_digit())
}

/// Faz o parsing da página de tags: cada linha é `div.group.px-4.py-3`; o nome vem do href
/// `/library/<model>:<tag>` e o tamanho/contexto do texto da linha (sem depender de classes voláteis).
fn parse_tags(html: &str, model: &str) -> Vec<RegistryTag> {
    let doc = Html::parse_document(html);
    let row = Selector::parse("div.group.px-4.py-3").unwrap();
    let link = Selector::parse(r#"a[href^="/library/"]"#).unwrap();
    let want = format!("{model}:");

    let mut out: Vec<RegistryTag> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for el in doc.select(&row) {
        // Nome completo (model:tag) do 1.º link da linha que pertence a este modelo.
        let name = el
            .select(&link)
            .filter_map(|a| a.value().attr("href").and_then(|h| h.strip_prefix("/library/")))
            .find(|s| s.starts_with(&want))
            .map(|s| s.to_string());
        let Some(name) = name else { continue };
        if !seen.insert(name.clone()) {
            continue;
        }
        // Varre os tokens do texto da linha: 1.º "…GB/…MB" = tamanho; "…K" antes de "context" = contexto.
        let text = el.text().collect::<String>();
        let toks: Vec<&str> = text.split_whitespace().collect();
        let mut size = String::new();
        let mut context = String::new();
        for (i, raw) in toks.iter().enumerate() {
            let tk = raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '.');
            if size.is_empty() && size_to_mb(tk).is_some() {
                size = tk.to_string();
            }
            if context.is_empty()
                && is_context(tk)
                && toks.get(i + 1).is_some_and(|n| n.starts_with("context"))
            {
                context = tk.to_string();
            }
        }
        out.push(RegistryTag { name, size, context });
        if out.len() >= 200 {
            break;
        }
    }
    // Mais leves primeiro (ajuda quem tem poucos recursos); cloud/sem-tamanho no fim.
    out.sort_by_key(|t| size_to_mb(&t.size).unwrap_or(u64::MAX));
    out
}
