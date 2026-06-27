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
    matches!(name, "browser_click" | "browser_fill" | "save_workspace_doc")
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
        // Criação/edição de documentos do workspace (ação).
        if name == "save_workspace_doc" {
            let kind = params.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            let n = params.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let content = params.get("content").and_then(|x| x.as_str()).unwrap_or("");
            return Ok(match self.workspace.as_ref() {
                Some(w) => match crate::workspace::write_doc(w.dir, kind, n, content) {
                    Ok(_) => format!("guardado: {kind} '{n}'"),
                    Err(e) => format!("ERRO ao guardar: {e}"),
                },
                None => "workspace indisponível".into(),
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
                "create_pdf" => {
                    let title = params.get("title").and_then(|x| x.as_str()).unwrap_or("documento");
                    let body = params.get("html").and_then(|x| x.as_str()).unwrap_or("");
                    let html = wrap_print_html(title, body);
                    b.call("pdf", &json!({ "title": title, "html": html })).await
                }
                other => Ok(format!("ferramenta desconhecida: {other}")),
            },
            None => Ok("PDF indisponível: ativa as ferramentas de browser (sidecar) nas Definições/Modelos.".into()),
        }
    }
}

/// Embrulha um corpo HTML num documento completo com estilo de impressão (para o create_pdf).
fn wrap_print_html(title: &str, body: &str) -> String {
    let esc = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{esc}</title><style>\
@page {{ margin: 18mm; }} \
body {{ font: 13px/1.6 -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; }} \
h1,h2,h3 {{ line-height: 1.25; }} h1 {{ font-size: 22px; }} \
pre {{ background:#f4f4f5; padding:10px 12px; border-radius:6px; white-space:pre-wrap; word-wrap:break-word; }} \
code {{ font-family: ui-monospace, Menlo, monospace; }} \
img,svg {{ max-width:100%; height:auto; }} \
table {{ border-collapse:collapse; }} th,td {{ border:1px solid #ccc; padding:4px 8px; }} \
a {{ color:#2563eb; }}\
</style></head><body><h1>{esc}</h1>{body}</body></html>"
    )
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
            arr.push(json!({
                "name": "save_workspace_doc",
                "description": "Cria ou atualiza um documento do workspace (skill, playbook ou workflow) quando o utilizador o pedir. Skills e workflows devem incluir frontmatter (name, description).",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": ["skill", "playbook", "workflow"] },
                        "name": { "type": "string", "description": "nome sem espaços" },
                        "content": { "type": "string", "description": "markdown completo" }
                    },
                    "required": ["kind", "name", "content"]
                }
            }));
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
        s.push_str(
            "\nPodes criar ou editar skills, playbooks e workflows com a ferramenta save_workspace_doc quando o utilizador pedir.\n",
        );
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
