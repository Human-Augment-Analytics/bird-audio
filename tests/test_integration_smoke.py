from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

MODELS_PRESENT = os.path.exists("models/buzz_localizer.pt") and os.path.exists("models/classifier.pt")
pytestmark = pytest.mark.skipif(not MODELS_PRESENT, reason="model weights not present")


def _write_wav(path, seconds=3.0, sr=48000):
    rng = np.random.default_rng(0)
    sf.write(str(path), rng.normal(0, 0.001, int(seconds * sr)).astype("float32"), sr)


def test_worker_processes_a_tiny_wav(tmp_path):
    wav = tmp_path / "tiny.wav"
    _write_wav(wav)
    proc = subprocess.run(
        [sys.executable, "scripts/ml_engine.py", "--worker", "--device", "cpu"],
        input=json.dumps({"id": 1, "input": str(wav), "manifest_only": True}) + "\n",
        capture_output=True, text=True, timeout=600,
    )
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip().startswith("{")]
    assert lines[0]["type"] == "ready"
    result = next(m for m in lines if m.get("type") == "result")
    assert result["id"] == 1
    assert result["status"] == "success"
    assert "events" in result and isinstance(result["events"], list)
    assert "n_windows" in result
