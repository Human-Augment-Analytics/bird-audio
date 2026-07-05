import pytest
from unittest.mock import MagicMock, patch
import torch
from scripts.ml_engine import BirdAudioPipeline

def test_get_model_cpu_fallback():
    with patch("scripts.ml_engine.YOLO") as mock_yolo:
        mock_model = MagicMock()
        
        def to_side_effect(device):
            if device.type == "cuda":
                raise RuntimeError("CUDA out of memory")
            return mock_model
        
        mock_model.to.side_effect = to_side_effect
        mock_yolo.return_value = mock_model
        
        pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None)
        pipeline.device = torch.device("cuda")
        
        with patch("scripts.ml_engine.os.path.exists", return_value=True):
            model = pipeline._get_model("dummy_path.pt")
            assert pipeline.device.type == "cpu"
            assert model == mock_model

def test_process_file_model_load_failure():
    pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None)
    with patch.object(pipeline, "_get_model", side_effect=RuntimeError("Model corrupted")):
        result = pipeline.process_file("dummy.wav", localizer="some_localizer.pt")
        assert result["status"] == "error"
        assert "Failed to load model: Model corrupted" in result["message"]

def test_frequency_bounds_validation():
    pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None)
    # Test negative f_min
    result1 = pipeline.process_file("dummy.wav", f_min_hz=-100.0)
    assert result1["status"] == "error"
    assert "Invalid frequency bounds" in result1["message"]
    
    # Test f_min >= f_max
    result2 = pipeline.process_file("dummy.wav", f_min_hz=8000.0, f_max_hz=7000.0)
    assert result2["status"] == "error"
    assert "Invalid frequency bounds" in result2["message"]

import numpy as np
import soundfile as sf

class DummyPyTorchModel(torch.nn.Module):
    def __init__(self, names):
        super().__init__()
        self.names = names
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))
    def forward(self, x):
        logits = torch.zeros((1, len(self.names)))
        logits[0, 1] = 10.0 # Class 1 has high score
        return logits

class DummyPyTorchModelFailing(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))
    def forward(self, x):
        raise RuntimeError("Forward pass failed")

def test_non_yolo_stage_c_classifier(tmp_path):
    wav_path = tmp_path / "test.wav"
    sr = 48000
    y = np.zeros(int(3.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    from tests.test_stage_c import FakeResult, FakeClassifierResult

    mock_localizer = MagicMock()
    mock_localizer.return_value = [FakeResult([[0.5, 0.5, 0.2, 0.2]], [0.85])]

    mock_classifier_b = MagicMock()
    mock_classifier_b.return_value = [FakeClassifierResult({0: "full", 1: "not_full"}, [0.9, 0.1], 0)]

    mock_classifier_c = DummyPyTorchModel({0: "other", 1: "hlw_species"})

    def dummy_yolo(path, *args, **kwargs):
        if "localizer" in str(path):
            return mock_localizer
        elif "classifier_b" in str(path):
            return mock_classifier_b
        raise Exception("Not a YOLO model")

    with patch("scripts.ml_engine.YOLO", side_effect=dummy_yolo), \
         patch("scripts.ml_engine.os.path.exists", return_value=True), \
         patch("scripts.ml_engine.torch.load", return_value=mock_classifier_c):
        
        pipeline = BirdAudioPipeline(
            localizer_path="dummy_localizer.pt",
            classifier_path="dummy_classifier_b.pt",
            device="cpu"
        )
        
        result = pipeline.process_file(
            str(wav_path),
            theta_a=0.1,
            theta_b=0.5,
            classifier_c="dummy_classifier_c.pt"
        )
        
        assert result["status"] == "success"
        assert result["n_events"] > 0
        assert result["n_retained"] > 0
        for event in result["events"]:
            if event["retained"]:
                assert event["stage_c_label"] == "hlw_species"
                assert event["stage_c_score"] > 0.99

def test_non_yolo_stage_c_classifier_failing(tmp_path):
    wav_path = tmp_path / "test.wav"
    sr = 48000
    y = np.zeros(int(3.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    from tests.test_stage_c import FakeResult, FakeClassifierResult

    mock_localizer = MagicMock()
    mock_localizer.return_value = [FakeResult([[0.5, 0.5, 0.2, 0.2]], [0.85])]

    mock_classifier_b = MagicMock()
    mock_classifier_b.return_value = [FakeClassifierResult({0: "full", 1: "not_full"}, [0.9, 0.1], 0)]

    mock_classifier_c = DummyPyTorchModelFailing()

    def dummy_yolo(path, *args, **kwargs):
        if "localizer" in str(path):
            return mock_localizer
        elif "classifier_b" in str(path):
            return mock_classifier_b
        raise Exception("Not a YOLO model")

    with patch("scripts.ml_engine.YOLO", side_effect=dummy_yolo), \
         patch("scripts.ml_engine.os.path.exists", return_value=True), \
         patch("scripts.ml_engine.torch.load", return_value=mock_classifier_c):
        
        pipeline = BirdAudioPipeline(
            localizer_path="dummy_localizer.pt",
            classifier_path="dummy_classifier_b.pt",
            device="cpu"
        )
        
        result = pipeline.process_file(
            str(wav_path),
            theta_a=0.1,
            theta_b=0.5,
            classifier_c="dummy_classifier_c.pt"
        )
        
        assert result["status"] == "success"
        assert result["n_events"] > 0
        assert result["n_retained"] > 0
        for event in result["events"]:
            if event["retained"]:
                assert event["stage_c_label"] == "unknown"
                assert event["stage_c_score"] == 0.0



