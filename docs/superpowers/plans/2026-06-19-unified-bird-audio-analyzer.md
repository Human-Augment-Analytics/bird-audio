# Unified "Bird Audio Analyzer" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two front-ends (root "Acoustic Field Station" PWA + `batch-app/`) into one Tauri desktop app, "Bird Audio Analyzer", that keeps the interactive spectrogram review UI and gains the real-ML batch engine, with a single SQLite store and a curate-ML-events workflow.

**Architecture:** A Cargo workspace at the repo root with `batch-core` (engine/worker/protocol/store/export) as a shared crate and one Tauri app under `src-tauri/`. A single React (Vite) frontend under `src/` with two sections — **Batch** (Setup → Run, ported from `batch-app`) and **Review** (spectrogram + curation table, refactored from the Field Station). Built in 6 build-safe phases; the standalone `batch-app/` shell is deleted last.

**Tech Stack:** Rust (Tauri v2, rusqlite/SQLite), React 19 + Vite 8 + TypeScript, wavesurfer.js v7, @tanstack/react-virtual, the existing Python `birdpipe` pipeline run via `uv`.

## Global Constraints

- Tauri **v2**; Rust **edition 2021**, `rust-version = "1.77.2"`.
- Frontend: React **19**, Vite **8**, TypeScript **~6.0**, ESM (`"type": "module"`).
- Dev server **port 1420** (`strictPort: true`); Tauri `devUrl = "http://localhost:1420"`.
- **Desktop-only.** No PWA. By end of plan, these deps are removed: `dexie`, `onnxruntime-web`, `vite-plugin-pwa`, `@tauri-apps/plugin-shell`.
- **SQLite is the only store** — `<output_dir>/batch.db`. No IndexedDB/Dexie.
- **Serde casing:** Rust structs serialize `snake_case` by default → TS interfaces for return payloads use `snake_case` (e.g. `n_events`, `t_start`). `StartOpts` is the exception (`#[serde(rename_all = "camelCase")]`). Tauri auto-maps camelCase JS argument keys to snake_case Rust command params.
- Product/window name: **"Bird Audio Analyzer"**.
- Run `cargo` and `npm` from the **repo root**.
- **Commit after every task.** Do NOT add a Claude co-author trailer or "Generated with Claude Code" attribution to any commit (user standing rule).
- Branch: `leyang/pwa-prototype` (work directly on it).

---

## Phase 1 — Cargo workspace + move `batch-core` to root

### Task 1.1: Create the root workspace and move the engine crate

**Files:**
- Create: `Cargo.toml` (repo root)
- Move: `batch-app/batch-core/` → `batch-core/`
- Modify: `batch-app/src-tauri/Cargo.toml` is left alone (excluded; deleted in Phase 6)

**Interfaces:**
- Produces: the `batch-core` crate at `batch-core/` (lib `batch_core`, bin `batch`), buildable from the root workspace.

- [ ] **Step 1: Move the crate with git**

```bash
git mv batch-app/batch-core batch-core
```

- [ ] **Step 2: Create the root workspace manifest**

Create `Cargo.toml` at the repo root:

```toml
[workspace]
resolver = "2"
members = ["batch-core", "src-tauri"]
# batch-app still contains its own (now-stale) workspace + crates until Phase 6.
# Excluding it prevents a nested-workspace error and keeps it out of root builds.
exclude = ["batch-app"]
```

- [ ] **Step 3: Verify batch-core builds and tests pass under the new layout**

Run: `cargo test -p batch-core`
Expected: PASS — all existing store/export/protocol tests green (compiles from `batch-core/`).

- [ ] **Step 4: Verify the headless CLI still runs**

Run: `cargo run -p batch-core --bin batch -- --help`
Expected: the CLI prints its usage/help and exits 0 (or prints the arg error for missing `--input`; either proves the bin builds).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml batch-core
git rm -r --cached batch-app/batch-core 2>/dev/null; true
git commit -m "refactor(workspace): create root Cargo workspace, move batch-core to repo root"
```

---

## Phase 2 — Backend parity in the root Tauri app

The root `src-tauri` currently has an empty `lib.rs` (plugins only). Bring over batch-app's real backend so `src-tauri` exposes the batch command surface and depends on `batch-core`.

### Task 2.1: Depend on batch-core and port commands + state

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands.rs` (copied from `batch-app/src-tauri/src/commands.rs`)
- Create: `src-tauri/src/state.rs` (copied from `batch-app/src-tauri/src/state.rs`)
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `batch_core::{concurrency, engine, enumerate, export, store}` (from Phase 1).
- Produces: Tauri commands `start_session, cancel_session, get_summary, list_files, export_session, check_health, prepare_system, check_cache, clear_cache, get_cached_files, delete_cached_files`; events `batch://progress`, `batch://done`; `AppState { cancel }`.

- [ ] **Step 1: Copy the backend source files**

```bash
cp batch-app/src-tauri/src/commands.rs src-tauri/src/commands.rs
cp batch-app/src-tauri/src/state.rs   src-tauri/src/state.rs
```

- [ ] **Step 2: Replace `src-tauri/Cargo.toml` dependencies**

Set the `[dependencies]` block (keep `[package]`, `[lib]`, `[build-dependencies]` as they are, except keep `name = "app"` / lib `name = "app_lib"`):

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
batch-core = { path = "../batch-core" }
```

(Removes `tauri-plugin-log`, `tauri-plugin-shell`, `tauri-plugin-fs`, `log` — unused once `NativeProcessor` is gone.)

- [ ] **Step 3: Rewrite `src-tauri/src/lib.rs` to register state + commands**

```rust
mod commands;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::cancel_session,
            commands::get_summary,
            commands::list_files,
            commands::export_session,
            commands::check_health,
            commands::prepare_system,
            commands::check_cache,
            commands::clear_cache,
            commands::get_cached_files,
            commands::delete_cached_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Replace `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "default capability set",
  "windows": ["main"],
  "permissions": ["core:default", "dialog:default"]
}
```

- [ ] **Step 5: Update `src-tauri/tauri.conf.json` (product name, identifier, port, window)**

Set these fields (leave `bundle.icon` and `bundle.android` as-is):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Bird Audio Analyzer",
  "version": "0.1.0",
  "identifier": "com.bird.audioanalyzer",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      { "title": "Bird Audio Analyzer", "width": 1100, "height": 760, "resizable": true, "fullscreen": false }
    ],
    "security": { "csp": null }
  }
}
```

- [ ] **Step 6: Verify the backend compiles**

Run: `cargo build -p app`
Expected: PASS — `src-tauri` compiles against `batch-core` with all 11 commands registered. (Tauri context/icon generation succeeds; icons already present under `src-tauri/icons/`.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands.rs src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/tauri.conf.json
git commit -m "feat(app): port batch-core command surface + state into root Tauri app"
```

---

## Phase 3 — Frontend Batch mode at the root

Bring batch-app's React frontend to root `src/`, replacing the Field Station app shell. Keep the Review-only components (`AudioVisualizer`, `AnnotationTable`) in place for Phase 4; delete Field Station code that is now dead.

### Task 3.1: Port the batch frontend and rebuild the root app shell

**Files:**
- Create: `src/api.ts`, `src/types.ts` (from `batch-app/src/`)
- Create: `src/components/SetupView.tsx`, `src/components/RunView.tsx`, `src/components/FileTable.tsx`, `src/components/ManageCache.tsx` (from `batch-app/src/components/`)
- Replace: `src/App.tsx`, `src/index.css`, `index.html`, `vite.config.ts`, `package.json`
- Delete: `src/components/NativeProcessor.tsx`, `src/lib/audioProcessor.ts`, `src/lib/consolidation.ts`, `src/lib/evaluation.ts`, `src/lib/modelManifest.ts`
- Keep (untouched this phase): `src/components/AudioVisualizer.tsx`, `src/components/AnnotationTable.tsx`, `src/lib/db.ts`, `src/main.tsx`

