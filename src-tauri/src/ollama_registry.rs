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
