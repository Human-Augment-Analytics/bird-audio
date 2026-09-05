//! Where the Python pipeline lives at run time.
//!
//! In development the app runs against the repository checkout, as before. In a
//! packaged build the checkout does not exist, so the pieces the pipeline needs
//! (`scripts/`, `birdpipe/`, `pyproject.toml`, `uv.lock`, `.python-version`,
//! `config/`, `models/`) are shipped inside the bundle as Tauri resources under
//! `payload/` and copied on first launch to a writable per-user directory, where
//! `uv sync` can create the virtual environment. The copy is refreshed whenever
//! the bundled app version changes.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// Marker file inside the runtime directory recording which app version
/// populated it.
const STAMP_FILE: &str = ".payload-version";

/// Sub-directory of the bundle's resource dir holding the pipeline payload.
const PAYLOAD_DIR: &str = "payload";

static PROJECT_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// The project root chosen at start-up, if `init` has run.
pub(crate) fn project_root() -> Option<&'static Path> {
    PROJECT_ROOT.get().map(|p| p.as_path())
}

/// True when `dir` looks like a usable pipeline root.
pub(crate) fn is_project_root(dir: &Path) -> bool {
    dir.join("models").exists() && dir.join("pyproject.toml").exists()
}

/// Find a repository checkout: the compile-time crate parent (dev builds), or any
/// ancestor of the executable or the current directory.
pub(crate) fn find_repo_root() -> Option<PathBuf> {
    // The compile-time path is only meaningful on the machine that built the
    // app, so release builds ignore it and behave like an installed copy.
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(root) = manifest_dir.parent() {
            if is_project_root(root) {
                return Some(root.to_path_buf());
            }
        }
    }
    let mut starts = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    if let Ok(dir) = std::env::current_dir() {
        starts.push(dir.clone());
        if is_project_root(&dir) {
            return Some(dir);
        }
    }
    for start in starts {
        let mut current = start;
        while let Some(parent) = current.parent() {
            if is_project_root(parent) {
                return Some(parent.to_path_buf());
            }
            current = parent.to_path_buf();
        }
    }
    None
}

/// Decide the project root once, at app start-up. A repository checkout wins;
/// otherwise the bundled payload is unpacked into the app-data directory.
pub(crate) fn init(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = PROJECT_ROOT.get() {
        return Ok(root.clone());
    }
    let root = match find_repo_root() {
        Some(root) => root,
        None => unpack_payload(app)?,
    };
    let _ = PROJECT_ROOT.set(root.clone());
    Ok(root)
}

fn unpack_payload(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot locate bundled resources: {e}"))?;
    let payload = resource_dir.join(PAYLOAD_DIR);
    if !is_project_root(&payload) {
        return Err(format!(
            "Bundled pipeline payload not found at {}. This build was made without the \
             pipeline resources; run the app from a repository checkout instead.",
            payload.display()
        ));
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate the app data directory: {e}"))?;
    let runtime = data_dir.join("runtime");
    let version = app.package_info().version.to_string();
    sync_payload(&payload, &runtime, &version)?;
    Ok(runtime)
}

/// Copy `payload` into `runtime` unless `runtime` already holds this version.
/// Only the payload's own files are replaced; the virtual environment that
/// `uv sync` creates alongside them (`.venv/`) is left alone so an app update
/// does not force a full re-download of the Python packages.
pub(crate) fn sync_payload(payload: &Path, runtime: &Path, version: &str) -> Result<(), String> {
    let stamp = runtime.join(STAMP_FILE);
    if is_project_root(runtime) && std::fs::read_to_string(&stamp).ok().as_deref() == Some(version) {
        return Ok(());
    }
    std::fs::create_dir_all(runtime).map_err(|e| format!("Cannot create {}: {e}", runtime.display()))?;
    for entry in std::fs::read_dir(payload).map_err(|e| format!("Cannot read {}: {e}", payload.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = runtime.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            if target.exists() {
                std::fs::remove_dir_all(&target).map_err(|e| format!("Cannot replace {}: {e}", target.display()))?;
            }
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("Cannot copy {}: {e}", target.display()))?;
        }
    }
    std::fs::write(&stamp, version).map_err(|e| format!("Cannot write {}: {e}", stamp.display()))?;
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("Cannot create {}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("Cannot read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("Cannot copy {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// The `uv` executable to use: the sidecar shipped next to the app binary when
/// present, else the usual install locations, else whatever is on `PATH`.
pub(crate) fn find_uv() -> PathBuf {
    let exe_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(exe_name);
            if sidecar.exists() {
                return sidecar;
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let path = Path::new(&home).join(".local/bin").join(exe_name);
        if path.exists() {
            return path;
        }
    }
    for candidate in ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"] {
        let path = Path::new(candidate);
        if path.exists() {
            return path.to_path_buf();
        }
    }
    PathBuf::from(exe_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bbg_runtime_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_payload(dir: &Path) {
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("models/a.pt"), b"model").unwrap();
        std::fs::write(dir.join("scripts/ml_engine.py"), b"print(1)").unwrap();
        std::fs::write(dir.join("pyproject.toml"), b"[project]").unwrap();
    }

    #[test]
    fn repo_root_is_found_in_dev() {
        let root = find_repo_root().expect("repo root");
        assert!(root.join("pyproject.toml").exists());
        assert!(root.join("models").exists());
    }

    #[test]
    fn payload_is_copied_once_per_version_and_keeps_venv() {
        let base = temp("sync");
        let payload = base.join("payload");
        let runtime = base.join("runtime");
        fake_payload(&payload);

        sync_payload(&payload, &runtime, "1.0.0").unwrap();
        assert_eq!(std::fs::read(runtime.join("models/a.pt")).unwrap(), b"model");
        assert!(is_project_root(&runtime));

        // A venv created later survives a same-version and a new-version sync.
        std::fs::create_dir_all(runtime.join(".venv")).unwrap();
        std::fs::write(runtime.join(".venv/marker"), b"x").unwrap();
        std::fs::write(payload.join("scripts/ml_engine.py"), b"print(2)").unwrap();

        sync_payload(&payload, &runtime, "1.0.0").unwrap();
        assert_eq!(std::fs::read(runtime.join("scripts/ml_engine.py")).unwrap(), b"print(1)", "same version: untouched");

        sync_payload(&payload, &runtime, "1.1.0").unwrap();
        assert_eq!(std::fs::read(runtime.join("scripts/ml_engine.py")).unwrap(), b"print(2)", "new version: refreshed");
        assert!(runtime.join(".venv/marker").exists(), "venv kept across versions");
        assert_eq!(std::fs::read_to_string(runtime.join(STAMP_FILE)).unwrap(), "1.1.0");
    }
}
