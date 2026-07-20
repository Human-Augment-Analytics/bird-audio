//! Tauri command surface wrapping batch-core.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use batch_core::concurrency::resolve_concurrency;
use batch_core::engine::{run_session, EngineConfig, FileDone, Progress};
use batch_core::enumerate::enumerate_audio;
use batch_core::export::{export_csv, export_json, export_warbler, export_raven};
use batch_core::store::{EventRow, FileRow, NewSession, Store, Summary};

use crate::state::AppState;

fn db_path(output_dir: &str) -> PathBuf {
    PathBuf::from(output_dir).join("batch.db")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
    pub input: String,
    pub output_dir: String,
    pub device: String,
    pub concurrency: usize,
    pub worker_cmd: String,
    pub cwd: Option<String>,
    pub theta_a: f64,
    pub theta_b: f64,
    pub timeout_secs: u64,
    pub max_attempts: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartResult {
    pub session_id: i64,
    pub total_files: usize,
    /// Manifest rows dropped at start because the recording is gone from disk.
    /// Surfaced so the silent prune is visible to the researcher.
    pub pruned: usize,
}

fn resolve_cwd(cwd: Option<String>) -> PathBuf {
    if let Some(c) = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from) {
        return c;
    }

    // 1. Try the compile-time project root (parent of CARGO_MANIFEST_DIR)
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        if project_root.join("models").exists() && project_root.join("pyproject.toml").exists() {
            return project_root.to_path_buf();
        }
    }

    // 2. Try walking up from current executable path (useful for macOS bundle launched from Finder/Dock)
    if let Ok(exe) = std::env::current_exe() {
        let mut current = exe.clone();
        while let Some(parent) = current.parent() {
            if parent.join("models").exists() && parent.join("pyproject.toml").exists() {
                return parent.to_path_buf();
            }
            current = parent.to_path_buf();
        }
    }

    // 3. Try walking up from standard current_dir (useful in dev mode)
    if let Ok(dir) = std::env::current_dir() {
        let mut current = dir.clone();
        while let Some(parent) = current.parent() {
            if parent.join("models").exists() && parent.join("pyproject.toml").exists() {
                return parent.to_path_buf();
            }
            current = parent.to_path_buf();
        }
        if dir.join("models").exists() && dir.join("pyproject.toml").exists() {
            return dir;
        }
    }

    // 4. Fallback to current directory
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}


