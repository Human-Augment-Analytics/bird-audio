use batch_core::export::parse_path_metadata;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const DEFAULT_FILE_EFFORT_HOURS: f64 = 0.25;

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
    pub effort_files_measured: usize,
    pub effort_files_defaulted: usize,
    pub total_retained_events: usize,
    pub bands: Vec<BandSummary>,
}

#[derive(Default)]
struct BandAccumulator {
    file_count: usize,
    effort_hours: f64,
    event_count: usize,
    retained_durations: Vec<f64>,
}

fn band_for_path(path: &str) -> String {
    parse_path_metadata(path)
        .elevation_band
        .unwrap_or_else(|| "Unassigned".to_string())
}

/// Read duration from an ordinary RIFF/WAVE header without decoding the audio.
/// Unsupported or malformed files return `None` so callers can use the documented fallback.
fn wav_duration_hours(path: &Path) -> Option<f64> {
    let mut file = File::open(path).ok()?;
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff).ok()?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return None;
    }

    let mut byte_rate = None;
    let mut data_bytes = None;
    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let chunk_size = u32::from_le_bytes(chunk[4..8].try_into().ok()?) as u64;
        match &chunk[0..4] {
            b"fmt " => {
                if chunk_size < 12 {
                    return None;
                }
                let mut format = [0_u8; 12];
                file.read_exact(&mut format).ok()?;
                byte_rate = Some(u32::from_le_bytes(format[8..12].try_into().ok()?) as u64);
                file.seek(SeekFrom::Current((chunk_size - 12) as i64)).ok()?;
            }
            b"data" => {
                data_bytes = Some(chunk_size);
                file.seek(SeekFrom::Current(chunk_size as i64)).ok()?;
            }
            _ => {
                file.seek(SeekFrom::Current(chunk_size as i64)).ok()?;
            }
        }
        if chunk_size % 2 == 1 {
            file.seek(SeekFrom::Current(1)).ok()?;
        }
        if byte_rate.is_some() && data_bytes.is_some() {
            break;
        }
    }

    let bytes_per_second = byte_rate?;
    if bytes_per_second == 0 {
        return None;
    }
    Some(data_bytes? as f64 / bytes_per_second as f64 / 3600.0)
}

fn finish_band(name: String, mut acc: BandAccumulator) -> BandSummary {
    acc.retained_durations
        .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let retained_count = acc.retained_durations.len();
    let rate_per_hour = if acc.effort_hours > 0.0 {
        retained_count as f64 / acc.effort_hours
    } else {
        0.0
    };
    let mean_duration_sec = if retained_count > 0 {
        acc.retained_durations.iter().sum::<f64>() / retained_count as f64
    } else {
        0.0
    };
    let median_duration_sec = match retained_count {
        0 => 0.0,
        n if n % 2 == 1 => acc.retained_durations[n / 2],
        n => (acc.retained_durations[n / 2 - 1] + acc.retained_durations[n / 2]) / 2.0,
    };

    BandSummary {
        band: name,
        file_count: acc.file_count,
        effort_hours: acc.effort_hours,
        event_count: acc.event_count,
        retained_count,
        rate_per_hour,
        mean_duration_sec,
        median_duration_sec,
    }
}

