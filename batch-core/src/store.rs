//! SQLite-backed work queue + checkpoint. The DB IS the durable state.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

pub struct Store {
    pub conn: Connection,
}

/// Fields needed to create a session row.
pub struct NewSession<'a> {
    pub input_roots: &'a str, // JSON array string
    pub output_dir: &'a str,
    pub device: &'a str,
    pub concurrency: i64,
    pub theta_a: f64,
    pub theta_b: f64,
    pub species_name: Option<&'a str>,
    /// Stable serialization of every analysis-affecting option. Only an exact
    /// match may reuse completed file rows from this session.
    pub config_key: &'a str,
    pub worker_cmd: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub localizer_path: Option<&'a str>,
    pub classifier_path: Option<&'a str>,
    pub classifier_c_path: Option<&'a str>,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
}

/// A file claimed for processing.
pub struct Claimed {
    pub file_id: i64,
    pub path: String,
    pub attempts: i64,
}

/// Per-file success payload to persist (subset of a worker Result message).
pub struct RecordedResult<'a> {
    pub n_events: i64,
    pub n_complete: i64,
    pub n_retained: i64,
    pub elapsed_ms: i64,
    pub events: &'a [crate::protocol::EventRecord],
}

/// Aggregate counts for a session.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Summary {
    pub session_id: i64,
    pub status: String,
    pub total: i64,
    pub pending: i64,
    pub in_progress: i64,
    pub done: i64,
    pub failed: i64,
    pub n_events: i64,
    pub n_complete: i64,
    pub n_retained: i64,
}

/// A per-file status row for the GUI table.
#[derive(Debug, serde::Serialize)]
pub struct FileRow {
    pub path: String,
    pub status: String,
    pub n_events: i64,
    pub n_complete: i64,
    pub error: Option<String>,
}

/// Changes made while reconciling a resumed session with the current input scan.
#[derive(Debug, Default, PartialEq)]
pub struct FileSync {
    pub added: usize,
    pub requeued: usize,
    pub removed: usize,
}

/// A single event row with curation fields, for the review UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    pub human_completeness: Option<String>,
    pub completeness_source: Option<String>,
    pub retained: Option<bool>,
    pub n_members: i64,
    pub review_status: String,
    pub source: String,
    pub label: Option<String>,
    pub note: Option<String>,
    pub reviewed_at: Option<String>,
    pub stage_c_label: Option<String>,
    pub stage_c_score: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionEventRow {
    pub path: String,
    pub duration: f64,
    pub retained: bool,
}

/// Fields needed to log one reviewer action. `dwell_ms` is derived, not supplied.
pub struct NewReviewEvent<'a> {
    pub session_id: i64,
    pub event_id: Option<i64>,
    pub file_id: Option<i64>,
    pub action: &'a str,
    pub meta: Option<&'a str>,
}

/// Aggregate verification-effort stats for a session.
#[derive(Debug, serde::Serialize)]
pub struct ReviewTelemetrySummary {
    pub total_actions: i64,
    pub actions_by_type: BTreeMap<String, i64>,
    pub idle_cutoff_ms: i64,
    pub total_review_ms: i64,
    pub n_decisions: i64,
    pub distinct_events_decided: i64,
    pub mean_seconds_per_decision: f64,
    pub median_seconds_per_decision: f64,
}

/// A gap this long or longer is the reviewer being away, not reviewing.
pub const DEFAULT_IDLE_CUTOFF_MS: i64 = 120_000;

/// The actions that settle an event's `review_status`; everything else is navigation.
const DECISION_FILTER: &str = "action IN ('confirm','reject','reset')";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_roots TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  device TEXT NOT NULL,
  effective_device TEXT,
  concurrency INTEGER NOT NULL,
  theta_a REAL NOT NULL,
  theta_b REAL NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  initial_total_files INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  species_name TEXT DEFAULT 'Hume''s Leaf Warbler',
  config_key TEXT,
  worker_cmd TEXT,
  cwd TEXT,
  localizer_path TEXT,
  classifier_path TEXT,
  classifier_c_path TEXT,
  f_min_hz REAL,
  f_max_hz REAL
);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  n_events INTEGER NOT NULL DEFAULT 0,
  n_complete INTEGER NOT NULL DEFAULT 0,
  n_retained INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  modified_ns INTEGER,
  updated_at TEXT,
  UNIQUE(session_id, path)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  t_start REAL, t_end REAL, duration REAL,
  f_low REAL, f_high REAL, center_freq REAL,
  stage_a_conf REAL,
  completeness_score REAL,
  completeness_label TEXT,
  human_completeness TEXT,
  completeness_source TEXT,
  retained INTEGER,
  n_members INTEGER,
  stage_c_label TEXT,
  stage_c_score REAL
);
CREATE INDEX IF NOT EXISTS idx_files_session_status ON files(session_id, status);
CREATE INDEX IF NOT EXISTS idx_events_file ON events(file_id);
CREATE INDEX IF NOT EXISTS idx_events_session_label ON events(session_id, completeness_label, retained);
"#;

/// Idempotent migration: add curation and stage c columns to `events` and `sessions` if not already present.
fn ensure_curation_columns(conn: &Connection) -> rusqlite::Result<()> {
    let existing_events: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(events)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let event_columns: &[(&str, &str)] = &[
        ("review_status", "TEXT NOT NULL DEFAULT 'unreviewed'"),
        ("source",        "TEXT NOT NULL DEFAULT 'ml'"),
        ("label",         "TEXT"),
        ("note",          "TEXT"),
        ("reviewed_at",   "TEXT"),
        ("stage_c_label", "TEXT"),
        ("stage_c_score", "REAL"),
        ("human_completeness", "TEXT"),
        ("completeness_source", "TEXT"),
    ];
    for (col, def) in event_columns {
        if !existing_events.iter().any(|n| n == col) {
            conn.execute_batch(&format!("ALTER TABLE events ADD COLUMN {col} {def}"))?;
        }
    }

    let existing_sessions: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let session_columns: &[(&str, &str)] = &[
        ("species_name", "TEXT DEFAULT 'Hume''s Leaf Warbler'"),
        ("effective_device", "TEXT"),
        ("config_key", "TEXT"),
        ("worker_cmd", "TEXT"),
        ("cwd", "TEXT"),
        ("localizer_path", "TEXT"),
        ("classifier_path", "TEXT"),
        ("classifier_c_path", "TEXT"),
        ("f_min_hz", "REAL"),
        ("f_max_hz", "REAL"),
        ("initial_total_files", "INTEGER"),
    ];
    for (col, def) in session_columns {
        if !existing_sessions.iter().any(|n| n == col) {
            conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} {def}"))?;
        }
    }

    let existing_files: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(files)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (col, def) in [("size_bytes", "INTEGER"), ("modified_ns", "INTEGER")] {
        if !existing_files.iter().any(|n| n == col) {
            conn.execute_batch(&format!("ALTER TABLE files ADD COLUMN {col} {def}"))?;
        }
    }

    Ok(())
}

