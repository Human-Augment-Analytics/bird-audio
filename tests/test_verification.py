from __future__ import annotations

import argparse
import sqlite3

import pytest

from birdpipe import verification as V
from scripts import verification_planner


def _ev(eid, conf, completeness=0.6, review="unreviewed", source="ml"):
    return {
        "id": eid,
        "stage_a_conf": conf,
        "completeness_score": completeness,
        "review_status": review,
        "source": source,
        "file_id": 1,
    }


def test_verification_plan_queue_carries_recording_path(tmp_path):
    db_path = tmp_path / "batch.db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL)")
    conn.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, session_id INTEGER, file_id INTEGER, "
        "stage_a_conf REAL, completeness_score REAL, completeness_label TEXT, retained INTEGER, "
        "review_status TEXT, source TEXT)"
    )
    recording = "/recordings/PSL1_20250619_080000.WAV"
    conn.execute("INSERT INTO files (id, path) VALUES (?, ?)", (7, recording))
    conn.execute(
        "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (42, 3, 7, 0.91, 0.72, "complete", 1, "unreviewed", "ml"),
    )
    conn.commit()
    conn.close()

    events = verification_planner.load_events(str(db_path), session_id=3)
    args = argparse.Namespace(
        db=str(db_path), session_id=3, threshold=0.5, confidence=0.95,
        seconds_per_verification=8.0, target_half_width=0.1,
        budget=1, strategy="uncertainty", seed=0, theta_b=0.5,
        sweep=False, min_evidence=5,
    )
    report = verification_planner.build_report(events, args)

    assert report["queue"] == [{
        "id": 42,
        "stage_a_conf": 0.91,
        "completeness_score": 0.72,
        "file_id": 7,
        "path": recording,
    }]


# --- Wilson interval ---------------------------------------------------------

def test_wilson_known_value_8_of_10():
    lo, hi = V.wilson_interval(8, 10)
    assert lo == pytest.approx(0.4902, abs=1e-3)
    assert hi == pytest.approx(0.9433, abs=1e-3)


def test_wilson_n_zero_is_fully_uninformative():
    assert V.wilson_interval(0, 0) == (0.0, 1.0)


def test_wilson_stays_in_unit_interval():
    for n in (1, 5, 10, 50, 200):
        for s in range(n + 1):
            lo, hi = V.wilson_interval(s, n)
            assert 0.0 <= lo <= hi <= 1.0


def test_wilson_asymmetric_at_the_extremes():
    lo, hi = V.wilson_interval(0, 5)
    assert lo == 0.0
    assert 0.0 < hi < 1.0
    lo, hi = V.wilson_interval(5, 5)
    assert hi == 1.0
    assert 0.0 < lo < 1.0
    # centred estimate is pulled off the observed proportion, unlike the normal approx
    lo, hi = V.wilson_interval(5, 5)
    assert (lo + hi) / 2.0 < 1.0


def test_wilson_narrows_with_n():
    widths = [V.wilson_interval(int(0.8 * n), n) for n in (10, 50, 200, 1000)]
    spans = [hi - lo for lo, hi in widths]
    assert spans == sorted(spans, reverse=True)


def test_wilson_rejects_impossible_counts():
    with pytest.raises(ValueError):
        V.wilson_interval(5, 3)
    with pytest.raises(ValueError):
        V.wilson_interval(-1, 3)


# --- required_sample_size ----------------------------------------------------

def test_required_sample_size_monotone_in_target():
    targets = [0.20, 0.15, 0.10, 0.05, 0.02]
    sizes = [V.required_sample_size(0.8, t) for t in targets]
    assert sizes == sorted(sizes)
    assert len(set(sizes)) == len(sizes)


def test_required_sample_size_actually_meets_the_target():
    for p in (0.05, 0.5, 0.9):
        for target in (0.10, 0.05, 0.03):
            n = V.required_sample_size(p, target)
            lo, hi = V.wilson_interval(round(p * n), n)
            assert n >= 1
            assert (hi - lo) / 2.0 <= target + 0.01


def test_required_sample_size_capped_by_population():
    assert V.required_sample_size(0.5, 0.01, population=50) == 50
    assert V.required_sample_size(0.5, 0.05, population=100) <= 100
    assert V.required_sample_size(0.5, 0.05, population=100) < V.required_sample_size(0.5, 0.05)


def test_required_sample_size_zero_population():
    assert V.required_sample_size(0.5, 0.05, population=0) == 0


def test_required_sample_size_defaults_to_conservative_p():
    assert V.required_sample_size(None, 0.05) == V.required_sample_size(0.5, 0.05)


