from __future__ import annotations

import json
import numpy as np
import pytest
import soundfile as sf
from unittest.mock import patch, MagicMock

from birdpipe.types import Event
from scripts.ml_engine import BirdAudioPipeline


class FakeBoxes:
    def __init__(self, xywhn, conf):
        self._xywhn = np.array(xywhn)
        self._conf = np.array(conf)

    @property
    def xywhn(self):
        mock = MagicMock()
        mock.cpu.return_value.numpy.return_value = self._xywhn
        mock.__len__.return_value = len(self._xywhn)
        return mock

    @property
    def conf(self):
        mock = MagicMock()
        mock.cpu.return_value.numpy.return_value = self._conf
        mock.__len__.return_value = len(self._conf)
        return mock


class FakeResult:
    def __init__(self, xywhn, conf):
        self.boxes = FakeBoxes(xywhn, conf)


class FakeClassifierProbs:
    def __init__(self, data, top1):
        self.data = data
        self.top1 = top1


class FakeClassifierResult:
    def __init__(self, names, probs_data, top1):
        self.names = names
        self.probs = FakeClassifierProbs(probs_data, top1)


def test_dynamic_pipeline_configuration(tmp_path):
    # Create a tiny WAV file for processing (3 seconds, 48000 Hz)
    wav_path = tmp_path / "test.wav"
    sr = 48000
    y = np.zeros(int(3.0 * sr), dtype=np.float32)
    sf.write(str(wav_path), y, sr)

    # Setup mocked YOLO class instances
    mock_localizer = MagicMock()
    # Mock __call__ to return a list of FakeResult objects for Stage A detection
    # Return one detection in the middle of the frame
    mock_localizer.return_value = [FakeResult([[0.5, 0.5, 0.2, 0.2]], [0.85])]

    mock_classifier_b = MagicMock()
    # Mock Stage B classifier to return completeness probability
    # 'full' is index 0
    mock_classifier_b.return_value = [FakeClassifierResult({0: "full", 1: "not_full"}, [0.9, 0.1], 0)]

    mock_classifier_c = MagicMock()
    # Mock Stage C classifier to return species prediction
    # Species label 'species_c_target' at index 1 with 0.95 score
    mock_classifier_c.return_value = [FakeClassifierResult({0: "other", 1: "species_c_target"}, [0.05, 0.95], 1)]

    # Mock the YOLO model loader to return our mocks based on paths
    def dummy_yolo(path, *args, **kwargs):
        if "localizer" in str(path):
            return mock_localizer
        elif "classifier_b" in str(path):
            return mock_classifier_b
        elif "classifier_c" in str(path):
            return mock_classifier_c
        return MagicMock()

    with patch("scripts.ml_engine.YOLO", side_effect=dummy_yolo), \
         patch("scripts.ml_engine.os.path.exists", return_value=True):
        
        # Instantiate pipeline
        pipeline = BirdAudioPipeline(
            localizer_path="dummy_localizer.pt",
            classifier_path="dummy_classifier_b.pt",
            device="cpu"
        )
        
        # Process file with custom dynamic parameters and Stage C model path
        result = pipeline.process_file(
            str(wav_path),
            theta_a=0.1,
            theta_b=0.5,
            localizer="dummy_localizer.pt",
            classifier="dummy_classifier_b.pt",
            classifier_c="dummy_classifier_c.pt",
            f_min_hz=3000.0,
            f_max_hz=13000.0
        )

        assert result["status"] == "success"
        assert result["n_events"] > 0

        # Verify Stage C results exist on retained events
        for event in result["events"]:
            if event["retained"]:
                assert "stage_c_label" in event
                assert event["stage_c_label"] == "species_c_target"
                assert abs(event["stage_c_score"] - 0.95) < 1e-5