/// SQLite may reuse the largest deleted INTEGER PRIMARY KEY. Review telemetry
/// refers to event ids historically, so migrate old databases to AUTOINCREMENT
/// before any event can be deleted and restored under an old identity.
fn ensure_event_ids_never_reused(conn: &Connection) -> rusqlite::Result<()> {
    let create_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if create_sql
        .as_deref()
        .is_some_and(|sql| sql.to_ascii_uppercase().contains("AUTOINCREMENT"))
    {
        return Ok(());
    }

    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
CREATE TABLE events_no_reuse(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  t_start REAL, t_end REAL, duration REAL,
  f_low REAL, f_high REAL, center_freq REAL,
  stage_a_conf REAL,
  completeness_score REAL,
  completeness_label TEXT,
  human_completeness TEXT,
  completeness_source TEXT,
  retained INTEGER,
  n_members INTEGER,
  stage_c_label TEXT,
  stage_c_score REAL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  source TEXT NOT NULL DEFAULT 'ml',
  label TEXT,
  note TEXT,
  reviewed_at TEXT
);
INSERT INTO events_no_reuse(
  id, session_id, file_id, t_start, t_end, duration, f_low, f_high, center_freq,
  stage_a_conf, completeness_score, completeness_label, human_completeness,
  completeness_source, retained, n_members,
  stage_c_label, stage_c_score, review_status, source, label, note, reviewed_at
)
SELECT id, session_id, file_id, t_start, t_end, duration, f_low, f_high, center_freq,
       stage_a_conf, completeness_score, completeness_label, human_completeness,
       completeness_source, retained, n_members,
       stage_c_label, stage_c_score, review_status, source, label, note, reviewed_at
FROM events;
DROP TABLE events;
ALTER TABLE events_no_reuse RENAME TO events;
CREATE INDEX idx_events_file ON events(file_id);
CREATE INDEX idx_events_session_label ON events(session_id, completeness_label, retained);
COMMIT;
"#,
    )
}

/// File ids also appear in historical review telemetry. Prevent a pruned cache
/// row from lending its identity to an unrelated recording added later.
fn ensure_file_ids_never_reused(conn: &Connection) -> rusqlite::Result<()> {
    let create_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='files'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if create_sql
        .as_deref()
        .is_some_and(|sql| sql.to_ascii_uppercase().contains("AUTOINCREMENT"))
    {
        return Ok(());
    }

    conn.execute_batch(
        r#"
BEGIN IMMEDIATE;
CREATE TABLE files_no_reuse(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  n_events INTEGER NOT NULL DEFAULT 0,
  n_complete INTEGER NOT NULL DEFAULT 0,
  n_retained INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  modified_ns INTEGER,
  updated_at TEXT,
  UNIQUE(session_id, path)
);
INSERT INTO files_no_reuse(
  id, session_id, path, status, n_events, n_complete, n_retained,
  elapsed_ms, error, attempts, size_bytes, modified_ns, updated_at
)
SELECT id, session_id, path, status, n_events, n_complete, n_retained,
       elapsed_ms, error, attempts, size_bytes, modified_ns, updated_at
FROM files;
DROP TABLE files;
ALTER TABLE files_no_reuse RENAME TO files;
CREATE INDEX idx_files_session_status ON files(session_id, status);
COMMIT;
"#,
    )
}

/// Idempotent migration: add the run manifest column to `sessions` if not already present.
fn ensure_run_manifest_column(conn: &Connection) -> rusqlite::Result<()> {
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        names.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !existing.iter().any(|n| n == "run_manifest") {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN run_manifest TEXT")?;
    }
    Ok(())
}

