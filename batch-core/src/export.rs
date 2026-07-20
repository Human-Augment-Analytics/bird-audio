//! Export consolidated events to CSV / JSON analysis-ready files.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use rusqlite::params;

use crate::store::Store;

const SELECT: &str = "SELECT f.path, e.t_start, e.t_end, e.duration, e.f_low, e.f_high, \
     e.center_freq, e.stage_a_conf, e.completeness_score, e.completeness_label, e.retained, e.n_members, e.review_status \
     FROM events e JOIN files f ON f.id=e.file_id \
     WHERE e.session_id=?1 \
       AND (?2=0 OR e.completeness_label='complete') \
       AND (?3=0 OR e.review_status='confirmed') \
     ORDER BY f.path, e.t_start";

#[allow(dead_code)]
struct MetadataRow {
    device_id: String,
    site_id: String,
    elevation_m: f64,
    lat: f64,
    lon: f64,
    deploy_date: String,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    site_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elevation_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lon: Option<f64>,
}

/// One row per scanned file (LEFT JOIN from `files`), so every file in the
/// manifest is represented in the CSV/JSON export even when it has no events or
/// terminally failed. Event columns are `None` for a file with no matching
/// events; `file_status`/`file_error` always carry the per-file outcome.
#[derive(serde::Serialize)]
struct ManifestRow {
    path: String,
    file_status: String,
    file_error: Option<String>,
    t_start: Option<f64>,
    t_end: Option<f64>,
    duration: Option<f64>,
    f_low: Option<f64>,
    f_high: Option<f64>,
    center_freq: Option<f64>,
    stage_a_conf: Option<f64>,
    completeness_score: Option<f64>,
    completeness_label: Option<String>,
    retained: Option<bool>,
    n_members: Option<i64>,
    review_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elevation_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lon: Option<f64>,
}

/// Manifest query: LEFT JOIN so files with no (matching) events still yield a
/// row. The `complete_only`/`confirmed_only` filters live in the JOIN's `ON`
/// clause — not `WHERE` — so filtering out a file's events leaves the file
/// present as an empty row rather than dropping it from the manifest.
const MANIFEST_SELECT: &str = "SELECT f.path, f.status, f.error, \
     e.t_start, e.t_end, e.duration, e.f_low, e.f_high, e.center_freq, \
     e.stage_a_conf, e.completeness_score, e.completeness_label, e.retained, e.n_members, e.review_status \
     FROM files f \
     LEFT JOIN events e ON e.file_id = f.id \
       AND (?2=0 OR e.completeness_label='complete') \
       AND (?3=0 OR e.review_status='confirmed') \
     WHERE f.session_id=?1 \
     ORDER BY f.path, e.t_start";

fn collect_manifest(store: &Store, session_id: i64, complete_only: bool, confirmed_only: bool) -> rusqlite::Result<Vec<ManifestRow>> {
    let mut stmt = store.conn.prepare(MANIFEST_SELECT)?;
    let rows = stmt.query_map(params![session_id, complete_only as i64, confirmed_only as i64], |r| {
        Ok(ManifestRow {
            path: r.get(0)?,
            file_status: r.get(1)?,
            file_error: r.get(2)?,
            t_start: r.get(3)?,
            t_end: r.get(4)?,
            duration: r.get(5)?,
            f_low: r.get(6)?,
            f_high: r.get(7)?,
            center_freq: r.get(8)?,
            stage_a_conf: r.get(9)?,
            completeness_score: r.get(10)?,
            completeness_label: r.get(11)?,
            retained: r.get::<_, Option<i64>>(12)?.map(|v| v != 0),
            n_members: r.get(13)?,
            review_status: r.get(14)?,
            site_id: None,
            elevation_m: None,
            lat: None,
            lon: None,
        })
    })?;
    rows.collect()
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
            site_id: None,
            elevation_m: None,
            lat: None,
            lon: None,
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

fn split_csv_line(line: &str) -> Vec<String> {
    let mut res = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    chars.next(); // consume the second quote
                    field.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' => {
                if in_quotes {
                    field.push(',');
                } else {
                    res.push(field);
                    field = String::new();
                }
            }
            _ => {
                field.push(c);
            }
        }
    }
    res.push(field);
    res
}

