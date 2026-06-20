# Bird Audio Analyzer — Batch App Reference

> Status: prototype (`leyang/prototype`). This is the **developer reference** for
> the desktop batch app at the repo root. For the conceptual overview and
> Mermaid diagrams, see [`architecture.md`](architecture.md). For the ML pipeline
> internals, see the source under `birdpipe/` and `scripts/ml_engine.py`.

The **Bird Audio Analyzer** is a Tauri desktop app that batch-processes folders of
field recordings to detect the high-frequency *"buzz"* call of the Hume's Leaf
Warbler (*Phylloscopus humei*, "HLW"). It is built in three layers plus a
language-agnostic worker boundary:

```
React UI  ──invoke()/events──▶  Tauri shell (Rust)  ──run_session()──▶  batch-core engine (Rust)
                                                                              │  NDJSON over stdin/stdout
                                                                              ▼
                                                              Python ML worker (scripts/ml_engine.py --worker)
```

Two front doors share one engine: the **GUI** (`src-tauri` + `src`) and a headless
**CLI** (`batch-core/src/bin/batch.rs`). All durable state lives in a SQLite file
(`<output>/batch.db`), which makes every run resumable and idempotent.

---

## Table of contents

1. [Repository layout](#1-repository-layout)
2. [Build & run](#2-build--run)
3. [Layer 1 — `batch-core` engine](#3-layer-1--batch-core-engine)
4. [The worker protocol](#4-the-worker-protocol)
5. [Layer 2 — Tauri shell](#5-layer-2--tauri-shell)
6. [Layer 3 — React frontend](#6-layer-3--react-frontend)
7. [End-to-end data flow](#7-end-to-end-data-flow)
8. [CLI reference (`batch`)](#8-cli-reference-batch)
9. [Configuration reference](#9-configuration-reference)
10. [Testing](#10-testing)
11. [Known limitations & packaging gotchas](#11-known-limitations--packaging-gotchas)

---

## 1. Repository layout

```
bird-audio/
├── Cargo.toml                 # Rust workspace: members = batch-core, src-tauri
├── package.json               # Frontend + Tauri CLI (npm), package name "bird-batch-gui"
├── vite.config.ts             # Vite dev server on :1420 (strictPort)
├── index.html                 # Webview entry → /src/main.tsx
│
├── batch-core/                # Pure-Rust orchestration engine (no Tauri dependency)
│   ├── Cargo.toml             # deps: serde, serde_json, rusqlite(bundled), walkdir
│   └── src/
│       ├── lib.rs             # re-exports the modules below
│       ├── engine.rs          # job lifecycle, worker pool, retries, cancellation
│       ├── store.rs           # SQLite persistence ("the DB IS the durable state")
│       ├── protocol.rs        # serde types for the NDJSON worker protocol
│       ├── worker.rs          # subprocess spawn + stdin/stdout wiring
│       ├── concurrency.rs     # worker-count policy (GPU=1, CPU=cores−1)
│       ├── enumerate.rs       # audio file discovery (.wav/.flac/.mp3)
│       ├── export.rs          # CSV / JSON export from batch.db
│       └── bin/batch.rs       # headless CLI front door
│   └── tests/
│       ├── integration.rs     # end-to-end engine tests against a fake worker
│       └── fake_worker.py     # protocol test double (no ML)
│
├── src-tauri/                 # Tauri v2 shell, crate "bird-batch-gui" / lib "app_lib"
│   ├── Cargo.toml             # deps: tauri 2, tauri-plugin-dialog, batch-core
│   ├── tauri.conf.json        # window, bundle, identifier com.bird.batchrunner
│   ├── capabilities/default.json   # permissions: core:default, dialog:default
│   └── src/
│       ├── main.rs            # binary entry → app_lib::run()
│       ├── lib.rs             # Tauri builder, plugin + command registration
│       ├── commands.rs        # the #[tauri::command] IPC surface
│       └── state.rs           # AppState (the cancel flag)
│
└── src/                       # React 19 + Vite + TypeScript frontend
    ├── main.tsx               # React root
    ├── App.tsx                # shell: SetupView ↔ RunView, run-state owner
    ├── api.ts                 # all invoke()/listen() wrappers
    ├── types.ts               # TS mirrors of the Rust structs
    ├── index.css              # theme
    └── components/
        ├── SetupView.tsx      # config screen (folder, θ_A, θ_B, advanced)
        ├── RunView.tsx        # live run dashboard + export
        ├── FileTable.tsx      # virtualized per-file status table
        └── ManageCache.tsx    # cache inspection / deletion panel
```

How it relates to the rest of the repo: `birdpipe/` (pure-logic Python package),
`scripts/ml_engine.py` (the ML entry point and `--worker` server), and `models/`
(`buzz_localizer.pt`, `classifier.pt`) are the **underlying ML pipeline** that
`batch-core` drives as a subprocess. The batch app is the **product**; the pipeline
is the engine inside it.

---

## 2. Build & run

### Prerequisites

| Tool | Used for | Notes |
|---|---|---|
| **Rust** (1.77.2+) | `batch-core` + Tauri shell | `rustup` |
| **Node** + **npm** | frontend + Tauri CLI | `@tauri-apps/cli` is a devDependency |
| **uv** | the Python ML worker | the worker is launched as `uv run python …` |
| System WebView | Tauri runtime | WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux) |
| `models/buzz_localizer.pt`, `models/classifier.pt` | ML inference | verify with `uv run scripts/verify_models.py` |

### Run the GUI (development)

```bash
npm install
npm run tauri dev      # launches Vite on :1420, then the Tauri window
```

`npm run tauri dev` runs `beforeDevCommand: npm run dev` (Vite) and points the
WebView at `http://localhost:1420` (`tauri.conf.json`). The app's **Setup** screen
runs a health check (`check_health`) and offers a **Prepare System** button that
runs `uv sync` if the Python env or models are missing.

### Build distributable bundles

```bash
npm run tauri build    # runs `npm run build` then bundles for the current OS
```

Bundles for `.app`/`.dmg`/`.msi`/`.deb`/… are produced under
`src-tauri/target/release/bundle/` (`bundle.targets = "all"`). **See the
[packaging gotchas](#11-known-limitations--packaging-gotchas)** — the bundled app
relies on `uv` and the repo's `models/`+`pyproject.toml` being discoverable, which
needs work before it ships standalone.

### Run the headless CLI (no GUI)

The same engine, driven from the terminal. Run from the **repo root** so the
default worker command (`scripts/ml_engine.py`) and `models/` resolve:

```bash
# from repo root
cargo run -p batch-core --bin batch -- \
  --input data/ --device cpu --db output/batch.db
```

See the [CLI reference](#8-cli-reference-batch) for all flags.

---

## 3. Layer 1 — `batch-core` engine

`batch-core` (`lib.rs`) is a headless, GUI-agnostic crate. It owns enumeration,
scheduling, the worker subprocess pool, persistence, retries, resume, and export.
`lib.rs` re-exports seven modules: `protocol`, `enumerate`, `concurrency`, `store`,
`worker`, `engine`, `export`.

### 3.1 Data model & persistence (`store.rs`)

> *"The DB IS the durable state."* — `store.rs`

Everything goes through `Store { pub conn: Connection }`, opened in WAL mode. The
schema is three tables:

```sql
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_roots TEXT NOT NULL,        -- JSON array of canonical root paths (resume key)
  output_dir TEXT NOT NULL,
  device TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  theta_a REAL NOT NULL,
  theta_b REAL NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|in_progress|done|failed
  n_events INTEGER NOT NULL DEFAULT 0,
  n_complete INTEGER NOT NULL DEFAULT 0,
  n_retained INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  UNIQUE(session_id, path)                  -- makes add_files idempotent
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  t_start REAL, t_end REAL, duration REAL,
  f_low REAL, f_high REAL, center_freq REAL,
  stage_a_conf REAL,
  completeness_score REAL,
  completeness_label TEXT,                   -- 'complete' | 'incomplete'
  retained INTEGER,                          -- 0/1
  n_members INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_session_status   ON files(session_id, status);
CREATE INDEX IF NOT EXISTS idx_events_file            ON events(file_id);
CREATE INDEX IF NOT EXISTS idx_events_session_label   ON events(session_id, completeness_label, retained);
```

**The `files` table is the work queue.** There is no in-memory queue. The
scheduling primitive is one atomic SQL statement:

```sql
-- claim_next_pending(session_id): pending → in_progress, FIFO by id, atomic
UPDATE files SET status='in_progress', attempts=attempts+1
WHERE id = (SELECT id FROM files WHERE session_id=?1 AND status='pending' ORDER BY id LIMIT 1)
RETURNING id, path, attempts;
```

Key `Store` methods:

| Method | Purpose |
|---|---|
| `open(path)` / `open_memory()` | open file-backed (WAL) or in-memory DB + run schema |
| `create_session(&NewSession)` | insert a run, returns `session_id` |
| `add_files(session_id, &[PathBuf])` | `INSERT OR IGNORE` (dedup) + bump `total_files` |
| `claim_next_pending(session_id)` | atomic claim → `Option<Claimed>` |
| `requeue` / `mark_failed` | retry vs terminal-fail a file |
| `reset_in_progress(session_id)` | crash recovery: `in_progress` → `pending` |
| `record_success(session_id, file_id, &RecordedResult)` | one transaction: set file `done` + bulk-insert events |
| `summary(session_id)` | per-status counts + event totals → `Summary` |
| `find_resumable(input_roots)` | most recent session with matching roots (resume key) |
| `list_files(session_id)` | feed the GUI table (`FileRow`) |
| `delete_cached_files(session_id, &[String])` | ManageCache: delete events+files by path |
| `get_latest_session_id()` | newest session, for cache panel |

`record_success` takes `&mut self` because it opens a `conn.transaction()`;
everything else takes `&self`. `Store.conn` is `pub` so `export.rs` and tests can
issue raw SQL.

**File status state machine:**

```
pending ──claim──▶ in_progress ──success──▶ done
   ▲                    │
   └──requeue/reset─────┴──fail (attempts ≥ max)──▶ failed
```

### 3.2 Job lifecycle (`engine.rs`)

Entry point:

```rust
pub fn run_session(
    store: Arc<Mutex<Store>>,
    session_id: i64,
    cfg: EngineConfig,
    progress: Option<Sender<Progress>>,
) -> Summary
```

Flow:

1. `reset_in_progress(session_id)` — recover orphans from a prior crash.
2. Spawn `cfg.concurrency` OS threads, each running an identical `worker_loop`.
3. **`worker_loop`** (per thread), repeating until the queue drains:
   - Check `cfg.cancel` (`Arc<AtomicBool>`, relaxed) → break if set.
   - `store.claim_next_pending(session_id)` under the mutex → `None` ⇒ break.
   - Lazily `Worker::spawn(...)` the Python subprocess if this thread has none.
   - Send `Request { id: file_id, input, manifest_only, theta_a, theta_b, emit_raw: false }`.
   - `w.recv_timeout(cfg.timeout)` and match:
     - `Result { id == file_id }` → `record_success(...)`.
     - `Error { message }` → `mark_failed(...)` (**no retry** for worker-reported errors).
     - id mismatch / unexpected msg → kill worker, `fail_or_requeue`.
     - `Err(timeout|closed)` → kill worker, `fail_or_requeue`.
   - `fail_or_requeue`: if `attempts ≥ max_attempts` → `mark_failed`, else `requeue`.
   - Emit a `Progress` snapshot on the optional channel.
4. Each thread kills its worker on exit; threads are joined.
5. `set_session_status(session_id, "done")`; return `summary(session_id)`.

### 3.3 Concurrency model (`concurrency.rs`)

```rust
pub fn resolve_concurrency(device: &str, requested: Option<usize>) -> usize
```

- Explicit `requested` wins (min 1).
- `cuda*` / `mps*` → always **1** (GPU memory is shared; one worker per GPU).
- CPU → `available_parallelism() − 1` (min 1).

Parallelism is N identical OS threads racing to `claim_next_pending`. SQLite's
serialized writes guarantee no two threads claim the same file; the mutex is held
only for the duration of a single SQL statement. Cancellation is a shared
`AtomicBool` checked at the top of each loop (in-flight files are **not**
preempted). Progress is one-way over an `mpsc` channel.

### 3.4 Enumeration (`enumerate.rs`)

```rust
pub fn enumerate_audio(roots: &[PathBuf]) -> Vec<PathBuf>
```

`walkdir` recursion over each root, keeping files whose (case-insensitive)
extension is in `{wav, flac, mp3}`. Paths are canonicalized, de-duplicated through
a `HashSet`, and returned sorted.

### 3.5 Export (`export.rs`)

```rust
pub fn export_csv (store, session_id, path, complete_only: bool) -> Result<usize, …>
pub fn export_json(store, session_id, path, complete_only: bool) -> Result<usize, …>
```

Both read the same join:

```sql
SELECT f.path, e.t_start, e.t_end, e.duration, e.f_low, e.f_high, e.center_freq,
       e.stage_a_conf, e.completeness_score, e.completeness_label, e.retained, e.n_members
FROM events e JOIN files f ON f.id = e.file_id
WHERE e.session_id = ?1 AND (?2 = 0 OR e.completeness_label = 'complete')
ORDER BY f.path, e.t_start;
```

`complete_only = true` restricts to `completeness_label = 'complete'`. CSV is
hand-written with proper quoting; JSON is `serde_json::to_writer_pretty`. Both
return the row count written.

### 3.6 Key types

```rust
// engine.rs
pub struct EngineConfig {
    pub python: String,            pub worker_args: Vec<String>,
    pub cwd: Option<PathBuf>,      pub concurrency: usize,
    pub theta_a: f64,              pub theta_b: f64,
    pub manifest_only: bool,       pub timeout: Duration,
    pub max_attempts: i64,         pub cancel: Option<Arc<AtomicBool>>,
}
pub struct Progress { pub total, done, failed, pending, in_progress: i64, pub last_file: Option<String> }

// store.rs
pub struct Summary { pub total, pending, in_progress, done, failed, n_events, n_complete, n_retained: i64 }
pub struct Claimed { pub file_id: i64, pub path: String, pub attempts: i64 }
pub struct FileRow { pub path, status: String, pub n_events, n_complete: i64, pub error: Option<String> }
pub struct RecordedResult<'a> { pub n_events, n_complete, n_retained, elapsed_ms: i64, pub events: &'a [EventRecord] }
```

---

## 4. The worker protocol

The boundary between the Rust engine and the Python ML worker is **newline-delimited
JSON (NDJSON) over stdin/stdout** — defined in Rust by `protocol.rs` / `worker.rs`
and implemented in Python by `birdpipe/worker.py` (driven from
`scripts/ml_engine.py --worker`). It is the cleanest seam in the system: anything
that speaks this protocol can be a worker.

### 4.1 Transport

- **Engine → worker (stdin):** one `Request` JSON object per line, `\n`-terminated, flushed.
- **Worker → engine (stdout):** one `WorkerMsg` per line. First a single `ready`, then one `result` *or* `error` per request.
- **Framing:** `\n` only — no length prefix, no envelope. Correlation is the `id` field inside the JSON.
- **Flow:** strictly sequential per worker — send one request, block for exactly one reply, then send the next. No pipelining, no streaming progress at the message level.
- **stderr:** discarded by the engine (`Stdio::null()`). All Python diagnostics must go to stderr; anything non-JSON the worker prints to **stdout during processing** will be treated as a protocol error.

### 4.2 Messages

**`Request`** (engine → worker; serde struct, plain snake_case fields):

```rust
struct Request { id: u64, input: String, manifest_only: bool,
                 theta_a: f64, theta_b: f64, emit_raw: bool }
```
```json
{"id":1,"input":"/data/site_A/REC.WAV","manifest_only":true,"theta_a":0.0,"theta_b":0.530306,"emit_raw":false}
```

- `id` = the SQLite `file_id` (correlates the reply).
- `manifest_only=true` → worker does not write vis/crop/wav artifacts, only returns records.
- `emit_raw` is wired through but the engine always sends `false`.

**`WorkerMsg`** (worker → engine; internally tagged on `"type"`):

```rust
#[serde(tag = "type")]
enum WorkerMsg {
  #[serde(rename="ready")]  Ready  { device: String },
  #[serde(rename="result")] Result { id: u64, #[serde(default)] input: String,
        #[serde(default)] n_windows, n_raw, n_events, n_complete, n_retained, elapsed_ms: i64,
        #[serde(default)] events: Vec<EventRecord> },
  #[serde(rename="error")]  Error  { #[serde(default)] id: Option<u64>,
        #[serde(default)] input: Option<String>, message: String,
        #[serde(default)] traceback: Option<String> },
}
```

```jsonc
// ready (once, at startup)
{"type":"ready","device":"cpu"}

// result (one per file)
{"type":"result","id":7,"input":"/data/REC.WAV","n_windows":10,"n_raw":14,
 "n_events":2,"n_complete":1,"n_retained":1,"elapsed_ms":50,
 "events":[{"t_start":1.0,"t_end":2.5,"duration":1.5,"f_low":5000,"f_high":6000,
            "center_freq":5500,"stage_a_conf":0.9,"completeness_score":0.8,
            "completeness_label":"complete","retained":true,"n_members":3}]}

// error (one per failed file; permanently fails it, no retry)
{"type":"error","id":4,"input":"/data/BAD.WAV","message":"Failed to open audio","traceback":"…"}
```

**`EventRecord`** (one consolidated buzz event):

```rust
struct EventRecord {
  t_start, t_end, duration, f_low, f_high, center_freq, stage_a_conf: f64,
  completeness_score: Option<f64>, completeness_label: Option<String>,
  retained: Option<bool>, n_members: i64,
}
```

Unknown extra keys (e.g. `status`, `filename` emitted by the real worker) are
ignored. Missing `result` fields default to zero/empty thanks to `#[serde(default)]`.

### 4.3 Process management (`worker.rs`)

`Worker::spawn(program, args, cwd)` runs `Command::new(program).args(args)` with
`stdin=piped`, `stdout=piped`, `stderr=null`, optional `current_dir(cwd)`. A
dedicated background thread reads `BufReader(stdout).lines()` and forwards each line
over an `mpsc` channel, so the engine never blocks on stdout.

- **Handshake:** after spawn, poll for the `ready` line with a hardcoded **180 s**
  startup timeout. Non-`{`-prefixed lines (library logs) are skipped *during the
  handshake only*. Any non-`ready` JSON during startup is a `Protocol` error.
- **Send/recv:** `send(&Request)` writes the JSON + `\n` + flush; `recv_timeout(dur)`
  pulls one line and parses it as a `WorkerMsg`.
- **Shutdown:** `kill()` and the `Drop` impl both `child.kill()` then `child.wait()`
  — there is no graceful stop; workers are always hard-killed.

### 4.4 Retry / poison semantics

| Failure | Engine action |
|---|---|
| Worker returns `error` | `mark_failed` immediately (no retry) |
| `recv_timeout` elapses | kill worker, requeue (until `max_attempts`), then fail |
| Worker process dies / pipe closes | kill, respawn for next file, requeue/fail current |
| `result` with wrong `id` | kill worker, requeue/fail (should never happen — protocol is sequential) |

### 4.5 Writing a new worker

The minimum contract (see `batch-core/tests/fake_worker.py`):

1. On startup, before reading stdin, print one `{"type":"ready","device":"…"}` (flushed).
2. Read stdin line by line; for each, parse JSON and read `id` + `input`.
3. Print exactly one `result` (with `id`, counts, `events[]`) or one `error` (with `id`, `message`).
4. Flush after every line; send all logs/tracebacks to **stderr**, never stdout.

The real worker is `scripts/ml_engine.py --worker` → `birdpipe.worker.run_worker`,
which maps each request onto `BirdAudioPipeline.process_file` (Stage A → consolidate
→ Stage B → finalize). It needs `models/buzz_localizer.pt` and
`models/classifier.pt` relative to its working directory. For the Stage A/B model
hyperparameters (STFT/windowing, YOLO `conf`/`imgsz`, consolidation gates, crop
size), see [`architecture.md` §10](architecture.md#10-pipeline-parameter-reference-paper-constants).

---

## 5. Layer 2 — Tauri shell

The crate `bird-batch-gui` (lib `app_lib`) is the bridge between the WebView and
`batch-core`. `main.rs` calls `app_lib::run()`; `lib.rs` builds the Tauri app:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())   // native folder / save dialogs
    .manage(state::AppState::default())    // shared cancel flag
    .invoke_handler(tauri::generate_handler![ /* 11 commands */ ])
    .run(tauri::generate_context!())
```

### 5.1 Command (IPC) surface (`commands.rs`)

The full set of `#[tauri::command]` functions the frontend can `invoke`:

| Command | Signature (abbrev.) | What it does |
|---|---|---|
| `start_session` | `(app, state, opts: StartOpts) -> StartResult` | enumerate, open/resume `batch.db`, store cancel flag, **spawn the run on a background thread**, return `{ session_id, total_files }` immediately |
| `cancel_session` | `(state)` | set the shared `AtomicBool` (cooperative stop) |
| `get_summary` | `(output_dir, session_id) -> Summary` | per-status + event counts |
| `list_files` | `(output_dir, session_id) -> Vec<FileRow>` | feed the file table (polled) |
| `export_session` | `(output_dir, session_id, path, fmt, complete_only) -> usize` | dispatch to `export_csv`/`export_json` |
| `check_health` | `async (cwd?) -> HealthStatus` | check models on disk + run a tiny `uv run python -c "import torch…"` to detect the device |
| `prepare_system` | `async (cwd?)` | run `uv sync` |
| `check_cache` | `(output_dir) -> bool` | does `<output_dir>/batch.db` exist? |
| `clear_cache` | `(output_dir)` | delete `batch.db` |
| `get_cached_files` | `(output_dir) -> Vec<CachedFile>` | latest session's files (path+status) |
| `delete_cached_files` | `(output_dir, paths) -> ()` | delete selected files+events |

`StartOpts` (camelCase over the wire) carries `input`, `outputDir`, `device`,
`concurrency`, `workerCmd`, `cwd?`, `thetaA`, `thetaB`, `timeoutSecs`,
`maxAttempts`.

### 5.2 State & threading (`state.rs`)

```rust
#[derive(Default)]
pub struct AppState { pub cancel: Mutex<Option<Arc<AtomicBool>>> }
```

That is the *entire* in-process state — everything else is in SQLite.
`start_session` returns right away after spawning **two threads**:

- a **run thread** that calls `run_session(Arc<Mutex<Store>>, sid, cfg, tx)` and, when it returns, emits `batch://done` with the final `Summary`;
- a **forwarder thread** that drains the progress channel and re-emits it to the WebView as `batch://progress`, **throttled to ≥250 ms** between emits.

### 5.3 Events

| Event | Payload | Emitted by |
|---|---|---|
| `batch://progress` | `Progress` | forwarder thread (throttled 250 ms) |
| `batch://done` | `Summary` | run thread, once, after the forwarder drains |

The frontend `listen()`s for both; progress is push-based (no progress-polling
command). The file table is polled separately via `list_files`.

### 5.4 Worker command & cwd resolution

The worker command is **not** hardcoded in Rust — the frontend passes
`opts.workerCmd` (default `"uv run python scripts/ml_engine.py --worker"`). Rust
splits it on whitespace (`program` + `args`) and appends `--device <device>`.

`resolve_cwd(cwd)` (used by `start_session`, `check_health`, `prepare_system`)
takes the provided `cwd` (or `current_dir()`), then walks **up to 3 parents** looking
for a directory that contains both `models/` and `pyproject.toml`. This finds the
repo root in development; see the [packaging gotchas](#11-known-limitations--packaging-gotchas)
for why it breaks in a bundled app.

### 5.5 Config & permissions

`tauri.conf.json`: product `Bird Batch Runner`, identifier `com.bird.batchrunner`,
1100×760 window, `frontendDist=../dist`, `devUrl=http://localhost:1420`,
`bundle.targets="all"`, **`security.csp=null`** (CSP disabled — acceptable for a
local-only tool).

`capabilities/default.json`: permissions are only `core:default` + `dialog:default`.
There are **no** `fs`/`shell`/`process`/`http` capabilities — the WebView cannot
touch the filesystem or run processes directly; everything goes through the Rust
commands above.

---

## 6. Layer 3 — React frontend

### 6.1 Stack

React **19**, Vite **8**, TypeScript ~5.8, `@tauri-apps/api` v2 (`invoke` + `listen`),
`@tauri-apps/plugin-dialog` (native pickers), `@tanstack/react-virtual` (file-table
virtualization). Dev server is fixed to port 1420 (`strictPort`).

### 6.2 App shell (`App.tsx`)

A single screen with a two-value view model — no router:

```ts
const [view, setView] = useState<"setup" | "run">("setup");
```

`App.tsx` owns all run state: `start` (`StartResult`), `opts`, `progress`,
`summary` (non-null ⇒ done), `rows` (`FileRow[]`), a throughput EMA, a `notice`
toast, and a `cancelled` flag. On entering the run view it: (a) immediately polls
`getSummary` (race guard for very fast runs), (b) subscribes to `onProgress` /
`onDone`, and (c) starts a `setInterval` polling `listFiles` every 2 s.
`ManageCache` is **not** a top-level view — it renders inside `SetupView` when the
chosen folder already has a cache.

### 6.3 IPC layer (`api.ts`)

Every Rust command/event has a thin wrapper here (the mirror of §5.1):

```ts
checkHealth(cwd?)                     → invoke("check_health")
prepareSystem(cwd?)                   → invoke("prepare_system")
checkCache(outputDir)                 → invoke("check_cache")
clearCache(outputDir)                 → invoke("clear_cache")
getCachedFiles(outputDir)             → invoke("get_cached_files")
deleteCachedFiles(outputDir, paths)   → invoke("delete_cached_files")
startSession(opts)                    → invoke("start_session")
cancelSession()                       → invoke("cancel_session")
getSummary(outputDir, sessionId)      → invoke("get_summary")
listFiles(outputDir, sessionId)       → invoke("list_files")
exportSession(outputDir, sid, path, fmt, completeOnly) → invoke("export_session")
pickFolder()                          → plugin-dialog open({directory:true})
pickSavePath(defaultName)             → plugin-dialog save()
onProgress(cb)                        → listen("batch://progress")
onDone(cb)                            → listen("batch://done")
```

### 6.4 Types (`types.ts`)

TS interfaces mirroring the Rust structs: `StartOpts`, `StartResult`
(snake_case `session_id`/`total_files`), `Progress`, `Summary`, `FileRow`,
`CachedFile`, `HealthStatus`. (Note the asymmetry: `StartResult` uses snake_case
while the others are camelCase, reflecting serde defaults vs. renames.)

### 6.5 Components

- **`SetupView`** — collects the **Recording folder** (used as both input *and*
  output dir), **Detection sensitivity** (θ_A, default 0), **Quality filter**
  (θ_B, default 0.530306), and an *Advanced* disclosure for `workerCmd`, `device`,
  `cwd`, `concurrency`, `timeoutSecs`, `maxAttempts`. Runs `checkHealth` on mount /
  on `cwd` change; the "Begin Listening" button is gated on `env_ok && models_ok`.
  A "Prepare System" button (shown when not ready) runs `prepareSystem` then
  re-checks. When the folder already has a cache, `ManageCache` is shown inline.
- **`RunView`** — pure display. Progress bar (`(done+failed)/total`), a 7-tile stat
  strip (processed / failed / active / remaining / total / speed / ETA), a
  last-file ticker, and on completion three count-up numbers (Detections =
  `n_events`, High-quality = `n_complete`, Retained = `n_retained`). Filter chips
  (All / Complete / Failed), a Cancel button (while running), and export buttons
  (CSV / CSV complete-only / JSON) after completion.
- **`FileTable`** — virtualized (`@tanstack/react-virtual`, 34 px rows). Each row:
  a colored status pill (Pending / Listening / Complete / Failed), the file
  basename (full path in a tooltip), the `n_events` count, and any error string. No
  sort/pagination — filtering via RunView's chips.
- **`ManageCache`** — lists the latest session's cached files with checkboxes and
  select-All / None / Failed helpers. "Clear" calls `clearCache` if every file is
  selected, otherwise `deleteCachedFiles(paths)`.

---

## 7. End-to-end data flow

One full journey (GUI), naming the `api.ts` call → Rust command at each step. For
the visual sequence diagram, see [`architecture.md`](architecture.md) §3.

1. **Load** — `SetupView` mounts → `checkHealth` → `check_health` returns models/device status.
2. **Pick folder** — `pickFolder` (dialog) → `checkCache` → if cached, `getCachedFiles` populates `ManageCache`.
3. **Configure** — adjust θ_A / θ_B (and Advanced if needed).
4. **Start** — `startSession(opts)` → `start_session`; returns `{session_id, total_files}`; view switches to `run`.
5. **Live** — subscribe `onProgress`/`onDone`; poll `listFiles` every 2 s. The engine processes files; each completion bumps `batch://progress`.
6. **Done** — `batch://done` delivers the final `Summary`; RunView shows count-ups + export buttons.
7. **Export** — `pickSavePath("events.csv")` (dialog) → `exportSession(...)` → `export_session` writes the file and returns the row count.

The whole run is resumable: re-pointing at the same folder resumes the matching
session (done files are skipped, orphaned `in_progress` files reset to `pending`).

---

## 8. CLI reference (`batch`)

The headless front door, `batch-core/src/bin/batch.rs` — same engine, no GUI. Args
are parsed by hand (no clap):

```
batch --input <folder>
      [--db batch.db]
      [--device cpu]                # cpu | cuda | mps
      [--concurrency 0]             # 0 = auto (GPU=1, CPU=cores−1)
      [--worker-cmd "uv run python scripts/ml_engine.py --worker"]
      [--cwd DIR]                   # working dir for the worker subprocess
      [--theta-a 0.0]
      [--theta-b 0.530306]
      [--timeout-secs 600]
      [--max-attempts 2]
      [--export-csv out.csv]        # optional: write CSV after the run
```

Behavior: enumerate audio under `--input`, open/create `--db`, **resume** any prior
session with the same (canonicalized) input root, add files idempotently, run with
the resolved concurrency while printing `done/total` progress, then print the
summary and optionally export CSV. `--device` is appended to `--worker-cmd` as
`--device <device>`. The CLI hardcodes `manifest_only=true` and `cancel=None`.

---

## 9. Configuration reference

| Field (GUI `StartOpts` / CLI flag) | Default | Meaning |
|---|---|---|
| `input` / `--input` | — | folder of recordings to scan (`.wav/.flac/.mp3`, recursive) |
| `outputDir` | = `input` (GUI) | where `batch.db` and exports live; the CLI uses `--db` |
| `device` / `--device` | `cpu` | `cpu` \| `cuda` \| `mps`; GPU forces 1 worker |
| `concurrency` / `--concurrency` | `0` (auto) | worker count; 0 ⇒ GPU=1, CPU=cores−1 |
| `workerCmd` / `--worker-cmd` | `uv run python scripts/ml_engine.py --worker` | the ML worker process |
| `cwd` / `--cwd` | auto-resolved | working dir for the worker (must see `models/`, `scripts/`) |
| `thetaA` / `--theta-a` | `0.0` | **Detection Sensitivity** — keep events with `conf ≥ θ_A`; lower = more buzzes |
| `thetaB` / `--theta-b` | `0.530306` | **Quality Filter** — `complete` if `completeness ≥ θ_B`; higher = stricter |
| `timeoutSecs` / `--timeout-secs` | `600` | per-file worker timeout |
| `maxAttempts` / `--max-attempts` | `2` | retry budget before a file is `failed` |

θ_A and θ_B are **post-processing gates** — they change only which events are
labeled/retained, not what the models detect. See
[`architecture.md`](architecture.md) §6 for the full semantics and the
`n_events` / `n_complete` / `n_retained` mapping.

---

## 10. Testing

- **Rust engine** — `cargo test`. `batch-core/tests/integration.rs`
  drives the full `run_session` path against `tests/fake_worker.py` (a protocol
  double with no ML), covering: all-files-done, worker-reported error → failed,
  hung worker → timeout → poison after retries, crashing worker → respawn + pool
  keeps working, resume skips done files, and cancel-before-any-file.
- **Python pipeline** — from the repo root, `uv run pytest` (the `birdpipe` +
  `ml_engine` suite; includes a real-model smoke test).

---

## 11. Known limitations & packaging gotchas

These matter most when moving from `npm run tauri dev` to a shipped bundle:

1. **`resolve_cwd` breaks when bundled.** In a packaged `.app`, `current_dir` is
   `Contents/MacOS/`; walking 3 parents won't find `models/` + `pyproject.toml`, so
   it falls back to the wrong directory. The GUI must pass an explicit `cwd` (or the
   app must bundle the pipeline) before it can run standalone.
2. **`uv` must be on `PATH`.** `check_health` and `prepare_system` call
   `Command::new("uv")` with no absolute path. A bundled macOS app has a minimal
   `PATH`, so `uv` (and thus health/prepare) will usually fail in production.
3. **No bundled Python/worker.** `tauri.conf.json` declares no `externalBin`
   sidecar — the host must already have `uv` + the Python env + `models/`.
4. **`async` commands block on sync I/O.** `check_health` / `prepare_system` are
   `async` but call blocking `std::process::Command`; a long `uv sync` starves the
   Tauri async pool.
5. **No guard against concurrent runs.** Calling `start_session` twice spawns a
   second run thread and a second `Store` handle on the same `batch.db`, and orphans
   the previous cancel flag.
6. **`outputDir == input`.** The GUI writes `batch.db` (and offers exports) into the
   same folder as the recordings; there is no separate output-dir control yet.
7. **Cancel is not a pause.** Cancellation stops after in-flight files; "resume" is
   re-running and skipping done files, not a true warm pause.
8. **Worker startup timeout (180 s) and `emit_raw` are not configurable** from the
   GUI/CLI; `emit_raw` is always `false`.
9. **Fonts load from Google Fonts** (`index.html`) — offline/air-gapped machines
   fall back to system fonts.

---

## See also

- [`architecture.md`](architecture.md) — conceptual overview, Mermaid diagrams, θ_A/θ_B semantics.
- `birdpipe/` + `scripts/ml_engine.py` — the ML pipeline the worker runs.
- [`../README.md`](../README.md) — project intro, pipeline summary, getting started.
