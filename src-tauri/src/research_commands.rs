//! Tauri bridge for the reproducible research-analysis bundle.

use std::path::Path;

use crate::active_learning_commands::run_script;

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
    let mut args = vec![
        "--db".into(), db_path,
        "--session-id".into(), session_id.to_string(),
        "--out".into(), analysis_dir.to_string_lossy().into_owned(),
        "--theta-a".into(), theta_a.to_string(),
        "--theta-b".into(), theta_b.to_string(),
        "--bin-minutes".into(), bin_minutes.to_string(),
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
