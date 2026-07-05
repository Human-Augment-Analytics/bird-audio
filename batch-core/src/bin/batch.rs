//! Headless batch runner CLI for the HLW buzz pipeline.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use batch_core::concurrency::resolve_concurrency;
use batch_core::engine::{run_session, EngineConfig, Progress};
use batch_core::enumerate::enumerate_audio;
use batch_core::export::export_csv;
use batch_core::store::{NewSession, Store};

struct Args {
    input: PathBuf,
    db: PathBuf,
    device: String,
    concurrency: usize,
    worker_cmd: String,
    cwd: Option<PathBuf>,
    theta_a: f64,
    theta_b: f64,
    timeout_secs: u64,
    max_attempts: i64,
    export_csv: Option<PathBuf>,
}

fn usage_and_exit() -> ! {
    eprintln!(
        "usage: batch --input <folder> [--db batch.db] [--device cpu] [--concurrency 0] \
         [--worker-cmd \"uv run python scripts/ml_engine.py --worker\"] [--cwd DIR] \
         [--theta-a 0.0] [--theta-b 0.530306] [--timeout-secs 600] [--max-attempts 2] \
         [--export-csv out.csv]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut a = Args {
        input: PathBuf::new(),
        db: PathBuf::from("batch.db"),
        device: "cpu".into(),
        concurrency: 0,
        worker_cmd: "uv run python scripts/ml_engine.py --worker".into(),
        cwd: None,
        theta_a: 0.0,
        theta_b: 0.530306,
        timeout_secs: 600,
        max_attempts: 2,
        export_csv: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut next = || it.next().unwrap_or_else(|| usage_and_exit());
        match flag.as_str() {
            "--input" => a.input = PathBuf::from(next()),
            "--db" => a.db = PathBuf::from(next()),
            "--device" => a.device = next(),
            "--concurrency" => a.concurrency = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--worker-cmd" => a.worker_cmd = next(),
            "--cwd" => a.cwd = Some(PathBuf::from(next())),
            "--theta-a" => a.theta_a = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--theta-b" => a.theta_b = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--timeout-secs" => a.timeout_secs = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--max-attempts" => a.max_attempts = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--export-csv" => a.export_csv = Some(PathBuf::from(next())),
            _ => usage_and_exit(),
        }
    }
    if a.input.as_os_str().is_empty() {
        usage_and_exit();
    }
    a
}

fn main() {
    let args = parse_args();

    let paths = enumerate_audio(&[args.input.clone()]);
    println!("Found {} audio files under {}", paths.len(), args.input.display());

    let store = Store::open(&args.db).expect("open db");
    let input_abs = args.input.canonicalize().unwrap_or_else(|_| args.input.clone());
    let roots_json = serde_json::to_string(&vec![input_abs.to_string_lossy()]).unwrap();

    let conc = if args.concurrency == 0 {
        resolve_concurrency(&args.device, None)
    } else {
        args.concurrency
    };

    let sid = match store.find_resumable(&roots_json).expect("find_resumable") {
        Some(id) => {
            println!("Resuming session {}", id);
            id
        }
        None => store
            .create_session(&NewSession {
                input_roots: &roots_json,
                output_dir: &args
                    .db
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                device: &args.device,
                concurrency: conc as i64,
                theta_a: args.theta_a,
                theta_b: args.theta_b,
                species_name: None,
            })
            .expect("create_session"),
    };
    let added = store.add_files(sid, &paths).expect("add_files");
    println!("{} new files queued (session {})", added, sid);

    let mut parts: Vec<String> = args.worker_cmd.split_whitespace().map(String::from).collect();
    if parts.is_empty() {
        usage_and_exit();
    }
    let program = parts.remove(0);
    let mut worker_args = parts;
    worker_args.push("--device".into());
    worker_args.push(args.device.clone());

    let cfg = EngineConfig {
        python: program,
        worker_args,
        cwd: args.cwd.clone(),
        concurrency: conc,
        theta_a: args.theta_a,
        theta_b: args.theta_b,
        manifest_only: true,
        timeout: Duration::from_secs(args.timeout_secs),
        max_attempts: args.max_attempts,
        cancel: None,
        localizer: None,
        classifier: None,
        classifier_c: None,
        f_min_hz: None,
        f_max_hz: None,
        species_name: None,
    };
    println!("Running {} worker(s) (device={})...", conc, args.device);

    let store = Arc::new(Mutex::new(store));
    let (tx, rx) = mpsc::channel::<Progress>();
    let printer = thread::spawn(move || {
        use std::io::Write;
        for p in rx {
            print!("\r{}/{} done, {} failed   ", p.done, p.total, p.failed);
            std::io::stdout().flush().ok();
        }
        println!();
    });

    let summary = run_session(store.clone(), sid, cfg, Some(tx));
    let _ = printer.join();
    println!(
        "Session {} complete: {} ok, {} failed, {} events ({} complete, {} retained)",
        sid, summary.done, summary.failed, summary.n_events, summary.n_complete, summary.n_retained
    );

    if let Some(csv) = args.export_csv {
        let s = store.lock().unwrap();
        let n = export_csv(&s, sid, &csv, false, false, None).expect("export csv");
        println!("Exported {} event rows to {}", n, csv.display());
    }
}
