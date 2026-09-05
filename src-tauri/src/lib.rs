mod commands;
mod state;
mod script_commands;
mod ecology_commands;

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
            commands::open_existing_session,
            commands::concurrency_suggestion,
            commands::get_feature_flags,
            commands::get_session_events,
            commands::list_events,
            commands::set_event_review,
            commands::update_event_bounds,
            commands::add_manual_event,
            commands::delete_event,
            commands::restore_event,
            commands::log_review_action,
            commands::get_review_telemetry,
            commands::prepare_review,
            script_commands::run_verification_plan,
            ecology_commands::get_ecological_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
