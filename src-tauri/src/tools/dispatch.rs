//! Dispatcher de ferramentas: agrega os schemas das tools disponíveis (browser +
//! servidores MCP) e encaminha cada chamada pelo prefixo do nome. Aplica também a
//! "espinha de segurança": regista cada ação e, conforme o modo, pré-visualiza
//! (dry-run) ou pede aprovação ao utilizador (ask) antes de executar.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::mcp::McpManager;
use crate::tools::browser::PlaywrightSidecar;
use crate::tools::{browser_tools_schema, BrowserTool};
use crate::workspace::WorkspaceIndex;

/// Tudo o que o loop agêntico (`agent::run`) precisa de uma fonte de ferramentas.
pub trait ToolHost {
    /// Schemas no formato `tools` da API Anthropic.
    fn schemas(&self) -> Value;
    /// Texto opcional a acrescentar ao system prompt (ex.: skills disponíveis).
    fn system_addendum(&self) -> Option<String> {
        None
    }
    /// Executa uma ferramenta pelo nome e devolve o resultado (texto).
    async fn call(&mut self, name: &str, params: &Value) -> Result<String>;
}

/// Acesso ao workspace (skills/playbooks) para o dispatcher.
pub struct WorkspaceTools<'a> {
    pub dir: &'a str,
    pub index: &'a WorkspaceIndex,
}

/// Modo de confirmação de ações.
#[derive(Clone, Copy, PartialEq)]
pub enum ConfirmMode {
    Off,
    DryRun,
    Ask,
}

impl ConfirmMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "dry_run" => Self::DryRun,
            "ask" => Self::Ask,
            _ => Self::Off,
        }
    }
}

/// Futuro devolvido por um `Approver` (boxed para ser usável como `dyn`).
pub type ApprovalFut<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

/// Pede aprovação de uma ação ao utilizador. Implementado em `commands.rs`
/// (envia um evento à UI e espera a resposta).
pub trait Approver: Send + Sync {
    fn request<'a>(&'a self, tool: &'a str, preview: &'a str) -> ApprovalFut<'a>;
}

/// Regista ações no SQLite e aplica o gate de confirmação.
pub struct ActionGate<'a> {
    pub db: Option<&'a Mutex<Connection>>,
    pub conversation_id: i64,
    pub mode: ConfirmMode,
    pub approver: Option<&'a dyn Approver>,
}

impl ActionGate<'_> {
    fn insert(&self, tool: &str, params: &Value, status: &str, detail: &str, error: &str) -> i64 {
        if let Some(db) = self.db {
            if let Ok(conn) = db.lock() {
                return crate::store::insert_action(
                    &conn,
                    self.conversation_id,
                    tool,
                    &params.to_string(),
                    status,
                    detail,
                    error,
                )
                .unwrap_or(0);
            }
        }
        0
    }

    fn finish(&self, id: i64, status: &str, detail: &str, error: &str) {
        if id == 0 {
            return;
        }
        if let Some(db) = self.db {
            if let Ok(conn) = db.lock() {
                let _ = crate::store::update_action(&conn, id, status, detail, error);
            }
        }
    }
}

/// Ações que mutam estado e por isso passam pelo gate de confirmação.
/// Leituras/navegação não pedem confirmação (mas são na mesma registadas).
fn is_action(name: &str) -> bool {
    if name.starts_with("mcp__") {
        return true;
    }
    matches!(name, "browser_click" | "browser_fill")
}

/// Agregador concreto: browser (opcional) + servidores MCP (opcional) + gate.
/// Empresta os recursos por referência para a duração do loop.
pub struct Dispatcher<'a> {
    pub browser: Option<&'a mut PlaywrightSidecar>,
    pub mcp: Option<&'a mut McpManager>,
    pub workspace: Option<WorkspaceTools<'a>>,
    pub gate: ActionGate<'a>,
}

impl Dispatcher<'_> {
    /// Execução crua, sem gate/log — encaminha pelo nome.
    async fn exec_raw(&mut self, name: &str, params: &Value) -> Result<String> {
        // Tools de workspace (leitura de skills/playbooks).
        if name == "load_skill" || name == "read_playbook" {
            let n = params.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let ws = self.workspace.as_ref();
            return Ok(match name {
                "load_skill" => ws
                    .and_then(|w| crate::workspace::read_skill(w.dir, n))
                    .unwrap_or_else(|| format!("skill '{n}' não encontrada")),
                _ => ws
                    .and_then(|w| crate::workspace::read_playbook(w.dir, n))
                    .unwrap_or_else(|| format!("playbook '{n}' não encontrado")),
            });
        }
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
        if let Some(ws) = &self.workspace {
            if !ws.index.skills.is_empty() {
                arr.push(json!({
                    "name": "load_skill",
                    "description": "Carrega as instruções completas de uma skill do workspace pelo nome.",
                    "input_schema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
                }));
            }
            if !ws.index.playbooks.is_empty() {
                arr.push(json!({
                    "name": "read_playbook",
                    "description": "Lê um playbook (procedimento reutilizável) do workspace pelo nome.",
                    "input_schema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
                }));
            }
        }
        Value::Array(arr)
    }

    fn system_addendum(&self) -> Option<String> {
        let ws = self.workspace.as_ref()?;
        if ws.index.skills.is_empty() && ws.index.playbooks.is_empty() {
            return None;
        }
        let mut s = String::new();
        if !ws.index.skills.is_empty() {
            s.push_str(
                "Skills disponíveis (chama load_skill para carregar as instruções quando a tarefa encaixar):\n",
            );
            for sk in &ws.index.skills {
                s.push_str(&format!("- {}: {}\n", sk.name, sk.description));
            }
        }
        if !ws.index.playbooks.is_empty() {
            s.push_str("\nPlaybooks disponíveis (chama read_playbook):\n");
            for p in &ws.index.playbooks {
                s.push_str(&format!("- {p}\n"));
            }
        }
        Some(s)
    }

    async fn call(&mut self, name: &str, params: &Value) -> Result<String> {
        // Gate de confirmação (só para ações).
        if is_action(name) {
            match self.gate.mode {
                ConfirmMode::DryRun => {
                    let preview = format!("[dry-run] {name} {params}");
                    self.gate.insert(name, params, "PREVIEW", &preview, "");
                    return Ok(preview);
                }
                ConfirmMode::Ask => {
                    let preview = format!("{name} {params}");
                    let approved = match self.gate.approver {
                        Some(a) => a.request(name, &preview).await,
                        None => true,
                    };
                    if !approved {
                        self.gate
                            .insert(name, params, "ERRO", "", "recusada pelo utilizador");
                        return Ok("ação recusada pelo utilizador".into());
                    }
                }
                ConfirmMode::Off => {}
            }
        }

        // Regista início, executa, regista resultado.
        let log_id = self.gate.insert(name, params, "EM_EXECUCAO", "", "");
        let res = self.exec_raw(name, params).await;
        match &res {
            Ok(detail) => self.gate.finish(log_id, "OK", detail, ""),
            Err(e) => self.gate.finish(log_id, "ERRO", "", &e.to_string()),
        }
        res
    }
}
