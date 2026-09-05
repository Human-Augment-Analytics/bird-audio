//! Fingerprints for the inputs that make an analysis reproducible.
//!
//! These feed the session `config_key`: two runs with the same key may share cached
//! per-file results, a different key forces a fresh session. Keep the key sensitive to
//! anything that changes worker output, and insensitive to anything that does not
//! (rebuilding the app, `git checkout` touching mtimes, and so on).

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Python sources and lockfiles that determine worker behaviour, relative to the project cwd.
pub const CODE_FILES: &[&str] = &[
    "scripts/ml_engine.py",
    "scripts/score_completeness.py",
    "birdpipe/audio.py",
    "birdpipe/consolidate.py",
    "birdpipe/constants.py",
    "birdpipe/coords.py",
    "birdpipe/records.py",
    "birdpipe/stageb.py",
    "birdpipe/worker.py",
    "pyproject.toml",
    "uv.lock",
];

fn resolve(cwd: &Path, selected: &str) -> PathBuf {
    let raw = PathBuf::from(selected);
    if raw.is_absolute() { raw } else { cwd.join(raw) }
}

/// Identity of a large binary asset (model weights): path, size and mtime.
/// Hashing hundreds of megabytes on every session start is not worth it here.
pub fn model_identity(cwd: &Path, configured: Option<&str>, default_path: Option<&str>) -> Value {
    let selected = configured
        .filter(|value| !value.trim().is_empty())
        .or(default_path);
    let Some(selected) = selected else {
        return Value::Null;
    };
    let path = resolve(cwd, selected);
    let metadata = path.metadata().ok();
    let size_bytes = metadata.as_ref().map(std::fs::Metadata::len);
    let modified_ns = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string());
    json!({
        "path": path.to_string_lossy(),
        "size_bytes": size_bytes,
        "modified_ns": modified_ns,
    })
}

/// Identity of a source file: path plus a content hash, so touching the file
/// (checkout, copy, `uv sync`) does not invalidate cached results but editing it does.
pub fn code_identity(cwd: &Path, selected: &str) -> Value {
    let path = resolve(cwd, selected);
    let sha256 = std::fs::read(&path).ok().map(|bytes| {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    });
    json!({
        "path": path.to_string_lossy(),
        "sha256": sha256,
    })
}

/// Identities of every code file that influences worker output, plus any file paths
/// named in `worker_cmd` (e.g. a custom worker script).
pub fn code_identities(cwd: &Path, worker_cmd: &str) -> Value {
    let mut identities = Map::new();
    for relative in CODE_FILES {
        identities.insert((*relative).into(), code_identity(cwd, relative));
    }
    for (index, token) in worker_cmd.split_whitespace().enumerate() {
        if token.starts_with('-') {
            continue;
        }
        let resolved = resolve(cwd, token);
        if resolved.is_file() {
            identities.insert(format!("worker_arg_{index}"), code_identity(cwd, token));
        }
    }
    Value::Object(identities)
}

/// The parts of a `config_key` that actually change worker output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultsKey {
    /// Thresholds, species, frequency band, model weights.
    pub analysis: String,
    /// Content hashes of the worker code, or `None` for keys written by older builds that
    /// only recorded mtimes (which carry nothing we can trust across checkouts).
    pub code: Option<String>,
}

impl ResultsKey {
    /// Two keys are compatible when the analysis matches and the code either matches or
    /// is unknown on one side. Unknown-code sessions are legacy data we choose to trust
    /// rather than throw away.
    pub fn compatible(&self, other: &ResultsKey) -> bool {
        self.analysis == other.analysis
            && match (&self.code, &other.code) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            }
    }
}

