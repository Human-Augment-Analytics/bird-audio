#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::json;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::thread;
use tauri::{AppHandle, Manager};

#[tauri::command]
fn read_output(outdir: String) -> Result<serde_json::Value, String> {
  use std::fs;
  let abs = std::path::Path::new(&outdir).canonicalize().map_err(|e| e.to_string())?;
  let read_if_exists = |sub: &str| -> Vec<String> {
    let p = abs.join(sub);
    if !p.exists() { return vec![] }
    match fs::read_dir(p) {
      Ok(rd) => rd.filter_map(|e| e.ok().map(|d| d.path().to_string_lossy().to_string())).collect(),
      Err(_) => vec![],
    }
  };
  let vis = read_if_exists("vis");
  let crops = read_if_exists("crops");
  let wav = read_if_exists("wav");
  let labels = read_if_exists("labels");

  // read label contents
  let mut label_contents = serde_json::Map::new();
  for lp in &labels {
    if let Ok(s) = std::fs::read_to_string(lp) { label_contents.insert(std::path::Path::new(lp).file_name().unwrap().to_string_lossy().to_string(), json!(s)); }
  }

  Ok(json!({"files": {"vis": vis, "crops": crops, "wav": wav, "labels": labels}, "labelContents": label_contents}))
}

#[tauri::command]
fn run_files(app: AppHandle, files: Vec<String>) -> Result<String, String> {
  let app_clone = app.clone();
  thread::spawn(move || {
    // use the app config dir (replaces deprecated `app_dir()`)
    let runs_dir = app_clone.path_resolver().app_config_dir().unwrap_or_else(|| std::path::PathBuf::from("./runs"));
    if !runs_dir.exists() { let _ = std::fs::create_dir_all(&runs_dir); }

    let repo_root = std::path::Path::new(&std::env::current_exe().unwrap()).parent().unwrap().parent().unwrap().to_path_buf();
    for f in files {
      let base = std::path::Path::new(&f).file_stem().unwrap().to_string_lossy().to_string();
      let outdir = runs_dir.join(format!("{}_{}", base, chrono::Local::now().timestamp()));
      let outdir_s = outdir.to_string_lossy().to_string();
      let _ = std::fs::create_dir_all(&outdir);

      // determine python executable
      let py = std::env::var("PYTHON_EXECUTABLE").unwrap_or_else(|_| {
        let venv = repo_root.join(".venv").join("bin").join("python");
        if venv.exists() { venv.to_string_lossy().to_string() } else { if cfg!(target_os = "windows") { "python".into() } else { "python3".into() } }
      });

      let script = repo_root.join("scripts").join("ml_engine.py");
      let mut cmd = match Command::new(&py).arg(script).arg("--input").arg(&f).arg("--output").arg(&outdir_s).arg("--localizer").arg("../models/buzz_localizer.pt").stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => { let _ = app_clone.emit_all("result", json!({"file": f, "outdir": outdir_s, "result": {"error": format!("failed to spawn: {}", e)} })); continue }
      };

      let stdout = cmd.stdout.take().unwrap();
      let stderr = cmd.stderr.take().unwrap();
      let app_for_stdout = app_clone.clone();
      let f_clone = f.clone();
      thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
          // send stdout lines as logs
          let _ = app_for_stdout.emit_all("log", json!({"file": f_clone, "line": line}));
        }
      });

      let app_for_stderr = app_clone.clone();
      let f_clone2 = f.clone();
      let out_clone2 = outdir_s.clone();
      let mut stderr_buf = String::new();
      let reader_err = BufReader::new(stderr);
      for line in reader_err.lines().flatten() {
        stderr_buf.push_str(&line);
        stderr_buf.push('\n');
        if line.starts_with("PROGRESS:") {
          if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&line[9..]) {
            let _ = app_for_stderr.emit_all("progress", json!({"file": f_clone2, "outdir": out_clone2, "payload": payload}));
          }
        } else {
          let _ = app_for_stderr.emit_all("log", json!({"file": f_clone2, "line": line}));
        }
      }

      let status = cmd.wait();
      match status {
        Ok(s) => {
          let code = s.code().unwrap_or(-1);
          // attempt to read result.json from stdout (not implemented here); return raw buffers
          let _ = app_clone.emit_all("result", json!({"file": f, "outdir": outdir_s, "result": {"code": code, "stderr": stderr_buf}}));
        }
        Err(e) => { let _ = app_clone.emit_all("result", json!({"file": f, "outdir": outdir_s, "result": {"error": e.to_string()}})); }
      }
    }
  });
  Ok("started".into())
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_files, read_output])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
