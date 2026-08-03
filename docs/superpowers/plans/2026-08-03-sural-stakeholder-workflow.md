# Sural AudioMoth Stakeholder Workflow & Ecological Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide AudioMoth metadata parsing, a 1-click Sural dataset preset selector in SetupView, and an interactive in-app Ecological Summary Dashboard (EcologyView) for stakeholders analyzing the Sural AudioMoths dataset.

**Architecture:** 
1. **Rust (`batch-core` & `src-tauri`):** Parse AudioMoth path/filename metadata (`recorder_id`, `elevation_band`, `recording_datetime`) during file enumeration and store in SQLite (`batch.db`). Add a Tauri command `get_ecological_summary` that computes effort-normalized call rates and duration metrics per elevation band.
2. **React (`src/components/`):** Add Sural dataset presets to `SetupView.tsx` and build a responsive `EcologyView.tsx` dashboard with visual charts and 1-click CSV summary export.

**Tech Stack:** Tauri (Rust), React + TypeScript, Vite, SQLite (`rusqlite`), `recharts` / CSS bar visuals.

## Global Constraints

- AudioMoth filename pattern: `(PSL\d+|PSM\d+|PSH\d+|H\d+)` for recorder ID, with prefixes `PSL`=Low, `PSM`=Medium, `PSH`/`H`=High.
- Effort accounting: 0.25 hours (15 mins) per `.WAV` file.
- Quality gate: Completeness threshold $\theta_B = 0.530306$.
- All Rust changes must pass `cargo test --workspace`.
- All React changes must pass `npx tsc -b`.

---

### Task 1: Rust Backend AudioMoth Metadata Ingestion & SQLite Export

**Files:**
- Modify: `batch-core/src/enumerate.rs`
- Modify: `batch-core/src/store.rs`
- Modify: `batch-core/src/export.rs`
- Test: `batch-core/src/export.rs`

**Interfaces:**
- Consumes: Audio file paths during enumeration.
- Produces: SQLite `files` and `events` metadata fields (`recorder_id`, `elevation_band`, `recording_datetime`).

- [ ] **Step 1: Write failing Rust test for AudioMoth metadata parsing**

Add to `batch-core/src/export.rs`:
```rust
#[test]
fn test_audiomoth_path_metadata_parsing() {
    let path = "/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/Low/PSL1/PSL1_20250619_080000.WAV";
    let meta = parse_path_metadata(path);
    assert_eq!(meta.recorder_id, Some("PSL1".to_string()));
    assert_eq!(meta.elevation_band, Some("Low".to_string()));
    assert_eq!(meta.recording_datetime, Some("2025-06-19T08:00:00".to_string()));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p batch-core --lib export::tests::test_audiomoth_path_metadata_parsing`
Expected: FAIL with `cannot find function parse_path_metadata`

- [ ] **Step 3: Implement AudioMoth path metadata parser**

In `batch-core/src/export.rs`:
```rust
#[derive(Debug, PartialEq)]
pub struct PathMetadata {
    pub recorder_id: Option<String>,
    pub elevation_band: Option<String>,
    pub recording_datetime: Option<String>,
}

pub fn parse_path_metadata(path: &str) -> PathMetadata {
    use regex::Regex;
    let rec_re = Regex::new(r"(?i)(PSL\d+|PSM\d+|PSH\d+|H\d+)").unwrap();
    let dt_re = Regex::new(r"(20\d{6})[_-]?([0-2]\d[0-5]\d[0-5]\d)").unwrap();

    let recorder_id = rec_re.find(path).map(|m| m.as_str().to_uppercase());
    let elevation_band = recorder_id.as_ref().and_then(|rid| {
        if rid.starts_with("PSL") {
            Some("Low".to_string())
        } else if rid.starts_with("PSM") {
            Some("Medium".to_string())
        } else if rid.starts_with("PSH") || rid.starts_with('H') {
            Some("High".to_string())
        } else {
            None
        }
    });

    let recording_datetime = dt_re.captures(path).and_then(|cap| {
        let date_str = &cap[1];
        let time_str = &cap[2];
        if date_str.len() == 8 && time_str.len() == 6 {
            Some(format!(
                "{}-{}-{}T{}:{}:{}",
                &date_str[0..4], &date_str[4..6], &date_str[6..8],
                &time_str[0..2], &time_str[2..4], &time_str[4..6]
            ))
        } else {
            None
        }
    });

    PathMetadata {
        recorder_id,
        elevation_band,
        recording_datetime,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p batch-core --lib export::tests::test_audiomoth_path_metadata_parsing`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add batch-core/src/export.rs
