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

/// Pasta de um projeto (file tools sandboxed à pasta). `writable` = pode editar/criar (confirmado).
pub struct ProjectTools {
    pub root: String,
    pub writable: bool,
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

/// Decisão do gate antes de executar uma tool.
pub enum Gate {
    /// Não executar — devolve este texto como resultado (pré-visualização dry-run ou recusa).
    Blocked(String),
    /// Pode executar; passa o `log_id` ao `finish` no fim.
    Proceed(i64),
}

impl ActionGate<'_> {
    /// Aplica o gate de confirmação antes de uma tool. `needs_confirm` = a tool muta estado.
    /// Partilhado pela rota Claude (Dispatcher) e pela rota local (web_agent) — fonte única.
    pub async fn begin(&self, name: &str, params: &Value, needs_confirm: bool) -> Gate {
        if needs_confirm {
            match self.mode {
                ConfirmMode::DryRun => {
                    let preview = format!("[dry-run] {name} {params}");
                    self.insert(name, params, "PREVIEW", &preview, "");
                    return Gate::Blocked(preview);
                }
                ConfirmMode::Ask => {
                    let preview = format!("{name} {params}");
                    let approved = match self.approver {
                        Some(a) => a.request(name, &preview).await,
                        None => true,
                    };
                    if !approved {
                        self.insert(name, params, "ERRO", "", "recusada pelo utilizador");
                        return Gate::Blocked("ação recusada pelo utilizador".into());
                    }
                }
                ConfirmMode::Off => {}
            }
        }
        Gate::Proceed(self.insert(name, params, "EM_EXECUCAO", "", ""))
    }

    pub fn insert(&self, tool: &str, params: &Value, status: &str, detail: &str, error: &str) -> i64 {
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

    pub fn finish(&self, id: i64, status: &str, detail: &str, error: &str) {
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
pub(crate) fn is_action(name: &str) -> bool {
    if name.starts_with("mcp__") {
        return true;
    }
    matches!(
        name,
        "browser_click"
            | "browser_fill"
            | "save_workspace_doc"
            | "project_edit"
            | "project_create"
            | "project_delete"
    )
}

/// Agregador concreto: browser (opcional) + servidores MCP (opcional) + gate.
/// Empresta os recursos por referência para a duração do loop.
pub struct Dispatcher<'a> {
    pub browser: Option<&'a mut PlaywrightSidecar>,
    pub mcp: Option<&'a mut McpManager>,
    pub workspace: Option<WorkspaceTools<'a>>,
    pub project: Option<ProjectTools>,
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
        // File tools do projeto (sandboxed à pasta; escritas passam pelo gate via is_action).
        if let Some(p) = &self.project {
            if matches!(
                name,
                "project_tree" | "project_read" | "project_edit" | "project_create" | "project_delete"
            ) {
                use crate::tools::project;
                if name == "project_delete" {
                    let path = params.get("path").and_then(|x| x.as_str()).unwrap_or("");
                    return Ok(match project::delete_file(&p.root, path) {
                        Ok(_) => format!("apagado: {path}"),
                        Err(e) => format!("ERRO: {e}"),
                    });
                }
                return Ok(match name {
                    "project_tree" => {
                        let sub = params.get("subpath").and_then(|x| x.as_str()).unwrap_or("");
                        let root = if sub.trim().is_empty() {
                            p.root.clone()
                        } else {
                            match project::resolve_in_root(&p.root, sub) {
                                Some(pp) => pp.to_string_lossy().to_string(),
                                None => return Ok(format!("caminho fora da pasta do projeto: {sub}")),
                            }
                        };
                        let tree = project::tree_text(&root, 600);
                        if tree.trim().is_empty() {
                            "(vazio ou pasta inacessível)".into()
                        } else {
                            tree
                        }
                    }
                    "project_read" => {
                        let path = params.get("path").and_then(|x| x.as_str()).unwrap_or("");
                        project::read_file(&p.root, path).unwrap_or_else(|e| format!("ERRO: {e}"))
                    }
                    // edit | create: ambos gravam o conteúdo completo (a distinção é semântica p/ o modelo).
                    _ => {
                        let path = params.get("path").and_then(|x| x.as_str()).unwrap_or("");
                        let content = params.get("content").and_then(|x| x.as_str()).unwrap_or("");
                        match project::write_file(&p.root, path, content) {
                            Ok(_) => format!("gravado: {path}"),
                            Err(e) => format!("ERRO: {e}"),
                        }
                    }
                });
            }
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
                    let theme = params.get("theme").and_then(|x| x.as_str()).unwrap_or("report");
                    let html = wrap_print_html(title, body, theme);
                    b.call("pdf", &json!({ "title": title, "html": html })).await
                }
                other => Ok(format!("ferramenta desconhecida: {other}")),
            },
            None => Ok("PDF indisponível: ativa as ferramentas de browser (sidecar) nas Definições/Modelos.".into()),
        }
    }
}

