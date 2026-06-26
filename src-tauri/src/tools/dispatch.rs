//! Dispatcher de ferramentas: agrega os schemas das tools disponíveis (browser +
//! servidores MCP) e encaminha cada chamada pelo prefixo do nome. Substitui o
//! `match` hardcoded que vivia no loop agêntico.

use anyhow::Result;
use serde_json::Value;

use crate::mcp::McpManager;
use crate::tools::browser::PlaywrightSidecar;
use crate::tools::{browser_tools_schema, BrowserTool};

/// Tudo o que o loop agêntico (`agent::run`) precisa de uma fonte de ferramentas.
pub trait ToolHost {
    /// Schemas no formato `tools` da API Anthropic.
    fn schemas(&self) -> Value;
    /// Executa uma ferramenta pelo nome e devolve o resultado (texto).
    async fn call(&mut self, name: &str, params: &Value) -> Result<String>;
}

/// Agregador concreto: browser (opcional) + servidores MCP (opcional).
/// Empresta os recursos por referência para a duração do loop.
pub struct Dispatcher<'a> {
    pub browser: Option<&'a mut PlaywrightSidecar>,
    pub mcp: Option<&'a mut McpManager>,
}

impl ToolHost for Dispatcher<'_> {
    fn schemas(&self) -> Value {
        let mut arr: Vec<Value> = Vec::new();
        if self.browser.is_some() {
            if let Some(a) = browser_tools_schema().as_array() {
                arr.extend(a.clone());
            }
        }
        if let Some(m) = &self.mcp {
            arr.extend(m.tools_schema());
        }
        Value::Array(arr)
    }

    async fn call(&mut self, name: &str, params: &Value) -> Result<String> {
        if name.starts_with("mcp__") {
            return match self.mcp.as_mut() {
                Some(m) => m.call(name, params).await,
                None => Ok(format!("servidor MCP indisponível para {name}")),
            };
        }
        match self.browser.as_mut() {
            Some(b) => match name {
                "browser_navigate" => b.call("navigate", params).await,
                "browser_read_text" => b.call("read_text", params).await,
                "browser_click" => b.call("click", params).await,
                "browser_fill" => b.call("fill", params).await,
                "browser_screenshot" => b.call("screenshot", params).await,
                other => Ok(format!("ferramenta desconhecida: {other}")),
            },
            None => Ok(format!("ferramenta desconhecida: {name}")),
        }
    }
}
