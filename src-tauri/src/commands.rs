//! Comandos Tauri expostos ao frontend.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::accounting::Accounting;
use crate::providers::{estimate_tokens, ChatMessage};
use crate::router;
use crate::settings::Settings;
use crate::{memory, providers};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub accounting: Mutex<Accounting>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::load()),
            accounting: Mutex::new(Accounting::default()),
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

#[tauri::command]
pub async fn list_ollama_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models(&endpoint)
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

#[tauri::command]
pub async fn send_message_stream(
    state: State<'_, AppState>,
    messages: Vec<ChatMessage>,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();

    let prepared = router::prepare(&messages, &settings)
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
                &settings.ollama_model,
                &prepared.full_messages,
                on_delta,
            )
            .await
        }
        router::Route::Claude => match settings.claude_mode.as_str() {
            "api" => {
                providers::claude_api::messages_stream(
                    &settings.claude_api_key,
                    &settings.claude_model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    on_delta,
                )
                .await
            }
            _ => {
                // CLI não suporta streaming fino — resposta completa, emitida como um delta.
                let r = providers::claude_cli::run(
                    &settings.claude_cli_path,
                    &settings.claude_model,
                    &prepared.full_messages,
                )
                .await;
                if let Ok(ref resp) = r {
                    let _ = channel.send(StreamEvent::Delta {
                        text: resp.text.clone(),
                    });
                }
                r
            }
        },
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

    let _ = channel.send(StreamEvent::Done {
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        tokens_saved: prepared.tokens_saved,
        cost_usd: cost,
        accounting: snapshot,
    });

    Ok(())
}
