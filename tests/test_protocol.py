from __future__ import annotations

import json
import shlex
import sqlite3

import pytest

from birdpipe import protocol as P

_OLD_SCHEMA = """
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  created_at TEXT,
  input_roots TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  device TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  theta_a REAL NOT NULL,
  theta_b REAL NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY, session_id INTEGER, path TEXT, status TEXT,
  n_events INTEGER DEFAULT 0, n_complete INTEGER DEFAULT 0, n_retained INTEGER DEFAULT 0
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, session_id INTEGER, file_id INTEGER,
  completeness_label TEXT, retained INTEGER
);
"""

_NEW_COLUMNS = "ALTER TABLE sessions ADD COLUMN species_name TEXT DEFAULT 'Hume''s Leaf Warbler';"


def make_db(tmp_path, roots, *, device="mps", theta_a=0.0, theta_b=0.530306,
            output_dir=None, new_schema=True, concurrency=1, name="batch.db"):
    db = tmp_path / name
    output_dir = str(output_dir if output_dir is not None else tmp_path)
    conn = sqlite3.connect(db)
    conn.executescript(_OLD_SCHEMA)
    if new_schema:
        conn.executescript(_NEW_COLUMNS)
    conn.execute(
        "INSERT INTO sessions (id, created_at, input_roots, output_dir, device, concurrency,"
        " theta_a, theta_b, total_files, status)"
        " VALUES (1, '2026-07-01 00:00:00', ?, ?, ?, ?, ?, ?, 2, 'done')",
        (json.dumps(roots), output_dir, device, concurrency, theta_a, theta_b),
    )
    conn.executemany(
        "INSERT INTO files (session_id, path, status, n_events, n_complete, n_retained)"
        " VALUES (1, ?, 'done', 2, 1, 1)",
        [(f"{roots[0]}/a.WAV",), (f"{roots[0]}/b.WAV",)],
    )
    conn.executemany(
        "INSERT INTO events (session_id, file_id, completeness_label, retained) VALUES (1, 1, ?, ?)",
        [("complete", 1), ("complete", 1), ("incomplete", 0)],
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def audio_root(tmp_path):
    root = tmp_path / "audio"
    root.mkdir()
    return root


def build(tmp_path, db, **kwargs):
    kwargs.setdefault("out_dir", str(tmp_path / "out"))
    kwargs.setdefault("generated_at", "2026-07-26T00:00:00+00:00")
    return P.build_protocol(db, **kwargs)


def flat(steps):
    return [part for step in steps for part in step.command]


def test_read_session_missing_db_returns_none(tmp_path):
    assert P.read_session_protocol(tmp_path / "absent.db") is None


def test_read_session_missing_session_returns_none(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    assert P.read_session_protocol(db, session_id=99) is None


def test_read_session_reads_config_and_counts(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)], device="mps", theta_b=0.530306)
    session = P.read_session_protocol(db, session_id=1)
    assert session.device == "mps"
    assert session.theta_a == 0.0
    assert session.theta_b == 0.530306
    assert session.input_roots == [str(audio_root)]
    assert [f.path for f in session.files] == [f"{audio_root}/a.WAV", f"{audio_root}/b.WAV"]
    assert (session.n_events, session.n_complete, session.n_retained) == (3, 2, 2)


def test_read_session_tolerates_old_schema_without_new_columns(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)], new_schema=False)
    with sqlite3.connect(db) as conn:
        columns = [r[1] for r in conn.execute("PRAGMA table_info(sessions)")]
    assert "species_name" not in columns

    session = P.read_session_protocol(db)
    assert session is not None
    assert session.species_name is None
    assert session.model_paths == {}
    assert session.theta_b == 0.530306


def test_read_session_defaults_to_most_recent(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO sessions (id, input_roots, output_dir, device, concurrency,"
            " theta_a, theta_b) VALUES (7, ?, 'out', 'cpu', 4, 0.25, 0.6)",
            (json.dumps([str(audio_root)]),),
        )
    session = P.read_session_protocol(db)
    assert session.session_id == 7
    assert session.device == "cpu"


def test_build_protocol_raises_for_absent_session(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    with pytest.raises(ValueError):
        build(tmp_path, db, session_id=42)


def test_thetas_and_device_reach_the_batch_command(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)], device="cuda", theta_a=0.25, theta_b=0.61)
    proto = build(tmp_path, db)
    run_step = next(s for s in proto.steps if s.name == "batch-run")
    assert run_step.command[:7] == ["cargo", "run", "-p", "batch-core", "--bin", "batch", "--"]
    for flag, value in (("--device", "cuda"), ("--theta-a", "0.25"), ("--theta-b", "0.61"),
                        ("--input", str(audio_root))):
        assert run_step.command[run_step.command.index(flag) + 1] == value


