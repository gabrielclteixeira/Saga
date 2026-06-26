//! Comandos Tauri expostos ao frontend.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::accounting::Accounting;
use crate::providers::{estimate_tokens, ChatMessage};
use crate::router;
use crate::settings::Settings;
use crate::store::{self, ConversationMeta, SearchHit, StoredMessage};
use crate::tools::browser::PlaywrightSidecar;
use crate::{agent, memory, providers};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub accounting: Mutex<Accounting>,
    pub db: Mutex<Connection>,
    /// Sidecar do browser, criado preguiçosamente na 1.ª utilização de ferramentas.
    pub browser: tokio::sync::Mutex<Option<PlaywrightSidecar>>,
}

impl AppState {
    pub fn new() -> Self {
        let db = store::open().expect("falha a abrir a base de dados SQLite");
        Self {
            settings: Mutex::new(Settings::load()),
            accounting: Mutex::new(Accounting::default()),
            db: Mutex::new(db),
            browser: tokio::sync::Mutex::new(None),
        }
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
    Done {
        input_tokens: u64,
        output_tokens: u64,
        tokens_saved: u64,
        cost_usd: f64,
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

#[tauri::command]
pub async fn list_ollama_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models(&endpoint)
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

    let prepared = router::prepare(
        &messages,
        &settings,
        route_override.as_deref(),
        model_override.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let _ = channel.send(StreamEvent::Start {
        route: prepared.route.as_str().to_string(),
        model: prepared.model.clone(),
        reason: prepared.reason.clone(),
    });

    // Closure que reenvia cada fragmento para o frontend.
    let tx = channel.clone();
    let on_delta = move |d: &str| {
        let _ = tx.send(StreamEvent::Delta {
            text: d.to_string(),
        });
    };

    let response = match prepared.route {
        router::Route::Local => {
            providers::ollama::chat_stream(
                &settings.ollama_endpoint,
                &prepared.model,
                &prepared.full_messages,
                on_delta,
            )
            .await
        }
        router::Route::Claude => {
            // Imagens exigem API (a CLI não as suporta).
            let use_api = prepared.has_images || settings.claude_mode == "api";
            if use_api && settings.enable_browser_tools && !prepared.has_images {
                // Loop agêntico com ferramentas de browser (só API).
                let tx_d = channel.clone();
                let tx_t = channel.clone();
                let mut guard = state.browser.lock().await;
                if guard.is_none() {
                    match PlaywrightSidecar::spawn(
                        &settings.browser_node_path,
                        &settings.browser_sidecar_script,
                        &settings.browser_user_data_dir,
                    )
                    .await
                    {
                        Ok(s) => *guard = Some(s),
                        Err(e) => return Err(e.to_string()),
                    }
                }
                let browser = guard.as_mut().unwrap();
                agent::run(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    browser,
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
                    &prepared.model,
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
                &prepared.model,
                response.input_tokens,
                response.output_tokens,
            )
        }
    } else {
        0.0
    };

    // Persistir a resposta do assistente.
    {
        let conn = state.db.lock().unwrap();
        let _ = store::append_message(
            &conn,
            conversation_id,
            "assistant",
            &response.text,
            "[]",
            prepared.route.as_str(),
            &prepared.model,
            response.input_tokens as i64,
            response.output_tokens as i64,
            cost,
            prepared.tokens_saved as i64,
        );
    }

    let _ = channel.send(StreamEvent::Done {
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        tokens_saved: prepared.tokens_saved,
        cost_usd: cost,
        accounting: snapshot,
    });

    Ok(())
}
