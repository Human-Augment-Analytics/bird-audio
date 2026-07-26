"""Turn a recorded session into an executable reproduction protocol.

A GUI run leaves its analytical outputs in a `batch.db`, but nothing in that database
tells a reviewer how to obtain them again from the original audio. This module reads a
session back out, pairs it with the run manifest from `birdpipe.provenance`, and emits
the ordered command sequence — preflight digest check, headless batch run, export, and
the downstream analyses — as a shell script and as JSON.

Journal requirement (Methods in Ecology and Evolution, Applications): a point-and-click
tool is reviewable only if it can export executable scripts that reproduce its outputs.
"""
from __future__ import annotations

import json
import shlex
import sqlite3
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from birdpipe.constants import StageBParams
from birdpipe.provenance import DEFAULT_MODEL_PATHS, build_manifest

PROTOCOL_SCHEMA_VERSION = 1

DEFAULT_OUT_DIR = "output/protocol"
DEFAULT_PYTHON_CMD: tuple[str, ...] = ("uv", "run", "python")

# Session columns that only exist in databases written by newer builds.
_MODEL_PATH_COLUMNS = {
    "localizer": ("localizer_path", "localizer", "model_localizer"),
    "classifier": ("classifier_path", "classifier", "model_classifier"),
}


@dataclass(frozen=True)
class InputFile:
    path: str
    status: str | None = None
    n_events: int = 0
    n_complete: int = 0
    n_retained: int = 0


@dataclass(frozen=True)
class SessionProtocol:
    """Everything recorded about a session that a rerun needs."""

    db_path: str
    session_id: int
    input_roots: list[str]
    output_dir: str
    device: str
    concurrency: int
    theta_a: float
    theta_b: float
    species_name: str | None = None
    model_paths: dict[str, str] = field(default_factory=dict)
    status: str | None = None
    created_at: str | None = None
    total_files: int | None = None
    files: list[InputFile] = field(default_factory=list)
    n_events: int = 0
    n_complete: int = 0
    n_retained: int = 0


@dataclass(frozen=True)
class ProtocolStep:
    name: str
    description: str
    command: list[str]
    optional: bool = False
    # Optional steps run only when this path exists, so a missing input skips the step
    # instead of aborting the script under `set -e`.
    guard_path: str | None = None
    stdout_path: str | None = None


@dataclass(frozen=True)
class Protocol:
    session: SessionProtocol
    manifest: dict[str, Any]
    steps: list[ProtocolStep]
    db_path: str
    out_dir: str
    rerun_db: str
    generated_at: str
    metadata: str | None = None
    include_analysis: bool = True
    schema_version: int = PROTOCOL_SCHEMA_VERSION


def _as_float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _as_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _parse_roots(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(r) for r in raw]
    text = str(raw)
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return [text] if text else []
    if isinstance(parsed, list):
        return [str(r) for r in parsed]
    return [str(parsed)]


def _event_totals(cur: sqlite3.Cursor, session_id: int) -> tuple[int, int, int]:
    queries = (
        "SELECT COUNT(*) AS n_events,"
        " SUM(CASE WHEN completeness_label = 'complete' THEN 1 ELSE 0 END) AS n_complete,"
        " SUM(CASE WHEN retained = 1 THEN 1 ELSE 0 END) AS n_retained"
        " FROM events WHERE session_id = ?",
        "SELECT COUNT(*) AS n_events, 0 AS n_complete, 0 AS n_retained"
        " FROM events WHERE session_id = ?",
    )
    for sql in queries:
        try:
            row = cur.execute(sql, (session_id,)).fetchone()
        except sqlite3.Error:
            continue
        if row is None:
            return (0, 0, 0)
        return (
            _as_int(row["n_events"], 0),
            _as_int(row["n_complete"], 0),
            _as_int(row["n_retained"], 0),
        )
    return (0, 0, 0)