fn parse_metadata_csv(content: &str) -> Vec<MetadataRow> {
    let mut rows = Vec::new();
    let mut lines = content.lines();
    let header_line = match lines.next() {
        Some(l) => l,
        None => return rows,
    };
    
    let headers = split_csv_line(header_line);
    let get_index = |name: &str| -> Option<usize> {
        headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name) || h.trim().trim_matches('"').eq_ignore_ascii_case(name))
    };
    
    let idx_device_id = get_index("device_id");
    let idx_site_id = get_index("site_id");
    let idx_elevation_m = get_index("elevation_m");
    let idx_lat = get_index("lat");
    let idx_lon = get_index("lon");
    let idx_deploy_date = get_index("deploy_date");
    
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let cols = split_csv_line(line);
        let get_val = |idx: Option<usize>| -> Option<String> {
            idx.and_then(|i| cols.get(i)).map(|s| s.trim().trim_matches('"').to_string())
        };
        
        let device_id = match get_val(idx_device_id) {
            Some(val) if !val.is_empty() => val,
            _ => continue,
        };
        let site_id = get_val(idx_site_id).unwrap_or_default();
        let elevation_m = get_val(idx_elevation_m).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let lat = get_val(idx_lat).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let lon = get_val(idx_lon).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let deploy_date = get_val(idx_deploy_date).unwrap_or_default();
        
        rows.push(MetadataRow {
            device_id,
            site_id,
            elevation_m,
            lat,
            lon,
            deploy_date,
        });
    }
    rows
}

fn load_metadata(path: &Path) -> Result<Vec<MetadataRow>, Box<dyn Error>> {
    let content = std::fs::read_to_string(path)?;
    Ok(parse_metadata_csv(&content))
}

fn find_device_id(path: &str) -> Option<String> {
    let chars: Vec<char> = path.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + 3 < chars.len() && (chars[i] == 'P' || chars[i] == 'p') && (chars[i+1] == 'S' || chars[i+1] == 's') {
            let next_c = chars[i+2].to_ascii_uppercase();
            if next_c == 'L' || next_c == 'M' || next_c == 'H' {
                if chars[i+3].is_ascii_digit() {
                    let mut end = i + 4;
                    while end < chars.len() && chars[end].is_ascii_digit() {
                        end += 1;
                    }
                    let dev_id: String = chars[i..end].iter().collect();
                    return Some(dev_id.to_ascii_uppercase());
                }
            }
        }
        if chars[i] == 'H' || chars[i] == 'h' {
            let is_boundary = i == 0 || !chars[i-1].is_ascii_alphanumeric();
            if is_boundary && i + 1 < chars.len() && chars[i+1].is_ascii_digit() {
                let mut end = i + 2;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                let dev_id: String = chars[i..end].iter().collect();
                return Some(dev_id.to_ascii_uppercase());
            }
        }
        i += 1;
    }
    None
}

fn find_session_datetime(path: &str) -> Option<String> {
    let chars: Vec<char> = path.chars().collect();
    if chars.len() < 15 {
        return None;
    }
    for i in 0..=(chars.len() - 15) {
        let is_match = chars[i..i+8].iter().all(|c| c.is_ascii_digit())
            && chars[i+8] == '_'
            && chars[i+9..i+15].iter().all(|c| c.is_ascii_digit());
        if is_match {
            let dt: String = chars[i..i+15].iter().collect();
            return Some(dt);
        }
    }
    None
}

