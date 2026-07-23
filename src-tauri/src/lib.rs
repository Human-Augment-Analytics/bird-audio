mod commands;
mod state;
mod active_learning_commands;

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
            commands::count_audio_files,
            commands::check_cache,
            commands::clear_cache,
            commands::get_cached_files,
            commands::delete_cached_files,
            commands::concurrency_suggestion,
            commands::get_feature_flags,
            commands::get_session_events,
            commands::list_events,
            commands::set_event_review,
            commands::update_event_bounds,
            commands::add_manual_event,
            commands::delete_event,
            commands::prepare_review,
            active_learning_commands::run_pcen,
            active_learning_commands::run_active_learning,
            active_learning_commands::run_qbe_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
