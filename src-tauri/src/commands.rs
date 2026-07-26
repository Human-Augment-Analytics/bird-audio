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
use batch_core::engine::{run_session, EngineConfig};
use batch_core::enumerate::enumerate_audio;
use batch_core::export::{export_csv, export_json, export_telemetry_csv, export_warbler, export_raven};
use batch_core::store::{
    EventRow, FileRow, NewReviewEvent, NewSession, ReviewTelemetrySummary, Store, Summary,
};

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
    pub localizer: Option<String>,
    pub classifier: Option<String>,
    pub classifier_c: Option<String>,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
    pub species_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartResult {
    pub session_id: i64,
    pub total_files: usize,
}

pub(crate) fn resolve_cwd(cwd: Option<String>) -> PathBuf {
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
    let conc = if opts.concurrency == 0 {
        resolve_concurrency(&opts.device, None)
    } else {
        opts.concurrency
    };
    // Read feature flags from project cwd and enforce parallel_control
    let proj_dir = resolve_cwd(opts.cwd.clone());
    let flags = read_feature_flags(&proj_dir);
    let conc_final = match flags.get("parallel_control") {
        Some(v) if v == &serde_json::Value::Bool(false) => resolve_concurrency(&opts.device, None),
        _ => conc,
    };
    let sid = match store.find_resumable(&roots_json).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => store
                .create_session(&NewSession {
                input_roots: &roots_json,
                output_dir: &opts.output_dir,
                device: &opts.device,
                    concurrency: conc_final as i64,
                theta_a: opts.theta_a,
                theta_b: opts.theta_b,
                species_name: opts.species_name.as_deref(),
            })
            .map_err(|e| e.to_string())?,
    };
    store.add_files(sid, &paths).map_err(|e| e.to_string())?;
    let total_files = store.list_files(sid).map_err(|e| e.to_string())?.len();

    // worker command: split "uv run python scripts/ml_engine.py --worker" + device
    let mut parts: Vec<String> = opts.worker_cmd.split_whitespace().map(String::from).collect();
    if parts.is_empty() {
        return Err("worker_cmd is empty".into());
    }
    let mut program = parts.remove(0);
    if program == "uv" {
        program = find_uv().to_string_lossy().into_owned();
    }
    let mut worker_args = parts;
    worker_args.push("--device".into());
    worker_args.push(opts.device.clone());

    if let Some(ref loc) = opts.localizer {
        if !loc.trim().is_empty() {
            worker_args.push("--localizer".into());
            worker_args.push(loc.clone());
        }
    }
    if let Some(ref cls) = opts.classifier {
        if !cls.trim().is_empty() {
            worker_args.push("--classifier".into());
            worker_args.push(cls.clone());
        }
    }
    if let Some(ref clsc) = opts.classifier_c {
        if !clsc.trim().is_empty() {
            worker_args.push("--classifier-c".into());
            worker_args.push(clsc.clone());
        }
    }
    if let Some(f_min) = opts.f_min_hz {
        worker_args.push("--f-min-hz".into());
        worker_args.push(f_min.to_string());
    }
    if let Some(f_max) = opts.f_max_hz {
        worker_args.push("--f-max-hz".into());
        worker_args.push(f_max.to_string());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = Some(cancel.clone());

    let cfg = EngineConfig {
        python: program,
        worker_args,
        cwd: Some(resolve_cwd(opts.cwd)),
        concurrency: conc_final,
        theta_a: opts.theta_a,
        theta_b: opts.theta_b,
        manifest_only: true,
        timeout: Duration::from_secs(opts.timeout_secs),
        max_attempts: opts.max_attempts,
        cancel: Some(cancel),
        localizer: opts.localizer.clone(),
        classifier: opts.classifier.clone(),
        classifier_c: opts.classifier_c.clone(),
        f_min_hz: opts.f_min_hz,
        f_max_hz: opts.f_max_hz,
        species_name: opts.species_name.clone(),
    };

    let store = Arc::new(Mutex::new(store));
    let (tx, rx) = mpsc::channel();

    // forwarder thread: throttle progress events to ~250ms
    let app_fwd = app.clone();
    let fwd = thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_millis(500);
        for p in rx {
            if last.elapsed() >= Duration::from_millis(250) {
                let _ = app_fwd.emit("batch://progress", &p);
                last = Instant::now();
            }
        }
    });

    // run thread: drives the engine, then emits final summary
    let app_done = app.clone();
    thread::spawn(move || {
        let summary = run_session(store, sid, cfg, Some(tx));
        let _ = fwd.join();
        let _ = app_done.emit("batch://done", &summary);
    });

    Ok(StartResult { session_id: sid, total_files })
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
        "telemetry" => export_telemetry_csv(&store, session_id, &p),
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
        return serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true });
    }
    match fs::read_to_string(&p) {
        Ok(s) => match serde_yaml::from_str::<serde_yaml::Value>(&s) {
            Ok(v) => {
                // convert to serde_json::Value
                let j = serde_json::to_value(v).unwrap_or(serde_json::json!({}));
                j
            }
            Err(_) => serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true }),
        },
        Err(_) => serde_json::json!({ "parallel_control": true, "import_enabled": true, "advanced_settings": true }),
    }
}

