mod accounting;
mod agent;
mod commands;
mod lmstudio;
mod mcp;
mod memory;
mod ollama_registry;
mod orchestrator;
mod providers;
mod router;
mod scheduler;
mod settings;
mod store;
mod tools;
mod web_agent;
mod workspace;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .setup(|app| {
            scheduler::spawn_loop(app.handle().clone());
            // Semeia skills embutidas por defeito (ex.: pdf) se o workspace estiver definido.
            {
                let state = app.state::<AppState>();
                let dir = state.settings.lock().unwrap().workspace_dir.clone();
                workspace::seed_defaults(&dir);
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
            commands::search_ollama_registry,
            commands::lmstudio_list,
            commands::lmstudio_search,
            commands::lmstudio_download,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
