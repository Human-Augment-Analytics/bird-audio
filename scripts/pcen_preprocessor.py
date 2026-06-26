#!/usr/bin/env python3
"""
PCEN Preprocessor
Computes Per-Channel Energy Normalization (PCEN) on STFT spectrograms
tuned specifically for bioacoustic applications (Hume's Leaf Warbler).
"""

import argparse
import os
import sys
from pathlib import Path

# Ensure the repo root is on sys.path
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import librosa
import numpy as np
import soundfile as sf

# Try importing matplotlib, fallback to opencv for saving if needed
try:
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

def compute_pcen(y, sr, n_fft=1024, hop_length=256, center=False,
                 gain=0.98, bias=2.0, power=0.5, b=0.035, eps=1e-6):
    """
    Computes PCEN for a given audio signal.
    """
    # 1. Compute STFT magnitude spectrogram
    stft_mag = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length, center=center))
    
    # 2. Compute PCEN
    pcen_spec = librosa.pcen(
        stft_mag,
        sr=sr,
        hop_length=hop_length,
        gain=gain,
        bias=bias,
        power=power,
        b=b,
        eps=eps
    )
    return pcen_spec, stft_mag

def get_vis_spectrogram(spec, crop_band=(88, 248), flip=True):
    """
    Crops and prepares a spectrogram for visualization/model input.
    """
    if crop_band:
        spec = spec[crop_band[0]:crop_band[1]]
    if flip:
        spec = spec[::-1]
    return spec

def main():
    parser = argparse.ArgumentParser(description="PCEN Preprocessor for Bioacoustic Data")
    parser.add_argument("--input", type=str, help="Path to input WAV file. If not provided, searches data/ directory.")
    parser.add_argument("--output-dir", type=str, default="output", help="Directory to save output comparison plot.")
    parser.add_argument("--duration", type=float, default=10.0, help="Duration of audio segment to visualize (in seconds).")
    parser.add_argument("--offset", type=float, default=10.0, help="Start time offset in seconds for the visualization.")
    parser.add_argument("--gain", type=float, default=0.98, help="PCEN gain parameter.")
    parser.add_argument("--bias", type=float, default=2.0, help="PCEN bias parameter.")
    parser.add_argument("--power", type=float, default=0.5, help="PCEN power parameter.")
    parser.add_argument("--b", type=float, default=0.035, help="PCEN b smoothing parameter.")
    parser.add_argument("--eps", type=float, default=1e-6, help="PCEN epsilon parameter.")
    args = parser.parse_args()

    # Find an input file in data/ if not specified
    input_path = args.input
    if not input_path:
        data_dir = _REPO_ROOT / "data"
        if data_dir.exists():
            wav_files = sorted(list(data_dir.glob("*.WAV")) + list(data_dir.glob("*.wav")))
            if wav_files:
                input_path = str(wav_files[0])
                print(f"Auto-selected input file: {input_path}")
            else:
                print("Error: No WAV files found in data/ directory. Please provide --input.")
                sys.exit(1)
        else:
            print("Error: data/ directory not found. Please provide --input.")
            sys.exit(1)

    print(f"Loading {input_path} (offset={args.offset}s, duration={args.duration}s)...")
    try:
        y, sr = librosa.load(input_path, sr=None, offset=args.offset, duration=args.duration)
    except Exception as e:
        print(f"Error loading audio file: {e}")
        sys.exit(1)

    print("Computing STFT and PCEN...")
    pcen_spec, stft_mag = compute_pcen(
        y, sr,
        gain=args.gain,
        bias=args.bias,
        power=args.power,
        b=args.b,
        eps=args.eps
    )

    # Prepare standard dB spectrogram for comparison
    db_spec = librosa.amplitude_to_db(stft_mag, ref=np.max)

    # Process both for comparison visualization (crop & flip)
    db_vis = get_vis_spectrogram(db_spec, crop_band=(88, 248), flip=True)
    pcen_vis = get_vis_spectrogram(pcen_spec, crop_band=(88, 248), flip=True)

    # Save visualization
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_img_path = output_dir / "pcen_comparison.png"

    if HAS_MATPLOTLIB:
        print(f"Creating comparison plot and saving to {out_img_path}...")
        fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)

        # Standard dB Spectrogram
        img1 = axes[0].imshow(db_vis, aspect='auto', cmap='magma', 
                             extent=[args.offset, args.offset + args.duration, 88 * (sr / 1024), 248 * (sr / 1024)])
        axes[0].set_title("Standard dB Spectrogram (Clipped 88-248 Bins)")
        axes[0].set_ylabel("Frequency (Hz)")
        fig.colorbar(img1, ax=axes[0], label="dB (ref=max)")

        # PCEN Spectrogram
        img2 = axes[1].imshow(pcen_vis, aspect='auto', cmap='magma', 
                             extent=[args.offset, args.offset + args.duration, 88 * (sr / 1024), 248 * (sr / 1024)])
        axes[1].set_title(f"PCEN Spectrogram (gain={args.gain}, bias={args.bias}, power={args.power}, b={args.b})")
        axes[1].set_ylabel("Frequency (Hz)")
        axes[1].set_xlabel("Time (seconds)")
        fig.colorbar(img2, ax=axes[1], label="Normalized Response")

        plt.tight_layout()
        plt.savefig(out_img_path, dpi=300)
        plt.close()
        print("Comparison saved successfully.")
    else:
        print("Warning: matplotlib not available. Saving comparison using OpenCV fallback.")
        # Normalize to 0-255 for cv2 save
        db_norm = np.clip((db_vis - db_vis.min()) * 255 / (db_vis.max() - db_vis.min() + 1e-6), 0, 255).astype(np.uint8)
        pcen_norm = np.clip((pcen_vis - pcen_vis.min()) * 255 / (pcen_vis.max() - pcen_vis.min() + 1e-6), 0, 255).astype(np.uint8)
        
        # Stack vertically
        combined = np.vstack([db_norm, pcen_norm])
        import cv2
        cv2.imwrite(str(out_img_path), combined)
        print(f"Combined grayscale comparison image saved to {out_img_path}.")

if __name__ == "__main__":
    main()
