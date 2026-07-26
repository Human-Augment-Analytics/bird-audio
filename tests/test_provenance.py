from __future__ import annotations

import copy
import json
import sqlite3

from birdpipe import constants as C
from birdpipe import provenance


def _manifest(**overrides):
    m = {
        "schema_version": 1,
        "generated_at": "2026-07-26T00:00:00+00:00",
        "git": {"commit": "abc123", "branch": "main", "dirty": False},
        "environment": {"python": "3.12.0", "packages": {"torch": "2.5.0"}},
        "models": {"localizer": {"path": "models/buzz_localizer.pt", "sha256": "aa", "bytes": 10}},
        "constants": {"stage_b.theta_b": 0.530306},
    }
    m.update(overrides)
    return m


def test_sha256_file_matches_hashlib(tmp_path):
    import hashlib

    target = tmp_path / "blob.bin"
    payload = b"buzz" * 5000
    target.write_bytes(payload)
    assert provenance.sha256_file(target) == hashlib.sha256(payload).hexdigest()


def test_sha256_file_missing_returns_none(tmp_path):
    assert provenance.sha256_file(tmp_path / "absent.pt") is None


def test_constants_snapshot_pins_paper_values():
    snap = provenance.constants_snapshot()
    assert snap["SAMPLE_RATE"] == C.SAMPLE_RATE
    assert snap["FREQ_BIN_LOW"] == C.FREQ_BIN_LOW
    assert snap["stage_b.theta_b"] == C.StageBParams().theta_b
    assert snap["consolidation.affinity.iou2d"] == C.AffinityWeights().iou2d
    assert snap["consolidation.absorption.area"] == C.AbsorptionWeights().area


def test_model_snapshot_reports_missing_without_raising(tmp_path):
    snap = provenance.model_snapshot({"localizer": tmp_path / "nope.pt"})
    assert snap["localizer"]["sha256"] is None
    assert snap["localizer"]["bytes"] is None


def test_session_snapshot_reads_config_and_counts(tmp_path):
    db = tmp_path / "batch.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, theta_a REAL, theta_b REAL, device TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY, session_id INTEGER, retained INTEGER);
        INSERT INTO sessions (id, theta_a, theta_b, device) VALUES (1, 0.0, 0.530306, 'mps');
        INSERT INTO events (session_id, retained) VALUES (1, 1), (1, 1), (1, 0);
        """
    )
    conn.commit()
    conn.close()

    snap = provenance.session_snapshot(db, session_id=1)
    assert snap["theta_b"] == 0.530306
    assert snap["device"] == "mps"
    assert snap["n_events"] == 3
    assert snap["n_retained"] == 2


def test_session_snapshot_missing_db_returns_none(tmp_path):
    assert provenance.session_snapshot(tmp_path / "absent.db") is None


def test_diff_identical_manifests_is_empty():
    a = _manifest()
    assert provenance.diff_manifests(a, copy.deepcopy(a)) == []


def test_diff_ignores_generated_at_by_default():
    a = _manifest()
    b = _manifest(generated_at="2027-01-01T00:00:00+00:00")
    assert provenance.diff_manifests(a, b) == []
    assert any(d["field"] == "generated_at" for d in provenance.diff_manifests(a, b, ignore_volatile=False))


def test_changed_weights_break_reproducibility():
    a = _manifest()
    b = copy.deepcopy(a)
    b["models"]["localizer"]["sha256"] = "bb"
    diffs = provenance.diff_manifests(a, b)
    assert [d["field"] for d in diffs] == ["models.localizer.sha256"]
    assert provenance.is_reproducible(diffs) is False


def test_changed_constant_breaks_reproducibility():
    a = _manifest()
    b = copy.deepcopy(a)
    b["constants"]["stage_b.theta_b"] = 0.6
    diffs = provenance.diff_manifests(a, b)
    assert provenance.is_reproducible(diffs) is False


def test_environment_drift_alone_stays_reproducible():
    a = _manifest()
    b = copy.deepcopy(a)
    b["environment"]["packages"]["torch"] = "2.6.0"
    diffs = provenance.diff_manifests(a, b)
    assert len(diffs) == 1
    assert provenance.is_reproducible(diffs) is True


def test_diff_orders_models_and_constants_first():
    a = _manifest()
    b = copy.deepcopy(a)
    b["git"]["commit"] = "def456"
    b["constants"]["stage_b.theta_b"] = 0.6
    b["models"]["localizer"]["sha256"] = "bb"
    fields = [d["field"] for d in provenance.diff_manifests(a, b)]
    assert fields[0].startswith("models")
    assert fields[1].startswith("constants")
    assert fields[-1].startswith("git")


def test_write_and_read_roundtrip(tmp_path):
    target = tmp_path / "nested" / "manifest.json"
    provenance.write_manifest(target, _manifest())
    assert json.loads(target.read_text())["constants"]["stage_b.theta_b"] == 0.530306
    assert provenance.read_manifest(target) == _manifest()


def test_build_manifest_has_required_sections():
    m = provenance.build_manifest(generated_at="2026-07-26T00:00:00+00:00")
    for section in ("schema_version", "generated_at", "git", "environment", "models", "constants"):
        assert section in m
    assert m["constants"]["SAMPLE_RATE"] == C.SAMPLE_RATE


def test_diff_ignores_descriptive_sections_by_default():
    """A worker-captured manifest has no session block; those diffs are not signal."""
    a = _manifest()
    b = copy.deepcopy(a)
    b["session"] = {"id": 1, "device": "mps", "n_events": 187}
    b["extra"] = {"f_min_hz": 6000}
    assert provenance.diff_manifests(a, b) == []
    noisy = provenance.diff_manifests(a, b, ignore_volatile=False)
    assert any(d["field"].startswith("session.") for d in noisy)


def test_descriptive_sections_never_affect_the_reproducibility_verdict():
    a = _manifest()
    b = copy.deepcopy(a)
    b["session"] = {"device": "cpu"}
    assert provenance.is_reproducible(provenance.diff_manifests(a, b)) is True


def test_weight_change_still_surfaces_alongside_descriptive_drift():
    a = _manifest()
    b = copy.deepcopy(a)
    b["session"] = {"device": "cpu"}
    b["models"]["localizer"]["sha256"] = "changed"
    diffs = provenance.diff_manifests(a, b)
    assert [d["field"] for d in diffs] == ["models.localizer.sha256"]
    assert provenance.is_reproducible(diffs) is False
