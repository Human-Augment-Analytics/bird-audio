# Bird Audio Analyzer

A desktop app for automated detection and curation of bird vocalizations from field recordings, optimized for the Hume's Leaf Warbler (*Phylloscopus humei*).

Built with Tauri + React (frontend) and Rust + Python (backend). One app, two modes:

- **Batch mode** — pick a folder, set thresholds, run the ML pipeline across all recordings.
- **Review mode** — step through files, inspect detections on a spectrogram, confirm/reject/edit ML events and add manual annotations.

> 📖 New here? Start with the **[Usage Tutorial](docs/USAGE.md)** — install, run a batch, review, and export, step by step.

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
- **Stage A — Detection**: `buzz_localizer.pt` identifies candidate buzz vocalizations per analysis window. Overlapping per-window detections are then consolidated into event-level tracks.
- **Stage B — Completeness Curation**: `classifier.pt` scores each consolidated event for *completeness* — `p("full")`, i.e. how clean/fully-formed the buzz is — **not** species identity. This score drives the Quality Filter (`θ_B`). See [`docs/architecture.md`](docs/architecture.md) for the full pipeline and the `θ_A` / `θ_B` thresholds.

## Getting Started

### Prerequisites

- [**uv**](https://github.com/astral-sh/uv) for Python environment management
- [Rust + Cargo](https://rustup.rs/) and [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites/)
- Node.js (for the frontend)

### Install dependencies

```bash
npm install
uv sync
```

### Run the desktop app

```bash
npm run tauri dev
```

This launches the Tauri desktop window. The first run checks for Python dependencies and model files; click **Prepare System** if prompted.

### Headless CLI (batch only)

Run the batch pipeline without the GUI:

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db output/batch.db \
  --export-csv events.csv
```

## App Modes

### Batch Mode (Setup → Run)

1. **Setup** — pick an input folder, output directory, and optionally adjust `θ_A` (detection sensitivity) and `θ_B` (quality filter).
2. **Run** — the pipeline processes all audio files in the folder. Progress is shown per-file; results are aggregated into `batch.db`.
3. **Export** — save detected events as CSV or JSON. The *confirmed only* option exports only events you have confirmed in Review mode.

### Review Mode

After a batch run, switch to Review mode to curate the ML detections:

- A file list shows all processed recordings. Click a file to load its events.
- Events are displayed on an interactive spectrogram with bounding boxes.
- For each event you can: **confirm**, **reject**, or reset to *unreviewed*.
- Edit an event's time/frequency bounds by dragging on the spectrogram.
- Add manual events by drawing a box on the spectrogram.
- Delete false positives entirely.
- Use the confirmed-only export to output only your verified detections.

## Output Structure

All state is stored in `<output_dir>/batch.db` (SQLite). The database is the durable checkpoint: runs are resumable and idempotent — done files are skipped on re-run, and events accumulate curation annotations across Review sessions.

Export artifacts:
- `events.csv` / `events.json`: detected (and optionally curated) events joined to file paths, ordered by path then time.
