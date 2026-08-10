from __future__ import annotations

import math
import sqlite3

import pytest

from birdpipe import ecology as eco

SCHEMA = """
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY,
  input_roots TEXT NOT NULL DEFAULT '',
  output_dir TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'cpu',
  concurrency INTEGER NOT NULL DEFAULT 1,
  theta_a REAL NOT NULL,
  theta_b REAL NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done'
);
CREATE TABLE files(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done'
);
CREATE TABLE events(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  t_start REAL, t_end REAL, duration REAL,
  f_low REAL, f_high REAL, center_freq REAL,
  stage_a_conf REAL,
  completeness_score REAL,
  completeness_label TEXT,
  retained INTEGER,
  n_members INTEGER NOT NULL DEFAULT 2,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  source TEXT NOT NULL DEFAULT 'ml'
);
"""


def make_db(files, theta_a=0.2, theta_b=0.5):
    """files: list of (path, [event dicts]). Retention is stored using theta_a/theta_b."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT INTO sessions(id, theta_a, theta_b, total_files) VALUES (1, ?, ?, ?)",
        (theta_a, theta_b, len(files)),
    )
    for file_id, (path, events) in enumerate(files, start=1):
        conn.execute("INSERT INTO files(id, session_id, path) VALUES (?, 1, ?)", (file_id, path))
        for ev in events:
            conf = ev.get("conf", 0.9)
            score = ev.get("score", 0.9)
            duration = ev.get("duration", 1.3)
            center = ev.get("center_freq", 7100.0)
            retained = int(conf >= theta_a and score >= theta_b)
            conn.execute(
                "INSERT INTO events(session_id, file_id, t_start, t_end, duration, f_low, f_high,"
                " center_freq, stage_a_conf, completeness_score, completeness_label, retained, n_members)"
                " VALUES (1, ?, 0.0, ?, ?, 6500, 7700, ?, ?, ?, ?, ?, 2)",
                (
                    file_id, duration, duration, center, conf, score,
                    "complete" if score >= theta_b else "incomplete", retained,
                ),
            )
    conn.commit()
    return conn


def synthetic_deployment(recorders, files_per_recorder, counts, durations=None, prefix="PSL"):
    """Build (files, metadata) for recorders given per-recorder event counts."""
    files = []
    metadata = {}
    for i, (rid, elev) in enumerate(recorders):
        metadata[rid] = {"site_id": "S{}".format(i), "elevation_m": elev, "lat": 30.0, "lon": 79.0}
        remaining = counts[i]
        for f in range(files_per_recorder):
            n_here = remaining if f == files_per_recorder - 1 else remaining // files_per_recorder
            remaining -= n_here
            dur = 1.3 if durations is None else durations[i]
            evs = [{"duration": dur} for _ in range(n_here)]
            files.append(("/data/{}/{}_2025061{}_080000.WAV".format(rid, rid, f), evs))
    return files, metadata


def build_rows(recorders, counts, durations=None, files_per_recorder=4, theta_a=0.2, theta_b=0.5):
    files, metadata = synthetic_deployment(recorders, files_per_recorder, counts, durations)
    conn = make_db(files, theta_a=theta_a, theta_b=theta_b)
    records = eco.load_event_records(conn)
    records = eco.join_deployment_metadata(records, metadata=metadata)
    return eco.recorder_summary(
        records,
        file_paths=eco.load_file_paths(conn),
        metadata=eco.metadata_by_recorder(metadata),
    )


# --- recorder ID parsing / band assignment ---------------------------------

@pytest.mark.parametrize("path,expected", [
    ("/data/PSL03/PSL03_20250611_080000.WAV", "PSL03"),
    ("/data/PSM12_20250611_080000.WAV", "PSM12"),
    ("/data/PSH07/rec.WAV", "PSH07"),
    ("/data/H4/rec.WAV", "H4"),
    ("psl9_x.wav", "PSL9"),
])
def test_parse_recorder_id(path, expected):
    assert eco.parse_recorder_id(path) == expected


def test_parse_recorder_id_none_when_absent():
    assert eco.parse_recorder_id("/data/20250611_080000.WAV") is None
    assert eco.parse_recorder_id(None) is None


@pytest.mark.parametrize("rid,band", [
    ("PSL03", "Low"),
    ("PSM12", "Medium"),
    ("PSH07", "High"),
    ("H4", "High"),
    ("XX1", None),
])
def test_elevation_band_prefixes(rid, band):
    assert eco.elevation_band(rid) == band


def test_elevation_band_mapping_is_overridable():
    custom = {"PSL": "Valley", "PS": "Slope"}
    assert eco.elevation_band("PSL03", custom) == "Valley"
    assert eco.elevation_band("PSM12", custom) == "Slope"


def test_resolve_band_prefers_declared_band():
    assert eco.resolve_band("PSL01", "PSH09", declared_band="Medium") == "Medium"


def test_resolve_band_falls_back_to_site_id():
    """Recorder IDs are often timestamps; the band then lives in the site code."""
    assert eco.resolve_band("20250611_080000", "PSL01") == "Low"
    assert eco.resolve_band("20250612_050000", "PSH01") == "High"


def test_resolve_band_prefers_recorder_over_site():
    assert eco.resolve_band("PSM07", "PSL01") == "Medium"


def test_resolve_band_none_when_neither_encodes_a_band():
    assert eco.resolve_band("20250611_080000", "site-a") is None
    assert eco.resolve_band(None, None) is None


# --- effort-normalized rate arithmetic -------------------------------------

def test_rate_per_hour_is_events_over_effort():
    files = [
        ("/data/PSL01/a.WAV", [{"duration": 1.0}, {"duration": 2.0}]),
        ("/data/PSL01/b.WAV", [{"duration": 1.5}]),
        ("/data/PSL01/c.WAV", [{"duration": 1.5}, {"duration": 1.5}, {"duration": 1.5}]),
    ]
    conn = make_db(files)
    rows = eco.recorder_summary(eco.load_event_records(conn), file_paths=eco.load_file_paths(conn))
    row = rows[0]
    assert row["recorder_id"] == "PSL01"
    assert row["n_files"] == 3
    assert row["effort_hours"] == pytest.approx(0.75)
    assert row["n_events"] == 6
    assert row["rate_per_hour"] == pytest.approx(8.0)
    assert row["duration_mean"] == pytest.approx(1.5)


def test_files_without_events_still_contribute_effort():
    files = [
        ("/data/PSH01/a.WAV", [{"duration": 1.0}]),
        ("/data/PSH01/b.WAV", []),
        ("/data/PSH02/a.WAV", []),
    ]
    conn = make_db(files)
    rows = {r["recorder_id"]: r for r in eco.recorder_summary(
        eco.load_event_records(conn), file_paths=eco.load_file_paths(conn))}
    assert rows["PSH01"]["effort_hours"] == pytest.approx(0.5)
    assert rows["PSH01"]["rate_per_hour"] == pytest.approx(2.0)
    assert rows["PSH02"]["n_events"] == 0
    assert rows["PSH02"]["rate_per_hour"] == pytest.approx(0.0)


def test_default_loaders_skip_failed_latest_session_and_reject_it_when_explicit():
    conn = make_db([("/data/PSL01/old.WAV", [{"duration": 1.0}])])
    conn.execute(
        "INSERT INTO sessions(id, theta_a, theta_b, total_files, status) VALUES (2, 0.3, 0.7, 3, 'failed')"
    )
    conn.executemany(
        "INSERT INTO files(id, session_id, path, status) VALUES (?, 2, ?, ?)",
        [
            (10, "/data/PSH01/done.WAV", "done"),
            (11, "/data/PSH01/pending.WAV", "pending"),
            (12, "/data/PSH01/failed.WAV", "failed"),
        ],
    )
    conn.execute(
        "INSERT INTO events(id, session_id, file_id, t_start, t_end, duration, f_low, f_high, "
        "center_freq, stage_a_conf, completeness_score, completeness_label, retained, n_members, "
        "review_status, source) VALUES (20, 2, 10, 0, 1, 1, 6500, 7700, 7100, 0.9, 0.9, "
        "'complete', 1, 2, 'unreviewed', 'ml')"
    )
    conn.execute(
        "INSERT INTO events(id, session_id, file_id, t_start, t_end, duration, f_low, f_high, "
        "center_freq, stage_a_conf, completeness_score, completeness_label, retained, n_members, "
        "review_status, source) VALUES (21, 2, 11, 0, 1, 1, 6500, 7700, 7100, 0.9, 0.9, "
        "'complete', 1, 2, 'unreviewed', 'ml')"
    )
    conn.commit()

    records = eco.load_event_records(conn)
    assert [record["session_id"] for record in records] == [1]
    assert eco.load_file_paths(conn) == ["/data/PSL01/old.WAV"]
    assert eco.session_thetas(conn) == {"theta_a": 0.2, "theta_b": 0.5}
    with pytest.raises(ValueError, match="requires a completed session"):
        eco.load_event_records(conn, session_id=2)
    with pytest.raises(ValueError, match="requires a completed session"):
        eco.load_file_paths(conn, session_id=2)
    with pytest.raises(ValueError, match="requires a completed session"):
        eco.session_thetas(conn, session_id=2)


def test_effort_hours_per_file_is_configurable():
    files = [("/data/PSL01/a.WAV", [{"duration": 1.0}, {"duration": 1.0}])]
    conn = make_db(files)
    rows = eco.recorder_summary(
        eco.load_event_records(conn), effort_hours_per_file=0.5,
        file_paths=eco.load_file_paths(conn))
    assert rows[0]["effort_hours"] == pytest.approx(0.5)
    assert rows[0]["rate_per_hour"] == pytest.approx(4.0)


# --- threshold recomputation ------------------------------------------------

def test_recompute_matches_stored_retained_at_session_thetas():
    files = [("/data/PSL01/a.WAV", [
        {"conf": 0.05, "score": 0.9},
        {"conf": 0.9, "score": 0.1},
        {"conf": 0.9, "score": 0.9},
        {"conf": 0.2, "score": 0.5},
    ])]
    conn = make_db(files, theta_a=0.2, theta_b=0.5)
    stored = [r["retained"] for r in eco.load_event_records(conn)]
    recomputed = [r["retained"] for r in eco.load_event_records(conn, theta_a=0.2, theta_b=0.5)]
    assert stored == [False, False, True, True]
    assert recomputed == stored


def test_raising_thresholds_drops_events():
    files = [("/data/PSL01/a.WAV", [
        {"conf": 0.3, "score": 0.6},
        {"conf": 0.9, "score": 0.9},
    ])]
    conn = make_db(files, theta_a=0.2, theta_b=0.5)
    strict = eco.load_event_records(conn, theta_a=0.8, theta_b=0.8)
    assert [r["retained"] for r in strict] == [False, True]
    assert [r["completeness_label"] for r in strict] == ["incomplete", "complete"]


def test_apply_thresholds_does_not_mutate_input():
    files = [("/data/PSL01/a.WAV", [{"conf": 0.3, "score": 0.6}])]
    conn = make_db(files)
    records = eco.load_event_records(conn)
    eco.apply_thresholds(records, 0.9, 0.9)
    assert records[0]["retained"] is True


# --- band aggregation uses recorder means -----------------------------------

def test_band_summary_averages_recorders_not_events():
    files = [
        ("/data/PSL01/a.WAV", [{"duration": 1.0} for _ in range(100)]),
        ("/data/PSL02/a.WAV", [{"duration": 2.0} for _ in range(2)]),
    ]
    conn = make_db(files)
    rows = eco.recorder_summary(eco.load_event_records(conn), file_paths=eco.load_file_paths(conn))
    bands = {b["elevation_band"]: b for b in eco.band_summary(rows)}
    low = bands["Low"]
    assert low["n_recorders"] == 2
    assert low["n_events"] == 102
    # Event-weighted mean would be ~1.0196; the recorder-level mean is 1.5.
    assert low["duration_mean"] == pytest.approx(1.5)
    assert low["events_median_per_recorder"] == pytest.approx(51.0)
    assert low["rate_per_hour_mean"] == pytest.approx((400.0 + 8.0) / 2)


def test_band_summary_orders_low_medium_high():
    files = [
        ("/data/PSH01/a.WAV", [{"duration": 1.0}]),
        ("/data/PSL01/a.WAV", [{"duration": 1.0}]),
        ("/data/PSM01/a.WAV", [{"duration": 1.0}]),
        ("/data/20250611_080000.WAV", [{"duration": 1.0}]),
    ]
    conn = make_db(files)
    rows = eco.recorder_summary(eco.load_event_records(conn), file_paths=eco.load_file_paths(conn))
    bands = [b["elevation_band"] for b in eco.band_summary(rows)]
    assert bands == ["Low", "Medium", "High", eco.UNASSIGNED_BAND]


# --- P1 / P2 model behaviour ------------------------------------------------

def _gradient_recorders(n=12, base=3200, step=50):
    return [("PSL{:02d}".format(i), base + i * step) for i in range(n)]


def test_planted_negative_rate_gradient_is_recovered():
    recorders = _gradient_recorders()
    counts = [int(round(200 * math.exp(-0.004 * (elev - 3200)))) for _, elev in recorders]
    rows = build_rows(recorders, counts)
    result = eco.fit_elevation_models(rows)["p1"]
    primary = result["primary"]

    assert primary["n"] == 12
    assert primary["estimate"] < 0
    assert primary["ci_high"] < 0
    assert primary["status"] == eco.SUPPORTED
    assert "SUPPORTED" in primary["verdict"]
    assert result["models"]["spearman"]["estimate"] == pytest.approx(-1.0)
    assert result["models"]["poisson"]["estimate"] == pytest.approx(-0.004, abs=5e-4)


def test_planted_positive_rate_gradient_is_not_supported():
    recorders = _gradient_recorders()
    counts = [int(round(20 * math.exp(0.004 * (elev - 3200)))) for _, elev in recorders]
    rows = build_rows(recorders, counts)
    primary = eco.fit_elevation_models(rows)["p1"]["primary"]
    assert primary["estimate"] > 0
    assert primary["status"] == eco.NOT_SUPPORTED


def test_null_rate_gradient_is_not_a_false_positive():
    recorders = _gradient_recorders()
    counts = [50, 48, 52, 49, 51, 50, 52, 48, 51, 49, 50, 51]
    rows = build_rows(recorders, counts)
    primary = eco.fit_elevation_models(rows)["p1"]["primary"]
    assert primary["status"] in (eco.INCONCLUSIVE, eco.NOT_SUPPORTED)
    assert primary["status"] != eco.SUPPORTED
    assert primary["p_value"] > 0.05


def test_planted_negative_duration_gradient_is_recovered():
    recorders = _gradient_recorders()
    counts = [40] * len(recorders)
    durations = [1.5 - 0.0005 * (elev - 3200) for _, elev in recorders]
    rows = build_rows(recorders, counts, durations=durations)
    result = eco.fit_elevation_models(rows)["p2"]
    primary = result["primary"]
    assert primary["model"].startswith("weighted least squares")
    assert primary["estimate"] == pytest.approx(-0.0005, abs=1e-6)
    assert primary["status"] == eco.SUPPORTED
    assert result["models"]["spearman"]["estimate"] == pytest.approx(-1.0)


def test_null_duration_gradient_is_not_a_false_positive():
    recorders = _gradient_recorders()
    counts = [40] * len(recorders)
    durations = [1.30, 1.32, 1.28, 1.31, 1.29, 1.30, 1.32, 1.28, 1.31, 1.29, 1.30, 1.31]
    rows = build_rows(recorders, counts, durations=durations)
    primary = eco.fit_elevation_models(rows)["p2"]["primary"]
    assert primary["status"] != eco.SUPPORTED
    assert primary["p_value"] > 0.05


def test_duration_model_weights_by_events():
    recorders = [("PSL{:02d}".format(i), 3200 + i * 100) for i in range(6)]
    counts = [1000, 1000, 1000, 1000, 1000, 1]
    durations = [1.4, 1.35, 1.3, 1.25, 1.2, 9.0]
    rows = build_rows(recorders, counts, durations=durations)
    weighted = eco.fit_elevation_models(rows)["p2"]["primary"]["estimate"]
    # Unweighted, the single-event outlier would drag the slope positive.
    assert weighted < 0


# --- degenerate designs -----------------------------------------------------

def test_two_recorders_is_inconclusive_without_a_p_value():
    recorders = [("PSL01", 3200), ("PSH01", 3800)]
    rows = build_rows(recorders, [100, 10])
    models = eco.fit_elevation_models(rows)
    for key in ("p1", "p2"):
        primary = models[key]["primary"]
        assert primary["status"] == eco.INCONCLUSIVE
        assert primary["p_value"] is None
        assert primary["estimate"] is None
        assert primary["n"] == 2


def test_three_recorders_fits_but_stays_inconclusive():
    recorders = [("PSL01", 3200), ("PSM01", 3500), ("PSH01", 3800)]
    rows = build_rows(recorders, [400, 100, 10])
    p1 = eco.fit_elevation_models(rows)["p1"]
    assert p1["primary"]["n"] == 3
    assert p1["primary"]["estimate"] < 0
    assert p1["primary"]["status"] == eco.INCONCLUSIVE


def test_no_elevation_metadata_is_inconclusive_not_a_crash():
    files = [("/data/20250611_080000.WAV", [{"duration": 1.2}, {"duration": 1.4}])]
    conn = make_db(files)
    rows = eco.recorder_summary(eco.load_event_records(conn), file_paths=eco.load_file_paths(conn))
    models = eco.fit_elevation_models(rows)
    assert models["n_recorders_with_elevation"] == 0
    assert models["p1"]["primary"]["status"] == eco.INCONCLUSIVE
    assert models["p2"]["primary"]["status"] == eco.INCONCLUSIVE


# --- metadata join ----------------------------------------------------------

def test_join_deployment_metadata_from_csv(tmp_path):
    csv_path = tmp_path / "deployments.csv"
    csv_path.write_text(
        "device_id,site_id,elevation_m,lat,lon,deploy_date\n"
        "PSL01,Kedar-Low,3210,30.5,79.1,2025-06-01\n"
        "PSH01,Kedar-High,3790,30.6,79.2,2025-06-01\n",
        encoding="utf-8",
    )
    files = [
        ("/data/PSL01/a.WAV", [{"duration": 1.0}]),
        ("/data/PSH01/a.WAV", [{"duration": 1.0}]),
    ]
    conn = make_db(files)
    records = eco.join_deployment_metadata(eco.load_event_records(conn), str(csv_path))
    by_recorder = {r["recorder_id"]: r for r in records}
    assert by_recorder["PSL01"]["site_id"] == "Kedar-Low"
    assert by_recorder["PSL01"]["elevation_m"] == pytest.approx(3210.0)
    assert by_recorder["PSL01"]["elevation_band"] == "Low"
    assert by_recorder["PSH01"]["lat"] == pytest.approx(30.6)
    assert by_recorder["PSH01"]["elevation_band"] == "High"


def test_missing_metadata_row_leaves_elevation_none():
    files = [("/data/PSM09/a.WAV", [{"duration": 1.0}])]
    conn = make_db(files)
    records = eco.join_deployment_metadata(eco.load_event_records(conn), metadata={})
    assert records[0]["elevation_m"] is None
    assert records[0]["elevation_band"] == "Medium"


def test_metadata_device_id_resolves_paths_without_a_prefix():
    metadata = {
        "20250611_080000": {"site_id": "A", "elevation_m": 3200.0, "elevation_band": "Low"},
        "20250612_050000": {"site_id": "B", "elevation_m": 3800.0, "elevation_band": "High"},
    }
    files = [
        ("/data/20250611_080000.WAV", [{"duration": 1.4}, {"duration": 1.4}]),
        ("/data/20250612_050000.WAV", [{"duration": 1.1}]),
    ]
    conn = make_db(files)
    records = eco.join_deployment_metadata(eco.load_event_records(conn), metadata=metadata)
    by_recorder = eco.metadata_by_recorder(metadata)
    rows = {r["recorder_id"]: r for r in eco.recorder_summary(
        records, file_paths=eco.load_file_paths(conn), metadata=by_recorder)}

    assert set(rows) == {"20250611_080000", "20250612_050000"}
    assert rows["20250611_080000"]["elevation_band"] == "Low"
    assert rows["20250611_080000"]["effort_hours"] == pytest.approx(0.25)
    assert rows["20250611_080000"]["rate_per_hour"] == pytest.approx(8.0)
    assert rows["20250612_050000"]["elevation_m"] == pytest.approx(3800.0)


def test_band_rate_ordering_ranks_by_rate():
    recorders = [("PSL01", 3200), ("PSL02", 3210), ("PSM01", 3500), ("PSM02", 3510),
                 ("PSH01", 3800), ("PSH02", 3810)]
    rows = build_rows(recorders, [40, 44, 80, 84, 8, 12])
    ordering = eco.band_rate_ordering(eco.band_summary(rows))
    assert ordering == "Medium>Low>High"


# --- measured survey effort -------------------------------------------------

def test_measure_effort_defaults_for_unreadable_files(tmp_path):
    missing = str(tmp_path / "gone.wav")
    got = eco.measure_effort_hours([missing], default_hours=0.25)
    assert got["hours"][missing] == pytest.approx(0.25)
    if got["available"]:
        assert got["n_defaulted"] == 1
        assert got["n_measured"] == 0


def test_recorder_summary_uses_per_file_effort():
    """A recorder whose files are half-length must not be credited full effort."""
    records = [
        {"path": "/d/PSL01_a.wav", "retained": 1, "duration": 1.0, "center_freq": 7000.0},
        {"path": "/d/PSL01_b.wav", "retained": 1, "duration": 1.0, "center_freq": 7000.0},
    ]
    paths = ["/d/PSL01_a.wav", "/d/PSL01_b.wav"]

    uniform = eco.recorder_summary(records, effort_hours_per_file=0.25, file_paths=paths)
    assert uniform[0]["effort_hours"] == pytest.approx(0.5)
    assert uniform[0]["rate_per_hour"] == pytest.approx(4.0)

    measured = eco.recorder_summary(
        records, effort_hours_per_file=0.25, file_paths=paths,
        effort_by_path={"/d/PSL01_a.wav": 0.25, "/d/PSL01_b.wav": 0.125},
    )
    assert measured[0]["effort_hours"] == pytest.approx(0.375)
    assert measured[0]["rate_per_hour"] == pytest.approx(2 / 0.375)


def test_recorder_summary_falls_back_for_paths_missing_from_effort_map():
    records = [{"path": "/d/PSL01_a.wav", "retained": 1, "duration": 1.0, "center_freq": 7000.0}]
    rows = eco.recorder_summary(
        records, effort_hours_per_file=0.25,
        file_paths=["/d/PSL01_a.wav", "/d/PSL01_b.wav"],
        effort_by_path={"/d/PSL01_a.wav": 0.1},
    )
    assert rows[0]["effort_hours"] == pytest.approx(0.35)
