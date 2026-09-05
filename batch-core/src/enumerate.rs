//! Recursively enumerate audio files under one or more roots.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

const AUDIO_EXTS: &[&str] = &["wav", "flac", "mp3"];

fn is_audio(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => AUDIO_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// Walk each root recursively, keep audio files, dedupe by canonical path, sorted.
/// Any traversal error aborts the scan so a partial result can never be mistaken
/// for a complete inventory and used to prune durable cache rows.
pub fn enumerate_audio(roots: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root) {
            let entry = entry.map_err(|error| {
                format!("failed to scan audio root {}: {error}", root.display())
            })?;
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if !is_audio(p) {
                continue;
            }
            let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            if seen.insert(canon.clone()) {
                out.push(canon);
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn finds_audio_recursively_and_filters_extensions() {
        let tmp = std::env::temp_dir().join(format!("bc_enum_{}", std::process::id()));
        let sub = tmp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        touch(&tmp, "a.WAV"); // uppercase ext counts
        touch(&tmp, "b.wav");
        touch(&tmp, "notes.txt"); // ignored
        touch(&sub, "c.flac"); // nested
        let found = enumerate_audio(&[tmp.clone()]).unwrap();
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"a.WAV".to_string()));
        assert!(names.contains(&"b.wav".to_string()));
        assert!(names.contains(&"c.flac".to_string()));
        assert!(!names.iter().any(|n| n == "notes.txt"));
        assert_eq!(found.len(), 3);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn dedupes_repeated_roots() {
        let tmp = std::env::temp_dir().join(format!("bc_enum_dup_{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        touch(&tmp, "a.wav");
        let found = enumerate_audio(&[tmp.clone(), tmp.clone()]).unwrap();
        assert_eq!(found.len(), 1);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_complete_scan() {
        let missing = std::env::temp_dir().join(format!(
            "bc_enum_missing_{}_{}",
            std::process::id(),
            crate::store::DEFAULT_IDLE_CUTOFF_MS,
        ));
        assert!(enumerate_audio(&[missing]).is_err());
    }
}
