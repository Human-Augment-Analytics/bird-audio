#!/usr/bin/env python3
"""Build the app's transparent, reproducible research-analysis bundle."""

import argparse
import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from birdpipe import ecology, research


def _write_csv(path, rows, fields=None):
    rows = list(rows)
    fields = list(fields or sorted({key for row in rows for key in row}))
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _threshold_grid(center, floor=0.0):
    """Five unique sensitivity values, respecting what inference stored."""
    center = max(float(center), float(floor))
    start = min(max(floor, center - 0.10), 0.80)
    return [round(start + 0.05 * index, 6) for index in range(5)]


def build(args):
    base = ecology.load_event_records(args.db, session_id=args.session_id)
    files = ecology.load_file_paths(args.db, session_id=args.session_id)
    metadata = ecology.read_deployment_metadata(args.metadata) if args.metadata else {}
    base = ecology.join_deployment_metadata(base, metadata=metadata)
    curated = research.curate_records(base, args.theta_a, args.theta_b)
    # Manual annotations remain part of the final curated export, but without
    # an exhaustive-search flag they cannot safely augment a detection-rate
    # numerator used for inference.
    inferential = [row for row in curated if row.get("source") != "manual"]
    if args.effort_json:
        effort = json.loads(Path(args.effort_json).read_text(encoding="utf-8"))
    else:
        effort = ecology.measure_effort_hours(files)
    activity = research.activity_by_recording_time(inferential, effort["hours"], args.bin_minutes)
    file_rows = research.build_file_rows(inferential, files, effort["hours"], metadata)
    model = research.fit_adjusted_rate_model(file_rows, args.alpha)

    thresholds = []
    for ta in _threshold_grid(args.theta_a, floor=0.25):
        for tb in _threshold_grid(args.theta_b):
            events = [row for row in research.curate_records(base, ta, tb) if row.get("source") != "manual"]
            total_effort = sum(effort["hours"].values())
            low, high = research.poisson_rate_interval(len(events), total_effort)
            identifiable = True
            cell_model = research.fit_adjusted_rate_model(
                research.build_file_rows(events, files, effort["hours"], metadata), args.alpha
            )
            elevation_term = next((term for term in cell_model.get("terms", []) if term["term"] == "elevation_per_100m"), None)
            thresholds.append({"theta_a": ta, "theta_b": tb, "n_events": len(events),
                               "rate_per_hour": len(events) / total_effort if total_effort else None,
                               "ci_low": low, "ci_high": high, "identifiable": identifiable,
                               "model_status": cell_model.get("status"),
                               "elevation_rate_ratio": elevation_term.get("rate_ratio") if elevation_term else None,
                               "elevation_ci_low": elevation_term.get("ci_low") if elevation_term else None,
                               "elevation_ci_high": elevation_term.get("ci_high") if elevation_term else None})

    basis = Counter(row["curation_basis"] for row in curated)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    curated_path = out / "final_curated_events.csv"
    file_path = out / "model_ready_recordings.csv"
    event_fields = sorted({key for row in base + curated for key in row}) or [
        "event_id", "path", "t_start", "t_end", "duration", "f_low", "f_high",
        "center_freq", "stage_a_conf", "completeness_score", "retained",
        "completeness_label", "human_completeness", "completeness_source",
        "review_status", "source", "label", "note", "curation_basis",
    ]
    file_fields = sorted({key for row in file_rows for key in row}) or [
        "path", "recorder_id", "site_id", "recording_date", "season", "elevation_m",
        "effort_hours", "n_events", *research.WEATHER_FIELDS,
    ]
    _write_csv(curated_path, curated, event_fields)
    _write_csv(file_path, file_rows, file_fields)
    _write_csv(out / "manual_annotations.csv", [row for row in curated if row.get("source") == "manual"], event_fields)
    _write_csv(out / "curated_detector_events.csv", inferential, event_fields)
    metadata_hash = None
    if args.metadata:
        metadata_hash = hashlib.sha256(Path(args.metadata).read_bytes()).hexdigest()
    spec = {
        "schema_version": 1, "session_id": args.session_id,
        "event_set": "review_corrected_pipeline_plus_manual_catalog",
        "theta_a": args.theta_a, "theta_b": args.theta_b,
        "activity_bin_minutes": args.bin_minutes, "alpha": args.alpha,
        "effort_fallback_hours": ecology.DEFAULT_EFFORT_HOURS_PER_FILE,
        "effort_reader": effort.get("reader", "python-soundfile"),
        "metadata_sha256": metadata_hash,
    }
    spec_bytes = json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    data_bytes = json.dumps({
        "curated_events": curated,
        "model_ready_recordings": file_rows,
        "effort": effort,
        "metadata_sha256": metadata_hash,
    }, sort_keys=True, separators=(",", ":"), default=str).encode()
    spec["spec_sha256"] = hashlib.sha256(spec_bytes).hexdigest()
    spec["curated_data_sha256"] = hashlib.sha256(data_bytes).hexdigest()
    (out / "research_spec.json").write_text(json.dumps(spec, indent=2), encoding="utf-8")
    result = {
        "definition": "manual annotations + reviewer-confirmed detections + unreviewed detections passing both selected thresholds; reviewer-rejected detections excluded",
        "inferential_event_set": "reviewer-confirmed and threshold-retained detector events only; manual annotations excluded unless an exhaustive-search design is documented",
        "curated_count": len(curated), "curation_basis": dict(basis),
        "effort": {"total_hours": sum(effort["hours"].values()), "measured_files": effort["n_measured"],
                   "defaulted_files": effort["n_defaulted"], "reader_available": effort["available"]},
        "activity": activity, "model": model, "sensitivity": thresholds,
        "thresholds": {"theta_a": args.theta_a, "theta_b": args.theta_b},
        "outputs": {"curated_events_csv": str(curated_path), "model_ready_recordings_csv": str(file_path)},
        "spec": spec,
    }
    result["outputs"]["analysis_json"] = str(out / "research_analysis.json")
    result["outputs"]["research_spec_json"] = str(out / "research_spec.json")
    (out / "research_analysis.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--session-id", type=int, required=True)
    parser.add_argument("--metadata")
    parser.add_argument("--effort-json")
    parser.add_argument("--out", required=True)
    parser.add_argument("--theta-a", type=float, required=True)
    parser.add_argument("--theta-b", type=float, required=True)
    parser.add_argument("--bin-minutes", type=float, default=5.0)
    parser.add_argument("--alpha", type=float, default=0.05)
    args = parser.parse_args()
    json.dump(build(args), sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