def _read_files(cur: sqlite3.Cursor, session_id: int) -> list[InputFile]:
    try:
        rows = cur.execute(
            "SELECT * FROM files WHERE session_id = ? ORDER BY id", (session_id,)
        ).fetchall()
    except sqlite3.Error:
        return []
    out = []
    for row in rows:
        rec = dict(row)
        out.append(
            InputFile(
                path=str(rec.get("path", "")),
                status=rec.get("status"),
                n_events=_as_int(rec.get("n_events"), 0),
                n_complete=_as_int(rec.get("n_complete"), 0),
                n_retained=_as_int(rec.get("n_retained"), 0),
            )
        )
    return out


def read_session_protocol(
    db_path: str | Path, session_id: int | None = None
) -> SessionProtocol | None:
    """Reads a session's rerun configuration; None when the DB or session is absent.

    Columns are read by name because `sessions` has gained columns over time and older
    databases must still yield a protocol.
    """
    if not Path(db_path).exists():
        return None
    conn = None
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
        rec = dict(row)
        sid = _as_int(rec.get("id"), session_id if session_id is not None else 0)

        model_paths = {}
        for role, candidates in _MODEL_PATH_COLUMNS.items():
            for column in candidates:
                value = rec.get(column)
                if value:
                    model_paths[role] = str(value)
                    break

        n_events, n_complete, n_retained = _event_totals(cur, sid)
        return SessionProtocol(
            db_path=str(db_path),
            session_id=sid,
            input_roots=_parse_roots(rec.get("input_roots")),
            output_dir=str(rec.get("output_dir") or ""),
            device=str(rec.get("device") or "cpu"),
            concurrency=_as_int(rec.get("concurrency"), 0),
            theta_a=_as_float(rec.get("theta_a"), 0.0),
            theta_b=_as_float(rec.get("theta_b"), StageBParams().theta_b),
            species_name=rec.get("species_name"),
            model_paths=model_paths,
            status=rec.get("status"),
            created_at=rec.get("created_at"),
            total_files=rec.get("total_files"),
            files=_read_files(cur, sid),
            n_events=n_events,
            n_complete=n_complete,
            n_retained=n_retained,
        )
    except sqlite3.Error:
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass


def _batch_command(
    root: str, rerun_db: str, session: SessionProtocol, export: tuple[str, str] | None
) -> list[str]:
    cmd = [
        "cargo", "run", "-p", "batch-core", "--bin", "batch", "--",
        "--input", root,
        "--db", rerun_db,
        "--device", session.device,
        "--theta-a", repr(session.theta_a),
        "--theta-b", repr(session.theta_b),
    ]
    if session.concurrency > 0:
        cmd += ["--concurrency", str(session.concurrency)]
    if export is not None:
        cmd += ["--export-csv", export[0], "--export-telemetry", export[1]]
    return cmd