def test_required_sample_size_rejects_bad_target():
    with pytest.raises(ValueError):
        V.required_sample_size(0.5, 0.0)


# --- precision_estimate ------------------------------------------------------

def test_precision_counts_confirmed_as_true_and_rejected_as_false():
    recs = [
        _ev(1, 0.9, review="confirmed"),
        _ev(2, 0.8, review="confirmed"),
        _ev(3, 0.7, review="confirmed"),
        _ev(4, 0.6, review="rejected"),
    ]
    est = V.precision_estimate(recs, 0.5)
    assert est.n_verified == 4
    assert est.n_true == 3
    assert est.point == pytest.approx(0.75)
    assert est.ci_low < est.point < est.ci_high


def test_precision_excludes_manual_events():
    recs = [
        _ev(1, 0.9, review="confirmed"),
        _ev(2, 0.9, review="confirmed", source="manual"),
        _ev(3, 0.9, review="rejected", source="manual"),
    ]
    est = V.precision_estimate(recs, 0.5)
    assert est.n_verified == 1
    assert est.n_above_threshold == 1


def test_precision_excludes_unreviewed_but_counts_them_as_pool():
    recs = [
        _ev(1, 0.9, review="confirmed"),
        _ev(2, 0.9, review="unreviewed"),
        _ev(3, 0.9, review="unreviewed"),
    ]
    est = V.precision_estimate(recs, 0.5)
    assert est.n_verified == 1
    assert est.n_unreviewed == 2
    assert est.n_above_threshold == 3


def test_precision_excludes_below_threshold():
    recs = [_ev(1, 0.9, review="confirmed"), _ev(2, 0.2, review="rejected")]
    est = V.precision_estimate(recs, 0.5)
    assert est.n_verified == 1
    assert est.n_true == 1


def test_precision_with_no_verified_labels_is_none_not_zero():
    recs = [_ev(i, 0.9) for i in range(5)]
    est = V.precision_estimate(recs, 0.5)
    assert est.point is None
    assert est.n_verified == 0
    assert (est.ci_low, est.ci_high) == (0.0, 1.0)


def test_precision_reads_sqlite_rows():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, stage_a_conf REAL, "
        "completeness_score REAL, review_status TEXT, source TEXT)"
    )
    conn.executemany(
        "INSERT INTO events VALUES (?,?,?,?,?)",
        [
            (1, 0.9, 0.7, "confirmed", "ml"),
            (2, 0.8, 0.7, "rejected", "ml"),
            (3, 0.9, None, "confirmed", "manual"),
        ],
    )
    rows = conn.execute("SELECT * FROM events").fetchall()
    est = V.precision_estimate(rows, 0.5)
    assert est.n_verified == 2
    assert est.n_true == 1


# --- additional_effort -------------------------------------------------------

def test_additional_effort_subtracts_work_already_done():
    recs = [_ev(i, 0.9, review="confirmed") for i in range(20)]
    recs += [_ev(100 + i, 0.9) for i in range(500)]
    est = V.precision_estimate(recs, 0.5)
    effort = V.additional_effort(est, 0.05, seconds_per_verification=10.0)
    assert effort.n_verified == 20
    assert effort.n_additional == effort.n_required - 20
    assert effort.estimated_seconds == pytest.approx(effort.n_additional * 10.0)
    assert effort.estimated_minutes == pytest.approx(effort.estimated_seconds / 60.0)


def test_additional_effort_cold_start_assumes_half():
    recs = [_ev(i, 0.9) for i in range(300)]
    est = V.precision_estimate(recs, 0.5)
    effort = V.additional_effort(est, 0.05)
    assert effort.p_assumed == 0.5
    assert effort.n_additional > 0


def test_additional_effort_flags_a_census_requirement():
    recs = [_ev(i, 0.9) for i in range(5)]
    est = V.precision_estimate(recs, 0.5)
    effort = V.additional_effort(est, 0.01)
    assert effort.requires_census is True
    assert effort.n_additional == 5

    big = [_ev(i, 0.9) for i in range(5000)]
    effort = V.additional_effort(V.precision_estimate(big, 0.5), 0.05)
    assert effort.requires_census is False
    assert effort.n_additional < 5000


# --- plan_review_queue -------------------------------------------------------

@pytest.fixture
def mixed_pool():
    return [
        _ev(1, 0.95, completeness=0.95),
        _ev(2, 0.80, completeness=0.55),
        _ev(3, 0.62, completeness=0.20),
        _ev(4, 0.51, completeness=0.53),
        _ev(5, 0.30, completeness=0.90),                      # below threshold
        _ev(6, 0.90, completeness=0.90, review="confirmed"),  # already reviewed
        _ev(7, 0.90, completeness=0.90, source="manual"),     # not detector output
    ]


