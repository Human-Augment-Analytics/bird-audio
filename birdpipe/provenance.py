"""Run provenance: pin every fixed processing choice a run depended on.

The pipeline's behaviour is determined by model weights, the Table A.6/A.8 constants,
and the post-hoc thresholds. None of those are recoverable from an export alone, so a
rerun cannot be shown to be the same analysis. This module captures them as a manifest
and can diff two manifests to say exactly what changed.
"""
from __future__ import annotations

import hashlib
import json
import platform
import sqlite3
import subprocess
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from birdpipe import constants as C

MANIFEST_SCHEMA_VERSION = 1

_REPO_ROOT = Path(__file__).resolve().parent.parent

# Packages whose version changes can move detector outputs.
_TRACKED_PACKAGES = ("torch", "ultralytics", "librosa", "numpy", "scipy", "opencv-python")


def sha256_file(path: str | Path, chunk_size: int = 1 << 20) -> str | None:
    """Returns None when the file is absent so a manifest can still be written."""
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(chunk_size), b""):
                digest.update(block)
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return None
    return digest.hexdigest()


def _flatten(prefix: str, value: Any, out: dict[str, Any]) -> None:
    if is_dataclass(value) and not isinstance(value, type):
        for key, inner in asdict(value).items():
            _flatten(f"{prefix}.{key}" if prefix else key, inner, out)
    elif isinstance(value, dict):
        for key, inner in value.items():
            _flatten(f"{prefix}.{key}" if prefix else str(key), inner, out)
    else:
        out[prefix] = value


def constants_snapshot() -> dict[str, Any]:
    """Every paper-pinned constant, flattened to dotted keys for diffing."""
    out: dict[str, Any] = {}
    for name in dir(C):
        if name.startswith("_"):
            continue
        value = getattr(C, name)
        if isinstance(value, (int, float, str, bool)):
            out[name] = value
    for name, obj in (
        ("consolidation", C.ConsolidationParams()),
        ("stage_b", C.StageBParams()),
        ("export", C.ExportParams()),
    ):
        _flatten(name, obj, out)
    return out


def _package_version(name: str) -> str | None:
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:
        return None
    try:
        return version(name)
    except PackageNotFoundError:
        return None
    except Exception:
        return None


def environment_snapshot() -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": {name: _package_version(name) for name in _TRACKED_PACKAGES},
    }


def git_snapshot(repo_root: Path | None = None) -> dict[str, Any]:
    root = repo_root or _REPO_ROOT

    def run(args: list[str]) -> str | None:
        try:
            result = subprocess.run(
                args, cwd=root, capture_output=True, text=True, timeout=10, check=False
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout.strip() if result.returncode == 0 else None

    commit = run(["git", "rev-parse", "HEAD"])
    status = run(["git", "status", "--porcelain"])
    return {
        "commit": commit,
        "branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
        "dirty": bool(status) if status is not None else None,
    }


def model_snapshot(model_paths: dict[str, str | Path]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for role, path in model_paths.items():
        resolved = Path(path)
        if not resolved.is_absolute():
            resolved = _REPO_ROOT / resolved
        out[role] = {
            "path": str(path),
            "sha256": sha256_file(resolved),
            "bytes": resolved.stat().st_size if resolved.exists() else None,
        }
    return out


def session_snapshot(db_path: str | Path, session_id: int | None = None) -> dict[str, Any] | None:
    """Reads the recorded session config; returns None if unavailable."""
    if not Path(db_path).exists():
        return None
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        if session_id is None:
            row = cur.execute("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").fetchone()
        else:
            row = cur.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        session = dict(row)
        counts = cur.execute(
            "SELECT COUNT(*) AS n_events,"
            " SUM(CASE WHEN retained = 1 THEN 1 ELSE 0 END) AS n_retained"
            " FROM events WHERE session_id = ?",
            (session["id"],),
        ).fetchone()
        session["n_events"] = counts["n_events"]
        session["n_retained"] = counts["n_retained"]
        return session
    except sqlite3.Error:
        return None
    finally:
        try:
            conn.close()
        except (NameError, sqlite3.Error):
            pass


DEFAULT_MODEL_PATHS = {
    "localizer": "models/buzz_localizer.pt",
    "classifier": "models/classifier.pt",
}


def build_manifest(
    db_path: str | Path | None = None,
    session_id: int | None = None,
    model_paths: dict[str, str | Path] | None = None,
    generated_at: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "git": git_snapshot(),
        "environment": environment_snapshot(),
        "models": model_snapshot(model_paths or DEFAULT_MODEL_PATHS),
        "constants": constants_snapshot(),
    }
    if db_path is not None:
        manifest["session"] = session_snapshot(db_path, session_id)
    if extra:
        manifest["extra"] = extra
    return manifest


def write_manifest(path: str | Path, manifest: dict[str, Any]) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str))
    return target


def read_manifest(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


# Fields that legitimately differ between two runs of the same analysis.
_VOLATILE_KEYS = frozenset({"generated_at", "session.started_at", "session.finished_at"})

# Sections that describe a run without determining its behaviour. A manifest captured
# by the worker has no session block at all, so comparing these field-by-field buries
# the sections that matter under noise.
_NON_DETERMINING_PREFIXES = ("session.", "extra.")


def _flatten_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    _flatten("", manifest, out)
    return out


def diff_manifests(
    a: dict[str, Any], b: dict[str, Any], ignore_volatile: bool = True
) -> list[dict[str, Any]]:
    """Field-level differences, most reproducibility-relevant sections first."""
    flat_a = _flatten_manifest(a)
    flat_b = _flatten_manifest(b)
    keys = sorted(set(flat_a) | set(flat_b))

    def section_rank(key: str) -> int:
        for rank, prefix in enumerate(("models", "constants", "environment", "git", "session")):
            if key.startswith(prefix):
                return rank
        return 99

    diffs = []
    for key in keys:
        if ignore_volatile and (
            key in _VOLATILE_KEYS or key.startswith(_NON_DETERMINING_PREFIXES)
        ):
            continue
        left, right = flat_a.get(key), flat_b.get(key)
        if left != right:
            diffs.append({"field": key, "left": left, "right": right})
    diffs.sort(key=lambda d: (section_rank(d["field"]), d["field"]))
    return diffs


def is_reproducible(diffs: list[dict[str, Any]]) -> bool:
    """A rerun reproduces the analysis only if weights and constants are identical."""
    return not any(
        d["field"].startswith("models") or d["field"].startswith("constants") for d in diffs
    )
