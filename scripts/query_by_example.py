#!/usr/bin/env python3
"""
Query-by-Example Search Prototype
Extracts feature embeddings (spectrogram crops + MFCCs) from consolidated events,
and finds similar events using cosine similarity.
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path
import numpy as np

# Ensure the repo root is on sys.path
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import librosa
import cv2

# Import constants from birdpipe
from birdpipe import constants as C

def query_event_by_id(cursor, event_id):
    """Retrieves a single event record by ID."""
    cursor.execute("""
        SELECT e.id, e.session_id, e.file_id, e.t_start, e.t_end, e.f_low, e.f_high,
               e.stage_a_conf, e.retained, f.path as file_path
        FROM events e
        JOIN files f ON e.file_id = f.id
        WHERE e.id = ?
    """, (event_id,))
    row = cursor.fetchone()
    return dict(row) if row else None

def query_session_events(cursor, session_id):
    """Retrieves all events in a session."""
    cursor.execute("""
        SELECT e.id, e.session_id, e.file_id, e.t_start, e.t_end, e.f_low, e.f_high,
               e.stage_a_conf, e.retained, f.path as file_path
        FROM events e
        JOIN files f ON e.file_id = f.id
        WHERE e.session_id = ?
    """, (session_id,))
    return [dict(r) for r in cursor.fetchall()]

def extract_features(event, feature_type="combined"):
    """
    Extracts features for a given event from its audio file.
    """
    file_path = event["file_path"]
    if not os.path.exists(file_path):
        alt_path = _REPO_ROOT / file_path
        if alt_path.exists():
            file_path = str(alt_path)
        else:
            raise FileNotFoundError(f"Audio file not found: {file_path}")

    # Load audio segment corresponding to the event
    t_start = event["t_start"]
    duration = max(0.05, event["t_end"] - t_start) # minimum 50ms clip
    
    sr = librosa.get_samplerate(file_path)
    # Load with slight buffer (e.g. 50ms) on each side to catch context, if possible
    buffer = 0.05
    load_start = max(0.0, t_start - buffer)
    load_duration = duration + (2 * buffer)
    
    y, sr = librosa.load(file_path, sr=sr, offset=load_start, duration=load_duration)
    
    # 1. Spectrogram features
    if feature_type in ("spectrogram", "combined"):
        stft = np.abs(librosa.stft(y, n_fft=C.N_FFT, hop_length=C.HOP_LENGTH, center=False))
        # Find frequency bins matching f_low and f_high
        freqs = librosa.fft_frequencies(sr=sr, n_fft=C.N_FFT)
        f_low_idx = np.searchsorted(freqs, event["f_low"])
        f_high_idx = np.searchsorted(freqs, event["f_high"])
        f_low_idx = max(0, min(f_low_idx, stft.shape[0] - 2))
        f_high_idx = max(f_low_idx + 1, min(f_high_idx, stft.shape[0]))
        
        # Crop to bounding box
        crop = stft[f_low_idx:f_high_idx]
        
        # Resize to fixed size 32x32 for comparison
        crop_resized = cv2.resize(crop, (32, 32))
        
        # Normalize
        norm_factor = np.linalg.norm(crop_resized)
        if norm_factor > 0:
            crop_resized = crop_resized / norm_factor
        spec_feat = crop_resized.flatten()
        
        if feature_type == "spectrogram":
            return spec_feat

    # 2. MFCC features
    if feature_type in ("mfcc", "combined"):
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20, n_fft=C.N_FFT, hop_length=C.HOP_LENGTH)
        # Compute mean and std over time
        mfcc_mean = np.mean(mfcc, axis=1)
        mfcc_std = np.std(mfcc, axis=1)
        
        # Normalize MFCCs
        mfcc_feat = np.concatenate([mfcc_mean, mfcc_std])
        norm_factor = np.linalg.norm(mfcc_feat)
        if norm_factor > 0:
            mfcc_feat = mfcc_feat / norm_factor
            
        if feature_type == "mfcc":
            return mfcc_feat

    # 3. Combined features
    # Combine spectrogram feature, mfcc feature, and duration feature
    dur_feat = np.array([duration])
    combined_feat = np.concatenate([spec_feat, mfcc_feat * 0.5, dur_feat * 0.1])
    norm_factor = np.linalg.norm(combined_feat)
    if norm_factor > 0:
        combined_feat = combined_feat / norm_factor
    return combined_feat

def main():
    parser = argparse.ArgumentParser(description="Query-by-Example event search")
    parser.add_argument("--db", type=str, default="data/batch.db", help="Path to batch.db database")
    parser.add_argument("--query-id", type=int, required=True, help="ID of the event to query")
    parser.add_argument("--session-id", type=int, help="Limit search pool to this session (defaults to query event's session)")
    parser.add_argument("--k", type=int, default=5, help="Number of nearest neighbors to return")
    parser.add_argument("--feature-type", type=str, choices=["spectrogram", "mfcc", "combined"], default="combined",
                        help="Feature extraction type")
    parser.add_argument("--recache", action="store_true", help="Force recomputing embeddings")
    parser.add_argument("--cache-dir", type=str, default="output", help="Directory for storing embeddings cache")
    parser.add_argument("--json", action="store_true", help="Output results in JSON format")
    args = parser.parse_args()

    db_path = str(_REPO_ROOT / args.db)
    if not os.path.exists(db_path):
        print(f"Error: Database not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Find the query event
    query_event = query_event_by_id(cursor, args.query_id)
    if not query_event:
        print(f"Error: Query Event ID {args.query_id} not found in database.", file=sys.stderr)
        sys.exit(1)

    def log_info(msg):
        if args.json:
            print(msg, file=sys.stderr)
        else:
            print(msg)

    log_info("Query Event Info:")
    log_info(f"  - ID: {query_event['id']}")
    log_info(f"  - Session ID: {query_event['session_id']}")
    log_info(f"  - File: {Path(query_event['file_path']).name}")
    log_info(f"  - Time: {query_event['t_start']:.2f}s - {query_event['t_end']:.2f}s (duration: {query_event['t_end'] - query_event['t_start']:.2f}s)")
    log_info(f"  - Frequency Band: {query_event['f_low']:.1f}Hz - {query_event['f_high']:.1f}Hz")
    log_info(f"  - Retained: {query_event['retained']}, Stage A Conf: {query_event['stage_a_conf']:.3f}")

    # Determine session to search in
    search_session_id = args.session_id if args.session_id is not None else query_event["session_id"]
    log_info(f"\nSearching in Session {search_session_id}...")

    # Fetch search pool events
    pool_events = query_session_events(cursor, search_session_id)
    log_info(f"Search pool size: {len(pool_events)} events.")

    # Cache file path
    cache_path = Path(args.cache_dir) / f"embeddings_session_{search_session_id}_{args.feature_type}.npz"
    
    embeddings = {}
    cached_ids = []
    
    # Try loading cache if not recaching
    if not args.recache and cache_path.exists():
        try:
            cache_data = np.load(cache_path, allow_pickle=True)
            cached_ids = cache_data["ids"].tolist()
            cached_embs = cache_data["embeddings"]
            embeddings = {eid: cached_embs[i] for i, eid in enumerate(cached_ids)}
            log_info(f"Loaded {len(embeddings)} embeddings from cache: {cache_path}")
        except Exception as e:
            print(f"Warning: Failed to load cache: {e}. Recomputing.", file=sys.stderr)

    # Compute missing embeddings
    missing_events = [e for e in pool_events if e["id"] not in embeddings]
    if missing_events:
        log_info(f"Computing embeddings for {len(missing_events)} events...")
        for idx, ev in enumerate(missing_events):
            try:
                emb = extract_features(ev, args.feature_type)
                embeddings[ev["id"]] = emb
            except Exception as e:
                print(f"Warning: Failed to extract features for event {ev['id']}: {e}", file=sys.stderr)
        
        # Save cache
        try:
            Path(args.cache_dir).mkdir(parents=True, exist_ok=True)
            ids_to_save = list(embeddings.keys())
            embs_to_save = np.array([embeddings[eid] for eid in ids_to_save])
            np.savez(cache_path, ids=ids_to_save, embeddings=embs_to_save)
            log_info(f"Saved {len(embeddings)} embeddings to cache: {cache_path}")
        except Exception as e:
            print(f"Warning: Failed to save cache: {e}", file=sys.stderr)

    # Gather matching pool vectors
    valid_events = []
    valid_embs = []
    for ev in pool_events:
        if ev["id"] in embeddings:
            valid_events.append(ev)
            valid_embs.append(embeddings[ev["id"]])

    if not valid_events:
        print("Error: No valid event embeddings to compare against.", file=sys.stderr)
        sys.exit(1)

    # Compute similarity
    query_vector = extract_features(query_event, args.feature_type)
    
    valid_embs = np.array(valid_embs)
    norms = np.linalg.norm(valid_embs, axis=1)
    query_norm = np.linalg.norm(query_vector)
    
    similarities = np.dot(valid_embs, query_vector) / (norms * query_norm + 1e-9)

    # Sort matches
    sorted_indices = np.argsort(similarities)[::-1]
    
    if args.json:
        import json
        matches = []
        rank = 1
        for idx in sorted_indices:
            match_ev = valid_events[idx]
            sim = similarities[idx]
            
            # Skip query event itself
            if match_ev["id"] == args.query_id:
                continue
                
            event_dict = dict(match_ev)
            event_dict["similarity"] = float(sim)
            matches.append(event_dict)
            
            rank += 1
            if rank > args.k:
                break
        print(json.dumps(matches))
    else:
        print(f"\nTop-{args.k} matches for Query Event {args.query_id}:")
        print(f"{'Rank':<5} | {'Event ID':<8} | {'Sim':<6} | {'Retained':<8} | {'File':<25} | {'Time Range':<15} | {'Freq Range':<15}")
        print("-" * 105)

        rank = 1
        for idx in sorted_indices:
            match_ev = valid_events[idx]
            sim = similarities[idx]
            
            # Skip query event itself in display but show neighbors
            if match_ev["id"] == args.query_id:
                continue
                
            print(f"{rank:<5} | {match_ev['id']:<8} | {sim:.4f} | {str(match_ev['retained']):<8} | {Path(match_ev['file_path']).name:<25} | "
                  f"{match_ev['t_start']:.2f}-{match_ev['t_end']:.2f}s | {match_ev['f_low']:.0f}-{match_ev['f_high']:.0f}Hz")
            
            rank += 1
            if rank > args.k:
                break

    conn.close()

if __name__ == "__main__":
    main()