def build_protocol(
    db_path: str | Path,
    session_id: int | None = None,
    include_analysis: bool = True,
    out_dir: str | Path = DEFAULT_OUT_DIR,
    metadata: str | Path | None = None,
    model_paths: dict[str, str | Path] | None = None,
    rerun_db: str | Path | None = None,
    generated_at: str | None = None,
    python_cmd: Sequence[str] = DEFAULT_PYTHON_CMD,
) -> Protocol:
    """Session + provenance manifest + the ordered commands that reproduce the session.

    Raises ValueError when the session cannot be read: a protocol that invents a
    configuration would be a false reproducibility claim.
    """
    session = read_session_protocol(db_path, session_id)
    if session is None:
        raise ValueError(f"no session found in {db_path} (session_id={session_id})")

    resolved_models: dict[str, str | Path] = dict(DEFAULT_MODEL_PATHS)
    resolved_models.update(session.model_paths)
    if model_paths:
        resolved_models.update(model_paths)

    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    manifest = build_manifest(
        db_path=db_path,
        session_id=session.session_id,
        model_paths=resolved_models,
        generated_at=generated_at,
    )

    out = str(out_dir).rstrip("/") or "."
    rerun = str(rerun_db) if rerun_db is not None else f"{out}/reproduce.db"
    reference_manifest = f"{out}/manifest.json"
    rerun_manifest = f"{out}/rerun_manifest.json"
    events_csv = f"{out}/events.csv"
    telemetry_csv = f"{out}/telemetry.csv"
    py = list(python_cmd)

    steps: list[ProtocolStep] = [
        ProtocolStep(
            name="preflight-manifest",
            description="Recompute model digests, paper constants and environment here",
            command=[
                *py, "scripts/run_manifest.py",
                "--db", str(db_path),
                "--session-id", str(session.session_id),
                "--out", rerun_manifest,
            ],
        ),
        ProtocolStep(
            name="preflight-compare",
            description="Stop unless model weights and constants match the recorded run",
            command=[*py, "scripts/run_manifest.py", "--compare", reference_manifest, rerun_manifest],
            optional=True,
            guard_path=reference_manifest,
        ),
    ]

    roots = session.input_roots
    for index, root in enumerate(roots):
        suffix = f"-{index + 1}" if len(roots) > 1 else ""
        steps.append(
            ProtocolStep(
                name=f"batch-run{suffix}",
                description=f"Re-run the pipeline over {root} at the recorded thresholds",
                command=_batch_command(root, rerun, session, export=None),
            )
        )

    if roots:
        steps.append(
            ProtocolStep(
                name="export",
                description=(
                    "Resume the completed session and write the event and telemetry CSVs "
                    "(JSON export is GUI-only; batch-core's CLI emits CSV)"
                ),
                command=_batch_command(roots[0], rerun, session, export=(events_csv, telemetry_csv)),
            )
        )

    if include_analysis:
        eco_cmd = [
            *py, "scripts/ecological_analysis.py",
            "--db", rerun,
            "--theta-a", repr(session.theta_a),
            "--theta-b", repr(session.theta_b),
            "--out", f"{out}/ecology",
        ]
        sens_cmd = [
            *py, "scripts/threshold_sensitivity.py",
            "--db", rerun,
            "--out", f"{out}/ecology/sensitivity",
        ]
        if metadata is not None:
            eco_cmd += ["--metadata", str(metadata)]
            sens_cmd += ["--metadata", str(metadata)]

        steps += [
            ProtocolStep(
                name="ecological-analysis",
                description="Effort-normalised summaries and the two manuscript predictions",
                command=eco_cmd,
                optional=True,
                guard_path=rerun,
            ),
            ProtocolStep(
                name="threshold-sensitivity",
                description="Sweep theta_A x theta_B and check the verdicts survive the choice",
                command=sens_cmd,
                optional=True,
                guard_path=rerun,
            ),
            ProtocolStep(
                name="verification-plan",
                description="Precision interval and the next manual-verification queue",
                command=[
                    *py, "scripts/verification_planner.py",
                    "--db", rerun,
                    "--threshold", repr(session.theta_a),
                    "--theta-b", repr(session.theta_b),
                    "--json",
                ],
                optional=True,
                guard_path=rerun,
                stdout_path=f"{out}/verification_plan.json",
            ),
        ]

    return Protocol(
        session=session,
        manifest=manifest,
        steps=steps,
        db_path=str(db_path),
        out_dir=out,
        rerun_db=rerun,
        generated_at=generated_at,
        metadata=str(metadata) if metadata is not None else None,
        include_analysis=include_analysis,
    )


def _render_command(step: ProtocolStep) -> str:
    line = " ".join(shlex.quote(part) for part in step.command)
    if step.stdout_path:
        line += f" > {shlex.quote(step.stdout_path)}"
    return line