@pytest.mark.parametrize("strategy", list(V.STRATEGIES))
def test_queue_only_returns_eligible_unreviewed_ids(mixed_pool, strategy):
    ids = V.plan_review_queue(mixed_pool, 0.5, budget=10, strategy=strategy, rng_seed=7)
    assert set(ids) <= {1, 2, 3, 4}
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("strategy", list(V.STRATEGIES))
def test_queue_respects_budget(mixed_pool, strategy):
    assert len(V.plan_review_queue(mixed_pool, 0.5, 2, strategy, rng_seed=7)) == 2
    assert V.plan_review_queue(mixed_pool, 0.5, 0, strategy, rng_seed=7) == []


@pytest.mark.parametrize("strategy", list(V.STRATEGIES))
def test_queue_is_reproducible_under_a_fixed_seed(strategy):
    pool = [_ev(i, 0.5 + i / 200.0, completeness=(i % 100) / 100.0) for i in range(100)]
    a = V.plan_review_queue(pool, 0.5, 30, strategy, rng_seed=42)
    b = V.plan_review_queue(pool, 0.5, 30, strategy, rng_seed=42)
    assert a == b


def test_random_queue_differs_across_seeds():
    pool = [_ev(i, 0.9) for i in range(100)]
    a = V.plan_review_queue(pool, 0.5, 20, "random", rng_seed=1)
    b = V.plan_review_queue(pool, 0.5, 20, "random", rng_seed=2)
    assert a != b


def test_uncertainty_orders_by_closeness_to_threshold():
    pool = [
        _ev(1, 0.95),
        _ev(2, 0.51),
        _ev(3, 0.70),
        _ev(4, 0.55),
    ]
    assert V.plan_review_queue(pool, 0.5, 4, "uncertainty") == [2, 4, 3, 1]


def test_completeness_orders_by_closeness_to_theta_b():
    theta_b = 0.5
    pool = [
        _ev(1, 0.9, completeness=0.99),
        _ev(2, 0.9, completeness=0.52),
        _ev(3, 0.9, completeness=0.10),
        _ev(4, 0.9, completeness=0.45),
    ]
    # |0.52-0.5|=0.02, |0.45-0.5|=0.05, |0.10-0.5|=0.40, |0.99-0.5|=0.49
    ids = V.plan_review_queue(pool, 0.5, 4, "completeness", theta_b=theta_b)
    assert ids == [2, 4, 3, 1]


def test_completeness_puts_missing_scores_last():
    pool = [_ev(1, 0.9, completeness=None), _ev(2, 0.9, completeness=0.9)]
    assert V.plan_review_queue(pool, 0.5, 2, "completeness", theta_b=0.9) == [2, 1]


def test_stratified_spreads_across_confidence_bins():
    pool = ([_ev(i, 0.55) for i in range(20)]
            + [_ev(100 + i, 0.95) for i in range(20)])
    ids = V.plan_review_queue(pool, 0.5, 8, "stratified", rng_seed=3, n_strata=2)
    low = sum(1 for i in ids if i < 100)
    high = len(ids) - low
    assert len(ids) == 8
    assert low == 4 and high == 4


def test_stratified_falls_back_when_a_stratum_is_empty():
    pool = [_ev(i, 0.52) for i in range(6)]
    ids = V.plan_review_queue(pool, 0.5, 6, "stratified", rng_seed=3, n_strata=4)
    assert sorted(ids) == list(range(6))


def test_unknown_strategy_rejected():
    with pytest.raises(ValueError):
        V.plan_review_queue([], 0.5, 5, "magic")


# --- stopping_rule -----------------------------------------------------------

def test_stopping_rule_fires_when_target_already_met():
    recs = [_ev(i, 0.9, review="confirmed") for i in range(400)]
    recs += [_ev(1000 + i, 0.9) for i in range(50)]
    est = V.precision_estimate(recs, 0.5)
    verdict = V.stopping_rule(est, 0.05)
    assert verdict["stop"] is True
    assert "Target met" in verdict["reason"]


def test_stopping_rule_fires_when_pool_exhausted():
    recs = [_ev(1, 0.9, review="confirmed"), _ev(2, 0.9, review="rejected")]
    est = V.precision_estimate(recs, 0.5)
    verdict = V.stopping_rule(est, 0.05)
    assert verdict["stop"] is True
    assert "exhausted" in verdict["reason"]


def test_stopping_rule_continues_on_cold_start():
    recs = [_ev(i, 0.9) for i in range(50)]
    est = V.precision_estimate(recs, 0.5)
    verdict = V.stopping_rule(est, 0.05)
    assert verdict["stop"] is False
    assert "Cold start" in verdict["reason"]


