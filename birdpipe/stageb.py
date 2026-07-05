"""Stage B crop construction (Table A.8) + classifier wrapper."""
from __future__ import annotations

import numpy as np

from . import constants as C
from .constants import StageBParams
from .types import Event


def freq_to_row(f_hz: float, n_rows: int,
                f_min: float = C.F_MIN_HZ, f_max: float = C.F_MAX_HZ) -> float:
    """Map a frequency to a row in the flipped band image (row 0 = f_max)."""
    frac = (f_max - f_hz) / (f_max - f_min)
    return frac * (n_rows - 1)


def build_crop(band_img: np.ndarray, event: Event, params: StageBParams = StageBParams(),
               sec_per_frame: float = C.SEC_PER_FRAME,
               f_min: float = C.F_MIN_HZ, f_max: float = C.F_MAX_HZ) -> np.ndarray:
    """Construct the standardized 288x288x3 Stage-B crop for one event.

    band_img: uint8 [n_rows, n_frames] flipped dB band spectrogram of the whole file.
    The event is right-aligned in a `crop_frames`-wide temporal window, cropped
    vertically to its frequency bounds, aspect-preserving-resized and mean/gray padded.

    NOTE (fidelity risk #1): the exact frequency extent + padding must match the
    original training crop-generation; validate against the sample data.
    """
    import cv2

    n_rows, n_frames = band_img.shape[:2]
    pad_value = int(np.mean(band_img))

    # right-aligned temporal crop
    fe = int(round(event.t_end / sec_per_frame))
    fe = min(max(fe, 1), n_frames)
    fs = fe - params.crop_frames
    if fs < 0:
        time_crop = band_img[:, 0:fe]
        time_crop = np.pad(time_crop, ((0, 0), (-fs, 0)), mode="constant",
                           constant_values=pad_value)
    else:
        time_crop = band_img[:, fs:fe]

    # vertical crop to event frequency bounds
    r_top = int(np.floor(freq_to_row(event.f_high, n_rows, f_min, f_max)))
    r_bot = int(np.ceil(freq_to_row(event.f_low, n_rows, f_min, f_max)))
    r_top = max(0, min(r_top, n_rows - 1))
    r_bot = max(r_top + 1, min(r_bot, n_rows))
    crop = time_crop[r_top:r_bot, :]

    # aspect-preserving resize + square mean/gray pad
    h, w = crop.shape[:2]
    scale = min(params.out_size / h, params.out_size / w)
    nh, nw = max(1, int(round(h * scale))), max(1, int(round(w * scale)))
    resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((params.out_size, params.out_size), pad_value, dtype=np.uint8)
    y0 = (params.out_size - nh) // 2
    x0 = (params.out_size - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    return np.stack([canvas, canvas, canvas], axis=-1)


def classify_crop(model, crop_rgb: np.ndarray, complete_class: str = "full") -> float:
    """Return p(complete) = probability of the `complete_class` class."""
    res = model(crop_rgb, verbose=False)[0]
    names = res.names
    idx = next(k for k, v in names.items() if v == complete_class)
    return float(res.probs.data[idx])
