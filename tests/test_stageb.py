from __future__ import annotations

import numpy as np

from birdpipe import stageb
from birdpipe.constants import StageBParams, F_MIN_HZ, F_MAX_HZ
from birdpipe.types import Event

SB = StageBParams()


def _band_image(n_rows=160, n_frames=2000, value=120):
    return np.full((n_rows, n_frames), value, dtype=np.uint8)


def test_build_crop_output_shape_and_dtype():
    band = _band_image()
    ev = Event(t_start=1.0, t_end=2.0, f_low=5000, f_high=8000, conf=0.9)
    crop = stageb.build_crop(band, ev, params=SB)
    assert crop.shape == (288, 288, 3)
    assert crop.dtype == np.uint8


def test_build_crop_left_pads_when_event_near_start():
    # event ending very early -> needs left padding; must not raise and stays in-bounds
    band = _band_image(n_frames=100)
    ev = Event(t_start=0.0, t_end=0.2, f_low=5000, f_high=8000, conf=0.9)
    crop = stageb.build_crop(band, ev, params=SB)
    assert crop.shape == (288, 288, 3)


def test_freq_to_row_orientation():
    # row 0 = f_max (top), last row = f_min (bottom)
    assert stageb.freq_to_row(F_MAX_HZ, 160) == 0.0
    assert abs(stageb.freq_to_row(F_MIN_HZ, 160) - 159.0) < 1e-6


def test_reconstruct_crop_silence_returns_none():
    assert stageb.reconstruct_crop(np.zeros(48000 * 3, np.float32), 48000, 1.0, 2.0, 5000, 8000) is None


def test_reconstruct_crop_tone_is_band_limited_gray_image():
    sr = 48000
    t = np.arange(sr * 3) / sr
    wav = (0.1 * np.sin(2 * np.pi * 6500 * t)).astype(np.float32)
    crop = stageb.reconstruct_crop(wav, sr, 0.5, 2.5, 5000, 8000)
    assert crop.dtype == np.uint8 and crop.shape[2] == 3
    # rows = bins between 5000 and 8000 Hz; frames = centred STFT minus the two edge frames
    assert crop.shape[0] == int(513 * 8000 / 24000) - int(513 * 5000 / 24000)
    assert crop.shape[1] == (int(2.5 * sr) - int(0.5 * sr)) // 256 + 1 - 2


def test_reconstruct_crop_short_event_extends_left_to_288_frames():
    sr = 48000
    t = np.arange(sr * 3) / sr
    wav = (0.1 * np.sin(2 * np.pi * 6500 * t)).astype(np.float32)
    crop = stageb.reconstruct_crop(wav, sr, 1.5, 2.5, 5000, 8000)
    assert crop.shape[1] == 288


def test_make_square_288_centre_pads_with_mean():
    im = np.full((60, 144, 3), 200, np.uint8)
    im[:, :72] = 100                                  # mean 150
    out = stageb.make_square_288(im)
    assert out.shape == (288, 288, 3) and out.dtype == np.uint8
    assert (out[:84] == 150).all() and (out[-84:] == 150).all()   # 120-row image, centred
    assert (out[84:84 + 120, :100] == 100).all()


def test_classify_crop_with_fake_model():
    class _Probs:
        def __init__(self, data, top1):
            self.data = data
            self.top1 = top1

    class _Res:
        names = {0: "full", 1: "not_full"}

        def __init__(self):
            self.probs = _Probs([0.8, 0.2], 0)

    class _FakeModel:
        def __call__(self, img, verbose=False):
            return [_Res()]

    score = stageb.classify_crop(_FakeModel(), np.zeros((288, 288, 3), np.uint8),
                                 complete_class="full")
    assert abs(score - 0.8) < 1e-6
