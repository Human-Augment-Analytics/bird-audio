# Benchmarking Results: Dropbox Cloud Storage vs. Seagate External HDD

This document details the benchmarking results comparing the file-read and processing performance of the Bird Audio Analyzer ML pipeline across two storage configurations:
1. **Dropbox Local Cache (File Provider)**: `/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/...`
2. **External HDD (Seagate)**: `/Volumes/Seagate/...`

---

## 1. Test Configuration
- **Audio Files**: 15-minute AudioMoth `.WAV` recordings (~86.4 MB / 86,400,488 bytes each).
- **Execution Device**: Apple Silicon GPU (`mps`).
- **Concurrency**: `1` (single worker to isolate I/O bottlenecking).
- **Test Date**: July 20, 2026.

---

## 2. Benchmark Results

The following table summarizes the performance metrics captured using the automated benchmark script [run_benchmarks.py](file:///Users/leyangloh/dev/bird-audio-pwa/scripts/run_benchmarks.py):

| Benchmark Location | Total Wall Time (s) | Pipeline I/O Time (s)* | Processing Throughput (MB/s) |
| :--- | :--- | :--- | :--- |
| **Seagate HDD (External USB)** | **32.56** | **27.90** | **3.10** |
| **Dropbox Hot (Cached SSD)** | 33.96 | 30.28 | 2.85 |
| **Dropbox Cold (On-Demand Download)** | 37.68 | 33.59 | 2.57 |

*\*Pipeline I/O Time is the exact duration recorded by the Rust backend engine to parse, read, and run ML models on the file.*

---

## 3. Analysis & Key Insights

### A. Seagate External HDD is the Performance Leader
- **Observation**: The Seagate HDD was the fastest configuration, completing in **27.90 seconds** (I/O time).
- **Explanation**: The ML pipeline is GPU-bound, taking approximately 27 seconds of computational time for a 15-minute file. Reading 86.4 MB sequentially from a USB 3.0 HDD takes under a second (~0.7s), which is not a bottleneck. The external drive runs at the full native speed of the Apple Silicon GPU with zero overhead.

### B. Dropbox Hot (Cached SSD) filesystem overhead
- **Observation**: Even when the file was cached locally on the SSD, it took **2.38 seconds longer** (30.28s) than the Seagate HDD.
- **Explanation**: Dropbox runs under Apple’s File Provider API (`~/Library/CloudStorage/`). Reads are virtualized through Dropbox's daemon extension, adding translation and permission checks. Direct block access on `/Volumes/Seagate` is simpler and has lower driver-level latency.

### C. Dropbox Cold network download latency
- **Observation**: The cold download took **5.69 seconds longer** (33.59s) than the Seagate HDD.
- **Explanation**: The read system calls blocked while the Dropbox daemon downloaded the file over the network. This network delay directly starved the GPU worker, increasing processing time.

---

## 4. Recommendations for Large-Scale Analysis

- **Direct External Drive Processing (Recommended)**: For large batches of recordings, processing directly from the external **Seagate HDD** is the fastest and most efficient option. It avoids local SSD wear and bypasses all virtual filesystem layer overhead.
- **Pre-pin Dropbox Files**: If you must process files from Dropbox, right-click the folders in Finder and select **"Make Available Offline"** ahead of time. Running on "Cold" (online-only) files will degrade performance as the pipeline waits on network transfers.
