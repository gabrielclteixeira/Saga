//! Cliente do sidecar Node/Playwright. Comunica por JSON linha-a-linha sobre stdio.
//! Mantém um processo vivo (sessão/página persistente) durante a vida da app.

use anyhow::{anyhow, Result};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::BrowserTool;

pub struct PlaywrightSidecar {
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl PlaywrightSidecar {
    pub async fn spawn(node: &str, script: &str, user_data_dir: &str) -> Result<Self> {
        if script.trim().is_empty() {
            return Err(anyhow!(
                "caminho do sidecar do browser não configurado (Definições → Browser)"
            ));
        }
        let mut child = Command::new(node)
            .arg(script)
            .env("SAGA_USER_DATA_DIR", user_data_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| anyhow!("falha a lançar o sidecar ({node} {script}): {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sem stdin no sidecar"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sem stdout no sidecar"))?;
        let stdout = BufReader::new(stdout).lines();

        Ok(Self {
            _child: child,
            stdin,
            stdout,
            next_id: 0,
        })
    }
}

impl BrowserTool for PlaywrightSidecar {
    async fn call(&mut self, action: &str, params: &serde_json::Value) -> Result<String> {
        self.next_id += 1;
        let id = self.next_id;
        let req = json!({ "id": id, "action": action, "params": params });
        let line = format!("{}\n", req);

        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| anyhow!("falha a escrever no sidecar: {e}"))?;
        self.stdin.flush().await.ok();

        loop {
            let line = self
                .stdout
                .next_line()
                .await
                .map_err(|e| anyhow!("falha a ler do sidecar: {e}"))?
                .ok_or_else(|| anyhow!("o sidecar do browser terminou inesperadamente"))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue; // linha de log do sidecar — ignora
            };
            if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
                continue;
            }
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                let text = match v.get("result") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => "ok".into(),
                };
                return Ok(text);
            }
            let err = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("erro desconhecido");
            return Err(anyhow!("ferramenta de browser falhou: {err}"));
        }
    }
}
