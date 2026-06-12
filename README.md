# Bird Audio Analysis Pipeline (Backend)

This repository provides a high-performance Python-native pipeline for the automated detection and classification of bird vocalizations, specifically optimized for the Hume's Leaf Warbler (*Phylloscopus humei*).

## High-Performance Native Inference

The pipeline is built on a **Python/PyTorch backend**, designed to handle extremely large audio recordings (1GB+ WAV files) that exceed the memory limits of standard web browsers.

### Key Components

- **Detection & Localization**: A CNN-based model (`buzz_localizer.pt`) that identifies time-frequency regions (bounding boxes) within a spectrogram likely to contain bird activity.
- **Classification**: A multi-class classifier (`classifier.pt`) that distinguishes between specific species calls and environmental noise.
- **Consolidation**: Python-native logic to merge overlapping or adjacent detection events into single, continuous segments.

## Pipeline Architecture

1.  **Audio Loading**: High-speed decoding using `librosa` and `torchaudio`.
2.  **Segmented Processing**: Audio is processed in sliding windows to ensure constant memory footprint regardless of file size.
3.  **Localizer Pass**: Generates high-confidence candidates for bird activity.
4.  **Classifier Pass**: Refines candidates to species-level labels.
5.  **JSON Export**: Standardized detection results for integration with visualization tools or databases.

## Getting Started (CLI)

### 1. Requirements
- Python 3.9+
- PyTorch
- librosa
- numpy

### 2. Running Inference
The main entry point is the `ml_engine.py` script:

```bash
python scripts/ml_engine.py --input path/to/large_recording.wav
```

### 3. Model Verification
Ensure the integrity of your model checkpoints:
```bash
python scripts/verify_models.py
```
