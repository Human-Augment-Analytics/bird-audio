//! Tauri bridge for the reproducible research-analysis bundle.

use std::collections::BTreeMap;
use std::path::Path;

use crate::active_learning_commands::run_script;
use batch_core::audio::audio_duration_hours;
use batch_core::store::Store;

const DEFAULT_FILE_EFFORT_HOURS: f64 = 0.25;

#[tauri::command]
pub async fn run_research_analysis(
    db_path: String,
    session_id: i64,
    output_dir: String,
    metadata_path: Option<String>,
    theta_a: f64,
    theta_b: f64,
    bin_minutes: f64,
) -> Result<String, String> {
    if !Path::new(&db_path).exists() {
        return Err(format!("Database not found: {db_path}"));
    }
    if !(0.0..=1.0).contains(&theta_a) || !(0.0..=1.0).contains(&theta_b) {
        return Err("Thresholds must be between 0 and 1".to_string());
    }
    if !bin_minutes.is_finite() || bin_minutes <= 0.0 {
        return Err("Activity bin size must be positive".to_string());
    }
    let analysis_dir = Path::new(&output_dir).join("research").join(format!("session-{session_id}"));
    let db_for_effort = db_path.clone();
    let effort = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let store = Store::open(Path::new(&db_for_effort)).map_err(|error| error.to_string())?;
        let files = store.list_files(session_id).map_err(|error| error.to_string())?;
        let mut hours = BTreeMap::new();
        let mut n_measured = 0;
        let mut n_defaulted = 0;
        for file in files.into_iter().filter(|file| file.status == "done") {
            let value = match audio_duration_hours(Path::new(&file.path)) {
                Some(value) => { n_measured += 1; value }
                None => { n_defaulted += 1; DEFAULT_FILE_EFFORT_HOURS }
            };
            hours.insert(file.path, value);
        }
        Ok(serde_json::json!({
            "hours": hours, "n_measured": n_measured, "n_defaulted": n_defaulted,
            "available": true, "reader": "batch-core/symphonia-frame-scan"
        }))
    }).await.map_err(|error| format!("Duration worker failed: {error}"))??;
    std::fs::create_dir_all(&analysis_dir).map_err(|error| error.to_string())?;
    let effort_path = analysis_dir.join("effort.json");
    std::fs::write(&effort_path, serde_json::to_vec_pretty(&effort).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let mut args = vec![
        "--db".into(), db_path,
        "--session-id".into(), session_id.to_string(),
        "--out".into(), analysis_dir.to_string_lossy().into_owned(),
        "--theta-a".into(), theta_a.to_string(),
        "--theta-b".into(), theta_b.to_string(),
        "--bin-minutes".into(), bin_minutes.to_string(),
        "--effort-json".into(), effort_path.to_string_lossy().into_owned(),
    ];
    if let Some(path) = metadata_path.filter(|value| !value.trim().is_empty()) {
        if !Path::new(&path).exists() {
            return Err(format!("Metadata CSV not found: {path}"));
        }
        args.extend(["--metadata".into(), path]);
    }
    let stdout = run_script("scripts/research_analysis.py", &args).await?;
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        format!("research_analysis.py returned invalid JSON: {error}\n{}", stdout.trim())
    })?;
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_missing_database() {
        let error = run_research_analysis(
            "/does/not/exist.db".into(), 1, "/tmp".into(), None, 0.5, 0.5, 5.0,
        ).await.expect_err("missing database must fail");
        assert!(error.contains("Database not found"));
    }
}
