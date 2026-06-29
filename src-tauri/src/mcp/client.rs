//! Cliente MCP (Model Context Protocol) sobre stdio. Lança um servidor MCP como
//! subprocesso e fala JSON-RPC 2.0 delimitado por newline — o mesmo padrão de
//! transporte do sidecar do browser, mas com o envelope JSON-RPC do MCP.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Versão do protocolo que anunciamos no handshake. O servidor responde com a
/// versão que vai usar; a maioria aceita ou negoceia para baixo.
const PROTOCOL_VERSION: &str = "2025-06-18";

pub struct McpClient {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl McpClient {
    /// Lança o servidor e faz o handshake `initialize` + `notifications/initialized`.
    pub async fn spawn(command: &str, args: &[String], env: &[(String, String)]) -> Result<Self> {
        if command.trim().is_empty() {
            return Err(anyhow!("comando do servidor MCP não configurado"));
        }
        // Apps GUI no macOS têm PATH mínimo e não veem o npx/node — resolve o comando + PATH aumentado
        // (o env do servidor, a seguir, ainda se pode sobrepor ao PATH se for explícito).
        let launch = crate::which::launch_path(command);
        let mut cmd = Command::new(&launch);
        cmd.args(args);
        cmd.env("PATH", crate::which::augmented_path());
        for (k, v) in env {
            cmd.env(k, v);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — não abrir consola no Windows
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow!("falha a lançar servidor MCP ({command}): {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sem stdin no servidor MCP"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sem stdout no servidor MCP"))?;
        let stdout = BufReader::new(stdout).lines();

        let mut client = Self {
            _child: child,
            stdin,
            stdout,
            next_id: 0,
        };
        client.initialize().await?;
        Ok(client)
    }

    async fn initialize(&mut self) -> Result<()> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "saga", "version": env!("CARGO_PKG_VERSION") }
        });
        self.request("initialize", params).await?;
        self.notify("notifications/initialized", json!({})).await?;
        Ok(())
    }

    async fn send_line(&mut self, v: &Value) -> Result<()> {
        let line = format!("{}\n", v);
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| anyhow!("falha a escrever no servidor MCP: {e}"))?;
        self.stdin.flush().await.ok();
        Ok(())
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.send_line(&msg).await
    }

    /// Envia um pedido e espera a resposta com o `id` correspondente, ignorando
    /// notificações e pedidos do servidor pelo meio.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.send_line(&msg).await?;

        loop {
            let line = self
                .stdout
                .next_line()
                .await
                .map_err(|e| anyhow!("falha a ler do servidor MCP: {e}"))?
                .ok_or_else(|| anyhow!("o servidor MCP terminou inesperadamente"))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                continue; // linha de log do servidor — ignora
            };
            if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
                continue;
            }
            if let Some(err) = v.get("error") {
                let m = err
                    .get("message")
                    .and_then(|x| x.as_str())
                    .unwrap_or("erro do servidor MCP");
                return Err(anyhow!("{m}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Lista as ferramentas do servidor (`tools/list`).
    pub async fn list_tools(&mut self) -> Result<Vec<Value>> {
        let res = self.request("tools/list", json!({})).await?;
        Ok(res
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default())
    }

    /// Invoca uma ferramenta (`tools/call`) e devolve o texto agregado do resultado.
    pub async fn call_tool(&mut self, tool: &str, args: &Value) -> Result<String> {
        let res = self
            .request("tools/call", json!({ "name": tool, "arguments": args }))
            .await?;
        if res.get("isError").and_then(|x| x.as_bool()) == Some(true) {
            return Err(anyhow!("{}", extract_text(&res)));
        }
        Ok(extract_text(&res))
    }
}

/// Extrai o texto de um resultado MCP (`content: [{type:"text", text}]`).
fn extract_text(res: &Value) -> String {
    if let Some(arr) = res.get("content").and_then(|c| c.as_array()) {
        let mut out = String::new();
        for block in arr {
            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    res.to_string()
}
