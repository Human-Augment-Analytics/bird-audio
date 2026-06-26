mod commands;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::cancel_session,
            commands::get_summary,
            commands::list_files,
            commands::export_session,
            commands::check_health,
            commands::prepare_system,
            commands::check_cache,
            commands::clear_cache,
            commands::get_cached_files,
            commands::delete_cached_files,
            commands::concurrency_suggestion,
            commands::get_feature_flags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
