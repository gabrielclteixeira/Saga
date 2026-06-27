//! Comandos Tauri expostos ao frontend.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::oneshot;

use crate::accounting::Accounting;
use crate::mcp::McpManager;
use crate::providers::{estimate_tokens, ChatMessage};
use crate::router;
use crate::settings::Settings;
use crate::store::{self, ConversationMeta, SearchHit, StoredMessage};
use crate::tools::browser::PlaywrightSidecar;
use crate::tools::dispatch::{ActionGate, ApprovalFut, Approver, ConfirmMode, Dispatcher};
use crate::{agent, memory, providers};

/// Calcula a janela de contexto efetiva para um pedido local.
///
/// No Ollama, `num_ctx` é a janela TOTAL (prompt + resposta). Com um prompt grande
/// (ex.: um PDF anexado), a janela fixa enche-se e quase não sobra espaço para a
/// resposta — o modelo pára a meio. Aqui subimos a janela para caber o prompt + uma
/// folga para a resposta, arredondando para múltiplos de 1024 e limitando por um teto
/// (para não rebentar a VRAM). Nunca descemos abaixo do valor configurado pelo utilizador.
///
/// `estimate_tokens` (caracteres÷4) SUBESTIMA ~15% em português (acentos tokenizam mais);
/// se confiarmos nela à risca, a contagem real do prompt come a folga e a resposta corta-se
/// (visto: estimado 15k → num_ctx 17408, mas o prompt real eram 17199 → só 209 p/ resposta).
/// Por isso inflacionamos a estimativa antes de dimensionar a janela.
fn effective_num_ctx(base: u32, messages: &[ChatMessage]) -> u32 {
    const RESERVE: u64 = 4096; // espaço reservado para a resposta (resumos querem espaço)
    const CAP: u64 = 32768; // teto para limitar o uso de VRAM/latência
    const FUDGE: f64 = 1.3; // margem para a subestimação do tokenizer (PT/acentos)
    let prompt: u64 = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
    let needed = (prompt as f64 * FUDGE) as u64 + RESERVE;
    // Arredonda para cima ao próximo múltiplo de 1024.
    let rounded = needed.div_ceil(1024) * 1024;
    let target = rounded.min(CAP).max(base as u64);
    target as u32
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub accounting: Mutex<Accounting>,
    pub db: Mutex<Connection>,
    /// Sidecar do browser, criado preguiçosamente na 1.ª utilização de ferramentas.
    pub browser: tokio::sync::Mutex<Option<PlaywrightSidecar>>,
    /// Servidores MCP ativos, lançados preguiçosamente.
    pub mcp: tokio::sync::Mutex<McpManager>,
    /// Aprovações de ações pendentes (id → canal de resposta), para o modo "ask".
    pub pending: tokio::sync::Mutex<HashMap<u64, oneshot::Sender<bool>>>,
    pub approval_seq: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        let db = store::open().expect("falha a abrir a base de dados SQLite");
        Self {
            settings: Mutex::new(Settings::load()),
            accounting: Mutex::new(Accounting::default()),
            db: Mutex::new(db),
            browser: tokio::sync::Mutex::new(None),
            mcp: tokio::sync::Mutex::new(McpManager::default()),
            pending: tokio::sync::Mutex::new(HashMap::new()),
            approval_seq: AtomicU64::new(0),
        }
    }
}

/// Implementação de `Approver`: envia um pedido de aprovação à UI e espera a resposta.
struct ChannelApprover<'a> {
    channel: Channel<StreamEvent>,
    state: &'a AppState,
}

impl Approver for ChannelApprover<'_> {
    fn request<'a>(&'a self, tool: &'a str, preview: &'a str) -> ApprovalFut<'a> {
        Box::pin(async move {
            let id = self.state.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let (tx, rx) = oneshot::channel();
            self.state.pending.lock().await.insert(id, tx);
            let _ = self.channel.send(StreamEvent::ApprovalRequest {
                id,
                tool: tool.to_string(),
                preview: preview.to_string(),
            });
            rx.await.unwrap_or(false)
        })
    }
}

