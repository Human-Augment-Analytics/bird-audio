#!/usr/bin/env python3
"""Plan manual verification effort for a batch run.

Answers: how precise is the detector at this threshold, how many more clips
must a human verify to pin that down to a target interval width, and which
clips should be next in the queue.

    uv run python scripts/verification_planner.py --db data/batch.db \
        --threshold 0.5 --target-half-width 0.05 --strategy uncertainty --budget 50
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from birdpipe import verification as V

_EVENT_COLUMNS = (
    "e.id, e.session_id, e.file_id, e.stage_a_conf, e.completeness_score, "
    "e.completeness_label, e.retained, e.review_status, e.source, f.path AS path"
)


def load_events(db_path: str, session_id: Optional[int] = None) -> List[Dict[str, Any]]:
    if not Path(db_path).exists():
        raise SystemExit(f"error: database not found at {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        sql = f"SELECT {_EVENT_COLUMNS} FROM events e JOIN files f ON f.id = e.file_id"
        params: tuple = ()
        if session_id is not None:
            sql += " WHERE e.session_id = ?"
            params = (session_id,)
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def _score_lookup(events: List[Dict[str, Any]]) -> Dict[Any, Dict[str, Any]]:
    return {e["id"]: e for e in events}


def resolve_pace(args: argparse.Namespace) -> Dict[str, Any]:
    """An explicit flag wins; otherwise use recorded telemetry, else the nominal default."""
    if args.seconds_per_verification is not None:
        return {"seconds_per_verification": float(args.seconds_per_verification),
                "source": "flag", "n_decisions": None}
    measured = V.measured_seconds_per_verification(args.db, args.session_id)
    if measured is not None:
        return measured
    return {"seconds_per_verification": V.DEFAULT_SECONDS_PER_VERIFICATION,
            "source": "assumed", "n_decisions": None}


def build_report(events: List[Dict[str, Any]], args: argparse.Namespace) -> Dict[str, Any]:
    est = V.precision_estimate(events, args.threshold, confidence=args.confidence)
    pace = resolve_pace(args)
    effort = V.additional_effort(
        est, args.target_half_width,
        seconds_per_verification=pace["seconds_per_verification"],
    )
    verdict = V.stopping_rule(est, args.target_half_width)
    queue_ids = V.plan_review_queue(
        events,
        args.threshold,
        budget=args.budget,
        strategy=args.strategy,
        rng_seed=args.seed,
        theta_b=args.theta_b,
    )
    lookup = _score_lookup(events)
    queue = [
        {
            "id": eid,
            "stage_a_conf": lookup[eid].get("stage_a_conf"),
            "completeness_score": lookup[eid].get("completeness_score"),
            "file_id": lookup[eid].get("file_id"),
            "path": lookup[eid].get("path"),
        }
        for eid in queue_ids
    ]
    report: Dict[str, Any] = {
        "db": args.db,
        "session_id": args.session_id,
        "threshold": args.threshold,
        "theta_b": args.theta_b,
        "strategy": args.strategy,
        "budget": args.budget,
        "seed": args.seed,
        "pace": pace,
        "precision": est.to_dict(),
        "effort": effort.to_dict(),
        "stopping_rule": verdict,
        "queue": queue,
    }
    if args.sweep:
        thresholds = [round(x / 100.0, 2) for x in range(0, 100, 10)]
        report["sweep"] = [
            row.to_dict()
            for row in V.threshold_sweep_precision(
                events, thresholds, confidence=args.confidence,
                min_evidence=args.min_evidence,
            )
        ]
    return report


def print_report(report: Dict[str, Any]) -> None:
    p = report["precision"]
    e = report["effort"]
    print(f"Verification plan  db={report['db']}  threshold={report['threshold']:.3f}")
    print("-" * 72)
    print(f"Detector detections above threshold : {p['n_above_threshold']}")
    print(f"Verified so far                     : {p['n_verified']} "
          f"({p['n_true']} confirmed, {p['n_verified'] - p['n_true']} rejected)")
    print(f"Still unreviewed                    : {p['n_unreviewed']}")
    if p["point"] is None:
        print("Precision                           : no verified labels yet - cold start, "
              "precision is unknown (not zero)")
    else:
        print(f"Precision                           : {p['point']:.3f}  "
              f"[{p['ci_low']:.3f}, {p['ci_high']:.3f}]  "
              f"(+/-{p['half_width']:.3f} at {p['confidence']:.0%})")
    print()
    print(f"Target half-width                   : {e['target_half_width']:.3f}")
    print(f"Assumed precision for planning      : {e['p_assumed']:.3f}"
          f"{' (conservative 0.5, no data yet)' if p['point'] is None else ''}")
    print(f"Total verifications required        : {e['n_required']}")
    print(f"More verifications needed           : {e['n_additional']}"
          f"{'  (a full census of the pool)' if e['requires_census'] else ''}")
    pace = report["pace"]
    if pace["source"] == "measured":
        pace_note = f"measured from {pace['n_decisions']} recorded decisions"
    elif pace["source"] == "flag":
        pace_note = "supplied on the command line"
    else:
        pace_note = "assumed - no review telemetry recorded yet"
    print(f"Estimated human time                : {e['estimated_minutes']:.1f} min "
          f"at {e['seconds_per_verification']:.1f} s/clip ({pace_note})")
    print()
    verdict = report["stopping_rule"]
    print(f"Stopping rule                       : {'STOP' if verdict['stop'] else 'CONTINUE'}")
    print(f"  {verdict['reason']}")
    print()
    queue = report["queue"]
    print(f"Next {len(queue)} to review (strategy={report['strategy']}, seed={report['seed']}):")
    if not queue:
        print("  (queue empty - nothing unreviewed above this threshold)")
    for row in queue:
        conf = row["stage_a_conf"]
        comp = row["completeness_score"]
        print(f"  event {row['id']:>6}  conf={conf:.4f}  "
              f"completeness={'n/a' if comp is None else f'{comp:.4f}'}  "
              f"file={row['file_id']}")
    if "sweep" in report:
        print()
        print("Threshold sweep")
        print(f"  {'thresh':>7}  {'n>=t':>6}  {'verified':>8}  {'precision':>9}  "
              f"{'95% CI':>18}  evidence")
        for row in report["sweep"]:
            point = "  n/a  " if row["point"] is None else f"{row['point']:.3f}"
            ci = ("      n/a         " if row["point"] is None
                  else f"[{row['ci_low']:.3f}, {row['ci_high']:.3f}]")
            print(f"  {row['threshold']:>7.2f}  {row['n_above_threshold']:>6}  "
                  f"{row['n_verified']:>8}  {point:>9}  {ci:>18}  {row['evidence']}")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="data/batch.db", help="path to batch.db")
    ap.add_argument("--session-id", type=int, default=None, help="restrict to one session")
    ap.add_argument("--threshold", type=float, default=0.5,
                    help="detection-confidence operating point (theta_A)")
    ap.add_argument("--target-half-width", type=float, default=0.05,
                    help="desired +/- width of the precision interval")
    ap.add_argument("--strategy", default="uncertainty", choices=list(V.STRATEGIES))
    ap.add_argument("--budget", type=int, default=25, help="how many ids to queue up")
    ap.add_argument("--seconds-per-verification", type=float, default=None,
                    help="seconds a human spends per clip; default reads recorded "
                         "review telemetry, falling back to "
                         f"{V.DEFAULT_SECONDS_PER_VERIFICATION:g}s")
    ap.add_argument("--confidence", type=float, default=0.95)
    ap.add_argument("--theta-b", type=float, default=V.DEFAULT_THETA_B,
                    help="completeness operating point, used by the completeness strategy")
    ap.add_argument("--min-evidence", type=int, default=V.MIN_EVIDENCE,
                    help="verified labels below which a sweep row is flagged insufficient")
    ap.add_argument("--seed", type=int, default=0, help="rng seed for reproducible queues")
    ap.add_argument("--sweep", action="store_true", help="also print the threshold sweep table")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit a machine-readable object instead of text")
    args = ap.parse_args(argv)

    events = load_events(args.db, args.session_id)
    report = build_report(events, args)
    if args.as_json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
