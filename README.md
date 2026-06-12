# Bird Audio Analysis Pipeline

A high-performance Python-native pipeline for automated detection and classification of bird vocalizations, specifically optimized for the Hume's Leaf Warbler (*Phylloscopus humei*).

## Technical Architecture

The pipeline uses a **Quarter-Step YOLO Streaming** architecture to process large audio files (1GB+) with high temporal resolution and a constant memory footprint.

### 1. Feature Extraction
Audio is streamed in blocks using `librosa.stream`. For each block, a Short-Time Fourier Transform (STFT) generates spectrogram features.

### 2. Quarter-Step Sliding Window
To ensure no calls are missed at window boundaries, the system uses a sliding window that advances by 25% (quarter-step) of the window width (approx. 30ms resolution).
- **Frequency Band**: Analysis is focused on the [88:248] STFT bins, optimized for the high-frequency "buzz" of the Hume's Leaf Warbler.

### 3. Native Inference
The system uses `ultralytics.YOLO` to run native inference on PyTorch checkpoints (`.pt`).
- **Hardware Acceleration**: Supports **CUDA** (NVIDIA), **MPS** (Apple Silicon), and **CPU**.
- **Detection**: `buzz_localizer.pt` identifies candidate vocalizations.
- **Classification**: `classifier.pt` refines species labels.

## Getting Started

We recommend using [**uv**](https://github.com/astral-sh/uv) for environment and dependency management. It is significantly faster than `venv` or `conda` and handles ML dependencies reliably.

### 1. Installation
Install `uv` if you haven't already:
```bash
curl -LsSf https://astral-sh/uv/install.sh | sh
```

### 2. Environment Setup
Initialize the environment and sync dependencies:
```bash
uv sync
```

### 3. Model Verification
Verify the integrity of your local model checkpoints:
```bash
uv run scripts/verify_models.py
```

### 4. Running Inference
Process an audio file through the pipeline. You can explicitly specify the device for acceleration:
```bash
# Auto-detect device (prefers CUDA/MPS)
uv run scripts/ml_engine.py --input data/recording.WAV

# Force CPU usage
uv run scripts/ml_engine.py --input data/recording.WAV --device cpu

# Use Apple Silicon (Metal)
uv run scripts/ml_engine.py --input data/recording.WAV --device mps
```

## Output Structure

The pipeline generates several artifacts in the `--output` directory:
- `vis/`: Spectrogram visualizations with detection bounding boxes (JPEG).
- `crops/`: Raw spectrogram image segments (PNG).
- `wav/`: Extracted audio clips of each detection.
- `labels/`: YOLO-format detection coordinates and confidence scores (TXT).
- `results.json`: (Future) Consolidated detection manifest.
