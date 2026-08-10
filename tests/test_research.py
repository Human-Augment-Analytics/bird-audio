import math
import pytest

from birdpipe import ecology, research
from scripts.research_analysis import _threshold_grid


def _event(event_id, *, source="ml", review="unreviewed", retained=True, conf=0.8, quality=0.8):
    return {
        "event_id": event_id, "path": "PSL01_20250115_060000.wav", "t_start": float(event_id),
        "source": source, "review_status": review, "retained": retained,
        "stage_a_conf": conf, "completeness_score": quality,
        "session_theta_a": 0.5, "session_theta_b": 0.5,
    }


def test_curated_definition_combines_manual_confirmed_and_retained():
    rows = [
        _event(1, source="manual", retained=False, conf=0.0, quality=0.0),
        _event(2, review="confirmed", retained=False, conf=0.1, quality=0.1),
        _event(3, review="rejected"),
        _event(4, retained=True),
        _event(5, retained=False, conf=0.1, quality=0.1),
    ]
    curated = research.curate_records(rows, 0.5, 0.5)
    assert [row["event_id"] for row in curated] == [1, 2, 4]
    assert {row["curation_basis"] for row in curated} == {
        "manual_annotation", "reviewer_confirmed", "threshold_retained_unreviewed"
    }


def test_rejected_manual_annotation_is_excluded():
    assert research.curate_records([_event(1, source="manual", review="rejected")], 0.5, 0.5) == []


def test_curate_records_accepts_generator():
    curated = research.curate_records((_event(i) for i in range(3)), 0.5, 0.5)
    assert len(curated) == 3


def test_exact_poisson_interval_handles_zero_counts():
    low, high = research.poisson_rate_interval(0, 2.0)
    assert low == 0.0
    assert high > 0


def test_activity_normalizes_each_bin_by_actual_exposure():
    rows = [_event(1), {**_event(2), "t_start": 400.0}]
    activity = research.activity_by_recording_time(
        rows, {"a.wav": 10 / 60, "b.wav": 5 / 60}, bin_minutes=5
    )
    assert len(activity) == 2
    assert math.isclose(activity[0]["exposure_hours"], 10 / 60)
    assert math.isclose(activity[1]["exposure_hours"], 5 / 60)
    assert activity[0]["rate_per_hour"] == 6.0
    assert activity[1]["rate_per_hour"] == 12.0


def test_file_rows_include_zero_detection_recordings_and_covariates():
    paths = ["PSL01_20250115_060000.wav", "PSL01_20250415_060000.wav"]
    metadata = {"PSL01": {"site_id": "LOW", "elevation_m": 10.0, "temperature_c": 5.0}}
    rows = research.build_file_rows([_event(1)], paths, {p: 0.25 for p in paths}, metadata)
    assert [row["n_events"] for row in rows] == [1, 0]
    assert rows[0]["season"] == "winter"
    assert rows[0]["temperature_c"] == 5.0


def test_adjusted_model_refuses_too_few_recorder_clusters():
    rows = [{"path": f"PSL{i:02d}_20250115_060000.wav", "recorder_id": f"PSL{i:02d}",
             "site_id": "LOW", "elevation_m": float(i), "effort_hours": 0.25,
             "n_events": i % 2, "season": "winter", "temperature_c": None,
             "precipitation_mm": None, "wind_mps": None, "humidity_pct": None}
            for i in range(9)]
    result = research.fit_adjusted_rate_model(rows)
    assert result["status"] == "not_fitted"
    assert "10 recorders" in result["reason"]


def test_duplicate_device_metadata_is_rejected(tmp_path):
    path = tmp_path / "metadata.csv"
    path.write_text("device_id,site_id,elevation_m\nPSL01,A,10\nPSL01,B,20\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate device_id"):
        ecology.read_deployment_metadata(str(path))


def test_threshold_grid_stays_unique_at_candidate_floor():
    assert _threshold_grid(0.0, floor=0.25) == [0.25, 0.3, 0.35, 0.4, 0.45]
    assert len(set(_threshold_grid(0.98))) == 5