def test_quoting_survives_spaces_and_quotes(tmp_path):
    root = tmp_path / "field data" / "o'brien site"
    root.mkdir(parents=True)
    db = make_db(tmp_path, [str(root)])
    proto = build(tmp_path, db)
    script = P.render_shell_script(proto)

    run_line = next(line for line in script.splitlines() if line.startswith("cargo run"))
    argv = shlex.split(run_line)
    assert argv[argv.index("--input") + 1] == str(root)

    # Every step's argv must appear in the script in a form that splits back to itself.
    for step in proto.steps:
        rendered = " ".join(shlex.quote(part) for part in step.command)
        assert rendered in script
        assert shlex.split(rendered) == step.command


def test_script_has_shebang_and_strict_mode(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    script = P.render_shell_script(build(tmp_path, db))
    assert script.startswith("#!")
    assert "set -euo pipefail" in script
    assert "session id:      1" in script


def test_script_header_names_source_db_and_commit(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    script = P.render_shell_script(proto)
    assert str(db) in script
    assert proto.generated_at in script
    commit = (proto.manifest.get("git") or {}).get("commit") or "unknown"
    assert commit in script


def test_optional_steps_are_guarded_not_fatal(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    script = P.render_shell_script(proto)
    optional = [s for s in proto.steps if s.optional]
    assert optional
    for step in optional:
        assert step.guard_path is not None
        assert f"if [ -e {shlex.quote(step.guard_path)} ]; then" in script
    assert "skip [" in script


def test_every_step_is_announced(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    script = P.render_shell_script(proto)
    for index, step in enumerate(proto.steps, start=1):
        assert f"[{index}/{len(proto.steps)}] {step.name}" in script


def test_analysis_steps_toggle(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    analysis = {"ecological-analysis", "threshold-sensitivity", "verification-plan"}

    with_analysis = {s.name for s in build(tmp_path, db, include_analysis=True).steps}
    without = {s.name for s in build(tmp_path, db, include_analysis=False).steps}

    assert analysis <= with_analysis
    assert analysis.isdisjoint(without)
    assert {"preflight-manifest", "preflight-compare", "batch-run", "export"} <= without


def test_metadata_argument_only_when_supplied(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    assert "--metadata" not in flat(build(tmp_path, db).steps)

    proto = build(tmp_path, db, metadata="deployments.csv")
    eco = next(s for s in proto.steps if s.name == "ecological-analysis")
    assert eco.command[eco.command.index("--metadata") + 1] == "deployments.csv"
    sens = next(s for s in proto.steps if s.name == "threshold-sensitivity")
    assert "deployments.csv" in sens.command


def test_preflight_compares_manifests(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    compare = next(s for s in proto.steps if s.name == "preflight-compare")
    assert "scripts/run_manifest.py" in compare.command
    assert "--compare" in compare.command
    assert proto.steps[0].name == "preflight-manifest"


def test_rerun_does_not_write_the_source_database(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    run_step = next(s for s in proto.steps if s.name == "batch-run")
    assert run_step.command[run_step.command.index("--db") + 1] == proto.rerun_db
    assert proto.rerun_db != str(db)


def test_verify_protocol_warns_about_missing_model(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db, model_paths={"localizer": str(tmp_path / "absent.pt")})
    warnings = P.verify_protocol(proto)
    assert any("localizer" in w and "missing" in w for w in warnings)


def test_verify_protocol_warns_about_missing_input_root(tmp_path):
    root = tmp_path / "gone"
    db = make_db(tmp_path, [str(root)])
    warnings = P.verify_protocol(build(tmp_path, db))
    assert any("input root no longer exists" in w and str(root) in w for w in warnings)


def test_verify_protocol_warns_about_absent_output_dir(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)], output_dir=str(tmp_path / "vanished"))
    warnings = P.verify_protocol(build(tmp_path, db))
    assert any("output directory is absent" in w for w in warnings)


def test_verify_protocol_warns_about_dirty_tree(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    proto.manifest["git"] = {"commit": "abc123", "branch": "main", "dirty": True}
    assert any("dirty" in w for w in P.verify_protocol(proto))


def test_render_manifest_json_roundtrips(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    payload = json.loads(P.render_manifest_json(proto))
    assert "manifest" in payload and "steps" in payload
    assert payload["manifest"]["constants"]["stage_b.theta_b"] == 0.530306
    assert [s["name"] for s in payload["steps"]] == [s.name for s in proto.steps]
    assert payload["steps"][0]["command"] == proto.steps[0].command
    assert payload["session"]["theta_b"] == 0.530306


def test_cli_writes_script_and_protocol(tmp_path, audio_root, capsys):
    import scripts.export_protocol as cli

    db = make_db(tmp_path, [str(audio_root)])
    out = tmp_path / "protocol_out"
    assert cli.main(["--db", str(db), "--out", str(out)]) == 0

    script = out / "reproduce.sh"
    assert script.read_text().startswith("#!")
    assert script.stat().st_mode & 0o111
    assert json.loads((out / "protocol.json").read_text())["steps"]
    assert json.loads((out / "manifest.json").read_text())["models"]
    assert "batch-run" in capsys.readouterr().out


def test_cli_json_stdout_is_machine_readable(tmp_path, audio_root, capsys):
    import scripts.export_protocol as cli

    db = make_db(tmp_path, [str(audio_root)])
    out = tmp_path / "protocol_out"
    assert cli.main(["--db", str(db), "--out", str(out), "--json", "--no-analysis"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["session_id"] == 1
    assert all("ecolog" not in s["name"] for s in payload["steps"])


def test_cli_missing_session_exits_nonzero(tmp_path, audio_root, capsys):
    import scripts.export_protocol as cli

    db = make_db(tmp_path, [str(audio_root)])
    assert cli.main(["--db", str(db), "--out", str(tmp_path / "o"), "--session-id", "99"]) == 2


# --- reproduction-fidelity warning ------------------------------------------

def test_session_without_recorded_manifest_warns_about_fidelity(tmp_path, audio_root):
    """The retrospective manifest cannot prove the original run used today's code."""
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    assert proto.session.recorded_manifest is None
    warnings = P.verify_protocol(proto)
    assert any("stored no run manifest" in w for w in warnings)
    assert any("different pipeline version" in w for w in warnings)


def test_recorded_manifest_is_read_when_present(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE sessions ADD COLUMN run_manifest TEXT")
    conn.execute(
        "UPDATE sessions SET run_manifest = ? WHERE id = 1",
        (json.dumps({"constants": {"stage_b.theta_b": 0.530306}}),),
    )
    conn.commit()
    conn.close()

    proto = build(tmp_path, db)
    assert proto.session.recorded_manifest == {"constants": {"stage_b.theta_b": 0.530306}}
    assert not any("stored no run manifest" in w for w in P.verify_protocol(proto))


def test_unparseable_recorded_manifest_is_treated_as_absent(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE sessions ADD COLUMN run_manifest TEXT")
    conn.execute("UPDATE sessions SET run_manifest = 'not json' WHERE id = 1")
    conn.commit()
    conn.close()

    assert build(tmp_path, db).session.recorded_manifest is None


def test_reference_manifest_prefers_the_recorded_one(tmp_path, audio_root):
    """Only a run-time manifest can detect that the original used different code."""
    db = make_db(tmp_path, [str(audio_root)])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE sessions ADD COLUMN run_manifest TEXT")
    recorded = {"models": {"localizer": {"sha256": "recorded"}}, "constants": {"x": 1}}
    conn.execute("UPDATE sessions SET run_manifest = ? WHERE id = 1", (json.dumps(recorded),))
    conn.commit()
    conn.close()

    proto = build(tmp_path, db)
    assert proto.reference_is_recorded is True
    assert proto.reference_manifest == recorded
    assert proto.reference_manifest != proto.manifest


def test_reference_manifest_falls_back_to_the_rebuilt_one(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    proto = build(tmp_path, db)
    assert proto.reference_is_recorded is False
    assert proto.reference_manifest is proto.manifest


def test_manifest_json_records_which_baseline_was_used(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    payload = json.loads(P.render_manifest_json(build(tmp_path, db)))
    assert payload["reference_manifest_source"] == "rebuilt_at_export_time"


def test_compare_step_says_when_the_baseline_cannot_detect_code_drift(tmp_path, audio_root):
    db = make_db(tmp_path, [str(audio_root)])
    step = next(s for s in build(tmp_path, db).steps if s.name == "preflight-compare")
    assert "CANNOT detect" in step.description
