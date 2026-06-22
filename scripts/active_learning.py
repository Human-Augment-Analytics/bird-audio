#!/usr/bin/env python3
"""
Active Learning Loop
Queries batch.db for events, extracts positive and false-positive segments,
and builds a formatted YOLO dataset for localizer fine-tuning.
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path
import yaml

# Ensure the repo root is on sys.path
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import librosa
import numpy as np
import soundfile as sf
import cv2

# Import constants from birdpipe
from birdpipe import constants as C

def query_events(db_path, session_id=None, output_dir=None):
    """
    Queries batch.db for events linked with files.
    """
    if not os.path.exists(db_path):
        print(f"Error: Database not found at {db_path}", file=sys.stderr)
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    query = """
        SELECT e.id, e.session_id, e.file_id, e.t_start, e.t_end, e.f_low, e.f_high,
               e.stage_a_conf, e.retained, f.path as file_path
        FROM events e
        JOIN files f ON e.file_id = f.id
        JOIN sessions s ON e.session_id = s.id
    """
    
    params = []
    conditions = []
    
    if session_id is not None:
        conditions.append("e.session_id = ?")
        params.append(session_id)
    if output_dir is not None:
        conditions.append("s.output_dir = ?")
        params.append(output_dir)
        
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        
    cursor.execute(query, params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def generate_spectrogram(y, sr):
    """
    Computes a standard flipped dB spectrogram cropped to frequency bins [88:248].
    Matches the Stage A preprocessing in ml_engine.py.
    """
    feats = np.abs(librosa.stft(y, n_fft=C.N_FFT, hop_length=C.HOP_LENGTH, center=False))
    # Crop to frequency band and flip vertically
    feats_cropped = feats[C.FREQ_BIN_LOW:C.FREQ_BIN_HIGH]
    feats_flipped = feats_cropped[::-1].copy()
    
    db = librosa.amplitude_to_db(feats_flipped, ref=np.max)
    rng = np.amax(db) - np.amin(db)
    img_png = np.clip((db - np.amin(db)) * 255 / (rng + 1e-6), 0, 255).astype(np.uint8)
    # Convert to 3-channel image as expected by YOLO
    img_png = np.tile(np.expand_dims(img_png, -1), (1, 1, 3))
    return img_png

def main():
    parser = argparse.ArgumentParser(description="Active Learning Dataset Builder")
    parser.add_argument("--db", type=str, default="data/batch.db", help="Path to batch.db SQLite database")
    parser.add_argument("--session-id", type=int, help="Filter by session ID")
    parser.add_argument("--output-dir", type=str, help="Filter by output directory in sessions")
    parser.add_argument("--dataset-dir", type=str, default="dataset_active_learning", help="Target dataset directory")
    parser.add_argument("--min-stage-a-conf", type=float, default=0.5, 
                        help="Confidence threshold to treat a retained=0 event as a false positive")
    
    args = parser.parse_args()
    
    db_path = str(_REPO_ROOT / args.db)
    
    # 1. Fetch events
    print(f"Querying events from database: {db_path}...")
    events = query_events(db_path, args.session_id, args.output_dir)
    if not events:
        print("No events found matching the criteria.")
        return
        
    print(f"Found {len(events)} events in total.")
    
    # 2. Separate into Positives and potential False Positives
    positives = [e for e in events if e["retained"] == 1]
    negatives = [e for e in events if e["retained"] == 0 and e["stage_a_conf"] >= args.min_stage_a_conf]
    
    print(f"Selected {len(positives)} confirmed positive events (retained=1).")
    print(f"Selected {len(negatives)} high-confidence false positive events (retained=0, stage_a_conf>={args.min_stage_a_conf}).")
    
    all_selected = positives + negatives
    if not all_selected:
        print("No events selected for dataset generation.")
        return

    # 3. Create dataset directories
    dataset_path = Path(args.dataset_dir)
    images_path = dataset_path / "images"
    labels_path = dataset_path / "labels"
    audio_path = dataset_path / "audio"
    
    images_path.mkdir(parents=True, exist_ok=True)
    labels_path.mkdir(parents=True, exist_ok=True)
    audio_path.mkdir(parents=True, exist_ok=True)
    
    # Track files to avoid loading the same WAV file too many times
    # (cache key is (file_path, w_start))
    processed_clips = 0
    
    print(f"Generating dataset at {dataset_path}...")
    for idx, target_event in enumerate(all_selected):
        event_id = target_event["id"]
        file_path = target_event["file_path"]
        
        if not os.path.exists(file_path):
            # Try absolute path relative to repo root if path is relative
            alt_path = _REPO_ROOT / file_path
            if alt_path.exists():
                file_path = str(alt_path)
            else:
                print(f"Warning: Audio file {file_path} not found. Skipping event {event_id}.")
                continue
                
        # Center a window of T_W duration around the target event
        t_start = target_event["t_start"]
        t_end = target_event["t_end"]
        t_mid = (t_start + t_end) / 2.0
        
        # Get file duration
        try:
            file_dur = librosa.get_duration(path=file_path)
            sr = librosa.get_samplerate(file_path)
        except Exception as e:
            print(f"Error reading metadata for {file_path}: {e}. Skipping.")
            continue
            
        w_start = max(0.0, t_mid - C.T_W / 2.0)
        w_end = w_start + C.T_W
        if w_end > file_dur:
            w_end = file_dur
            w_start = max(0.0, w_end - C.T_W)
            
        clip_name = f"event_{event_id:05d}"
        
        # Load audio clip
        try:
            y, _ = librosa.load(file_path, sr=sr, offset=w_start, duration=C.T_W)
            # Ensure clip matches exactly the samples required for a window
            expected_samples = int(C.T_W * sr)
            if len(y) < expected_samples:
                # Pad with zeros
                y = np.pad(y, (0, expected_samples - len(y)), mode='constant')
        except Exception as e:
            print(f"Error loading clip for event {event_id}: {e}. Skipping.")
            continue
            
        # 1. Save audio clip
        sf.write(str(audio_path / f"{clip_name}.wav"), y, sr, format="wav")
        
        # 2. Save spectrogram image
        img = generate_spectrogram(y, sr)
        cv2.imwrite(str(images_path / f"{clip_name}.png"), img)
        
        # 3. Create label file
        label_file_path = labels_path / f"{clip_name}.txt"
        
        # Find all other events in the database from the SAME file that fall within this window
        overlapping_events = [
            e for e in events 
            if e["file_path"] == target_event["file_path"]
            and e["t_start"] < w_end 
            and e["t_end"] > w_start
        ]
        
        label_lines = []
        for ev in overlapping_events:
            # We only write bounding boxes for positive (retained=1) events in the window
            if ev["retained"] == 1:
                # Clip event boundaries to window
                ev_start = max(w_start, ev["t_start"])
                ev_end = min(w_end, ev["t_end"])
                
                # Normalize time coordinates
                x_start_norm = (ev_start - w_start) / C.T_W
                x_end_norm = (ev_end - w_start) / C.T_W
                w_norm = x_end_norm - x_start_norm
                x_center_norm = (x_start_norm + x_end_norm) / 2.0
                
                # Clip and normalize frequency coordinates
                ev_flow = max(C.F_MIN_HZ, ev["f_low"])
                ev_fhigh = min(C.F_MAX_HZ, ev["f_high"])
                h_norm = (ev_fhigh - ev_flow) / (C.F_MAX_HZ - C.F_MIN_HZ)
                y_center_norm = (C.F_MAX_HZ - (ev_fhigh + ev_flow) / 2.0) / (C.F_MAX_HZ - C.F_MIN_HZ)
                
                label_lines.append(f"0 {x_center_norm:.6f} {y_center_norm:.6f} {w_norm:.6f} {h_norm:.6f}")
                
        with open(label_file_path, "w") as f:
            if label_lines:
                f.write("\n".join(label_lines) + "\n")
            else:
                # Write empty file for background / false positives
                pass
                
        processed_clips += 1

    # 4. Generate dataset.yaml
    dataset_yaml = {
        "path": os.path.abspath(dataset_path),
        "train": "images",
        "val": "images",
        "names": {
            0: "humes_leaf_warbler"
        }
    }
    
    with open(dataset_path / "dataset.yaml", "w") as f:
        yaml.safe_dump(dataset_yaml, f, default_flow_style=False)
        
    print(f"\nSuccessfully generated Active Learning Dataset:")
    print(f"  - Total clips processed: {processed_clips}")
    print(f"  - Audio clips directory: {audio_path}")
    print(f"  - Spectrogram images directory: {images_path}")
    print(f"  - YOLO labels directory: {labels_path}")
    print(f"  - YOLO Dataset Configuration: {dataset_path / 'dataset.yaml'}")

if __name__ == "__main__":
    main()
