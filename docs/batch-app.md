# Bird Audio Analyzer — App Reference

This document covers the structure of the Bird Audio Analyzer desktop app: its source layout, the Tauri command surface, how a re-run decides which session to resume, the three workspaces (Batch, Review, Analytics), and the SQLite schema.

See [`docs/architecture.md`](architecture.md) for the end-to-end pipeline architecture and ML details.

## Source layout

```
/                          ← repo root (Cargo workspace)
├── batch-core/            ← Rust crate: engine, store, export, identity, CLI bin
│   ├── src/
│   │   ├── lib.rs
│   │   ├── bin/batch.rs   ← headless CLI entry point
│   │   ├── engine.rs      ← run_session: enumerate, claim, worker pool, retries, resume
│   │   ├── store.rs       ← SQLite schema, curation methods, find_resumable
│   │   ├── identity.rs    ← model/code identity and the session results key
│   │   ├── worker.rs      ← Python worker process (spawn, protocol, process-group kill)
│   │   ├── export.rs      ← CSV / JSON / warbleR / Raven / telemetry writers
│   │   ├── audio.rs       ← WAV/FLAC/MP3 duration for effort measurement
│   │   ├── enumerate.rs
│   │   ├── protocol.rs
│   │   └── concurrency.rs
│   └── Cargo.toml
├── src-tauri/             ← Tauri shell (Rust)
│   └── src/
│       ├── lib.rs               ← command registration, app setup
│       ├── main.rs
│       ├── commands.rs          ← batch, cache, review and export commands
│       ├── ecology_commands.rs  ← get_ecological_summary (Analytics)
│       ├── script_commands.rs   ← run_verification_plan (shells out to scripts/)
│       └── state.rs
├── src/                   ← React frontend (TypeScript)
│   ├── App.tsx            ← workspace tabs, progress subscription, session lifecycle
│   ├── components/
│   │   ├── SetupView.tsx        ← folder, thresholds, analysis target, health check
│   │   ├── ManageCache.tsx      ← drop files from a cached session
│   │   ├── RunView.tsx          ← progress, counts, speed/ETA, export options
│   │   ├── FileTable.tsx
│   │   ├── ReviewView.tsx       ← file list, undo/redo, shortcuts, verification panel
│   │   ├── VerificationPanel.tsx
│   │   ├── AudioVisualizer.tsx  ← wavesurfer waveform + spectrogram + bounding boxes
│   │   ├── EventTable.tsx
│   │   └── EcologyView.tsx      ← Analytics workspace
│   ├── reviewShortcuts.ts ← keyboard handling for Review
│   ├── api.ts             ← typed wrappers for invoke() calls
│   └── types.ts
├── scripts/
│   ├── ml_engine.py       ← Python ML worker (--worker mode) and single-file CLI
│   └── *.py               ← analysis CLIs (ecology, sensitivity, verification, manifest…)
├── birdpipe/              ← Python package: stageb, consolidate, records, worker, constants, …
├── models/                ← buzz_localizer.pt, classifier.pt
├── tests/                 ← pytest suite for birdpipe and scripts
└── Cargo.toml             ← workspace: members = ["batch-core", "src-tauri"]
```

## Tauri command surface

Commands live in `src-tauri/src/commands.rs`, `ecology_commands.rs` and `script_commands.rs`, and are registered in `lib.rs`. Every command the frontend calls has a typed wrapper in `src/api.ts`.

### Batch commands

| Command | Signature (Rust) | Description |
|---|---|---|
| `start_session` | `(opts: StartOpts) → Result<StartResult>` | Enumerate audio files, create or resume a session (see *Session identity* below), spawn the Python worker pool, stream progress via `batch://progress`. Fires `batch://done` when complete. |
| `cancel_session` | `() → ()` | Set the shared cancel flag; workers stop after the current file and their process groups are killed. |
| `open_existing_session` | `(output_dir) → Result<OpenSessionResult>` | Open the most complete previous session in a folder without processing, returning its options and summary so Review and Analytics can load. |
| `get_summary` | `(output_dir, session_id) → Result<Summary>` | Aggregate file/event counts for a session. |
| `list_files` | `(output_dir, session_id) → Result<Vec<FileRow>>` | Per-file status rows (path, status, `n_events`, `n_complete`, `n_retained`, error). |
| `get_session_events` | `(output_dir, session_id) → Result<Vec<ExportedEvent>>` | All event rows for a session with file paths and scores. |
| `export_session` | `(output_dir, session_id, path, fmt, complete_only, confirmed_only, metadata_path?) → Result<usize>` | Export events as `csv`, `json`, `warbler`, `raven` or `telemetry`. `complete_only` keeps `completeness_label = 'complete'`; `confirmed_only` keeps `review_status = 'confirmed'`. Optionally joins deployment metadata and writes a site summary. Returns the row count. |
| `check_health` | `(cwd?, models?) → Result<HealthStatus>` | Verify the Python env (torch/ultralytics/librosa), detect the hardware device, check the model files exist. |
| `prepare_system` | `(cwd?) → Result<()>` | Run `uv sync` to install or update Python dependencies. |
| `concurrency_suggestion` | `(device) → usize` | Recommended worker count for the device. |
| `get_feature_flags` | `(cwd?) → Result<Value>` | Optional feature toggles read from the project directory. |
| `check_cache` | `(output_dir) → Result<bool>` | True if `batch.db` exists in the folder. |
| `get_cached_files` | `(output_dir) → Result<Vec<CachedFile>>` | Path and status for every file in the latest session. |
| `delete_cached_files` | `(output_dir, paths) → Result<()>` | Remove specific files (and their events) from the session so they are re-processed on the next run. |
| `clear_cache` | `(output_dir) → Result<()>` | Delete `batch.db`. |

