use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use batch_core::engine::{run_session, EngineConfig};
use batch_core::store::{NewSession, Store};

fn fake_args() -> Vec<String> {
    vec![format!("{}/tests/fake_worker.py", env!("CARGO_MANIFEST_DIR"))]
}

fn cfg(concurrency: usize, timeout_ms: u64, max_attempts: i64) -> EngineConfig {
    EngineConfig {
        python: "python3".into(),
        worker_args: fake_args(),
        cwd: None,
        concurrency,
        theta_a: 0.0,
        theta_b: 0.53,
        manifest_only: true,
        timeout: Duration::from_millis(timeout_ms),
        max_attempts,
        cancel: None,
        localizer: None,
        classifier: None,
        classifier_c: None,
        f_min_hz: None,
        f_max_hz: None,
        species_name: None,
    }
}

fn session_with(paths: &[&str]) -> (Arc<Mutex<Store>>, i64) {
    let store = Store::open_memory().unwrap();
    let sid = store
        .create_session(&NewSession {
            input_roots: "[\"/jobs\"]",
            output_dir: "/out",
            device: "cpu",
            concurrency: 2,
            theta_a: 0.0,
            theta_b: 0.53,
            species_name: None,
        })
        .unwrap();
    let pbs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    store.add_files(sid, &pbs).unwrap();
    (Arc::new(Mutex::new(store)), sid)
}

#[test]
fn runs_all_files_to_done() {
    let (store, sid) = session_with(&["/jobs/a.wav", "/jobs/b.wav", "/jobs/c.wav"]);
    let summary = run_session(store, sid, cfg(2, 10_000, 2), None);
    assert_eq!(summary.done, 3);
    assert_eq!(summary.failed, 0);
    assert_eq!(summary.n_events, 3);
    assert_eq!(summary.n_complete, 3);
}

#[test]
fn worker_reported_bad_file_is_marked_failed() {
    let (store, sid) = session_with(&["/jobs/ok.wav", "/jobs/BOOM.wav"]);
    let summary = run_session(store, sid, cfg(1, 10_000, 2), None);
    assert_eq!(summary.done, 1);
    assert_eq!(summary.failed, 1);
}

#[test]
fn hung_worker_times_out_and_file_is_poisoned_after_retries() {
    // short timeout so the test is fast; HANG never replies -> timeout each attempt
    let (store, sid) = session_with(&["/jobs/ok.wav", "/jobs/HANG.wav"]);
    let summary = run_session(store, sid, cfg(1, 400, 2), None);
    assert_eq!(summary.done, 1);
    assert_eq!(summary.failed, 1); // HANG poisoned after max_attempts
    assert_eq!(summary.pending, 0);
    assert_eq!(summary.in_progress, 0);
}

#[test]
fn crashing_worker_is_respawned_and_pool_keeps_working() {
    let (store, sid) = session_with(&["/jobs/ok1.wav", "/jobs/CRASH.wav", "/jobs/ok2.wav"]);
    let summary = run_session(store, sid, cfg(1, 10_000, 2), None);
    assert_eq!(summary.done, 2); // both ok files complete despite the crash
    assert_eq!(summary.failed, 1); // CRASH poisoned after retries
}

#[test]
fn resume_does_not_reprocess_done_files() {
    let (store, sid) = session_with(&["/jobs/a.wav", "/jobs/b.wav"]);
    // Pre-mark one file done by claiming + recording a success manually.
    {
        let mut s = store.lock().unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        s.record_success(
            sid,
            c.file_id,
            &batch_core::store::RecordedResult {
                n_events: 0, n_complete: 0, n_retained: 0, elapsed_ms: 1, events: &[],
            },
        )
        .unwrap();
    }
    // Now run: only the remaining pending file should be processed by the worker.
    let summary = run_session(store, sid, cfg(1, 10_000, 2), None);
    assert_eq!(summary.done, 2);
    // The pre-done file had 0 events; the worker-processed one has 1 -> total events == 1.
    assert_eq!(summary.n_events, 1);
}

#[test]
fn cancel_flag_stops_processing_before_any_file() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    let (store, sid) = session_with(&["/jobs/a.wav", "/jobs/b.wav", "/jobs/c.wav"]);
    let mut c = cfg(1, 10_000, 2);
    c.cancel = Some(Arc::new(AtomicBool::new(true))); // pre-cancelled
    let summary = run_session(store, sid, c, None);
    assert_eq!(summary.done, 0); // nothing processed
    assert_eq!(summary.pending, 3);
}
