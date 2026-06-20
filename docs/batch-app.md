# Bird Audio Analyzer — App Reference

This document covers the structure of the unified Bird Audio Analyzer desktop app: its source layout, Tauri command surface, and the two UI modes (Batch and Review).

See [`docs/architecture.md`](architecture.md) for the end-to-end pipeline architecture and ML details.

## Source layout

```
/                          ← repo root (Cargo workspace)
├── batch-core/            ← Rust crate: engine, store, export, CLI bin
│   ├── src/
│   │   ├── lib.rs
│   │   ├── bin/batch.rs   ← headless CLI entry point
│   │   ├── engine.rs
│   │   ├── store.rs       ← SQLite schema + curation methods
│   │   ├── export.rs
│   │   ├── enumerate.rs
│   │   ├── protocol.rs
│   │   └── concurrency.rs
│   └── Cargo.toml
├── src-tauri/             ← Tauri shell (Rust)
│   └── src/
│       ├── commands.rs    ← all Tauri #[tauri::command] definitions
│       ├── state.rs
│       └── main.rs
├── src/                   ← React frontend (TypeScript)
│   ├── components/
│   │   ├── SetupView.tsx
│   │   ├── RunView.tsx
│   │   ├── FileTable.tsx
│   │   ├── ManageCache.tsx
│   │   ├── ReviewView.tsx
│   │   ├── EventTable.tsx
│   │   └── AudioVisualizer.tsx
│   ├── api.ts             ← typed wrappers for invoke() calls
│   └── types.ts
├── scripts/
│   └── ml_engine.py       ← Python ML worker (--worker mode)
├── birdpipe/              ← Python package: stageb, consolidate, worker, constants
├── models/                ← buzz_localizer.pt, classifier.pt
└── Cargo.toml             ← workspace: members = ["batch-core", "src-tauri"]
```

## Tauri command surface

All commands are defined in `src-tauri/src/commands.rs` and registered in `main.rs`.

### Batch commands

| Command | Signature (Rust) | Description |
|---|---|---|
| `start_session` | `(opts: StartOpts) → Result<StartResult>` | Enumerate audio files, create/resume session, spawn Python worker pool, stream progress via `batch://progress`. Fires `batch://done` when complete. |
| `cancel_session` | `() → ()` | Set the shared `AtomicBool` cancel flag; workers stop after the current file. |
| `get_summary` | `(output_dir, session_id) → Result<Summary>` | Aggregate file/event counts for a session. |
| `list_files` | `(output_dir, session_id) → Result<Vec<FileRow>>` | Per-file status rows (path, status, n_events, n_complete, error). |
| `export_session` | `(output_dir, session_id, path, fmt, complete_only, confirmed_only) → Result<usize>` | Export events to CSV or JSON. `complete_only` filters by Stage B quality gate; `confirmed_only` filters by `review_status = 'confirmed'`. Returns row count. |
| `check_health` | `(cwd?) → Result<HealthStatus>` | Verify Python env (torch/ultralytics/librosa), detect hardware device, check model files exist. |
| `prepare_system` | `(cwd?) → Result<()>` | Run `uv sync` to install/update Python dependencies. |
| `check_cache` | `(output_dir) → Result<bool>` | Returns true if `batch.db` exists in the output directory. |
| `clear_cache` | `(output_dir) → Result<()>` | Delete `batch.db`. |
| `get_cached_files` | `(output_dir) → Result<Vec<CachedFile>>` | List path + status for all files in the latest session. |
| `delete_cached_files` | `(output_dir, paths) → Result<()>` | Remove specific files (and their events) from the session, allowing them to be re-processed on next run. |

### Review / curation commands

