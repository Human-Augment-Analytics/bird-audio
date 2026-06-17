# Bird Audio Analyzer

A desktop application for automated detection and curation of bird vocalizations —
specifically the high-frequency **"buzz"** call of the Hume's Leaf Warbler
(*Phylloscopus humei*, "HLW"). Point it at a folder of field recordings and it
streams every file through a PyTorch ML pipeline, persists results to a local
database, and exports analysis-ready event tables.

The project has two parts:

- **The ML pipeline** (`birdpipe/`, `scripts/ml_engine.py`, `models/`) — a
  Python-native, paper-faithful detection pipeline.
- **The batch app** (`batch-app/`) — a Tauri + Rust + React desktop product that
  orchestrates the pipeline across thousands of files with resume, retries, live
  progress, and CSV/JSON export.

## Documentation

- **[`docs/architecture.md`](docs/architecture.md)** — conceptual system overview, diagrams, and the θ_A / θ_B threshold semantics.
- **[`docs/batch-app.md`](docs/batch-app.md)** — developer reference for the desktop app: engine, worker protocol, Tauri IPC surface, frontend, CLI, build & packaging.

## ML pipeline architecture

The pipeline uses a **Quarter-Step YOLO Streaming** architecture to process large
audio files (1 GB+) with high temporal resolution and a constant memory footprint.

### 1. Feature extraction
Audio is streamed in blocks using `librosa.stream`. For each block, a Short-Time
Fourier Transform (STFT) generates spectrogram features.

### 2. Quarter-step sliding window
To ensure no calls are missed at window boundaries, the system uses a sliding window
that advances by 25% (quarter-step) of the window width.
- **Frequency band**: analysis is focused on the `[88:248]` STFT bins
  (≈ 4125–11625 Hz), optimized for the high-frequency "buzz" of the Hume's Leaf
  Warbler.

### 3. Two-stage inference
The system uses `ultralytics.YOLO` to run native inference on PyTorch checkpoints
(`.pt`), with hardware acceleration on **CUDA** (NVIDIA), **MPS** (Apple Silicon),
or **CPU**.
- **Stage A — Detection**: `buzz_localizer.pt` identifies candidate buzz
  vocalizations per analysis window. Overlapping per-window detections are then
  *consolidated* into event-level tracks.
- **Stage B — Completeness curation**: `classifier.pt` scores each consolidated
  event for *completeness* — `p("full")`, i.e. how clean/fully-formed the buzz is —
  **not** species identity. This score drives the Quality Filter (`θ_B`).

See [`docs/architecture.md`](docs/architecture.md) for the full pipeline and the
`θ_A` (Detection Sensitivity) / `θ_B` (Quality Filter) thresholds.

## Getting started

We recommend [**uv**](https://github.com/astral-sh/uv) for the Python environment —
it is significantly faster than `venv`/`conda` and handles ML dependencies reliably.

### 1. Install uv
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2. Set up the Python environment
```bash
uv sync
```

### 3. Verify the models
```bash
uv run scripts/verify_models.py
```

This checks `models/buzz_localizer.pt` (Stage A) and `models/classifier.pt`
(Stage B) against expected checksums.

## Running

### Desktop app (recommended)

```bash
cd batch-app
npm install
npm run tauri dev
```

The app launches a **Setup** screen: pick a recording folder, set the Detection
Sensitivity (θ_A) and Quality Filter (θ_B), and press **Begin Listening**. A live
**Run** dashboard shows progress, per-file status, and throughput; on completion you
can export the detected events to CSV or JSON. Requires Rust, Node, and `uv`.

To build distributable bundles: `npm run tauri build`. (See the packaging notes in
[`docs/batch-app.md`](docs/batch-app.md#11-known-limitations--packaging-gotchas)
before shipping standalone.)

### Headless batch (CLI)

The same engine without the GUI — useful for servers and scripting. Run from the
repo root so the worker command and `models/` resolve:

```bash
cargo run --manifest-path batch-app/Cargo.toml -p batch-core --bin batch -- \
  --input data/ --device cpu --db output/batch.db --export-csv events.csv
```

### Single file (pipeline only)

Process one recording directly through the Python pipeline:

```bash
# Auto-detect device (prefers CUDA/MPS); or force --device cpu / mps
uv run scripts/ml_engine.py --input data/recording.WAV
```

## Output & persistence

The batch app stores all state in a SQLite database, **`<output_dir>/batch.db`**,
with three tables — `sessions`, `files`, and `events`. Because the database *is* the
durable state, runs are **resumable and idempotent**: re-pointing at the same folder
skips already-processed files and recovers any interrupted ones.

- **Export** — from the app (or the CLI `--export-csv`), events are written to
  **CSV** or **JSON**, optionally restricted to *complete* events only.
- **Per-detection artifacts** — when run with artifacts enabled (the single-file
  pipeline path), `vis/` (annotated spectrograms), `crops/` (image segments),
  `wav/` (audio clips), and `labels/` (YOLO-format coordinates) are written to the
  output directory. The batch app runs in `manifest_only` mode by default and
  records events to the database instead.
