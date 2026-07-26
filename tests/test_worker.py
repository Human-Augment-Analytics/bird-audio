from __future__ import annotations

import io
import json

from birdpipe import constants as C
from birdpipe import worker


class _FakePipeline:
    device = "cpu"
    localizer_path = "models/buzz_localizer.pt"
    classifier_path = "models/classifier.pt"

    def process_file(self, input_path, output_root="output", write_artifacts=False,
                     theta_a=0.0, theta_b=0.530306, emit_raw=False):
        if input_path == "BOOM":
            raise ValueError("boom")
        return {"status": "success", "input": input_path, "n_windows": 3,
                "n_raw": 1, "elapsed_ms": 5, "events": []}


def _run(lines):
    out = io.StringIO()
    worker.run_worker(_FakePipeline(), in_stream=iter(lines), out_stream=out)
    return [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]


def test_ready_line_emitted_first():
    msgs = _run([])
    assert msgs[0]["type"] == "ready"
    assert msgs[0]["device"] == "cpu"


def test_ready_carries_run_manifest():
    manifest = _run([])[0]["manifest"]
    assert manifest is not None
    for section in ("schema_version", "generated_at", "git", "environment", "models", "constants"):
        assert section in manifest, f"missing manifest section: {section}"
    assert set(manifest["models"]) == {"localizer", "classifier"}
    assert manifest["models"]["localizer"]["path"] == "models/buzz_localizer.pt"
    assert manifest["constants"]["F_MIN_HZ"] == C.F_MIN_HZ
    assert manifest["extra"]["device"] == "cpu"


def test_manifest_failure_still_yields_usable_ready(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("no provenance today")

    monkeypatch.setattr(worker.provenance, "build_manifest", boom)
    msgs = _run([json.dumps({"id": 3, "input": "/a.wav"})])
    assert msgs[0] == {"type": "ready", "device": "cpu", "manifest": None}
    assert msgs[1]["type"] == "result" and msgs[1]["id"] == 3


def test_processes_job_and_returns_result():
    job = json.dumps({"id": 7, "input": "/a.wav", "manifest_only": True})
    msgs = _run([job])
    assert msgs[1]["type"] == "result"
    assert msgs[1]["id"] == 7
    assert msgs[1]["input"] == "/a.wav"


def test_bad_file_emits_error_and_loop_survives():
    jobs = [json.dumps({"id": 1, "input": "BOOM"}),
            json.dumps({"id": 2, "input": "/ok.wav"})]
    msgs = _run(jobs)
    assert msgs[1]["type"] == "error" and msgs[1]["id"] == 1
    assert msgs[2]["type"] == "result" and msgs[2]["id"] == 2  # survived
