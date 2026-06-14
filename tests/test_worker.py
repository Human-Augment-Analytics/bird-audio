from __future__ import annotations

import io
import json

from birdpipe import worker


class _FakePipeline:
    device = "cpu"

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
    assert msgs[0] == {"type": "ready", "device": "cpu"}


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