/// Build the engine config from the UI options: resolve worker command, device
/// args, and concurrency (honoring the `parallel_control` feature flag). Shared
/// by `start_session` and `retry_failed` so the two never drift.
fn make_engine_config(
    opts: &StartOpts,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<EngineConfig, String> {
    let conc = if opts.concurrency == 0 {
        resolve_concurrency(&opts.device, None)
    } else {
        opts.concurrency
    };
    let proj_dir = resolve_cwd(opts.cwd.clone());
    let flags = read_feature_flags(&proj_dir);
    let conc_final = match flags.get("parallel_control") {
        Some(v) if v == &serde_json::Value::Bool(false) => resolve_concurrency(&opts.device, None),
        _ => conc,
    };

    // worker command: split "uv run python scripts/ml_engine.py --worker" + device
    let mut parts: Vec<String> = opts.worker_cmd.split_whitespace().map(String::from).collect();
    if parts.is_empty() {
        return Err("worker_cmd is empty".into());
    }
    let program = parts.remove(0);
    let mut worker_args = parts;
    worker_args.push("--device".into());
    worker_args.push(opts.device.clone());

    Ok(EngineConfig {
        python: program,
        worker_args,
        cwd: Some(proj_dir),
        concurrency: conc_final,
        theta_a: opts.theta_a,
        theta_b: opts.theta_b,
        manifest_only: true,
        timeout: Duration::from_secs(opts.timeout_secs),
        max_attempts: opts.max_attempts,
        cancel,
    })
}

/// Spawn the worker pool for a session and wire its two event streams to the
/// frontend: `batch://progress` (throttled ~250ms aggregate) and
/// `batch://file_done` (one unthrottled message per file as it's stored).
/// Emits `batch://done` with the final summary. Shared by start/retry.
fn spawn_run(app: AppHandle, store: Store, sid: i64, cfg: EngineConfig) {
    let store = Arc::new(Mutex::new(store));
    let (tx, rx) = mpsc::channel::<Progress>();
    let (ftx, frx) = mpsc::channel::<FileDone>();

    // aggregate progress: throttle to ~250ms so we don't flood the webview
    let app_p = app.clone();
    let fwd_p = thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_millis(500);
        for p in rx {
            if last.elapsed() >= Duration::from_millis(250) {
                let _ = app_p.emit("batch://progress", &p);
                last = Instant::now();
            }
        }
    });

    // per-file completion: never throttled — this is the "file stored" signal
    let app_f = app.clone();
    let fwd_f = thread::spawn(move || {
        for fd in frx {
            let _ = app_f.emit("batch://file_done", &fd);
        }
    });

    let app_done = app.clone();
    thread::spawn(move || {
        let summary = run_session(store, sid, cfg, Some(tx), Some(ftx));
        let _ = fwd_p.join();
        let _ = fwd_f.join();
        let _ = app_done.emit("batch://done", &summary);
    });
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: StartOpts,
) -> Result<StartResult, String> {
    let paths = enumerate_audio(&[PathBuf::from(&opts.input)]);
    let store = Store::open(&db_path(&opts.output_dir)).map_err(|e| e.to_string())?;
    let input_abs = PathBuf::from(&opts.input)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&opts.input));
    let roots_json =
        serde_json::to_string(&vec![input_abs.to_string_lossy()]).map_err(|e| e.to_string())?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cfg = make_engine_config(&opts, Some(cancel.clone()))?;

    let sid = match store.find_resumable(&roots_json).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => store
            .create_session(&NewSession {
                input_roots: &roots_json,
                output_dir: &opts.output_dir,
                device: &opts.device,
                concurrency: cfg.concurrency as i64,
                theta_a: opts.theta_a,
                theta_b: opts.theta_b,
            })
            .map_err(|e| e.to_string())?,
    };
    store.add_files(sid, &paths).map_err(|e| e.to_string())?;
    // Drop any files that vanished from disk since a previous run so they can't
    // linger as `pending` and keep the session from ever finishing.
    let pruned = store.prune_missing(sid).map_err(|e| e.to_string())?;
    let total_files = store.list_files(sid).map_err(|e| e.to_string())?.len();

    *state.cancel.lock().unwrap() = Some(cancel);
    spawn_run(app, store, sid, cfg);

    Ok(StartResult { session_id: sid, total_files, pruned })
}

/// Re-run a session's failed files without re-picking the folder. With `paths`
/// it retries just those files (per-row retry); without, it retries every
/// terminally-failed file in the session. Reuses the same engine plumbing as
/// `start_session`.
#[tauri::command]
pub fn retry_failed(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: StartOpts,
    session_id: i64,
    paths: Option<Vec<String>>,
) -> Result<StartResult, String> {
    let store = Store::open(&db_path(&opts.output_dir)).map_err(|e| e.to_string())?;
    match &paths {
        Some(ps) => { store.reset_files(session_id, ps).map_err(|e| e.to_string())?; }
        None => { store.reset_failed(session_id).map_err(|e| e.to_string())?; }
    };
    let total_files = store.list_files(session_id).map_err(|e| e.to_string())?.len();

    let cancel = Arc::new(AtomicBool::new(false));
    let cfg = make_engine_config(&opts, Some(cancel.clone()))?;
    *state.cancel.lock().unwrap() = Some(cancel);
    spawn_run(app, store, session_id, cfg);

    Ok(StartResult { session_id, total_files, pruned: 0 })
}

