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
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub pending: i64,
    pub in_progress: i64,
    pub last_file: Option<String>,
}

fn fail_or_requeue(store: &Arc<Mutex<Store>>, c: &Claimed, cfg: &EngineConfig, reason: &str) {
    let s = store.lock().unwrap();
    if c.attempts >= cfg.max_attempts {
        s.mark_failed(c.file_id, reason).expect("mark_failed");
    } else {
        s.requeue(c.file_id).expect("requeue");
    }
}

fn worker_loop(
    store: Arc<Mutex<Store>>,
    session_id: i64,
    cfg: Arc<EngineConfig>,
    progress: Option<Sender<Progress>>,
) {
    let mut worker: Option<Worker> = None;
    loop {
        if let Some(flag) = &cfg.cancel {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
        }
        let claimed = {
            let s = store.lock().unwrap();
            s.claim_next_pending(session_id).expect("claim")
        };
        let c = match claimed {
            Some(c) => c,
            None => break,
        };

        if worker.is_none() {
            match Worker::spawn(&cfg.python, &cfg.worker_args, cfg.cwd.as_deref()) {
                Ok(w) => worker = Some(w),
                Err(_) => {
                    fail_or_requeue(&store, &c, &cfg, "worker spawn failed");
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
        };

        let w = worker.as_mut().unwrap();
        let outcome = if w.send(&req).is_ok() {
            w.recv_timeout(cfg.timeout)
        } else {
            Err(crate::worker::WorkerError::Closed)
        };

        match outcome {
            Ok(WorkerMsg::Result {
                id, n_events, n_complete, n_retained, elapsed_ms, events, ..
            }) if id == c.file_id as u64 => {
                let mut s = store.lock().unwrap();
                s.record_success(
                    session_id,
                    c.file_id,
                    &RecordedResult { n_events, n_complete, n_retained, elapsed_ms, events: &events },
                )
                .expect("record_success");
            }
            Ok(WorkerMsg::Error { message, .. }) => {
                let s = store.lock().unwrap();
                s.mark_failed(c.file_id, &message).expect("mark_failed");
            }
            Ok(_other) => {
                if let Some(mut bad) = worker.take() {
                    bad.kill();
                }
                fail_or_requeue(&store, &c, &cfg, "protocol/id mismatch");
            }
            Err(_) => {
                if let Some(mut bad) = worker.take() {
                    bad.kill();
                }
                fail_or_requeue(&store, &c, &cfg, "timeout or worker died");
            }
        }

        if let Some(tx) = &progress {
            let snap = {
                let s = store.lock().unwrap();
                s.summary(session_id).expect("summary")
            };
            let _ = tx.send(Progress {
                total: snap.total,
                done: snap.done,
                failed: snap.failed,
                pending: snap.pending,
                in_progress: snap.in_progress,
                last_file: Some(c.path.clone()),
            });
        }
    }
    if let Some(mut w) = worker.take() {
        w.kill();
    }
}

/// Run all pending files for a session to completion; returns the final summary.
pub fn run_session(
    store: Arc<Mutex<Store>>,
    session_id: i64,
    cfg: EngineConfig,
    progress: Option<Sender<Progress>>,
) -> Summary {
    {
        let s = store.lock().unwrap();
        s.reset_in_progress(session_id).expect("reset_in_progress");
    }
    let cfg = Arc::new(cfg);
    let mut handles = Vec::new();
    for _ in 0..cfg.concurrency.max(1) {
        let store = store.clone();
        let cfg = cfg.clone();
        let progress = progress.clone();
        handles.push(thread::spawn(move || worker_loop(store, session_id, cfg, progress)));
    }
    for h in handles {
        let _ = h.join();
    }
    let s = store.lock().unwrap();
    s.set_session_status(session_id, "done").ok();
    s.summary(session_id).expect("summary")
}
