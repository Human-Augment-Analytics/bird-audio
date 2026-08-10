from __future__ import annotations

import librosa
import numpy as np
import pytest
import soundfile as sf

from birdpipe import constants as C
from birdpipe import stageb
from birdpipe.types import Event
from scripts.score_completeness import build_manual_crop


def _write_test_audio(path, seconds: float = 4.0) -> None:
    samples = int(seconds * C.SAMPLE_RATE)
    time = np.arange(samples, dtype=np.float32) / C.SAMPLE_RATE
    # A changing signal ensures local and global normalization would diverge.
    waveform = (0.08 + 0.7 * time / seconds) * np.sin(2 * np.pi * 6500 * time)
    sf.write(path, waveform, C.SAMPLE_RATE, subtype="FLOAT")


def _worker_reference(path, event: Event) -> np.ndarray:
    blocks = librosa.stream(
        str(path), block_length=C.BLOCK_FRAMES, frame_length=C.N_FFT,
        hop_length=C.HOP_LENGTH, fill_value=0,
    )
    features = [
        np.abs(librosa.stft(
            block, n_fft=C.N_FFT, hop_length=C.HOP_LENGTH, center=False,
        ))
        for block in blocks
    ]
    magnitude = np.concatenate(features, axis=1)[C.FREQ_BIN_LOW:C.FREQ_BIN_HIGH]
    magnitude = magnitude[::-1].copy()
    db = librosa.amplitude_to_db(magnitude, ref=np.max)
    span = float(db.max() - db.min())
    image = np.clip((db - db.min()) * 255 / (span + 1e-6), 0, 255).astype(np.uint8)
    return stageb.build_crop(image, event)


def test_manual_crop_matches_pipeline_stage_b_preprocessing(tmp_path):
    path = tmp_path / "manual.wav"
    _write_test_audio(path)
    event = Event(t_start=1.0, t_end=2.1, f_low=5600, f_high=7600, conf=0.0)

    actual = build_manual_crop(
        str(path), event.t_start, event.t_end, event.f_low, event.f_high,
    )
    expected = _worker_reference(path, event)

    assert actual.shape == (288, 288, 3)
    assert actual.dtype == np.uint8
    np.testing.assert_array_equal(actual, expected)


def test_manual_crop_rejects_window_beyond_recording(tmp_path):
    path = tmp_path / "short.wav"
    _write_test_audio(path, seconds=1.0)
    with pytest.raises(ValueError, match="outside"):
        build_manual_crop(str(path), 0.5, 1.5, 5600, 7600)


def test_manual_crop_rejects_frequency_outside_model_band(tmp_path):
    path = tmp_path / "manual.wav"
    _write_test_audio(path)
    with pytest.raises(ValueError, match="Stage B band"):
        build_manual_crop(str(path), 1.0, 2.0, 3000, 7600)