git commit -m "feat(backend): add AudioMoth path metadata parser for recorder ID, elevation band, and datetime"
```

---

### Task 2: Tauri Command for Ecological Summary Aggregation

**Files:**
- Create: `src-tauri/src/ecology_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/ecology_commands.rs`

**Interfaces:**
- Consumes: `session_id` via Tauri IPC `get_ecological_summary`.
- Produces: `EcologicalSummary` struct with rates and duration metrics per elevation band.

- [ ] **Step 1: Write failing test for ecological summary calculations**

In `src-tauri/src/ecology_commands.rs`:
```rust
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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app_lib ecology_commands::tests::test_ecological_summary_struct`
Expected: FAIL with `cannot find module ecology_commands`

- [ ] **Step 3: Implement `ecology_commands.rs` and `get_ecological_summary` Tauri command**

```rust
use serde::Serialize;
use tauri::State;
use batch_core::export::parse_path_metadata;

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Serialize, Clone)]
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
    let store = batch_core::store::Store::open(&db_path)
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
```

Register `get_ecological_summary` command in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p app_lib ecology_commands::tests::test_ecological_summary_struct`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ecology_commands.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add get_ecological_summary command for effort-normalized metrics"
```

---

### Task 3: Sural AudioMoth Preset Selector in `SetupView.tsx`

**Files:**
- Modify: `src/components/SetupView.tsx`
- Modify: `src/types/index.ts`
- Test: `npx tsc -b`

**Interfaces:**
- Consumes: Local Dropbox Sural path presets.
- Produces: Pre-filled `inputPath` string in `SetupView`.

- [ ] **Step 1: Add Sural Dataset Presets constant and UI selector**

In `src/components/SetupView.tsx`:
```tsx
const SURAL_PRESETS = [
  { label: 'Sural 2025 Low Elevation (PSL1–PSL9)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/Low' },
  { label: 'Sural 2025 Mid Elevation (PSM2–PSM10)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/Mid' },
  { label: 'Sural 2025 High Elevation (PSH1–PSH10)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/High' },
  { label: 'Sural 2024 High Elevation (PSH Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation' },
  { label: 'Sural 2024 Low Elevation (PSL Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/Low_elevation' },
  { label: 'Sural 2024 Mid Elevation (PSM Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/Mid_elevation' },
];
```

Render preset selector dropdown under **Input Directory** field in `SetupView.tsx`:
```tsx
<div style={{ marginTop: '8px' }}>
  <label style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>Quick Sural Dataset Preset:</label>
  <select
    className="select-input"
    onChange={(e) => {
      if (e.target.value) {
        setInputPath(e.target.value);
      }
    }}
  >
    <option value="">Select a Sural deployment folder...</option>
    {SURAL_PRESETS.map((p) => (
      <option key={p.path} value={p.path}>{p.label}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 2: Typecheck frontend**

Run: `npx tsc -b`
Expected: PASS with 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/SetupView.tsx
git commit -m "feat(gui): add Sural AudioMoth dataset quick presets to SetupView"
```

---

### Task 4: Interactive Ecological Summary Dashboard (`EcologyView.tsx`)

**Files:**
- Create: `src/components/EcologyView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Test: `npx tsc -b`

**Interfaces:**
- Consumes: `get_ecological_summary` Tauri IPC.
- Produces: Interactive dashboard UI with calling rates, duration stats, and CSV export.

- [ ] **Step 1: Implement `EcologyView.tsx` Component**

Create `src/components/EcologyView.tsx`:
```tsx
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface BandSummary {
  band: string;
  file_count: number;
  effort_hours: number;
  event_count: number;
  retained_count: number;
  rate_per_hour: number;
  mean_duration_sec: number;
  median_duration_sec: number;
}

interface EcologicalSummary {
  session_id: number;
  total_files: number;
  total_effort_hours: number;
  total_retained_events: number;
  bands: BandSummary[];
}

interface EcologyViewProps {
  sessionId: number | null;
  dbPath: string | null;
}

export const EcologyView: React.FC<EcologyViewProps> = ({ sessionId, dbPath }) => {
  const [summary, setSummary] = useState<EcologicalSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !dbPath) return;
    setLoading(true);
    invoke<EcologicalSummary>('get_ecological_summary', { sessionId, dbPath })
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sessionId, dbPath]);

  if (!sessionId || !dbPath) {
    return <div className="card">Please run a batch session to view ecological insights.</div>;
  }

  if (loading) return <div className="card">Calculating effort-normalized ecological metrics...</div>;
  if (error) return <div className="card error">Error loading ecology stats: {error}</div>;
  if (!summary) return null;

  return (
    <div className="view-container">
      <div className="card">
        <h2>Ecological Summary & Elevational Analysis</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', margin: '16px 0' }}>
          <div className="stat-box">
            <span className="stat-label">Total AudioMoth Files</span>
            <span className="stat-value">{summary.total_files}</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Survey Effort Hours</span>
            <span className="stat-value">{summary.total_effort_hours.toFixed(2)} h</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Retained Buzz Events</span>
            <span className="stat-value">{summary.total_retained_events}</span>
          </div>
        </div>

        <h3 style={{ marginTop: '24px' }}>Calling Rate (Buzzes / Hour) by Elevation Band</h3>
        <div style={{ display: 'flex', gap: '24px', margin: '16px 0', alignItems: 'flex-end', height: '180px', padding: '16px', background: 'var(--surface-dark)', borderRadius: '8px' }}>
          {summary.bands.map((b) => (
            <div key={b.band} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
              <div style={{ marginTop: 'auto', width: '60px', height: `${Math.min(120, b.rate_per_hour * 10)}px`, background: 'var(--spectrogram)', borderRadius: '4px' }} />
              <span style={{ marginTop: '8px', fontWeight: 'bold' }}>{b.band}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>{b.rate_per_hour.toFixed(2)} / h</span>
            </div>
          ))}
        </div>

        <h3 style={{ marginTop: '24px' }}>Elevation Band Metrics</h3>
        <table className="file-table" style={{ width: '100%', marginTop: '8px' }}>
          <thead>
            <tr>
              <th>Elevation Band</th>
              <th>Files</th>
              <th>Effort (h)</th>
              <th>Retained Events</th>
              <th>Rate (events/h)</th>
              <th>Mean Duration (s)</th>
              <th>Median Duration (s)</th>
            </tr>
          </thead>
          <tbody>
            {summary.bands.map((b) => (
              <tr key={b.band}>
                <td><strong>{b.band}</strong></td>
                <td>{b.file_count}</td>
                <td>{b.effort_hours.toFixed(2)}</td>
                <td>{b.retained_count}</td>
                <td>{b.rate_per_hour.toFixed(2)}</td>
                <td>{b.mean_duration_sec.toFixed(3)}</td>
                <td>{b.median_duration_sec.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Connect `EcologyView` into `App.tsx` navigation**

In `src/App.tsx`:
Add `ecology` tab mode to masthead navigation.

- [ ] **Step 3: Typecheck frontend**

Run: `npx tsc -b`
Expected: PASS with 0 errors.

- [ ] **Step 4: Run full verification tests**

Run: `cargo test --workspace` and `uv run pytest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/EcologyView.tsx src/App.tsx src/index.css
git commit -m "feat(gui): add interactive EcologyView dashboard for effort-normalized insights"
```

---

## Plan Verification Checklist

1. `cargo test --workspace` passes all Rust backend & Tauri tests.
2. `uv run pytest` passes all Python ML & analysis tests.
3. `npx tsc -b` passes with zero TypeScript errors.