/// Reduce a stored `config_key` to a [`ResultsKey`], so sessions written by older builds
/// (mtime-based code identities, the app binary in the key, a different cwd) can still be
/// resumed when the analysis itself is unchanged. Non-JSON keys (legacy/test values) are
/// used verbatim as the analysis key.
pub fn results_key(config_key: &str) -> ResultsKey {
    let Ok(Value::Object(full)) = serde_json::from_str::<Value>(config_key) else {
        return ResultsKey { analysis: config_key.to_string(), code: None };
    };
    let mut analysis = Map::new();
    for field in ["theta_a", "theta_b", "species_name", "f_min_hz", "f_max_hz", "model_identities"] {
        analysis.insert(field.into(), full.get(field).cloned().unwrap_or(Value::Null));
    }
    let mut code = Map::new();
    if let Some(Value::Object(entries)) = full.get("code_identities") {
        for (name, entry) in entries {
            if name == "application_binary" {
                continue;
            }
            if let Some(sha) = entry.get("sha256").and_then(Value::as_str) {
                code.insert(name.clone(), Value::String(sha.to_string()));
            }
        }
    }
    ResultsKey {
        analysis: Value::Object(analysis).to_string(),
        code: if code.is_empty() { None } else { Some(Value::Object(code).to_string()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("identity-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("scripts")).unwrap();
        dir
    }

    #[test]
    fn code_identity_ignores_mtime_but_tracks_content() {
        let dir = scratch("content");
        let file = dir.join("scripts/ml_engine.py");
        fs::write(&file, "print('v1')").unwrap();
        let first = code_identity(&dir, "scripts/ml_engine.py");

        // Rewrite identical bytes: mtime moves, hash must not.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&file, "print('v1')").unwrap();
        assert_eq!(first, code_identity(&dir, "scripts/ml_engine.py"));

        fs::write(&file, "print('v2')").unwrap();
        assert_ne!(first, code_identity(&dir, "scripts/ml_engine.py"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_identities_never_include_the_running_binary() {
        let dir = scratch("binary");
        let ids = code_identities(&dir, "uv run python scripts/ml_engine.py --worker");
        assert!(ids.get("application_binary").is_none());
        for name in CODE_FILES {
            assert!(ids.get(*name).is_some(), "missing {name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn results_key_ignores_binary_cwd_version_and_trusts_legacy_code_entries() {
        let old = json!({
            "schema": 1, "app_version": "0.1.0", "device": "mps", "cwd": "/old/checkout",
            "worker_cmd": "uv run python scripts/ml_engine.py --worker",
            "theta_a": 0.0, "theta_b": 0.530306, "species_name": "Hume's Leaf Warbler",
            "f_min_hz": null, "f_max_hz": null,
            "model_identities": {"localizer": {"path": "m.pt", "size_bytes": 1, "modified_ns": "1"}},
            "code_identities": {
                "application_binary": {"path": "/app", "size_bytes": 5, "modified_ns": "9"},
                "scripts/ml_engine.py": {"path": "/old/checkout/scripts/ml_engine.py", "size_bytes": 10, "modified_ns": "2"},
            },
        });
        let new = json!({
            "schema": 1, "app_version": "0.1.1", "device": "mps", "cwd": "/new/checkout",
            "worker_cmd": "uv run python scripts/ml_engine.py --worker",
            "theta_a": 0.0, "theta_b": 0.530306, "species_name": "Hume's Leaf Warbler",
            "f_min_hz": null, "f_max_hz": null,
            "model_identities": {"localizer": {"path": "m.pt", "size_bytes": 1, "modified_ns": "1"}},
            "code_identities": {
                "scripts/ml_engine.py": {"path": "/new/checkout/scripts/ml_engine.py", "sha256": "abc"},
            },
        });
        let old_key = results_key(&old.to_string());
        let new_key = results_key(&new.to_string());
        assert_eq!(old_key.code, None, "mtime-only entries carry no code identity");
        assert!(old_key.compatible(&new_key));

        let mut changed_theta = new.clone();
        changed_theta["theta_b"] = json!(0.6);
        assert!(!new_key.compatible(&results_key(&changed_theta.to_string())));

        let mut changed_code = new.clone();
        changed_code["code_identities"]["scripts/ml_engine.py"]["sha256"] = json!("def");
        assert!(!new_key.compatible(&results_key(&changed_code.to_string())));

        assert_eq!(results_key("test").analysis, "test");
        assert!(results_key("test").compatible(&results_key("test")));
        assert!(!results_key("test").compatible(&results_key("changed")));
    }

    #[test]
    fn worker_cmd_file_args_are_fingerprinted() {
        let dir = scratch("worker");
        fs::write(dir.join("scripts/custom.py"), "x").unwrap();
        let ids = code_identities(&dir, "python scripts/custom.py --worker");
        assert!(ids.get("worker_arg_1").is_some());
        assert!(ids.get("worker_arg_0").is_none(), "`python` is not a file in cwd");
        let _ = fs::remove_dir_all(&dir);
    }
}
