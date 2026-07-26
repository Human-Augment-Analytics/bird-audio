"""Warm persistent worker: read JSON jobs on stdin, emit result lines on stdout."""
from __future__ import annotations

import json
import sys
import traceback

from birdpipe import provenance

# Pipeline attributes that override a paper constant or name a model, so the manifest
# has to carry the value actually in use rather than the default.
_MODEL_PATH_ATTRS = (
    ("localizer", "localizer_path"),
    ("classifier", "classifier_path"),
    ("classifier_c", "classifier_c_path"),
)
_EXTRA_ATTRS = ("f_min_hz", "f_max_hz", "species_name", "conf")


def _emit(out_stream, obj) -> None:
    out_stream.write(json.dumps(obj) + "\n")
    flush = getattr(out_stream, "flush", None)
    if flush:
        flush()


def build_run_manifest(pipeline) -> dict:
    """Provenance for the models this process actually loaded, for the `ready` line."""
    model_paths = {}
    for role, attr in _MODEL_PATH_ATTRS:
        path = getattr(pipeline, attr, None)
        if path:
            model_paths[role] = str(path)
    extra = {"device": str(getattr(pipeline, "device", "")) or None}
    for attr in _EXTRA_ATTRS:
        value = getattr(pipeline, attr, None)
        if value is not None:
            extra[attr] = value
    return provenance.build_manifest(model_paths=model_paths or None, extra=extra)


def run_worker(pipeline, in_stream=None, out_stream=None) -> None:
    """Loop over newline-delimited JSON jobs. One bad file never stops the loop."""
    in_stream = in_stream if in_stream is not None else sys.stdin
    out_stream = out_stream if out_stream is not None else sys.stdout

    ready = {"type": "ready", "device": str(pipeline.device)}
    try:
        ready["manifest"] = build_run_manifest(pipeline)
    except Exception as exc:  # noqa: BLE001 - provenance must never block a run
        ready["manifest"] = None
        print(f"warning: run manifest unavailable: {exc}", file=sys.stderr)
    _emit(out_stream, ready)

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