### Review / curation commands

| Command | Signature (Rust) | Description |
|---|---|---|
| `prepare_review` | `(output_dir, session_id) → Result<()>` | Grant the Tauri asset-protocol scope for the session's input roots. Called before the Review UI loads audio. |
| `list_events` | `(output_dir, session_id, path) → Result<Vec<EventRow>>` | All events for one file, ordered by `t_start`, with ML and curation fields. |
| `set_event_review` | `(output_dir, event_id, status, label?, note?) → Result<()>` | Set `review_status` (`confirmed` / `rejected` / `unreviewed`), optional label and note; stamps `reviewed_at`. |
| `update_event_bounds` | `(output_dir, event_id, t_start, t_end, f_low, f_high) → Result<()>` | Update time/frequency bounds; recomputes `duration` and `center_freq`. |
| `add_manual_event` | `(output_dir, session_id, path, t_start, t_end, f_low, f_high, human_completeness) → Result<i64>` | Insert an event with `source='manual'`, `review_status='confirmed'` and no ML scores. The app passes `human_completeness = "unsure"`, which leaves completeness unresolved. Returns the new id. |
| `delete_event` | `(output_dir, event_id) → Result<()>` | Delete an event row. |
| `restore_event` | `(output_dir, event: EventRow) → Result<i64>` | Re-insert a deleted event with its scientific fields intact (used by Undo). |
| `log_review_action` | `(output_dir, session_id, action, event_id?, meta?) → Result<()>` | Record a non-mutating review action (`play` / `seek` / `open_file` / `search` / verification queue use) in `review_events`. Mutating commands log themselves. |
| `get_review_telemetry` | `(output_dir, session_id, idle_cutoff_ms?) → Result<ReviewTelemetrySummary>` | Aggregate review effort: action counts, total review time, mean/median seconds per decision. |
| `run_verification_plan` | `(db_path, threshold, target_half_width, strategy, budget, theta_b, session_id?) → Result<String>` | Run `scripts/verification_planner.py --json` and return the plan: current precision with a Wilson interval, decisions still needed for the target half-width, and a ranked queue. |

### Analytics command

| Command | Signature (Rust) | Description |
|---|---|---|
| `get_ecological_summary` | `(output_dir, session_id) → Result<EcologicalSummary>` | Everything the Analytics workspace shows: coverage, measured or estimated effort, retention, review coverage, histograms by recording offset, Stage A / completeness score, duration and center frequency, review composition, retained rate by elevation band, and the per-recorder table, plus data-quality notices. Bands are inferred from `PSL` / `PSM` / `PSH` / `H` recorder prefixes in file paths. |

Scripts are run through the same `uv run` machinery as `check_health`; a non-zero exit surfaces the script's stderr in the error string.

### Frontend events (Tauri event bus)

| Event | Payload | When |
|---|---|---|
| `batch://progress` | `Progress` struct (aggregate counts) | Throttled ~250 ms during an active session. The first event can precede the listener, so the frontend seeds its throughput baseline from the first summary fetch. |
| `batch://done` | `Result<Summary>` | Emitted once when the engine finishes (success, cancel or error). |

## Session identity and resume

`batch.db` can hold many sessions for the same folder. A re-run must resume the right one, and must **not** resume results produced by different settings or a different pipeline.

`start_session` records a `config_key` JSON with every option. `batch_core::identity::results_key` reduces it to two parts:

| Part | Fields | Effect of a change |
|---|---|---|
| **analysis** | `theta_a`, `theta_b`, `species_name`, `f_min_hz`, `f_max_hz`, model file size + mtime | New session |
| **code** | SHA-256 of `scripts/ml_engine.py` and the `birdpipe/` modules | New session |
| ignored | device, working directory, worker command, app version, app binary | Resume |

`Store::find_resumable` scans sessions on the same input roots and device, keeps those whose key is compatible, and picks the one with the most completed files (newest on ties). Sessions written before content hashes existed carry no code part and match on the analysis part alone. **View Existing Results** uses the same "most complete" rule without checking compatibility, since it processes nothing.

Cancelling a run kills the worker's whole process group (`uv` wrapper and the Python child) so no orphan keeps burning CPU; `in_progress` files are reset to `pending` on the next run.

## Workspaces

### Batch

**SetupView** (`src/components/SetupView.tsx`)

