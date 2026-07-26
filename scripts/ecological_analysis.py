#!/usr/bin/env python3
"""
Ecological analysis of retained buzz events.

Builds effort-normalized recorder- and band-level summaries from a batch.db and
formally tests the manuscript's two predictions:

  P1  buzz events occur more frequently at lower elevations
  P2  buzz events are longer at lower elevations

Usage:
  uv run python scripts/ecological_analysis.py --db data/batch.db \
      --metadata deployments.csv --out output/ecology --json
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

# Ensure the repo root is on sys.path
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from birdpipe import ecology as eco

RECORDER_COLUMNS = [
    "recorder_id", "site_id", "elevation_m", "elevation_band",
    "n_files", "effort_hours", "n_events", "rate_per_hour",
    "duration_mean", "duration_median", "duration_sd", "center_freq_mean",
]

BAND_COLUMNS = [
    "elevation_band", "n_recorders", "n_files", "effort_hours", "n_events",
    "events_median_per_recorder", "rate_per_hour_mean", "rate_per_hour_sd",
    "rate_per_hour_median", "duration_mean", "duration_sd",
    "center_freq_mean", "center_freq_sd", "elevation_m_mean",
]


def write_csv(path, columns, rows):
    """Write `rows` (dicts) as CSV with a fixed column order; None becomes empty."""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: ("" if row.get(c) is None else row.get(c)) for c in columns})


def _fmt(value, digits=4):
    if value is None:
        return "-"
    if isinstance(value, float):
        return "{:.{d}f}".format(value, d=digits)
    return str(value)


def format_table(rows, columns, digits=4):
    header = [c for c in columns]
    body = [[_fmt(r.get(c), digits) for c in columns] for r in rows]
    widths = [len(h) for h in header]
    for line in body:
        for i, cell in enumerate(line):
            widths[i] = max(widths[i], len(cell))
    out = [" ".join(h.ljust(widths[i]) for i, h in enumerate(header))]
    out.append(" ".join("-" * w for w in widths))
    for line in body:
        out.append(" ".join(cell.rjust(widths[i]) for i, cell in enumerate(line)))
    return "\n".join(out)


def build_analysis(args):
    records = eco.load_event_records(
        args.db, session_id=args.session_id, theta_a=args.theta_a, theta_b=args.theta_b
    )
    file_paths = eco.load_file_paths(args.db, session_id=args.session_id)
    meta_table = eco.read_deployment_metadata(args.metadata) if args.metadata else {}
    records = eco.join_deployment_metadata(records, metadata=meta_table)

    effort = eco.measure_effort_hours(file_paths, args.effort_hours) if args.measure_effort else None

    recorder_rows = eco.recorder_summary(
        records,
        effort_hours_per_file=args.effort_hours,
        file_paths=file_paths,
        retained_only=not args.all_events,
        metadata=eco.metadata_by_recorder(meta_table),
        effort_by_path=effort["hours"] if effort else None,
    )
    band_rows = eco.band_summary(recorder_rows)
    models = eco.fit_elevation_models(recorder_rows, alpha=args.alpha)
    models["band_rate_ordering"] = eco.band_rate_ordering(band_rows)
    models["effort_hours_per_file"] = args.effort_hours
    models["effort_source"] = (
        {"mode": "measured", "n_measured": effort["n_measured"],
         "n_defaulted": effort["n_defaulted"], "soundfile_available": effort["available"]}
        if effort else {"mode": "assumed"}
    )
    models["event_set"] = "all events" if args.all_events else "retained events"
    models["theta_a"] = args.theta_a
    models["theta_b"] = args.theta_b
    return records, recorder_rows, band_rows, models


def print_report(recorder_rows, band_rows, models):
    print("Recorder-level summary (unit of replication)")
    print(format_table(recorder_rows, RECORDER_COLUMNS))
    print()
    print("Band-level summary (means across recorders within band)")
    print(format_table(band_rows, BAND_COLUMNS))
    print()
    source = models.get("effort_source") or {"mode": "assumed"}
    if source["mode"] == "measured":
        effort_note = "measured from audio headers ({} read, {} fell back to {} h)".format(
            source["n_measured"], source["n_defaulted"], models["effort_hours_per_file"])
    else:
        effort_note = "assumed {} h/file".format(models["effort_hours_per_file"])
    print("Event set: {}   effort: {}".format(models["event_set"], effort_note))
    print("Recorders with a known elevation: {} of {}".format(
        models["n_recorders_with_elevation"], models["n_recorders_total"]))
    ordering = models.get("band_rate_ordering") or "-"
    print("Band ordering by mean rate/hour (high to low): {}".format(ordering))
    print()

    for key in ("p1", "p2"):
        block = models[key]
        primary = block["primary"]
        print("[{}] {}".format(key.upper(), block["prediction"]))
        print("  model     : {}".format(primary["model"]))
        if block.get("preferred_reason"):
            print("  selection : {}".format(block["preferred_reason"]))
        print("  estimate  : {}  (se {})".format(_fmt(primary["estimate"], 6), _fmt(primary["se"], 6)))
        print("  95% CI    : [{}, {}]".format(_fmt(primary["ci_low"], 6), _fmt(primary["ci_high"], 6)))
        print("  p-value   : {}".format(_fmt(primary["p_value"], 6)))
        print("  n         : {} recorders".format(primary["n"]))
        print("  VERDICT   : {}".format(primary["verdict"]))
        for name, res in block["models"].items():
            if name == block.get("preferred"):
                continue
            print("  also [{}]: estimate {} p {} -> {}".format(
                name, _fmt(res["estimate"], 6), _fmt(res["p_value"], 6), res["status"]))
        print()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="path to batch.db")
    ap.add_argument("--metadata", help="deployment metadata CSV (device_id,site_id,elevation_m,lat,lon)")
    ap.add_argument("--session-id", type=int, default=None)
    ap.add_argument("--theta-a", type=float, default=None,
                    help="override theta_A; retention is recomputed from stage_a_conf")
    ap.add_argument("--theta-b", type=float, default=None,
                    help="override theta_B; retention is recomputed from completeness_score")
    ap.add_argument("--out", default="output/ecology", help="output directory")
    ap.add_argument("--measure-effort", action="store_true",
                    help="read each file's true duration from its audio header instead of "
                         "assuming --effort-hours; unreadable files fall back to it")
    ap.add_argument("--effort-hours", type=float, default=eco.DEFAULT_EFFORT_HOURS_PER_FILE,
                    help="recording effort per file in hours (default 0.25 = 15 min)")
    ap.add_argument("--alpha", type=float, default=eco.ALPHA)
    ap.add_argument("--all-events", action="store_true",
                    help="summarize every event instead of the retained set")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit machine-readable JSON on stdout")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("Error: database not found at {}".format(args.db), file=sys.stderr)
        return 2

    _, recorder_rows, band_rows, models = build_analysis(args)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "recorder_summary.csv", RECORDER_COLUMNS, recorder_rows)
    write_csv(out_dir / "band_summary.csv", BAND_COLUMNS, band_rows)
    with open(out_dir / "models.json", "w", encoding="utf-8") as fh:
        json.dump(models, fh, indent=2)

    if args.as_json:
        json.dump(
            {
                "recorder_summary": recorder_rows,
                "band_summary": band_rows,
                "models": models,
                "outputs": {
                    "recorder_summary_csv": str(out_dir / "recorder_summary.csv"),
                    "band_summary_csv": str(out_dir / "band_summary.csv"),
                    "models_json": str(out_dir / "models.json"),
                },
            },
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
    else:
        print_report(recorder_rows, band_rows, models)
        print("Wrote {}, {}, {}".format(
            out_dir / "recorder_summary.csv",
            out_dir / "band_summary.csv",
            out_dir / "models.json",
        ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
