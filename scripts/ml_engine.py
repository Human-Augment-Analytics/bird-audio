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
        
        print(f"Loading Localizer: {localizer_path}...", file=sys.stderr)
        self.localizer = YOLO(localizer_path)
        self.localizer.to(self.device)
        
        self.classifier = None
        if classifier_path and os.path.exists(classifier_path):
            print(f"Loading Classifier: {classifier_path}...", file=sys.stderr)
            # The classifier might be a standard PyTorch model or another YOLO
            # For now we'll load it as standard torch if it fails YOLO check
            try:
                self.classifier = YOLO(classifier_path)
                self.classifier.to(self.device)
            except:
                self.classifier = torch.load(classifier_path, map_location=self.device)
                if hasattr(self.classifier, 'eval'):
                    self.classifier.eval()
        
        self.conf = conf
        self.letterbox = LetterBox((160, 512), auto=False, stride=32)

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

    def _band_image(self, feats_quarters):
        """Whole-file flipped dB band image (uint8) for Stage B crops."""
        mag = np.concatenate(feats_quarters, axis=1)[88:248]
        mag = mag[::-1].copy()
        db = librosa.amplitude_to_db(mag, ref=np.max)
        rng = db.max() - db.min()
        return np.clip((db - db.min()) * 255 / (rng + 1e-6), 0, 255).astype(np.uint8)

    def process_file(self, input_wav, output_root="output", write_artifacts=False,
                     theta_a=0.0, theta_b=0.530306, emit_raw=False):
        input_wav = Path(input_wav)
        t0 = time.time()

        try:
            sr = librosa.get_samplerate(str(input_wav))
            stream = librosa.stream(
                str(input_wav), block_length=128, frame_length=1024,
                hop_length=256, fill_value=0,
            )
        except Exception as e:
            return {"status": "error", "input": str(input_wav),
                    "message": f"Failed to open audio: {e}"}

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
            feats = np.concatenate(feats_quarters[count:count + 4], axis=1)[88:248]
            feats = feats[::-1].copy()
            img = librosa.amplitude_to_db(feats, ref=np.max)
            rng = np.amax(img) - np.amin(img)
            img_png = np.clip((img - np.amin(img)) * 255 / (rng + 1e-6), 0, 255).astype(np.uint8)
            img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3))

            input_ims = self.preprocess(img_png).to(self.device)
            result = self.localizer(input_ims, imgsz=(160, 512), verbose=False, conf=self.conf)[0]
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
        if events and self.classifier is not None:
            band = self._band_image(feats_quarters)
            for ev in events:
                crop = stageb.build_crop(band, ev, params=sbp)
                ev.completeness_score = stageb.classify_crop(
                    self.classifier, crop, sbp.complete_class)
        rec.finalize_events(events, theta_a=theta_a, theta_b=theta_b)

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
    parser.add_argument("--input", type=str, required=True, help="Path to input WAV file")
    parser.add_argument("--output", type=str, default="output", help="Output directory")
    parser.add_argument("--localizer", type=str, default="models/buzz_localizer.pt", help="Path to Localizer .pt")
    parser.add_argument("--classifier", type=str, default="models/classifier.pt", help="Path to Classifier .pt")
    parser.add_argument("--device", type=str, help="Device (cpu, cuda, mps)")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    args = parser.parse_args()

    pipeline = BirdAudioPipeline(args.localizer, args.classifier, device=args.device, conf=args.conf)
    result = pipeline.process_file(args.input, args.output)
    
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