fn median(mut values: Vec<f64>) -> f64 {
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

fn export_secondary_summary(
    store: &Store,
    session_id: i64,
    main_path: &Path,
    complete_only: bool,
    confirmed_only: bool,
    metadata: &[MetadataRow],
) -> Result<(), Box<dyn Error>> {
    let mut stmt = store.conn.prepare("SELECT path FROM files WHERE session_id = ?1")?;
    let file_paths: Vec<String> = stmt
        .query_map(params![session_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;

    let mut group_files: HashMap<(String, String), (f64, HashSet<String>)> = HashMap::new();

    for path in &file_paths {
        let dev_id = find_device_id(path);
        let meta = dev_id.as_ref().and_then(|d| {
            metadata.iter().find(|m| m.device_id.eq_ignore_ascii_case(d))
        });
        let site_id = meta.map(|m| m.site_id.clone()).unwrap_or_default();
        let elevation_m = meta.map(|m| m.elevation_m).unwrap_or(0.0);
        let session_datetime = find_session_datetime(path).unwrap_or_default();
        
        let entry = group_files
            .entry((site_id, session_datetime))
            .or_insert_with(|| (elevation_m, HashSet::new()));
        entry.1.insert(path.clone());
    }

    let rows = collect(store, session_id, complete_only, confirmed_only)?;

    let mut group_events: HashMap<(String, String), Vec<(f64, f64)>> = HashMap::new();
    for r in &rows {
        let dev_id = find_device_id(&r.path);
        let meta = dev_id.as_ref().and_then(|d| {
            metadata.iter().find(|m| m.device_id.eq_ignore_ascii_case(d))
        });
        let site_id = meta.map(|m| m.site_id.clone()).unwrap_or_default();
        let session_datetime = find_session_datetime(&r.path).unwrap_or_default();
        
        group_events
            .entry((site_id, session_datetime))
            .or_insert(Vec::new())
            .push((r.duration, r.center_freq));
    }

    let summary_path = if let Some(stem) = main_path.file_stem() {
        let mut name = stem.to_os_string();
        name.push("_summary.csv");
        main_path.with_file_name(name)
    } else {
        main_path.with_extension("summary.csv")
    };

    let mut f = File::create(&summary_path)?;
    writeln!(
        f,
        "site_id,session_datetime,elevation_m,n_events,duration_mean,duration_median,center_freq_mean,effort_hours"
    )?;

    let mut keys: Vec<&(String, String)> = group_files.keys().collect();
    keys.sort();

    for &(site_id, session_datetime) in &keys {
        let &(elevation_m, ref files) = group_files.get(&(site_id.clone(), session_datetime.clone())).unwrap();
        let events = group_events.get(&(site_id.clone(), session_datetime.clone()));
        
        let n_events = events.map(|v| v.len()).unwrap_or(0);
        let effort_hours = (files.len() as f64) * 0.25;

        let (dur_mean, dur_median, freq_mean) = if n_events > 0 {
            let evs = events.unwrap();
            let sum_dur: f64 = evs.iter().map(|e| e.0).sum();
            let sum_freq: f64 = evs.iter().map(|e| e.1).sum();
            let mean_dur = sum_dur / (n_events as f64);
            let mean_freq = sum_freq / (n_events as f64);
            
            let durs: Vec<f64> = evs.iter().map(|e| e.0).collect();
            let med_dur = median(durs);
            (mean_dur, med_dur, mean_freq)
        } else {
            (0.0, 0.0, 0.0)
        };

        writeln!(
            f,
            "{},{},{},{},{:.4},{:.4},{:.4},{}",
            csv_escape(site_id),
            csv_escape(session_datetime),
            elevation_m,
            n_events,
            dur_mean,
            dur_median,
            freq_mean,
            effort_hours
        )?;
    }

    Ok(())
}

/// Attach deployment metadata (site/elevation/lat/lon) to manifest rows by
/// matching the recorder device id embedded in each file path.
fn join_metadata(rows: &mut [ManifestRow], metadata: &[MetadataRow]) {
    for r in rows.iter_mut() {
        if let Some(dev_id) = find_device_id(&r.path) {
            if let Some(meta) = metadata.iter().find(|m| m.device_id.eq_ignore_ascii_case(&dev_id)) {
                r.site_id = Some(meta.site_id.clone());
                r.elevation_m = Some(meta.elevation_m);
                r.lat = Some(meta.lat);
                r.lon = Some(meta.lon);
            }
        }
    }
}

fn opt_str<T: ToString>(v: &Option<T>) -> String {
    v.as_ref().map(|x| x.to_string()).unwrap_or_default()
}

pub fn export_csv(
    store: &Store,
    session_id: i64,
    path: &Path,
    complete_only: bool,
    confirmed_only: bool,
    metadata_path: Option<&Path>,
) -> Result<usize, Box<dyn Error>> {
    let mut rows = collect_manifest(store, session_id, complete_only, confirmed_only)?;
    let mut metadata = Vec::new();
    if let Some(meta_path) = metadata_path {
        metadata = load_metadata(meta_path)?;
        join_metadata(&mut rows, &metadata);
    }

    let mut f = File::create(path)?;
    // `file_status`/`file_error` are appended after the event columns so the
    // long-standing `path,t_start,...` prefix (and any downstream parser keyed
    // on it) keeps working; site columns follow only when metadata is joined.
    if metadata_path.is_some() {
        writeln!(
            f,
            "path,t_start,t_end,duration,f_low,f_high,center_freq,stage_a_conf,completeness_score,completeness_label,retained,n_members,review_status,file_status,file_error,site_id,elevation_m,lat,lon"
        )?;
    } else {
        writeln!(
            f,
            "path,t_start,t_end,duration,f_low,f_high,center_freq,stage_a_conf,completeness_score,completeness_label,retained,n_members,review_status,file_status,file_error"
        )?;
    }

    for r in &rows {
        if metadata_path.is_some() {
            writeln!(
                f,
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                csv_escape(&r.path),
                opt_str(&r.t_start),
                opt_str(&r.t_end),
                opt_str(&r.duration),
                opt_str(&r.f_low),
                opt_str(&r.f_high),
                opt_str(&r.center_freq),
                opt_str(&r.stage_a_conf),
                opt_str(&r.completeness_score),
                r.completeness_label.clone().unwrap_or_default(),
                opt_str(&r.retained),
                opt_str(&r.n_members),
                csv_escape(r.review_status.as_deref().unwrap_or("")),
                csv_escape(&r.file_status),
                csv_escape(r.file_error.as_deref().unwrap_or("")),
                csv_escape(r.site_id.as_deref().unwrap_or("")),
                opt_str(&r.elevation_m),
                opt_str(&r.lat),
                opt_str(&r.lon),
            )?;
        } else {
            writeln!(
                f,
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                csv_escape(&r.path),
                opt_str(&r.t_start),
                opt_str(&r.t_end),
                opt_str(&r.duration),
                opt_str(&r.f_low),
                opt_str(&r.f_high),
                opt_str(&r.center_freq),
                opt_str(&r.stage_a_conf),
                opt_str(&r.completeness_score),
                r.completeness_label.clone().unwrap_or_default(),
                opt_str(&r.retained),
                opt_str(&r.n_members),
                csv_escape(r.review_status.as_deref().unwrap_or("")),
                csv_escape(&r.file_status),
                csv_escape(r.file_error.as_deref().unwrap_or("")),
            )?;
        }
    }

    if metadata_path.is_some() {
        export_secondary_summary(store, session_id, path, complete_only, confirmed_only, &metadata)?;
    }

    Ok(rows.len())
}

pub fn export_json(
    store: &Store,
    session_id: i64,
    path: &Path,
    complete_only: bool,
    confirmed_only: bool,
    metadata_path: Option<&Path>,
) -> Result<usize, Box<dyn Error>> {
    let mut rows = collect_manifest(store, session_id, complete_only, confirmed_only)?;
    let mut metadata = Vec::new();
    if let Some(meta_path) = metadata_path {
        metadata = load_metadata(meta_path)?;
        join_metadata(&mut rows, &metadata);
    }

    let f = File::create(path)?;
    serde_json::to_writer_pretty(f, &rows)?;

    if metadata_path.is_some() {
        export_secondary_summary(store, session_id, path, complete_only, confirmed_only, &metadata)?;
    }

    Ok(rows.len())
}

/// warbleR selection tables are event-only by definition — each row is a
/// selection bounding an actual detection — so unlike CSV/JSON this format does
/// not include a row for files with no events.
pub fn export_warbler(
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
        "sound.files,selec,start,end,bottom.freq,top.freq"
    )?;

    let mut counts = HashMap::new();

    for r in &rows {
        let filename = Path::new(&r.path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let count = counts.entry(filename.clone()).or_insert(0);
        *count += 1;

        let bottom_freq = r.f_low / 1000.0;
        let top_freq = r.f_high / 1000.0;

        writeln!(
            f,
            "{},{},{},{},{},{}",
            csv_escape(&filename),
            count,
            r.t_start,
            r.t_end,
            bottom_freq,
            top_freq
        )?;
    }
    Ok(rows.len())
}

pub fn export_raven(
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
        "Selection\tView\tChannel\tBegin Time (s)\tEnd Time (s)\tLow Freq (Hz)\tHigh Freq (Hz)\tFile\tBegin Path"
    )?;

    for (i, r) in rows.iter().enumerate() {
        let filename = Path::new(&r.path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        writeln!(
            f,
            "{}\tSpectrogram 1\t1\t{}\t{}\t{}\t{}\t{}\t{}",
            i + 1,
            r.t_start,
            r.t_end,
            r.f_low,
            r.f_high,
            filename,
            r.path
        )?;
    }
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
        s.add_files(sid, &[
            PathBuf::from("/d/PSL2_20250611_080000.wav"),
            PathBuf::from("/d/PSM5_20250611_081500.wav")
        ]).unwrap();
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        let events = vec![
            EventRecord {
                t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.9, completeness_score: Some(0.8),
                completeness_label: Some("complete".into()), retained: Some(true), n_members: 2,
            },
        ];
        s.record_success(
            sid, c.file_id,
            &RecordedResult { n_events: 1, n_complete: 1, n_retained: 1, elapsed_ms: 5, events: &events },
        )
        .unwrap();
        
        let c2 = s.claim_next_pending(sid).unwrap().unwrap();
        let events2 = vec![
            EventRecord {
                t_start: 3.0, t_end: 3.3, duration: 0.3, f_low: 5000.0, f_high: 6000.0,
                center_freq: 5500.0, stage_a_conf: 0.4, completeness_score: Some(0.2),
                completeness_label: Some("incomplete".into()), retained: Some(false), n_members: 1,
            },
        ];
        s.record_success(
            sid, c2.file_id,
            &RecordedResult { n_events: 1, n_complete: 0, n_retained: 0, elapsed_ms: 5, events: &events2 },
        )
        .unwrap();
        (s, sid)
    }

    #[test]
    fn csv_export_writes_header_and_rows() {
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_csv_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &p, false, false, None).unwrap();
        assert_eq!(n, 2);
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.starts_with("path,t_start"));
        assert_eq!(body.trim().lines().count(), 3); // header + 2 rows
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn csv_complete_only_filters() {
        // Manifest semantics: complete_only filters *event rows*, but every file
        // still appears. The fixture has one complete and one incomplete file, so
        // both files show up (2 rows) with event data only on the complete one.
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_csv_co_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &p, true, false, None).unwrap();
        assert_eq!(n, 2);
        let body = std::fs::read_to_string(&p).unwrap();
        // The complete file keeps its "complete" label; the filtered file appears
        // as an empty row (no completeness label written).
        assert!(body.contains("complete"));
        assert!(body.contains("PSL2_20250611_080000.wav"));
        assert!(body.contains("PSM5_20250611_081500.wav"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn manifest_includes_files_with_no_events_and_failed() {
        // A file that ran with zero detections and a file that terminally failed
        // must both appear in the CSV so nothing silently drops from the manifest.
        let mut s = Store::open_memory().unwrap();
        let sid = s.create_session(&NewSession {
            input_roots: "[\"/d\"]", output_dir: "/o", device: "cpu",
            concurrency: 1, theta_a: 0.0, theta_b: 0.53,
        }).unwrap();
        s.add_files(sid, &[
            PathBuf::from("/d/has_events.wav"),
            PathBuf::from("/d/no_events.wav"),
            PathBuf::from("/d/failed.wav"),
        ]).unwrap();
        // has_events: one event
        let c = s.claim_next_pending(sid).unwrap().unwrap();
        let evs = vec![EventRecord {
            t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 5000.0, f_high: 6000.0,
            center_freq: 5500.0, stage_a_conf: 0.9, completeness_score: Some(0.8),
            completeness_label: Some("complete".into()), retained: Some(true), n_members: 2,
        }];
        s.record_success(sid, c.file_id,
            &RecordedResult { n_events: 1, n_complete: 1, n_retained: 1, elapsed_ms: 5, events: &evs }).unwrap();
        // no_events: done, zero events
        let c2 = s.claim_next_pending(sid).unwrap().unwrap();
        s.record_success(sid, c2.file_id,
            &RecordedResult { n_events: 0, n_complete: 0, n_retained: 0, elapsed_ms: 5, events: &[] }).unwrap();
        // failed
        let c3 = s.claim_next_pending(sid).unwrap().unwrap();
        s.mark_failed(c3.file_id, "decode error").unwrap();

        let p = std::env::temp_dir().join(format!("bc_manifest_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &p, false, false, None).unwrap();
        assert_eq!(n, 3, "every scanned file should be represented");
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("has_events.wav"));
        assert!(body.contains("no_events.wav"));
        assert!(body.contains("failed.wav"));
        assert!(body.contains("decode error"), "failed file should carry its error");
        // header exposes the per-file outcome columns
        assert!(body.lines().next().unwrap().contains("file_status,file_error"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn json_export_array_len() {
        let (s, sid) = store_with_events();
        let p = std::env::temp_dir().join(format!("bc_json_{}.json", std::process::id()));
        let n = export_json(&s, sid, &p, false, false, None).unwrap();
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
        // Manifest semantics: both files appear (2 rows); confirmed_only filters
        // the event data, so exactly one row carries a t_start.
        let n = export_json(&s, sid, &p, false, true, None).unwrap();
        assert_eq!(n, 2);
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let with_events = v.as_array().unwrap().iter()
            .filter(|r| !r["t_start"].is_null()).count();
        assert_eq!(with_events, 1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn test_find_device_id() {
        assert_eq!(find_device_id("/path/to/PSL2_audio.wav"), Some("PSL2".into()));
        assert_eq!(find_device_id("/path/to/PSM5_20250611_080000.wav"), Some("PSM5".into()));
        assert_eq!(find_device_id("/path/to/H12_20250611.wav"), Some("H12".into()));
        assert_eq!(find_device_id("/path/to/somefile_H3.wav"), Some("H3".into()));
        assert_eq!(find_device_id("/path/to/high_H1.wav"), Some("H1".into()));
        assert_eq!(find_device_id("/path/to/no_pattern.wav"), None);
    }

    #[test]
    fn test_find_session_datetime() {
        assert_eq!(find_session_datetime("/path/to/PSL2_20250611_080000.wav"), Some("20250611_080000".into()));
        assert_eq!(find_session_datetime("/path/to/20250611_080000.wav"), Some("20250611_080000".into()));
        assert_eq!(find_session_datetime("/path/to/no_date.wav"), None);
    }

    #[test]
    fn test_metadata_join() {
        let (s, sid) = store_with_events();
        let temp_dir = std::env::temp_dir();
        let meta_p = temp_dir.join(format!("meta_{}.csv", std::process::id()));
        std::fs::write(&meta_p, "device_id,site_id,elevation_m,lat,lon,deploy_date\nPSL2,SITE_A,1200.0,34.5,-112.4,2025-06-10\nPSM5,SITE_B,1500.0,34.6,-112.5,2025-06-10\n").unwrap();
        
        let out_p = temp_dir.join(format!("out_{}.csv", std::process::id()));
        let n = export_csv(&s, sid, &out_p, false, false, Some(&meta_p)).unwrap();
        assert_eq!(n, 2);
        
        let body = std::fs::read_to_string(&out_p).unwrap();
        assert!(body.contains("site_id,elevation_m,lat,lon"));
        assert!(body.contains("SITE_A"));
        
        let summary_p = temp_dir.join(format!("out_{}_summary.csv", std::process::id()));
        assert!(summary_p.exists());
        let summary_body = std::fs::read_to_string(&summary_p).unwrap();
        assert!(summary_body.contains("SITE_A"));
        assert!(summary_body.contains("SITE_B"));
        assert!(summary_body.contains("0.25")); // effort hours
        
        std::fs::remove_file(&meta_p).ok();
        std::fs::remove_file(&out_p).ok();
        std::fs::remove_file(&summary_p).ok();
    }
}
