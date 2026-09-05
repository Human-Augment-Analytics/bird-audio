# Phase 4: Advanced Search & Active Learning

This document describes the design, implementation, and usage of the three prototype scripts developed in Phase 4 under the [scripts/](file:///Users/leyangloh/dev/bird-audio-pwa/scripts) directory.

---

## 1. PCEN Preprocessor

Per-Channel Energy Normalization (PCEN) is a modern alternative to logarithmic scaling (dB) of spectrograms, particularly suited for bioacoustic applications. PCEN addresses key challenges in outdoor audio recordings, such as:
* **Varying background noise levels** (e.g., wind, rain).
* **Constant frequency interferers** (e.g., electronic hums, cicadas).
* **Transient signals** (e.g., brief bird calls).

### Implementation Details
The [pcen_preprocessor.py](file:///Users/leyangloh/dev/bird-audio-pwa/scripts/pcen_preprocessor.py) script implements PCEN using `librosa.pcen`. It uses **bioacoustic-tuned parameters** optimized for transient bird calls:
* `gain`: 0.98
* `bias`: 2.0
* `power`: 0.5
* `b`: 0.035 (smoothing coefficient)
* `eps`: 1e-6

### Usage
To run the preprocessor comparison mode and output a side-by-side visualization of standard dB vs PCEN spectrograms:

```bash
uv run python scripts/pcen_preprocessor.py --input data/20250611_080000.WAV --offset 10.0 --duration 10.0
```

#### Key Arguments
* `--input`: Path to input WAV file (searches `data/` automatically if omitted).
* `--output-dir`: Where to save comparison plot (default: `output/`).
* `--offset`: Start time offset in seconds (default: 10.0).
* `--duration`: Clip duration to visualize in seconds (default: 10.0).

#### Output
The script saves a side-by-side comparison visualization to `output/pcen_comparison.png`, which illustrates the enhanced signal-to-noise ratio (SNR) of the PCEN response.

---

## 2. Active Learning Loop

The Active Learning script creates a pipeline to fine-tune the YOLO localizer (`buzz_localizer.pt`) using user-curated results from the application database.

### Implementation Details
The [active_learning.py](file:///Users/leyangloh/dev/bird-audio-pwa/scripts/active_learning.py) script:
1. Queries the SQLite database [batch.db](file:///Users/leyangloh/dev/bird-audio-pwa/data/batch.db) to retrieve consolidated events.
2. Extracts **positives** (`retained = 1`) and **false positives** (`retained = 0` but `stage_a_conf >= min_stage_a_conf`).
3. Centers a `T_W` (2.7467s) window around each selected event, extracts the corresponding audio, and computes the cropped dB spectrogram matching the input format of the YOLO model.
4. Generates YOLO-style text annotations:
   - For positive events, it maps absolute time/frequency boundaries to normalized YOLO coordinates (`class_id x_center y_center width height`).
   - For negative/false-positive events, it outputs an **empty label file**, which teaches the model to suppress false alarms on that background/interferer.
5. Saves a `dataset.yaml` metadata file referencing the absolute paths of the generated training files.

### Dataset Directory Structure
The output dataset is organized according to the Ultralytics YOLO requirements:
```
dataset_active_learning/
├── dataset.yaml
├── audio/
│   ├── event_00001.wav
│   └── ...
├── images/
│   ├── event_00001.png
│   └── ...
└── labels/
    ├── event_00001.txt (contains boxes or is empty)
    └── ...
```

### Usage
To build the dataset from all sessions:

```bash
uv run python scripts/active_learning.py --db data/batch.db --dataset-dir output/dataset_active_learning --min-stage-a-conf 0.5
```

#### Key Arguments
* `--db`: SQLite database file path (default: `data/batch.db`).
* `--session-id`: Limit data extraction to a specific session ID.
* `--output-dir`: Limit data extraction to sessions matching a specific output directory.
* `--dataset-dir`: Output directory path (default: `dataset_active_learning`).
* `--min-stage-a-conf`: Minimum Stage A confidence threshold for rejected events to be included as negative training samples (default: 0.5).

---

## 3. Query-by-Example Search

Query-by-Example (QBE) enables users to surface potential false negatives (missed calls) by finding calls that look or sound similar to a validated target event.

### Implementation Details
The [query_by_example.py](file:///Users/leyangloh/dev/bird-audio-pwa/scripts/query_by_example.py) script:
1. Loads the target query event and all comparison events from the database.
2. Extracts feature representation vectors for each event:
   - **Spectrogram Patch**: Crops the 2D STFT magnitude spectrogram to the exact event bounding box (time-frequency limits), resizes it to a fixed `32x32` grid, and normalizes it. This represents the geometric structure/contour of the call.
   - **Mel-Frequency Cepstral Coefficients (MFCCs)**: Extracts 20 MFCCs from the clip, computing the mean and standard deviation over time. This captures the spectral timbre.
   - **Duration**: Appends normalized duration.
3. Caches computed features into a compressed `.npz` file under the `--cache-dir` directory for instant subsequential searches.
4. Computes the **Cosine Similarity** between the query feature vector and the database pool:
   $$\text{Similarity}(A, B) = \frac{A \cdot B}{\|A\|_2 \|B\|_2}$$
5. Sorts the database events by similarity and returns the top-k nearest neighbors.

### Usage
To run a query for event ID `1`:

```bash
uv run python scripts/query_by_example.py --query-id 1 --k 5
```

#### Key Arguments
* `--db`: SQLite database file path (default: `data/batch.db`).
* `--query-id`: Database primary key ID of the query event (required).
* `--session-id`: Limit the search pool to events within a specific session ID (defaults to the query event's session).
* `--k`: Number of matches to output (default: 5).
* `--feature-type`: Feature representation to use: `spectrogram`, `mfcc`, or `combined` (default: `combined`).
* `--recache`: Force feature extraction to re-run and overwrite the cache file.

---

## 4. Verification and Regression Testing

All scripts have been verified to execute without errors in the project python environment. Regression tests have been executed to ensure no changes disrupt the core batch processing pipeline:

```bash
# Run backend Python tests
uv run pytest

# Run core Rust engine unit and integration tests
cargo test
```
All 44 Python tests and 34 Rust tests pass successfully.
