//! Ferramentas que o modelo pode chamar (tool-calling): browser + servidores MCP,
//! agregados pelo `dispatch::Dispatcher`.

pub mod browser;
pub mod dispatch;
pub mod project;
pub mod web;

use anyhow::Result;

/// Abstração de uma ferramenta de browser — trocável (Playwright sidecar, chromiumoxide, …).
pub trait BrowserTool {
    async fn call(&mut self, action: &str, params: &serde_json::Value) -> Result<String>;
}

/// Schema das ferramentas de browser, no formato `tools` da API Anthropic.
pub fn browser_tools_schema() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "browser_navigate",
            "description": "Abre um URL no browser e devolve o título da página.",
            "input_schema": {
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }
        },
        {
            "name": "browser_read_text",
            "description": "Devolve o texto visível da página atual.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "browser_click",
            "description": "Clica num elemento identificado por um selector CSS.",
            "input_schema": {
                "type": "object",
                "properties": { "selector": { "type": "string" } },
                "required": ["selector"]
            }
        },
        {
            "name": "browser_fill",
            "description": "Preenche um campo (selector CSS) com texto.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "selector": { "type": "string" },
                    "text": { "type": "string" }
                },
                "required": ["selector", "text"]
            }
        },
        {
            "name": "browser_screenshot",
            "description": "Tira uma screenshot da página e devolve o caminho do ficheiro.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "create_pdf",
            "description": "Cria um ficheiro PDF a partir de conteúdo HTML e devolve o caminho. Usa quando o utilizador pedir um PDF, relatório ou documento. Passa o corpo em HTML simples (<h1>,<h2>,<p>,<ul>,<ol>,<table>,<pre>,<strong>…); o estilo de impressão é aplicado automaticamente.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "título do documento (também o nome do ficheiro)" },
                    "html": { "type": "string", "description": "corpo do documento em HTML" },
                    "theme": { "type": "string", "enum": ["report", "article", "technical"], "description": "estilo visual: 'report' (corporativo, omissão), 'article' (editorial serifado), 'technical' (denso, monoespaçado)" }
                },
                "required": ["title", "html"]
            }
        }
    ])
}