**Interfaces:**
- Consumes: the Tauri commands from Phase 2 (via `src/api.ts`).
- Produces: a working Batch UI at root (`view: "setup" | "run"`), `src/api.ts` exports, `src/types.ts` types.

- [ ] **Step 1: Copy the batch frontend files**

```bash
cp batch-app/src/api.ts src/api.ts
cp batch-app/src/types.ts src/types.ts
cp batch-app/src/components/SetupView.tsx src/components/SetupView.tsx
cp batch-app/src/components/RunView.tsx   src/components/RunView.tsx
cp batch-app/src/components/FileTable.tsx src/components/FileTable.tsx
cp batch-app/src/components/ManageCache.tsx src/components/ManageCache.tsx
cp batch-app/src/App.tsx  src/App.tsx
cp batch-app/src/index.css src/index.css
cp batch-app/index.html   index.html
cp batch-app/vite.config.ts vite.config.ts
```

(The imports in these files are relative — `../api`, `../types`, `./FileTable`, `./ManageCache` — and resolve unchanged in the flat `src/`/`src/components/` layout.)

- [ ] **Step 2: Delete dead Field Station files**

```bash
git rm src/components/NativeProcessor.tsx src/lib/audioProcessor.ts src/lib/consolidation.ts src/lib/evaluation.ts src/lib/modelManifest.ts
```

- [ ] **Step 3: Rewrite `package.json`** (name, desktop-only deps; keep `wavesurfer.js` + `lucide-react` for Phase 4; keep `dexie` until Phase 4 removes `db.ts`)

```json
{
  "name": "bird-audio-analyzer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tanstack/react-virtual": "^3.10.0",
    "@tauri-apps/api": "^2.11.0",
    "@tauri-apps/plugin-dialog": "^2.7.1",
    "dexie": "^4.4.3",
    "lucide-react": "^1.17.0",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "wavesurfer.js": "^7.12.7"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@tauri-apps/cli": "^2.11.0",
    "@types/node": "^24.12.3",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "eslint": "^10.3.0",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.2",
    "globals": "^17.6.0",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.59.2",
    "vite": "^8.0.12"
  }
}
```

- [ ] **Step 4: Install deps**

Run: `npm install`
Expected: lockfile updates; no peer-dep errors that block (`onnxruntime-web`, `vite-plugin-pwa` removed).

- [ ] **Step 5: Verify the frontend type-checks and builds**

Run: `npm run build`
Expected: PASS — `tsc -b` + `vite build` succeed. (`src/lib/db.ts`, `AudioVisualizer.tsx`, `AnnotationTable.tsx` still compile; they're unreferenced by the new `App.tsx` but valid.)

- [ ] **Step 6: Smoke-test the desktop app (manual)**

Run: `npm run tauri dev`
Expected: window titled "Bird Audio Analyzer" opens to the Setup screen; picking a folder + Begin Listening runs the batch (requires `uv` + `models/`). Close the window.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(app): bring batch frontend to root as the app shell (Batch mode)"
```

---

## Phase 4 — Review mode

Adds the curation data layer (SQLite columns + Store methods + Tauri commands), the asset-protocol audio access, and the Review UI (refactored visualizer + new curation table + orchestrator), wired into the app shell as a second section.

### Task 4.1: Add curation columns + Store methods (TDD)

**Files:**
- Modify: `batch-core/src/store.rs`
- Test: `batch-core/src/store.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `store::EventRow`; `Store::{list_events, set_event_review, update_event_bounds, add_manual_event, delete_event}`; an idempotent `events`-table migration run inside `Store::open`/`open_memory`.

- [ ] **Step 1: Write the failing tests** — append to the existing `#[cfg(test)] mod tests` in `store.rs`:

```rust
    fn make_events_for_file(store: &mut Store, sid: i64) -> i64 {
        use crate::protocol::EventRecord;
        store.add_files(sid, &[PathBuf::from("/data/x.wav")]).unwrap();
        let c = store.claim_next_pending(sid).unwrap().unwrap();
        let evs = vec![
            EventRecord { t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 4000.0, f_high: 8000.0,
                center_freq: 6000.0, stage_a_conf: 0.9, completeness_score: Some(0.7),
                completeness_label: Some("complete".into()), retained: Some(true), n_members: 2 },
            EventRecord { t_start: 3.0, t_end: 3.5, duration: 0.5, f_low: 4000.0, f_high: 8000.0,
                center_freq: 6000.0, stage_a_conf: 0.6, completeness_score: Some(0.3),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1 },
        ];
        store.record_success(sid, c.file_id,
            &RecordedResult { n_events: 2, n_complete: 1, n_retained: 1, elapsed_ms: 10, events: &evs }).unwrap();
        c.file_id
    }

    #[test]
    fn migration_is_idempotent() {
        let _s1 = Store::open_memory().unwrap();
        let _s2 = Store::open_memory().unwrap();
        let s = mem();
        let existing: Vec<String> = {
            let mut stmt = s.conn.prepare("PRAGMA table_info(events)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        for col in &["review_status", "source", "label", "note", "reviewed_at"] {
            assert!(existing.contains(&col.to_string()), "missing column: {col}");
        }
    }

    #[test]
    fn list_events_returns_inserted_with_defaults() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let rows = s.list_events(sid, "/data/x.wav").unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].t_start < rows[1].t_start);
        for row in &rows { assert_eq!(row.review_status, "unreviewed"); assert_eq!(row.source, "ml"); }
    }

    #[test]
    fn list_events_unknown_path_returns_empty() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        assert!(s.list_events(sid, "/data/none.wav").unwrap().is_empty());
    }

    #[test]
    fn set_event_review_updates_status_label_note() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let eid = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        s.set_event_review(eid, "confirmed", Some("HLW"), Some("clear")).unwrap();
        let row = s.list_events(sid, "/data/x.wav").unwrap().into_iter().find(|r| r.id == eid).unwrap();
        assert_eq!(row.review_status, "confirmed");
        assert_eq!(row.label.as_deref(), Some("HLW"));
        assert_eq!(row.note.as_deref(), Some("clear"));
    }

    #[test]
    fn update_event_bounds_recomputes_duration_and_center_freq() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let eid = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        s.update_event_bounds(eid, 2.0, 4.0, 3000.0, 7000.0).unwrap();
        let row = s.list_events(sid, "/data/x.wav").unwrap().into_iter().find(|r| r.id == eid).unwrap();
        assert!((row.duration - 2.0).abs() < 1e-9);
        assert!((row.center_freq - 5000.0).abs() < 1e-9);
    }

    #[test]
    fn add_manual_event_inserts_confirmed_manual() {
        let s = mem(); let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/m.wav")]).unwrap();
        let new_id = s.add_manual_event(sid, "/data/m.wav", 0.5, 1.5, 2000.0, 6000.0).unwrap();
        let row = s.list_events(sid, "/data/m.wav").unwrap().into_iter().find(|r| r.id == new_id).unwrap();
        assert_eq!(row.source, "manual");
        assert_eq!(row.review_status, "confirmed");
        assert!((row.center_freq - 4000.0).abs() < 1e-9);
    }

    #[test]
    fn delete_event_removes_the_row() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let eid = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        s.delete_event(eid).unwrap();
        let after = s.list_events(sid, "/data/x.wav").unwrap();
        assert_eq!(after.len(), 1);
        assert!(after.iter().all(|r| r.id != eid));
    }
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cargo test -p batch-core store::tests`
Expected: FAIL — `EventRow` / `list_events` / etc. not defined.

- [ ] **Step 3: Add the migration helper + call it from `open`/`open_memory`**

In `store.rs`, edit both constructors to call the helper after `execute_batch(SCHEMA)?;` and add the helper at module scope (outside `impl`):

```rust
// inside Store::open, after conn.execute_batch(SCHEMA)?;
ensure_curation_columns(&conn)?;
// inside Store::open_memory, after conn.execute_batch(SCHEMA)?;
ensure_curation_columns(&conn)?;
```

```rust
/// Idempotent migration: add curation columns to `events` if not already present.
fn ensure_curation_columns(conn: &Connection) -> rusqlite::Result<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(events)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let columns: &[(&str, &str)] = &[
        ("review_status", "TEXT NOT NULL DEFAULT 'unreviewed'"),
        ("source",        "TEXT NOT NULL DEFAULT 'ml'"),
        ("label",         "TEXT"),
        ("note",          "TEXT"),
        ("reviewed_at",   "TEXT"),
    ];
    for (col, def) in columns {
        if !existing.iter().any(|n| n == col) {
            conn.execute_batch(&format!("ALTER TABLE events ADD COLUMN {col} {def}"))?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Add the `EventRow` struct** (after `FileRow`):

```rust
/// A single event row with curation fields, for the review UI.
#[derive(Debug, serde::Serialize)]
pub struct EventRow {
    pub id: i64,
    pub file_id: i64,
    pub t_start: f64,
    pub t_end: f64,
    pub duration: f64,
    pub f_low: f64,
    pub f_high: f64,
    pub center_freq: f64,
    pub stage_a_conf: f64,
    pub completeness_score: Option<f64>,
    pub completeness_label: Option<String>,
    pub retained: Option<bool>,
    pub n_members: i64,
    pub review_status: String,
    pub source: String,
    pub label: Option<String>,
    pub note: Option<String>,
}
```

- [ ] **Step 5: Add the five Store methods** (inside `impl Store`, after `list_files`):

```rust
/// Return all events for a specific file within a session, ordered by t_start.
pub fn list_events(&self, session_id: i64, path: &str) -> rusqlite::Result<Vec<EventRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT e.id, e.file_id, e.t_start, e.t_end, e.duration, e.f_low, e.f_high,
                e.center_freq, e.stage_a_conf, e.completeness_score, e.completeness_label,
                e.retained, e.n_members, e.review_status, e.source, e.label, e.note
         FROM events e
         WHERE e.file_id = (SELECT id FROM files WHERE session_id=?1 AND path=?2)
         ORDER BY e.t_start",
    )?;
    let rows = stmt.query_map(params![session_id, path], |r| {
        Ok(EventRow {
            id: r.get(0)?, file_id: r.get(1)?, t_start: r.get(2)?, t_end: r.get(3)?,
            duration: r.get(4)?, f_low: r.get(5)?, f_high: r.get(6)?, center_freq: r.get(7)?,
            stage_a_conf: r.get(8)?, completeness_score: r.get(9)?, completeness_label: r.get(10)?,
            retained: r.get::<_, Option<i64>>(11)?.map(|v| v != 0), n_members: r.get(12)?,
            review_status: r.get(13)?, source: r.get(14)?, label: r.get(15)?, note: r.get(16)?,
        })
    })?;
    rows.collect()
}

