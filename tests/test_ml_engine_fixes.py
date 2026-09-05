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


class DummyBinaryStageCModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))

    def forward(self, x):
        return torch.tensor([[3.0]])

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

        pipeline.classifier_c = DummyBinaryStageCModel()
        binary_result = pipeline.process_file(
            str(wav_path), theta_a=0.1, theta_b=0.5, species_name="hlw_species"
        )
        assert binary_result["status"] == "success"
        retained = [event for event in binary_result["events"] if event["retained"]]
        assert retained
        assert all(event["stage_c_label"] == "hlw_species" for event in retained)
        assert all(event["stage_c_score"] > 0.9 for event in retained)

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
        
        assert result["status"] == "error"
        assert "Failed to execute Stage C classifier" in result["message"]


def test_narrow_and_nyquist_frequency_bounds(tmp_path):
    import numpy as np
    import soundfile as sf
    from scripts.ml_engine import BirdAudioPipeline
    
    wav_path = tmp_path / "test_bounds.wav"
    sr = 48000
    y = np.zeros(int(1.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None)
    
    # 1. Minimum frequency exceeding Nyquist (sr/2.0 = 24000 Hz)
    res_nyquist = pipeline.process_file(str(wav_path), f_min_hz=25000.0, f_max_hz=26000.0)
    assert res_nyquist["status"] == "error"
    assert "must be below the Nyquist frequency" in res_nyquist["message"]

    # 2. Too narrow frequency range resulting in less than 1 bin
    # For n_fft = 1024, sr = 48000, one bin spans 46.875 Hz.
    res_narrow = pipeline.process_file(str(wav_path), f_min_hz=2000.0, f_max_hz=2005.0)
    assert res_narrow["status"] == "error"
    assert "maps to less than 1 bin" in res_narrow["message"]


class DummyStageBPyTorchModel(torch.nn.Module):
    def __init__(self, out_features=2, return_high_at_idx=0):
        super().__init__()
        self.out_features = out_features
        self.return_high_at_idx = return_high_at_idx
        self.dummy_param = torch.nn.Parameter(torch.zeros(1))
    def forward(self, x):
        # x is expected to be [1, 3, 288, 288]
        assert x.shape == (1, 3, 288, 288)
        if self.out_features == 1:
            return torch.tensor([[10.0]])
        else:
            logits = torch.full((1, self.out_features), -10.0)
            logits[0, self.return_high_at_idx] = 10.0
            return logits


def test_stageb_classify_crop():
    from birdpipe import stageb
    
    # Test standard PyTorch model (dim=1)
    model_dim1 = DummyStageBPyTorchModel(out_features=1)
    crop = np.zeros((288, 288, 3), dtype=np.uint8)
    prob1 = stageb.classify_crop(model_dim1, crop)
    assert isinstance(prob1, float)
    assert prob1 > 0.99
    model_dim1.positive_class = "not_full"
    with pytest.raises(ValueError, match="positive_class"):
        stageb.classify_crop(model_dim1, crop)
    
    # A multi-class model without semantic class metadata is ambiguous. Guessing
    # index 0 previously made model-export changes silently invert completeness.
    model_dim2 = DummyStageBPyTorchModel(out_features=2, return_high_at_idx=0)
    with pytest.raises(ValueError, match="refusing to guess"):
        stageb.classify_crop(model_dim2, crop)
    
    # Test standard PyTorch model (dim=2) resolving index dynamically via names
    model_dim2_dynamic = DummyStageBPyTorchModel(out_features=2, return_high_at_idx=1)
    model_dim2_dynamic.names = {0: "not_full", 1: "full"}
    prob3 = stageb.classify_crop(model_dim2_dynamic, crop, complete_class="full")
    assert isinstance(prob3, float)
    assert prob3 > 0.99

    # Test standard PyTorch model (dim=2) resolving index dynamically via classes list
    model_dim2_list = DummyStageBPyTorchModel(out_features=2, return_high_at_idx=1)
    model_dim2_list.classes = ["not_full", "full"]
    prob4 = stageb.classify_crop(model_dim2_list, crop, complete_class="full")
    assert isinstance(prob4, float)
    assert prob4 > 0.99
    
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


def test_f_max_nyquist_capping_and_map_box(tmp_path):
    import numpy as np
    import soundfile as sf
    from birdpipe import constants as C, coords, stageb
    
    wav_path = tmp_path / "test_nyquist.wav"
    sr = 48000
    y = np.zeros(int(10.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    from tests.test_stage_c import FakeResult
    mock_localizer = MagicMock()
    mock_localizer.return_value = [FakeResult([[0.5, 0.5, 0.2, 0.2]], [0.85])]

    with patch("scripts.ml_engine.YOLO", return_value=mock_localizer), \
         patch("scripts.ml_engine.os.path.exists", return_value=True), \
         patch("scripts.ml_engine.coords.map_box", wraps=coords.map_box) as mock_map_box, \
         patch("scripts.ml_engine.stageb.build_crop", wraps=stageb.build_crop) as mock_build_crop, \
         patch("scripts.ml_engine.stageb.classify_crop", return_value=1.0):
        
        pipeline = BirdAudioPipeline(localizer_path="dummy_localizer.pt", classifier_path=None, device="cpu")
        pipeline.classifier = object()

        # requested f_max_hz is higher than the pinned 48 kHz input's Nyquist.
        result = pipeline.process_file(
            str(wav_path),
            f_min_hz=2000.0,
            f_max_hz=30000.0,
            localizer="dummy_localizer.pt"
        )
        
        assert result["status"] == "success"
        assert mock_map_box.call_count > 0
        _, called_kwargs = mock_map_box.call_args
        assert called_kwargs.get("f_max") == 24000.0
        assert called_kwargs.get("f_min") == 2000.0
        assert called_kwargs.get("dt") == pytest.approx(C.BLOCK_FRAMES * C.HOP_LENGTH / sr)
        assert called_kwargs.get("tw") == pytest.approx(
            ((C.WINDOW_FRAMES - 1) * C.HOP_LENGTH + 1024) / sr
        )
        assert mock_build_crop.call_count > 0
        assert mock_build_crop.call_args.kwargs["sec_per_frame"] == pytest.approx(C.HOP_LENGTH / sr)

        zero_based = pipeline.process_file(
            str(wav_path),
            f_min_hz=0.0,
            f_max_hz=4000.0,
            localizer="dummy_localizer.pt",
        )
        assert zero_based["status"] == "success"


def test_non_pinned_sample_rate_is_rejected_before_inference(tmp_path):
    import numpy as np
    import soundfile as sf

    wav_path = tmp_path / "unsupported-rate.wav"
    sf.write(str(wav_path), np.zeros(16000, dtype=np.float32), 16000)
    pipeline = BirdAudioPipeline(localizer_path=None, classifier_path=None, device="cpu")
    result = pipeline.process_file(str(wav_path))
    assert result["status"] == "error"
    assert "requires 48000 Hz" in result["message"]
