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


def test_narrow_and_nyquist_frequency_bounds(tmp_path):
    import numpy as np
    import soundfile as sf
    from scripts.ml_engine import BirdAudioPipeline
    
    wav_path = tmp_path / "test_bounds.wav"
    sr = 16000
    y = np.zeros(int(1.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None)
    
    # 1. Minimum frequency exceeding Nyquist (sr/2.0 = 8000 Hz)
    res_nyquist = pipeline.process_file(str(wav_path), f_min_hz=9000.0, f_max_hz=10000.0)
    assert res_nyquist["status"] == "error"
    assert "must be below the Nyquist frequency" in res_nyquist["message"]

    # 2. Too narrow frequency range resulting in less than 1 bin
    # For n_fft = 1024, sr = 16000, 1 bin maps to 16000 / 1024 = 15.625 Hz.
    # If f_min = 2000 and f_max = 2005: both round to index round(2000 * 1024 / 16000) = 128.
    res_narrow = pipeline.process_file(str(wav_path), f_min_hz=2000.0, f_max_hz=2005.0)
    assert res_narrow["status"] == "error"
    assert "maps to less than 1 bin" in res_narrow["message"]


class DummyStageBPyTorchModel(torch.nn.Module):
    def __init__(self, out_features=2):
        super().__init__()
        self.out_features = out_features
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))
    def forward(self, x):
        # x is expected to be [1, 3, 288, 288]
        assert x.shape == (1, 3, 288, 288)
        if self.out_features == 1:
            return torch.tensor([[10.0]])
        else:
            return torch.tensor([[-10.0, 10.0]])


def test_stageb_classify_crop():
    from birdpipe import stageb
    
    # Test standard PyTorch model (dim=1)
    model_dim1 = DummyStageBPyTorchModel(out_features=1)
    crop = np.zeros((288, 288, 3), dtype=np.uint8)
    prob1 = stageb.classify_crop(model_dim1, crop)
    assert isinstance(prob1, float)
    assert prob1 > 0.99
    
    # Test standard PyTorch model (dim=2)
    model_dim2 = DummyStageBPyTorchModel(out_features=2)
    prob2 = stageb.classify_crop(model_dim2, crop)
    assert isinstance(prob2, float)
    assert prob2 > 0.99
    
    # Test YOLO-like model mock
    mock_yolo_model = MagicMock()
    mock_yolo_result = MagicMock()
    mock_yolo_result.names = {0: "not_full", 1: "full"}
    mock_yolo_result.probs.data = torch.tensor([0.1, 0.9])
    mock_yolo_model.return_value = [mock_yolo_result]
    mock_yolo_model.names = {0: "not_full", 1: "full"}
    
    prob_yolo = stageb.classify_crop(mock_yolo_model, crop, complete_class="full")
    assert isinstance(prob_yolo, float)
    assert abs(prob_yolo - 0.9) < 1e-5



