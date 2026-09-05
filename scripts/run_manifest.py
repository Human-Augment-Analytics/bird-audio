#!/usr/bin/env python3
"""Emit or compare run manifests that pin a pipeline run's processing choices.

    uv run python scripts/run_manifest.py --db data/batch.db --out output/run_manifest.json
    uv run python scripts/run_manifest.py --compare a.json b.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from birdpipe.provenance import (  # noqa: E402
    build_manifest, diff_manifests, is_reproducible,
    read_manifest, write_manifest,
)


def cmd_emit(args: argparse.Namespace) -> int:
    model_paths = {}
    if args.localizer:
        model_paths["localizer"] = args.localizer
    if args.classifier:
        model_paths["classifier"] = args.classifier
    if args.classifier_c:
        model_paths["classifier_c"] = args.classifier_c

    manifest = build_manifest(
        db_path=args.db,
        session_id=args.session_id,
        model_paths=model_paths,
    )

    if args.out:
        target = write_manifest(args.out, manifest)
        if not args.json:
            print(f"Wrote manifest: {target}")
    if args.json or not args.out:
        print(json.dumps(manifest, indent=2, sort_keys=True, default=str))

    if not args.json:
        missing = [role for role, m in manifest["models"].items() if m["sha256"] is None]
        if missing:
            print(f"Warning: model weights not found for: {', '.join(missing)}", file=sys.stderr)
        session = manifest.get("session")
        if session:
            print(
                f"Session {session.get('id')}: {session.get('n_events')} events, "
                f"{session.get('n_retained')} retained, "
                f"theta_a={session.get('theta_a')} theta_b={session.get('theta_b')}"
            )
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    left_path, right_path = args.compare
    left, right = read_manifest(left_path), read_manifest(right_path)
    diffs = diff_manifests(left, right)
    reproducible = is_reproducible(diffs)

    if args.json:
        print(json.dumps({"reproducible": reproducible, "n_diffs": len(diffs), "diffs": diffs}, indent=2, default=str))
        return 0 if reproducible else 1

    if not diffs:
        print("Manifests are identical (ignoring timestamps).")
        return 0

    print(f"{len(diffs)} field(s) differ between:\n  A: {left_path}\n  B: {right_path}\n")
    for d in diffs:
        print(f"  {d['field']}\n    A: {d['left']}\n    B: {d['right']}")
    print()
    if reproducible:
        print("REPRODUCIBLE: determining code, runtime, configuration, and model weights are identical.")
        return 0
    print("NOT REPRODUCIBLE: determining code, runtime, configuration, or model weights differ.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Pipeline run provenance manifest")
    parser.add_argument("--db", type=str, default=None, help="batch.db to record session config from")
    parser.add_argument("--session-id", type=int, default=None, help="Session to record (default: most recent)")
    parser.add_argument("--out", type=str, default=None, help="Write manifest JSON here")
    parser.add_argument("--localizer", type=str, default=None, help="Override Stage A weights path")
    parser.add_argument("--classifier", type=str, default=None, help="Override Stage B weights path")
    parser.add_argument("--classifier-c", type=str, default=None, help="Override Stage C weights path")
    parser.add_argument("--compare", nargs=2, metavar=("A", "B"), default=None,
                        help="Compare two manifests instead of emitting one")
    parser.add_argument("--json", action="store_true", help="Machine-readable stdout")
    args = parser.parse_args()

    if args.compare:
        return cmd_compare(args)
    return cmd_emit(args)


if __name__ == "__main__":
    raise SystemExit(main())