/// Idempotent migration: add the review telemetry table if not already present.
fn ensure_review_telemetry(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS review_events(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  event_id INTEGER,
  file_id INTEGER,
  action TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  dwell_ms INTEGER,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_events_session ON review_events(session_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_review_events_event ON review_events(event_id);
"#,
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn file_identity(path: &Path) -> (Option<i64>, Option<i64>) {
    let Ok(metadata) = path.metadata() else {
        return (None, None);
    };
    let size_bytes = i64::try_from(metadata.len()).ok();
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64);
    (size_bytes, modified_ns)
}

fn median_of(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        ensure_curation_columns(&conn)?;
        ensure_file_ids_never_reused(&conn)?;
        ensure_event_ids_never_reused(&conn)?;
        ensure_run_manifest_column(&conn)?;
        ensure_review_telemetry(&conn)?;
        Ok(Store { conn })
    }

    pub fn open_memory() -> rusqlite::Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        ensure_curation_columns(&conn)?;
        ensure_file_ids_never_reused(&conn)?;
        ensure_event_ids_never_reused(&conn)?;
        ensure_run_manifest_column(&conn)?;
        ensure_review_telemetry(&conn)?;
        Ok(Store { conn })
    }

    pub fn create_session(&self, s: &NewSession) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO sessions(
                 input_roots, output_dir, device, concurrency, theta_a, theta_b, species_name,
                 config_key, worker_cmd, cwd, localizer_path, classifier_path,
                 classifier_c_path, f_min_hz, f_max_hz
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                s.input_roots,
                s.output_dir,
                s.device,
                s.concurrency,
                s.theta_a,
                s.theta_b,
                s.species_name.unwrap_or("Hume's Leaf Warbler"),
                s.config_key,
                s.worker_cmd,
                s.cwd,
                s.localizer_path,
                s.classifier_path,
                s.classifier_c_path,
                s.f_min_hz,
                s.f_max_hz,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Insert file rows (INSERT OR IGNORE for the UNIQUE(session_id,path)); return count inserted.
    pub fn add_files(&self, session_id: i64, paths: &[PathBuf]) -> rusqlite::Result<usize> {
        let mut inserted = 0usize;
        for p in paths {
            let n = self.conn.execute(
                "INSERT OR IGNORE INTO files(session_id, path) VALUES(?1, ?2)",
                params![session_id, p.to_string_lossy()],
            )?;
            inserted += n;
        }
        self.conn.execute(
            "UPDATE sessions
             SET total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1),
                 initial_total_files=CASE
                     WHEN status='running' THEN (SELECT COUNT(*) FROM files WHERE session_id=?1)
                     ELSE initial_total_files
                 END
             WHERE id=?1",
            params![session_id],
        )?;
        Ok(inserted)
    }

    /// Reconcile a complete input scan with an existing session.
    ///
    /// A same-path file whose size or modification time changed is put back in
    /// the queue and its now-stale detections are removed. Files no longer in
    /// the scan are removed from the session entirely. This is intentionally a
    /// separate operation from `add_files`, whose callers may add partial lists.
    pub fn sync_files(&self, session_id: i64, paths: &[PathBuf]) -> rusqlite::Result<FileSync> {
        let tx = self.conn.unchecked_transaction()?;
        let mut result = FileSync::default();
        let mut current_paths = HashSet::with_capacity(paths.len());

        for path in paths {
            let path_text = path.to_string_lossy().into_owned();
            current_paths.insert(path_text.clone());
            let (size_bytes, modified_ns) = file_identity(path);
            let existing: Option<(i64, Option<i64>, Option<i64>)> = tx
                .query_row(
                    "SELECT id, size_bytes, modified_ns FROM files WHERE session_id=?1 AND path=?2",
                    params![session_id, path_text],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            match existing {
                None => {
                    tx.execute(
                        "INSERT INTO files(session_id, path, size_bytes, modified_ns) VALUES(?1, ?2, ?3, ?4)",
                        params![session_id, path_text, size_bytes, modified_ns],
                    )?;
                    result.added += 1;
                }
                Some((file_id, old_size, old_modified))
                    if old_size != size_bytes || old_modified != modified_ns =>
                {
                    tx.execute("DELETE FROM events WHERE file_id=?1", params![file_id])?;
                    tx.execute(
                        "UPDATE files SET status='pending', n_events=0, n_complete=0, n_retained=0,
                             elapsed_ms=0, error=NULL, attempts=0, size_bytes=?2, modified_ns=?3,
                             updated_at=datetime('now') WHERE id=?1",
                        params![file_id, size_bytes, modified_ns],
                    )?;
                    result.requeued += 1;
                }
                Some(_) => {}
            }
        }

        let known: Vec<(i64, String)> = {
            let mut stmt = tx.prepare("SELECT id, path FROM files WHERE session_id=?1")?;
            let rows = stmt.query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (file_id, path) in known {
            if !current_paths.contains(&path) {
                tx.execute("DELETE FROM events WHERE file_id=?1", params![file_id])?;
                tx.execute("DELETE FROM files WHERE id=?1", params![file_id])?;
                result.removed += 1;
            }
        }

        tx.execute(
            "UPDATE sessions
             SET total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1),
                 initial_total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1)
             WHERE id=?1",
            params![session_id],
        )?;
        tx.commit()?;
        Ok(result)
    }

    /// Atomically claim the next pending file: set it in_progress, bump attempts, return it.
    pub fn claim_next_pending(&self, session_id: i64) -> rusqlite::Result<Option<Claimed>> {
        self.conn
            .query_row(
                "UPDATE files SET status='in_progress', attempts=attempts+1, updated_at=datetime('now')
                 WHERE id=(SELECT id FROM files WHERE session_id=?1 AND status='pending' ORDER BY id LIMIT 1)
                 RETURNING id, path, attempts",
                params![session_id],
                |row| {
                    Ok(Claimed {
                        file_id: row.get(0)?,
                        path: row.get(1)?,
                        attempts: row.get(2)?,
                    })
                },
            )
            .optional()
    }

    /// Put a file back to pending (e.g., worker crash/timeout, will be retried).
    pub fn requeue(&self, file_id: i64) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE files SET status='pending', updated_at=datetime('now') WHERE id=?1",
            params![file_id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// Terminally mark a file failed with an error message.
    pub fn mark_failed(&self, file_id: i64, error: &str) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE files SET status='failed', error=?2, updated_at=datetime('now') WHERE id=?1",
            params![file_id, error],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// On resume: any file left 'in_progress' from a previous run goes back to 'pending'.
    pub fn reset_in_progress(&self, session_id: i64) -> rusqlite::Result<usize> {
        let n = self.conn.execute(
            "UPDATE files SET status='pending' WHERE session_id=?1 AND status='in_progress'",
            params![session_id],
        )?;
        Ok(n)
    }

    /// A new invocation is an explicit retry opportunity for terminal file failures.
    pub fn reset_failed(&self, session_id: i64) -> rusqlite::Result<usize> {
        let n = self.conn.execute(
            "UPDATE files SET status='pending', attempts=0, error=NULL, updated_at=datetime('now')
             WHERE session_id=?1 AND status='failed'",
            params![session_id],
        )?;
        Ok(n)
    }

    /// Test/inspection helper.
    pub fn file_status(&self, file_id: i64) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT status FROM files WHERE id=?1", params![file_id], |r| r.get(0))
            .optional()
    }

    /// Persist a successful file: update the file row and insert its events.
    pub fn record_success(
        &mut self,
        session_id: i64,
        file_id: i64,
        r: &RecordedResult,
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE files SET status='done', n_events=?2, n_complete=?3, n_retained=?4,
                 elapsed_ms=?5, error=NULL, updated_at=datetime('now')
             WHERE id=?1 AND session_id=?6",
            params![file_id, r.n_events, r.n_complete, r.n_retained, r.elapsed_ms, session_id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        tx.execute("DELETE FROM events WHERE file_id=?1", params![file_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events(session_id, file_id, t_start, t_end, duration, f_low, f_high,
                     center_freq, stage_a_conf, completeness_score, completeness_label, retained, n_members,
                     stage_c_label, stage_c_score)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            )?;
            for e in r.events {
                stmt.execute(params![
                    session_id,
                    file_id,
                    e.t_start,
                    e.t_end,
                    e.duration,
                    e.f_low,
                    e.f_high,
                    e.center_freq,
                    e.stage_a_conf,
                    e.completeness_score,
                    e.completeness_label,
                    e.retained,
                    e.n_members,
                    e.stage_c_label,
                    e.stage_c_score,
                ])?;
            }
        }
        tx.commit()
    }

    /// Aggregate counts for a session.
    pub fn summary(&self, session_id: i64) -> rusqlite::Result<Summary> {
        let status: String = self.conn.query_row(
            "SELECT status FROM sessions WHERE id=?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let count = |status: &str| -> rusqlite::Result<i64> {
            self.conn.query_row(
                "SELECT COUNT(*) FROM files WHERE session_id=?1 AND status=?2",
                params![session_id, status],
                |r| r.get(0),
            )
        };
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM files WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let n_events: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id=?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let n_complete: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id=?1 AND completeness_label='complete'",
            params![session_id],
            |r| r.get(0),
        )?;
        let n_retained: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id=?1 AND retained=1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(Summary {
            session_id,
            status,
            total,
            pending: count("pending")?,
            in_progress: count("in_progress")?,
            done: count("done")?,
            failed: count("failed")?,
            n_events,
            n_complete,
            n_retained,
        })
    }

    /// Most-recent session for these roots and this exact analysis configuration.
    pub fn find_resumable(&self, input_roots: &str, config_key: &str, requested_device: &str) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM sessions
                 WHERE input_roots=?1 AND config_key=?2
                   AND (effective_device IS NULL OR effective_device=?3)
                 ORDER BY id DESC LIMIT 1",
                params![input_roots, config_key, requested_device],
                |r| r.get(0),
            )
            .optional()
    }

    /// All files for a session as status rows (ordered by id).
    pub fn list_files(&self, session_id: i64) -> rusqlite::Result<Vec<FileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, status, n_events, n_complete, error FROM files
             WHERE session_id=?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(FileRow {
                path: r.get(0)?,
                status: r.get(1)?,
                n_events: r.get(2)?,
                n_complete: r.get(3)?,
                error: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Return all events for a specific file within a session, ordered by t_start.
    pub fn list_events(&self, session_id: i64, path: &str) -> rusqlite::Result<Vec<EventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.id, e.file_id, e.t_start, e.t_end, e.duration, e.f_low, e.f_high,
                    e.center_freq, e.stage_a_conf, e.completeness_score, e.completeness_label,
                    e.human_completeness, e.completeness_source, e.retained, e.n_members,
                    e.review_status, e.source, e.label, e.note,
                    e.reviewed_at, e.stage_c_label, e.stage_c_score
             FROM events e
             WHERE e.file_id = (SELECT id FROM files WHERE session_id=?1 AND path=?2)
             ORDER BY e.t_start",
        )?;
        let rows = stmt.query_map(params![session_id, path], |r| {
            Ok(EventRow {
                id: r.get(0)?, file_id: r.get(1)?, t_start: r.get(2)?, t_end: r.get(3)?,
                duration: r.get(4)?, f_low: r.get(5)?, f_high: r.get(6)?, center_freq: r.get(7)?,
                stage_a_conf: r.get(8)?, completeness_score: r.get(9)?, completeness_label: r.get(10)?,
                human_completeness: r.get(11)?, completeness_source: r.get(12)?,
                retained: r.get::<_, Option<i64>>(13)?.map(|v| v != 0), n_members: r.get(14)?,
                review_status: r.get(15)?, source: r.get(16)?, label: r.get(17)?, note: r.get(18)?,
                reviewed_at: r.get(19)?, stage_c_label: r.get(20)?, stage_c_score: r.get(21)?,
            })
        })?;
        rows.collect()
    }

    /// Return all events for a session with joined file path, duration, and retained flag.
    pub fn list_events_all(&self, session_id: i64) -> rusqlite::Result<Vec<SessionEventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.path, e.duration, COALESCE(e.retained, 0)
             FROM events e
             JOIN files f ON e.file_id = f.id
             WHERE e.session_id = ?1 AND f.status = 'done'",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(SessionEventRow {
                path: r.get(0)?,
                duration: r.get(1)?,
                retained: r.get::<_, i64>(2)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn set_event_review(&self, event_id: i64, status: &str, label: Option<&str>, note: Option<&str>) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE events SET review_status=?2, label=?3, note=?4, reviewed_at=datetime('now') WHERE id=?1",
            params![event_id, status, label, note],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_event_bounds(&self, event_id: i64, t_start: f64, t_end: f64, f_low: f64, f_high: f64) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE events SET t_start=?2, t_end=?3, duration=(?3 - ?2),
                 f_low=?4, f_high=?5, center_freq=((?4 + ?5) / 2.0),
                 completeness_score=CASE WHEN source='manual' THEN NULL ELSE completeness_score END,
                 completeness_label=CASE
                   WHEN source='manual' AND completeness_source IN ('stage_b_accepted','unresolved') THEN NULL
                   ELSE completeness_label END,
                 completeness_source=CASE
                   WHEN source='manual' AND completeness_source='stage_b_accepted' THEN 'unresolved'
                   ELSE completeness_source END,
                 human_completeness=CASE
                   WHEN source='manual' AND completeness_source='stage_b_accepted' THEN 'unsure'
                   ELSE human_completeness END
             WHERE id=?1",
            params![event_id, t_start, t_end, f_low, f_high],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn add_manual_event(&self, session_id: i64, path: &str, t_start: f64, t_end: f64,
                            f_low: f64, f_high: f64, human_completeness: &str) -> rusqlite::Result<i64> {
        let (completeness_label, completeness_source) = match human_completeness {
            "complete" => (Some("complete"), "human"),
            "incomplete" => (Some("incomplete"), "human"),
            "unsure" => (None, "unresolved"),
            _ => return Err(rusqlite::Error::InvalidParameterName(
                "human_completeness must be complete, incomplete, or unsure".into())),
        };
        let file_id: i64 = self.conn.query_row(
            "SELECT id FROM files WHERE session_id=?1 AND path=?2",
            params![session_id, path], |r| r.get(0),
        )?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO events(session_id, file_id, t_start, t_end, duration, f_low, f_high, center_freq,
                 stage_a_conf, n_members, completeness_score, completeness_label,
                 human_completeness, completeness_source, retained, source, review_status)
             VALUES(?1,?2,?3,?4,(?4 - ?3),?5,?6,((?5 + ?6) / 2.0),0.0,0,NULL,?7,?8,?9,NULL,'manual','confirmed')",
            params![session_id, file_id, t_start, t_end, f_low, f_high,
                    completeness_label, human_completeness, completeness_source],
        )?;
        let event_id = tx.last_insert_rowid();
        Self::refresh_file_event_counts(&tx, file_id)?;
        tx.commit()?;
        Ok(event_id)
    }

    pub fn set_manual_completeness(
        &self, event_id: i64, human_completeness: &str,
        completeness_label: Option<&str>, completeness_source: &str,
        completeness_score: Option<f64>,
    ) -> rusqlite::Result<()> {
        if !matches!(human_completeness, "complete" | "incomplete" | "unsure") {
            return Err(rusqlite::Error::InvalidParameterName(
                "human_completeness must be complete, incomplete, or unsure".into()));
        }
        if completeness_label.is_some_and(|value| !matches!(value, "complete" | "incomplete")) {
            return Err(rusqlite::Error::InvalidParameterName(
                "completeness_label must be complete, incomplete, or null".into()));
        }
        if !matches!(completeness_source, "human" | "stage_b_accepted" | "unresolved") {
            return Err(rusqlite::Error::InvalidParameterName(
                "completeness_source must be human, stage_b_accepted, or unresolved".into()));
        }
        if completeness_score.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
            return Err(rusqlite::Error::InvalidParameterName(
                "completeness_score must be finite and between 0 and 1".into()));
        }
        let provenance_is_consistent = match completeness_source {
            "human" => completeness_label == Some(human_completeness)
                && human_completeness != "unsure",
            "stage_b_accepted" => human_completeness == "unsure"
                && completeness_label.is_some()
                && completeness_score.is_some(),
            "unresolved" => human_completeness == "unsure"
                && completeness_label.is_none(),
            _ => false,
        };
        if !provenance_is_consistent {
            return Err(rusqlite::Error::InvalidParameterName(
                "manual completeness decision, label, score, and source are inconsistent".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        let file_id: i64 = tx.query_row(
            "SELECT file_id FROM events WHERE id=?1 AND source='manual'",
            params![event_id], |row| row.get(0),
        )?;
        let changed = tx.execute(
            "UPDATE events SET human_completeness=?2, completeness_label=?3,
                 completeness_source=?4, completeness_score=?5 WHERE id=?1 AND source='manual'",
            params![event_id, human_completeness, completeness_label,
                    completeness_source, completeness_score],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Self::refresh_file_event_counts(&tx, file_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_event(&self, event_id: i64) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let file_id: i64 = tx.query_row(
            "SELECT file_id FROM events WHERE id=?1",
            params![event_id],
            |row| row.get(0),
        )?;
        let changed = tx.execute("DELETE FROM events WHERE id=?1", params![event_id])?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Self::refresh_file_event_counts(&tx, file_id)?;
        tx.commit()?;
        Ok(())
    }

    fn refresh_file_event_counts(conn: &Connection, file_id: i64) -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE files SET
                 n_events=(SELECT COUNT(*) FROM events WHERE file_id=?1),
                 n_complete=(SELECT COUNT(*) FROM events WHERE file_id=?1 AND completeness_label='complete'),
                 n_retained=(SELECT COUNT(*) FROM events WHERE file_id=?1 AND retained=1),
                 updated_at=datetime('now')
             WHERE id=?1",
            params![file_id],
        )?;
        Ok(())
    }

    /// Reinsert a deleted event without degrading an ML event into a manual one.
    ///
    /// The database assigns a fresh id because another edit may have reused the old
    /// row id while the event was on the undo stack. Every scientific and curation
    /// field is otherwise restored verbatim.
    pub fn restore_event(
        &self,
        session_id: i64,
        path: &str,
        event: &EventRow,
    ) -> rusqlite::Result<i64> {
        let file_id: i64 = self.conn.query_row(
            "SELECT id FROM files WHERE session_id=?1 AND path=?2",
            params![session_id, path],
            |r| r.get(0),
        )?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO events(
                 session_id, file_id, t_start, t_end, duration, f_low, f_high, center_freq,
                 stage_a_conf, completeness_score, completeness_label, human_completeness,
                 completeness_source, retained, n_members, review_status, source, label, note,
                 reviewed_at, stage_c_label, stage_c_score
             ) VALUES(
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
             )",
            params![
                session_id,
                file_id,
                event.t_start,
                event.t_end,
                event.duration,
                event.f_low,
                event.f_high,
                event.center_freq,
                event.stage_a_conf,
                event.completeness_score,
                event.completeness_label,
                event.human_completeness,
                event.completeness_source,
                event.retained,
                event.n_members,
                event.review_status,
                event.source,
                event.label,
                event.note,
                event.reviewed_at,
                event.stage_c_label,
                event.stage_c_score,
            ],
        )?;
        let event_id = tx.last_insert_rowid();
        Self::refresh_file_event_counts(&tx, file_id)?;
        tx.commit()?;
        Ok(event_id)
    }

    /// The (session_id, file_id) an event belongs to, for telemetry attribution.
    pub fn event_scope(&self, event_id: i64) -> rusqlite::Result<Option<(i64, i64)>> {
        self.conn
            .query_row(
                "SELECT session_id, file_id FROM events WHERE id=?1",
                params![event_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
    }

    /// Record one reviewer action, stamped with the wall-clock time of the call.
    pub fn log_review_event(&self, ev: &NewReviewEvent) -> rusqlite::Result<i64> {
        self.log_review_event_at(ev, now_ms())
    }

    /// Same as `log_review_event` with an explicit timestamp (tests, replay).
    pub fn log_review_event_at(&self, ev: &NewReviewEvent, at_ms: i64) -> rusqlite::Result<i64> {
        let prev_at_ms: Option<i64> = self
            .conn
            .query_row(
                "SELECT at_ms FROM review_events WHERE session_id=?1 ORDER BY at_ms DESC, id DESC LIMIT 1",
                params![ev.session_id],
                |r| r.get(0),
            )
            .optional()?;
        let dwell_ms = prev_at_ms.map(|prev| (at_ms - prev).max(0));
        self.conn.execute(
            "INSERT INTO review_events(session_id, event_id, file_id, action, at_ms, dwell_ms, meta)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![ev.session_id, ev.event_id, ev.file_id, ev.action, at_ms, dwell_ms, ev.meta],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Verification-effort stats for a session, using the default idle cutoff.
    pub fn review_telemetry_summary(&self, session_id: i64) -> rusqlite::Result<ReviewTelemetrySummary> {
        self.review_telemetry_summary_with_cutoff(session_id, DEFAULT_IDLE_CUTOFF_MS)
    }

    /// Dwells at or above `idle_cutoff_ms` are treated as time away and excluded
    /// from every duration statistic.
    pub fn review_telemetry_summary_with_cutoff(
        &self,
        session_id: i64,
        idle_cutoff_ms: i64,
    ) -> rusqlite::Result<ReviewTelemetrySummary> {
        let actions_by_type: BTreeMap<String, i64> = {
            let mut stmt = self.conn.prepare(
                "SELECT action, COUNT(*) FROM review_events WHERE session_id=?1 GROUP BY action ORDER BY action",
            )?;
            let rows = stmt.query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let total_actions: i64 = actions_by_type.values().sum();

        let total_review_ms: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(dwell_ms), 0) FROM review_events
             WHERE session_id=?1 AND dwell_ms IS NOT NULL AND dwell_ms < ?2",
            params![session_id, idle_cutoff_ms],
            |r| r.get(0),
        )?;

        let n_decisions: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM review_events WHERE session_id=?1 AND {DECISION_FILTER}"),
            params![session_id],
            |r| r.get(0),
        )?;
        let distinct_events_decided: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT event_id) FROM review_events
                 WHERE session_id=?1 AND event_id IS NOT NULL AND {DECISION_FILTER}"
            ),
            params![session_id],
            |r| r.get(0),
        )?;

        let decision_dwells: Vec<f64> = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT dwell_ms FROM review_events
                 WHERE session_id=?1 AND dwell_ms IS NOT NULL AND dwell_ms < ?2 AND {DECISION_FILTER}"
            ))?;
            let rows = stmt.query_map(params![session_id, idle_cutoff_ms], |r| {
                r.get::<_, i64>(0).map(|ms| ms as f64 / 1000.0)
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mean_seconds_per_decision = if decision_dwells.is_empty() {
            0.0
        } else {
            decision_dwells.iter().sum::<f64>() / decision_dwells.len() as f64
        };

        Ok(ReviewTelemetrySummary {
            total_actions,
            actions_by_type,
            idle_cutoff_ms,
            total_review_ms,
            n_decisions,
            distinct_events_decided,
            mean_seconds_per_decision,
            median_seconds_per_decision: median_of(decision_dwells),
        })
    }

    /// Record the provenance manifest the worker captured when it loaded the models.
    /// Write-once: workers respawn after a crash and a pool runs several of them, so
    /// the manifest of what the session actually started with must not be overwritten.
    /// Returns true when this call was the one that stored it.
    pub fn set_run_manifest(&self, session_id: i64, manifest_json: &str) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "UPDATE sessions SET run_manifest=?2 WHERE id=?1 AND run_manifest IS NULL",
            params![session_id, manifest_json],
        )?;
        Ok(n > 0)
    }

    /// The stored manifest JSON for a session, if one was captured.
    pub fn run_manifest(&self, session_id: i64) -> rusqlite::Result<Option<String>> {
        let row: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT run_manifest FROM sessions WHERE id=?1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(row.flatten())
    }

    pub fn set_session_status(&self, session_id: i64, status: &str) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE sessions SET status=?2 WHERE id=?1",
            params![session_id, status],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn set_session_effective_device(&self, session_id: i64, device: &str) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "UPDATE sessions SET effective_device=?2 WHERE id=?1",
            params![session_id, device],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// Return the raw `input_roots` JSON string stored for a session.
    pub fn session_input_roots(&self, session_id: i64) -> rusqlite::Result<String> {
        self.conn.query_row(
            "SELECT input_roots FROM sessions WHERE id=?1",
            params![session_id],
            |r| r.get(0),
        )
    }

    pub fn get_latest_session_id(&self) -> rusqlite::Result<Option<i64>> {
        self.conn.query_row(
            "SELECT id FROM sessions ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        ).optional()
    }

    pub fn delete_cached_files(&self, session_id: i64, paths: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let mut deleted = 0usize;
        for path in paths {
            // Get file_id to delete events
            let file_id: Option<i64> = tx.query_row(
                "SELECT id FROM files WHERE session_id=?1 AND path=?2",
                params![session_id, path],
                |r| r.get(0)
            ).optional()?;

            if let Some(id) = file_id {
                tx.execute("DELETE FROM events WHERE file_id=?1", params![id])?;
                deleted += tx.execute("DELETE FROM files WHERE id=?1", params![id])?;
            }
        }

        if deleted > 0 {
            // Once cached rows are removed, the previous terminal summary no longer
            // describes the original input inventory. The next explicit run will
            // reconcile the scan and set the session back to `running`.
            tx.execute(
                "UPDATE sessions
                 SET total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1),
                     status='invalidated'
                 WHERE id=?1",
                params![session_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Store {
        Store::open_memory().unwrap()
    }

    fn new_session(store: &Store) -> i64 {
        store
            .create_session(&NewSession {
                input_roots: "[\"/data\"]",
                output_dir: "/out",
                device: "cpu",
                concurrency: 2,
                theta_a: 0.0,
                theta_b: 0.53,
                species_name: None,
                config_key: "test", worker_cmd: None, cwd: None,
                localizer_path: None, classifier_path: None, classifier_c_path: None,
                f_min_hz: None, f_max_hz: None,
            })
            .unwrap()
    }

    #[test]
    fn add_files_dedupes() {
        let s = mem();
        let sid = new_session(&s);
        let a = PathBuf::from("/data/a.wav");
        let b = PathBuf::from("/data/b.wav");
        assert_eq!(s.add_files(sid, &[a.clone(), b.clone()]).unwrap(), 2);
        assert_eq!(s.add_files(sid, &[a.clone()]).unwrap(), 0); // duplicate ignored
    }

    #[test]
    fn claim_transitions_and_drains() {
        let s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav"), PathBuf::from("/data/b.wav")])
            .unwrap();
        let c1 = s.claim_next_pending(sid).unwrap().unwrap();
        assert_eq!(s.file_status(c1.file_id).unwrap().as_deref(), Some("in_progress"));
        assert_eq!(c1.attempts, 1);
        let c2 = s.claim_next_pending(sid).unwrap().unwrap();
        assert_ne!(c1.file_id, c2.file_id);
        assert!(s.claim_next_pending(sid).unwrap().is_none()); // drained
    }

    #[test]
    fn requeue_and_reset_in_progress() {
        let s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        s.requeue(c.file_id).unwrap();
        assert_eq!(s.file_status(c.file_id).unwrap().as_deref(), Some("pending"));
        let c2 = s.claim_next_pending(sid).unwrap().unwrap();
        assert_eq!(s.file_status(c2.file_id).unwrap().as_deref(), Some("in_progress"));
        assert_eq!(s.reset_in_progress(sid).unwrap(), 1);
        assert_eq!(s.file_status(c2.file_id).unwrap().as_deref(), Some("pending"));
    }

    #[test]
    fn mark_failed_sets_status_and_error() {
        let s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        s.mark_failed(c.file_id, "boom").unwrap();
        assert_eq!(s.file_status(c.file_id).unwrap().as_deref(), Some("failed"));
    }

    #[test]
    fn record_success_persists_file_and_events() {
        use crate::protocol::EventRecord;
        let mut s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        let events = vec![
            EventRecord {
                t_start: 1.0, t_end: 2.5, duration: 1.5, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.9, completeness_score: Some(0.8),
                completeness_label: Some("complete".into()), retained: Some(true), n_members: 3,
                stage_c_label: Some("buzzing_warbler".into()),
                stage_c_score: Some(0.95),
                ..Default::default()
            },
            EventRecord {
                t_start: 3.0, t_end: 3.4, duration: 0.4, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.5, completeness_score: Some(0.2),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1,
                ..Default::default()
            },
        ];
        s.record_success(
            sid, c.file_id,
            &RecordedResult { n_events: 2, n_complete: 1, n_retained: 1, elapsed_ms: 42, events: &events },
        ).unwrap();
        assert_eq!(s.file_status(c.file_id).unwrap().as_deref(), Some("done"));
        let evs = s.list_events(sid, "/data/a.wav").unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].stage_c_label.as_deref(), Some("buzzing_warbler"));
        assert_eq!(evs[0].stage_c_score, Some(0.95));
        assert_eq!(evs[1].stage_c_label, None);
        assert_eq!(evs[1].stage_c_score, None);
        let sum = s.summary(sid).unwrap();
        assert_eq!(sum.done, 1);
        assert_eq!(sum.n_events, 2);
        assert_eq!(sum.n_complete, 1);
        assert_eq!(sum.n_retained, 1);
    }

    #[test]
    fn summary_counts_statuses() {
        let s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav"), PathBuf::from("/data/b.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        s.mark_failed(c.file_id, "x").unwrap();
        let sum = s.summary(sid).unwrap();
        assert_eq!(sum.total, 2);
        assert_eq!(sum.failed, 1);
        assert_eq!(sum.pending, 1);
        assert_eq!(sum.session_id, sid);
        assert_eq!(sum.status, "running");
    }

    #[test]
    fn find_resumable_matches_latest_session_for_roots() {
        let s = mem();
        let sid = new_session(&s); // input_roots = "[\"/data\"]"
        assert_eq!(s.find_resumable("[\"/data\"]", "test", "cpu").unwrap(), Some(sid));
        // still resumable even after being marked done (run skips already-done files)
        s.set_session_status(sid, "done").unwrap();
        assert_eq!(s.find_resumable("[\"/data\"]", "test", "cpu").unwrap(), Some(sid));
        assert_eq!(s.find_resumable("[\"/data\"]", "changed", "cpu").unwrap(), None);
        // a different root has no session
        assert_eq!(s.find_resumable("[\"/other\"]", "test", "cpu").unwrap(), None);
        s.set_session_effective_device(sid, "cpu").unwrap();
        assert_eq!(s.find_resumable("[\"/data\"]", "test", "cuda").unwrap(), None);
    }

    #[test]
    fn session_input_roots_returns_stored_json() {
        let s = mem();
        let sid = new_session(&s); // inserts input_roots = "[\"/data\"]"
        let roots_json = s.session_input_roots(sid).unwrap();
        assert_eq!(roots_json, "[\"/data\"]");
    }

    #[test]
    fn list_files_returns_status_rows() {
        let s = mem();
        let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/a.wav"), PathBuf::from("/data/b.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        s.mark_failed(c.file_id, "boom").unwrap();
        let rows = s.list_files(sid).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.status == "failed" && r.error.as_deref() == Some("boom")));
        assert!(rows.iter().any(|r| r.status == "pending"));
    }

    #[test]
    fn test_granular_cache_deletion() {
        let store = Store::open_memory().unwrap();
        let sid = store.create_session(&NewSession {
            input_roots: "[]", output_dir: "out", device: "cpu", concurrency: 1, theta_a: 0.1, theta_b: 0.5, species_name: None,
            config_key: "test", worker_cmd: None, cwd: None, localizer_path: None,
            classifier_path: None, classifier_c_path: None, f_min_hz: None, f_max_hz: None,
        }).unwrap();
        store.add_files(sid, &[PathBuf::from("a.wav"), PathBuf::from("b.wav")]).unwrap();

        // Mock some events
        store.conn.execute(
            "INSERT INTO events(session_id, file_id, completeness_label) VALUES(?1, 1, 'full'), (?1, 2, 'full')",
            params![sid],
        ).unwrap();

        // Get latest session (should be sid)
        let latest_sid = store.get_latest_session_id().unwrap().unwrap();
        assert_eq!(latest_sid, sid);

        store
            .delete_cached_files(sid, &["missing.wav".to_string()])
            .unwrap();
        assert_eq!(store.summary(sid).unwrap().status, "running");

        // Delete only file 1
        store.delete_cached_files(sid, &["a.wav".to_string()]).unwrap();

        // Verify file 1 and its events are gone, but file 2 remains
        let files = store.list_files(sid).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "b.wav");
        assert_eq!(store.summary(sid).unwrap().status, "invalidated");

        let event_count: i64 = store.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(event_count, 1);

        store.add_files(sid, &[PathBuf::from("c.wav")]).unwrap();
        let new_file_id: i64 = store.conn.query_row(
            "SELECT id FROM files WHERE session_id=?1 AND path='c.wav'",
            params![sid],
            |row| row.get(0),
        ).unwrap();
        assert!(new_file_id > 2, "a deleted file id must never identify a later recording");
    }

    fn make_events_for_file(store: &mut Store, sid: i64) -> i64 {
        use crate::protocol::EventRecord;
        store.add_files(sid, &[PathBuf::from("/data/x.wav")]).unwrap();
        let c = store.claim_next_pending(sid).unwrap().unwrap();
        let evs = vec![
            EventRecord { t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 4000.0, f_high: 8000.0,
                center_freq: 6000.0, stage_a_conf: 0.9, completeness_score: Some(0.7),
                completeness_label: Some("complete".into()), retained: Some(true), n_members: 2, ..Default::default() },
            EventRecord { t_start: 3.0, t_end: 3.5, duration: 0.5, f_low: 4000.0, f_high: 8000.0,
                center_freq: 6000.0, stage_a_conf: 0.6, completeness_score: Some(0.3),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1, ..Default::default() },
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
        let session_columns: Vec<String> = {
            let mut stmt = s.conn.prepare("PRAGMA table_info(sessions)").unwrap();
            stmt.query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        assert!(session_columns.contains(&"initial_total_files".to_string()));
    }

    #[test]
    fn legacy_primary_keys_migrate_to_non_reusable_file_and_event_ids() {
        let path = std::env::temp_dir().join(format!(
            "bird_audio_legacy_ids_{}_{}.db",
            std::process::id(),
            now_ms(),
        ));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&SCHEMA.replace("PRIMARY KEY AUTOINCREMENT", "PRIMARY KEY"))
            .unwrap();
        conn.execute(
            "INSERT INTO sessions(id, input_roots, output_dir, device, concurrency, theta_a, theta_b)
             VALUES(1, '[]', '/out', 'cpu', 1, 0, 0.5)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files(id, session_id, path) VALUES(7, 1, 'old.wav')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO events(id, session_id, file_id) VALUES(9, 1, 7)",
            [],
        ).unwrap();
        drop(conn);

        let store = Store::open(&path).unwrap();
        store.delete_cached_files(1, &["old.wav".into()]).unwrap();
        store.add_files(1, &[PathBuf::from("new.wav")]).unwrap();
        let file_id: i64 = store.conn.query_row(
            "SELECT id FROM files WHERE path='new.wav'", [], |row| row.get(0),
        ).unwrap();
        assert!(file_id > 7);
        let event_id = store.add_manual_event(
            1, "new.wav", 0.0, 1.0, 1.0, 2.0, "complete",
        ).unwrap();
        assert!(event_id > 9);
        drop(store);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn run_manifest_migration_is_idempotent() {
        let s = mem();
        ensure_run_manifest_column(&s.conn).unwrap();
        ensure_run_manifest_column(&s.conn).unwrap();
        let cols: Vec<String> = {
            let mut stmt = s.conn.prepare("PRAGMA table_info(sessions)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(cols.iter().filter(|n| *n == "run_manifest").count(), 1);
    }

    #[test]
    fn set_run_manifest_stores_json_verbatim() {
        let s = mem();
        let sid = new_session(&s);
        assert_eq!(s.run_manifest(sid).unwrap(), None);
        let manifest = serde_json::json!({
            "schema_version": 1,
            "models": {"localizer": {"sha256": "abc", "bytes": 10}},
            "constants": {"F_MIN_HZ": 3000.0},
        });
        let text = serde_json::to_string(&manifest).unwrap();
        assert!(s.set_run_manifest(sid, &text).unwrap());
        let stored = s.run_manifest(sid).unwrap().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn set_run_manifest_is_write_once() {
        let s = mem();
        let sid = new_session(&s);
        assert!(s.set_run_manifest(sid, r#"{"first":true}"#).unwrap());
        assert!(!s.set_run_manifest(sid, r#"{"second":true}"#).unwrap());
        assert_eq!(s.run_manifest(sid).unwrap().as_deref(), Some(r#"{"first":true}"#));
    }

    #[test]
    fn run_manifest_is_per_session() {
        let s = mem();
        let a = new_session(&s);
        let b = s.create_session(&NewSession {
            input_roots: "[\"/other\"]", output_dir: "/out", device: "cpu",
            concurrency: 1, theta_a: 0.0, theta_b: 0.53, species_name: None,
            config_key: "other", worker_cmd: None, cwd: None, localizer_path: None,
            classifier_path: None, classifier_c_path: None, f_min_hz: None, f_max_hz: None,
        }).unwrap();
        s.set_run_manifest(a, r#"{"a":1}"#).unwrap();
        assert_eq!(s.run_manifest(b).unwrap(), None);
        assert!(s.set_run_manifest(b, r#"{"b":2}"#).unwrap());
        assert_eq!(s.run_manifest(a).unwrap().as_deref(), Some(r#"{"a":1}"#));
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
        let new_id = s.add_manual_event(
            sid, "/data/m.wav", 0.5, 1.5, 2000.0, 6000.0, "complete",
        ).unwrap();
        let row = s.list_events(sid, "/data/m.wav").unwrap().into_iter().find(|r| r.id == new_id).unwrap();
        assert_eq!(row.source, "manual");
        assert_eq!(row.review_status, "confirmed");
        assert_eq!(row.human_completeness.as_deref(), Some("complete"));
        assert_eq!(row.completeness_source.as_deref(), Some("human"));
        assert_eq!(row.completeness_label.as_deref(), Some("complete"));
        assert!((row.center_freq - 4000.0).abs() < 1e-9);
    }

    #[test]
    fn unsure_manual_event_stays_unresolved_until_a_decision() {
        let s = mem(); let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/m.wav")]).unwrap();
        let event_id = s.add_manual_event(
            sid, "/data/m.wav", 0.5, 1.5, 2000.0, 6000.0, "unsure",
        ).unwrap();
        let unresolved = s.list_events(sid, "/data/m.wav").unwrap().into_iter()
            .find(|row| row.id == event_id).unwrap();
        assert_eq!(unresolved.human_completeness.as_deref(), Some("unsure"));
        assert_eq!(unresolved.completeness_source.as_deref(), Some("unresolved"));
        assert_eq!(unresolved.completeness_label, None);
        assert_eq!(unresolved.completeness_score, None);

        s.set_manual_completeness(
            event_id, "unsure", Some("complete"), "stage_b_accepted", Some(0.91),
        ).unwrap();
        let accepted = s.list_events(sid, "/data/m.wav").unwrap().into_iter()
            .find(|row| row.id == event_id).unwrap();
        assert_eq!(accepted.completeness_source.as_deref(), Some("stage_b_accepted"));
        assert_eq!(accepted.completeness_label.as_deref(), Some("complete"));
        assert_eq!(accepted.completeness_score, Some(0.91));
    }

    #[test]
    fn changing_manual_bounds_invalidates_an_accepted_stage_b_result() {
        let s = mem(); let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/m.wav")]).unwrap();
        let event_id = s.add_manual_event(
            sid, "/data/m.wav", 0.5, 1.5, 2000.0, 6000.0, "unsure",
        ).unwrap();
        s.set_manual_completeness(
            event_id, "unsure", Some("complete"), "stage_b_accepted", Some(0.91),
        ).unwrap();

        s.update_event_bounds(event_id, 0.4, 1.7, 1800.0, 6400.0).unwrap();
        let changed = s.list_events(sid, "/data/m.wav").unwrap().into_iter()
            .find(|row| row.id == event_id).unwrap();
        assert_eq!(changed.human_completeness.as_deref(), Some("unsure"));
        assert_eq!(changed.completeness_source.as_deref(), Some("unresolved"));
        assert_eq!(changed.completeness_label, None);
        assert_eq!(changed.completeness_score, None);
    }

    #[test]
    fn manual_completeness_rejects_inconsistent_provenance() {
        let s = mem(); let sid = new_session(&s);
        s.add_files(sid, &[PathBuf::from("/data/m.wav")]).unwrap();
        let event_id = s.add_manual_event(
            sid, "/data/m.wav", 0.5, 1.5, 2000.0, 6000.0, "unsure",
        ).unwrap();

        assert!(s.set_manual_completeness(
            event_id, "unsure", Some("complete"), "human", Some(0.9),
        ).is_err());
        assert!(s.set_manual_completeness(
            event_id, "unsure", Some("complete"), "stage_b_accepted", None,
        ).is_err());
        assert!(s.set_manual_completeness(
            event_id, "unsure", Some("complete"), "unresolved", Some(0.9),
        ).is_err());
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

    #[test]
    fn restore_event_preserves_scientific_and_curation_fields() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let original_id = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        s.set_event_review(original_id, "confirmed", Some("buzz"), Some("clear")).unwrap();
        let original = s.list_events(sid, "/data/x.wav").unwrap()
            .into_iter().find(|r| r.id == original_id).unwrap();

        s.delete_event(original_id).unwrap();
        let restored_id = s.restore_event(sid, "/data/x.wav", &original).unwrap();
        let restored = s.list_events(sid, "/data/x.wav").unwrap()
            .into_iter().find(|r| r.id == restored_id).unwrap();

        assert_eq!(restored.source, original.source);
        assert_eq!(restored.review_status, original.review_status);
        assert_eq!(restored.label, original.label);
        assert_eq!(restored.note, original.note);
        assert_eq!(restored.reviewed_at, original.reviewed_at);
        assert_eq!(restored.stage_a_conf, original.stage_a_conf);
        assert_eq!(restored.completeness_score, original.completeness_score);
        assert_eq!(restored.completeness_label, original.completeness_label);
        assert_eq!(restored.human_completeness, original.human_completeness);
        assert_eq!(restored.completeness_source, original.completeness_source);
        assert_eq!(restored.retained, original.retained);
        assert_eq!(restored.stage_c_label, original.stage_c_label);
        assert_eq!(restored.stage_c_score, original.stage_c_score);
        assert!(restored_id > original_id, "a restored event must receive a never-before-used id");

        let counts: (i64, i64, i64) = s.conn.query_row(
            "SELECT n_events, n_complete, n_retained FROM files WHERE id=?1",
            params![restored.file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(counts, (2, 1, 1));
    }

    #[test]
    fn stale_event_mutations_fail_instead_of_claiming_success() {
        let mut s = mem(); let sid = new_session(&s); make_events_for_file(&mut s, sid);
        let event_id = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        s.delete_event(event_id).unwrap();
        assert_eq!(
            s.set_event_review(event_id, "confirmed", None, None).unwrap_err(),
            rusqlite::Error::QueryReturnedNoRows,
        );
        assert_eq!(
            s.update_event_bounds(event_id, 0.0, 1.0, 1000.0, 2000.0).unwrap_err(),
            rusqlite::Error::QueryReturnedNoRows,
        );
        assert_eq!(
            s.delete_event(event_id).unwrap_err(),
            rusqlite::Error::QueryReturnedNoRows,
        );
    }

    #[test]
    fn sync_files_requeues_changed_audio_and_prunes_removed_audio() {
        use std::fs::{self, File};
        use std::io::Write;

        let mut s = mem();
        let sid = new_session(&s);
        let path = std::env::temp_dir().join(format!(
            "bird-audio-sync-{}-{}.wav",
            std::process::id(),
            now_ms(),
        ));
        File::create(&path).unwrap().write_all(b"first").unwrap();
        assert_eq!(s.sync_files(sid, std::slice::from_ref(&path)).unwrap(), FileSync {
            added: 1,
            requeued: 0,
            removed: 0,
        });

        let claimed = s.claim_next_pending(sid).unwrap().unwrap();
        let event = crate::protocol::EventRecord {
            t_start: 0.0,
            t_end: 1.0,
            duration: 1.0,
            retained: Some(true),
            completeness_label: Some("complete".into()),
            ..Default::default()
        };
        s.record_success(
            sid,
            claimed.file_id,
            &RecordedResult {
                n_events: 1,
                n_complete: 1,
                n_retained: 1,
                elapsed_ms: 1,
                events: &[event],
            },
        ).unwrap();

        File::create(&path).unwrap().write_all(b"changed-length").unwrap();
        assert_eq!(s.sync_files(sid, std::slice::from_ref(&path)).unwrap().requeued, 1);
        assert_eq!(s.file_status(claimed.file_id).unwrap().as_deref(), Some("pending"));
        assert!(s.list_events(sid, &path.to_string_lossy()).unwrap().is_empty());

        assert_eq!(s.sync_files(sid, &[]).unwrap().removed, 1);
        assert!(s.list_files(sid).unwrap().is_empty());
        fs::remove_file(path).unwrap();
    }

    fn log_at(s: &Store, sid: i64, action: &str, event_id: Option<i64>, at_ms: i64) {
        s.log_review_event_at(
            &NewReviewEvent { session_id: sid, event_id, file_id: None, action, meta: None },
            at_ms,
        )
        .unwrap();
    }

    #[test]
    fn review_telemetry_migration_is_idempotent() {
        let s = mem();
        ensure_review_telemetry(&s.conn).unwrap();
        ensure_review_telemetry(&s.conn).unwrap();
        let cols: Vec<String> = {
            let mut stmt = s.conn.prepare("PRAGMA table_info(review_events)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        for col in &["id", "session_id", "event_id", "file_id", "action", "at_ms", "dwell_ms", "meta"] {
            assert!(cols.contains(&col.to_string()), "missing column: {col}");
        }
        // A row logged before the re-run survives it.
        let sid = new_session(&s);
        log_at(&s, sid, "play", None, 1_000);
        ensure_review_telemetry(&s.conn).unwrap();
        let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM review_events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn dwell_ms_is_null_on_first_row_then_gap_to_previous() {
        let s = mem();
        let sid = new_session(&s);
        log_at(&s, sid, "open_file", None, 10_000);
        log_at(&s, sid, "play", None, 12_500);
        log_at(&s, sid, "confirm", Some(7), 15_000);
        let dwells: Vec<Option<i64>> = {
            let mut stmt = s.conn.prepare("SELECT dwell_ms FROM review_events ORDER BY id").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(dwells, vec![None, Some(2_500), Some(2_500)]);
    }

    #[test]
    fn dwell_ms_is_per_session() {
        let s = mem();
        let a = new_session(&s);
        let b = s.create_session(&NewSession {
            input_roots: "[\"/other\"]", output_dir: "/out", device: "cpu",
            concurrency: 1, theta_a: 0.0, theta_b: 0.53, species_name: None,
            config_key: "other", worker_cmd: None, cwd: None, localizer_path: None,
            classifier_path: None, classifier_c_path: None, f_min_hz: None, f_max_hz: None,
        }).unwrap();
        log_at(&s, a, "play", None, 1_000);
        log_at(&s, b, "play", None, 9_000);
        let dwell_b: Option<i64> = s.conn.query_row(
            "SELECT dwell_ms FROM review_events WHERE session_id=?1", params![b], |r| r.get(0)).unwrap();
        assert_eq!(dwell_b, None);
    }

    #[test]
    fn idle_cutoff_excludes_long_gaps_from_review_time() {
        let s = mem();
        let sid = new_session(&s);
        log_at(&s, sid, "open_file", None, 0);
        log_at(&s, sid, "confirm", Some(1), 4_000);
        // reviewer walks away for an hour, then decides again
        log_at(&s, sid, "confirm", Some(2), 3_604_000);
        log_at(&s, sid, "reject", Some(3), 3_610_000);

        let sum = s.review_telemetry_summary(sid).unwrap();
        assert_eq!(sum.total_actions, 4);
        assert_eq!(sum.actions_by_type.get("confirm"), Some(&2));
        assert_eq!(sum.actions_by_type.get("open_file"), Some(&1));
        assert_eq!(sum.idle_cutoff_ms, DEFAULT_IDLE_CUTOFF_MS);
        assert_eq!(sum.total_review_ms, 10_000); // 4s + 6s, the 1h gap dropped
        assert_eq!(sum.n_decisions, 3);
        assert_eq!(sum.distinct_events_decided, 3);
        assert!((sum.mean_seconds_per_decision - 5.0).abs() < 1e-9); // (4 + 6) / 2
        assert!((sum.median_seconds_per_decision - 5.0).abs() < 1e-9);

        // A cutoff above the gap counts it as review time.
        let wide = s.review_telemetry_summary_with_cutoff(sid, 7_200_000).unwrap();
        assert_eq!(wide.total_review_ms, 3_610_000);
    }

    #[test]
    fn review_telemetry_summary_is_empty_for_untouched_session() {
        let s = mem();
        let sid = new_session(&s);
        let sum = s.review_telemetry_summary(sid).unwrap();
        assert_eq!(sum.total_actions, 0);
        assert_eq!(sum.total_review_ms, 0);
        assert_eq!(sum.distinct_events_decided, 0);
        assert_eq!(sum.mean_seconds_per_decision, 0.0);
        assert_eq!(sum.median_seconds_per_decision, 0.0);
    }

    #[test]
    fn event_scope_resolves_session_and_file() {
        let mut s = mem();
        let sid = new_session(&s);
        let file_id = make_events_for_file(&mut s, sid);
        let eid = s.list_events(sid, "/data/x.wav").unwrap()[0].id;
        assert_eq!(s.event_scope(eid).unwrap(), Some((sid, file_id)));
        assert_eq!(s.event_scope(999_999).unwrap(), None);
    }

    #[test]
    fn test_migration_includes_stage_c_columns() {
        let store = Store::open_memory().unwrap();
        let mut stmt = store.conn.prepare("PRAGMA table_info(events)").unwrap();
        let cols: Vec<String> = stmt.query_map([], |r| r.get(1)).unwrap().map(|x| x.unwrap()).collect();
        assert!(cols.contains(&"stage_c_label".to_string()));
        assert!(cols.contains(&"stage_c_score".to_string()));

        let mut stmt = store.conn.prepare("PRAGMA table_info(sessions)").unwrap();
        let cols: Vec<String> = stmt.query_map([], |r| r.get(1)).unwrap().map(|x| x.unwrap()).collect();
        assert!(cols.contains(&"species_name".to_string()));

        // Assert that when a new session is created with species_name: None,
        // retrieving it returns the default "Hume's Leaf Warbler".
        let sid = store.create_session(&NewSession {
            input_roots: "[]",
            output_dir: "out",
            device: "cpu",
            concurrency: 1,
            theta_a: 0.1,
            theta_b: 0.5,
            species_name: None,
            config_key: "test", worker_cmd: None, cwd: None,
            localizer_path: None, classifier_path: None, classifier_c_path: None,
            f_min_hz: None, f_max_hz: None,
        }).unwrap();
        let species: String = store.conn.query_row(
            "SELECT species_name FROM sessions WHERE id = ?1",
            params![sid],
            |r| r.get(0)
        ).unwrap();
        assert_eq!(species, "Hume's Leaf Warbler");
    }
}