/// Eventos enviados ao frontend durante o streaming.
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum StreamEvent {
    Start {
        route: String,
        model: String,
        reason: String,
    },
    Delta {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolStep {
        tool: String,
        detail: String,
    },
    ApprovalRequest {
        id: u64,
        tool: String,
        preview: String,
    },
    Done {
        input_tokens: u64,
        output_tokens: u64,
        tokens_saved: u64,
        cost_usd: f64,
        gen_ms: i64,
        accounting: Accounting,
    },
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub text: String,
    pub route: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens_saved: u64,
    pub cost_usd: f64,
    pub reason: String,
    pub accounting: Accounting,
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub fn get_accounting(state: State<AppState>) -> Accounting {
    state.accounting.lock().unwrap().clone()
}

#[tauri::command]
pub fn reset_accounting(state: State<AppState>) -> Accounting {
    let mut acc = state.accounting.lock().unwrap();
    *acc = Accounting::default();
    acc.clone()
}

#[tauri::command]
pub fn get_memory_preview(state: State<AppState>) -> String {
    let settings = state.settings.lock().unwrap().clone();
    memory::preview(&settings, 2000)
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub ollama_ok: bool,
    pub ollama_models: Vec<String>,
    pub ollama_model_present: bool,
    pub claude_mode: String,
    pub claude_ready: bool,
    pub claude_detail: String,
}

/// Verifica o que está disponível (Ollama, Claude) para o wizard de 1.º arranque.
#[tauri::command]
pub async fn diagnostics(state: State<'_, AppState>) -> Result<Diagnostics, String> {
    let settings = state.settings.lock().unwrap().clone();

    let (ollama_ok, ollama_models) =
        match providers::ollama::list_models(&settings.ollama_endpoint).await {
            Ok(models) => (true, models),
            Err(_) => (false, Vec::new()),
        };
    let cfg = settings.ollama_model.clone();
    let ollama_model_present = ollama_models
        .iter()
        .any(|m| m == &cfg || m.split(':').next() == Some(cfg.as_str()));

    let (claude_ready, claude_detail) = match settings.claude_mode.as_str() {
        "api" => {
            if settings.claude_api_key.trim().is_empty() {
                (false, "API key em falta".into())
            } else {
                (true, "API key configurada".into())
            }
        }
        "cli" => {
            let path = settings.claude_cli_path.clone();
            let ok = tauri::async_runtime::spawn_blocking(move || {
                std::process::Command::new(&path)
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            if ok {
                (true, "Claude CLI detetada".into())
            } else {
                (false, "Claude CLI não encontrada".into())
            }
        }
        _ => (false, "Claude desligado".into()),
    };

    Ok(Diagnostics {
        ollama_ok,
        ollama_models,
        ollama_model_present,
        claude_mode: settings.claude_mode.clone(),
        claude_ready,
        claude_detail,
    })
}

// ---- Histórico de conversas ----

#[tauri::command]
pub fn list_conversations(state: State<AppState>) -> Result<Vec<ConversationMeta>, String> {
    let conn = state.db.lock().unwrap();
    store::list_conversations(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_conversation(state: State<AppState>, id: i64) -> Result<Vec<StoredMessage>, String> {
    let conn = state.db.lock().unwrap();
    store::get_messages(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn new_conversation(state: State<AppState>, title: Option<String>) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    store::create_conversation(&conn, title.as_deref().unwrap_or("Nova conversa"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_conversation(state: State<AppState>, id: i64, title: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::rename_conversation(&conn, id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_conversation(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::delete_conversation(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_chats(state: State<AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let conn = state.db.lock().unwrap();
    store::search_messages(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_conversation_accounting(state: State<AppState>, id: i64) -> Result<Accounting, String> {
    let conn = state.db.lock().unwrap();
    store::conversation_accounting(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn truncate_conversation(state: State<AppState>, id: i64, keep: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::truncate_conversation(&conn, id, keep).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Compaction {
    pub summary: String,
    pub upto: i64,
}

#[derive(Serialize)]
pub struct CompactResult {
    pub summary: String,
    pub upto: i64,
    pub messages_compacted: usize,
}

/// Lê o resumo/fronteira de compactação de uma Saga (para o frontend repor ao abrir).
#[tauri::command]
pub fn get_compaction(state: State<AppState>, id: i64) -> Result<Compaction, String> {
    let conn = state.db.lock().unwrap();
    let (summary, upto) = store::get_compaction(&conn, id).map_err(|e| e.to_string())?;
    Ok(Compaction { summary, upto })
}

/// Esvazia uma Saga (apaga mensagens + limpa compactação), mantendo-a na lista.
#[tauri::command]
pub fn clear_conversation(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::clear_conversation(&conn, id).map_err(|e| e.to_string())
}

/// Compacta uma Saga: resume os turnos antigos com o modelo local (não-destrutivo) e
/// marca a fronteira; mantém os últimos `keep_last` turnos verbatim.
#[tauri::command]
pub async fn compact_conversation(
    state: State<'_, AppState>,
    id: i64,
    keep_last: i64,
) -> Result<CompactResult, String> {
    let settings = state.settings.lock().unwrap().clone();
    let (msgs, prev_summary) = {
        let conn = state.db.lock().unwrap();
        let msgs = store::get_messages(&conn, id).map_err(|e| e.to_string())?;
        let prev = store::get_compaction(&conn, id)
            .map(|(s, _)| s)
            .unwrap_or_default();
        (msgs, prev)
    };
    let total = msgs.len() as i64;
    let keep = keep_last.max(0);
    let cut = (total - keep).max(0) as usize;
    if cut < 2 {
        return Err("Conversa demasiado curta para compactar.".to_string());
    }
    let to_summarize = &msgs[..cut];
    let upto = to_summarize.last().map(|m| m.id).unwrap_or(0);
    let transcript = to_summarize
        .iter()
        .map(|m| {
            let who = if m.role == "user" { "Utilizador" } else { "Assistente" };
            format!("{who}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let full = if prev_summary.trim().is_empty() {
        transcript
    } else {
        format!("Resumo anterior:\n{prev_summary}\n\n{transcript}")
    };
    let summary = router::summarize_conversation(&full, &settings)
        .await
        .ok_or_else(|| "Não foi possível resumir — verifica o modelo local.".to_string())?;
    {
        let conn = state.db.lock().unwrap();
        store::set_compaction(&conn, id, &summary, upto).map_err(|e| e.to_string())?;
    }
    Ok(CompactResult {
        summary,
        upto,
        messages_compacted: cut,
    })
}

/// Escreve `content` no caminho dado (usado para exportar artefactos/Sagas; o caminho
/// vem do save-dialog no frontend).
#[tauri::command]
pub fn export_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Remove cercas de código ```…``` se o modelo as colocar à volta da resposta.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let after_lang = rest.splitn(2, '\n').nth(1).unwrap_or("");
        return after_lang.trim_end().trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// Gera um documento de workspace (skill | playbook | workflow) a partir de uma descrição,
/// usando o provider configurado (preferindo o cloud). Devolve o markdown.
#[tauri::command]
pub async fn generate_doc(
    state: State<'_, AppState>,
    kind: String,
    instruction: String,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let sys = match kind.as_str() {
        "skill" => "Escreve uma SKILL.md para a Saga. Formato EXATO:\n---\nname: <slug-sem-espacos>\ndescription: \"<uma frase sobre quando usar>. Triggers: <palavras/expressões que ativam>\"\n---\n\n# <título>\n<instruções claras, passo a passo, em markdown>\n\nResponde APENAS com o markdown final — sem cercas de código nem comentários.",
        "workflow" => "Escreve um workflow em markdown para a Saga. Formato EXATO:\n---\nname: <slug-sem-espacos>\ndescription: \"<o que faz>\"\nargument-hint: <que argumentos espera>\n---\n\n<procedimento passo-a-passo; usa $ARGUMENTS onde os argumentos do utilizador entram>\n\nResponde APENAS com o markdown final — sem cercas nem comentários.",
        "agent" => "Escreve um agente (persona) em markdown para a Saga. Formato EXATO:\n---\nname: <Nome legível>\ndescription: \"<uma frase sobre o que faz>\"\ntools: <true|false>\nresearch: <true|false>\nsubagents: <true|false>\nroute: <local|claude>\n---\n\n<system prompt na 2.ª pessoa (\"És um…\"): define o papel, o estilo e as regras de comportamento do agente>\n\nResponde APENAS com o markdown final — sem cercas de código nem comentários.",
        _ => "Escreve um playbook em markdown simples (sem frontmatter): um título e um procedimento reutilizável e claro. Responde APENAS com o markdown — sem cercas nem comentários.",
    };
    let messages = vec![
        ChatMessage { role: "system".into(), content: sys.into(), attachments: Vec::new() },
        ChatMessage { role: "user".into(), content: instruction, attachments: Vec::new() },
    ];
    let max = settings.claude_max_tokens.max(2048);
    // Tenta o cloud configurado; se falhar (ou não houver), cai para o modelo local.
    let cloud = if settings.cloud_provider == "openai" && !settings.openai_cloud_key.trim().is_empty() {
        Some(providers::openai_compat::chat(&settings.openai_cloud_endpoint, &settings.openai_cloud_key, &settings.openai_cloud_model, &messages, max).await)
    } else if settings.cloud_provider == "claude" && settings.claude_mode == "api" && !settings.claude_api_key.trim().is_empty() {
        Some(providers::claude_api::messages(&settings.claude_api_key, &settings.claude_model, max, &messages, false).await)
    } else if settings.cloud_provider == "claude" && settings.claude_mode == "cli" {
        Some(providers::claude_cli::run(&settings.claude_cli_path, &settings.claude_model, &messages, &[]).await)
    } else {
        None
    };
    let resp = match cloud {
        Some(Ok(r)) => Ok(r),
        _ if settings.local_provider == "openai" => {
            providers::openai_compat::chat(&settings.openai_local_endpoint, &settings.openai_local_key, &settings.openai_local_model, &messages, max).await
        }
        _ => {
            let g = providers::ollama::GenOpts {
                num_ctx: effective_num_ctx(settings.ollama_num_ctx, &messages),
                temperature: settings.ollama_temp_opt(),
                num_predict: None,
            };
            providers::ollama::chat(&settings.ollama_endpoint, &settings.ollama_model, &messages, g).await
        }
    };
    let text = resp.map_err(|e| e.to_string())?.text;
    Ok(strip_fences(&text))
}

/// Semeia os defaults do workspace (skill pdf + agentes) no idioma da UI. Idempotente:
/// não sobrescreve docs editados. Chamado pelo frontend no arranque.
#[tauri::command]
pub fn ensure_workspace_defaults(state: State<AppState>, lang: String) {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::seed_defaults(&dir, &lang);
}

/// Índice do workspace (skills, playbooks, workflows) para a UI e o disparo de workflows.
#[tauri::command]
pub fn get_workspace_index(state: State<AppState>) -> crate::workspace::WorkspaceIndex {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::index(&dir)
}

/// Conteúdo cru (com frontmatter) de um documento do workspace, para edição.
#[tauri::command]
pub fn read_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::read_doc(&dir, &kind, &name)
        .ok_or_else(|| "documento não encontrado".to_string())
}

/// Cria/atualiza um documento do workspace (skill | playbook | workflow).
#[tauri::command]
pub fn save_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::write_doc(&dir, &kind, &name, &content).map_err(|e| e.to_string())
}

/// Apaga um documento do workspace.
#[tauri::command]
pub fn delete_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
) -> Result<(), String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::delete_doc(&dir, &kind, &name).map_err(|e| e.to_string())
}

/// Log de ações (tool-calling) de uma conversa, para a vista "Atividade".
#[tauri::command]
pub fn get_action_log(
    state: State<AppState>,
    conversation_id: i64,
) -> Result<Vec<store::ActionLogEntry>, String> {
    let conn = state.db.lock().unwrap();
    store::get_action_log(&conn, conversation_id).map_err(|e| e.to_string())
}

// ---- Agendamentos (automações) ----

#[tauri::command]
pub fn list_schedules(state: State<AppState>) -> Result<Vec<store::Schedule>, String> {
    let conn = state.db.lock().unwrap();
    store::list_schedules(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_schedule(
    state: State<AppState>,
    name: String,
    workflow_name: String,
    arguments: String,
    cron: String,
    enabled: bool,
) -> Result<i64, String> {
    let next = if enabled {
        crate::scheduler::next_epoch(&cron).ok_or("expressão cron inválida")?
    } else {
        0
    };
    let conn = state.db.lock().unwrap();
    store::create_schedule(&conn, &name, &workflow_name, &arguments, &cron, enabled, next)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_schedule(
    state: State<AppState>,
    id: i64,
    name: String,
    workflow_name: String,
    arguments: String,
    cron: String,
    enabled: bool,
) -> Result<(), String> {
    let next = if enabled {
        crate::scheduler::next_epoch(&cron).ok_or("expressão cron inválida")?
    } else {
        0
    };
    let conn = state.db.lock().unwrap();
    store::update_schedule(&conn, id, &name, &workflow_name, &arguments, &cron, enabled, next)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_schedule(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::delete_schedule(&conn, id).map_err(|e| e.to_string())
}

/// Corre um agendamento imediatamente ("Correr agora").
#[tauri::command]
pub async fn run_schedule_now(app: tauri::AppHandle, id: i64) -> Result<String, String> {
    let sched = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        store::get_schedule(&conn, id).map_err(|e| e.to_string())?
    };
    let sched = sched.ok_or_else(|| "agendamento não encontrado".to_string())?;
    let (status, summary) = crate::scheduler::run_schedule(&app, &sched).await;
    Ok(format!("{status}: {summary}"))
}

/// Resposta a um pedido de aprovação de ação (modo "ask").
#[tauri::command]
pub async fn approve_action(
    state: State<'_, AppState>,
    id: u64,
    approved: bool,
) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().await.remove(&id) {
        let _ = tx.send(approved);
    }
    Ok(())
}

// ---- Arranque com o sistema (autostart) ----

/// Está a app configurada para arrancar com o sistema?
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Liga/desliga o arranque com o sistema.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enable {
        m.enable().map_err(|e| e.to_string())
    } else {
        m.disable().map_err(|e| e.to_string())
    }
}

// ---- Diagnóstico / logs ----

/// Regista no log um evento vindo do frontend (erros de JS, rejeições não tratadas).
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {message}"),
        "warn" => log::warn!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    }
}

/// Caminho da pasta de logs (para mostrar/partilhar nas Definições).
#[tauri::command]
pub fn log_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Abre a pasta de logs no explorador de ficheiros (via opener, do lado Rust).
#[tauri::command]
pub fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Extrai texto de um documento anexado (PDF/Word/Excel/texto) a partir dos bytes
/// em base64. Corre em blocking pois a extração (PDF/zip) é CPU-bound e síncrona.
#[tauri::command]
pub async fn extract_file_text(name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64 inválido: {e}"))?;
    tokio::task::spawn_blocking(move || crate::extract::extract(&name, &bytes))
        .await
        .map_err(|e| e.to_string())
}

/// Pré-carrega o modelo local em memória para a 1.ª resposta ser imediata (sem cold-start).
/// Fire-and-forget: só aplica ao Ollama e ignora erros (Ollama pode estar desligado).
#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>, model: Option<String>) -> Result<(), String> {
    let (endpoint, default_model, num_ctx, is_ollama) = {
        let s = state.settings.lock().unwrap();
        (
            s.ollama_endpoint.clone(),
            s.ollama_model.clone(),
            s.ollama_num_ctx,
            s.local_provider == "ollama",
        )
    };
    if !is_ollama {
        return Ok(());
    }
    let model = model.unwrap_or(default_model);
    if model.trim().is_empty() {
        return Ok(());
    }
    let _ = providers::ollama::warm(&endpoint, &model, num_ctx).await;
    Ok(())
}

/// Aplica as otimizações do servidor Ollama (flash attention + KV cache q8_0 + keep-alive)
/// definindo variáveis de ambiente do utilizador (setx — sem admin). NÃO mexe nos processos
/// do Ollama: o utilizador reinicia-o (matar/relançar o Ollama provou-se frágil — deixava-o
/// em baixo ou com servidores a competir pela porta → 100% CPU).
#[tauri::command]
pub async fn optimize_ollama() -> Result<(), String> {
    tokio::task::spawn_blocking(|| set_ollama_opt_blocking(true))
        .await
        .map_err(|e| e.to_string())?
}

/// Reverte as otimizações (remove as variáveis). O utilizador reinicia o Ollama.
#[tauri::command]
pub async fn revert_ollama_opt() -> Result<(), String> {
    tokio::task::spawn_blocking(|| set_ollama_opt_blocking(false))
        .await
        .map_err(|e| e.to_string())?
}

fn set_ollama_opt_blocking(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const VARS: [&str; 3] = ["OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_KEEP_ALIVE"];
        if enable {
            for (k, v) in [
                ("OLLAMA_FLASH_ATTENTION", "1"),
                ("OLLAMA_KV_CACHE_TYPE", "q8_0"),
                ("OLLAMA_KEEP_ALIVE", "30m"),
            ] {
                Command::new("setx")
                    .args([k, v])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("setx {k} falhou: {e}"))?;
            }
        } else {
            // Remove as variáveis do ambiente do utilizador (reg delete; ignora se não existirem).
            for k in VARS {
                let _ = Command::new("reg")
                    .args(["delete", "HKCU\\Environment", "/v", k, "/f"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("Só disponível no Windows. Usa os comandos copiados.".into())
    }
}

/// Constrói um anexo a partir de um caminho do sistema (drag & drop entrega caminhos,
/// não objetos File). Imagens → base64 para a visão; documentos → texto extraído.
#[tauri::command]
pub async fn attachment_from_path(path: String) -> Result<crate::providers::Attachment, String> {
    use base64::Engine;
    let p = std::path::PathBuf::from(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "ficheiro".into());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("não foi possível ler {name}: {e}"))?;

    let image_media = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    };
    if let Some(media) = image_media {
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(crate::providers::Attachment {
            kind: "image".into(),
            media_type: media.into(),
            data_base64,
            name: name.clone(),
            text: String::new(),
        });
    }
    // Media type para o visor (PDF abre na vista nativa do webview).
    let media_type = match ext.as_str() {
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string();
    // Guardamos os bytes crus (base64) para o visor; o texto extraído vai para o modelo.
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name2 = name.clone();
    let text = tokio::task::spawn_blocking(move || crate::extract::extract(&name2, &bytes))
        .await
        .map_err(|e| e.to_string())?;
    Ok(crate::providers::Attachment {
        kind: "document".into(),
        media_type,
        data_base64,
        name,
        text,
    })
}

#[tauri::command]
pub async fn list_ollama_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

/// Info da máquina + modelo local recomendado (por VRAM se houver GPU, senão por RAM).
#[derive(Serialize)]
pub struct SystemInfo {
    pub total_ram_gb: u64,
    /// VRAM da GPU (NVIDIA) em GB; 0 se não detetada.
    pub total_vram_gb: u64,
    pub cpu_cores: u32,
    pub recommended: String,
    pub note: String,
}

/// VRAM total da GPU NVIDIA via `nvidia-smi` (0 se ausente/erro). Cobre o caso comum (NVIDIA).
fn detect_vram_gb() -> u64 {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output();
    let Ok(out) = out else { return 0 };
    if !out.status.success() {
        return 0;
    }
    // Uma linha por GPU (MiB); usa a maior.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .map(|mib| (mib / 1024.0).round() as u64)
        .max()
        .unwrap_or(0)
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_ram_gb =
        (sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0).round().max(0.0) as u64;
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(0);
    let total_vram_gb = detect_vram_gb();

    // Com GPU, o gargalo é a VRAM: escolhe um modelo que CAIBA na VRAM (corre 100% na GPU =
    // rápido), deixando ~2 GB de folga para o cache KV. Sem GPU, decide pela RAM.
    let (recommended, why) = if total_vram_gb >= 22 {
        ("gemma4:26b-a4b-it-qat", "VRAM grande — Gemma 4 MoE (4B ativos): rápido, multimodal e capaz")
    } else if total_vram_gb >= 11 {
        ("gemma4:12b", "cabe na VRAM — Gemma 4 12B multimodal (imagens/ferramentas/raciocínio)")
    } else if total_vram_gb >= 8 {
        ("gemma4:e4b", "VRAM média — Gemma 4 e4b multimodal e leve")
    } else if total_vram_gb >= 5 {
        ("qwen3:8b", "VRAM pequena — 8B com ferramentas/raciocínio (texto)")
    } else if total_vram_gb > 0 {
        ("llama3.2:3b", "VRAM muito pequena — modelo leve para caber na GPU")
    } else if total_ram_gb == 0 {
        ("gemma4:12b", "multimodal equilibrado — imagens, ferramentas e raciocínio")
    } else if total_ram_gb < 10 {
        ("llama3.2:3b", "sem GPU, RAM limitada — modelo pequeno e rápido (CPU)")
    } else if total_ram_gb < 24 {
        ("qwen3:8b", "sem GPU — 8B em CPU é confortável (ferramentas/raciocínio)")
    } else {
        ("gemma4:12b", "sem GPU, muita RAM — Gemma 4 12B em CPU (mais lento, mas capaz)")
    };
    SystemInfo {
        total_ram_gb,
        total_vram_gb,
        cpu_cores,
        recommended: recommended.into(),
        note: why.into(),
    }
}

/// Uso de pesquisa web do mês corrente, por motor (contador local — o que a Saga gastou).
#[tauri::command]
pub fn get_search_usage(state: State<AppState>) -> Result<Vec<crate::store::SearchUsage>, String> {
    let ym = chrono::Local::now().format("%Y-%m").to_string();
    let conn = state.db.lock().unwrap();
    store::search_usage(&conn, &ym).map_err(|e| e.to_string())
}

/// Pesquisa o registo público do Ollama (ollama.com) — navegador de modelos ao vivo.
#[tauri::command]
pub async fn search_ollama_registry(
    query: String,
) -> Result<Vec<crate::ollama_registry::RegistryModel>, String> {
    crate::ollama_registry::search(&query, 25)
        .await
        .map_err(|e| e.to_string())
}

/// Todas as variantes (tags) de um modelo do ollama.com, com tamanho/contexto.
#[tauri::command]
pub async fn ollama_registry_tags(
    model: String,
) -> Result<Vec<crate::ollama_registry::RegistryTag>, String> {
    crate::ollama_registry::fetch_tags(&model)
        .await
        .map_err(|e| e.to_string())
}

/// Lista modelos locais com metadados (para o hub "Modelos").
#[tauri::command]
pub async fn list_ollama_models_detailed(
    state: State<'_, AppState>,
) -> Result<Vec<providers::ollama::OllamaModel>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models_detailed(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

/// Apaga um modelo local.
#[tauri::command]
pub async fn delete_ollama_model(state: State<'_, AppState>, model: String) -> Result<(), String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::delete_model(&endpoint, &model)
        .await
        .map_err(|e| e.to_string())
}

/// Testa um servidor MCP (handshake + tools/list) e devolve os nomes das tools.
#[tauri::command]
pub async fn test_mcp_server(
    config: crate::mcp::McpServerConfig,
) -> Result<Vec<String>, String> {
    crate::mcp::test_server(&config)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum PullEvent {
    Progress { status: String, percent: f64 },
    Done,
    Error { message: String },
}

#[tauri::command]
pub async fn pull_ollama_model(
    state: State<'_, AppState>,
    model: String,
    channel: Channel<PullEvent>,
) -> Result<(), String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    let tx = channel.clone();
    let result = providers::ollama::pull_model(&endpoint, &model, move |status, percent| {
        let _ = tx.send(PullEvent::Progress {
            status: status.to_string(),
            percent,
        });
    })
    .await;
    match result {
        Ok(_) => {
            let _ = channel.send(PullEvent::Done);
            Ok(())
        }
        Err(e) => {
            let _ = channel.send(PullEvent::Error {
                message: e.to_string(),
            });
            Ok(())
        }
    }
}

// ---- LM Studio (modelos já descarregados, via REST local) ----
// Os downloads fazem-se na app do LM Studio; aqui só listamos para usar como provider de chat.
#[tauri::command]
pub async fn lmstudio_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::lmstudio::LmModel>, String> {
    let (endpoint, key) = {
        let s = state.settings.lock().unwrap();
        (s.openai_local_endpoint.clone(), s.openai_local_key.clone())
    };
    crate::lmstudio::list_downloaded(&endpoint, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    messages: Vec<ChatMessage>,
) -> Result<ChatResponse, String> {
    // Clona as definições e larga o lock antes de qualquer await.
    let settings = state.settings.lock().unwrap().clone();

    let outcome = router::handle(&messages, &settings)
        .await
        .map_err(|e| e.to_string())?;

    let cost = router::outcome_cost(&outcome);

    // Atualiza a contabilidade.
    let snapshot = {
        let mut acc = state.accounting.lock().unwrap();
        match outcome.route {
            router::Route::Local => {
                let est = outcome.response.input_tokens + outcome.response.output_tokens;
                let est = if est == 0 {
                    estimate_tokens(&outcome.response.text)
                } else {
                    est
                };
                acc.record_local(est);
            }
            router::Route::Claude => {
                acc.record_claude(
                    &outcome.model,
                    outcome.response.input_tokens,
                    outcome.response.output_tokens,
                    outcome.response.reported_cost_usd,
                    outcome.tokens_saved_compression,
                );
            }
        }
        acc.clone()
    };

    Ok(ChatResponse {
        text: outcome.response.text,
        route: outcome.route.as_str().to_string(),
        model: outcome.model,
        input_tokens: outcome.response.input_tokens,
        output_tokens: outcome.response.output_tokens,
        tokens_saved: outcome.tokens_saved_compression,
        cost_usd: cost,
        reason: outcome.reason,
        accounting: snapshot,
    })
}

/// Interpreta "/nome args" no início de uma mensagem. Devolve (nome, args).
fn parse_slash_command(content: &str) -> Option<(String, String)> {
    let rest = content.trim().strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.splitn(2, char::is_whitespace);
    let name = parts.next()?.to_string();
    let args = parts.next().unwrap_or("").trim().to_string();
    Some((name, args))
}

#[tauri::command]
pub async fn send_message_stream(
    state: State<'_, AppState>,
    conversation_id: i64,
    messages: Vec<ChatMessage>,
    channel: Channel<StreamEvent>,
    route_override: Option<String>,
    model_override: Option<String>,
    regenerate: bool,
    thinking: bool,
    research: bool,
    subagents: bool,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();

    if regenerate {
        // Regenerar: a mensagem do utilizador já existe; apaga a resposta anterior.
        let conn = state.db.lock().unwrap();
        let _ = store::delete_last_assistant(&conn, conversation_id);
    } else if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        // Persistir a mensagem do utilizador (a última do histórico) + auto-título.
        let attachments_json =
            serde_json::to_string(&last_user.attachments).unwrap_or_else(|_| "[]".into());
        let conn = state.db.lock().unwrap();
        let _ = store::append_message(
            &conn,
            conversation_id,
            "user",
            &last_user.content,
            &attachments_json,
            "",
            "",
            0,
            0,
            0.0,
            0,
        );
        let _ = store::maybe_autotitle(&conn, conversation_id, &last_user.content);
    }

    // Disparo de workflow: "/nome args" → carrega o procedimento e força a rota agêntica.
    let mut workflow_name: Option<String> = None;
    let mut workflow_system: Option<String> = None;
    if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        if let Some((name, args)) = parse_slash_command(&last_user.content) {
            if let Some(body) = crate::workspace::read_workflow(&settings.workspace_dir, &name) {
                let proc = body.replace("$ARGUMENTS", &args);
                workflow_system = Some(format!(
                    "Estás a executar o workflow '{name}'. Segue este procedimento usando as \
                     ferramentas disponíveis, regista o progresso e termina com um resumo curto.\n\n{proc}"
                ));
                workflow_name = Some(name);
            }
        }
    }
    let forced_workflow = workflow_system.is_some();
    let route_override_eff = if forced_workflow {
        Some("claude".to_string())
    } else {
        route_override.clone()
    };

    let mut prepared = router::prepare(
        &messages,
        &settings,
        route_override_eff.as_deref(),
        model_override.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    if let Some(sys) = workflow_system {
        prepared.full_messages.insert(
            0,
            ChatMessage {
                role: "system".into(),
                content: sys,
                attachments: Vec::new(),
            },
        );
    }

    let local_openai = settings.local_provider == "openai";
    let cloud_openai = settings.cloud_provider == "openai";
    // Modelo realmente usado (do slot ativo), para badge/contabilidade.
    let effective_model = match prepared.route {
        router::Route::Local if local_openai => settings.openai_local_model.clone(),
        router::Route::Claude if cloud_openai => settings.openai_cloud_model.clone(),
        _ => prepared.model.clone(),
    };

    // Breadcrumb: contexto do turno (útil para ver a última ação antes de um crash).
    log::info!(
        "turn conv={conversation_id} route={} model={effective_model} research={research} subagents={subagents} think={thinking} msgs={} images={} web_search={}",
        prepared.route.as_str(),
        prepared.full_messages.len(),
        prepared.has_images,
        settings.local_web_search || research
    );

    let _ = channel.send(StreamEvent::Start {
        route: prepared.route.as_str().to_string(),
        model: effective_model.clone(),
        reason: prepared.reason.clone(),
    });

    // Closure que reenvia cada fragmento para o frontend.
    let tx = channel.clone();
    let on_delta = move |d: &str| {
        let _ = tx.send(StreamEvent::Delta {
            text: d.to_string(),
        });
    };

    let gen_start = std::time::Instant::now();
    let response = match prepared.route {
        router::Route::Local if local_openai => {
            providers::openai_compat::chat_stream(
                &settings.openai_local_endpoint,
                &settings.openai_local_key,
                &settings.openai_local_model,
                &prepared.full_messages,
                settings.claude_max_tokens,
                on_delta,
            )
            .await
        }
        router::Route::Local => {
            // Janela adaptativa: garante espaço para a resposta mesmo com prompts grandes
            // (ex.: documentos anexados). Senão a resposta corta-se a meio.
            let num_ctx = effective_num_ctx(settings.ollama_num_ctx, &prepared.full_messages);
            log::info!(
                "local num_ctx base={} efetivo={num_ctx}",
                settings.ollama_num_ctx
            );
            let gopts = providers::ollama::GenOpts {
                num_ctx,
                temperature: settings.ollama_temp_opt(),
                num_predict: None,
            };
            // 🔎 explícito (research) → pipeline FUNDAMENTADA (decompõe → pesquisa cada sub-pergunta
            // → verifica → sintetiza). Pesquisa web passiva (sempre-ligada, sem 🔎) → loop leve.
            // Sem pesquisa nenhuma, segue para o caminho de chat/visão direto (chat_stream) abaixo.
            if settings.local_web_search || research {
                let tx_t = channel.clone();
                // Conta as pesquisas web feitas neste pedido (para o medidor de uso mensal).
                let searches = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
                let sc = searches.clone();
                let on_tool = move |tool: &str, detail: &str| {
                    if tool == "web_search" {
                        sc.fetch_add(1, Ordering::Relaxed);
                    }
                    let _ = tx_t.send(StreamEvent::ToolStep {
                        tool: tool.to_string(),
                        detail: detail.to_string(),
                    });
                };
                let r = if research {
                    crate::deep_research::run(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &settings.web_search_provider,
                        &settings.active_web_key(),
                        &prepared.full_messages,
                        gopts,
                        settings.research_max_rounds,
                        on_delta,
                        on_tool,
                    )
                    .await
                } else {
                    crate::web_agent::run(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &settings.web_search_provider,
                        &settings.active_web_key(),
                        &prepared.full_messages,
                        gopts,
                        on_delta,
                        on_tool,
                    )
                    .await
                };
                // Atribui ao motor que REALMENTE correu (sem chave, um motor com chave cai p/ DDG).
                let n = searches.load(Ordering::Relaxed);
                if n > 0 {
                    let eff = if settings.web_search_provider != "duckduckgo"
                        && settings.active_web_key().trim().is_empty()
                    {
                        "duckduckgo"
                    } else {
                        settings.web_search_provider.as_str()
                    };
                    let ym = chrono::Local::now().format("%Y-%m").to_string();
                    let conn = state.db.lock().unwrap();
                    let _ = store::add_search_usage(&conn, &ym, eff, n);
                }
                r
            } else {
                // Modelos com raciocínio (gemma4, qwen3, deepseek-r1…) emitem "thinking"
                // separado — pede-o e reenvia-o como feedback ao utilizador.
                let think = providers::ollama::model_reasons(&prepared.model);
                let tx_think = channel.clone();
                providers::ollama::chat_stream(
                    &settings.ollama_endpoint,
                    &prepared.model,
                    &prepared.full_messages,
                    gopts,
                    think,
                    on_delta,
                    move |t| {
                        let _ = tx_think.send(StreamEvent::Thinking { text: t.to_string() });
                    },
                )
                .await
            }
        }
        router::Route::Claude if cloud_openai => {
            providers::openai_compat::chat_stream(
                &settings.openai_cloud_endpoint,
                &settings.openai_cloud_key,
                &settings.openai_cloud_model,
                &prepared.full_messages,
                settings.claude_max_tokens,
                on_delta,
            )
            .await
        }
        router::Route::Claude => {
            // CLI e API leem imagens (a CLI via ficheiros temporários + tool Read).
            let use_api = settings.claude_mode == "api";
            let any_mcp = settings
                .mcp_servers
                .iter()
                .any(|s| s.enabled && !s.name.trim().is_empty());
            let ws_index = crate::workspace::index(&settings.workspace_dir);
            let has_ws = !ws_index.skills.is_empty() || !ws_index.playbooks.is_empty();
            let want_tools = use_api
                && !prepared.has_images
                && (settings.enable_browser_tools || any_mcp || has_ws || forced_workflow);
            if want_tools {
                // Loop agêntico com ferramentas (browser e/ou servidores MCP) — só API.
                let tx_d = channel.clone();
                let tx_t = channel.clone();

                // Lança o browser se ativado.
                let mut browser_guard = state.browser.lock().await;
                if settings.enable_browser_tools && browser_guard.is_none() {
                    match PlaywrightSidecar::spawn(
                        &settings.browser_node_path,
                        &settings.browser_sidecar_script,
                        &settings.browser_user_data_dir,
                    )
                    .await
                    {
                        Ok(s) => *browser_guard = Some(s),
                        Err(e) => return Err(e.to_string()),
                    }
                }
                // Garante os servidores MCP ativos.
                let mut mcp_guard = state.mcp.lock().await;
                if any_mcp {
                    mcp_guard.ensure_ready(&settings.mcp_servers).await;
                }

                // Workflows fazem ações: se a confirmação estiver desligada, pede aprovação na mesma.
                let mode = if forced_workflow && settings.confirm_mode == "off" {
                    ConfirmMode::Ask
                } else {
                    ConfirmMode::parse(&settings.confirm_mode)
                };
                if let Some(name) = &workflow_name {
                    let _ = channel.send(StreamEvent::ToolStep {
                        tool: "workflow".into(),
                        detail: name.clone(),
                    });
                }
                let approver = ChannelApprover {
                    channel: channel.clone(),
                    state: state.inner(),
                };
                let mut dispatcher = Dispatcher {
                    browser: if settings.enable_browser_tools {
                        browser_guard.as_mut()
                    } else {
                        None
                    },
                    mcp: if any_mcp { Some(&mut *mcp_guard) } else { None },
                    workspace: if has_ws {
                        Some(crate::tools::dispatch::WorkspaceTools {
                            dir: &settings.workspace_dir,
                            index: &ws_index,
                        })
                    } else {
                        None
                    },
                    gate: ActionGate {
                        db: Some(&state.db),
                        conversation_id,
                        mode,
                        approver: if mode == ConfirmMode::Ask {
                            Some(&approver)
                        } else {
                            None
                        },
                    },
                };
                agent::run(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    &mut dispatcher,
                    move |d| {
                        let _ = tx_d.send(StreamEvent::Delta { text: d.to_string() });
                    },
                    move |tool, detail| {
                        let _ = tx_t.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else if use_api && subagents {
                // Orquestração de subagentes (planeador → paralelo → síntese).
                let tx_tool = channel.clone();
                crate::orchestrator::orchestrate(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    research,
                    settings.research_max_rounds,
                    on_delta,
                    move |tool, detail| {
                        let _ = tx_tool.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else if use_api {
                let thinking_budget = if thinking {
                    Some(settings.thinking_budget)
                } else {
                    None
                };
                let tx_think = channel.clone();
                let tx_tool = channel.clone();
                providers::claude_api::messages_stream(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    thinking_budget,
                    research,
                    on_delta,
                    move |th| {
                        let _ = tx_think.send(StreamEvent::Thinking {
                            text: th.to_string(),
                        });
                    },
                    move |tool, detail| {
                        let _ = tx_tool.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else {
                // CLI não suporta streaming fino — resposta completa, emitida como um delta.
                let mut cli_tools: Vec<&str> = Vec::new();
                if research {
                    cli_tools.push("WebSearch");
                    cli_tools.push("WebFetch");
                }
                if subagents {
                    cli_tools.push("Task");
                }
                let r = providers::claude_cli::run(
                    &settings.claude_cli_path,
                    &prepared.model,
                    &prepared.full_messages,
                    &cli_tools,
                )
                .await;
                if let Ok(ref resp) = r {
                    let _ = channel.send(StreamEvent::Delta {
                        text: resp.text.clone(),
                    });
                }
                r
            }
        }
    }
    .map_err(|e| e.to_string())?;
    let gen_ms = gen_start.elapsed().as_millis() as i64;

    // Pesquisa numa só passagem (sem subagentes): acrescenta as fontes capturadas.
    let mut response = response;
    if research && !subagents && !response.sources.is_empty() {
        let mut fontes = String::from("\n\n## Fontes\n");
        for (i, s) in response.sources.iter().enumerate() {
            let label = if s.title.trim().is_empty() { &s.url } else { &s.title };
            fontes.push_str(&format!("{}. [{}]({})\n", i + 1, label, s.url));
        }
        let _ = channel.send(StreamEvent::Delta {
            text: fontes.clone(),
        });
        response.text.push_str(&fontes);
    }

    let snapshot = {
        let mut acc = state.accounting.lock().unwrap();
        match prepared.route {
            router::Route::Local => {
                let est = response.input_tokens + response.output_tokens;
                let est = if est == 0 {
                    estimate_tokens(&response.text)
                } else {
                    est
                };
                acc.record_local(est);
            }
            router::Route::Claude => {
                acc.record_claude(
                    &effective_model,
                    response.input_tokens,
                    response.output_tokens,
                    response.reported_cost_usd,
                    prepared.tokens_saved,
                );
            }
        }
        acc.clone()
    };

    let cost = if prepared.route == router::Route::Claude {
        if response.reported_cost_usd > 0.0 {
            response.reported_cost_usd
        } else {
            crate::accounting::cost_usd(
                &effective_model,
                response.input_tokens,
                response.output_tokens,
            )
        }
    } else {
        0.0
    };

    // Persistir a resposta do assistente (+ tempo de geração).
    {
        let conn = state.db.lock().unwrap();
        if let Ok(mid) = store::append_message(
            &conn,
            conversation_id,
            "assistant",
            &response.text,
            "[]",
            prepared.route.as_str(),
            &effective_model,
            response.input_tokens as i64,
            response.output_tokens as i64,
            cost,
            prepared.tokens_saved as i64,
        ) {
            let _ = store::set_message_gen_ms(&conn, mid, gen_ms);
        }
    }

    let _ = channel.send(StreamEvent::Done {
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        tokens_saved: prepared.tokens_saved,
        cost_usd: cost,
        gen_ms,
        accounting: snapshot,
    });

    Ok(())
}