def test_stopping_rule_continues_when_interval_too_wide():
    recs = [_ev(i, 0.9, review="confirmed") for i in range(10)]
    recs += [_ev(100 + i, 0.9) for i in range(200)]
    est = V.precision_estimate(recs, 0.5)
    verdict = V.stopping_rule(est, 0.02)
    assert verdict["stop"] is False


def test_stopping_rule_on_empty_population():
    est = V.precision_estimate([], 0.5)
    verdict = V.stopping_rule(est, 0.05)
    assert verdict["stop"] is True
    assert "nothing to verify" in verdict["reason"]


# --- threshold_sweep_precision ----------------------------------------------

def test_sweep_flags_thin_evidence():
    recs = [_ev(i, 0.9, review="confirmed") for i in range(12)]
    recs += [_ev(100 + i, 0.95, review="confirmed") for i in range(3)]
    rows = V.threshold_sweep_precision(recs, [0.5, 0.92], min_evidence=10)
    by_t = {r.threshold: r for r in rows}
    assert by_t[0.5].evidence == "sufficient"
    assert by_t[0.92].evidence == "insufficient"
    assert by_t[0.92].estimate.n_verified == 3


def test_sweep_never_reports_a_point_without_an_interval():
    recs = [_ev(i, 0.6, review="confirmed") for i in range(5)] + [_ev(50, 0.99)]
    for row in V.threshold_sweep_precision(recs, [0.0, 0.5, 0.95, 1.0]):
        d = row.to_dict()
        assert "ci_low" in d and "ci_high" in d and "n_verified" in d
        if d["point"] is None:
            assert d["n_verified"] == 0
        else:
            assert d["ci_low"] <= d["point"] <= d["ci_high"]


# --- measured pace from review telemetry -----------------------------------

def _telemetry_db(tmp_path, rows, name="tel.db"):
    import sqlite3
    db = tmp_path / name
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE review_events (id INTEGER PRIMARY KEY, session_id INTEGER,"
        " event_id INTEGER, file_id INTEGER, action TEXT, at_ms INTEGER,"
        " dwell_ms INTEGER, meta TEXT)"
    )
    conn.executemany(
        "INSERT INTO review_events (session_id, action, dwell_ms) VALUES (?,?,?)", rows
    )
    conn.commit()
    conn.close()
    return str(db)


def test_measured_pace_is_median_of_decision_dwells(tmp_path):
    rows = [(1, "confirm", 4000), (1, "reject", 6000), (1, "confirm", 5000),
            (1, "confirm", 5000), (1, "reject", 10000), (1, "confirm", 5000)]
    got = V.measured_seconds_per_verification(_telemetry_db(tmp_path, rows))
    assert got["source"] == "measured"
    assert got["n_decisions"] == 6
    assert got["seconds_per_verification"] == pytest.approx(5.0)


def test_measured_pace_excludes_idle_gaps(tmp_path):
    """An overnight gap is a break, not a decision, and must not inflate the pace."""
    rows = [(1, "confirm", 4000)] * 5 + [(1, "confirm", 9_984_000)]
    got = V.measured_seconds_per_verification(_telemetry_db(tmp_path, rows))
    assert got["n_decisions"] == 5
    assert got["seconds_per_verification"] == pytest.approx(4.0)


def test_measured_pace_ignores_navigation_actions(tmp_path):
    rows = [(1, "confirm", 4000)] * 5 + [(1, "play", 60000), (1, "open_file", 90000)]
    got = V.measured_seconds_per_verification(_telemetry_db(tmp_path, rows))
    assert got["n_decisions"] == 5


def test_measured_pace_none_when_too_few_decisions(tmp_path):
    rows = [(1, "confirm", 4000), (1, "reject", 5000)]
    assert V.measured_seconds_per_verification(_telemetry_db(tmp_path, rows)) is None


def test_measured_pace_none_when_table_absent(tmp_path):
    import sqlite3
    db = tmp_path / "bare.db"
    sqlite3.connect(db).close()
    assert V.measured_seconds_per_verification(str(db)) is None


def test_measured_pace_none_when_db_missing(tmp_path):
    assert V.measured_seconds_per_verification(str(tmp_path / "nope.db")) is None


def test_measured_pace_scopes_to_session(tmp_path):
    rows = [(1, "confirm", 4000)] * 5 + [(2, "confirm", 20000)] * 5
    got = V.measured_seconds_per_verification(_telemetry_db(tmp_path, rows), session_id=2)
    assert got["n_decisions"] == 5
    assert got["seconds_per_verification"] == pytest.approx(20.0)
