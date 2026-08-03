use serde::Serialize;
use batch_core::export::parse_path_metadata;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct BandSummary {
    pub band: String,
    pub file_count: usize,
    pub effort_hours: f64,
    pub event_count: usize,
    pub retained_count: usize,
    pub rate_per_hour: f64,
    pub mean_duration_sec: f64,
    pub median_duration_sec: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct EcologicalSummary {
    pub session_id: i64,
    pub total_files: usize,
    pub total_effort_hours: f64,
    pub total_retained_events: usize,
    pub bands: Vec<BandSummary>,
}

#[tauri::command]
pub async fn get_ecological_summary(
    session_id: i64,
    db_path: String,
) -> Result<EcologicalSummary, String> {
    let store = batch_core::store::Store::open(std::path::Path::new(&db_path))
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    
    // Compute band aggregates from files and events in store
    let events = store.list_events_all(session_id)
        .map_err(|e| format!("Failed to list events: {}", e))?;
    let files = store.list_files(session_id)
        .map_err(|e| format!("Failed to list files: {}", e))?;

    let total_files = files.len();
    let total_effort_hours = total_files as f64 * 0.25;

    // Group by elevation band
    let mut low_files = 0;
    let mut med_files = 0;
    let mut high_files = 0;

    for f in &files {
        let meta = parse_path_metadata(&f.path);
        match meta.elevation_band.as_deref() {
            Some("Low") => low_files += 1,
            Some("Medium") => med_files += 1,
            Some("High") => high_files += 1,
            _ => low_files += 1, // Default fallback
        }
    }

    let mut low_events: Vec<f64> = Vec::new();
    let mut med_events: Vec<f64> = Vec::new();
    let mut high_events: Vec<f64> = Vec::new();

    for ev in &events {
        if ev.retained {
            let meta = parse_path_metadata(&ev.path);
            match meta.elevation_band.as_deref() {
                Some("Low") => low_events.push(ev.duration),
                Some("Medium") => med_events.push(ev.duration),
                Some("High") => high_events.push(ev.duration),
                _ => low_events.push(ev.duration),
            }
        }
    }

    let calc_band = |name: &str, file_cnt: usize, durations: &mut Vec<f64>| -> BandSummary {
        durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let effort = file_cnt as f64 * 0.25;
        let retained = durations.len();
        let rate = if effort > 0.0 { retained as f64 / effort } else { 0.0 };
        let mean_dur = if !durations.is_empty() {
            durations.iter().sum::<f64>() / retained as f64
        } else {
            0.0
        };
        let median_dur = if !durations.is_empty() {
            durations[retained / 2]
        } else {
            0.0
        };

        BandSummary {
            band: name.to_string(),
            file_count: file_cnt,
            effort_hours: effort,
            event_count: retained,
            retained_count: retained,
            rate_per_hour: rate,
            mean_duration_sec: mean_dur,
            median_duration_sec: median_dur,
        }
    };

    let bands = vec![
        calc_band("Low", low_files, &mut low_events),
        calc_band("Medium", med_files, &mut med_events),
        calc_band("High", high_files, &mut high_events),
    ];

    Ok(EcologicalSummary {
        session_id,
        total_files,
        total_effort_hours,
        total_retained_events: events.iter().filter(|e| e.retained).count(),
        bands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ecological_summary_struct() {
        let band_stat = BandSummary {
            band: "Low".to_string(),
            file_count: 10,
            effort_hours: 2.5,
            event_count: 50,
            retained_count: 40,
            rate_per_hour: 16.0,
            mean_duration_sec: 1.25,
            median_duration_sec: 1.20,
        };
        assert_eq!(band_stat.rate_per_hour, 16.0);
    }

    #[tokio::test]
    async fn test_get_ecological_summary_db() {
        use std::path::PathBuf;
        use batch_core::store::{NewSession, Store, RecordedResult};
        use batch_core::protocol::EventRecord;

        let temp_dir = std::env::temp_dir();
        let db_path = temp_dir.join(format!("test_eco_{}.db", std::process::id()));
        let mut store = Store::open(&db_path).unwrap();
        let sid = store
            .create_session(&NewSession {
                input_roots: "[\"/d\"]",
                output_dir: temp_dir.to_str().unwrap(),
                device: "cpu",
                concurrency: 1,
                theta_a: 0.5,
                theta_b: 0.5,
                species_name: None,
            })
            .unwrap();

        store.add_files(sid, &[
            PathBuf::from("/path/PSL1_20250619_080000.WAV"),
            PathBuf::from("/path/PSM2_20250619_080000.WAV"),
        ]).unwrap();

        let c1 = store.claim_next_pending(sid).unwrap().unwrap();
        let events1 = vec![EventRecord {
            t_start: 1.0, t_end: 2.0, duration: 1.0, f_low: 5000.0, f_high: 6000.0,
            center_freq: 5500.0, stage_a_conf: 0.9, completeness_score: Some(0.8),
            completeness_label: Some("complete".into()), retained: Some(true), n_members: 1,
            ..Default::default()
        }];
        store.record_success(sid, c1.file_id, &RecordedResult {
            n_events: 1, n_complete: 1, n_retained: 1, elapsed_ms: 10, events: &events1,
        }).unwrap();

        let summary = get_ecological_summary(sid, db_path.to_str().unwrap().to_string()).await.unwrap();
        assert_eq!(summary.session_id, sid);
        assert_eq!(summary.total_files, 2);
        assert_eq!(summary.total_effort_hours, 0.5);
        assert_eq!(summary.total_retained_events, 1);
        assert_eq!(summary.bands.len(), 3);
        assert_eq!(summary.bands[0].band, "Low");
        assert_eq!(summary.bands[0].file_count, 1);
        assert_eq!(summary.bands[0].retained_count, 1);
        assert_eq!(summary.bands[0].rate_per_hour, 4.0); // 1 event / 0.25h effort = 4.0/h

        std::fs::remove_file(&db_path).ok();
    }
}
