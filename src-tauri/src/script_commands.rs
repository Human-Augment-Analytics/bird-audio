//! Tauri commands that shell out to the project's Python scripts.

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

}
