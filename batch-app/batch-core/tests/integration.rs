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
