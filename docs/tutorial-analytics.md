# Tutorial: Reading the Analytics Tab

The **Analytics** workspace answers one question: *what happened in this run?* This tutorial walks through each panel, what it measures, what it cannot tell you, and the patterns that mean a run needs a second look before anyone draws a conclusion from it.

Analytics becomes available once at least one file has finished and updates as the batch progresses, so you can catch a mis-configured run early instead of after an overnight job.

## Table of contents

1. [Run context](#1-run-context)
2. [Retained versus all detections](#2-retained-versus-all-detections)
3. [Data-quality notices](#3-data-quality-notices)
4. [KPI cards](#4-kpi-cards)
5. [Detections by recording offset](#5-detections-by-recording-offset)
6. [Score distributions](#6-score-distributions)
7. [Event shape](#7-event-shape)
8. [Review status](#8-review-status)
9. [Rate by elevation band](#9-rate-by-elevation-band)
10. [Recorder table](#10-recorder-table)
11. [A five-minute run check](#11-a-five-minute-run-check)
12. [From dashboard to analysis](#12-from-dashboard-to-analysis)

---

## 1. Run context

The header lists the species/call target, compute device, θ_A and θ_B, and the frequency band the session ran with. The full configuration is stored with the session in `batch.db`.

Read this first every time. A chart separated from its thresholds is meaningless, and two runs with different θ_B are not comparable on retained counts.

---

## 2. Retained versus all detections

The **Retained** / **All detections** toggle switches every card and histogram between two event sets:

- **Retained** — events that passed both thresholds (`retained = 1`). This is what an export contains by default.
- **All detections** — every consolidated event the detector produced above its internal confidence floor, including those the thresholds removed.

Flip to *All detections* to see what the thresholds took away. A large gap between the two on one recorder, but not others, usually means that recorder has a noise source producing low-confidence candidates. Neither view can show candidates below the detector's internal floor; those were never stored.

---

## 3. Data-quality notices

Notices appear above the cards when the summary rests on something shaky:

| Notice | Meaning | What to do |
|---|---|---|
| unverified inventory | the session is still running or ended early, so file coverage is partial | wait, resume, or say so when reporting |
| failed / missing files | some recordings did not process | check the Run tab's **Failed** filter and the error text; re-run after fixing |
| estimated effort | duration could not be read from some audio files, so a fallback of 0.25 h per file was used | rates on those recorders are approximate |
| invalid numeric rows | events with non-finite bounds or scores were skipped | investigate the file in Review |

A notice does not go away by itself. Either resolve it or carry it into the report.

---

## 4. KPI cards

| Card | What it is | What it is not |
|---|---|---|
| **Files analyzed** | done / total in the session | not a guarantee every file was readable to the end |
| **Recording effort** | summed audio duration in hours, measured from the files where possible | not listening effort |
| **Retained** or **All events** | event count for the current scope | not calls, not birds |
| **Pipeline retention** | retained ÷ all detections | not precision or recall |
| **Review coverage** | share of detector events with a confirm or reject decision | not a representative precision unless reviewed by a sampling plan |
| **Typical retained event** | median duration and centre frequency | describes detector output, not the soundscape |

For a Hume's Leaf Warbler run, a typical retained event around 0.3–0.8 s and 6–7 kHz is normal. A median far from that at one site means the "detections" there are probably something else.

---

## 5. Detections by recording offset

Events pooled by seconds since the start of their file. AudioMoth schedules that begin on the hour produce files with the same structure, so a genuine call pattern should be smooth across the file.

Look for:

- **One bin far above its neighbours** — a transient (gust, handling, a vehicle) hit many files at the same offset, or one file is dominating the count.
- **A drop in the last bins** — some files are shorter than others; fewer files contribute there, so the raw count falls. This is an exposure effect, not a behavioural one.
- **A pile at offset zero** — recorder start-up noise being detected.

Counts here are not normalised by exposure. Use it to find problems, not to describe activity.

---

## 6. Score distributions

Two histograms show the scores behind the thresholds:

- **Stage A confidence** — the detector's confidence for each event. A pile-up just above θ_A, or a mass just below it in *All detections*, means the threshold sits inside a cluster and small changes will move many events.
- **Completeness score** — Stage B's `p(full)` per event. A healthy run shows a bimodal shape: clean buzzes near 1, fragments and noise near 0. A unimodal hump in the middle means the classifier is unsure about most of what it sees, which often means the audio is not what the model was trained on.

Scores are not probabilities of species presence and are not calibrated across sites. Do not compare a mean score between recorders as if it were an abundance index.

---

## 7. Event shape

**Event duration** and **Center frequency** histograms describe the morphology of retained (or all) events. Extreme values are kept in the edge bins rather than dropped, so a spike at the top duration bin is a signal, not an artefact.

Typical uses:

- A cluster of very long events after a threshold change often means two calls were merged; check them in Review.
- A second mode in centre frequency, well away from the buzz band, points at a different sound source that passed the detector.

---

## 8. Review status

The bar shows confirmed, rejected and unreviewed detector events; manual annotations are counted separately because they were never detector output.

Review coverage is a workflow metric. Fifty percent coverage from reviewing the files with the most events is not the same as fifty percent from a random sample. For a defensible precision figure, review with the [verification queue](tutorial-review-curation.md#8-working-a-verification-queue) and report the Wilson interval it gives you.

---

## 9. Rate by elevation band

Retained detections per hour of measured recording effort, grouped by band. Bands are inferred from the recorder prefix in each file path: `PSL` low, `PSM` mid, `PSH` or `H` high. Other naming conventions fall into a single band, and a folder that mixes conventions will look like one band plus "unknown".

This is a descriptive screen. A large difference between bands is worth investigating; it is not evidence of an elevation effect, because band rates pool over site, date, weather, recorder placement and detectability. The formal test lives in `scripts/ecological_analysis.py`, which refuses to fit with fewer than three recorders per comparison.

---

## 10. Recorder table

One row per recorder with band, files, effort, all and retained events, rate per hour, review coverage, and median duration and frequency. Sort by any numeric column and pick which count drives the sort.

Read it top and bottom:

- **Highest rate per hour** — an active site, or a recorder next to running water, a road, or a fence that hums. Open two of its files in Review before believing it.
- **Zero events with plenty of effort** — no birds, or a dead microphone. Play a file.
- **Little effort** — a rate built on one or two files is unstable; do not rank it against recorders with fifty.
- **Estimated effort** is disclosed separately from measured effort so a fallback never hides inside a rate.

---

## 11. A five-minute run check

Do this after the first few files finish, and again when the run ends:

1. Run context shows the thresholds and band you intended.
2. No failed-file notice, or you know why.
3. Typical retained event is in the expected duration and frequency range.
4. Completeness score is bimodal, not a single central hump.
5. Detections by offset has no lone spike.
6. The recorder table has no outlier you cannot explain from the audio.

If any of these fail, fix the cause and re-run before reviewing. Reviewing a bad run is wasted effort.

---

## 12. From dashboard to analysis

Analytics is for checking a run. The analysis itself happens outside the app on an exported dataset:

- Export **confirmed only** (or retained) events with a deployment metadata CSV joined; see the [Export Cookbook](tutorial-export-cookbook.md).
- Test threshold robustness with `scripts/threshold_sensitivity.py`.
- Fit the elevation model with `scripts/ecological_analysis.py --measure-effort`.
- Pin the run with `scripts/run_manifest.py` and emit a reproduction with `scripts/export_protocol.py`.

The app measures **pipeline detection rates**. Abundance, occupancy, calling rate or a causal elevation effect require a study design that models detection probability and addresses confounding; nothing on this tab substitutes for that.