/// Tema de impressão polido (espelha PRINT_CSS no frontend): capa, escala tipográfica,
/// títulos/tabelas/callouts/código estilizados e controlo de quebras de página.
const PRINT_CSS: &str = "\
:root{--ink:#1c2b3a;--accent:#2f6ea5;--muted:#5a6b7d;--line:#d8e0e8;--soft:#f3f6fa;}\
@page{margin:20mm 18mm;}*{box-sizing:border-box;}\
body{font:11.5pt/1.65 'Segoe UI',-apple-system,Roboto,sans-serif;color:var(--ink);margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}\
.doc-cover{border-bottom:3px solid var(--accent);padding-bottom:14px;margin-bottom:26px;page-break-after:avoid;}\
.doc-cover .eyebrow{text-transform:uppercase;letter-spacing:0.14em;font-size:8.5pt;font-weight:700;color:var(--accent);margin:0 0 6px;}\
.doc-cover h1{font-size:26pt;line-height:1.12;margin:0;}\
h1,h2,h3,h4{line-height:1.22;page-break-after:avoid;}\
h1{font-size:20pt;margin:1.4em 0 .5em;}\
h2{font-size:15pt;margin:1.5em 0 .4em;padding-bottom:4px;border-bottom:1px solid var(--line);}\
h3{font-size:12.5pt;margin:1.2em 0 .3em;color:var(--accent);}\
p{margin:0 0 .8em;}a{color:var(--accent);text-decoration:none;}\
ul,ol{margin:0 0 .9em;padding-left:1.4em;}li{margin:.2em 0;}li::marker{color:var(--accent);}\
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid var(--accent);background:var(--soft);color:var(--muted);page-break-inside:avoid;}\
pre{background:var(--soft);border:1px solid var(--line);padding:12px 14px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;font-size:9.5pt;page-break-inside:avoid;}\
code{font-family:'Cascadia Code',ui-monospace,Menlo,monospace;font-size:9.5pt;}\
p code,li code{background:var(--soft);padding:1px 5px;border-radius:4px;}\
img,svg{max-width:100%;height:auto;}\
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:10pt;page-break-inside:avoid;}\
thead{background:var(--accent);color:#fff;}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;}\
tbody tr:nth-child(even){background:var(--soft);}hr{border:none;border-top:1px solid var(--line);margin:1.6em 0;}\
body[data-theme=article]{--ink:#241f1c;--accent:#7a2e3a;--muted:#6a5d57;--line:#e0d6cf;--soft:#f6f1ec;font-family:Georgia,'Iowan Old Style','Times New Roman',serif;font-size:12pt;line-height:1.7;max-width:165mm;margin:0 auto;}\
body[data-theme=article] .doc-cover{text-align:center;border-bottom-width:1px;padding-bottom:20px;}\
body[data-theme=article] .doc-cover h1{font-size:30pt;}\
body[data-theme=article] h2{border-bottom:none;font-style:italic;}\
body[data-theme=article] thead{background:transparent;color:var(--ink);border-bottom:2px solid var(--accent);}\
body[data-theme=article] th,body[data-theme=article] td{border:none;border-bottom:1px solid var(--line);}\
body[data-theme=technical]{--ink:#16201f;--accent:#0f6e6e;--muted:#4c5a59;--line:#cdd9d8;--soft:#eef4f4;font-size:10.5pt;line-height:1.55;}\
body[data-theme=technical] h1,body[data-theme=technical] h2,body[data-theme=technical] h3,body[data-theme=technical] .doc-cover .eyebrow{font-family:'Cascadia Code',ui-monospace,Menlo,monospace;}\
body[data-theme=technical] .doc-cover{border-bottom-style:double;border-bottom-width:4px;}\
body[data-theme=technical] h2{background:var(--soft);padding:5px 10px;border-bottom:none;border-left:4px solid var(--accent);}\
body[data-theme=technical] th,body[data-theme=technical] td{border:1px solid var(--accent);}\
body[data-theme=technical] pre{border-color:var(--accent);}";