#[tauri::command]
pub fn get_feature_flags(cwd: Option<String>) -> Result<serde_json::Value, String> {
    let dir = resolve_cwd(cwd);
    Ok(read_feature_flags(&dir))
}

pub(crate) fn find_uv() -> std::path::PathBuf {
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
pub async fn check_health(
    cwd: Option<String>,
    localizer: Option<String>,
    classifier: Option<String>,
    classifier_c: Option<String>,
) -> Result<HealthStatus, String> {
    use std::process::Command;
    let dir = resolve_cwd(cwd);

    // Check models
    let m1 = if let Some(ref loc) = localizer.as_ref().filter(|s| !s.trim().is_empty()) {
        let p = std::path::Path::new(loc);
        if p.is_absolute() {
            p.exists()
        } else {
            dir.join(p).exists()
        }
    } else {
        dir.join("models/buzz_localizer.pt").exists()
    };

    let m2 = if let Some(ref cls) = classifier.as_ref().filter(|s| !s.trim().is_empty()) {
        let p = std::path::Path::new(cls);
        if p.is_absolute() {
            p.exists()
        } else {
            dir.join(p).exists()
        }
    } else {
        dir.join("models/classifier.pt").exists()
    };

    let m3 = if let Some(ref clsc) = classifier_c.as_ref().filter(|s| !s.trim().is_empty()) {
        let p = std::path::Path::new(clsc);
        if p.is_absolute() {
            p.exists()
        } else {
            dir.join(p).exists()
        }
    } else {
        true
    };

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

    let details = if !m1 || !m2 || !m3 {
        "Missing model files in models/ folder.".into()
    } else if !env_ok {
        "Python environment or dependencies missing. Click 'Prepare System'.".into()
    } else {
        "".into()
    };

    Ok(HealthStatus {
        env_ok,
        models_ok: m1 && m2 && m3,
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
pub fn check_cache(output_dir: String) -> Result<bool, String> {
    Ok(db_path(&output_dir).exists())
}

#[tauri::command]
pub fn clear_cache(output_dir: String) -> Result<(), String> {
    let path = db_path(&output_dir);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete cache: {}", e))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CachedFile {
    pub path: String,
    pub status: String,
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
    
    let rows = store.list_files(sid).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| CachedFile { path: r.path, status: r.status }).collect())
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

/// Telemetry is an instrument, not part of the contract: a failed insert is
/// reported to the log and the curation call still succeeds.
fn log_telemetry(store: &Store, ev: &NewReviewEvent) {
    if let Err(e) = store.log_review_event(ev) {
        eprintln!("review telemetry: failed to log '{}': {}", ev.action, e);
    }
}

/// Telemetry needs the event's session and file; a missing event is not fatal.
fn event_scope(store: &Store, event_id: i64) -> Option<(i64, i64)> {
    match store.event_scope(event_id) {
        Ok(scope) => scope,
        Err(e) => {
            eprintln!("review telemetry: failed to resolve event {event_id}: {e}");
            None
        }
    }
}

fn review_action_for(status: &str) -> &'static str {
    match status {
        "confirmed" => "confirm",
        "rejected" => "reject",
        _ => "reset",
    }
}

#[tauri::command]
pub fn set_event_review(output_dir: String, event_id: i64, status: String, label: Option<String>, note: Option<String>) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let scope = event_scope(&store, event_id);
    store.set_event_review(event_id, &status, label.as_deref(), note.as_deref()).map_err(|e| e.to_string())?;
    if let Some((session_id, file_id)) = scope {
        let meta = serde_json::json!({ "status": status, "label": label }).to_string();
        log_telemetry(&store, &NewReviewEvent {
            session_id,
            event_id: Some(event_id),
            file_id: Some(file_id),
            action: review_action_for(&status),
            meta: Some(&meta),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn update_event_bounds(output_dir: String, event_id: i64, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let scope = event_scope(&store, event_id);
    store.update_event_bounds(event_id, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())?;
    if let Some((session_id, file_id)) = scope {
        let meta = serde_json::json!({
            "t_start": t_start, "t_end": t_end, "f_low": f_low, "f_high": f_high
        }).to_string();
        log_telemetry(&store, &NewReviewEvent {
            session_id,
            event_id: Some(event_id),
            file_id: Some(file_id),
            action: "edit_bounds",
            meta: Some(&meta),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn add_manual_event(output_dir: String, session_id: i64, path: String, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<i64, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let new_id = store.add_manual_event(session_id, &path, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())?;
    let meta = serde_json::json!({
        "path": path, "t_start": t_start, "t_end": t_end, "f_low": f_low, "f_high": f_high
    }).to_string();
    log_telemetry(&store, &NewReviewEvent {
        session_id,
        event_id: Some(new_id),
        file_id: event_scope(&store, new_id).map(|(_, file_id)| file_id),
        action: "add_manual",
        meta: Some(&meta),
    });
    Ok(new_id)
}

#[tauri::command]
pub fn delete_event(output_dir: String, event_id: i64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let scope = event_scope(&store, event_id);
    store.delete_event(event_id).map_err(|e| e.to_string())?;
    if let Some((session_id, file_id)) = scope {
        log_telemetry(&store, &NewReviewEvent {
            session_id,
            event_id: Some(event_id),
            file_id: Some(file_id),
            action: "delete",
            meta: None,
        });
    }
    Ok(())
}

/// Log a non-mutating reviewer action (play / seek / open_file / search).
#[tauri::command]
pub fn log_review_action(
    output_dir: String,
    session_id: i64,
    action: String,
    event_id: Option<i64>,
    file_id: Option<i64>,
    meta: Option<String>,
) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let file_id = file_id.or_else(|| event_id.and_then(|id| event_scope(&store, id)).map(|(_, f)| f));
    log_telemetry(&store, &NewReviewEvent {
        session_id,
        event_id,
        file_id,
        action: &action,
        meta: meta.as_deref(),
    });
    Ok(())
}

#[tauri::command]
pub fn get_review_telemetry(
    output_dir: String,
    session_id: i64,
    idle_cutoff_ms: Option<i64>,
) -> Result<ReviewTelemetrySummary, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    match idle_cutoff_ms {
        Some(cutoff) => store.review_telemetry_summary_with_cutoff(session_id, cutoff),
        None => store.review_telemetry_summary(session_id),
    }
    .map_err(|e| e.to_string())
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

    /// Returns (output_dir, session_id, event_id) for a one-file, one-event db.
    fn temp_session(tag: &str) -> (String, i64, i64) {
        let dir = std::env::temp_dir().join(format!("bbg_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::remove_file(db_path(&dir.to_string_lossy())).ok();
        let store = Store::open(&db_path(&dir.to_string_lossy())).unwrap();
        let sid = store.create_session(&NewSession {
            input_roots: "[\"/d\"]", output_dir: "/o", device: "cpu",
            concurrency: 1, theta_a: 0.0, theta_b: 0.53, species_name: None,
        }).unwrap();
        store.add_files(sid, &[PathBuf::from("/d/a.wav")]).unwrap();
        let eid = store.add_manual_event(sid, "/d/a.wav", 1.0, 2.0, 4000.0, 8000.0).unwrap();
        (dir.to_string_lossy().into_owned(), sid, eid)
    }

    #[test]
    fn set_event_review_logs_telemetry() {
        let (out, sid, eid) = temp_session("telem_ok");
        set_event_review(out.clone(), eid, "confirmed".into(), Some("HLW".into()), None).unwrap();
        let summary = get_review_telemetry(out.clone(), sid, None).unwrap();
        assert_eq!(summary.total_actions, 1);
        assert_eq!(summary.actions_by_type.get("confirm"), Some(&1));
        assert_eq!(summary.distinct_events_decided, 1);
        std::fs::remove_dir_all(&out).ok();
    }

    #[test]
    fn set_event_review_succeeds_when_telemetry_insert_fails() {
        let (out, sid, eid) = temp_session("telem_broken");
        {
            let store = Store::open(&db_path(&out)).unwrap();
            // A schema the indexes still accept but INSERT cannot satisfy.
            store.conn.execute_batch(
                "DROP TABLE review_events;
                 CREATE TABLE review_events(id INTEGER PRIMARY KEY, session_id INTEGER,
                     event_id INTEGER, at_ms INTEGER);",
            ).unwrap();
        }
        set_event_review(out.clone(), eid, "rejected".into(), None, None).unwrap();
        let store = Store::open(&db_path(&out)).unwrap();
        let status: String = store.conn.query_row(
            "SELECT review_status FROM events WHERE id=?1", rusqlite::params![eid], |r| r.get(0)).unwrap();
        assert_eq!(status, "rejected");
        let logged: i64 = store.conn.query_row("SELECT COUNT(*) FROM review_events", [], |r| r.get(0)).unwrap();
        assert_eq!(logged, 0);
        let _ = sid;
        drop(store);
        std::fs::remove_dir_all(&out).ok();
    }

    #[test]
    fn log_review_action_records_non_mutating_actions() {
        let (out, sid, eid) = temp_session("telem_actions");
        log_review_action(out.clone(), sid, "open_file".into(), None, None, None).unwrap();
        log_review_action(out.clone(), sid, "play".into(), Some(eid), None,
            Some("{\"t\":1.5}".into())).unwrap();
        let summary = get_review_telemetry(out.clone(), sid, None).unwrap();
        assert_eq!(summary.total_actions, 2);
        assert_eq!(summary.actions_by_type.get("play"), Some(&1));
        assert_eq!(summary.n_decisions, 0);
        std::fs::remove_dir_all(&out).ok();
    }
}
