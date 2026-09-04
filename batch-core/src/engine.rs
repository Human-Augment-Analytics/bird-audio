//! Warm-worker pool: each thread owns a worker, claims files from the store,
//! sends them, persists results, and reports progress. Bad/hung/dead workers
//! are killed and respawned; files are retried up to `max_attempts` then poisoned.

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::protocol::{Request, WorkerMsg};
use crate::store::{Claimed, RecordedResult, Store, Summary};
use crate::worker::Worker;

#[derive(Clone)]
pub struct EngineConfig {
    pub python: String,
    pub worker_args: Vec<String>,
    pub cwd: Option<std::path::PathBuf>,
    pub concurrency: usize,
    pub theta_a: f64,
    pub theta_b: f64,
    pub manifest_only: bool,
    pub timeout: Duration,
    pub max_attempts: i64,
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    pub localizer: Option<String>,
    pub classifier: Option<String>,
    pub classifier_c: Option<String>,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
    pub species_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub session_id: i64,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub pending: i64,
    pub in_progress: i64,
    pub last_file: Option<String>,
    pub last_elapsed_ms: Option<i64>,
    pub elapsed_ms_total: i64,
}

fn lock_store(store: &Arc<Mutex<Store>>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fail_or_requeue(
    store: &Arc<Mutex<Store>>,
    c: &Claimed,
    cfg: &EngineConfig,
    reason: &str,
) -> rusqlite::Result<()> {
    let s = lock_store(store);
    if c.attempts >= cfg.max_attempts {
        s.mark_failed(c.file_id, reason)
    } else {
        s.requeue(c.file_id)
    }
}

/// Persist what the first worker to come up reported loading. Losing the manifest
/// costs provenance, not results, so a storage failure is logged and the run goes on.
fn record_manifest(
    store: &Arc<Mutex<Store>>,
    session_id: i64,
    manifest: Option<&serde_json::Value>,
    cfg: &EngineConfig,
) {
    let Some(value) = manifest else { return };
    let mut value = value.clone();
    if let Some(root) = value.as_object_mut() {
        let analysis = root
            .entry("analysis")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let Some(analysis) = analysis.as_object_mut() {
            analysis.insert("theta_a".into(), serde_json::json!(cfg.theta_a));
            analysis.insert("theta_b".into(), serde_json::json!(cfg.theta_b));
            if let Some(value) = cfg.f_min_hz {
                analysis.insert("f_min_hz".into(), serde_json::json!(value));
            }
            if let Some(value) = cfg.f_max_hz {
                analysis.insert("f_max_hz".into(), serde_json::json!(value));
            }
            if let Some(value) = &cfg.species_name {
                analysis.insert("species_name".into(), serde_json::json!(value));
            }
        }
    }
    let effective_device = value
        .pointer("/analysis/device")
        .or_else(|| value.pointer("/extra/device"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let text = match serde_json::to_string(&value) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("run manifest: failed to serialize worker manifest: {e}");
            return;
        }
    };
    let s = lock_store(store);
    if let Some(device) = effective_device {
        if let Err(e) = s.set_session_effective_device(session_id, &device) {
            eprintln!("run manifest: failed to store effective device for session {session_id}: {e}");
        }
    }
    if let Err(e) = s.set_run_manifest(session_id, &text) {
        eprintln!("run manifest: failed to store for session {session_id}: {e}");
    }
}

fn worker_loop(
    store: Arc<Mutex<Store>>,
    session_id: i64,
    cfg: Arc<EngineConfig>,
    progress: Option<Sender<Progress>>,
    start: std::time::Instant,
) -> Result<(), String> {
    let mut worker: Option<Worker> = None;
    let mut last_elapsed_ms: Option<i64> = None;
    loop {
        if let Some(flag) = &cfg.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
        }
        let claimed = {
            let s = lock_store(&store);
            s.claim_next_pending(session_id)
                .map_err(|error| format!("failed to claim the next file: {error}"))?
        };
        let c = match claimed {
            Some(c) => c,
            None => break,
        };

        if worker.is_none() {
            match Worker::spawn(&cfg.python, &cfg.worker_args, cfg.cwd.as_deref()) {
                Ok(w) => {
                    record_manifest(&store, session_id, w.manifest.as_ref(), &cfg);
                    worker = Some(w);
                }
                Err(err) => {
                    fail_or_requeue(&store, &c, &cfg, &format!("worker spawn failed: {err:?}"))
                        .map_err(|error| format!("failed to record worker spawn failure: {error}"))?;
                    continue;
                }
            }
        }

        let req = Request {
            id: c.file_id as u64,
            input: c.path.clone(),
            manifest_only: cfg.manifest_only,
            theta_a: cfg.theta_a,
            theta_b: cfg.theta_b,
            emit_raw: false,
            localizer: cfg.localizer.clone(),
            classifier: cfg.classifier.clone(),
            classifier_c: cfg.classifier_c.clone(),
            f_min_hz: cfg.f_min_hz,
            f_max_hz: cfg.f_max_hz,
            species_name: cfg.species_name.clone(),
        };

        let w = worker.as_mut().unwrap();
        let outcome = if w.send(&req).is_ok() {
            let deadline = std::time::Instant::now() + cfg.timeout;
            let mut got = Err(crate::worker::WorkerError::Timeout);
            while std::time::Instant::now() < deadline {
                if let Some(flag) = &cfg.cancel {
                    if flag.load(std::sync::atomic::Ordering::Relaxed) {
                        got = Err(crate::worker::WorkerError::Closed);
                        break;
                    }
                }
                match w.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(msg) => {
                        got = Ok(msg);
                        break;
                    }
                    Err(crate::worker::WorkerError::Timeout) => continue,
                    Err(err) => {
                        got = Err(err);
                        break;
                    }
                }
            }
            got
        } else {
            Err(crate::worker::WorkerError::Closed)
        };

        if let Some(flag) = &cfg.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                if let Some(mut bad) = worker.take() {
                    bad.kill();
                }
                let s = lock_store(&store);
                let _ = s.requeue(c.file_id);
                break;
            }
        }

        match outcome {
            Ok(WorkerMsg::Result {
                id, n_events, n_complete, n_retained, elapsed_ms, events, ..
            }) if id == c.file_id as u64 => {
                last_elapsed_ms = Some(elapsed_ms as i64);
                let mut s = lock_store(&store);
                s.record_success(
                    session_id,
                    c.file_id,
                    &RecordedResult { n_events, n_complete, n_retained, elapsed_ms, events: &events },
                )
                .map_err(|error| format!("failed to persist worker result: {error}"))?;
            }
            Ok(WorkerMsg::Error { message, .. }) => {
                fail_or_requeue(&store, &c, &cfg, &message)
                    .map_err(|error| format!("failed to persist worker error: {error}"))?;
            }
            Ok(_other) => {
                if let Some(mut bad) = worker.take() {
                    bad.kill();
                }
                fail_or_requeue(&store, &c, &cfg, "protocol/id mismatch")
                    .map_err(|error| format!("failed to persist protocol failure: {error}"))?;
            }
            Err(err) => {
                if let Some(mut bad) = worker.take() {
                    bad.kill();
                }
                fail_or_requeue(&store, &c, &cfg, &format!("worker failed: {err:?}"))
                    .map_err(|error| format!("failed to persist worker failure: {error}"))?;
            }
        }

        if let Some(tx) = &progress {
            let snap = {
                let s = lock_store(&store);
                s.summary(session_id)
                    .map_err(|error| format!("failed to read progress summary: {error}"))?
            };
            let elapsed_total = start.elapsed().as_millis() as i64;
            let _ = tx.send(Progress {
                session_id,
                total: snap.total,
                done: snap.done,
                failed: snap.failed,
                pending: snap.pending,
                in_progress: snap.in_progress,
                last_file: Some(c.path.clone()),
                last_elapsed_ms: last_elapsed_ms,
                elapsed_ms_total: elapsed_total,
            });
        }
    }
    if let Some(mut w) = worker.take() {
        w.kill();
    }
    Ok(())
}