#[tauri::command]
pub fn cancel_session(state: State<'_, AppState>) {
    if let Some(flag) = state.cancel.lock().unwrap().as_ref() {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn get_summary(output_dir: String, session_id: i64) -> Result<Summary, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.summary(session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_files(output_dir: String, session_id: i64) -> Result<Vec<FileRow>, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.list_files(session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_session(
    output_dir: String,
    session_id: i64,
    path: String,
    fmt: String,
    complete_only: bool,
    confirmed_only: bool,
    metadata_path: Option<String>,
) -> Result<usize, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    let meta_p = metadata_path.map(PathBuf::from);
    let meta_ref = meta_p.as_deref();
    let n = match fmt.as_str() {
        "json" => export_json(&store, session_id, &p, complete_only, confirmed_only, meta_ref),
        "warbler" => export_warbler(&store, session_id, &p, complete_only, confirmed_only),
        "raven" => export_raven(&store, session_id, &p, complete_only, confirmed_only),
        _ => export_csv(&store, session_id, &p, complete_only, confirmed_only, meta_ref),
    }
    .map_err(|e| e.to_string())?;
    Ok(n)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthStatus {
    pub env_ok: bool,
    pub models_ok: bool,
    pub device: String,
    pub internal_device: String,
    pub details: String,
}

#[derive(Debug, Serialize)]
pub struct ConcurrencyInfo {
    pub logical: usize,
    pub recommended: usize,
}

#[tauri::command]
pub fn concurrency_suggestion(device: String) -> Result<ConcurrencyInfo, String> {
    use batch_core::concurrency::resolve_concurrency;
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let recommended = resolve_concurrency(&device, None);
    Ok(ConcurrencyInfo { logical, recommended })
}

fn read_feature_flags(cwd: &std::path::Path) -> serde_json::Value {
    use std::fs;
    let p = cwd.join("config/features.yaml");
    if !p.exists() {
        return serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true, "card_ui": false, "time_estimates": true, "resume_runs": true, "cloud_import": false });
    }
    match fs::read_to_string(&p) {
        Ok(s) => match serde_yaml::from_str::<serde_yaml::Value>(&s) {
            Ok(v) => {
                // convert to serde_json::Value
                let j = serde_json::to_value(v).unwrap_or(serde_json::json!({}));
                j
            }
            Err(_) => serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true, "card_ui": false, "time_estimates": true, "resume_runs": true, "cloud_import": false }),
        },
        Err(_) => serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true, "card_ui": false, "time_estimates": true, "resume_runs": true, "cloud_import": false }),
    }
}

#[tauri::command]
pub fn get_feature_flags(cwd: Option<String>) -> Result<serde_json::Value, String> {
    let dir = resolve_cwd(cwd);
    Ok(read_feature_flags(&dir))
}

fn find_uv() -> std::path::PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::Path::new(&home).join(".local/bin/uv");
        if path.exists() {
            return path;
        }
    }
    let hb = std::path::Path::new("/opt/homebrew/bin/uv");
    if hb.exists() {
        return hb.to_path_buf();
    }
    let ul = std::path::Path::new("/usr/local/bin/uv");
    if ul.exists() {
        return ul.to_path_buf();
    }
    std::path::PathBuf::from("uv")
}

#[tauri::command]
pub async fn check_health(cwd: Option<String>) -> Result<HealthStatus, String> {
    use std::process::Command;
    let dir = resolve_cwd(cwd);

    // Check models
    let m1 = dir.join("models/buzz_localizer.pt").exists();
    let m2 = dir.join("models/classifier.pt").exists();

    // Check Python env
    let output = Command::new(find_uv())
        .args([
            "run",
            "python",
            "-c",
            "import torch, ultralytics, librosa; print('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')",
        ])
        .current_dir(&dir)
        .output();

    let (env_ok, device_info, internal_device) = match output {
        Ok(o) if o.status.success() => {
            let internal = String::from_utf8_lossy(&o.stdout).trim().to_lowercase();
            let d = if internal == "cuda" || internal == "mps" {
                "Graphics Card (Accelerated)"
            } else {
                "Processor (CPU)"
            };
            (true, d.to_string(), internal)
        }
        _ => (false, "Not Found".to_string(), "cpu".to_string()),
    };

    let details = if !m1 || !m2 {
        "Missing model files in models/ folder.".into()
    } else if !env_ok {
        "Python environment or dependencies missing. Click 'Prepare System'.".into()
    } else {
        "".into()
    };

    Ok(HealthStatus {
        env_ok,
        models_ok: m1 && m2,
        device: device_info,
        internal_device,
        details,
    })
}