pub fn set_event_review(&self, event_id: i64, status: &str, label: Option<&str>, note: Option<&str>) -> rusqlite::Result<()> {
    self.conn.execute(
        "UPDATE events SET review_status=?2, label=?3, note=?4, reviewed_at=datetime('now') WHERE id=?1",
        params![event_id, status, label, note],
    )?;
    Ok(())
}

pub fn update_event_bounds(&self, event_id: i64, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> rusqlite::Result<()> {
    self.conn.execute(
        "UPDATE events SET t_start=?2, t_end=?3, duration=(?3 - ?2),
             f_low=?4, f_high=?5, center_freq=((?4 + ?5) / 2.0) WHERE id=?1",
        params![event_id, t_start, t_end, f_low, f_high],
    )?;
    Ok(())
}

pub fn add_manual_event(&self, session_id: i64, path: &str, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> rusqlite::Result<i64> {
    let file_id: i64 = self.conn.query_row(
        "SELECT id FROM files WHERE session_id=?1 AND path=?2",
        params![session_id, path], |r| r.get(0),
    )?;
    self.conn.execute(
        "INSERT INTO events(session_id, file_id, t_start, t_end, duration, f_low, f_high, center_freq,
             stage_a_conf, n_members, completeness_score, completeness_label, retained, source, review_status)
         VALUES(?1,?2,?3,?4,(?4 - ?3),?5,?6,((?5 + ?6) / 2.0),0.0,0,NULL,NULL,NULL,'manual','confirmed')",
        params![session_id, file_id, t_start, t_end, f_low, f_high],
    )?;
    Ok(self.conn.last_insert_rowid())
}

pub fn delete_event(&self, event_id: i64) -> rusqlite::Result<()> {
    self.conn.execute("DELETE FROM events WHERE id=?1", params![event_id])?;
    Ok(())
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `cargo test -p batch-core store::tests`
Expected: PASS — all new + existing store tests green.

- [ ] **Step 7: Commit**

```bash
git add batch-core/src/store.rs
git commit -m "feat(batch-core): add curation columns + event review/edit Store methods"
```

### Task 4.2: Add review Tauri commands + asset-protocol audio access

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register new commands)
- Modify: `src-tauri/tauri.conf.json` (enable asset protocol)

**Interfaces:**
- Consumes: `Store::{list_events, set_event_review, update_event_bounds, add_manual_event, delete_event}`, `store::EventRow`.
- Produces: commands `list_events, set_event_review, update_event_bounds, add_manual_event, delete_event, prepare_review`.

- [ ] **Step 1: Extend imports in `commands.rs`**

Change the store import and the tauri import:

```rust
use batch_core::store::{EventRow, FileRow, NewSession, Store, Summary};
use tauri::{AppHandle, Emitter, Manager, State};
```

- [ ] **Step 2: Append the review commands** to `commands.rs`:

```rust
#[tauri::command]
pub fn list_events(output_dir: String, session_id: i64, path: String) -> Result<Vec<EventRow>, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.list_events(session_id, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_event_review(output_dir: String, event_id: i64, status: String, label: Option<String>, note: Option<String>) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.set_event_review(event_id, &status, label.as_deref(), note.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_event_bounds(output_dir: String, event_id: i64, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.update_event_bounds(event_id, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_manual_event(output_dir: String, session_id: i64, path: String, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> Result<i64, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.add_manual_event(session_id, &path, t_start, t_end, f_low, f_high).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_event(output_dir: String, event_id: i64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    store.delete_event(event_id).map_err(|e| e.to_string())
}

/// Grant the asset-protocol scope for a session's input roots so the review UI
/// can load local audio via convertFileSrc().
#[tauri::command]
pub fn prepare_review(app: AppHandle, output_dir: String, session_id: i64) -> Result<(), String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let roots_json: String = store.conn.query_row(
        "SELECT input_roots FROM sessions WHERE id=?1",
        rusqlite::params![session_id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    let roots: Vec<String> = serde_json::from_str(&roots_json).map_err(|e| e.to_string())?;
    let scope = app.asset_protocol_scope();
    for dir in &roots {
        scope.allow_directory(dir, true).ok();
    }
    Ok(())
}
```

- [ ] **Step 3: Register the new commands** — add to the `generate_handler!` list in `src-tauri/src/lib.rs`:

```rust
            commands::list_events,
            commands::set_event_review,
            commands::update_event_bounds,
            commands::add_manual_event,
            commands::delete_event,
            commands::prepare_review,
```

- [ ] **Step 4: Enable the asset protocol** in `src-tauri/tauri.conf.json` `app.security`:

```json
    "security": {
      "csp": null,
      "assetProtocol": { "enable": true, "scope": [] }
    }
```

- [ ] **Step 5: Verify the backend compiles**

Run: `cargo build -p app`
Expected: PASS — 17 commands registered; `Manager`/`asset_protocol_scope` resolve.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat(app): add review/curation commands + asset-protocol audio access"
```

### Task 4.3: Frontend review types + API bindings

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`

**Interfaces:**
- Produces: TS `EventRow`; api `listEvents, setEventReview, updateEventBounds, addManualEvent, deleteEvent, prepareReview, audioSrc`.

- [ ] **Step 1: Append `EventRow` to `src/types.ts`:**

```ts
export interface EventRow {
  id: number;
  file_id: number;
  t_start: number;
  t_end: number;
  duration: number;
  f_low: number;
  f_high: number;
  center_freq: number;
  stage_a_conf: number;
  completeness_score: number | null;
  completeness_label: string | null;
  retained: boolean | null;
  n_members: number;
  review_status: "unreviewed" | "confirmed" | "rejected";
  source: "ml" | "manual";
  label: string | null;
  note: string | null;
}
```

- [ ] **Step 2: Add review bindings to `src/api.ts`** — extend the core import and the type import, then add the functions:

```ts
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
// add EventRow to the existing `import type { ... } from "./types";`
```

```ts
export const listEvents = (outputDir: string, sessionId: number, path: string) =>
  invoke<EventRow[]>("list_events", { outputDir, sessionId, path });
export const setEventReview = (
  outputDir: string, eventId: number, status: string,
  label?: string | null, note?: string | null
) => invoke<void>("set_event_review", { outputDir, eventId, status, label, note });
export const updateEventBounds = (
  outputDir: string, eventId: number, tStart: number, tEnd: number, fLow: number, fHigh: number
) => invoke<void>("update_event_bounds", { outputDir, eventId, tStart, tEnd, fLow, fHigh });
export const addManualEvent = (
  outputDir: string, sessionId: number, path: string,
  b: { tStart: number; tEnd: number; fLow: number; fHigh: number }
) => invoke<number>("add_manual_event", { outputDir, sessionId, path, tStart: b.tStart, tEnd: b.tEnd, fLow: b.fLow, fHigh: b.fHigh });
export const deleteEvent = (outputDir: string, eventId: number) =>
  invoke<void>("delete_event", { outputDir, eventId });
export const prepareReview = (outputDir: string, sessionId: number) =>
  invoke<void>("prepare_review", { outputDir, sessionId });
export const audioSrc = (path: string): string => convertFileSrc(path);
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc -b`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(app): add EventRow type + review API bindings"
```

### Task 4.4: Merge the Field Station design tokens into the stylesheet

**Files:**
- Modify: `src/index.css`

**Interfaces:**
- Produces: the `--bg-color/--bg-panel/--bg-hover/--text-primary/--text-secondary/--accent-color/--accent-hover/--border-color/--danger-color/--danger-hover` variables the review components use (the batch-app stylesheet defines a different `--bg/--surface/--text/--amber/--jade/--coral` set, kept as-is).

- [ ] **Step 1: Append the Field Station token block** to the end of `src/index.css`:

```css
/* ── Field Station design tokens (used by review components) ───────────── */
:root {
  --bg-color: #0f1013;
  --bg-panel: #18191d;
  --bg-hover: #222329;
  --text-primary: #f1f3f5;
  --text-secondary: #868e96;
  --accent-color: #228be6;
  --accent-hover: #1c7ed6;
  --border-color: #2c2e35;
  --danger-color: #fa5252;
  --danger-hover: #e03131;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "style(app): add Field Station design tokens for review UI"
```

### Task 4.5: Refactor `AudioVisualizer` to the events model

**Files:**
- Replace: `src/components/AudioVisualizer.tsx`

**Interfaces:**
- Consumes: `EventRow` (types), region callbacks.
- Produces: `AudioVisualizer` with props `{ src, events, selectedId, onSelectEvent?, onUpdateBounds?, onAddEvent? }`.

- [ ] **Step 1: Replace the file contents** with:

```tsx
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, Volume2, VolumeX } from 'lucide-react';
import type { EventRow } from '../types';

const FREQ_MIN = 0;
const FREQ_MAX = 11025;

function regionColorForStatus(status: EventRow['review_status'], selected: boolean): string {
  const alpha = selected ? 0.55 : 0.25;
  switch (status) {
    case 'confirmed': return `rgba(79,214,163,${alpha})`;
    case 'rejected':  return `rgba(240,106,78,${alpha})`;
    default:          return `rgba(244,162,58,${alpha})`;
  }
}
function borderColorForStatus(status: EventRow['review_status']): string {
  switch (status) {
    case 'confirmed': return '#4fd6a3';
    case 'rejected':  return '#f06a4e';
    default:          return '#f4a23a';
  }
}

interface AudioVisualizerProps {
  src: string | null;
  events: EventRow[];
  selectedId: number | null;
  onSelectEvent?: (id: number) => void;
  onUpdateBounds?: (id: number, t_start: number, t_end: number, f_low: number, f_high: number) => void;
  onAddEvent?: (e: { t_start: number; t_end: number; f_low: number; f_high: number }) => void;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  src, events, selectedId, onSelectEvent, onUpdateBounds, onAddEvent,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const regionsPlugin = useRef<InstanceType<typeof RegionsPlugin> | null>(null);
  const suppressNewRegion = useRef(false);
  const regionToEventId = useRef<Map<string, number>>(new Map());

  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(50);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const eventsRef = useRef<EventRow[]>(events);
  useEffect(() => { eventsRef.current = events; }, [events]);
  const onSelectEventRef = useRef(onSelectEvent);
  const onUpdateBoundsRef = useRef(onUpdateBounds);
  const onAddEventRef = useRef(onAddEvent);
  useEffect(() => { onSelectEventRef.current = onSelectEvent; }, [onSelectEvent]);
  useEffect(() => { onUpdateBoundsRef.current = onUpdateBounds; }, [onUpdateBounds]);
  useEffect(() => { onAddEventRef.current = onAddEvent; }, [onAddEvent]);

  useEffect(() => {
    if (!src) return;
    if (!containerRef.current || !specRef.current || !timelineRef.current) return;
    if (wavesurfer.current) {
      wavesurfer.current.destroy();
      wavesurfer.current = null; regionsPlugin.current = null; regionToEventId.current.clear();
    }
    const wsRegions = RegionsPlugin.create();
    regionsPlugin.current = wsRegions;
    const wsTimeline = TimelinePlugin.create({
      container: timelineRef.current,
      style: { color: 'var(--text-secondary)', fontSize: '10px' },
    });
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#4b5563', progressColor: '#3b82f6', cursorColor: '#ef4444',
      height: 90, minPxPerSec: zoom, autoCenter: true,
      plugins: [
        wsRegions, wsTimeline,
        Spectrogram.create({ container: specRef.current, labels: true, height: 180,
          splitChannels: false, frequencyMin: FREQ_MIN, frequencyMax: FREQ_MAX }),
      ],
    });
    wavesurfer.current = ws;
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('timeupdate', (time) => setCurrentTime(time));
    ws.on('ready', (dur) => { setDuration(dur); setCurrentTime(0); });

    wsRegions.enableDragSelection({ color: 'rgba(59,130,246,0.25)' });
    wsRegions.on('region-created', (region: any) => {
      if (suppressNewRegion.current) return;
      const cur = eventsRef.current;
      let f_low = FREQ_MIN, f_high = FREQ_MAX;
      if (cur.length > 0) {
        const sorted = [...cur].sort((a, b) => a.center_freq - b.center_freq);
        const mid = sorted[Math.floor(sorted.length / 2)];
        f_low = mid.f_low; f_high = mid.f_high;
      }
      onAddEventRef.current?.({ t_start: region.start, t_end: region.end, f_low, f_high });
      region.remove();
    });
    wsRegions.on('region-updated', (region: any) => {
      const eventId = regionToEventId.current.get(region.id);
      if (eventId === undefined) return;
      const ev = eventsRef.current.find((e) => e.id === eventId);
      if (!ev) return;
      if (Math.abs(ev.t_start - region.start) > 0.005 || Math.abs(ev.t_end - region.end) > 0.005) {
        onUpdateBoundsRef.current?.(eventId, region.start, region.end, ev.f_low, ev.f_high);
      }
    });
    wsRegions.on('region-clicked', (region: any, e: MouseEvent) => {
      e.stopPropagation();
      const eventId = regionToEventId.current.get(region.id);
      if (eventId !== undefined) onSelectEventRef.current?.(eventId);
    });

    ws.load(src);
    return () => {
      ws.destroy();
      wavesurfer.current = null; regionsPlugin.current = null; regionToEventId.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const wsRegions = regionsPlugin.current;
    if (!wsRegions) return;
    suppressNewRegion.current = true;
    wsRegions.clearRegions();
    regionToEventId.current.clear();
    events.forEach((ev) => {
      const regionId = String(ev.id);
      const isSelected = ev.id === selectedId;
      const border = borderColorForStatus(ev.review_status);
      wsRegions.addRegion({
        id: regionId, start: ev.t_start, end: ev.t_end,
        color: regionColorForStatus(ev.review_status, isSelected),
        drag: true, resize: true, content: ev.label ?? undefined,
        // @ts-ignore — region style supported in wavesurfer v7
        style: {
          borderLeft: `2px solid ${border}`, borderRight: `2px solid ${border}`,
          ...(isSelected ? { outline: `2px solid ${border}`, outlineOffset: '-1px' } : {}),
        },
      });
      regionToEventId.current.set(regionId, ev.id);
    });
    suppressNewRegion.current = false;
  }, [events, selectedId]);

  useEffect(() => {
    if (selectedId === null || !wavesurfer.current) return;
    const ev = events.find((e) => e.id === selectedId);
    if (ev) wavesurfer.current.setTime(ev.t_start);
  }, [selectedId, events]);

  useEffect(() => { wavesurfer.current?.zoom(zoom); }, [zoom]);
  useEffect(() => { wavesurfer.current?.setPlaybackRate(playbackRate); }, [playbackRate]);
  useEffect(() => { wavesurfer.current?.setMuted(isMuted); }, [isMuted]);

  const togglePlay = () => wavesurfer.current?.playPause();
  const formatTime = (t: number) => {
    const m = Math.floor(t / 60); const s = (t % 60).toFixed(1);
    return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
  };

  if (!src) {
    return (
      <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', border: '2px dashed var(--border-color)', borderRadius: 12,
        backgroundColor: 'var(--bg-panel)', padding: '2rem' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 500 }}>Select a file to review</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', backgroundColor: 'var(--bg-panel)',
      padding: '1rem', borderRadius: 12, border: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button onClick={togglePlay} className="primary" style={{ display: 'flex', alignItems: 'center',
            gap: '0.5rem', minWidth: 96, justifyContent: 'center' }}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}{isPlaying ? 'Pause' : 'Play'}
          </button>
          <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <button onClick={() => setZoom((z) => Math.max(10, z - 15))} title="Zoom out" style={{ padding: '0.35rem' }}><ZoomOut size={16} /></button>
            <span style={{ fontSize: '0.8rem', minWidth: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>{zoom}px/s</span>
            <button onClick={() => setZoom((z) => Math.min(500, z + 15))} title="Zoom in" style={{ padding: '0.35rem' }}><ZoomIn size={16} /></button>
          </div>
          <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))}
            style={{ backgroundColor: 'var(--bg-color)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.35rem 0.5rem' }}>
            <option value="0.5">0.5x</option><option value="0.75">0.75x</option>
            <option value="1.0">1.0x</option><option value="1.5">1.5x</option><option value="2.0">2.0x</option>
          </select>
          <button onClick={() => setIsMuted((m) => !m)} title={isMuted ? 'Unmute' : 'Mute'} style={{ padding: '0.4rem 0.6rem' }}>
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, backgroundColor: 'var(--bg-color)',
        padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <div ref={specRef} style={{ width: '100%', overflow: 'hidden', backgroundColor: '#0b0c10' }} />
        <div ref={containerRef} style={{ width: '100%', backgroundColor: '#0f172a' }} />
        <div ref={timelineRef} style={{ width: '100%', marginTop: 4 }} />
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap',
        fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        <span>🟧 Unreviewed</span><span>🟩 Confirmed</span><span>🟥 Rejected</span>
        <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>Drag to mark a new event; drag/resize edges to adjust.</span>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc -b`
Expected: PASS (note: `AnnotationTable.tsx` still imports the old Dexie `Annotation` type and compiles; it is replaced in Task 4.6).

- [ ] **Step 3: Commit**

```bash
git add src/components/AudioVisualizer.tsx
git commit -m "refactor(app): AudioVisualizer renders curate-able event regions from asset URL"
```

### Task 4.6: New `EventTable` curation component; remove `AnnotationTable`

**Files:**
- Create: `src/components/EventTable.tsx`
- Delete: `src/components/AnnotationTable.tsx`

**Interfaces:**
- Produces: `EventTable` with props `{ events, selectedId, onSelect?, onSetReview?, onDelete?, onEditLabelNote? }`.

- [ ] **Step 1: Create `src/components/EventTable.tsx`** with:

```tsx
import React, { useState } from 'react';
import { Check, X, Edit2, Trash2, Music } from 'lucide-react';
import type { EventRow } from '../types';

