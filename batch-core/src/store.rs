//! SQLite-backed work queue + checkpoint. The DB IS the durable state.

use std::path::{Path, PathBuf};

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
    pub stage_c_label: Option<String>,
    pub stage_c_score: Option<f64>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  input_roots TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  device TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  theta_a REAL NOT NULL,
  theta_b REAL NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  species_name TEXT DEFAULT 'Hume''s Leaf Warbler'
);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  n_events INTEGER NOT NULL DEFAULT 0,
  n_complete INTEGER NOT NULL DEFAULT 0,
  n_retained INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  UNIQUE(session_id, path)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  t_start REAL, t_end REAL, duration REAL,
  f_low REAL, f_high REAL, center_freq REAL,
  stage_a_conf REAL,
  completeness_score REAL,
  completeness_label TEXT,
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
    ];
    for (col, def) in session_columns {
        if !existing_sessions.iter().any(|n| n == col) {
            conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} {def}"))?;
        }
    }

    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        ensure_curation_columns(&conn)?;
        Ok(Store { conn })
    }

    pub fn open_memory() -> rusqlite::Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        ensure_curation_columns(&conn)?;
        Ok(Store { conn })
    }

    pub fn create_session(&self, s: &NewSession) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO sessions(input_roots, output_dir, device, concurrency, theta_a, theta_b, species_name)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                s.input_roots,
                s.output_dir,
                s.device,
                s.concurrency,
                s.theta_a,
                s.theta_b,
                s.species_name.unwrap_or("Hume's Leaf Warbler")
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
            "UPDATE sessions SET total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1) WHERE id=?1",
            params![session_id],
        )?;
        Ok(inserted)
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
        self.conn.execute(
            "UPDATE files SET status='pending', updated_at=datetime('now') WHERE id=?1",
            params![file_id],
        )?;
        Ok(())
    }

    /// Terminally mark a file failed with an error message.
    pub fn mark_failed(&self, file_id: i64, error: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE files SET status='failed', error=?2, updated_at=datetime('now') WHERE id=?1",
            params![file_id, error],
        )?;
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
        tx.execute(
            "UPDATE files SET status='done', n_events=?2, n_complete=?3, n_retained=?4,
                 elapsed_ms=?5, error=NULL, updated_at=datetime('now') WHERE id=?1",
            params![file_id, r.n_events, r.n_complete, r.n_retained, r.elapsed_ms],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events(session_id, file_id, t_start, t_end, duration, f_low, f_high,
                     center_freq, stage_a_conf, completeness_score, completeness_label, retained, n_members)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
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
                ])?;
            }
        }
        tx.commit()
    }

    /// Aggregate counts for a session.
    pub fn summary(&self, session_id: i64) -> rusqlite::Result<Summary> {
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

    /// Most-recent session for these roots (resume target; done files are skipped on run).
    pub fn find_resumable(&self, input_roots: &str) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM sessions WHERE input_roots=?1 ORDER BY id DESC LIMIT 1",
                params![input_roots],
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
                    e.retained, e.n_members, e.review_status, e.source, e.label, e.note,
                    e.stage_c_label, e.stage_c_score
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
                stage_c_label: r.get(17)?, stage_c_score: r.get(18)?,
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

    pub fn set_session_status(&self, session_id: i64, status: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET status=?2 WHERE id=?1",
            params![session_id, status],
        )?;
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
            "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        ).optional()
    }

    pub fn delete_cached_files(&self, session_id: i64, paths: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for path in paths {
            // Get file_id to delete events
            let file_id: Option<i64> = tx.query_row(
                "SELECT id FROM files WHERE session_id=?1 AND path=?2",
                params![session_id, path],
                |r| r.get(0)
            ).optional()?;

            if let Some(id) = file_id {
                tx.execute("DELETE FROM events WHERE file_id=?1", params![id])?;
                tx.execute("DELETE FROM files WHERE id=?1", params![id])?;
            }
        }
        
        // Update session total
        tx.execute(
            "UPDATE sessions SET total_files=(SELECT COUNT(*) FROM files WHERE session_id=?1) WHERE id=?1",
            params![session_id],
        )?;
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
            },
            EventRecord {
                t_start: 3.0, t_end: 3.4, duration: 0.4, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.5, completeness_score: Some(0.2),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1,
            },
        ];
        s.record_success(
            sid, c.file_id,
            &RecordedResult { n_events: 2, n_complete: 1, n_retained: 1, elapsed_ms: 42, events: &events },
        ).unwrap();
        assert_eq!(s.file_status(c.file_id).unwrap().as_deref(), Some("done"));
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
    }

    #[test]
    fn find_resumable_matches_latest_session_for_roots() {
        let s = mem();
        let sid = new_session(&s); // input_roots = "[\"/data\"]"
        assert_eq!(s.find_resumable("[\"/data\"]").unwrap(), Some(sid));
        // still resumable even after being marked done (run skips already-done files)
        s.set_session_status(sid, "done").unwrap();
        assert_eq!(s.find_resumable("[\"/data\"]").unwrap(), Some(sid));
        // a different root has no session
        assert_eq!(s.find_resumable("[\"/other\"]").unwrap(), None);
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
            input_roots: "[]", output_dir: "out", device: "cpu", concurrency: 1, theta_a: 0.1, theta_b: 0.5, species_name: None
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

        // Delete only file 1
        store.delete_cached_files(sid, &["a.wav".to_string()]).unwrap();

        // Verify file 1 and its events are gone, but file 2 remains
        let files = store.list_files(sid).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "b.wav");

        let event_count: i64 = store.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(event_count, 1);
    }

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
        }).unwrap();
        let species: String = store.conn.query_row(
            "SELECT species_name FROM sessions WHERE id = ?1",
            params![sid],
            |r| r.get(0)
        ).unwrap();
        assert_eq!(species, "Hume's Leaf Warbler");
    }
}