def render_shell_script(protocol: Protocol) -> str:
    """A self-contained script that reproduces the session's outputs from the audio."""
    git = protocol.manifest.get("git") or {}
    commit = git.get("commit") or "unknown"
    dirty = " (working tree dirty at generation time)" if git.get("dirty") else ""
    session = protocol.session
    total = len(protocol.steps)

    lines = [
        "#!/usr/bin/env bash",
        "# Reproduction protocol generated by birdpipe.protocol.",
        "#",
        f"#   source database: {protocol.db_path}",
        f"#   session id:      {session.session_id}",
        f"#   generated at:    {protocol.generated_at}",
        f"#   git commit:      {commit}{dirty}",
        f"#   thresholds:      theta_a={session.theta_a!r} theta_b={session.theta_b!r}",
        f"#   device:          {session.device}",
        f"#   recorded totals: {len(session.files)} files, {session.n_events} events, "
        f"{session.n_retained} retained",
        "#",
        "# Run from the repository root. The rerun writes to a fresh database",
        f"# ({protocol.rerun_db}) and never modifies the source database.",
        "",
        "set -euo pipefail",
        "",
        'if [ ! -f pyproject.toml ] || [ ! -d batch-core ]; then',
        '  echo "error: run this script from the repository root" >&2',
        "  exit 1",
        "fi",
        "",
        f"mkdir -p {shlex.quote(protocol.out_dir)}",
        "",
    ]

    for index, step in enumerate(protocol.steps, start=1):
        header = f"[{index}/{total}] {step.name}: {step.description}"
        command = _render_command(step)
        if step.optional and step.guard_path:
            guard = shlex.quote(step.guard_path)
            lines += [
                f"if [ -e {guard} ]; then",
                f"  echo {shlex.quote('=== ' + header)}",
                f"  {command}",
                "else",
                f"  echo {shlex.quote('=== skip [' + str(index) + '/' + str(total) + '] ' + step.name + ': missing ' + step.guard_path)} >&2",
                "fi",
                "",
            ]
        elif step.optional:
            lines += [
                f"echo {shlex.quote('=== ' + header)}",
                f"{command} || echo {shlex.quote('warning: optional step ' + step.name + ' failed')} >&2",
                "",
            ]
        else:
            lines += [
                f"echo {shlex.quote('=== ' + header)}",
                command,
                "",
            ]

    lines += [
        f"echo {shlex.quote('=== done; outputs under ' + protocol.out_dir)}",
        "",
    ]
    return "\n".join(lines)


def render_manifest_json(protocol: Protocol) -> str:
    """The machine-readable twin of the script, for archiving beside it."""
    payload = {
        "schema_version": protocol.schema_version,
        "generated_at": protocol.generated_at,
        "db_path": protocol.db_path,
        "out_dir": protocol.out_dir,
        "rerun_db": protocol.rerun_db,
        "metadata": protocol.metadata,
        "include_analysis": protocol.include_analysis,
        "session": asdict(protocol.session),
        "manifest": protocol.manifest,
        "steps": [asdict(step) for step in protocol.steps],
        "warnings": verify_protocol(protocol),
    }
    return json.dumps(payload, indent=2, sort_keys=True, default=str)


def verify_protocol(protocol: Protocol) -> list[str]:
    """Human-readable reasons the protocol may not reproduce as written."""
    warnings: list[str] = []
    session = protocol.session

    for role, info in (protocol.manifest.get("models") or {}).items():
        if not isinstance(info, dict) or info.get("sha256") is None:
            path = info.get("path") if isinstance(info, dict) else "?"
            warnings.append(
                f"model weights missing for {role} ({path}): digests cannot be verified"
            )

    for root in session.input_roots:
        if not Path(root).exists():
            warnings.append(f"input root no longer exists: {root}")
    if not session.input_roots:
        warnings.append("session recorded no input roots: the rerun command cannot be built")
    elif len(session.input_roots) > 1:
        warnings.append(
            "session used multiple input roots; the batch CLI takes one --input per run, "
            "so the export step covers only the first root"
        )

    if session.output_dir and not Path(session.output_dir).exists():
        warnings.append(f"recorded output directory is absent: {session.output_dir}")

    git = protocol.manifest.get("git") or {}
    if git.get("dirty"):
        warnings.append(
            f"git tree was dirty at commit {git.get('commit')}: the script's code state is "
            "not fully described by that commit"
        )
    if git.get("commit") is None:
        warnings.append("git commit unavailable: the code state cannot be pinned")

    missing_files = [f.path for f in session.files if f.path and not Path(f.path).exists()]
    if missing_files:
        shown = ", ".join(missing_files[:3])
        more = f" (+{len(missing_files) - 3} more)" if len(missing_files) > 3 else ""
        warnings.append(f"{len(missing_files)} recorded input file(s) missing: {shown}{more}")

    return warnings
