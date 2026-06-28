//! Automações agendadas: corre workflows em horários (cron) numa tarefa de fundo,
//! sem UI. As ações são auto-executadas (opt-in por agendamento), registadas no
//! action_log, e o resultado é gravado numa Saga "Automações" + notificação de desktop.

use std::str::FromStr;
use std::time::Duration;

use chrono::Utc;
use cron::Schedule as CronSchedule;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::AppState;
use crate::providers::ChatMessage;
use crate::store::{self, Schedule};
use crate::tools::browser::PlaywrightSidecar;
use crate::tools::dispatch::{ActionGate, ConfirmMode, Dispatcher, WorkspaceTools};
use crate::{agent, workspace};

/// Próxima ocorrência (epoch UTC) de uma expressão cron (6/7 campos: seg min hora dia mês dia-semana [ano]).
pub fn next_epoch(cron: &str) -> Option<i64> {
    let sched = CronSchedule::from_str(cron).ok()?;
    sched.upcoming(Utc).next().map(|dt| dt.timestamp())
}

/// Lança o ciclo de fundo (chamado no `.setup()` do Tauri).
pub fn spawn_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            run_due(&app).await;
        }
    });
}

async fn run_due(app: &AppHandle) {
    let now = Utc::now().timestamp();
    let due = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        store::due_schedules(&conn, now).unwrap_or_default()
    };
    for sched in due {
        let (status, summary) = run_schedule(app, &sched).await;
        let next = next_epoch(&sched.cron).unwrap_or(0);
        {
            let state = app.state::<AppState>();
            let conn = state.db.lock().unwrap();
            let _ = store::set_schedule_run(&conn, sched.id, &Utc::now().to_rfc3339(), next);
        }
        notify(app, &sched.name, &status, &summary);
    }
}

/// Corre um agendamento já (usado pelo ciclo e pelo "Correr agora").
/// Devolve (estado, resumo) para a notificação e regista o resultado no agendamento (visível na
/// vista de Automações), incluindo falhas de pré-voo.
pub async fn run_schedule(app: &AppHandle, sched: &Schedule) -> (String, String) {
    let (status, summary) = run_schedule_inner(app, sched).await;
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        let _ = store::set_schedule_result(&conn, sched.id, &status, &summary);
    }
    (status, summary)
}

