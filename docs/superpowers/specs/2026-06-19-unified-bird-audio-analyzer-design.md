# Design: Unified "Bird Audio Analyzer" desktop app

**Date:** 2026-06-19
**Branch:** `leyang/pwa-prototype` (work happens directly on this branch)
**Status:** Approved design — pending written-spec review before planning

## 1. Summary

The repository currently carries **two separate front-ends** over one shared Python ML
pipeline (`birdpipe/`, `scripts/ml_engine.py`, `models/`):

- **Acoustic Field Station** (root PWA, `src/`, root `src-tauri/`) — an interactive,
  single-recording tool: mic capture / file upload, waveform + spectrogram viewer,
  editable annotation table, a crude in-browser JS amplitude detector, and an optional
  Tauri-only `NativeProcessor` that shells out to the real pipeline. Stores data in the
  browser (IndexedDB via Dexie). The root `src-tauri` backend is **empty scaffolding**
  (plugins only — no commands, no state).
- **Bird Audio Analyzer / batch-app** (`batch-app/`) — a mature Tauri + Rust + React
  desktop product: point at a folder, stream thousands of files through the real ML
  pipeline, persist to SQLite (`batch.db`), with resume/retry, live progress/ETA/throughput,
  per-file table, cache management, and CSV/JSON export. All real backend logic lives here
  (`batch-core`: engine, worker, protocol, store, export, concurrency; plus wired Tauri
  `commands.rs` + `state.rs`).

**Goal:** collapse these into **one desktop application** named **"Bird Audio Analyzer"**.
It keeps the Field Station's interactive review/annotation UI and gains the batch-app's
real-ML batch engine, with `batch-core` promoted to a shared workspace crate. The
standalone `batch-app/` shell is retired.

## 2. Locked decisions

| Decision | Choice |
| --- | --- |
| End state | **One unified app.** Interactive review + Batch mode in a single product. |
| Deployment target | **Desktop-only (Tauri).** No browser/PWA path. |
| Source of truth | **Single SQLite store** (`<output>/batch.db`). Drop IndexedDB/Dexie. |
| Curation model | **Curate ML events.** Batch writes ML events; the human confirms / rejects / edits / adds; verdicts stored on the events; export filterable to confirmed. |
| Structure | **Clean Cargo workspace at repo root** (Approach A), one Tauri app + one frontend, `batch-app/` deleted. Executed in build-safe phases. |
| App name | **Bird Audio Analyzer** |
| Mic capture + browser upload | **Cut both.** The app works on on-disk folders. |
| Work branch | Directly on `leyang/pwa-prototype`. |

## 3. Target architecture & repo layout

One Cargo workspace at the repo root, one Tauri desktop app, one React frontend.

```
/ (repo root = Cargo workspace)
├── Cargo.toml                 # [workspace] members = ["batch-core", "src-tauri"]
├── batch-core/                # MOVED from batch-app/batch-core
│   ├── src/{engine,worker,protocol,store,export,concurrency,enumerate,lib}.rs
│   ├── src/bin/batch.rs       # headless CLI stays (workspace member)
│   └── tests/{integration.rs, fake_worker.py}
├── src-tauri/                 # the single Tauri app (today: empty scaffold)
│   └── src/{lib.rs, commands.rs, state.rs}   # gains batch-core dep + ported commands + state
├── src/                       # the single React frontend
│   ├── App.tsx                # shell + nav: Batch | Review
│   ├── api.ts, types.ts       # from batch-app
│   ├── views/{SetupView,RunView,ReviewView}.tsx
│   └── components/
│       ├── FileTable.tsx, ManageCache.tsx           # from batch-app
│       └── AudioVisualizer.tsx, AnnotationTable.tsx  # from Field Station
├── birdpipe/, scripts/, models/, docs/, tests/      # shared pipeline, unchanged
└── DELETED: batch-app/, src/lib/db.ts (Dexie), src/lib/audioProcessor.ts (JS detector),
            src/components/NativeProcessor.tsx, deps: dexie, onnxruntime-web, vite-plugin-pwa
```

Notes:
- Root `src-tauri` package is currently named `app` / `app_lib`; rename to `bird-audio-analyzer`
  is optional and non-blocking (defer unless trivial).