/// Run all pending files for a session to completion; returns the final summary.
pub fn run_session(
    store: Arc<Mutex<Store>>,
    session_id: i64,
    cfg: EngineConfig,
    progress: Option<Sender<Progress>>,
) -> Result<Summary, String> {
    {
        let s = lock_store(&store);
        s.set_session_status(session_id, "running")
            .map_err(|error| format!("failed to start session: {error}"))?;
        s.reset_in_progress(session_id)
            .map_err(|error| format!("failed to reset interrupted files: {error}"))?;
        s.reset_failed(session_id)
            .map_err(|error| format!("failed to reset failed files: {error}"))?;
    }
    if let Some(tx) = &progress {
        let snap = {
            let s = lock_store(&store);
            s.summary(session_id).ok()
        };
        if let Some(snap) = snap {
            let _ = tx.send(Progress {
                session_id,
                total: snap.total,
                done: snap.done,
                failed: snap.failed,
                pending: snap.pending,
                in_progress: snap.in_progress,
                last_file: None,
                last_elapsed_ms: None,
                elapsed_ms_total: 0,
            });
        }
    }
    let cfg = Arc::new(cfg);
    let mut handles = Vec::new();
    let start = std::time::Instant::now();
    for _ in 0..cfg.concurrency.max(1) {
        let store = store.clone();
        let cfg = cfg.clone();
        let progress = progress.clone();
        handles.push(thread::spawn(move || worker_loop(store, session_id, cfg, progress, start)));
    }
    let mut worker_error: Option<String> = None;
    for h in handles {
        match h.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                worker_error.get_or_insert(error);
            }
            Err(_) => {
                worker_error.get_or_insert_with(|| "worker thread panicked".into());
            }
        }
    }
    let s = lock_store(&store);
    let was_cancelled = cfg.cancel.as_ref().is_some_and(|flag| {
        flag.load(std::sync::atomic::Ordering::Relaxed)
    });
    let final_counts = s
        .summary(session_id)
        .map_err(|error| format!("failed to read terminal summary: {error}"))?;
    let status = if worker_error.is_some() {
        "failed"
    } else if was_cancelled {
        "cancelled"
    } else if final_counts.failed > 0 {
        "failed"
    } else {
        "done"
    };
    s.set_session_status(session_id, status)
        .map_err(|error| format!("failed to store terminal session status: {error}"))?;
    let summary = s
        .summary(session_id)
        .map_err(|error| format!("failed to read final session summary: {error}"))?;
    if let Some(error) = worker_error {
        return Err(error);
    }
    Ok(summary)
}