async fn run_schedule_inner(app: &AppHandle, sched: &Schedule) -> (String, String) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();

    // Workflow desativado → não corre a automação.
    if !workspace::is_enabled(&settings.workspace_dir, "workflow", &sched.workflow_name) {
        log::warn!(
            "agendamento '{}': workflow '{}' está desativado — saltado",
            sched.name,
            sched.workflow_name
        );
        return (
            "SALTADO".into(),
            format!("workflow '{}' está desativado", sched.workflow_name),
        );
    }
    let body = match workspace::read_workflow(&settings.workspace_dir, &sched.workflow_name) {
        Some(b) => b.replace("$ARGUMENTS", &sched.arguments),
        None => {
            return (
                "ERRO".into(),
                format!("workflow '{}' não encontrado", sched.workflow_name),
            )
        }
    };
    // Rota do workflow: `claude` (browser/MCP/agêntico) exige Claude API; `local` (default) corre no
    // modelo local sem Claude.
    let route = workspace::doc_route(&settings.workspace_dir, "workflow", &sched.workflow_name);
    if route == "claude" && (settings.claude_mode != "api" || settings.claude_api_key.trim().is_empty()) {
        return ("ERRO".into(), "requer Claude API configurado".into());
    }

    // Saga "Automações" + regista o disparo.
    let conv_id = {
        let conn = state.db.lock().unwrap();
        let id = store::find_or_create_conversation(&conn, "Automações").unwrap_or(0);
        let _ = store::append_message(
            &conn,
            id,
            "user",
            &format!("▶ {} {}", sched.name, sched.arguments),
            "[]",
            "",
            "",
            0,
            0,
            0.0,
            0,
        );
        id
    };

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: format!(
                "Estás a executar o workflow '{}' como automação agendada. Segue o procedimento \
usando as ferramentas disponíveis e termina com um resumo curto.\n\n{body}",
                sched.workflow_name
            ),
            attachments: Vec::new(),
        },
        ChatMessage {
            role: "user".into(),
            content: "Executa agora.".into(),
            attachments: Vec::new(),
        },
    ];

    let mut buf = String::new();
    let result = if route == "claude" {
        // Rota Claude: loop agêntico completo (browser + MCP + workspace tools).
        let any_mcp = settings
            .mcp_servers
            .iter()
            .any(|s| s.enabled && !s.name.trim().is_empty());
        let ws_index = workspace::index(&settings.workspace_dir).active();
        let mut browser_guard = state.browser.lock().await;
        if settings.enable_browser_tools && browser_guard.is_none() {
            if let Ok(s) = PlaywrightSidecar::spawn(
                &settings.browser_node_path,
                &settings.browser_sidecar_script,
                &settings.browser_user_data_dir,
            )
            .await
            {
                *browser_guard = Some(s);
            }
        }
        let mut mcp_guard = state.mcp.lock().await;
        if any_mcp {
            mcp_guard.ensure_ready(&settings.mcp_servers).await;
        }
        let mut dispatcher = Dispatcher {
            browser: if settings.enable_browser_tools {
                browser_guard.as_mut()
            } else {
                None
            },
            mcp: if any_mcp { Some(&mut *mcp_guard) } else { None },
            workspace: Some(WorkspaceTools {
                dir: &settings.workspace_dir,
                index: &ws_index,
            }),
            gate: ActionGate {
                db: Some(&state.db),
                conversation_id: conv_id,
                mode: ConfirmMode::Off, // auto-executa (opt-in por agendamento)
                approver: None,
            },
        };
        agent::run(
            &settings.claude_api_key,
            &settings.claude_model,
            settings.claude_max_tokens,
            &messages,
            &mut dispatcher,
            |d| buf.push_str(d),
            |_t, _d| {},
        )
        .await
    } else {
        // Rota local: modelo local (com web/skills se o 🔎 estiver ligado). Sem browser/MCP/ações com gate.
        let gopts = crate::providers::ollama::GenOpts {
            num_ctx: settings.ollama_num_ctx,
            temperature: settings.ollama_temp_opt(),
            num_predict: None,
        };
        if settings.local_provider == "openai" {
            crate::providers::openai_compat::chat(
                &settings.openai_local_endpoint,
                &settings.openai_local_key,
                &settings.openai_local_model,
                &messages,
                settings.claude_max_tokens.max(1024),
            )
            .await
        } else if settings.local_web_search {
            crate::web_agent::run(
                &settings.ollama_endpoint,
                &settings.ollama_model,
                &settings.web_search_provider,
                &settings.active_web_key(),
                &messages,
                &settings.workspace_dir,
                &[],
                gopts,
                |d| buf.push_str(d),
                |_t, _d| {},
            )
            .await
        } else {
            crate::providers::ollama::chat(
                &settings.ollama_endpoint,
                &settings.ollama_model,
                &messages,
                gopts,
            )
            .await
        }
    };

    let (status, text) = match result {
        Ok(resp) => (
            "OK".to_string(),
            if !buf.trim().is_empty() {
                buf
            } else if !resp.text.trim().is_empty() {
                resp.text
            } else {
                "(sem texto)".into()
            },
        ),
        Err(e) => ("ERRO".to_string(), format!("erro: {e}")),
    };
    {
        let conn = state.db.lock().unwrap();
        let _ = store::append_message(
            &conn,
            conv_id,
            "assistant",
            &text,
            "[]",
            "claude",
            &settings.claude_model,
            0,
            0,
            0.0,
            0,
        );
    }
    let summary: String = text.chars().take(140).collect();
    (status, summary)
}

fn notify(app: &AppHandle, name: &str, status: &str, summary: &str) {
    let _ = app
        .notification()
        .builder()
        .title(format!("Saga — automação ({status})"))
        .body(format!("{name}: {summary}"))
        .show();
}
