#!/usr/bin/env python3
"""Run quarter-step Stage A OD inference on a single WAV file.

This is a single-file refactor of
`inference_buzz_detector_stream_field_data_quarterstep.py`.

It preserves the same output subdirectory structure under a caller-provided
root output directory:

- `vis/`
- `crops/`
- `wav/`
- `labels/`
- `negs/crops/`
- `negs/wav/`
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import librosa
import numpy as np
import soundfile as sf
import torch
from ultralytics import YOLO
from ultralytics.data.augment import LetterBox


DEFAULT_MODEL_PATH = "/media/erik/part1/bird/detector/buzz_detector_large/train5/weights/best.pt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run quarter-step buzz detector inference on a single input WAV file."
    )
    parser.add_argument("--input-wav", required=True, help="Path to the input WAV file.")
    parser.add_argument(
        "--output-root",
        required=True,
        help="Root output directory. Subdirectories are created here.",
    )
    parser.add_argument(
        "--model-path",
        default=DEFAULT_MODEL_PATH,
        help="YOLO model weights path.",
    )
    parser.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Torch device to run inference on.",
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.25,
        help="Confidence threshold passed to YOLO inference.",
    )
    parser.add_argument(
        "--name-prefix",
        default=None,
        help=(
            "Optional prefix for output filenames. "
            "Defaults to the parent directory name of the input WAV."
        ),
    )
    return parser.parse_args()


def preprocess(im: np.ndarray) -> torch.Tensor:
    """Prepare one image for model inference."""
    not_tensor = not isinstance(im, torch.Tensor)
    if not_tensor:
        im = np.stack(pre_transform(im))
        if im.shape[-1] == 3:
            im = im[..., ::-1]
        im = im.transpose((0, 3, 1, 2))
        im = np.ascontiguousarray(im)
        im = torch.from_numpy(im)

    im = im.float()
    if not_tensor:
        im /= 255.0
    return im


def pre_transform(im: np.ndarray) -> list[np.ndarray]:
    """Letterbox to the detector input shape."""
    letterbox = LetterBox((160, 512), auto=False, stride=32)
    return [letterbox(image=im)]


def make_output_dirs(output_root: Path) -> dict[str, Path]:
    vis_dir = output_root / "vis"
    crops_dir = output_root / "crops"
    wav_dir = output_root / "wav"
    labels_dir = output_root / "labels"
    neg_crops_dir = output_root / "negs" / "crops"
    neg_wav_dir = output_root / "negs" / "wav"

    for path in [output_root, vis_dir, crops_dir, wav_dir, labels_dir, neg_crops_dir, neg_wav_dir]:
        path.mkdir(parents=True, exist_ok=True)

    return {
        "root": output_root,
        "vis": vis_dir,
        "crops": crops_dir,
        "wav": wav_dir,
        "labels": labels_dir,
        "neg_crops": neg_crops_dir,
        "neg_wav": neg_wav_dir,
    }


def main() -> None:
    args = parse_args()

    input_wav = Path(args.input_wav)
    if not input_wav.is_file():
        raise FileNotFoundError(f"Input WAV not found: {input_wav}")

    output_root = Path(args.output_root)
    out_dirs = make_output_dirs(output_root)

    prefix = args.name_prefix if args.name_prefix else input_wav.parent.name

    model = YOLO(args.model_path)
    model.to(args.device)

    print(f"Starting wav file: {input_wav}")

    try:
        sr = librosa.get_samplerate(str(input_wav))
        stream = librosa.stream(
            str(input_wav),
            block_length=128,
            frame_length=1024,
            hop_length=256,
            fill_value=0,
        )
    except Exception as exc:
        raise RuntimeError(f"Could not read input WAV: {input_wav}") from exc

    feats_quarters: list[np.ndarray] = []
    samps_quarters: list[np.ndarray] = []
    for y_block in stream:
        feats = np.abs(librosa.stft(y_block, n_fft=1024, hop_length=256, center=False))
        feats_quarters.append(feats)
        samps_quarters.append(y_block)

    total_windows = max(0, len(feats_quarters) - 3)
    total_pred_windows = 0
    total_preds = 0

    for count in range(total_windows):
        feats = np.concatenate(feats_quarters[count : count + 4], axis=1)[88:248]
        feats = feats[::-1].copy()

        img = librosa.amplitude_to_db(feats, ref=np.max)
        img_png = np.clip(
            (img - np.amin(img)) * 255 / (np.amax(img) - np.amin(img)),
            0,
            255,
        ).astype(np.uint8)
        img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3))

        num_name = f"{count:04d}"
        png_name = f"{input_wav.stem}_{num_name}.png"
        output_stem = f"{prefix}_{png_name}"

        input_ims = preprocess(img_png).to(args.device)
        result = model(input_ims, imgsz=(160, 512), verbose=False, conf=args.conf)[0]
        boxes = result.boxes

        num_preds = len(boxes.xyxy)
        if num_preds > 0:
            total_pred_windows += 1
            total_preds += num_preds

            vis_dest = out_dirs["vis"] / output_stem.replace(".png", ".jpeg")
            result.save(filename=str(vis_dest))

            label_dest = out_dirs["labels"] / output_stem.replace(".png", ".txt")
            result.save_txt(str(label_dest), save_conf=True)

            crops_dest = out_dirs["crops"] / output_stem
            cv2.imwrite(str(crops_dest), img_png)

            samps = np.concatenate(samps_quarters[count : count + 4], axis=0)
            wav_dest = out_dirs["wav"] / output_stem.replace(".png", ".wav")
            sf.write(str(wav_dest), samps, int(sr), format="wav")

    print(f"Completed {input_wav}")
    print(f"Output root: {output_root}")
    print(f"Total quarter-step windows: {total_windows}")
    print(f"Windows with predictions: {total_pred_windows}")
    print(f"Total predictions: {total_preds}")


if __name__ == "__main__":
    main()