#[tauri::command]
pub async fn prepare_system(cwd: Option<String>) -> Result<(), String> {
    use std::process::Command;
    let dir = resolve_cwd(cwd);

    let output = Command::new(find_uv())
        .args(["sync"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("Failed to execute uv sync: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "uv sync failed.\nStdout: {}\nStderr: {}",
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn count_audio_files(input: String) -> Result<usize, String> {
    Ok(enumerate_audio(&[PathBuf::from(&input)]).len())
}

#[tauri::command]
pub fn check_cache(output_dir: String) -> Result<bool, String> {
    Ok(db_path(&output_dir).exists())
}

#[tauri::command]
pub fn clear_cache(output_dir: String) -> Result<Vec<String>, String> {
    // WAL mode keeps the write-ahead log and shared-memory index in sidecar
    // files; deleting only batch.db can leave committed data behind in -wal that
    // reopens later. Remove all three so "start over" is truly clean.
    // Returns the file names actually removed so the UI can show that the
    // sidecars went with the database instead of the user having to trust it.
    let base = db_path(&output_dir);
    let mut removed = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", base.to_string_lossy(), suffix));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("Failed to delete cache: {}", e))?;
            removed.push(
                p.file_name().map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            );
        }
    }
    Ok(removed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    /// Broken files (failed or stuck in_progress) re-queued for another run.
    pub reset: usize,
    /// Manifest rows dropped because their audio file no longer exists on disk.
    pub pruned: usize,
}

/// Tidy the cache so a re-run is trustworthy without nuking finished work:
/// re-queue broken files and prune manifest rows for recordings that have
/// disappeared from disk. Distinct from `clear_cache`, which deletes everything.
#[tauri::command]
pub fn clean_cache(output_dir: String) -> Result<CleanResult, String> {
    let path = db_path(&output_dir);
    if !path.exists() {
        return Ok(CleanResult { reset: 0, pruned: 0 });
    }
    let store = Store::open(&path).map_err(|e| e.to_string())?;
    let sid = match store.get_latest_session_id().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(CleanResult { reset: 0, pruned: 0 }),
    };
    let reset = store.reset_broken(sid).map_err(|e| e.to_string())?;
    let pruned = store.prune_missing(sid).map_err(|e| e.to_string())?;
    Ok(CleanResult { reset, pruned })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFile {
    pub path: String,
    pub status: String,
    pub n_events: i64,
    pub n_complete: i64,
    pub error: Option<String>,
    pub stage: String,
    pub broken: bool,
}

#[tauri::command]
pub fn get_cached_files(output_dir: String) -> Result<Vec<CachedFile>, String> {
    let path = db_path(&output_dir);
    if !path.exists() {
        return Ok(vec![]);
    }
    let store = Store::open(&path).map_err(|e| e.to_string())?;
    let sid = match store.get_latest_session_id().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(vec![]),
    };

    let rows = store.list_cached_files(sid).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| CachedFile {
            path: r.path,
            status: r.status,
            n_events: r.n_events,
            n_complete: r.n_complete,
            error: r.error,
            stage: r.stage,
            broken: r.broken,
        })
        .collect())
}

