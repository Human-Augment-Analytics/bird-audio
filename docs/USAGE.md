# Bird Audio Analyzer — Usage Tutorial

A step-by-step guide to a full session: **install → run a batch → review detections → export a clean dataset.**

The app is a [Tauri](https://tauri.app/) desktop application (React frontend, Rust + Python backend) for detecting and curating bird vocalizations from field recordings, optimized for the **Hume's Leaf Warbler** (*Phylloscopus humei*). It has four workspaces: **Batch**, **Review**, **Analytics**, and **Research**. See the [feature guide](feature-guide.md) for screenshots and interpretation.

> _Walkthrough video — to be added._

---

## 1. Install & launch

### Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **uv** | Python environment + dependencies | <https://github.com/astral-sh/uv> |
| **Rust + Cargo** | builds the Tauri backend | <https://rustup.rs/> |
| **Tauri prerequisites** | platform webview + build tooling | <https://tauri.app/start/prerequisites/> |
| **Node.js** | builds the React frontend | <https://nodejs.org/> |

### Install dependencies

From the repository root:

```bash
npm install   # frontend dependencies
uv sync       # Python environment for the ML pipeline
```

### Launch

```bash
npm run tauri dev
```

The first launch compiles the Rust backend (a few minutes is normal) and opens the desktop window.

### First run — Prepare System

On first launch the app runs a **health check** of the Python environment and the model files (`models/buzz_localizer.pt`, `models/classifier.pt`). If anything is missing, click **Prepare System** and wait for the check to turn green. The app then auto-selects the best available device: **CUDA** (NVIDIA) → **MPS** (Apple Silicon) → **CPU**.

---

## 2. Batch mode — find the calls

### Setup

<!-- screenshot: Setup view -->

- **Input folder** — the folder of recordings (subfolders included).
- **Output directory** — where results are written. All state lives in `<output_dir>/batch.db`.
- **θ_A — detection sensitivity** *(optional)*. Lower = more candidate detections (and more false positives); higher = stricter.
- **θ_B — quality filter** *(optional)*. Filters events by Stage-B *completeness* score — how clean/fully-formed the buzz is. Raise it to keep only the cleanest events.

> Not sure what to set? The defaults are tuned for the Hume's Leaf Warbler. You can always lower θ_B and inspect borderline events yourself in Review.

### Run

<!-- screenshot: Run view with per-file progress -->

The pipeline processes every audio file in the folder, showing **per-file progress**, a **clock-time ETA**, and running **buzz counts**. Results are aggregated into `batch.db` as it goes.

The database is the durable checkpoint. On resume, unchanged completed files are skipped, changed files are reprocessed with stale detections replaced, and removed inputs are pruned.

---

## 3. Review mode — curate the detections

After a batch run, switch to **Review** to turn raw ML output into a verified dataset.

<!-- screenshot: Review view — file list + spectrogram with event boxes -->

1. **Pick a file.** The file list shows every processed recording; click one to load its events.
2. **Inspect on the spectrogram.** Each detected event is drawn as a bounding box over the audio. Use the playback controls to listen — **zoom**, **seek**, change **playback rate** (down to 0.25×), and **mute**.
3. **Judge each event:**
   - **Confirm** — a real, wanted call.
   - **Reject** — a false positive (kept in the DB, marked rejected).
   - **Reset** — back to *unreviewed*.
4. **Fix the bounds.** Drag the edges of an event box to correct its time/frequency extent.
5. **Add a manual event.** Draw a new box on the spectrogram for a call the model missed.
6. **Delete** an event entirely to remove a false positive from the data.

Decisions are saved to `batch.db` and accumulate across Review sessions — stop and resume curation any time.

### Keyboard shortcuts

Reviewing thousands of detections with the mouse is the slowest part of the workflow. Press **?**
in Review mode to see the shortcuts, or use them directly:

| Key | Action |
|---|---|
| `J` / `↓` | Next event |
| `K` / `↑` | Previous event |
| `C` | Confirm and advance |
| `X` | Reject and advance |
| `U` | Mark unreviewed |
| `N` | Jump to the next unreviewed event (wraps, so skipped events are still reached) |
| `?` | Toggle the shortcut help |

Shortcuts are suppressed while you are typing in a text field. A `REVIEWED n/total` counter tracks
progress through the current file.

### Review effort is recorded

Every decision, and navigation actions like opening a file or playing audio, are logged to a
`review_events` table with timing. Gaps longer than two minutes are treated as breaks and excluded,
so the resulting per-decision cost reflects actual review time. This is what lets
`scripts/verification_planner.py` estimate remaining effort from *measured* seconds per decision
rather than a guess. Export it with `batch --export-telemetry <path>` or the app's telemetry export.

---

## 4. In-App Sanity Check Views

Once a batch run is complete, the app automatically pulls the session results to render three interactive diagnostic visualizations on the complete card:
*   **Elevation vs. Duration Plot:** Displays the distribution of event durations across Low (PSL), Medium (PSM), and High (PSH/H) altitude bands. The app categorizes events by parsing the recorder ID prefix (e.g. `PSL2`, `PSM5`) from the audio filenames.
*   **Bout Activity Timeline:** A density histogram displaying event frequencies in 5-minute bins across the session duration, highlighting burst behaviors.
*   **Sortable Site Summaries:** A detailed table summarizing event count, mean duration, and median frequency for each unique site/recorder. You can sort columns to quickly identify outliers.

---

## 5. Export

The application supports exporting analysis-ready datasets directly from the complete panel:
*   **Formats:** Export to standard **CSV**, **JSON**, **warbleR-compatible CSV** (with columns like `sound.files`, `selec`, `start`, `end`), or **Raven Selection Table** (tab-separated `.txt`).
*   **Confirmed only:** Toggle this on to limit exports to events that were reviewed and marked as `confirmed` (including manually added ones).
*   **Deployment Metadata Join:** Optionally browse and select a metadata CSV file containing recorder deployment parameters (`device_id`, `site_id`, `elevation_m`, `lat`, `lon`, `deploy_date`). When chosen:
    1.  The exported file will automatically join the `site_id`, `elevation_m`, `lat`, and `lon` fields to each event row by identifying the `device_id` from the filename.
    2.  A secondary site-level summary CSV (`<export_filename>_summary.csv`) will be generated, containing session-level aggregations (`site_id`, `session_datetime`, `elevation_m`, `n_events`, `duration_mean`, `duration_median`, `center_freq_mean`, `effort_hours`). Effort uses measured WAV/FLAC/MP3 duration when readable and a disclosed 0.25-hour fallback otherwise.

### Headless CLI (batch only)

Run the pipeline without the GUI:

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db output/batch.db \
  --export-csv events.csv
```

---

## Output reference

| Artifact | What it is |
| --- | --- |
| `<output_dir>/batch.db` | SQLite database — the durable source of truth (events + curation state). Resumable and idempotent. |
| `events.csv` / `events.json` | Exported events joined to file paths, ordered by path then time. Optionally confirmed-only. |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| App says the system isn't ready | Click **Prepare System**; wait for the health check to go green. |
| Inference is slow / "no device" | The app falls back to CPU when no GPU is found. Check CUDA drivers (NVIDIA) or that you're on Apple Silicon (MPS). |
| First `tauri dev` takes minutes | Normal — the first Rust build is slow; later runs are incremental. |
| Too many false positives | Raise **θ_A** and/or **θ_B** in Setup, or reject them in Review. |
| Missing real calls | Lower **θ_A**, or add them manually in Review. |
| Re-ran a folder, nothing happened | Expected — runs are idempotent; processed files are skipped. Use a fresh output DB or clear the results cache to reprocess. |
| Spectrogram controls unresponsive | They activate once the waveform finishes loading; wait a moment after selecting a file. |

Still stuck? Open an issue: <https://github.com/Human-Augment-Analytics/bird-audio/issues>.

For more hands-on workflows and downstream usage:
- **[Your First Analysis Session](tutorial-first-analysis.md)** — Step-by-step guided analysis walk-through.
- **[Active Learning Loop Tutorial](tutorial-active-learning.md)** — Learn how to fine-tune the model to improve performance.
- **[Export Cookbook](tutorial-export-cookbook.md)** — Detailed snippets to load and visualize data in R, Python, and Raven Pro.

For the pipeline internals (Quarter-Step YOLO streaming, Stage A / Stage B, the `θ_A` / `θ_B` thresholds), see [`architecture.md`](architecture.md).
