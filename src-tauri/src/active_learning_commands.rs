//! Tauri commands for PCEN, Active Learning, and QBE.

#[tauri::command]
pub async fn run_pcen(
    audio_path: String,
    _output_dir: String,
    _offset: f64,
    _duration: f64,
) -> Result<String, String> {
    if !std::path::Path::new(&audio_path).exists() {
        return Err(format!("Error loading audio file: {}", audio_path));
    }
    Err("Not implemented".to_string())
}

#[tauri::command]
pub async fn run_active_learning(
    db_path: String,
    _dataset_dir: String,
    _min_stage_a_conf: f64,
    _session_id: Option<i64>,
) -> Result<(), String> {
    if !std::path::Path::new(&db_path).exists() {
        return Err(format!("Database not found: {}", db_path));
    }
    Err("Not implemented".to_string())
}

#[tauri::command]
pub async fn run_qbe_search(
    db_path: String,
    _query_id: i64,
    _feature_type: String,
    _k: usize,
) -> Result<String, String> {
    if !std::path::Path::new(&db_path).exists() {
        return Err(format!("Database not found: {}", db_path));
    }
    Err("Not implemented".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_run_pcen_error_loading() {
        let result = run_pcen("nonexistent.wav".to_string(), "output".to_string(), 0.0, 10.0).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Error loading audio file") || err_msg.contains("No such file"));
    }

    #[tokio::test]
    async fn test_run_active_learning_error_db() {
        let result = run_active_learning("nonexistent.db".to_string(), "dataset".to_string(), 0.5, None).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Database not found") || err_msg.contains("No such file"));
    }

    #[tokio::test]
    async fn test_run_qbe_search_error_db() {
        let result = run_qbe_search("nonexistent.db".to_string(), 1, "combined".to_string(), 5).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Database not found") || err_msg.contains("No such file"));
    }
}
