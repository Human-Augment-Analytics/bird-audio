use batch_core::export::parse_path_metadata;
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use batch_core::audio::audio_duration_hours;

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
pub struct CountBin {
    pub label: String,
    pub start: f64,
    pub end: f64,
    pub event_count: usize,
    pub retained_count: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct DistributionStats {
    pub mean: Option<f64>,
    pub median: Option<f64>,
    pub p25: Option<f64>,
    pub p75: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct AnalysisContext {
    pub target: String,
    pub device: String,
    pub theta_a: f64,
    pub theta_b: f64,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
    pub config_key: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RecorderSummary {
    pub recorder_id: String,
    pub elevation_band: String,
    pub file_count: usize,
    pub effort_hours: f64,
    pub event_count: usize,
    pub retained_count: usize,
    pub rate_per_hour: f64,
    pub reviewed_count: usize,
    pub review_coverage: f64,
    pub mean_duration_sec: Option<f64>,
    pub median_duration_sec: Option<f64>,
    pub median_center_frequency_hz: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct EcologicalSummary {
    pub session_id: i64,
    pub session_status: String,
    pub total_files: usize,
    pub cached_files: usize,
    pub inventory_verified: bool,
    pub missing_cached_files: usize,
    pub analyzed_files: usize,
    pub failed_files: usize,
    pub pending_files: usize,
    pub in_progress_files: usize,
    pub partial_results: bool,
    pub total_effort_hours: f64,
    pub effort_files_measured: usize,
    pub effort_files_defaulted: usize,
    pub total_events: usize,
    pub total_retained_events: usize,
    pub retention_rate: f64,
    pub reviewed_events: usize,
    pub confirmed_events: usize,
    pub rejected_events: usize,
    pub review_coverage: f64,
    pub manual_events: usize,
    pub stage_c_labeled_events: usize,
    pub completeness_unscored_events: usize,
    pub completeness_unscored_retained_events: usize,
    pub incomplete_numeric_events: usize,
    pub context: AnalysisContext,
    pub duration: DistributionStats,
    pub center_frequency_hz: DistributionStats,
    pub activity_bins: Vec<CountBin>,
    pub duration_bins: Vec<CountBin>,
    pub frequency_bins: Vec<CountBin>,
    pub confidence_bins: Vec<CountBin>,
    pub completeness_bins: Vec<CountBin>,
    pub recorders: Vec<RecorderSummary>,
    pub bands: Vec<BandSummary>,
}

#[derive(Default)]
struct BandAccumulator {
    file_count: usize,
    effort_hours: f64,
    event_count: usize,
    retained_count: usize,
    retained_durations: Vec<f64>,
}

#[derive(Default)]
struct RecorderAccumulator {
    band: String,
    file_count: usize,
    effort_hours: f64,
    event_count: usize,
    retained_count: usize,
    reviewed_count: usize,
    retained_durations: Vec<f64>,
    retained_frequencies: Vec<f64>,
}

struct AnalyticsEvent {
    path: String,
    t_start: Option<f64>,
    duration: Option<f64>,
    center_freq: Option<f64>,
    stage_a_conf: Option<f64>,
    completeness_score: Option<f64>,
    retained: bool,
    review_status: String,
    source: String,
    stage_c_label: Option<String>,
}

fn band_for_path(path: &str) -> String {
    parse_path_metadata(path)
        .elevation_band
        .unwrap_or_else(|| "Unassigned".to_string())
}

fn recorder_for_path(path: &str) -> String {
    parse_path_metadata(path)
        .recorder_id
        .unwrap_or_else(|| "Unattributed (combined)".to_string())
}

fn finish_band(name: String, mut acc: BandAccumulator) -> BandSummary {
    acc.retained_durations
        .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let retained_count = acc.retained_count;
    let rate_per_hour = if acc.effort_hours > 0.0 {
        retained_count as f64 / acc.effort_hours
    } else {
        0.0
    };
    let duration_count = acc.retained_durations.len();
    let mean_duration_sec = if duration_count > 0 {
        acc.retained_durations.iter().sum::<f64>() / duration_count as f64
    } else {
        0.0
    };
    let median_duration_sec = match duration_count {
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

fn quantile(sorted: &[f64], q: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let position = q.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        Some(sorted[lower])
    } else {
        let weight = position - lower as f64;
        Some(sorted[lower] * (1.0 - weight) + sorted[upper] * weight)
    }
}

fn distribution_stats(values: &[f64]) -> DistributionStats {
    let mut sorted: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    DistributionStats {
        mean: if sorted.is_empty() {
            None
        } else {
            Some(sorted.iter().sum::<f64>() / sorted.len() as f64)
        },
        median: quantile(&sorted, 0.5),
        p25: quantile(&sorted, 0.25),
        p75: quantile(&sorted, 0.75),
        min: sorted.first().copied(),
        max: sorted.last().copied(),
    }
}

fn build_bins<F>(
    values: &[(f64, bool)],
    bin_count: usize,
    min: f64,
    max: f64,
    label: F,
) -> Vec<CountBin>
where
    F: Fn(f64, f64) -> String,
{
    let safe_bins = bin_count.max(1);
    let safe_min = if min.is_finite() { min } else { 0.0 };
    let safe_max = if max.is_finite() && max > safe_min {
        max
    } else {
        safe_min + 1.0
    };
    let width = (safe_max - safe_min) / safe_bins as f64;
    let mut bins: Vec<CountBin> = (0..safe_bins)
        .map(|index| {
            let start = safe_min + index as f64 * width;
            let end = if index + 1 == safe_bins {
                safe_max
            } else {
                start + width
            };
            CountBin {
                label: label(start, end),
                start,
                end,
                event_count: 0,
                retained_count: 0,
            }
        })
        .collect();

    for &(value, retained) in values {
        if !value.is_finite() {
            continue;
        }
        let clamped = value.clamp(safe_min, safe_max);
        let mut index = ((clamped - safe_min) / width).floor() as usize;
        if index >= safe_bins {
            index = safe_bins - 1;
        }
        bins[index].event_count += 1;
        if retained {
            bins[index].retained_count += 1;
        }
    }
    bins
}

fn finish_recorder(name: String, mut acc: RecorderAccumulator) -> RecorderSummary {
    acc.retained_durations
        .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    acc.retained_frequencies
        .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    RecorderSummary {
        recorder_id: name,
        elevation_band: if acc.band.is_empty() {
            "Unassigned".to_string()
        } else {
            acc.band
        },
        file_count: acc.file_count,
        effort_hours: acc.effort_hours,
        event_count: acc.event_count,
        retained_count: acc.retained_count,
        rate_per_hour: if acc.effort_hours > 0.0 {
            acc.retained_count as f64 / acc.effort_hours
        } else {
            0.0
        },
        reviewed_count: acc.reviewed_count,
        review_coverage: if acc.event_count > 0 {
            acc.reviewed_count as f64 / acc.event_count as f64
        } else {
            0.0
        },
        mean_duration_sec: if acc.retained_durations.is_empty() {
            None
        } else {
            Some(
                acc.retained_durations.iter().sum::<f64>()
                    / acc.retained_durations.len() as f64,
            )
        },
        median_duration_sec: quantile(&acc.retained_durations, 0.5),
        median_center_frequency_hz: quantile(&acc.retained_frequencies, 0.5),
    }
}

#[tauri::command]
pub async fn get_ecological_summary(
    session_id: i64,
    db_path: String,
) -> Result<EcologicalSummary, String> {
    let store = batch_core::store::Store::open(Path::new(&db_path))
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    store
        .conn
        .execute_batch("BEGIN DEFERRED")
        .map_err(|e| format!("Failed to start analytics snapshot: {e}"))?;
    let session = store
        .summary(session_id)
        .map_err(|e| format!("Failed to read session: {e}"))?;
    if !matches!(session.status.as_str(), "done" | "failed" | "cancelled") {
        return Err(format!(
            "Analytics require a terminal session; session {session_id} is {}",
            session.status
        ));
    }
    let (context, initial_total_files) = store
        .conn
        .query_row(
            "SELECT COALESCE(effective_device, device), theta_a, theta_b,
                    COALESCE(species_name, 'Unspecified'), f_min_hz, f_max_hz, config_key,
                    initial_total_files
             FROM sessions WHERE id=?1",
            params![session_id],
            |row| {
                Ok((
                    AnalysisContext {
                        device: row.get(0)?,
                        theta_a: row.get(1)?,
                        theta_b: row.get(2)?,
                        target: row.get(3)?,
                        f_min_hz: row.get(4)?,
                        f_max_hz: row.get(5)?,
                        config_key: row.get(6)?,
                    },
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to read analysis context: {e}"))?;
    let files = store
        .list_files(session_id)
        .map_err(|e| format!("Failed to list files: {}", e))?;
    let cached_files = files.len();
    let inventory_verified = initial_total_files.is_some();
    let total_files = initial_total_files
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(cached_files);
    let missing_cached_files = total_files.saturating_sub(cached_files);
    let analyzed_files = files.iter().filter(|file| file.status == "done").count();
    let failed_files = files.iter().filter(|file| file.status == "failed").count();
    let pending_files = files.iter().filter(|file| file.status == "pending").count();
    let in_progress_files = files
        .iter()
        .filter(|file| file.status == "in_progress")
        .count();
    let partial_results = analyzed_files < total_files;

    let events: Vec<AnalyticsEvent> = {
        let mut statement = store
            .conn
            .prepare(
                "SELECT f.path, e.t_start, e.duration, e.center_freq, e.stage_a_conf,
                        e.completeness_score, COALESCE(e.retained, 0),
                        COALESCE(e.review_status, 'unreviewed'), COALESCE(e.source, 'ml'),
                        e.stage_c_label
                 FROM events e
                 JOIN files f ON f.id = e.file_id
                 WHERE e.session_id = ?1 AND f.status = 'done'
                 ORDER BY f.path, e.t_start",
            )
            .map_err(|e| format!("Failed to prepare analytics query: {e}"))?;
        let rows = statement
            .query_map(params![session_id], |row| {
                Ok(AnalyticsEvent {
                    path: row.get(0)?,
                    t_start: row.get(1)?,
                    duration: row.get(2)?,
                    center_freq: row.get(3)?,
                    stage_a_conf: row.get(4)?,
                    completeness_score: row.get(5)?,
                    retained: row.get::<_, i64>(6)? != 0,
                    review_status: row.get(7)?,
                    source: row.get(8)?,
                    stage_c_label: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to read analytics rows: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect analytics rows: {e}"))?
    };

    let mut effort_files_measured = 0;
    let mut effort_files_defaulted = 0;
    let mut max_recording_seconds = 0.0_f64;
    let mut aggregates: BTreeMap<String, BandAccumulator> = BTreeMap::new();
    let mut recorder_aggregates: BTreeMap<String, RecorderAccumulator> = BTreeMap::new();

    for file in files.iter().filter(|file| file.status == "done") {
        let effort = match audio_duration_hours(Path::new(&file.path)) {
            Some(hours) => {
                effort_files_measured += 1;
                hours
            }
            None => {
                effort_files_defaulted += 1;
                DEFAULT_FILE_EFFORT_HOURS
            }
        };
        max_recording_seconds = max_recording_seconds.max(effort * 3600.0);
        let band = band_for_path(&file.path);
        let recorder = recorder_for_path(&file.path);
        let acc = aggregates.entry(band.clone()).or_default();
        acc.file_count += 1;
        acc.effort_hours += effort;
        let recorder_acc = recorder_aggregates.entry(recorder).or_default();
        recorder_acc.band = band;
        recorder_acc.file_count += 1;
        recorder_acc.effort_hours += effort;
    }

    let mut confirmed_events = 0;
    let mut rejected_events = 0;
    let mut manual_events = 0;
    let mut stage_c_labeled_events = 0;
    let mut incomplete_numeric_events = 0;
    let mut retained_durations = Vec::new();
    let mut retained_frequencies = Vec::new();
    let mut activity_values = Vec::new();
    let mut duration_values = Vec::new();
    let mut frequency_values = Vec::new();
    let mut confidence_values = Vec::new();
    let mut completeness_values = Vec::new();

    for event in &events {
        if event.source == "manual" {
            manual_events += 1;
            continue;
        }

        let band = band_for_path(&event.path);
        let recorder = recorder_for_path(&event.path);
        let acc = aggregates.entry(band.clone()).or_default();
        acc.event_count += 1;
        let recorder_acc = recorder_aggregates.entry(recorder).or_default();
        recorder_acc.band = band;
        recorder_acc.event_count += 1;

        match event.review_status.as_str() {
            "confirmed" => {
                confirmed_events += 1;
                recorder_acc.reviewed_count += 1;
            }
            "rejected" => {
                rejected_events += 1;
                recorder_acc.reviewed_count += 1;
            }
            _ => {}
        }
        if event
            .stage_c_label
            .as_deref()
            .is_some_and(|label| !label.is_empty() && !label.eq_ignore_ascii_case("unknown"))
        {
            stage_c_labeled_events += 1;
        }

        if event.t_start.is_none()
            || event.duration.is_none()
            || event.center_freq.is_none()
            || event.stage_a_conf.is_none()
        {
            incomplete_numeric_events += 1;
        }
        if let Some(value) = event.t_start {
            activity_values.push((value, event.retained));
        }
        if let Some(value) = event.duration {
            duration_values.push((value, event.retained));
        }
        if let Some(value) = event.center_freq {
            frequency_values.push((value, event.retained));
        }
        if let Some(value) = event.stage_a_conf {
            confidence_values.push((value, event.retained));
        }
        if let Some(score) = event.completeness_score {
            completeness_values.push((score, event.retained));
        }

        if event.retained {
            acc.retained_count += 1;
            recorder_acc.retained_count += 1;
            if let Some(value) = event.duration {
                acc.retained_durations.push(value);
                recorder_acc.retained_durations.push(value);
                retained_durations.push(value);
            }
            if let Some(value) = event.center_freq {
                recorder_acc.retained_frequencies.push(value);
                retained_frequencies.push(value);
            }
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

    let mut recorders: Vec<RecorderSummary> = recorder_aggregates
        .into_iter()
        .map(|(name, acc)| finish_recorder(name, acc))
        .collect();
    recorders.sort_by(|left, right| {
        right
            .retained_count
            .cmp(&left.retained_count)
            .then_with(|| left.recorder_id.cmp(&right.recorder_id))
    });

    let total_effort_hours = bands.iter().map(|band| band.effort_hours).sum();
    let model_events: Vec<&AnalyticsEvent> = events
        .iter()
        .filter(|event| event.source != "manual")
        .collect();
    let total_events = model_events.len();
    let total_retained_events = model_events.iter().filter(|event| event.retained).count();
    let completeness_unscored_events = model_events
        .iter()
        .filter(|event| event.completeness_score.is_none())
        .count();
    let completeness_unscored_retained_events = model_events
        .iter()
        .filter(|event| event.retained && event.completeness_score.is_none())
        .count();
    let reviewed_events = confirmed_events + rejected_events;
    let retention_rate = if total_events > 0 {
        total_retained_events as f64 / total_events as f64
    } else {
        0.0
    };
    let review_coverage = if total_events > 0 {
        reviewed_events as f64 / total_events as f64
    } else {
        0.0
    };

    let duration_cap = {
        let mut values: Vec<f64> = duration_values.iter().map(|(value, _)| *value).collect();
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        quantile(&values, 0.99).unwrap_or(1.0).max(0.25)
    };
    let (frequency_min, frequency_max) = {
        let mut values: Vec<f64> = frequency_values.iter().map(|(value, _)| *value).collect();
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let low = quantile(&values, 0.01).unwrap_or(0.0);
        let high = quantile(&values, 0.99).unwrap_or(low + 1_000.0);
        if high > low {
            (low, high)
        } else {
            (low - 500.0, high + 500.0)
        }
    };
    let activity_max = max_recording_seconds
        .max(
            activity_values
                .iter()
                .map(|(value, _)| *value)
                .fold(0.0_f64, f64::max),
        )
        .max(60.0);

    let summary = EcologicalSummary {
        session_id,
        session_status: session.status,
        total_files,
        cached_files,
        inventory_verified,
        missing_cached_files,
        analyzed_files,
        failed_files,
        pending_files,
        in_progress_files,
        partial_results,
        total_effort_hours,
        effort_files_measured,
        effort_files_defaulted,
        total_events,
        total_retained_events,
        retention_rate,
        reviewed_events,
        confirmed_events,
        rejected_events,
        review_coverage,
        manual_events,
        stage_c_labeled_events,
        completeness_unscored_events,
        completeness_unscored_retained_events,
        incomplete_numeric_events,
        context,
        duration: distribution_stats(&retained_durations),
        center_frequency_hz: distribution_stats(&retained_frequencies),
        activity_bins: build_bins(&activity_values, 30, 0.0, activity_max, |start, _| {
            format!("{:.1}m", start / 60.0)
        }),
        duration_bins: build_bins(&duration_values, 12, 0.0, duration_cap, |start, _| {
            format!("{start:.2}s")
        }),
        frequency_bins: build_bins(
            &frequency_values,
            12,
            frequency_min,
            frequency_max,
            |start, _| format!("{:.1}k", start / 1_000.0),
        ),
        confidence_bins: build_bins(&confidence_values, 10, 0.0, 1.0, |start, _| {
            format!("{start:.1}")
        }),
        completeness_bins: build_bins(&completeness_values, 10, 0.0, 1.0, |start, _| {
            format!("{start:.1}")
        }),
        recorders,
        bands,
    };
    store
        .conn
        .execute_batch("COMMIT")
        .map_err(|e| format!("Failed to finish analytics snapshot: {e}"))?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

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

        assert_eq!(audio_duration_hours(&path).unwrap(), 1.0 / 60.0);
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

    #[test]
    fn analytics_bins_keep_all_and_retained_counts_aligned() {
        let bins = build_bins(
            &[
                (-0.1, true),
                (0.0, false),
                (0.25, true),
                (0.99, true),
                (1.0, false),
                (1.1, true),
            ],
            4,
            0.0,
            1.0,
            |start, _| format!("{start:.2}"),
        );
        assert_eq!(bins.iter().map(|bin| bin.event_count).sum::<usize>(), 6);
        assert_eq!(bins.iter().map(|bin| bin.retained_count).sum::<usize>(), 4);
        assert_eq!(bins.first().unwrap().event_count, 2);
        assert_eq!(bins.last().unwrap().event_count, 3);
    }

    #[test]
    fn distribution_stats_report_quartiles() {
        let stats = distribution_stats(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(stats.mean, Some(2.5));
        assert_eq!(stats.median, Some(2.5));
        assert_eq!(stats.p25, Some(1.75));
        assert_eq!(stats.p75, Some(3.25));
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
                config_key: "test",
                worker_cmd: None,
                cwd: None,
                localizer_path: None,
                classifier_path: None,
                classifier_c_path: None,
                f_min_hz: None,
                f_max_hz: None,
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
        assert_eq!(summary.session_status, "done");
        assert_eq!(summary.total_files, 2);
        assert_eq!(summary.cached_files, 2);
        assert!(summary.inventory_verified);
        assert_eq!(summary.missing_cached_files, 0);
        assert_eq!(summary.analyzed_files, 2);
        assert_eq!(summary.failed_files, 0);
        assert!(!summary.partial_results);
        assert_eq!(summary.total_effort_hours, 0.5);
        assert_eq!(summary.effort_files_measured, 0);
        assert_eq!(summary.effort_files_defaulted, 2);
        assert_eq!(summary.total_events, 1);
        assert_eq!(summary.total_retained_events, 1);
        assert_eq!(summary.retention_rate, 1.0);
        assert_eq!(summary.manual_events, 0);
        assert_eq!(summary.completeness_unscored_events, 0);
        assert_eq!(summary.incomplete_numeric_events, 0);
        assert_eq!(summary.context.target, "Hume's Leaf Warbler");
        assert_eq!(summary.context.theta_a, 0.5);
        assert_eq!(summary.duration.median, Some(1.0));
        assert_eq!(summary.center_frequency_hz.median, Some(5500.0));
        assert_eq!(summary.activity_bins.len(), 30);
        assert_eq!(summary.confidence_bins.iter().map(|bin| bin.event_count).sum::<usize>(), 1);
        assert_eq!(summary.recorders.len(), 2);
        assert_eq!(summary.bands.len(), 3);
        assert_eq!(summary.bands[0].band, "Low");
        assert_eq!(summary.bands[0].file_count, 1);
        assert_eq!(summary.bands[0].event_count, 1);
        assert_eq!(summary.bands[0].retained_count, 1);
        assert_eq!(summary.bands[0].rate_per_hour, 4.0);

        store
            .conn
            .execute(
                "UPDATE sessions SET initial_total_files=NULL WHERE id=?1",
                params![sid],
            )
            .unwrap();
        let legacy_inventory =
            get_ecological_summary(sid, db_path.to_str().unwrap().to_string())
                .await
                .unwrap();
        assert!(!legacy_inventory.inventory_verified);
        store
            .conn
            .execute(
                "UPDATE sessions SET initial_total_files=2 WHERE id=?1",
                params![sid],
            )
            .unwrap();

        store
            .add_manual_event(
                sid,
                "/path/PSL1_20250619_080000.WAV",
                3.0,
                4.0,
                4_000.0,
                5_000.0,
                "complete",
            )
            .unwrap();
        let with_manual = get_ecological_summary(sid, db_path.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(with_manual.total_events, 1);
        assert_eq!(with_manual.total_retained_events, 1);
        assert_eq!(with_manual.manual_events, 1);
        assert_eq!(with_manual.confirmed_events, 0);
        assert_eq!(with_manual.review_coverage, 0.0);
        assert_eq!(
            with_manual
                .confidence_bins
                .iter()
                .map(|bin| bin.event_count)
                .sum::<usize>(),
            1
        );

        store
            .conn
            .execute(
                "UPDATE events SET center_freq=NULL WHERE session_id=?1 AND source='ml'",
                params![sid],
            )
            .unwrap();
        let with_legacy_null =
            get_ecological_summary(sid, db_path.to_str().unwrap().to_string())
                .await
                .unwrap();
        assert_eq!(with_legacy_null.incomplete_numeric_events, 1);
        assert_eq!(with_legacy_null.center_frequency_hz.median, None);
        assert_eq!(with_legacy_null.total_retained_events, 1);

        store
            .conn
            .execute(
                "UPDATE files SET status='failed' WHERE id=?1",
                params![zero_event_file.file_id],
            )
            .unwrap();
        store.set_session_status(sid, "failed").unwrap();
        let partial = get_ecological_summary(sid, db_path.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(partial.session_status, "failed");
        assert!(partial.partial_results);
        assert_eq!(partial.analyzed_files, 1);
        assert_eq!(partial.failed_files, 1);
        assert_eq!(partial.total_events, 1);

        std::fs::remove_file(&db_path).ok();
    }
}