| Command | Signature (Rust) | Description |
|---|---|---|
| `prepare_review` | `(output_dir, session_id) → Result<()>` | Grants the Tauri asset-protocol scope for the session's input roots. Must be called before the Review UI loads audio. |
| `list_events` | `(output_dir, session_id, path) → Result<Vec<EventRow>>` | Return all events for a specific file, ordered by `t_start`. Includes ML fields and curation fields. |
| `set_event_review` | `(output_dir, event_id, status, label?, note?) → Result<()>` | Set `review_status` (`confirmed` / `rejected` / `unreviewed`), optional label and note; stamps `reviewed_at`. |
| `update_event_bounds` | `(output_dir, event_id, t_start, t_end, f_low, f_high) → Result<()>` | Update time/frequency bounds of an event; recomputes `duration` and `center_freq`. |
| `add_manual_event` | `(output_dir, session_id, path, t_start, t_end, f_low, f_high) → Result<i64>` | Insert a new event with `source='manual'`, `review_status='confirmed'`. Returns the new event id. |
| `delete_event` | `(output_dir, event_id) → Result<()>` | Permanently delete an event row. |

### Frontend events (Tauri event bus)

| Event | Payload | When |
|---|---|---|
| `batch://progress` | `Progress` struct (aggregate counts) | Throttled ~250ms during an active session. |
| `batch://done` | `Result<Summary>` | Emitted once when the engine finishes (success or error). |

## UI modes

### Batch mode

**SetupView** (`src/components/SetupView.tsx`)

- Pick an input folder (via Tauri `open` dialog).
- Choose output directory (defaults to input folder).
- Set `θ_A` (detection sensitivity, default `0.0`) and `θ_B` (quality filter, default `0.530306`).
- System health check (`check_health`) runs on mount; **Prepare System** runs `uv sync`.
- **Begin Listening** calls `start_session`.

**RunView** (`src/components/RunView.tsx`)

- Subscribes to `batch://progress` and `batch://done`.
- Shows per-file progress via `FileTable`.
- **Cancel** triggers `cancel_session`.
- On completion, shows summary counts (`n_events`, `n_complete`, `n_retained`) and enables export and switch to Review.

**ManageCache** (`src/components/ManageCache.tsx`)

- Calls `get_cached_files` / `delete_cached_files` / `clear_cache`.
- Lets you selectively remove files from the session cache so they are re-processed next run.

### Review mode

**ReviewView** (`src/components/ReviewView.tsx`)

- Calls `prepare_review` on mount to unlock audio file access via the asset protocol.
- Displays the file list (from `list_files`). Clicking a file calls `list_events` for that file.
- Audio is loaded with `convertFileSrc()` using Tauri's asset-protocol URL.

**AudioVisualizer** (`src/components/AudioVisualizer.tsx`)

- Renders the spectrogram canvas with event bounding boxes.
- Drag an existing box → `update_event_bounds`.
- Draw a new box → `add_manual_event`.
- Click a box → selects the event in `EventTable`.

**EventTable** (`src/components/EventTable.tsx`)

- Lists events for the selected file with ML scores and `review_status`.
- Confirm / Reject / Unreviewed buttons → `set_event_review`.
- Delete button → `delete_event`.

## Headless CLI

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db output/batch.db \
  --export-csv events.csv
```

The CLI shares the same `run_session` function from `batch-core/src/engine.rs` as the Tauri GUI. It does not support the Review/curation workflow (write curation annotations via the app).

## SQLite schema — events curation columns

Added by `ensure_curation_columns` in `batch-core/src/store.rs` (idempotent migration on `Store::open`):

| Column | Type | Default | Meaning |
|---|---|---|---|
| `review_status` | TEXT | `unreviewed` | `unreviewed` / `confirmed` / `rejected` |
| `source` | TEXT | `ml` | `ml` (detector output) or `manual` (user-drawn) |
| `label` | TEXT | NULL | Free-text label (e.g. species code) |
| `note` | TEXT | NULL | Free-text annotation |
| `reviewed_at` | TEXT | NULL | ISO datetime stamped by `set_event_review` |
