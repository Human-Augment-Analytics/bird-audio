#!/usr/bin/env python3
"""Protocol-faithful fake worker for batch-core tests (no Torch).

Emits a ready line, then per job: a result, an error (input contains BOOM),
hangs forever (input contains HANG), or crashes (input contains CRASH).
"""
import json
import os
import sys
import time

MANIFEST = {
    "schema_version": 1,
    "models": {"localizer": {"path": "models/fake.pt", "sha256": "0" * 64, "bytes": 1}},
    "constants": {"F_MIN_HZ": 3000.0},
    "environment": {"python": "fake"},
    "extra": {"device": "cpu", "worker_pid": os.getpid()},
}

print(json.dumps({"type": "ready", "device": "cpu", "manifest": MANIFEST}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid = req.get("id")
    inp = req.get("input", "")
    if "BOOM" in inp:
        print(json.dumps({"type": "error", "id": rid, "input": inp, "message": "boom"}), flush=True)
    elif "HANG" in inp:
        time.sleep(3600)
    elif "CRASH" in inp:
        sys.exit(1)
    else:
        print(json.dumps({
            "type": "result", "id": rid, "input": inp, "status": "success",
            "n_windows": 5, "n_raw": 2, "n_events": 1, "n_complete": 1, "n_retained": 1,
            "elapsed_ms": 3,
            "events": [{
                "t_start": 1.0, "t_end": 2.0, "duration": 1.0, "f_low": 5000, "f_high": 6000,
                "center_freq": 5500, "stage_a_conf": 0.9, "completeness_score": 0.8,
                "completeness_label": "complete", "retained": True, "n_members": 2
            }]
        }), flush=True)
