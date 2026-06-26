mod accounting;
mod agent;
mod commands;
mod memory;
mod providers;
mod router;
mod settings;
mod store;
mod tools;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_accounting,
            commands::reset_accounting,
            commands::get_memory_preview,
            commands::diagnostics,
            commands::list_ollama_models,
            commands::send_message,
            commands::send_message_stream,
            commands::list_conversations,
            commands::get_conversation,
            commands::new_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::search_chats,
            commands::get_conversation_accounting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
