//! Tauri command surface wrapping batch-core.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use batch_core::concurrency::resolve_concurrency;
use batch_core::engine::{run_session, EngineConfig};
use batch_core::enumerate::enumerate_audio;
use batch_core::export::{export_csv, export_json};
use batch_core::store::{FileRow, NewSession, Store, Summary};

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
}

fn resolve_cwd(cwd: Option<String>) -> PathBuf {
    let dir = cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("get current_dir"));

    // Dev mode: walk up until we find models/ and pyproject.toml
    let mut current = dir.clone();
    for _ in 0..3 {
        if current.join("models").exists() && current.join("pyproject.toml").exists() {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    dir
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
    let sid = match store.find_resumable(&roots_json).map_err(|e| e.to_string())? {
        Some(id) => id,
        None => store
            .create_session(&NewSession {
                input_roots: &roots_json,
                output_dir: &opts.output_dir,
                device: &opts.device,
                concurrency: conc as i64,
                theta_a: opts.theta_a,
                theta_b: opts.theta_b,
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
    let program = parts.remove(0);
    let mut worker_args = parts;
    worker_args.push("--device".into());
    worker_args.push(opts.device.clone());

    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = Some(cancel.clone());

    let cfg = EngineConfig {
        python: program,
        worker_args,
        cwd: Some(resolve_cwd(opts.cwd)),
        concurrency: conc,
        theta_a: opts.theta_a,
        theta_b: opts.theta_b,
        manifest_only: true,
        timeout: Duration::from_secs(opts.timeout_secs),
        max_attempts: opts.max_attempts,
        cancel: Some(cancel),
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
) -> Result<usize, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    let n = if fmt == "json" {
        export_json(&store, session_id, &p, complete_only)
    } else {
        export_csv(&store, session_id, &p, complete_only)
    }
    .map_err(|e| e.to_string())?;
    Ok(n)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthStatus {
    pub env_ok: bool,
    pub models_ok: bool,
    pub device: String,
    pub details: String,
}

#[tauri::command]
pub async fn check_health(cwd: Option<String>) -> Result<HealthStatus, String> {
    use std::process::Command;
    let dir = resolve_cwd(cwd);

    // Check models
    let m1 = dir.join("models/buzz_localizer.pt").exists();
    let m2 = dir.join("models/classifier.pt").exists();

    // Check Python env
    let output = Command::new("uv")
        .args([
            "run",
            "python",
            "-c",
            "import torch, ultralytics, librosa; print(torch.cuda.is_available() if torch.cuda.is_available() else torch.backends.mps.is_available())",
        ])
        .current_dir(&dir)
        .output();

    let (env_ok, device_info) = match output {
        Ok(o) if o.status.success() => {
            let gpu = String::from_utf8_lossy(&o.stdout).trim().to_lowercase();
            let d = if gpu == "true" {
                "Graphics Card (Accelerated)"
            } else {
                "Processor (CPU)"
            };
            (true, d.to_string())
        }
        _ => (false, "Not Found".to_string()),
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
        details,
    })
}

#[tauri::command]
pub async fn prepare_system(cwd: Option<String>) -> Result<(), String> {
    use std::process::Command;
    let dir = resolve_cwd(cwd);

    let status = Command::new("uv")
        .args(["sync"])
        .current_dir(&dir)
        .status()
        .map_err(|e| format!("Failed to run uv sync: {}", e))?;

    if !status.success() {
        return Err("uv sync failed. Check internet connection.".into());
    }
    Ok(())
}
