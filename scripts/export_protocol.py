#!/usr/bin/env python3
"""Export a recorded session as an executable reproduction protocol.

    uv run python scripts/export_protocol.py --db data/batch.db --out output/protocol
    uv run python scripts/export_protocol.py --db data/batch.db --out output/protocol \
        --session-id 1 --metadata deployments.csv --json

Writes `reproduce.sh` (executable), `protocol.json` and `manifest.json`. The manifest is
the reference the script's preflight step compares against.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from birdpipe.protocol import (  # noqa: E402
    build_protocol, render_manifest_json, render_shell_script, verify_protocol,
)
from birdpipe.provenance import write_manifest  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export a reproducible protocol for a session")
    ap.add_argument("--db", required=True, help="path to batch.db")
    ap.add_argument("--out", default="output/protocol", help="output directory")
    ap.add_argument("--session-id", type=int, default=None,
                    help="session to export (default: most recent)")
    ap.add_argument("--metadata", default=None,
                    help="deployment metadata CSV to pass to the analysis steps")
    ap.add_argument("--no-analysis", action="store_true",
                    help="emit only preflight, run and export steps")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="machine-readable stdout")
    args = ap.parse_args(argv)

    try:
        protocol = build_protocol(
            db_path=args.db,
            session_id=args.session_id,
            include_analysis=not args.no_analysis,
            out_dir=args.out,
            metadata=args.metadata,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    script_path = out_dir / "reproduce.sh"
    script_path.write_text(render_shell_script(protocol))
    script_path.chmod(0o755)
    protocol_path = out_dir / "protocol.json"
    protocol_path.write_text(render_manifest_json(protocol))
    manifest_path = write_manifest(out_dir / "manifest.json", protocol.reference_manifest)

    warnings = verify_protocol(protocol)

    if args.as_json:
        print(json.dumps({
            "script": str(script_path),
            "protocol": str(protocol_path),
            "manifest": str(manifest_path),
            "session_id": protocol.session.session_id,
            "steps": [
                {"name": s.name, "optional": s.optional, "command": s.command}
                for s in protocol.steps
            ],
            "warnings": warnings,
        }, indent=2, default=str))
        return 0

    session = protocol.session
    print(f"Session {session.session_id}: {len(session.files)} files, "
          f"{session.n_events} events, {session.n_retained} retained, "
          f"theta_a={session.theta_a!r} theta_b={session.theta_b!r} device={session.device}")
    print(f"Wrote {script_path}\nWrote {protocol_path}\nWrote {manifest_path}\n")
    print(f"{len(protocol.steps)} step(s):")
    for index, step in enumerate(protocol.steps, start=1):
        tag = " [optional]" if step.optional else ""
        print(f"  {index}. {step.name}{tag} — {step.description}")
        print(f"     $ {' '.join(step.command)}")
    if warnings:
        print(f"\n{len(warnings)} warning(s):", file=sys.stderr)
        for warning in warnings:
            print(f"  - {warning}", file=sys.stderr)
    else:
        print("\nNo warnings: inputs, models and git state are all present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