- Pick a recording folder with the native dialog; folders used before are offered in a **Recent folders** list stored in the browser's `localStorage`.
- Results always go to `batch.db` in the selected folder.
- Set `θ_A` (detection sensitivity, default `0.0`) and `θ_B` (quality filter, default `0.530306`).
- **Analysis target** (collapsed): species/call name, band low/high (defaults 4125–11625 Hz), and Stage A/B/C model paths. Blank keeps the pipeline default.
- **Advanced** (collapsed): worker command, processing engine (device), execution directory, concurrency, timeout, retry limit.
- The health check runs on mount; **Prepare System** runs `uv sync`.
- **Begin Listening** calls `start_session`. When the folder already has results the buttons become **View Existing Results** (`open_existing_session`) and **Re-run / Resume Batch**, and the **ManageCache** panel appears.

**RunView** (`src/components/RunView.tsx`)

- Shows progress, processing speed, ETA, and three counts: **Detections found** (all consolidated events), **High-quality buzzes** (`completeness_label = 'complete'`) and **Retained records** (threshold-retained events).
- Per-file table with **All** / **Complete** / **Failed** filters.
- **Cancel run** triggers `cancel_session`.
- **Export Options** on completion: format (CSV, JSON, warbleR CSV, Raven Table), **Complete events only**, **Confirmed events only**, optional deployment metadata CSV.

**ManageCache** (`src/components/ManageCache.tsx`)

- Lists the latest session's files with status; **All** / **None** / **Failed** selection chips.
- Clearing a selection calls `delete_cached_files`; clearing everything calls `clear_cache`.

### Review

**ReviewView** (`src/components/ReviewView.tsx`)

- Calls `prepare_review` on load, then `list_files`; clicking a file calls `list_events`.
- Audio is loaded through Tauri's asset protocol with `convertFileSrc()`.
- Keeps an undo/redo history of bounding-box edits, additions and deletions.
- Keyboard: `J`/`K`/arrows move, `C`/`X`/`U` decide, `N` next unreviewed, `?` help, `Delete`/`Backspace`/`D` delete the selected box, `Cmd/Ctrl+Z` undo, `Cmd/Ctrl+Shift+Z` or `Cmd/Ctrl+Y` redo (`src/reviewShortcuts.ts`).
- Hosts the **VerificationPanel**, which calls `run_verification_plan` and jumps to queued events.

**AudioVisualizer** (`src/components/AudioVisualizer.tsx`)

- wavesurfer.js waveform, timeline, regions and a linear-scale spectrogram covering 0 Hz to the analysis band ceiling. Audio is decoded at twice that ceiling so the spectrogram is fully rendered; an overlay shows *decoding* and *generating FFT spectrogram* states.
- Drag a box edge → `update_event_bounds`. **Draw Bounding Box** or drag on the spectrogram → `add_manual_event`. Click a box to select it.
- Zoom, playback rate, mute.

**EventTable** (`src/components/EventTable.tsx`)

- Lists the file's events with scores and `review_status`; Confirm / Reject toggle via `set_event_review`, label/note editing, Delete.

### Analytics

**EcologyView** (`src/components/EcologyView.tsx`)

- Enabled once at least one file has finished; refreshes as files complete and when the session ends.
- Run context, **Retained** / **All detections** scope toggle, data-quality notices, KPI cards, histograms, review composition, rate by elevation band, recorder table.
- All data comes from one `get_ecological_summary` call.

## Headless CLI

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db output/batch.db \
  --export-csv events.csv
```

The CLI shares `run_session` from `batch-core/src/engine.rs` with the GUI and uses the same session identity, so a folder processed overnight on the command line resumes cleanly in the app. It does not support the Review/curation workflow.

Export flags: `--export-csv`, `--export-json`, `--export-telemetry`, and the filters `--complete-only`, `--confirmed-only`, `--metadata <deployments.csv>`. These mirror what the GUI's `export_session` can produce, so a generated reproduction script can reproduce any GUI export.

To emit a runnable reproduction of a completed session:

```bash
uv run python scripts/export_protocol.py --db output/batch.db --out output/protocol
```

This writes `reproduce.sh`, `protocol.json`, and a reference `manifest.json`. The script re-runs the pipeline at the recorded thresholds into a **fresh** database and refuses to proceed if the model digests or pipeline constants no longer match the recorded run.

## SQLite schema — events curation columns

Added by `ensure_curation_columns` in `batch-core/src/store.rs` (idempotent migration on `Store::open`):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `review_status` | TEXT | `unreviewed` | `unreviewed` / `confirmed` / `rejected` |
| `source` | TEXT | `ml` | `ml` (detector output) or `manual` (user-drawn) |
| `label` | TEXT | NULL | Free-text label (e.g. species code) |
| `note` | TEXT | NULL | Free-text annotation |
| `reviewed_at` | TEXT | NULL | ISO datetime stamped by `set_event_review` |
| `human_completeness` | TEXT | NULL | `complete` / `incomplete` / `unsure` for manual events |
| `completeness_source` | TEXT | NULL | who decided completeness: a pipeline source such as `stage_b_accepted`, `human`, or `unresolved` for manual events |

`n_members` on each event is the number of per-window detector boxes the consolidation step folded into it; `1` means a single window saw it. The `review_events` table records review actions with timing; see [`architecture.md`](architecture.md) section 7.