- `tauri.conf.json` `productName`, identifier, and icons updated to "Bird Audio Analyzer"
  (reuse batch-app's icon set).

## 4. Data model — single SQLite store

Keep batch-core's existing tables (`sessions`, `files`, `events`). The `events` table already
carries the detection geometry: `t_start`, `t_end`, `duration`, `f_low`, `f_high`,
`center_freq`, `stage_a_conf`, `completeness_score`, `completeness_label`, `retained`,
`n_members`.

Extend `events` with curation columns (added via **idempotent** `ALTER TABLE ... ADD COLUMN`
guarded by a check, so existing `batch.db` files migrate cleanly):

| Column | Type / default | Meaning |
| --- | --- | --- |
| `review_status` | `TEXT NOT NULL DEFAULT 'unreviewed'` | `unreviewed` \| `confirmed` \| `rejected` |
| `source` | `TEXT NOT NULL DEFAULT 'ml'` | `ml` \| `manual` (human-added call) |
| `label` | `TEXT` | optional human label |
| `note` | `TEXT` | optional reviewer note |
| `reviewed_at` | `TEXT` | timestamp of last human verdict |

- Human edits to bounds update `t_start/t_end/f_low/f_high` **in place**. Original ML values are
  **not** preserved in v1 (YAGNI; revisit if a "reset to ML" feature is requested).
- Field Station → events mapping: `start/end → t_start/t_end`, `peakFreq → center_freq`,
  `label → label`.
- IndexedDB/Dexie is removed entirely; there is no browser-side store.

## 5. Frontend

A top-level **shell** with two sections: **Batch** and **Review**.

**Batch** (rehomed from batch-app, behavior unchanged):
- `SetupView` — pick recording folder, device, concurrency, Detection Sensitivity (θ_A),
  Quality Filter (θ_B); "Begin Listening".
- `RunView` — live progress, ETA, throughput, per-file `FileTable`, cache management, export.

**Review** (new surface assembled from existing parts):
- Select a session + file (reuse `FileTable` as the list).
- Load that file's audio **from disk** via a Tauri asset protocol / fs read, fed to
  `AudioVisualizer` (wavesurfer + spectrogram + draggable regions).
- Overlay the file's `events` as regions; `AnnotationTable` becomes the **curation table**:
  confirm / reject each event, edit bounds (drag region → `update_event_bounds`), add a
  missed call (`source = 'manual'`), set label/note.

**Removed UI:** mic recording, in-browser file upload, the JS amplitude detector, and the
`NativeProcessor` shell-out path (superseded by the real batch engine).

## 6. Backend / Tauri command surface

`src-tauri` depends on `batch-core`. Port `commands.rs` + `state.rs` from
`batch-app/src-tauri` (camelCase IPC, async dialog already fixed in batch-app history):

- Batch: `start_batch`, `cancel`, `summary`, `list_files`, `export`, cache-management
  commands, plus progress events.
- **New Review commands:**
  - `list_events(file_id)` → events for a file
  - `set_event_review(event_id, status, label?, note?)`
  - `update_event_bounds(event_id, t_start, t_end, f_low, f_high)`
  - `add_manual_event(file_id, …)` / `delete_event(event_id)`
  - audio access for a file path (Tauri asset protocol → wavesurfer URL)
- **Export:** extend the existing complete-only filter with a `confirmed-only` option
  (combinable).

## 7. Data flow

1. **Setup → `start_batch`**: batch-core enumerates the folder, spawns worker(s) running
   `birdpipe` via `uv`, writes `files` + `events` to SQLite, emits progress events.
2. **Run dashboard** reads live `summary` + file rows.
3. **Review**: select a file → load audio + `list_events` → human curates → verdicts written
   back to `events`.
4. **Export**: CSV/JSON, optionally `confirmed-only` and/or `complete-only`.

## 8. Migration sequencing (each phase keeps the build green)

1. **Workspace + crate move.** Create root `Cargo.toml` workspace; move
   `batch-app/batch-core` → `/batch-core`; keep the `batch` CLI building; tests green.
2. **Backend parity.** Add `batch-core` dep to root `src-tauri`; port `commands.rs` +
   `state.rs`; register commands; build the Tauri backend.
3. **Frontend Batch mode at root.** Port `api.ts`/`types.ts` + `SetupView`/`RunView`/
   `FileTable`/`ManageCache` into root `src/`; wire the shell nav. Batch works end-to-end.
4. **Review mode.** Apply the events curation migration + review commands; add audio loading;
   port `AudioVisualizer`/`AnnotationTable` into a `ReviewView` with curation interactions.
5. **Export.** Add the `confirmed-only` export filter (UI + command).
6. **Cleanup.** Delete `batch-app/`, `src/lib/db.ts`, `src/lib/audioProcessor.ts`,
   `NativeProcessor.tsx`; drop `dexie`, `onnxruntime-web`, `vite-plugin-pwa`; update
   `tauri.conf.json` (name/identifier/icons), README, and `docs/`.

## 9. Error handling & testing

- Keep batch-core's existing integration test (`tests/integration.rs` + `fake_worker.py`)
  and protocol unit tests green across the crate move.
- Add store tests for the new curation columns/migration and for event mutations
  (`set_event_review`, `update_event_bounds`, `add_manual_event`, `delete_event`).
- Review UI explicit states: missing-file-on-disk, audio decode failure, zero events.
- Manual QA: one real recording folder end-to-end (Setup → Run → Review → Export) on
  macOS/MPS.

## 10. Out of scope (v1)

- Browser/PWA deployment, mic capture, in-browser upload, the JS amplitude detector.
- Preserving original ML bounds after a human edit ("reset to ML").
- Multi-user / cloud sync. Local-first desktop only.

## 11. Open / deferred (non-blocking)

- Rename of the Rust crate package (`app` → `bird-audio-analyzer`) — cosmetic, defer.
- Whether the headless `batch` CLI is documented as a supported surface or kept as a
  dev-only tool — keep building it either way.
