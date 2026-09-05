//! Headless batch runner CLI for the HLW buzz pipeline.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use batch_core::concurrency::resolve_concurrency;
use batch_core::engine::{run_session, EngineConfig, Progress};
use batch_core::enumerate::enumerate_audio;
use batch_core::identity::{code_identities, model_identity};
use batch_core::export::{export_csv, export_json, export_telemetry_csv};
use batch_core::store::{NewSession, Store};

const DEFAULT_SPECIES_NAME: &str = "Hume's Leaf Warbler";

struct Args {
    input: PathBuf,
    db: PathBuf,
    device: String,
    concurrency: usize,
    worker_cmd: String,
    cwd: Option<PathBuf>,
    theta_a: f64,
    theta_b: f64,
    localizer: Option<String>,
    classifier: Option<String>,
    classifier_c: Option<String>,
    f_min_hz: Option<f64>,
    f_max_hz: Option<f64>,
    species_name: Option<String>,
    timeout_secs: u64,
    max_attempts: i64,
    export_csv: Option<PathBuf>,
    export_json: Option<PathBuf>,
    export_telemetry: Option<PathBuf>,
    complete_only: bool,
    confirmed_only: bool,
    metadata: Option<PathBuf>,
}



fn usage_and_exit() -> ! {
    eprintln!(
        "usage: batch --input <folder> [--db batch.db] [--device cpu] [--concurrency 0] \
         [--worker-cmd \"uv run python scripts/ml_engine.py --worker\"] [--cwd DIR] \
         [--theta-a 0.0] [--theta-b 0.530306] [--timeout-secs 600] [--max-attempts 2] \
         [--localizer model.pt] [--classifier model.pt] [--classifier-c model.pt] \
         [--f-min-hz 4125] [--f-max-hz 11625] [--species-name NAME] \
         [--export-csv out.csv] [--export-json out.json] [--export-telemetry telemetry.csv] \
         [--complete-only] [--confirmed-only] [--metadata deployments.csv]"
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
        localizer: None,
        classifier: None,
        classifier_c: None,
        f_min_hz: None,
        f_max_hz: None,
        species_name: None,
        timeout_secs: 600,
        max_attempts: 2,
        export_csv: None,
        export_json: None,
        complete_only: false,
        confirmed_only: false,
        metadata: None,
        export_telemetry: None,
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
            "--localizer" => a.localizer = Some(next()),
            "--classifier" => a.classifier = Some(next()),
            "--classifier-c" => a.classifier_c = Some(next()),
            "--f-min-hz" => a.f_min_hz = Some(next().parse().unwrap_or_else(|_| usage_and_exit())),
            "--f-max-hz" => a.f_max_hz = Some(next().parse().unwrap_or_else(|_| usage_and_exit())),
            "--species-name" => a.species_name = Some(next()),
            "--timeout-secs" => a.timeout_secs = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--max-attempts" => a.max_attempts = next().parse().unwrap_or_else(|_| usage_and_exit()),
            "--export-csv" => a.export_csv = Some(PathBuf::from(next())),
            "--export-json" => a.export_json = Some(PathBuf::from(next())),
            "--export-telemetry" => a.export_telemetry = Some(PathBuf::from(next())),
            "--complete-only" => a.complete_only = true,
            "--confirmed-only" => a.confirmed_only = true,
            "--metadata" => a.metadata = Some(PathBuf::from(next())),
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

    let paths = enumerate_audio(&[args.input.clone()]).expect("enumerate audio input");
    println!("Found {} audio files under {}", paths.len(), args.input.display());

    let store = Store::open(&args.db).expect("open db");
    let input_abs = args.input.canonicalize().unwrap_or_else(|_| args.input.clone());
    let roots_json = serde_json::to_string(&vec![input_abs.to_string_lossy()]).unwrap();

    let conc = if args.concurrency == 0 {
        resolve_concurrency(&args.device, None)
    } else {
        args.concurrency
    };
    let resolved_cwd = args.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });
    let resolved_cwd = resolved_cwd.canonicalize().unwrap_or(resolved_cwd);
    let config_key = serde_json::to_string(&serde_json::json!({
        "schema": 1,
        "app_version": env!("CARGO_PKG_VERSION"),
        "device": args.device,
        "worker_cmd": args.worker_cmd,
        "cwd": resolved_cwd.to_string_lossy(),
        "theta_a": args.theta_a,
        "theta_b": args.theta_b,
        "species_name": args.species_name.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(DEFAULT_SPECIES_NAME),
        "f_min_hz": args.f_min_hz,
        "f_max_hz": args.f_max_hz,
        "localizer": args.localizer,
        "classifier": args.classifier,
        "classifier_c": args.classifier_c,
        "model_identities": {
            "localizer": model_identity(&resolved_cwd, args.localizer.as_deref(), Some("models/buzz_localizer.pt")),
            "classifier": model_identity(&resolved_cwd, args.classifier.as_deref(), Some("models/classifier.pt")),
            "classifier_c": model_identity(&resolved_cwd, args.classifier_c.as_deref(), None),
        },
        "code_identities": code_identities(&resolved_cwd, &args.worker_cmd),
    }))
    .expect("serialize analysis configuration");
    let output_dir = args
        .db
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let cwd_text = resolved_cwd.to_string_lossy().into_owned();
    let species_name = args
        .species_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_SPECIES_NAME)
        .to_owned();

    let sid = match store.find_resumable(&roots_json, &config_key, &args.device).expect("find_resumable") {
        Some(id) => {
            println!("Resuming session {}", id);
            id
        }
        None => store
            .create_session(&NewSession {
                input_roots: &roots_json,
                output_dir: &output_dir,
                device: &args.device,
                concurrency: conc as i64,
                theta_a: args.theta_a,
                theta_b: args.theta_b,
                species_name: Some(&species_name),
                config_key: &config_key,
                worker_cmd: Some(&args.worker_cmd),
                cwd: Some(&cwd_text),
                localizer_path: args.localizer.as_deref(),
                classifier_path: args.classifier.as_deref(),
                classifier_c_path: args.classifier_c.as_deref(),
                f_min_hz: args.f_min_hz,
                f_max_hz: args.f_max_hz,
            })
            .expect("create_session"),
    };
    let synced = store.sync_files(sid, &paths).expect("sync_files");
    println!(
        "{} new, {} changed, {} removed files reconciled (session {})",
        synced.added, synced.requeued, synced.removed, sid
    );

    let mut parts: Vec<String> = args.worker_cmd.split_whitespace().map(String::from).collect();
    if parts.is_empty() {
        usage_and_exit();
    }
    let program = parts.remove(0);
    let mut worker_args = parts;
    worker_args.push("--device".into());
    worker_args.push(args.device.clone());
    for (flag, value) in [
        ("--localizer", args.localizer.as_ref()),
        ("--classifier", args.classifier.as_ref()),
        ("--classifier-c", args.classifier_c.as_ref()),
    ] {
        if let Some(value) = value {
            worker_args.push(flag.into());
            worker_args.push(value.clone());
        }
    }
    worker_args.push("--species-name".into());
    worker_args.push(species_name.clone());
    if let Some(value) = args.f_min_hz {
        worker_args.push("--f-min-hz".into());
        worker_args.push(value.to_string());
    }
    if let Some(value) = args.f_max_hz {
        worker_args.push("--f-max-hz".into());
        worker_args.push(value.to_string());
    }

    let cfg = EngineConfig {
        python: program,
        worker_args,
        cwd: Some(resolved_cwd),
        concurrency: conc,
        theta_a: args.theta_a,
        theta_b: args.theta_b,
        manifest_only: true,
        timeout: Duration::from_secs(args.timeout_secs),
        max_attempts: args.max_attempts,
        cancel: None,
        localizer: args.localizer.clone(),
        classifier: args.classifier.clone(),
        classifier_c: args.classifier_c.clone(),
        f_min_hz: args.f_min_hz,
        f_max_hz: args.f_max_hz,
        species_name: Some(species_name),
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

    let run_result = run_session(store.clone(), sid, cfg, Some(tx));
    let _ = printer.join();
    let summary = match run_result {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("Session {sid} failed internally: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "Session {} complete: {} ok, {} failed, {} events ({} complete, {} retained)",
        sid, summary.done, summary.failed, summary.n_events, summary.n_complete, summary.n_retained
    );

    let metadata = args.metadata.as_deref();

    if let Some(csv) = args.export_csv {
        let s = store.lock().unwrap();
        let n = export_csv(&s, sid, &csv, args.complete_only, args.confirmed_only, metadata)
            .expect("export csv");
        println!("Exported {} event rows to {}", n, csv.display());
    }

    if let Some(json) = args.export_json {
        let s = store.lock().unwrap();
        let n = export_json(&s, sid, &json, args.complete_only, args.confirmed_only, metadata)
            .expect("export json");
        println!("Exported {} event rows to {}", n, json.display());
    }

    if let Some(csv) = args.export_telemetry {
        let s = store.lock().unwrap();
        let n = export_telemetry_csv(&s, sid, &csv).expect("export telemetry");
        println!("Exported {} review telemetry rows to {}", n, csv.display());
    }

    if summary.status != "done" {
        std::process::exit(1);
    }
}
