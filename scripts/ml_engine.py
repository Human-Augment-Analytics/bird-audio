#!/usr/bin/env python3
"""
Bird Audio ML Engine (Native Python)
Optimized for Hume's Leaf Warbler detection using YOLO and quarter-step streaming.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Ensure the repo root is on sys.path so that `birdpipe` is importable when
# this script is invoked directly (e.g. `python scripts/ml_engine.py`), where
# Python sets sys.path[0] to the script directory rather than the repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import cv2
import librosa
import numpy as np
import soundfile as sf
import torch
from ultralytics import YOLO
from ultralytics.data.augment import LetterBox

from birdpipe import consolidate, coords
from birdpipe import records as rec
from birdpipe import stageb
from birdpipe import constants as C
from birdpipe.constants import ConsolidationParams, StageBParams

class BirdAudioPipeline:
    def __init__(self, localizer_path, classifier_path=None, device=None, conf=0.25):
        if device:
            self.device = torch.device(device)
        elif torch.cuda.is_available():
            self.device = torch.device("cuda")
        elif torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")
            
        print(f"Using device: {self.device}", file=sys.stderr)
        
        self._model_cache = {}
        self.localizer_path = localizer_path
        self.classifier_path = classifier_path
        
        self.localizer = self._get_model(localizer_path)
        self.classifier = self._get_model(classifier_path) if classifier_path else None
        
        self.conf = conf
        self.letterbox = LetterBox((160, 512), auto=False, stride=32)

    def _get_model(self, path):
        if not path:
            return None
        path_str = str(path)
        if path_str not in self._model_cache:
            if not os.path.exists(path_str):
                raise FileNotFoundError(f"Model path does not exist: {path_str}")
            print(f"Loading Model: {path_str}...", file=sys.stderr)
            try:
                try:
                    model = YOLO(path_str)
                    model.to(self.device)
                except Exception:
                    model = torch.load(path_str, map_location=self.device)
                    if hasattr(model, 'eval'):
                        model.eval()
            except Exception as e:
                if self.device.type != "cpu":
                    print(f"Warning: Failed to load model {path_str} on device {self.device}: {e}. Falling back to CPU.", file=sys.stderr)
                    self.device = torch.device("cpu")
                    # Move any already cached models to cpu
                    for cached_model in self._model_cache.values():
                        if hasattr(cached_model, "to"):
                            try:
                                cached_model.to(self.device)
                            except Exception:
                                pass
                    # Retry loading on cpu
                    try:
                        model = YOLO(path_str)
                        model.to(self.device)
                    except Exception:
                        model = torch.load(path_str, map_location=self.device)
                        if hasattr(model, 'eval'):
                            model.eval()
                else:
                    raise e
            self._model_cache[path_str] = model
        return self._model_cache[path_str]

    def preprocess(self, im: np.ndarray) -> torch.Tensor:
        """Prepare spectrogram image for model inference."""
        im = np.stack([self.letterbox(image=im)])
        if im.shape[-1] == 3:
            im = im[..., ::-1] # BGR to RGB
        im = im.transpose((0, 3, 1, 2)) # BHWC to BCHW
        im = np.ascontiguousarray(im)
        im = torch.from_numpy(im).float()
        im /= 255.0
        return im

    def _make_dirs(self, output_root):
        output_root = Path(output_root)
        dirs = {k: output_root / k for k in ("vis", "crops", "wav", "labels")}
        for d in dirs.values():
            d.mkdir(parents=True, exist_ok=True)
        return dirs

    def _band_image(self, feats_quarters, freq_bin_low=88, freq_bin_high=248):
        """Whole-file flipped dB band image (uint8) for Stage B crops."""
        mag = np.concatenate(feats_quarters, axis=1)[freq_bin_low:freq_bin_high]
        mag = mag[::-1].copy()
        db = librosa.amplitude_to_db(mag, ref=np.max)
        rng = db.max() - db.min()
        return np.clip((db - db.min()) * 255 / (rng + 1e-6), 0, 255).astype(np.uint8)

    def process_file(self, input_wav, output_root="output", write_artifacts=False,
                     theta_a=0.0, theta_b=0.530306, emit_raw=False,
                     localizer=None, classifier=None, classifier_c=None,
                     f_min_hz=None, f_max_hz=None):
        input_wav = Path(input_wav)
        t0 = time.time()

        # Dynamic frequency calculations & validation
        f_min = float(f_min_hz) if f_min_hz is not None else C.F_MIN_HZ
        f_max = float(f_max_hz) if f_max_hz is not None else C.F_MAX_HZ

        if f_min <= 0 or f_max <= 0 or f_min >= f_max:
            return {"status": "error", "message": f"Invalid frequency bounds: f_min_hz={f_min_hz}, f_max_hz={f_max_hz} must be positive and f_min_hz < f_max_hz"}

        # Resolve active models dynamically
        try:
            active_localizer = self._get_model(localizer) if localizer else self.localizer
            active_classifier = self._get_model(classifier) if classifier else self.classifier
            active_classifier_c = self._get_model(classifier_c) if classifier_c else None
        except Exception as e:
            return {"status": "error", "message": f"Failed to load model: {e}"}

        try:
            sr = librosa.get_samplerate(str(input_wav))
            stream = librosa.stream(
                str(input_wav), block_length=128, frame_length=1024,
                hop_length=256, fill_value=0,
            )
        except Exception as e:
            return {"status": "error", "input": str(input_wav),
                    "message": f"Failed to open audio: {e}"}
        n_fft = 1024
        freq_bin_low = int(np.round(f_min * n_fft / sr))
        freq_bin_high = int(np.round(f_max * n_fft / sr))

        feats_quarters, samps_quarters = [], []
        for y_block in stream:
            feats = np.abs(librosa.stft(y_block, n_fft=1024, hop_length=256, center=False))
            feats_quarters.append(feats)
            samps_quarters.append(y_block)

        total_windows = max(0, len(feats_quarters) - 3)
        dirs = self._make_dirs(output_root) if write_artifacts else None
        raw = []

        # Stage A: per-window object detection -> absolute detections
        for count in range(total_windows):
            feats = np.concatenate(feats_quarters[count:count + 4], axis=1)[freq_bin_low:freq_bin_high]
            feats = feats[::-1].copy()
            img = librosa.amplitude_to_db(feats, ref=np.max)
            rng = np.amax(img) - np.amin(img)
            img_png = np.clip((img - np.amin(img)) * 255 / (rng + 1e-6), 0, 255).astype(np.uint8)
            img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3))

            input_ims = self.preprocess(img_png).to(self.device)
            result = active_localizer(input_ims, imgsz=(160, 512), verbose=False, conf=self.conf)[0]
            boxes = result.boxes
            if len(boxes.xywhn) == 0:
                continue

            if write_artifacts:
                stem = f"{input_wav.stem}_{count:04d}"
                result.save(filename=str(dirs["vis"] / f"{stem}.jpeg"))
                result.save_txt(str(dirs["labels"] / f"{stem}.txt"), save_conf=True)
                cv2.imwrite(str(dirs["crops"] / f"{stem}.png"), img_png)
                samps = np.concatenate(samps_quarters[count:count + 4], axis=0)
                sf.write(str(dirs["wav"] / f"{stem}.wav"), samps, int(sr), format="wav")

            xywhn = boxes.xywhn.cpu().numpy()
            confs = boxes.conf.cpu().numpy()
            for k in range(len(xywhn)):
                x, y, w, h = (float(v) for v in xywhn[k])
                raw.append(coords.map_box(x, y, w, h, float(confs[k]), count))

        # Consolidation -> event tracks
        events = consolidate.consolidate(raw, ConsolidationParams())

        # Stage B: completeness curation on consolidated events
        sbp = StageBParams(theta_b=theta_b)
        band = None
        if events and active_classifier is not None:
            band = self._band_image(feats_quarters, freq_bin_low=freq_bin_low, freq_bin_high=freq_bin_high)
            for ev in events:
                crop = stageb.build_crop(band, ev, params=sbp, f_min=f_min, f_max=f_max)
                ev.completeness_score = stageb.classify_crop(
                    active_classifier, crop, sbp.complete_class)
        rec.finalize_events(events, theta_a=theta_a, theta_b=theta_b)

        # Stage C: classification on retained events
        if events and active_classifier_c is not None:
            if band is None:
                band = self._band_image(feats_quarters, freq_bin_low=freq_bin_low, freq_bin_high=freq_bin_high)
            for ev in events:
                if ev.retained:
                    crop = stageb.build_crop(band, ev, params=sbp, f_min=f_min, f_max=f_max)
                    if not isinstance(active_classifier_c, torch.nn.Module):
                        res = active_classifier_c(crop, verbose=False)[0]
                        idx = int(res.probs.top1)
                        ev.stage_c_label = res.names[idx]
                        ev.stage_c_score = float(res.probs.data[idx])
                    else:
                        # Standard PyTorch model fallback
                        try:
                            crop_t = crop.transpose((2, 0, 1))
                            crop_t = np.ascontiguousarray(crop_t)
                            crop_tensor = torch.from_numpy(crop_t).float().unsqueeze(0).to(self.device)
                            crop_tensor /= 255.0
                            with torch.no_grad():
                                outputs = active_classifier_c(crop_tensor)
                            if isinstance(outputs, tuple):
                                outputs = outputs[0]
                            probs = torch.softmax(outputs, dim=1).squeeze(0)
                            idx = int(torch.argmax(probs).item())
                            score = float(probs[idx].item())
                            
                            names = None
                            if hasattr(active_classifier_c, "names"):
                                names = active_classifier_c.names
                            elif hasattr(active_classifier_c, "classes"):
                                names = active_classifier_c.classes
                            
                            if names and idx in names:
                                label = names[idx]
                            elif names and isinstance(names, list) and idx < len(names):
                                label = names[idx]
                            else:
                                label = str(idx)
                            
                            ev.stage_c_label = label
                            ev.stage_c_score = score
                        except Exception as e:
                            print(f"Warning: Failed to execute Stage C non-YOLO model: {e}", file=sys.stderr)
                            ev.stage_c_label = "unknown"
                            ev.stage_c_score = 0.0

        out = {
            "status": "success",
            "input": str(input_wav),
            "filename": input_wav.name,
            "n_windows": total_windows,
            "n_raw": len(raw),
            "n_events": len(events),
            "n_complete": sum(1 for e in events if e.completeness_label == "complete"),
            "n_retained": sum(1 for e in events if e.retained),
            "elapsed_ms": int((time.time() - t0) * 1000),
            "events": [rec.to_record(e) for e in events],
        }
        if emit_raw:
            out["raw_detections"] = [
                {"window": d.window, "t_start": d.t_start, "t_end": d.t_end,
                 "f_low": d.f_low, "f_high": d.f_high, "conf": d.conf} for d in raw
            ]
        return out

def main():
    parser = argparse.ArgumentParser(description="Bird Audio ML Engine (Native Python)")
    parser.add_argument("--input", type=str, help="Path to input WAV file")
    parser.add_argument("--output", type=str, default="output", help="Output directory")
    parser.add_argument("--localizer", type=str, default="models/buzz_localizer.pt")
    parser.add_argument("--classifier", type=str, default="models/classifier.pt")
    parser.add_argument("--classifier-c", type=str, help="Stage C classifier model path")
    parser.add_argument("--f-min-hz", type=float, help="Dynamic minimum frequency in Hz")
    parser.add_argument("--f-max-hz", type=float, help="Dynamic maximum frequency in Hz")
    parser.add_argument("--device", type=str, help="Device (cpu, cuda, mps)")
    parser.add_argument("--conf", type=float, default=0.25, help="Stage A confidence threshold")
    parser.add_argument("--theta-a", type=float, default=0.0, help="Export Stage A conf threshold")
    parser.add_argument("--theta-b", type=float, default=0.530306, help="Stage B completeness threshold")
    parser.add_argument("--write-artifacts", action="store_true", help="Write vis/crops/wav/labels")
    parser.add_argument("--worker", action="store_true", help="Run as a stdin/stdout JSON worker")
    args = parser.parse_args()

    pipeline = BirdAudioPipeline(args.localizer, args.classifier, device=args.device, conf=args.conf)

    if args.worker:
        from birdpipe.worker import run_worker
        run_worker(pipeline)
        return

    if not args.input:
        parser.error("--input is required unless --worker is set")

    result = pipeline.process_file(
        args.input, args.output, write_artifacts=args.write_artifacts,
        theta_a=args.theta_a, theta_b=args.theta_b,
        localizer=args.localizer, classifier=args.classifier, classifier_c=args.classifier_c,
        f_min_hz=args.f_min_hz, f_max_hz=args.f_max_hz,
    )
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