#[tauri::command]
pub async fn get_ecological_summary(
    session_id: i64,
    db_path: String,
) -> Result<EcologicalSummary, String> {
    let store = batch_core::store::Store::open(Path::new(&db_path))
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    let session = store
        .summary(session_id)
        .map_err(|e| format!("Failed to read session: {e}"))?;
    if session.status != "done" {
        return Err(format!(
            "Ecological analysis requires a completed session; session {session_id} is {}",
            session.status
        ));
    }
    let events = store
        .list_events_all(session_id)
        .map_err(|e| format!("Failed to list events: {}", e))?;
    let files: Vec<_> = store
        .list_files(session_id)
        .map_err(|e| format!("Failed to list files: {}", e))?
        .into_iter()
        .filter(|file| file.status == "done")
        .collect();

    let total_files = files.len();
    let mut effort_files_measured = 0;
    let mut effort_files_defaulted = 0;
    let mut aggregates: BTreeMap<String, BandAccumulator> = BTreeMap::new();

    for file in &files {
        let effort = match wav_duration_hours(Path::new(&file.path)) {
            Some(hours) => {
                effort_files_measured += 1;
                hours
            }
            None => {
                effort_files_defaulted += 1;
                DEFAULT_FILE_EFFORT_HOURS
            }
        };
        let acc = aggregates.entry(band_for_path(&file.path)).or_default();
        acc.file_count += 1;
        acc.effort_hours += effort;
    }

    for event in &events {
        let acc = aggregates.entry(band_for_path(&event.path)).or_default();
        acc.event_count += 1;
        if event.retained {
            acc.retained_durations.push(event.duration);
        }
    }

    let mut bands = Vec::new();
    for name in ["Low", "Medium", "High", "Unassigned"] {
        if let Some(acc) = aggregates.remove(name) {
            bands.push(finish_band(name.to_string(), acc));
        } else if name != "Unassigned" {
            bands.push(finish_band(name.to_string(), BandAccumulator::default()));
        }
    }
    bands.extend(aggregates.into_iter().map(|(name, acc)| finish_band(name, acc)));

    let total_effort_hours = bands.iter().map(|band| band.effort_hours).sum();
    Ok(EcologicalSummary {
        session_id,
        total_files,
        total_effort_hours,
        effort_files_measured,
        effort_files_defaulted,
        total_retained_events: events.iter().filter(|event| event.retained).count(),
        bands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecological_summary_struct() {
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

    #[test]
    fn wav_duration_reads_header_effort() {
        use std::io::Write;

        let path = std::env::temp_dir().join(format!(
            "test_eco_duration_{}_{}.wav",
            std::process::id(),
            std::thread::current().name().unwrap_or("thread")
        ));
        let sample_rate = 8_000_u32;
        let byte_rate = sample_rate * 2;
        let data_size = byte_rate * 60;
        let mut header = Vec::new();
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&(36 + data_size).to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&byte_rate.to_le_bytes());
        header.extend_from_slice(&2_u16.to_le_bytes());
        header.extend_from_slice(&16_u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&data_size.to_le_bytes());

        let mut file = File::create(&path).unwrap();
        file.write_all(&header).unwrap();
        file.set_len(header.len() as u64 + data_size as u64).unwrap();
        drop(file);

        assert_eq!(wav_duration_hours(&path).unwrap(), 1.0 / 60.0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn even_median_uses_both_middle_values() {
        let band = finish_band(
            "Low".to_string(),
            BandAccumulator {
                retained_durations: vec![1.0, 3.0],
                ..Default::default()
            },
        );
        assert_eq!(band.median_duration_sec, 2.0);
    }

    #[tokio::test]
    async fn get_ecological_summary_uses_documented_fallback() {
        use batch_core::protocol::EventRecord;
        use batch_core::store::{NewSession, RecordedResult, Store};
        use std::path::PathBuf;

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
                config_key: "test", worker_cmd: None, cwd: None,
                localizer_path: None, classifier_path: None, classifier_c_path: None,
                f_min_hz: None, f_max_hz: None,
            })
            .unwrap();

        store
            .add_files(
                sid,
                &[
                    PathBuf::from("/path/PSL1_20250619_080000.WAV"),
                    PathBuf::from("/path/PSM2_20250619_080000.WAV"),
                ],
            )
            .unwrap();

        let claimed = store.claim_next_pending(sid).unwrap().unwrap();
        let records = vec![EventRecord {
            t_start: 1.0,
            t_end: 2.0,
            duration: 1.0,
            f_low: 5000.0,
            f_high: 6000.0,
            center_freq: 5500.0,
            stage_a_conf: 0.9,
            completeness_score: Some(0.8),
            completeness_label: Some("complete".into()),
            retained: Some(true),
            n_members: 1,
            ..Default::default()
        }];
        store
            .record_success(
                sid,
                claimed.file_id,
                &RecordedResult {
                    n_events: 1,
                    n_complete: 1,
                    n_retained: 1,
                    elapsed_ms: 10,
                    events: &records,
                },
            )
            .unwrap();
        let zero_event_file = store.claim_next_pending(sid).unwrap().unwrap();
        store
            .record_success(
                sid,
                zero_event_file.file_id,
                &RecordedResult {
                    n_events: 0,
                    n_complete: 0,
                    n_retained: 0,
                    elapsed_ms: 5,
                    events: &[],
                },
            )
            .unwrap();
        store.set_session_status(sid, "done").unwrap();

        let summary = get_ecological_summary(sid, db_path.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(summary.session_id, sid);
        assert_eq!(summary.total_files, 2);
        assert_eq!(summary.total_effort_hours, 0.5);
        assert_eq!(summary.effort_files_measured, 0);
        assert_eq!(summary.effort_files_defaulted, 2);
        assert_eq!(summary.total_retained_events, 1);
        assert_eq!(summary.bands.len(), 3);
        assert_eq!(summary.bands[0].band, "Low");
        assert_eq!(summary.bands[0].file_count, 1);
        assert_eq!(summary.bands[0].event_count, 1);
        assert_eq!(summary.bands[0].retained_count, 1);
        assert_eq!(summary.bands[0].rate_per_hour, 4.0);

        std::fs::remove_file(&db_path).ok();
    }
}
