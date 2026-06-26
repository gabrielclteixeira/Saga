//! Suporte a MCP (Model Context Protocol) — a Saga como *cliente/host* MCP.
//! Liga-se a servidores MCP configurados pelo utilizador (stdio) e expõe as
//! ferramentas deles ao loop agêntico, com nomes `mcp__<servidor>__<tool>`.

pub mod client;

use anyhow::{anyhow, Result};
use client::McpClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Configuração de um servidor MCP (persistida nas Definições). O `env` pode
/// conter segredos → guardado na keychain, não no settings.json.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub enabled: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            enabled: false,
        }
    }
}

struct ServerRuntime {
    client: McpClient,
    /// Schemas já em formato Anthropic, com nomes prefixados `mcp__<servidor>__<tool>`.
    tools: Vec<Value>,
}

/// Gere os servidores MCP ativos. Lançamento preguiçoso; os processos ficam vivos
/// durante a sessão da app.
#[derive(Default)]
pub struct McpManager {
    servers: HashMap<String, ServerRuntime>,
}

impl McpManager {
    /// Garante que todos os servidores ativos estão lançados e com as tools listadas.
    /// Erros de arranque são registados e ignorados (não derrubam o pedido).
    pub async fn ensure_ready(&mut self, configs: &[McpServerConfig]) {
        for cfg in configs
            .iter()
            .filter(|c| c.enabled && !c.name.trim().is_empty())
        {
            if self.servers.contains_key(&cfg.name) {
                continue;
            }
            match McpClient::spawn(&cfg.command, &cfg.args, &cfg.env).await {
                Ok(mut client) => {
                    let tools = client.list_tools().await.unwrap_or_default();
                    let prefixed = tools
                        .iter()
                        .map(|t| to_anthropic_tool(&cfg.name, t))
                        .collect();
                    self.servers.insert(
                        cfg.name.clone(),
                        ServerRuntime {
                            client,
                            tools: prefixed,
                        },
                    );
                }
                Err(e) => log::warn!("MCP '{}' falhou a arrancar: {e}", cfg.name),
            }
        }
    }

    /// Schemas de todas as tools de todos os servidores ligados (formato Anthropic).
    pub fn tools_schema(&self) -> Vec<Value> {
        self.servers
            .values()
            .flat_map(|s| s.tools.clone())
            .collect()
    }

    pub fn has_tools(&self) -> bool {
        self.servers.values().any(|s| !s.tools.is_empty())
    }

    /// Invoca uma tool pelo nome prefixado `mcp__<servidor>__<tool>`.
    pub async fn call(&mut self, prefixed: &str, args: &Value) -> Result<String> {
        let rest = prefixed
            .strip_prefix("mcp__")
            .ok_or_else(|| anyhow!("nome de tool MCP inválido: {prefixed}"))?;
        let (server, tool) = rest
            .split_once("__")
            .ok_or_else(|| anyhow!("nome de tool MCP inválido: {prefixed}"))?;
        let rt = self
            .servers
            .get_mut(server)
            .ok_or_else(|| anyhow!("servidor MCP '{server}' não está ligado"))?;
        rt.client.call_tool(tool, args).await
    }
}

/// Converte uma tool MCP (`{name, description, inputSchema}`) para o formato
/// `tools` da API Anthropic, prefixando o nome com o servidor.
fn to_anthropic_tool(server: &str, t: &Value) -> Value {
    let name = t.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
    let desc = t.get("description").and_then(|x| x.as_str()).unwrap_or("");
    let input_schema = t
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    json!({
        "name": format!("mcp__{server}__{name}"),
        "description": desc,
        "input_schema": input_schema,
    })
}

/// Testa um servidor (para o botão "Testar ligação"): lança, faz handshake,
/// lista tools e devolve os nomes. O processo é descartado de seguida.
pub async fn test_server(cfg: &McpServerConfig) -> Result<Vec<String>> {
    let mut client = McpClient::spawn(&cfg.command, &cfg.args, &cfg.env).await?;
    let tools = client.list_tools().await?;
    Ok(tools
        .iter()
        .filter_map(|t| {
            t.get("name")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .collect())
}
