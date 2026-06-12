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
    def __init__(self, model_path, device=None, conf=0.25):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Using device: {self.device}", file=sys.stderr)
        
        print(f"Loading YOLO model from {model_path}...", file=sys.stderr)
        self.model = YOLO(model_path)
        self.model.to(self.device)
        self.conf = conf
        
        # Letterbox for detector input shape (160, 512)
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
        
        # 1. Feature Extraction (Spectrogram generation)
        for y_block in stream:
            feats = np.abs(librosa.stft(y_block, n_fft=1024, hop_length=256, center=False))
            feats_quarters.append(feats)
            samps_quarters.append(y_block)

        total_windows = max(0, len(feats_quarters) - 3)
        detections = []

        # 2. Quarter-step Sliding Window Inference
        for count in range(total_windows):
            # Concatenate 4 quarters to form a full window, slice frequency bins [88:248]
            feats = np.concatenate(feats_quarters[count : count + 4], axis=1)[88:248]
            feats = feats[::-1].copy() # Flip for correct visual orientation

            # Convert to DB and normalize to image format
            img = librosa.amplitude_to_db(feats, ref=np.max)
            img_min, img_max = np.amin(img), np.amax(img)
            img_png = np.clip((img - img_min) * 255 / (img_max - img_min + 1e-6), 0, 255).astype(np.uint8)
            img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3)) # 1 channel to 3 (RGB)

            # Preprocess and Run Inference
            input_ims = self.preprocess(img_png).to(self.device)
            result = self.model(input_ims, imgsz=(160, 512), verbose=False, conf=self.conf)[0]
            boxes = result.boxes

            if len(boxes.xyxy) > 0:
                output_stem = f"{input_wav.stem}_{count:04d}"
                
                # Save visual and data artifacts
                result.save(filename=str(dirs["vis"] / f"{output_stem}.jpeg"))
                result.save_txt(str(dirs["labels"] / f"{output_stem}.txt"), save_conf=True)
                cv2.imwrite(str(dirs["crops"] / f"{output_stem}.png"), img_png)

                # Save corresponding audio segment
                samps = np.concatenate(samps_quarters[count : count + 4], axis=0)
                sf.write(str(dirs["wav"] / f"{output_stem}.wav"), samps, int(sr), format="wav")

                # Track detection for JSON output
                for i in range(len(boxes.xyxy)):
                    box = boxes.xyxy[i].cpu().numpy()
                    conf = float(boxes.conf[i].cpu())
                    # Convert window relative coords to absolute time if needed
                    # For now, just marking the window start/end
                    detections.append({
                        "window_index": count,
                        "timestamp": (count * 256) / sr, # Start of window
                        "duration": (1024 + 3 * 256) / sr, # Approx window duration
                        "label": "HLW Buzz",
                        "confidence": conf,
                        "box": box.tolist()
                    })

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
    parser.add_argument("--model", type=str, default="models/buzz_localizer.pt", help="Path to YOLO .pt model")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    args = parser.parse_args()

    pipeline = BirdAudioPipeline(args.model, conf=args.conf)
    result = pipeline.process_file(args.input, args.output)
    
    # Output JSON result for Tauri/CLI consumption
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