interface EventTableProps {
  events: EventRow[];
  selectedId: number | null;
  onSelect?: (id: number) => void;
  onSetReview?: (id: number, status: 'confirmed' | 'rejected' | 'unreviewed') => void;
  onDelete?: (id: number) => void;
  onEditLabelNote?: (id: number, label: string, note: string) => void;
}

const STATUS: Record<EventRow['review_status'], { bg: string; text: string; label: string }> = {
  unreviewed: { bg: 'rgba(244,162,58,0.15)', text: '#f4a23a', label: 'Unreviewed' },
  confirmed:  { bg: 'rgba(79,214,163,0.15)', text: '#4fd6a3', label: 'Confirmed' },
  rejected:   { bg: 'rgba(240,106,78,0.15)', text: '#f06a4e', label: 'Rejected' },
};
const inputStyle: React.CSSProperties = {
  padding: '0.3rem 0.5rem', borderRadius: 4, border: '1px solid var(--border-color)',
  backgroundColor: 'var(--bg-color)', color: 'var(--text-primary)', fontSize: '0.85rem',
};

export const EventTable: React.FC<EventTableProps> = ({
  events, selectedId, onSelect, onSetReview, onDelete, onEditLabelNote,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editNote, setEditNote] = useState('');

  const startEditing = (ev: EventRow) => { setEditingId(ev.id); setEditLabel(ev.label ?? ''); setEditNote(ev.note ?? ''); };
  const saveEdit = (id: number) => { onEditLabelNote?.(id, editLabel, editNote); setEditingId(null); };

  const confirmed = events.filter((e) => e.review_status === 'confirmed').length;
  const rejected = events.filter((e) => e.review_status === 'rejected').length;
  const unreviewed = events.filter((e) => e.review_status === 'unreviewed').length;

  if (events.length === 0) {
    return (
      <div style={{ backgroundColor: 'var(--bg-panel)', padding: '3rem 2rem', borderRadius: 8,
        textAlign: 'center', border: '1px solid var(--border-color)' }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No events for this file.</p>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--bg-panel)', padding: '1rem', borderRadius: 8,
      border: '1px solid var(--border-color)', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
        <Music size={16} style={{ color: 'var(--accent-color)' }} />
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>Events</h3>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {events.length} · <span style={{ color: '#4fd6a3' }}>{confirmed} confirmed</span> ·{' '}
          <span style={{ color: '#f06a4e' }}>{rejected} rejected</span> ·{' '}
          <span style={{ color: '#f4a23a' }}>{unreviewed} unreviewed</span>
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
            <th style={{ padding: '0.5rem' }}>Time</th><th style={{ padding: '0.5rem' }}>Center</th>
            <th style={{ padding: '0.5rem' }}>Completeness</th><th style={{ padding: '0.5rem' }}>Conf</th>
            <th style={{ padding: '0.5rem' }}>Source</th><th style={{ padding: '0.5rem' }}>Status</th>
            <th style={{ padding: '0.5rem', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const isEditing = editingId === ev.id;
            const isSelected = ev.id === selectedId;
            const sm = STATUS[ev.review_status];
            return (
              <tr key={ev.id} onClick={() => !isEditing && onSelect?.(ev.id)}
                style={{ borderBottom: '1px solid var(--border-color)',
                  backgroundColor: isSelected ? 'var(--bg-hover)' : 'transparent',
                  cursor: onSelect && !isEditing ? 'pointer' : 'default' }}>
                <td style={{ padding: '0.6rem 0.5rem', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--text-primary)' }}>{ev.t_start.toFixed(2)}–{ev.t_end.toFixed(2)}s</span><br />
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{ev.duration.toFixed(2)}s</span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem' }}>{(ev.center_freq / 1000).toFixed(2)} kHz</td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  {ev.completeness_label ?? '—'}
                  {ev.completeness_score !== null && (
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.3rem' }}>({ev.completeness_score.toFixed(2)})</span>
                  )}
                </td>
                <td style={{ padding: '0.6rem 0.5rem' }}>{ev.stage_a_conf.toFixed(2)}</td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  <span style={{ color: ev.source === 'ml' ? '#a78bfa' : '#94a3b8', fontSize: '0.75rem', fontWeight: 600 }}>
                    {ev.source === 'ml' ? 'ML' : 'Manual'}
                  </span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  <span style={{ backgroundColor: sm.bg, color: sm.text, padding: '0.2rem 0.55rem', borderRadius: 12, fontSize: '0.78rem', fontWeight: 600 }}>{sm.label}</span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="label" style={{ ...inputStyle, width: 84 }} />
                      <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="note" style={{ ...inputStyle, width: 110 }} />
                      <button title="Save" onClick={() => saveEdit(ev.id)} style={{ padding: '0.35rem', backgroundColor: '#10b981', color: '#fff', border: 'none', borderRadius: 4 }}><Check size={14} /></button>
                      <button title="Cancel" onClick={() => setEditingId(null)} style={{ padding: '0.35rem', border: '1px solid var(--border-color)', borderRadius: 4, background: 'transparent', color: 'var(--text-secondary)' }}><X size={14} /></button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                      {onSetReview && (
                        <button title="Confirm" onClick={() => onSetReview(ev.id, ev.review_status === 'confirmed' ? 'unreviewed' : 'confirmed')}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--border-color)',
                            background: ev.review_status === 'confirmed' ? 'rgba(79,214,163,0.18)' : 'transparent',
                            color: ev.review_status === 'confirmed' ? '#4fd6a3' : 'var(--text-secondary)' }}><Check size={14} /></button>
                      )}
                      {onSetReview && (
                        <button title="Reject" onClick={() => onSetReview(ev.id, ev.review_status === 'rejected' ? 'unreviewed' : 'rejected')}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--border-color)',
                            background: ev.review_status === 'rejected' ? 'rgba(240,106,78,0.18)' : 'transparent',
                            color: ev.review_status === 'rejected' ? '#f06a4e' : 'var(--text-secondary)' }}><X size={14} /></button>
                      )}
                      {onEditLabelNote && (
                        <button title="Edit label / note" onClick={() => startEditing(ev)}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)' }}><Edit2 size={14} /></button>
                      )}
                      {onDelete && (
                        <button title="Delete" onClick={() => onDelete(ev.id)}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid rgba(240,106,78,0.3)', background: 'transparent', color: '#f06a4e' }}><Trash2 size={14} /></button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
```

- [ ] **Step 2: Delete the old annotation table**

```bash
git rm src/components/AnnotationTable.tsx
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc -b`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EventTable.tsx
git commit -m "feat(app): EventTable curation component; remove AnnotationTable"
```

### Task 4.7: `ReviewView` orchestrator + nav wiring

**Files:**
- Create: `src/components/ReviewView.tsx`
- Modify: `src/App.tsx` (add a Batch/Review nav + render ReviewView)

**Interfaces:**
- Consumes: `AudioVisualizer`, `EventTable`, the review API, `StartResult`/`StartOpts`/`FileRow`/`EventRow`.
- Produces: `ReviewView` (default export) with props `{ start, opts, rows }`.

- [ ] **Step 1: Create `src/components/ReviewView.tsx`** with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventRow, FileRow, StartOpts, StartResult } from "../types";
import {
  addManualEvent, audioSrc, deleteEvent, listEvents, prepareReview, setEventReview, updateEventBounds,
} from "../api";
import { AudioVisualizer } from "./AudioVisualizer";
import { EventTable } from "./EventTable";

export interface ReviewViewProps {
  start: StartResult;
  opts: StartOpts;
  rows: FileRow[];
}

export default function ReviewView({ start, opts, rows }: ReviewViewProps) {
  const sid = start.session_id;
  const dir = opts.outputDir;

  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const currentPathRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    prepareReview(dir, sid).catch((e) => { if (!cancelled) setPrepareError(String(e)); });
    return () => { cancelled = true; };
  }, [dir, sid]);

  const fetchEvents = useCallback(async (path: string) => {
    currentPathRef.current = path;
    setLoadingEvents(true);
    try {
      const result = await listEvents(dir, sid, path);
      if (currentPathRef.current === path) setEvents(result);
    } catch (e) {
      if (currentPathRef.current === path) setNotice(`Failed to load events: ${String(e)}`);
    } finally {
      if (currentPathRef.current === path) setLoadingEvents(false);
    }
  }, [dir, sid]);

  const refreshEvents = useCallback(async () => {
    if (selectedPath) await fetchEvents(selectedPath);
  }, [selectedPath, fetchEvents]);

  const selectFile = useCallback((path: string) => {
    if (path === selectedPath) return;
    setSelectedPath(path); setSelectedId(null); setEvents([]); setNotice(null);
    fetchEvents(path);
  }, [selectedPath, fetchEvents]);

  const currentStatus = useCallback(
    (id: number): "unreviewed" | "confirmed" | "rejected" =>
      events.find((e) => e.id === id)?.review_status ?? "unreviewed",
    [events]);

  const handleSelectEvent = useCallback((id: number) => setSelectedId(id), []);
  const handleSetReview = useCallback(async (id: number, status: "confirmed" | "rejected" | "unreviewed") => {
    try { await setEventReview(dir, id, status); await refreshEvents(); }
    catch (e) { setNotice(`Review update failed: ${String(e)}`); }
  }, [dir, refreshEvents]);
  const handleUpdateBounds = useCallback(async (id: number, t_start: number, t_end: number, f_low: number, f_high: number) => {
    try { await updateEventBounds(dir, id, t_start, t_end, f_low, f_high); await refreshEvents(); }
    catch (e) { setNotice(`Bounds update failed: ${String(e)}`); }
  }, [dir, refreshEvents]);
  const handleAddEvent = useCallback(async (e: { t_start: number; t_end: number; f_low: number; f_high: number }) => {
    if (!selectedPath) return;
    try {
      const newId = await addManualEvent(dir, sid, selectedPath, { tStart: e.t_start, tEnd: e.t_end, fLow: e.f_low, fHigh: e.f_high });
      await refreshEvents(); setSelectedId(newId);
    } catch (err) { setNotice(`Add event failed: ${String(err)}`); }
  }, [dir, sid, selectedPath, refreshEvents]);
  const handleDelete = useCallback(async (id: number) => {
    try { await deleteEvent(dir, id); if (selectedId === id) setSelectedId(null); await refreshEvents(); }
    catch (e) { setNotice(`Delete failed: ${String(e)}`); }
  }, [dir, selectedId, refreshEvents]);
  const handleEditLabelNote = useCallback(async (id: number, label: string, note: string) => {
    try { await setEventReview(dir, id, currentStatus(id), label, note); await refreshEvents(); }
    catch (e) { setNotice(`Label/note update failed: ${String(e)}`); }
  }, [dir, currentStatus, refreshEvents]);

  const src = selectedPath ? audioSrc(selectedPath) : null;
  const doneRows = rows.filter((r) => r.status === "done");

  return (
    <div className="reveal" style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 0,
      minHeight: 520, border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden", background: "var(--bg-panel)" }}>
      <aside style={{ borderRight: "1px solid var(--border-color)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>RECORDINGS</span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{doneRows.length}/{rows.length}</span>
        </div>
        {prepareError && (
          <div style={{ margin: "8px 10px 0", fontSize: 11, color: "#f06a4e" }}>{prepareError}</div>
        )}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          {rows.map((row) => {
            const isDone = row.status === "done";
            const isSelected = selectedPath === row.path;
            const basename = row.path.split("/").pop() || row.path;
            return (
              <button key={row.path} disabled={!isDone} onClick={() => isDone && selectFile(row.path)} title={row.path}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 12px",
                  background: isSelected ? "var(--bg-hover)" : "transparent", border: "none",
                  borderLeft: isSelected ? "3px solid var(--accent-color)" : "3px solid transparent",
                  cursor: isDone ? "pointer" : "default", opacity: isDone ? 1 : 0.4, textAlign: "left", minWidth: 0 }}>
                <span style={{ flex: 1, fontSize: 12.5, color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename}</span>
                {isDone && <span style={{ fontSize: 10.5, color: "var(--text-secondary)", border: "1px solid var(--border-color)", borderRadius: 10, padding: "1px 6px" }}>{row.n_events}</span>}
              </button>
            );
          })}
        </div>
      </aside>
      <section style={{ display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg-color)", padding: 12, gap: 12 }}>
        {notice && (
          <div className="notice reveal" style={{ fontSize: 12 }}>
            {notice}
            <button onClick={() => setNotice(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}>✕</button>
          </div>
        )}
        {!selectedPath ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
            Select a completed recording to review its events.
          </div>
        ) : loadingEvents ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>Loading events…</div>
        ) : (
          <>
            <AudioVisualizer src={src} events={events} selectedId={selectedId}
              onSelectEvent={handleSelectEvent} onUpdateBounds={handleUpdateBounds} onAddEvent={handleAddEvent} />
            <EventTable events={events} selectedId={selectedId} onSelect={handleSelectEvent}
              onSetReview={handleSetReview} onDelete={handleDelete} onEditLabelNote={handleEditLabelNote} />
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Wire a Batch/Review nav into `src/App.tsx`** — add a `section` state and a toggle, and render `ReviewView` when a finished session exists. Apply these changes to the ported `App.tsx`:

```tsx
// add import
import ReviewView from "./components/ReviewView";
// add state near the other useState calls:
const [section, setSection] = useState<"batch" | "review">("batch");
```

Add a nav under the `<header>` (before the `view === "setup"` block):

```tsx
      <nav className="reveal" style={{ display: "flex", gap: 8, margin: "0 0 16px" }}>
        <button className={section === "batch" ? "primary" : "backlink"} onClick={() => setSection("batch")}>Batch</button>
        <button className={section === "review" ? "primary" : "backlink"} onClick={() => setSection("review")} disabled={!start || !opts}>
          Review
        </button>
      </nav>
```

Wrap the existing setup/run blocks so they only render in the batch section, and render Review in the review section:

```tsx
      {section === "batch" && view === "setup" && <SetupView onStarted={onStarted} />}
      {section === "batch" && view === "run" && start && (
        /* ...existing run block unchanged... */
      )}
      {section === "review" && start && opts && (
        <ReviewView start={start} opts={opts} rows={rows} />
      )}
```

- [ ] **Step 3: Verify build + type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke test of Review**

Run: `npm run tauri dev`
Steps: run a batch on a small folder → switch to **Review** → pick a done file → confirm spectrogram + regions load, Confirm/Reject recolors the region, dragging a region edge persists (re-select the file; bounds stick), drawing a new region adds a Manual event, Delete removes it.
Expected: all interactions persist (reflected after re-selecting the file).

- [ ] **Step 5: Commit**

```bash
git add src/components/ReviewView.tsx src/App.tsx
git commit -m "feat(app): Review mode — curate ML events on the spectrogram"
```

---

## Phase 5 — Export confirmed-only

### Task 5.1: Add `confirmed_only` to export (backend, TDD)

**Files:**
- Modify: `batch-core/src/export.rs`
- Modify: `src-tauri/src/commands.rs` (`export_session`)

**Interfaces:**
- Consumes: the `events.review_status` column (Task 4.1).
- Produces: `export_csv`/`export_json` with a 5th `confirmed_only: bool` param; `export_session` command with a 6th `confirmed_only: bool` param.

- [ ] **Step 1: Write the failing test** — add to `export.rs` tests:

```rust
    #[test]
    fn confirmed_only_filters_to_confirmed() {
        let (s, sid) = store_with_events();
        let eid: i64 = s.conn.query_row(
            "SELECT id FROM events WHERE session_id=?1 ORDER BY t_start LIMIT 1",
            rusqlite::params![sid], |r| r.get(0)).unwrap();
        s.set_event_review(eid, "confirmed", None, None).unwrap();
        let p = std::env::temp_dir().join(format!("bc_conf_{}.json", std::process::id()));
        let n = export_json(&s, sid, &p, false, true).unwrap();
        assert_eq!(n, 1);
        std::fs::remove_file(&p).ok();
    }
```

- [ ] **Step 2: Update the existing export tests' call sites** — the three existing tests call `export_csv(&s, sid, &p, false)` / `export_json(...)`; add the new `false` arg to each so they read `export_csv(&s, sid, &p, false, false)` (and `true, false` for the complete-only test).

- [ ] **Step 3: Run tests to verify failure**

Run: `cargo test -p batch-core export`
Expected: FAIL — arity mismatch / `confirmed_only` not handled.

- [ ] **Step 4: Update `export.rs`** — replace the `SELECT` const, `collect`, `export_csv`, `export_json`:

```rust
const SELECT: &str = "SELECT f.path, e.t_start, e.t_end, e.duration, e.f_low, e.f_high, \
     e.center_freq, e.stage_a_conf, e.completeness_score, e.completeness_label, e.retained, \
     e.n_members, e.review_status \
     FROM events e JOIN files f ON f.id=e.file_id \
     WHERE e.session_id=?1 \
       AND (?2=0 OR e.completeness_label='complete') \
       AND (?3=0 OR e.review_status='confirmed') \
     ORDER BY f.path, e.t_start";
```

```rust
#[derive(serde::Serialize)]
struct Row {
    path: String, t_start: f64, t_end: f64, duration: f64, f_low: f64, f_high: f64,
    center_freq: f64, stage_a_conf: f64, completeness_score: Option<f64>,
    completeness_label: Option<String>, retained: Option<bool>, n_members: i64, review_status: String,
}

fn collect(store: &Store, session_id: i64, complete_only: bool, confirmed_only: bool) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = store.conn.prepare(SELECT)?;
    let rows = stmt.query_map(params![session_id, complete_only as i64, confirmed_only as i64], |r| {
        Ok(Row {
            path: r.get(0)?, t_start: r.get(1)?, t_end: r.get(2)?, duration: r.get(3)?,
            f_low: r.get(4)?, f_high: r.get(5)?, center_freq: r.get(6)?, stage_a_conf: r.get(7)?,
            completeness_score: r.get(8)?, completeness_label: r.get(9)?,
            retained: r.get::<_, Option<i64>>(10)?.map(|v| v != 0), n_members: r.get(11)?, review_status: r.get(12)?,
        })
    })?;
    rows.collect()
}

pub fn export_csv(store: &Store, session_id: i64, path: &Path, complete_only: bool, confirmed_only: bool) -> Result<usize, Box<dyn Error>> {
    let rows = collect(store, session_id, complete_only, confirmed_only)?;
    let mut f = File::create(path)?;
    writeln!(f, "path,t_start,t_end,duration,f_low,f_high,center_freq,stage_a_conf,completeness_score,completeness_label,retained,n_members,review_status")?;
    for r in &rows {
        writeln!(f, "{},{},{},{},{},{},{},{},{},{},{},{},{}",
            csv_escape(&r.path), r.t_start, r.t_end, r.duration, r.f_low, r.f_high, r.center_freq, r.stage_a_conf,
            r.completeness_score.map(|v| v.to_string()).unwrap_or_default(),
            r.completeness_label.clone().unwrap_or_default(),
            r.retained.map(|v| v.to_string()).unwrap_or_default(), r.n_members, r.review_status)?;
    }
    Ok(rows.len())
}

pub fn export_json(store: &Store, session_id: i64, path: &Path, complete_only: bool, confirmed_only: bool) -> Result<usize, Box<dyn Error>> {
    let rows = collect(store, session_id, complete_only, confirmed_only)?;
    let f = File::create(path)?;
    serde_json::to_writer_pretty(f, &rows)?;
    Ok(rows.len())
}
```

- [ ] **Step 5: Update `export_session` command** in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn export_session(output_dir: String, session_id: i64, path: String, fmt: String, complete_only: bool, confirmed_only: bool) -> Result<usize, String> {
    let store = Store::open(&db_path(&output_dir)).map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    let n = if fmt == "json" {
        export_json(&store, session_id, &p, complete_only, confirmed_only)
    } else {
        export_csv(&store, session_id, &p, complete_only, confirmed_only)
    }.map_err(|e| e.to_string())?;
    Ok(n)
}
```

- [ ] **Step 6: Run tests + build**

Run: `cargo test -p batch-core export && cargo build -p app`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add batch-core/src/export.rs src-tauri/src/commands.rs
git commit -m "feat(batch-core): confirmed-only export filter"
```

### Task 5.2: Wire the confirmed-only toggle into the frontend export

**Files:**
- Modify: `src/api.ts` (`exportSession` signature)
- Modify: `src/App.tsx` (`doExport`)
- Modify: `src/components/RunView.tsx` (export controls)

**Interfaces:**
- Consumes: `export_session` (6 args).
- Produces: `exportSession(outputDir, sessionId, path, fmt, completeOnly, confirmedOnly)`.

- [ ] **Step 1: Update `exportSession` in `src/api.ts`:**

```ts
export const exportSession = (
  outputDir: string, sessionId: number, path: string, fmt: string,
  completeOnly: boolean, confirmedOnly: boolean
) => invoke<number>("export_session", { outputDir, sessionId, path, fmt, completeOnly, confirmedOnly });
```

- [ ] **Step 2: Update `doExport` in `src/App.tsx`** to accept + pass `confirmedOnly`:

```tsx
  const doExport = async (fmt: string, completeOnly: boolean, confirmedOnly: boolean) => {
    if (!start || !opts) return;
    const path = await pickSavePath(`events.${fmt}`);
    if (!path) return;
    try {
      const n = await exportSession(opts.outputDir, start.session_id, path, fmt, completeOnly, confirmedOnly);
      setNotice(`Exported ${n} rows to ${path}`);
    } catch (e) { setNotice(`Export failed: ${String(e)}`); }
  };
```

- [ ] **Step 3: Update `RunView.tsx` export controls** — the `onExport` prop type becomes `(fmt: string, completeOnly: boolean, confirmedOnly: boolean) => void`. Add a "Confirmed only" checkbox alongside the existing "Complete only" control and pass its value through to `onExport`. (Read `RunView.tsx` for the existing export button markup; thread the new boolean the same way `completeOnly` is threaded.)

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/App.tsx src/components/RunView.tsx
git commit -m "feat(app): confirmed-only export toggle in the UI"
```

---

## Phase 6 — Cleanup & docs

### Task 6.1: Delete `batch-app`, dead Field Station files, and stale deps

**Files:**
- Delete: `batch-app/` (entire dir), `src/lib/db.ts` (and `src/lib/` if empty), `public/` PWA assets if present
- Modify: `Cargo.toml` (remove `exclude`), `package.json` (drop `dexie`)

**Interfaces:**
- Produces: a single-app repo with no `batch-app/`, no Dexie, no PWA artifacts.

- [ ] **Step 1: Confirm nothing imports the dead files**

Run: `grep -rn "lib/db" src; grep -rn "batch-app" src src-tauri Cargo.toml`
Expected: no references in `src/` (the only `db.ts` user, `AnnotationTable`, was removed in Task 4.6; `AudioVisualizer` no longer imports it).

- [ ] **Step 2: Delete the standalone shell + dead files**

```bash
git rm -r batch-app
git rm src/lib/db.ts
rmdir src/lib 2>/dev/null; true
```

- [ ] **Step 3: Remove the workspace `exclude`** in root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["batch-core", "src-tauri"]
```

- [ ] **Step 4: Drop `dexie` from `package.json`** dependencies, then:

Run: `npm install`
Expected: lockfile drops `dexie`.

- [ ] **Step 5: Verify the whole thing still builds + tests pass**

Run: `cargo test --workspace && npm run build`
Expected: PASS — workspace tests green, frontend builds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove standalone batch-app shell + Dexie/PWA remnants"
```

### Task 6.2: Update README + architecture docs

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/batch-app.md` (rename/retarget to the unified app)

**Interfaces:** docs only.

- [ ] **Step 1: Update `README.md`** — the project is now one desktop app. Replace the "two parts" framing and the run instructions:
  - Run (desktop): from repo root, `npm install` then `npm run tauri dev`.
  - Headless CLI: `cargo run -p batch-core --bin batch -- --input data/ --device cpu --db output/batch.db --export-csv events.csv` (no more `--manifest-path batch-app/Cargo.toml`).
  - Describe the two modes (Batch, Review) and the curate-ML-events workflow + confirmed-only export.

- [ ] **Step 2: Update `docs/architecture.md`** — note the single Tauri app, the `batch-core` workspace crate, the `events` curation columns (`review_status`/`source`/`label`/`note`/`reviewed_at`), and the asset-protocol audio path for Review.

- [ ] **Step 3: Retarget `docs/batch-app.md`** — update paths (`batch-core/`, root `src-tauri/`, root `src/`), the expanded Tauri command surface (add the review/curation commands), and the Review UI. Rename references from "batch app" to "Bird Audio Analyzer" where appropriate.

- [ ] **Step 4: Commit**

```bash
git add -f README.md docs/architecture.md docs/batch-app.md
git commit -m "docs: update for unified Bird Audio Analyzer (single app, review mode)"
```

### Task 6.3: Final end-to-end verification (manual)

- [ ] **Step 1: Full workspace test**

Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 2: Production build**

Run: `npm run build && cargo build --workspace --release` (or `npm run tauri build` for a bundle)
Expected: PASS.

- [ ] **Step 3: End-to-end on a real folder (macOS/MPS)**

Run: `npm run tauri dev`
Flow: Setup (pick a small recording folder, device MPS) → Run (watch progress to completion) → Review (open a file, confirm/reject/edit/add events) → Batch → Export with **Confirmed only** → open the CSV/JSON and verify only confirmed events are present with a `review_status` column.
Expected: all steps succeed; exported rows match the curated state.

- [ ] **Step 4: Commit any fixups discovered during QA, then the branch is ready for review.**

---

## Self-Review (completed during authoring)

**Spec coverage:** unified app (Phases 1–6); desktop-only Tauri (Phase 2 conf, Phase 6 dep removal); single SQLite store (no Dexie by Phase 6); curate-ML-events model (Phase 4 columns + Review UI); Approach A clean workspace (Phase 1); name "Bird Audio Analyzer" (Phase 2 conf); mic/upload cut (NativeProcessor/audioProcessor removed Phase 3, no mic UI ported); build-safe phases (each ends with a build/test gate); export confirmed-only (Phase 5); tests for store + export (Phases 4–5); error/empty states (Review components); manual macOS/MPS QA (Task 6.3). ✔

**Deviation from spec §3 noted:** the spec sketched a `src/views/` subdir; the plan keeps a flat `src/components/` layout to avoid rewriting the ported components' relative imports (they use `./FileTable`, `../api`). Functionally identical; lower risk.

**Placeholder scan:** Task 5.2 Step 3 (RunView export checkbox) and Task 6.2 (doc prose) intentionally describe edits against files the implementer will read rather than reproducing large unchanged markup; all *new* code is given in full. No TBD/TODO left.

**Type consistency:** `EventRow` (snake_case) is identical across `store.rs`, `types.ts`, and all three components; api arg keys are camelCase (Tauri-mapped); `export_*` arity (5) and `export_session` arity (6) match between `export.rs`, `commands.rs`, `api.ts`, and `App.tsx`.
