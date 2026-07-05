"""Warm persistent worker: read JSON jobs on stdin, emit result lines on stdout."""
from __future__ import annotations

import json
import sys
import traceback


def _emit(out_stream, obj) -> None:
    out_stream.write(json.dumps(obj) + "\n")
    flush = getattr(out_stream, "flush", None)
    if flush:
        flush()


def run_worker(pipeline, in_stream=None, out_stream=None) -> None:
    """Loop over newline-delimited JSON jobs. One bad file never stops the loop."""
    in_stream = in_stream if in_stream is not None else sys.stdin
    out_stream = out_stream if out_stream is not None else sys.stdout

    _emit(out_stream, {"type": "ready", "device": str(pipeline.device)})

    for line in in_stream:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001 - report and continue
            _emit(out_stream, {"type": "error", "message": f"bad request json: {exc}"})
            continue
        rid = req.get("id")
        try:
            import inspect
            sig = inspect.signature(pipeline.process_file)
            has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
            kwargs = {
                "output_root": req.get("output", "output"),
                "write_artifacts": not req.get("manifest_only", True),
                "theta_a": req.get("theta_a", 0.0),
                "theta_b": req.get("theta_b", 0.530306),
                "emit_raw": req.get("emit_raw", False),
            }
            extra = {
                "localizer": req.get("localizer"),
                "classifier": req.get("classifier"),
                "classifier_c": req.get("classifier_c"),
                "f_min_hz": req.get("f_min_hz"),
                "f_max_hz": req.get("f_max_hz"),
            }
            for k, v in extra.items():
                if has_var_keyword or k in sig.parameters:
                    kwargs[k] = v

            result = pipeline.process_file(req["input"], **kwargs)
            if result.get("status") == "error":
                result["type"] = "error"
            else:
                result["type"] = "result"
            result["id"] = rid
            _emit(out_stream, result)
        except Exception as exc:  # noqa: BLE001 - per-file isolation
            _emit(out_stream, {"type": "error", "id": rid, "input": req.get("input"),
                               "message": str(exc), "traceback": traceback.format_exc()})
