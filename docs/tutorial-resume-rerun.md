# Tutorial: Resuming, Re-running and the Results Cache

Batches are long. Laptops sleep, folders grow, thresholds get revised, and the pipeline gets updated. This tutorial explains what the app does in each case so you never lose finished work and never mix results from two configurations.

## Table of contents

1. [Where results live](#1-where-results-live)
2. [Resuming an interrupted run](#2-resuming-an-interrupted-run)
3. [Opening results without processing](#3-opening-results-without-processing)
4. [What makes a session compatible](#4-what-makes-a-session-compatible)
5. [Changing thresholds or the band](#5-changing-thresholds-or-the-band)
6. [Updating the app or the models](#6-updating-the-app-or-the-models)
7. [Adding, removing or replacing recordings](#7-adding-removing-or-replacing-recordings)
8. [Re-processing specific files](#8-re-processing-specific-files)
9. [Starting a folder over](#9-starting-a-folder-over)
10. [Cancelling](#10-cancelling)
11. [Overnight on the command line, review in the app](#11-overnight-on-the-command-line-review-in-the-app)
12. [Cheat sheet](#12-cheat-sheet)

---

## 1. Where results live

Everything is in `batch.db` inside the recording folder you selected. The database holds:

- **sessions** — one row per run with the full configuration it used;
- **files** — one row per recording per session with status `pending`, `in_progress`, `done` or `failed`;
- **events** — the detections, with your review decisions;
- **review_events** — the timing log behind review effort.

A folder can accumulate several sessions. Nothing is deleted when a new one starts.

---

## 2. Resuming an interrupted run

Select the same folder and click **Re-run / Resume Batch**. The app finds the compatible session with the most completed files, resets any file left `in_progress` by the crash to `pending`, and continues. Finished files are not touched.

The Run tab shows the resumed session's counts immediately, including the files done before the interruption.

---

## 3. Opening results without processing

Click **View Existing Results** instead. The most complete session in the folder opens straight into Review and Analytics; no worker starts and the audio is not read again. Use this to hand a finished run to a colleague or to continue curation on a different day.

---

## 4. What makes a session compatible

A re-run resumes a session only when the results it contains would be identical to what a fresh run would produce. The app compares two things:

| Part | What is compared | Changed? |
|---|---|---|
| **Analysis settings** | θ_A, θ_B, species/call name, band low and high, the size and modification time of each model file | new session |
| **Pipeline code** | a content hash of the Python worker and the `birdpipe` modules | new session |
| ignored | processing device, working directory, app version, the app binary itself | resume |

Sessions created by older versions of the app, before code hashing existed, are matched on analysis settings alone.

When nothing compatible exists the app starts a new session and processes every file again. The previous session stays in the database and remains available through **View Existing Results**.

---

## 5. Changing thresholds or the band

θ_A and θ_B are applied after detection, but they are still part of the session identity: changing either starts a new session. That is deliberate. A session's `retained` flags, counts and Analytics all assume one operating point; re-labelling in place would silently invalidate earlier exports and review decisions taken against the old cutoff.

If you only want to *see* what a different cutoff would keep, use the **All detections** scope in Analytics, or export all events and filter on `stage_a_conf` and `completeness_score` yourself. Run `scripts/threshold_sensitivity.py` to test whether a conclusion survives the choice.

---

## 6. Updating the app or the models

- **Model file replaced** (for example after [active learning](tutorial-active-learning.md)): the model identity changes, so the next run is a new session. Keep the old model file if you want to resume the old session later.
- **Pipeline code changed** (a new app release that touches `birdpipe/` or the worker): the code hash changes and the next run is a new session. This is how the duplicate-buzz consolidation fix reached existing folders: re-running produced a clean session rather than editing the old one.
- **App rebuilt without pipeline changes**: the binary is not part of the identity, so the old session resumes.

---

## 7. Adding, removing or replacing recordings

On resume the app re-enumerates the folder and reconciles it with the session:

- **New files** are added as `pending` and processed.
- **Files removed from the folder** are pruned from the session inventory.
- **Files whose contents changed** are reprocessed and their stale detections replaced.

Review decisions on unchanged files are unaffected.

---

## 8. Re-processing specific files

When the selected folder already holds results, a **Previous results cached** panel appears under the folder picker listing the latest session's files with their status.

1. Select files with the checkboxes, or use **All**, **None**, or **Failed** to pick every failed file at once.
2. Click the clear button. Those files and their events are dropped from the session.
3. Click **Re-run / Resume Batch**. Only the dropped files are processed again.

Typical use: a handful of files failed with a timeout on a busy machine. Select **Failed**, clear, re-run.

---

## 9. Starting a folder over

Select **All** in the cache panel and clear. That deletes `batch.db`, including every session, every review decision and the telemetry log. There is no undo; export first if anything in it matters.

A gentler alternative is to leave the database alone and let a changed setting start a new session, which keeps the history.

---

## 10. Cancelling

**Cancel run** on the Run tab sets a stop flag. Files in flight finish or are cut off, the worker processes are killed as a group so nothing keeps running in the background, and the session is marked cancelled. Files that were `in_progress` return to `pending` on the next resume. Analytics stays available for a cancelled session, with a partial-inventory notice.

---

## 11. Overnight on the command line, review in the app

The headless CLI uses the same engine, database and session identity as the app:

```bash
cargo run -p batch-core --bin batch -- \
  --input "/path/to/recordings" \
  --db "/path/to/recordings/batch.db" \
  --device mps \
  --species-name "Hume's Leaf Warbler" \
  --export-csv "/path/to/recordings/events.csv"
```

Point `--db` at `batch.db` inside the input folder and the app will find the session the next morning with **View Existing Results**. Pass the same thresholds and band you would use in the app, or the app will treat the run as a different configuration.

---

## 12. Cheat sheet

| Situation | Do this | Result |
|---|---|---|
| Laptop slept mid-run | Re-run / Resume Batch | continues from the last finished file |
| Show a colleague finished results | View Existing Results | opens Review and Analytics, no processing |
| Try a different θ_B | change it, Re-run | new session, old one kept |
| Installed a new model or app version | Re-run | new session if the pipeline or model changed |
| A few files failed | cache panel → Failed → clear → Re-run | only those files reprocessed |
| Added recordings to the folder | Re-run | only the new files processed |
| Wipe everything | cache panel → All → clear | `batch.db` deleted, no undo |
