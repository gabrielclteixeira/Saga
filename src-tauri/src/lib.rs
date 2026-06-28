mod accounting;
mod agent;
mod clarify;
mod commands;
mod deep_research;
mod extract;
mod lmstudio;
mod mcp;
mod memory;
mod ollama_registry;
mod orchestrator;
mod planner;
mod providers;
mod router;
mod scheduler;
mod settings;
mod store;
mod tools;
mod web_agent;
mod workspace;

use commands::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Traz a janela principal para a frente (cria/mostra/foca).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Há automações agendadas ativas? (Se sim, fechar a janela esconde-a para o tray.)
fn has_enabled_schedules(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    store::list_schedules(&conn)
        .map(|v| v.iter().any(|s| s.enabled))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Captura panics do Rust (main + tasks do tokio) no log — senão morrem em silêncio.
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        log::error!("PANIC em {loc}: {info}");
        prev_hook(info);
    }));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // Corta o ruído de DEBUG do updater (afogava o log).
                .level_for("tauri_plugin_updater", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::new())
        .setup(|app| {
            log::info!(
                "Saga {} · {} {} a arrancar",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            scheduler::spawn_loop(app.handle().clone());
            // Os defaults do workspace (skill pdf + agentes) são semeados pelo frontend, no
            // arranque, com o idioma da UI (comando `ensure_workspace_defaults`).

            // Ícone na bandeja do sistema: clique mostra a janela; menu Mostrar/Sair.
            let show_i = MenuItem::with_id(app, "show", "Mostrar Saga", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Saga")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Fechar a janela esconde-a para o tray se houver automações agendadas ativas
            // (para continuarem a correr); caso contrário, deixa a app sair normalmente.
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        log::warn!("janela: CloseRequested");
                        if has_enabled_schedules(&handle) {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_accounting,
            commands::reset_accounting,
            commands::get_memory_preview,
            commands::diagnostics,
            commands::list_ollama_models,
            commands::system_info,
            commands::get_search_usage,
            commands::search_ollama_registry,
            commands::ollama_registry_tags,
            commands::lmstudio_list,
            commands::list_ollama_models_detailed,
            commands::delete_ollama_model,
            commands::test_mcp_server,
            commands::pull_ollama_model,
            commands::send_message,
            commands::send_message_stream,
            commands::list_conversations,
            commands::get_conversation,
            commands::new_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::search_chats,
            commands::get_conversation_accounting,
            commands::truncate_conversation,
            commands::get_compaction,
            commands::clear_conversation,
            commands::compact_conversation,
            commands::get_action_log,
            commands::approve_action,
            commands::respond_plan,
            commands::respond_clarify,
            commands::detect_embed_model,
            commands::ensure_workspace_defaults,
            commands::get_workspace_index,
            commands::read_workspace_doc,
            commands::save_workspace_doc,
            commands::delete_workspace_doc,
            commands::generate_doc,
            commands::export_file,
            commands::list_schedules,
            commands::create_schedule,
            commands::update_schedule,
            commands::delete_schedule,
            commands::run_schedule_now,
            commands::get_autostart,
            commands::set_autostart,
            commands::log_frontend,
            commands::log_dir,
            commands::open_logs,
            commands::extract_file_text,
            commands::attachment_from_path,
            commands::warm_model,
            commands::optimize_ollama,
            commands::revert_ollama_opt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
