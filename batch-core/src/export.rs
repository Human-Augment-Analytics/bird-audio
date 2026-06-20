//! Export consolidated events to CSV / JSON analysis-ready files.

use std::error::Error;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use rusqlite::params;

use crate::store::Store;

const SELECT: &str = "SELECT f.path, e.t_start, e.t_end, e.duration, e.f_low, e.f_high, \
     e.center_freq, e.stage_a_conf, e.completeness_score, e.completeness_label, e.retained, \
     e.n_members, e.review_status \
     FROM events e JOIN files f ON f.id=e.file_id \
     WHERE e.session_id=?1 \
       AND (?2=0 OR e.completeness_label='complete') \
       AND (?3=0 OR e.review_status='confirmed') \
     ORDER BY f.path, e.t_start";

#[derive(serde::Serialize)]
struct Row {
    path: String,
    t_start: f64,
    t_end: f64,
    duration: f64,
    f_low: f64,
    f_high: f64,
    center_freq: f64,
    stage_a_conf: f64,
    completeness_score: Option<f64>,
    completeness_label: Option<String>,
    retained: Option<bool>,
    n_members: i64,
    review_status: String,
}

fn collect(store: &Store, session_id: i64, complete_only: bool, confirmed_only: bool) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = store.conn.prepare(SELECT)?;
    let rows = stmt.query_map(params![session_id, complete_only as i64, confirmed_only as i64], |r| {
        Ok(Row {
            path: r.get(0)?,
            t_start: r.get(1)?,
            t_end: r.get(2)?,
            duration: r.get(3)?,
            f_low: r.get(4)?,
            f_high: r.get(5)?,
            center_freq: r.get(6)?,
            stage_a_conf: r.get(7)?,
            completeness_score: r.get(8)?,
            completeness_label: r.get(9)?,
            retained: r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
            n_members: r.get(11)?,
            review_status: r.get(12)?,
        })
    })?;
    rows.collect()
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn export_csv(
    store: &Store,
    session_id: i64,
    path: &Path,
    complete_only: bool,
    confirmed_only: bool,
) -> Result<usize, Box<dyn Error>> {
    let rows = collect(store, session_id, complete_only, confirmed_only)?;
    let mut f = File::create(path)?;
    writeln!(
        f,
        "path,t_start,t_end,duration,f_low,f_high,center_freq,stage_a_conf,completeness_score,completeness_label,retained,n_members,review_status"
    )?;
    for r in &rows {
        writeln!(
            f,
            "{},{},{},{},{},{},{},{},{},{},{},{},{}",
            csv_escape(&r.path),
            r.t_start,
            r.t_end,
            r.duration,
            r.f_low,
            r.f_high,
            r.center_freq,
            r.stage_a_conf,
            r.completeness_score.map(|v| v.to_string()).unwrap_or_default(),
            r.completeness_label.clone().unwrap_or_default(),
            r.retained.map(|v| v.to_string()).unwrap_or_default(),
            r.n_members,
            r.review_status
        )?;
    }
    Ok(rows.len())
}

pub fn export_json(
    store: &Store,
    session_id: i64,
    path: &Path,
    complete_only: bool,
    confirmed_only: bool,
) -> Result<usize, Box<dyn Error>> {
    let rows = collect(store, session_id, complete_only, confirmed_only)?;
    let f = File::create(path)?;
    serde_json::to_writer_pretty(f, &rows)?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::EventRecord;
    use crate::store::{NewSession, RecordedResult, Store};
    use std::path::PathBuf;

    fn store_with_events() -> (Store, i64) {
        let mut s = Store::open_memory().unwrap();
        let sid = s
            .create_session(&NewSession {
                input_roots: "[\"/d\"]",
                output_dir: "/o",
                device: "cpu",
                concurrency: 1,
                theta_a: 0.0,
                theta_b: 0.53,
            })
            .unwrap();
        s.add_files(sid, &[PathBuf::from("/d/a.wav")]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        let events = vec![
            EventRecord {
                t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.9, completeness_score: Some(0.8),
                completeness_label: Some("complete".into()), retained: Some(true), n_members: 2,
            },
            EventRecord {
                t_start: 3.0, t_end: 3.3, duration: 0.3, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.4, completeness_score: Some(0.2),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1,
            },
        ];
        s.record_success(
            sid, c.file_id,
            &RecordedResult { n_events: 2, n_complete: 1, n_retained: 1, elapsed_ms: 5, events: &events },
        )
        .unwrap();
        (s, sid)
    }

    #[test]
    fn csv_export_writes_header_and_rows() {
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_csv_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &p, false, false).unwrap();
        assert_eq!(n, 2);
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.starts_with("path,t_start"));
        assert_eq!(body.trim().lines().count(), 3); // header + 2 rows
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn csv_complete_only_filters() {
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_csv_co_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &p, true, false).unwrap();
        assert_eq!(n, 1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn json_export_array_len() {
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_json_{}.json", std::process::id()));
        let n = export_json(&s, sid, &p, false, false).unwrap();
        assert_eq!(n, 2);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
        std::fs::remove_file(&p).ok();
    }

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
}