/// Resolves the existing session for `output_dir` without touching the analysis
/// engine, so the frontend can jump straight to reviewing cached results without
/// risking kicking off a new run for any files that aren't done yet.
#[tauri::command]
pub fn get_review_session(output_dir: String) -> Result<Option<StartResult>, String> {
    let path = db_path(&output_dir);
    if !path.exists() {
        return Ok(None);
    }
    let store = Store::open(&path).map_err(|e| e.to_string())?;
    let sid = match store.get_latest_session_id().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(None),
    };
    let total_files = store.list_files(sid).map_err(|e| e.to_string())?.len();
    Ok(Some(StartResult { session_id: sid, total_files, pruned: 0 }))
}

#[tauri::command]
pub fn delete_cached_files(output_dir: String, paths: Vec<String>) -> Result<(), String> {
    let path = db_path(&output_dir);
    if !path.exists() {
        return Ok(());
    }
    let store = Store::open(&path).map_err(|e| e.to_string())?;
    let sid = match store.get_latest_session_id().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(()),
    };
    
    store.delete_cached_files(sid, &paths).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEvent {
    pub path: String,
    pub t_start: f64,
    pub t_end: f64,
    pub duration: f64,
    pub f_low: f64,
    pub f_high: f64,
    pub center_freq: f64,
    pub stage_a_conf: f64,
    pub completeness_score: Option<f64>,
    pub completeness_label: Option<String>,
    pub retained: Option<bool>,
}

#[tauri::command]
pub fn get_session_events(
    output_dir: String,
    session_id: i64,
) -> Result<Vec<ExportedEvent>, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let mut stmt = store
        .conn
        .prepare(
            "SELECT 
                f.path, 
                e.t_start, 
                e.t_end, 
                e.duration, 
                e.f_low, 
                e.f_high, 
                e.center_freq, 
                e.stage_a_conf, 
                e.completeness_score, 
                e.completeness_label, 
                e.retained 
             FROM events e 
             JOIN files f ON e.file_id = f.id 
             WHERE e.session_id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let event_iter = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(ExportedEvent {
                path: row.get(0)?,
                t_start: row.get(1)?,
                t_end: row.get(2)?,
                duration: row.get(3)?,
                f_low: row.get(4)?,
                f_high: row.get(5)?,
                center_freq: row.get(6)?,
                stage_a_conf: row.get(7)?,
                completeness_score: row.get(8)?,
                completeness_label: row.get(9)?,
                retained: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut events = Vec::new();
    for event in event_iter {
        events.push(event.map_err(|e| e.to_string())?);
    }
    Ok(events)
}

#[tauri::command]
pub fn list_events(output_dir: String, session_id: i64, path: String) -> Result<Vec<EventRow>, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.list_events(session_id, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_event_review(output_dir: String, event_id: i64, status: String, label: Option<String>, note: Option<String>) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.set_event_review(event_id, &status, label.as_deref(), note.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_event_bounds(output_dir: String, event_id: i64, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.update_event_bounds(event_id, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_manual_event(output_dir: String, session_id: i64, path: String, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<i64, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.add_manual_event(session_id, &path, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_event(output_dir: String, event_id: i64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.delete_event(event_id).map_err(|e| e.to_string())
}

/// Grant the asset-protocol scope for a session's input roots so the review UI
/// can load local audio via convertFileSrc().
#[tauri::command]
pub fn prepare_review(app: AppHandle, output_dir: String, session_id: i64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let roots_json = store.session_input_roots(session_id).map_err(|e| e.to_string())?;
    let roots: Vec<String> = serde_json::from_str(&roots_json).map_err(|e| e.to_string())?;
    let scope = app.asset_protocol_scope();
    for dir in &roots {
        scope.allow_directory(dir, true).ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_cwd_finds_project_root() {
        let resolved = resolve_cwd(None);
        assert!(resolved.join("pyproject.toml").exists(), "Resolved path {:?} does not contain pyproject.toml", resolved);
        assert!(resolved.join("models").exists(), "Resolved path {:?} does not contain models/", resolved);
    }
}
