#!/usr/bin/env python3
"""Score one finalized manual time-frequency window with the Stage B model."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import librosa
import numpy as np
import soundfile as sf
from birdpipe import constants as C
from birdpipe import stageb
from birdpipe.constants import StageBParams
from birdpipe.types import Event


def build_manual_crop(
    audio_path: str,
    t_start: float,
    t_end: float,
    f_low: float,
    f_high: float,
    f_min_hz: float = C.F_MIN_HZ,
    f_max_hz: float = C.F_MAX_HZ,
) -> np.ndarray:
    """Build the same Stage B crop from the worker's whole-recording image."""
    params = StageBParams()
    with sf.SoundFile(audio_path) as handle:
        sample_rate = int(handle.samplerate)
        if sample_rate != C.SAMPLE_RATE:
            raise ValueError(
                f"Unsupported sample rate {sample_rate} Hz; Stage B requires {C.SAMPLE_RATE} Hz"
            )
        duration = len(handle) / sample_rate
        if t_start < 0 or t_end <= t_start or t_end > duration + C.SEC_PER_FRAME:
            raise ValueError(
                f"Manual window {t_start:.3f}-{t_end:.3f}s is outside the {duration:.3f}s recording"
            )
        nyquist = sample_rate / 2.0
        band_min = max(0.0, float(f_min_hz))
        band_max = min(float(f_max_hz), nyquist)
        if band_min >= band_max or f_low < band_min or f_high > band_max:
            raise ValueError(
                f"Manual frequency bounds must stay within the Stage B band {band_min:g}-{band_max:g} Hz"
            )

    # Stage B was trained on a whole-file image normalized by that recording's
    # global dB range. A local-only crop can change the score, so deliberately
    # reproduce the worker's streaming transform rather than approximating it.
    blocks = librosa.stream(
        audio_path, block_length=C.BLOCK_FRAMES, frame_length=C.N_FFT,
        hop_length=C.HOP_LENGTH, fill_value=0,
    )
    magnitudes = [
        np.abs(librosa.stft(
            block, n_fft=C.N_FFT, hop_length=C.HOP_LENGTH, center=False,
        ))
        for block in blocks
    ]
    if not magnitudes:
        raise ValueError("Audio file contains no samples")
    magnitude = np.concatenate(magnitudes, axis=1)
    low_bin = int(np.round(band_min * C.N_FFT / sample_rate))
    high_bin = int(np.round(band_max * C.N_FFT / sample_rate))
    band = magnitude[low_bin:high_bin][::-1].copy()
    db = librosa.amplitude_to_db(band, ref=np.max)
    span = float(db.max() - db.min())
    band_image = np.clip((db - db.min()) * 255 / (span + 1e-6), 0, 255).astype(np.uint8)

    event = Event(
        t_start=t_start,
        t_end=t_end,
        f_low=f_low,
        f_high=f_high,
        conf=0.0,
    )
    return stageb.build_crop(
        band_image,
        event,
        params=params,
        sec_per_frame=C.SEC_PER_FRAME,
        f_min=band_min,
        f_max=band_max,
    )


def load_model(path: str, requested_device: str):
    import torch
    from ultralytics import YOLO

    if not Path(path).is_file():
        raise FileNotFoundError(f"Stage B model not found: {path}")
    if requested_device.startswith("cuda") and torch.cuda.is_available():
        device = torch.device(requested_device)
    elif requested_device == "mps" and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    try:
        model = YOLO(path)
        model.to(device)
        return model
    except Exception:
        model = torch.load(path, map_location=device)
        if hasattr(model, "eval"):
            model.eval()
        return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--classifier", default="models/classifier.pt")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--t-start", type=float, required=True)
    parser.add_argument("--t-end", type=float, required=True)
    parser.add_argument("--f-low", type=float, required=True)
    parser.add_argument("--f-high", type=float, required=True)
    parser.add_argument("--theta-b", type=float, required=True)
    parser.add_argument("--f-min-hz", type=float, default=C.F_MIN_HZ)
    parser.add_argument("--f-max-hz", type=float, default=C.F_MAX_HZ)
    args = parser.parse_args()

    crop = build_manual_crop(
        args.audio, args.t_start, args.t_end, args.f_low, args.f_high,
        args.f_min_hz, args.f_max_hz,
    )
    model = load_model(args.classifier, args.device)
    score = float(stageb.classify_crop(model, crop, StageBParams().complete_class))
    if not math.isfinite(score) or not 0.0 <= score <= 1.0:
        raise ValueError("Stage B returned an invalid completeness probability")
    json.dump({
        "score": score,
        "label": "complete" if score >= args.theta_b else "incomplete",
        "threshold": args.theta_b,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
