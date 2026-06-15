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

    def process_file(self, input_wav, output_root):
        input_wav = Path(input_wav)
        output_root = Path(output_root)
        
        # Setup output subdirs
        dirs = {
            "vis": output_root / "vis",
            "crops": output_root / "crops",
            "wav": output_root / "wav",
            "labels": output_root / "labels"
        }
        for d in dirs.values():
            d.mkdir(parents=True, exist_ok=True)

        print(f"Starting pipeline for: {input_wav}", file=sys.stderr)

        # Simple run-cache to allow resuming interrupted runs.
        cache_path = output_root / f"{input_wav.stem}.cache.json"
        cache = {"processed_until": 0, "detections": []}
        if cache_path.exists():
            try:
                with open(cache_path, 'r') as fh:
                    cache = json.load(fh)
                detections = cache.get("detections", [])
                print(f"Resuming from cache: processed_until={cache.get('processed_until')}", file=sys.stderr)
            except Exception:
                cache = {"processed_until": 0, "detections": []}
        
        try:
            sr = librosa.get_samplerate(str(input_wav))
            stream = librosa.stream(
                str(input_wav),
                block_length=128,
                frame_length=1024,
                hop_length=256,
                fill_value=0,
            )
        except Exception as e:
            return {"error": f"Failed to open audio: {e}"}

        feats_quarters = []
        samps_quarters = []
        
        # 1. Feature Extraction
        for idx, y_block in enumerate(stream):
            feats = np.abs(librosa.stft(y_block, n_fft=1024, hop_length=256, center=False))
            feats_quarters.append(feats)
            samps_quarters.append(y_block)
            # Emit occasional progress to stderr for frontend monitoring
            if (idx + 1) % 50 == 0:
                try:
                    total_blocks = 'unknown'
                    msg = {"type": "extract_progress", "blocks_extracted": idx + 1}
                    print(f"PROGRESS: {json.dumps(msg)}", file=sys.stderr)
                except Exception:
                    pass

        total_windows = max(0, len(feats_quarters) - 3)
        detections = []

        # 2. Inference Loop
        start_time = time.time()
        processed_from = int(cache.get("processed_until", 0))
        # ensure processed_from in valid range
        if processed_from < 0:
            processed_from = 0

        for count in range(processed_from, total_windows):
            feats = np.concatenate(feats_quarters[count : count + 4], axis=1)[88:248]
            feats = feats[::-1].copy()

            img = librosa.amplitude_to_db(feats, ref=np.max)
            img_min, img_max = np.amin(img), np.amax(img)
            img_png = np.clip((img - img_min) * 255 / (img_max - img_min + 1e-6), 0, 255).astype(np.uint8)
            img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3))

            input_ims = self.preprocess(img_png).to(self.device)
            result = self.localizer(input_ims, imgsz=(160, 512), verbose=False, conf=self.conf)[0]
            boxes = result.boxes

            if len(boxes.xyxy) > 0:
                output_stem = f"{input_wav.stem}_{count:04d}"
                
                # Visuals and data
                result.save(filename=str(dirs["vis"] / f"{output_stem}.jpeg"))
                result.save_txt(str(dirs["labels"] / f"{output_stem}.txt"), save_conf=True)
                cv2.imwrite(str(dirs["crops"] / f"{output_stem}.png"), img_png)

                # Audio
                samps = np.concatenate(samps_quarters[count : count + 4], axis=0)
                sf.write(str(dirs["wav"] / f"{output_stem}.wav"), samps, int(sr), format="wav")

                # Optional Stage B: Classification
                # TODO: Implement actual Stage B refinement logic here using self.classifier
                for i in range(len(boxes.xyxy)):
                    box = boxes.xyxy[i].cpu().numpy()
                    conf = float(boxes.conf[i].cpu())
                    
                    # Currently we only run Stage A localization.
                    # Do not claim 'Classified' until inference is actually implemented.
                    label = "HLW Buzz (Detected)"

                    detections.append({
                        "window_index": count,
                        "timestamp": (count * 256) / sr,
                        "duration": (1024 + 3 * 256) / sr,
                        "label": label,
                        "confidence": conf,
                        "box": box.tolist()
                    })

            # Update cache after each window so we can resume
            try:
                cache = {"processed_until": count + 1, "detections": detections}
                tmp = cache_path.with_suffix('.tmp')
                with open(tmp, 'w') as fh:
                    json.dump(cache, fh)
                os.replace(str(tmp), str(cache_path))
            except Exception:
                pass

            # Emit progress message with ETA
            try:
                elapsed = time.time() - start_time
                processed = count - processed_from + 1
                per_item = elapsed / max(1, processed)
                remaining = total_windows - (count + 1)
                eta = remaining * per_item
                prog = {"type": "inference_progress", "processed": count + 1, "total": total_windows, "eta_seconds": int(eta)}
                print(f"PROGRESS: {json.dumps(prog)}", file=sys.stderr)
            except Exception:
                pass

        # Remove cache on successful completion
        try:
            if cache_path.exists():
                os.remove(cache_path)
        except Exception:
            pass

        return {
            "status": "success",
            "filename": input_wav.name,
            "total_windows": total_windows,
            "detections_found": len(detections),
            "output_root": str(output_root),
            "detections": detections
        }

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
