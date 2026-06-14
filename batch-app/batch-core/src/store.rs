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
}

/// A file claimed for processing.
pub struct Claimed {
    pub file_id: i64,
    pub path: String,
    pub attempts: i64,
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
  status TEXT NOT NULL DEFAULT 'running'
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
  n_members INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_session_status ON files(session_id, status);
CREATE INDEX IF NOT EXISTS idx_events_file ON events(file_id);
"#;

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    pub fn open_memory() -> rusqlite::Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn })
    }

    pub fn create_session(&self, s: &NewSession) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO sessions(input_roots, output_dir, device, concurrency, theta_a, theta_b)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.input_roots, s.output_dir, s.device, s.concurrency, s.theta_a, s.theta_b],
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
}
