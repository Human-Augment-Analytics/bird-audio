#!/usr/bin/env python3
"""
Threshold sensitivity of the ecological conclusions.

A detection pipeline's thresholds are chosen, not observed. This sweeps a grid of
theta_A x theta_B, recomputes retention, rebuilds recorder summaries and refits
both manuscript predictions in every cell, then reports whether the verdicts and
the slope signs survive the choice.

Usage:
  uv run python scripts/threshold_sensitivity.py --db data/batch.db \
      --metadata deployments.csv --out output/ecology/sensitivity
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

# Ensure the repo root is on sys.path
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from birdpipe import ecology as eco
from scripts.ecological_analysis import write_csv

GRID_COLUMNS = [
    "theta_a", "theta_b", "n_events_retained", "n_recorders",
    "n_recorders_with_elevation",
    "p1_model", "p1_slope", "p1_se", "p1_p_value", "p1_status",
    "p1_spearman_rho", "p1_spearman_p",
    "p2_slope", "p2_se", "p2_p_value", "p2_status",
    "p2_spearman_rho", "p2_spearman_p",
    "band_rate_ordering",
]


def frange(start, stop, step, digits=6):
    """Inclusive float range, rounded so grid labels stay exact."""
    if step <= 0:
        raise ValueError("step must be positive")
    values = []
    n = int(round((stop - start) / step)) + 1
    for i in range(max(n, 1)):
        v = round(start + i * step, digits)
        if v > stop + 1e-9:
            break
        values.append(v)
    return values


def _sign(value):
    if value is None:
        return 0
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def evaluate_cell(base_records, file_paths, meta_by_recorder, theta_a, theta_b, args):
    records = eco.apply_thresholds(base_records, theta_a, theta_b)
    recorder_rows = eco.recorder_summary(
        records,
        effort_hours_per_file=args.effort_hours,
        file_paths=file_paths,
        retained_only=True,
        metadata=meta_by_recorder,
    )
    band_rows = eco.band_summary(recorder_rows)
    models = eco.fit_elevation_models(recorder_rows, alpha=args.alpha)

    p1, p2 = models["p1"], models["p2"]
    p1_primary, p2_primary = p1["primary"], p2["primary"]
    p1_spear = p1["models"]["spearman"]
    p2_spear = p2["models"]["spearman"]

    return {
        "theta_a": theta_a,
        "theta_b": theta_b,
        "n_events_retained": sum(r["n_events"] for r in recorder_rows),
        "n_recorders": models["n_recorders_total"],
        "n_recorders_with_elevation": models["n_recorders_with_elevation"],
        "p1_model": p1_primary["model"],
        "p1_slope": p1_primary["estimate"],
        "p1_se": p1_primary["se"],
        "p1_p_value": p1_primary["p_value"],
        "p1_status": p1_primary["status"],
        "p1_spearman_rho": p1_spear["estimate"],
        "p1_spearman_p": p1_spear["p_value"],
        "p2_slope": p2_primary["estimate"],
        "p2_se": p2_primary["se"],
        "p2_p_value": p2_primary["p_value"],
        "p2_status": p2_primary["status"],
        "p2_spearman_rho": p2_spear["estimate"],
        "p2_spearman_p": p2_spear["p_value"],
        "band_rate_ordering": eco.band_rate_ordering(band_rows),
    }


def stability_for(cells, prefix, baseline_status):
    statuses = [c["{}_status".format(prefix)] for c in cells]
    slopes = [c["{}_slope".format(prefix)] for c in cells if c["{}_slope".format(prefix)] is not None]
    counts = Counter(statuses)
    modal_status, modal_n = counts.most_common(1)[0] if counts else (None, 0)
    signs = {_sign(s) for s in slopes if _sign(s) != 0}
    n = len(cells)
    return {
        "verdict_counts": dict(counts),
        "modal_verdict": modal_status,
        "modal_fraction": (modal_n / n) if n else None,
        "baseline_verdict": baseline_status,
        "fraction_matching_baseline": (
            sum(1 for s in statuses if s == baseline_status) / n if n and baseline_status else None
        ),
        "n_cells": n,
        "n_cells_fitted": len(slopes),
        "slope_min": min(slopes) if slopes else None,
        "slope_max": max(slopes) if slopes else None,
        "sign_flips": len(signs) > 1,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="path to batch.db")
    ap.add_argument("--metadata", help="deployment metadata CSV")
    ap.add_argument("--session-id", type=int, default=None)
    ap.add_argument("--out", default="output/ecology/sensitivity", help="output directory")
    ap.add_argument("--theta-a-range", nargs=3, type=float, metavar=("MIN", "MAX", "STEP"),
                    default=[0.3, 0.8, 0.1])
    ap.add_argument("--theta-b-range", nargs=3, type=float, metavar=("MIN", "MAX", "STEP"),
                    default=[0.3, 0.8, 0.1])
    ap.add_argument("--effort-hours", type=float, default=eco.DEFAULT_EFFORT_HOURS_PER_FILE)
    ap.add_argument("--alpha", type=float, default=eco.ALPHA)
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit machine-readable JSON on stdout")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("Error: database not found at {}".format(args.db), file=sys.stderr)
        return 2

    base_records = eco.load_event_records(args.db, session_id=args.session_id)
    file_paths = eco.load_file_paths(args.db, session_id=args.session_id)
    meta_table = eco.read_deployment_metadata(args.metadata) if args.metadata else {}
    base_records = eco.join_deployment_metadata(base_records, metadata=meta_table)
    meta_by_recorder = eco.metadata_by_recorder(meta_table)

    thetas_a = frange(*args.theta_a_range)
    thetas_b = frange(*args.theta_b_range)

    cells = [
        evaluate_cell(base_records, file_paths, meta_by_recorder, ta, tb, args)
        for ta in thetas_a
        for tb in thetas_b
    ]

    stored = eco.session_thetas(args.db, args.session_id)
    baseline = None
    if stored:
        baseline = evaluate_cell(
            base_records, file_paths, meta_by_recorder,
            stored["theta_a"], stored["theta_b"], args,
        )

    stability = {
        "grid": {
            "theta_a": thetas_a,
            "theta_b": thetas_b,
            "n_cells": len(cells),
        },
        "baseline": {
            "theta_a": stored["theta_a"] if stored else None,
            "theta_b": stored["theta_b"] if stored else None,
            "p1_status": baseline["p1_status"] if baseline else None,
            "p2_status": baseline["p2_status"] if baseline else None,
            "band_rate_ordering": baseline["band_rate_ordering"] if baseline else None,
        },
        "p1": stability_for(cells, "p1", baseline["p1_status"] if baseline else None),
        "p2": stability_for(cells, "p2", baseline["p2_status"] if baseline else None),
        "band_rate_ordering": {},
        "n_recorders_with_elevation": (
            max(c["n_recorders_with_elevation"] for c in cells) if cells else 0),
        "retained_events_min": min(c["n_events_retained"] for c in cells) if cells else None,
        "retained_events_max": max(c["n_events_retained"] for c in cells) if cells else None,
    }
    ordering_counts = Counter(c["band_rate_ordering"] for c in cells)
    if ordering_counts:
        modal_order, modal_n = ordering_counts.most_common(1)[0]
        stability["band_rate_ordering"] = {
            "counts": dict(ordering_counts),
            "modal": modal_order,
            "modal_fraction": modal_n / len(cells),
            "n_distinct": len(ordering_counts),
        }

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "sensitivity_grid.csv", GRID_COLUMNS, cells)
    with open(out_dir / "stability.json", "w", encoding="utf-8") as fh:
        json.dump(stability, fh, indent=2)

    if args.as_json:
        json.dump({"grid": cells, "stability": stability}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print("Threshold sensitivity over {} cells (theta_A {} x theta_B {})".format(
        len(cells), thetas_a, thetas_b))
    print("Retained events across the grid: {} - {}".format(
        stability["retained_events_min"], stability["retained_events_max"]))
    if baseline:
        print("Baseline (session thetas): theta_A={} theta_B={} -> P1 {} / P2 {}".format(
            stored["theta_a"], stored["theta_b"], baseline["p1_status"], baseline["p2_status"]))
    print()
    for key, label in (("p1", eco.P1_TEXT), ("p2", eco.P2_TEXT)):
        s = stability[key]
        print("[{}] {}".format(key.upper(), label))
        print("  verdicts        : {}".format(s["verdict_counts"]))
        print("  modal verdict   : {} in {:.0%} of cells".format(
            s["modal_verdict"], s["modal_fraction"] or 0.0))
        if s["fraction_matching_baseline"] is not None:
            print("  matches baseline: {:.0%} of cells".format(s["fraction_matching_baseline"]))
        print("  slope range     : {} to {} ({} of {} cells fitted)".format(
            s["slope_min"], s["slope_max"], s["n_cells_fitted"], s["n_cells"]))
        print("  sign flips      : {}".format("YES" if s["sign_flips"] else "no"))
        print()
    order = stability["band_rate_ordering"]
    if order:
        print("Band ordering by rate/hour: {} in {:.0%} of cells ({} distinct orderings)".format(
            order["modal"] or "(none)", order["modal_fraction"], order["n_distinct"]))
    fitted = stability["p1"]["n_cells_fitted"] + stability["p2"]["n_cells_fitted"]
    stable = (
        fitted > 0
        and not stability["p1"]["sign_flips"]
        and not stability["p2"]["sign_flips"]
        and (stability["p1"]["modal_fraction"] or 0) == 1.0
        and (stability["p2"]["modal_fraction"] or 0) == 1.0
    )
    if fitted == 0:
        # Uniform INCONCLUSIVE because nothing could be fitted is not stability.
        message = ("no grid cell produced a fittable model ({} recorders with a known "
                   "elevation) -- the sweep is uninformative, not stable".format(
                       stability["n_recorders_with_elevation"]))
    elif stable:
        message = "conclusions are invariant across the whole threshold grid"
    else:
        message = "conclusions change across the threshold grid -- see sensitivity_grid.csv"
    print()
    print("STABILITY: {}".format(message))
    print("Wrote {}, {}".format(
        out_dir / "sensitivity_grid.csv", out_dir / "stability.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
