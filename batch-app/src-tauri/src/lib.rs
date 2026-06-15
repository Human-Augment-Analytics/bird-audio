mod commands;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::pick_save_path,
            commands::start_session,
            commands::cancel_session,
            commands::get_summary,
            commands::list_files,
            commands::export_session,
            commands::check_health,
            commands::prepare_system,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