/// Embrulha um corpo HTML num documento completo com estilo de impressão (para o create_pdf).
fn wrap_print_html(title: &str, body: &str, theme: &str) -> String {
    let esc = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let theme = match theme {
        "article" | "technical" => theme,
        _ => "report",
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{esc}</title><style>{PRINT_CSS}</style></head>\
<body data-theme=\"{theme}\"><header class=\"doc-cover\"><p class=\"eyebrow\">Saga</p><h1>{esc}</h1></header>{body}</body></html>"
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
        // File tools do projeto (a pasta do tópico). Leitura sempre; escrita só se writable.
        if let Some(p) = &self.project {
            arr.push(json!({
                "name": "project_tree",
                "description": "Lista a árvore de ficheiros da pasta do projeto. `subpath` (relativo, opcional) lista uma subpasta.",
                "input_schema": { "type": "object", "properties": { "subpath": { "type": "string" } } }
            }));
            arr.push(json!({
                "name": "project_read",
                "description": "Lê o conteúdo de um ficheiro do projeto (caminho relativo à raiz da pasta).",
                "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
            }));
            if p.writable {
                arr.push(json!({
                    "name": "project_edit",
                    "description": "Substitui o conteúdo completo de um ficheiro do projeto (caminho relativo). O utilizador confirma antes de gravar.",
                    "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }
                }));
                arr.push(json!({
                    "name": "project_create",
                    "description": "Cria um ficheiro novo no projeto (caminho relativo) com o conteúdo dado. O utilizador confirma antes de gravar.",
                    "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }
                }));
                arr.push(json!({
                    "name": "project_delete",
                    "description": "Apaga um ficheiro do projeto (caminho relativo). O utilizador confirma antes de apagar.",
                    "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
                }));
            }
        }
        Value::Array(arr)
    }

    fn system_addendum(&self) -> Option<String> {
        let mut s = String::new();
        if let Some(ws) = self.workspace.as_ref() {
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
                    s.push_str(&format!("- {}\n", p.name));
                }
            }
            if !ws.index.skills.is_empty() || !ws.index.playbooks.is_empty() {
                s.push_str(
                    "\nPodes criar ou editar skills, playbooks e workflows com a ferramenta save_workspace_doc quando o utilizador pedir.\n",
                );
            }
        }
        if let Some(p) = &self.project {
            s.push_str(
                "\nProjeto: tens acesso aos ficheiros da pasta do projeto — usa project_tree e project_read para explorar antes de responder.",
            );
            if p.writable {
                s.push_str(
                    " Podes editar/criar/apagar com project_edit/project_create/project_delete (cada ação é confirmada pelo utilizador). Usa caminhos relativos à raiz. project_create é só para ficheiros novos — se já existir, usa project_edit. Quando te pedirem para criar/editar um ficheiro, USA estas ferramentas — não mandes copiar/colar nem digas que não tens acesso ao disco.",
                );
            }
            s.push('\n');
        }
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    async fn call(&mut self, name: &str, params: &Value) -> Result<String> {
        // `project_create` é só para ficheiros novos: se o ficheiro já existe, instrui o modelo a
        // usar `project_edit` — antes do gate, para não pedir uma confirmação que ia sobrescrever
        // às escondidas (senão o modelo desiste e manda copiar/colar à mão).
        if name == "project_create" {
            if let Some(p) = &self.project {
                let path = params.get("path").and_then(|x| x.as_str()).unwrap_or("");
                if crate::tools::project::file_exists(&p.root, path) {
                    return Ok(format!(
                        "o ficheiro '{path}' já existe — usa project_edit para substituir o conteúdo (project_create é só para ficheiros novos)"
                    ));
                }
            }
        }
        // Gate de confirmação (só para ações) + registo início/fim no action_log.
        let log_id = match self.gate.begin(name, params, is_action(name)).await {
            Gate::Blocked(msg) => return Ok(msg),
            Gate::Proceed(id) => id,
        };
        let res = self.exec_raw(name, params).await;
        match &res {
            Ok(detail) => self.gate.finish(log_id, "OK", detail, ""),
            Err(e) => self.gate.finish(log_id, "ERRO", "", &e.to_string()),
        }
        res
    }
}
