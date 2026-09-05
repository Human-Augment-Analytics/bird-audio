# Export Cookbook

Get your Bird Audio Analyzer data into your analysis tools. Every snippet is copy-paste ready.

---

## Table of Contents

- [1. Choosing the Right Format](#1-choosing-the-right-format)
- [2. Export Options Explained](#2-export-options-explained)
- [3. Loading into Raven Pro](#3-loading-into-raven-pro)
- [4. Loading into R with warbleR](#4-loading-into-r-with-warbler)
- [5. Loading into Python with pandas](#5-loading-into-python-with-pandas)
- [6. Loading into Python with librosa](#6-loading-into-python-with-librosa)
- [7. Visualization Recipes](#7-visualization-recipes)
- [8. Working with the Deployment Metadata Join](#8-working-with-the-deployment-metadata-join)
- [9. Headless CLI Export](#9-headless-cli-export)
- [10. Column Reference](#10-column-reference)

---

## 1. Choosing the Right Format

```
What are you doing?
│
├─ Opening in Cornell Raven Pro?  →  Raven Selection Table (.txt)
│
├─ Using R + warbleR?             →  warbleR CSV (.csv)
│
├─ Using Python / pandas?         →  CSV (.csv) or JSON (.json)
│
├─ Building a custom pipeline?    →  JSON (.json)
│
└─ Just exploring the data?       →  CSV (.csv)
```

| Format | Extension | Separator | Best For |
|---|---|---|---|
| CSV | `.csv` | comma | Spreadsheets, pandas, general analysis |
| JSON | `.json` | — | Programmatic access, nested tooling |
| warbleR CSV | `.csv` | comma | R's `warbleR` / `Rraven` packages |
| Raven Selection Table | `.txt` | tab | Cornell Raven Pro / Raven Lite |

---

## 2. Export Options Explained

### Format & Filter panel

After analysis completes, the **Export Options** card appears with three controls:

#### Confirmed only

Exports only events whose `review_status` is `"confirmed"` — events a human has verified in the review interface.

| Scenario | Use it? |
|---|---|
| Publishable dataset, ground-truthed labels | ✅ Yes |
| Exploratory analysis, checking detector performance | ❌ No — keep all events |
| Training a downstream classifier | ✅ Yes — cleaner labels |

#### Complete only

Exports only events where `completeness_label` is `"complete"` — clean, full buzzes that passed Stage B quality scoring.

| Scenario | Use it? |
|---|---|
| Acoustic parameter measurement | ✅ Yes — partial buzzes skew measurements |
| Call-rate / activity pattern analysis | ❌ No — you want all detections |
| Comparing sites by detection counts | ❌ No — include all events |

#### Deployment metadata join

Upload a metadata CSV that maps recorder device IDs to site information. The exporter extracts the device ID from each audio filename (e.g. `PSL2` from `PSL2_20250611_080000.wav`) and joins the site columns onto every event row.

**Required metadata CSV format:**

```csv
device_id,site_id,elevation_m,lat,lon,deploy_date
PSL2,site_lowland_02,850,27.1234,88.5678,2025-06-01
PSM5,site_mid_05,1200,27.2345,88.6789,2025-06-01
PSH3,site_high_03,1800,27.3456,88.7890,2025-06-01
```

> [!IMPORTANT]
> The `device_id` column is matched against filename prefixes. Supported patterns:
> - `PSL2`, `PSM5`, `PSH3` — the `PS{L,M,H}N` convention
> - `H1`, `H12` — the `HN` convention
>
> The match is case-insensitive.

When metadata is attached, the export produces **two files**:

1. **`events.csv`** — every event row, with `site_id`, `elevation_m`, `lat`, `lon` columns appended
2. **`events_summary.csv`** — per-site aggregations:

| Column | Description |
|---|---|
| `site_id` | Site identifier from metadata |
| `session_datetime` | Recording session timestamp (`YYYYMMDD_HHMMSS`) |
| `elevation_m` | Elevation in metres |
| `n_events` | Number of events at that site × session |
| `duration_mean` | Mean event duration (seconds) |
| `duration_median` | Median event duration (seconds) |
| `center_freq_mean` | Mean center frequency (Hz) |
| `effort_hours` | Measured WAV/FLAC/MP3 recording effort; unreadable files use the disclosed 0.25 h fallback |

---

## 3. Loading into Raven Pro

The **Raven Selection Table** export produces a tab-separated `.txt` file that Raven Pro reads natively.

### Exported columns

```
Selection	View	Channel	Begin Time (s)	End Time (s)	Low Freq (Hz)	High Freq (Hz)	File	Begin Path
1	Spectrogram 1	1	1.234	1.567	5100.0	6200.0	PSL2_20250611_080000.wav	/data/PSL2_20250611_080000.wav
2	Spectrogram 1	1	4.891	5.102	5000.0	6100.0	PSL2_20250611_080000.wav	/data/PSL2_20250611_080000.wav
```

### Step-by-step

1. **Export** — In Bird Audio Analyzer, select **Raven Table** format and click **Export Session Detections**. Save as `selections.txt`.

2. **Open in Raven** — Launch Raven Pro. Go to **File → Open Selection Table** and navigate to `selections.txt`.

3. **Open audio** — Go to **File → Open Sound Files** and open the corresponding audio file(s). The `Begin Path` column in the selection table provides the full path.

4. **View selections** — Detected events appear as highlighted boxes on the spectrogram. Each box spans from `Begin Time` to `End Time` horizontally and `Low Freq` to `High Freq` vertically.

5. **Measure** — Use Raven's built-in measurement tools to extract additional acoustic parameters (e.g. peak frequency, bandwidth, entropy) from the selected regions.

> [!TIP]
> The `Selection` column provides a sequential 1-based index across all files. If you need per-file selection numbering, sort by `File` then `Begin Time (s)` in Raven's table view.

> [!NOTE]
> The `View` column is always `Spectrogram 1` and `Channel` is always `1`. These are required by Raven's selection table format but don't carry analytical meaning.

---

## 4. Loading into R with warbleR

The **warbleR CSV** export produces a CSV whose columns match the format expected by [`warbleR`](https://cran.r-project.org/package=warbleR).

### Exported columns

```csv
sound.files,selec,start,end,bottom.freq,top.freq
PSL2_20250611_080000.wav,1,1.234,1.567,5.1,6.2
PSL2_20250611_080000.wav,2,4.891,5.102,5.0,6.1
PSM5_20250611_081500.wav,1,2.100,2.430,5.2,6.3
```

- `sound.files` — audio filename (basename only)
- `selec` — selection number, 1-indexed **per file**
- `start` / `end` — time in seconds
- `bottom.freq` / `top.freq` — frequency in **kHz** (warbleR convention)

### Complete R example

```r
library(warbleR)
library(readr)

# ── Load the exported data ──────────────────────────────────────
events <- read_csv("events_warbler.csv")

# Verify the structure
str(events)
# tibble: sound.files <chr>, selec <dbl>, start <dbl>, end <dbl>,
#         bottom.freq <dbl>, top.freq <dbl>

# ── Compute spectral parameters ────────────────────────────────
# 'path' must point to the FOLDER containing the audio files
sp <- spectro_analysis(events, path = "path/to/audio/folder/")
head(sp)

# ── Create catalog of spectrograms ─────────────────────────────
catalog(events,
        path   = "path/to/audio/folder/",
        nrow   = 4,
        ncol   = 3,
        flim   = c(4, 7),        # frequency limits in kHz
        ovlp   = 50,
        mar    = 0.05)

# ── Cross-correlation between selections ───────────────────────
xc <- cross_correlation(events, path = "path/to/audio/folder/")
```

> [!WARNING]
> **Common gotcha: file paths.**
> `warbleR` functions expect `sound.files` to be filenames only (not full paths). The audio files must exist inside the directory you pass to `path`. If your recordings are spread across subdirectories, copy or symlink them into a flat folder first.

> [!TIP]
> You can also use `Rraven::imp_raven()` to import the Raven Selection Table directly into R, if you prefer that format:
> ```r
> library(Rraven)
> sel <- imp_raven(path = ".", files = "selections.txt")
> ```

---

## 5. Loading into Python with pandas

### CSV

```python
import pandas as pd

df = pd.read_csv("events.csv")
print(df.shape)
print(df.columns.tolist())
```

### JSON

```python
df = pd.read_json("events.json")
```

### Quick summary

```python
print(f"Total events: {len(df)}")
print(f"Confirmed events: {len(df[df['review_status'] == 'confirmed'])}")
print(f"Mean duration: {df['duration'].mean():.3f} s")
print(f"Mean center frequency: {df['center_freq'].mean():.0f} Hz")
print(f"Duration range: {df['duration'].min():.3f}–{df['duration'].max():.3f} s")
print(f"Files represented: {df['path'].nunique()}")
```

### Filter to analysis-ready events

```python
# Keep only complete, retained events
retained = df[(df['retained'] == True) & (df['completeness_label'] == 'complete')]
print(f"Retained complete events: {len(retained)} / {len(df)}")
```

### Group by file

```python
per_file = (
    retained
    .groupby('path')
    .agg(
        n_events    = ('duration', 'count'),
        mean_duration = ('duration', 'mean'),
        mean_freq   = ('center_freq', 'mean'),
        total_buzz_time = ('duration', 'sum'),
    )
    .reset_index()
    .sort_values('n_events', ascending=False)
)
per_file.head(10)
```

### Extract filename parts

```python
import re

def parse_filename(path):
    """Extract device_id, date, time from standard filename pattern."""
    basename = path.rsplit('/', 1)[-1]
    m = re.match(r'([A-Za-z]+\d+)_(\d{8})_(\d{6})', basename)
    if m:
        return m.group(1), m.group(2), m.group(3)
    return None, None, None

df['device_id'], df['date'], df['time'] = zip(*df['path'].map(parse_filename))
```

---

## 6. Loading into Python with librosa

Extract audio for individual events and compute acoustic features.

### Load a single event

```python
import librosa
import numpy as np

row = df.iloc[0]
y, sr = librosa.load(row['path'], sr=None,
                     offset=row['t_start'],
                     duration=row['duration'])
print(f"Loaded {len(y)} samples at {sr} Hz ({row['duration']:.3f} s)")
```

### Mel spectrogram

```python
S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128, fmin=4000, fmax=8000)
S_dB = librosa.power_to_db(S, ref=np.max)
```

### MFCCs

```python
mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
print(f"MFCC shape: {mfccs.shape}")  # (20, n_frames)
mfcc_means = mfccs.mean(axis=1)      # one 20-d vector per event
```

### Batch feature extraction

```python
def extract_features(row):
    """Extract a feature vector for one event."""
    try:
        y, sr = librosa.load(row['path'], sr=None,
                             offset=row['t_start'],
                             duration=row['duration'])
        mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13).mean(axis=1)
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr).mean()
        bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr).mean()
        return pd.Series({
            **{f'mfcc_{i}': v for i, v in enumerate(mfccs)},
            'spectral_centroid': centroid,
            'spectral_bandwidth': bandwidth,
        })
    except Exception as e:
        return pd.Series(dtype=float)

features = retained.apply(extract_features, axis=1)
result = pd.concat([retained.reset_index(drop=True), features], axis=1)
```

---

## 7. Visualization Recipes

All recipes assume you have a DataFrame `df` loaded from the CSV export.

### Setup

```python
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

plt.rcParams.update({
    'figure.figsize': (10, 5),
    'figure.dpi': 120,
    'font.size': 11,
})
```

### Call rate over time (events per file)

```python
per_file = df.groupby('path').size().reset_index(name='n_events')
fig, ax = plt.subplots()
ax.bar(range(len(per_file)), per_file['n_events'], color='#2d7d46', width=0.8)
ax.set_xlabel('File index (chronological)')
ax.set_ylabel('Number of events')
ax.set_title('Call Rate Across Recordings')
plt.tight_layout()
plt.savefig('call_rate.png')
```

### Duration distribution

```python
fig, ax = plt.subplots()
ax.hist(df['duration'], bins=50, color='#3a86a0', edgecolor='white', linewidth=0.3)
ax.axvline(df['duration'].median(), color='#e05c5c', linestyle='--', label=f"Median: {df['duration'].median():.3f} s")
ax.set_xlabel('Duration (s)')
ax.set_ylabel('Count')
ax.set_title('Event Duration Distribution')
ax.legend()
plt.tight_layout()
plt.savefig('duration_dist.png')
```

### Frequency distribution

```python
fig, ax = plt.subplots()
ax.hist(df['center_freq'], bins=50, color='#7b68ae', edgecolor='white', linewidth=0.3)
ax.set_xlabel('Center Frequency (Hz)')
ax.set_ylabel('Count')
ax.set_title('Center Frequency Distribution')
plt.tight_layout()
plt.savefig('freq_dist.png')
```

### Confidence vs completeness

```python
complete = df.dropna(subset=['completeness_score'])
fig, ax = plt.subplots()
scatter = ax.scatter(
    complete['stage_a_conf'],
    complete['completeness_score'],
    c=complete['duration'],
    cmap='viridis',
    alpha=0.5,
    s=15,
)
ax.set_xlabel('Stage A Confidence')
ax.set_ylabel('Completeness Score')
ax.set_title('Detection Confidence vs Quality')
plt.colorbar(scatter, ax=ax, label='Duration (s)')
plt.tight_layout()
plt.savefig('conf_vs_complete.png')
```

### Daily activity pattern

If timestamps are encoded in filenames as `YYYYMMDD_HHMMSS`:

```python
import re

def extract_hour(path):
    m = re.search(r'(\d{8})_(\d{6})', path)
    if m:
        time_str = m.group(2)
        hour = int(time_str[:2])
        minute = int(time_str[2:4])
        return hour + minute / 60.0
    return None

df['hour'] = df['path'].map(extract_hour)
# Adjust for event offset within file
df['event_hour'] = df['hour'] + df['t_start'] / 3600.0
df['event_hour'] = df['event_hour'] % 24  # wrap around midnight

fig, ax = plt.subplots()
ax.hist(df['event_hour'].dropna(), bins=48, color='#e6a540', edgecolor='white', linewidth=0.3)
ax.set_xlabel('Hour of Day')
ax.set_ylabel('Number of Events')
ax.set_title('Daily Activity Pattern')
ax.set_xticks(range(0, 25, 3))
plt.tight_layout()
plt.savefig('daily_activity.png')
```

---

## 8. Working with the Deployment Metadata Join

### How the join works

1. You upload a metadata CSV with columns: `device_id, site_id, elevation_m, lat, lon, deploy_date`.
2. For each event row, the exporter extracts a device ID from the audio file path (e.g. `PSM5` from `/data/PSM5_20250611_080000.wav`).
3. It matches the device ID against the `device_id` column (case-insensitive) and appends `site_id`, `elevation_m`, `lat`, `lon` to the event row.
4. A secondary `_summary.csv` is written alongside, aggregated by `(site_id, session_datetime)`.

### Using the summary CSV

```python
summary = pd.read_csv("events_summary.csv")
print(summary.columns.tolist())
# ['site_id', 'session_datetime', 'elevation_m', 'n_events',
#  'duration_mean', 'duration_median', 'center_freq_mean', 'effort_hours']
```

### Call rate by elevation

```python
fig, ax = plt.subplots()
ax.scatter(summary['elevation_m'], summary['n_events'],
           s=summary['effort_hours'] * 40,  # size = effort
           alpha=0.6, color='#2d7d46', edgecolors='white', linewidth=0.5)
ax.set_xlabel('Elevation (m)')
ax.set_ylabel('Number of Events')
ax.set_title('Call Rate by Elevation')
plt.tight_layout()
plt.savefig('elevation_callrate.png')
```

### Standardised call rate (events per hour)

```python
summary['call_rate'] = summary['n_events'] / summary['effort_hours']

site_rates = (
    summary
    .groupby(['site_id', 'elevation_m'])
    .agg(total_events=('n_events', 'sum'),
         total_effort=('effort_hours', 'sum'))
    .reset_index()
)
site_rates['call_rate'] = site_rates['total_events'] / site_rates['total_effort']

fig, ax = plt.subplots()
ax.barh(site_rates['site_id'], site_rates['call_rate'], color='#3a86a0')
ax.set_xlabel('Events per Hour')
ax.set_title('Standardised Call Rate by Site')
plt.tight_layout()
plt.savefig('site_callrate.png')
```

### Mapping call density to GPS coordinates

```python
# Using the event-level export with metadata columns
df = pd.read_csv("events.csv")

site_summary = (
    df.groupby(['site_id', 'lat', 'lon'])
    .agg(n_events=('duration', 'count'))
    .reset_index()
)

fig, ax = plt.subplots(figsize=(8, 8))
scatter = ax.scatter(
    site_summary['lon'],
    site_summary['lat'],
    s=site_summary['n_events'] * 2,
    c=site_summary['n_events'],
    cmap='YlOrRd',
    alpha=0.8,
    edgecolors='black',
    linewidth=0.5,
)
for _, row in site_summary.iterrows():
    ax.annotate(row['site_id'], (row['lon'], row['lat']),
                textcoords="offset points", xytext=(8, 4), fontsize=8)
ax.set_xlabel('Longitude')
ax.set_ylabel('Latitude')
ax.set_title('Call Density by Site')
plt.colorbar(scatter, ax=ax, label='Number of Events')
plt.tight_layout()
plt.savefig('site_map.png')
```

> [!TIP]
> For real maps, use `folium` or `geopandas` instead of raw lat/lon scatter:
> ```python
> import folium
>
> m = folium.Map(location=[site_summary['lat'].mean(), site_summary['lon'].mean()], zoom_start=10)
> for _, row in site_summary.iterrows():
>     folium.CircleMarker(
>         location=[row['lat'], row['lon']],
>         radius=row['n_events'] ** 0.5,
>         popup=f"{row['site_id']}: {row['n_events']} events",
>         color='#e05c5c', fill=True, fill_opacity=0.7,
>     ).add_to(m)
> m.save('site_map.html')
> ```

---

## 9. Headless CLI Export

The batch CLI can run detection and export without the GUI.

### Basic run + export

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db output/batch.db \
  --export-csv output/events.csv
```

### Full options

```
usage: batch --input <folder>
    [--db batch.db]              # SQLite database path (default: batch.db)
    [--device cpu]               # cpu or cuda
    [--concurrency 0]            # 0 = auto-detect
    [--worker-cmd "uv run python scripts/ml_engine.py --worker"]
    [--cwd DIR]                  # working directory for the worker
    [--theta-a 0.0]              # Stage A confidence threshold
    [--theta-b 0.530306]         # Stage B completeness threshold
    [--timeout-secs 600]         # per-file timeout
    [--max-attempts 2]           # retries per file
    [--export-csv out.csv]       # auto-export after completion
```

### Scripting multiple exports from the same database

The `batch.db` SQLite database stores all results. You can re-export without re-running detection by querying the database directly:

```bash
# Export all events
cargo run -p batch-core --bin batch -- \
  --input data/ --db output/batch.db --export-csv output/all_events.csv

# Or query the database directly with sqlite3
sqlite3 output/batch.db <<'SQL'
.headers on
.mode csv
.output confirmed_events.csv
SELECT f.path, e.t_start, e.t_end, e.duration,
       e.f_low, e.f_high, e.center_freq,
       e.stage_a_conf, e.completeness_score,
       e.completeness_label, e.retained,
       e.n_members, e.review_status
FROM events e
JOIN files f ON f.id = e.file_id
WHERE e.review_status = 'confirmed'
ORDER BY f.path, e.t_start;
.quit
SQL
```

> [!TIP]
> The CLI currently exports CSV only. For JSON, warbleR, or Raven formats, use the GUI or query the database with `sqlite3` and post-process.

---

## 10. Column Reference

### Standard CSV / JSON export

| Column | Type | Description |
|---|---|---|
| `path` | string | Full path to the source audio file |
| `t_start` | float | Event start time in seconds from file start |
| `t_end` | float | Event end time in seconds from file start |
| `duration` | float | Event duration in seconds (`t_end - t_start`) |
| `f_low` | float | Lower frequency bound in Hz |
| `f_high` | float | Upper frequency bound in Hz |
| `center_freq` | float | Center frequency in Hz (`(f_low + f_high) / 2`) |
| `stage_a_conf` | float | Stage A detector confidence score (0–1) |
| `completeness_score` | float \| null | Stage B completeness quality score (0–1). `null` if Stage B was not run |
| `completeness_label` | string \| null | `"complete"` or `"incomplete"`. `null` if Stage B was not run |
| `retained` | bool \| null | Whether the event passed the completeness threshold. `null` if Stage B was not run |
| `n_members` | int | Number of member sub-events that were merged into this consolidated event |
| `review_status` | string | `"unreviewed"`, `"confirmed"`, or `"rejected"` |

#### Additional columns when metadata is joined

| Column | Type | Description |
|---|---|---|
| `site_id` | string | Site identifier from the metadata CSV |
| `elevation_m` | float | Site elevation in metres |
| `lat` | float | Latitude (decimal degrees) |
| `lon` | float | Longitude (decimal degrees) |

### warbleR CSV export

| Column | Type | Description |
|---|---|---|
| `sound.files` | string | Audio filename (basename only, not full path) |
| `selec` | int | Selection number, 1-indexed per file |
| `start` | float | Start time in seconds |
| `end` | float | End time in seconds |
| `bottom.freq` | float | Lower frequency in **kHz** |
| `top.freq` | float | Upper frequency in **kHz** |

### Raven Selection Table export

| Column | Type | Description |
|---|---|---|
| `Selection` | int | Sequential selection number (1-indexed, global) |
| `View` | string | Always `"Spectrogram 1"` |
| `Channel` | int | Always `1` |
| `Begin Time (s)` | float | Event start time in seconds |
| `End Time (s)` | float | Event end time in seconds |
| `Low Freq (Hz)` | float | Lower frequency bound in Hz |
| `High Freq (Hz)` | float | Upper frequency bound in Hz |
| `File` | string | Audio filename (basename only) |
| `Begin Path` | string | Full path to the audio file |

### Summary CSV (metadata join)

| Column | Type | Description |
|---|---|---|
| `site_id` | string | Site identifier |
| `session_datetime` | string | Recording session timestamp (`YYYYMMDD_HHMMSS`) |
| `elevation_m` | float | Site elevation in metres |
| `n_events` | int | Number of events in this site × session |
| `duration_mean` | float | Mean event duration (seconds) |
| `duration_median` | float | Median event duration (seconds) |
| `center_freq_mean` | float | Mean center frequency (Hz) |
| `effort_hours` | float | Measured WAV/FLAC/MP3 recording effort; unreadable files use the disclosed 0.25 h fallback |
