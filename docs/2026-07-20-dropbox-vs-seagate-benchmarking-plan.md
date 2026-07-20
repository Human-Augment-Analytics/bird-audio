# Benchmarking Plan: Cloud Storage (Dropbox) vs. External HDD (Seagate)

This plan outlines the methodology and execution steps to benchmark the performance and processing speed of the Bird Audio Analyzer ML pipeline when processing files from two different storage locations:
1. **Dropbox Local Cache (File Provider)**: `/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation`
2. **External HDD (Seagate)**: `/Volumes/Seagate/Sural_AudioMoths/Mid_elevation`

---

## 1. Objectives
- Measure the difference in total execution time and per-file I/O throughput.
- Understand the impact of network-backed cloud virtualization (Dropbox File Provider) vs. physical spinning-disk latency (Seagate HDD) on the YOLO ML inference pipeline.
- Identify whether I/O read operations are bottlenecking the GPU/CPU inference speed.

---

## 2. Key Performance Metrics to Capture
1. **Initialization / Scanning Time**: The time taken to enumerate the files in the directory.
2. **First-File Spooling Time**:
   - **Dropbox**: Latency due to on-demand download trigger (cold read).
   - **Seagate**: Spin-up latency from disk sleep state.
3. **Average Processing Speed (seconds per file / files per minute)**.
4. **Total Elapsed Time** for a fixed batch size (e.g., 20 files).
5. **CPU / GPU Utilization**: Checking if the processor is starved of data (waiting on I/O).

---

## 3. Test Matrix & Scenarios

We will test three distinct scenarios to isolate the performance variables:

| Scenario | Input Location | Storage State | Expected Bottleneck |
| :--- | :--- | :--- | :--- |
| **A. Dropbox (Cold)** | CloudStorage Folder | Online-only (files downloaded on-demand) | Network download latency (highest bottleneck) |
| **B. Dropbox (Hot)** | CloudStorage Folder | Locally pinned / fully cached on SSD | None (SSD speed, near-instantaneous) |
| **C. Seagate HDD** | `/Volumes/Seagate/...` | Physical USB-connected external HDD | Mechanical seek time & USB read speeds |

---

## 4. Step-by-Step Benchmarking Protocol

To keep the comparison fair, we will process a **subset of 20 audio files** from each location using the exact same concurrency and model settings via the headless CLI.

### Phase 1: Preparation
1. Select a folder containing at least 20 `.WAV` files in both locations.
2. Ensure no other heavy tasks are running on your Mac.
3. Create a scratch folder for benchmark databases:
   ```bash
   mkdir -p test_output/benchmarks/
   ```

### Phase 2: Benchmark Runs

#### Run 1: Dropbox (Cold - On-Demand Download)
*Ensure the 20 files are marked as "Online Only" in Finder (cloud icon visible).*
```bash
cargo run -p batch-core --bin batch -- \
  --input "/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation" \
  --db test_output/benchmarks/dropbox_cold.db \
  --concurrency 4 \
  --device mps
```
*   **What this measures**: Speed including cloud synchronization / downloading of files while the pipeline processes them.

#### Run 2: Dropbox (Hot - Locally Cached SSD)
*Right-click the 20 files in Finder and select "Make Available Offline" (green checkmark visible).*
```bash
cargo run -p batch-core --bin batch -- \
  --input "/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation" \
  --db test_output/benchmarks/dropbox_hot.db \
  --concurrency 4 \
  --device mps
```
*   **What this measures**: Baseline SSD read speed under the File Provider API without network overhead.

#### Run 3: Seagate HDD
*Ensure the Seagate external drive is plugged in and awake.*
```bash
cargo run -p batch-core --bin batch -- \
  --input "/Volumes/Seagate/Sural_AudioMoths/Mid_elevation" \
  --db test_output/benchmarks/seagate_hdd.db \
  --concurrency 4 \
  --device mps
```
*   **What this measures**: Physical USB-connected disk reading performance.

---

## 5. Result Analysis & Interpretation

After running, inspect the database results or console outputs:

1. **Compare Total Elapsed Time**: Check the console output for `Finished session in X seconds`.
2. **Review Per-File Latencies in SQLite**:
   Run this SQL query to see the average and standard deviation of file read times:
   ```bash
   sqlite3 test_output/benchmarks/dropbox_cold.db "SELECT avg(elapsed_ms), min(elapsed_ms), max(elapsed_ms) FROM files WHERE status='complete';"
   ```
   Repeat this for `dropbox_hot.db` and `seagate_hdd.db`.

### Expected Results Profile
- **Dropbox (Cold)**: Highly variable. First file might take 5-10s (or more depending on connection speed) to download, causing the GPU/CPU to sit idle.
- **Dropbox (Hot)**: Fastest execution. Reads are done from the internal Mac SSD at >2000 MB/s. ML pipeline runs at full speed.
- **Seagate HDD**: Consistent but slower than SSD. Steady processing speed bottlenecked by the HDD read speed (typically ~100-130 MB/s) and random seek latency (which affects parallel reads).
