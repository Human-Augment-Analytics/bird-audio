//! Tauri commands for PCEN, Active Learning, and QBE.

use tokio::process::Command;

use crate::commands::{find_uv, resolve_cwd};

/// Run one of the `scripts/*.py` CLIs through the project's uv environment.
/// On failure the captured stderr is returned so the UI can show why.
pub(crate) async fn run_script(script: &str, args: &[String]) -> Result<String, String> {
    let dir = resolve_cwd(None);
    let output = Command::new(find_uv())
        .arg("run")
        .arg("python")
        .arg(script)
        .args(args)
        .current_dir(&dir)
        .output()
        .await
        .map_err(|e| format!("Failed to execute {}: {}", script, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "{} failed (exit {}).\nStderr: {}\nStdout: {}",
            script,
            output.status.code().unwrap_or(-1),
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn run_pcen(
    audio_path: String,
    output_dir: String,
    offset: f64,
    duration: f64,
) -> Result<String, String> {
    if !std::path::Path::new(&audio_path).exists() {
        return Err(format!("Error loading audio file: {}", audio_path));
    }
    let args = vec![
        "--input".to_string(),
        audio_path,
        "--output-dir".to_string(),
        output_dir,
        "--offset".to_string(),
        offset.to_string(),
        "--duration".to_string(),
        duration.to_string(),
    ];
    let stdout = run_script("scripts/pcen_preprocessor.py", &args).await?;
    Ok(stdout.trim().to_string())
}

#[tauri::command]
pub async fn run_active_learning(
    db_path: String,
    dataset_dir: String,
    min_stage_a_conf: f64,
    session_id: Option<i64>,
) -> Result<(), String> {
    if !std::path::Path::new(&db_path).exists() {
        return Err(format!("Database not found: {}", db_path));
    }
    let mut args = vec![
        "--db".to_string(),
        db_path,
        "--dataset-dir".to_string(),
        dataset_dir,
        "--min-stage-a-conf".to_string(),
        min_stage_a_conf.to_string(),
    ];
    if let Some(sid) = session_id {
        args.push("--session-id".to_string());
        args.push(sid.to_string());
    }
    run_script("scripts/active_learning.py", &args).await?;
    Ok(())
}

#[tauri::command]
pub async fn run_qbe_search(
    db_path: String,
    query_id: i64,
    feature_type: String,
    k: usize,
) -> Result<String, String> {
    if !std::path::Path::new(&db_path).exists() {
        return Err(format!("Database not found: {}", db_path));
    }
    let args = vec![
        "--db".to_string(),
        db_path,
        "--query-id".to_string(),
        query_id.to_string(),
        "--k".to_string(),
        k.to_string(),
        "--feature-type".to_string(),
        feature_type,
        "--json".to_string(),
    ];
    let stdout = run_script("scripts/query_by_example.py", &args).await?;
    // The JSON array is the last stdout line; anything else the script printed is noise.
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let matches: serde_json::Value = serde_json::from_str(json_line)
        .map_err(|e| format!("query_by_example.py returned unparseable output: {}\n{}", e, stdout.trim()))?;
    serde_json::to_string(&matches).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_verification_plan(
    db_path: String,
    threshold: f64,
    target_half_width: f64,
    strategy: String,
    budget: usize,
    theta_b: f64,
    session_id: Option<i64>,
) -> Result<String, String> {
    if !std::path::Path::new(&db_path).exists() {
        return Err(format!("Database not found: {}", db_path));
    }
    let mut args = vec![
        "--db".to_string(),
        db_path,
        "--threshold".to_string(),
        threshold.to_string(),
        "--target-half-width".to_string(),
        target_half_width.to_string(),
        "--strategy".to_string(),
        strategy,
        "--budget".to_string(),
        budget.to_string(),
        "--theta-b".to_string(),
        theta_b.to_string(),
        "--json".to_string(),
    ];
    if let Some(sid) = session_id {
        args.push("--session-id".to_string());
        args.push(sid.to_string());
    }
    let stdout = run_script("scripts/verification_planner.py", &args).await?;
    // The planner pretty-prints, so its object spans many lines; the whole stdout
    // is the document. The last-line fallback covers a compact emitter after noise.
    let plan: serde_json::Value = serde_json::from_str(stdout.trim())
        .or_else(|_| {
            let last = stdout
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            serde_json::from_str(last)
        })
        .map_err(|e| {
            format!(
                "verification_planner.py returned unparseable output: {}\n{}",
                e,
                stdout.trim()
            )
        })?;
    serde_json::to_string(&plan).map_err(|e| e.to_string())
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

    #[tokio::test]
    async fn test_run_verification_plan_error_db() {
        let result = run_verification_plan(
            "nonexistent.db".to_string(),
            0.5,
            0.05,
            "uncertainty".to_string(),
            25,
            0.530306,
            None,
        )
        .await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Database not found") || err_msg.contains("No such file"));
    }

    /// A path that exists but is not a database must fail, never yield a plan.
    #[tokio::test]
    async fn verification_plan_rejects_non_json_stdout() {
        let db = std::env::temp_dir().join(format!("vplan_bad_{}.db", std::process::id()));
        std::fs::write(&db, b"not a database").unwrap();
        let err = run_verification_plan(
            db.to_string_lossy().into_owned(),
            0.5,
            0.05,
            "uncertainty".to_string(),
            5,
            0.530306,
            None,
        )
        .await
        .expect_err("a corrupt db must not yield a plan");
        assert!(!err.is_empty());
        std::fs::remove_file(&db).ok();
    }

    /// A script that exits non-zero must surface its stderr, not fail silently.
    #[tokio::test]
    async fn failing_script_error_contains_stderr() {
        let err = run_script("scripts/query_by_example.py", &["--query-id".to_string()])
            .await
            .expect_err("missing argument value must fail");
        assert!(err.contains("query_by_example.py"), "unexpected error: {err}");
        // Without a usable uv/python the call fails to spawn at all, which is
        // also a diagnosable error and all this test can assert.
        assert!(
            err.contains("Stderr:") || err.contains("Failed to execute"),
            "unexpected error: {err}"
        );
    }

    /// The QBE command must reject non-JSON stdout rather than handing the
    /// frontend a string it cannot parse.
    #[tokio::test]
    async fn qbe_rejects_non_json_stdout() {
        let db = std::env::temp_dir().join(format!("qbe_bad_{}.db", std::process::id()));
        std::fs::write(&db, b"not a database").unwrap();
        let err = run_qbe_search(db.to_string_lossy().into_owned(), 1, "combined".to_string(), 5)
            .await
            .expect_err("a corrupt db must not yield matches");
        assert!(!err.is_empty());
        std::fs::remove_file(&db).ok();
    }
}
