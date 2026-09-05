# Tutorial: Reviewing Detections

A hands-on guide to the **Review** workspace: turning a batch of machine detections into a verified dataset quickly, without losing anything you might need later.

[Your First Analysis Session](tutorial-first-analysis.md) introduces Review with the mouse. This tutorial is for the second session onwards, when you have hundreds of events to get through and want to work from the keyboard.

## Table of contents

1. [What you are deciding](#1-what-you-are-deciding)
2. [Loading a file](#2-loading-a-file)
3. [Reading the spectrogram](#3-reading-the-spectrogram)
4. [A keyboard-driven pass](#4-a-keyboard-driven-pass)
5. [Fixing boxes](#5-fixing-boxes)
6. [Adding a call the model missed](#6-adding-a-call-the-model-missed)
7. [Deleting, undoing and redoing](#7-deleting-undoing-and-redoing)
8. [Working a verification queue](#8-working-a-verification-queue)
9. [What gets recorded](#9-what-gets-recorded)
10. [Habits that keep the data clean](#10-habits-that-keep-the-data-clean)

---

## 1. What you are deciding

Every event in Review has a `review_status`:

| Status | Meaning | In a "confirmed only" export? |
|---|---|---|
| `unreviewed` | nobody has looked at it | no |
| `confirmed` | a real call you want in the dataset | yes |
| `rejected` | not a call; kept in the database as a detector error | no |

Two things are **not** part of that decision:

- **Completeness.** The Stage B score says how clean the buzz is, not whether it is one. A faint but real buzz is *confirmed*; an unusually clean insect is *rejected*.
- **Bounds.** A box that is a little wide is still a real call. Confirm it, then tighten it if the measurement matters (section 5).

---

## 2. Loading a file

Open the **Review** tab. The left column lists every recording in the session with its event count; files still processing are greyed out. Use the search box to filter by name.

Click a file. The app decodes the audio and renders the spectrogram; on a 15-minute AudioMoth recording this takes a few seconds and the panel shows **Decoding audio…** then **Generating FFT spectrogram…**. Controls become active when the overlay clears.

The `REVIEWED n/total` counter at the top of the panel tracks progress through the current file. Start with files that have a handful of events, not the busiest one.

---

## 3. Reading the spectrogram

The spectrogram runs from 0 Hz to the analysis band ceiling (11.625 kHz by default) on a linear scale, so the buzz band sits in the upper half. Each event is a bounding box coloured by status: amber unreviewed, green confirmed, red rejected.

Controls above it:

- **Play** plays from the cursor; click the waveform to seek.
- **Zoom** buttons change the pixels per second. Zoom in until a single buzz is a few centimetres wide before judging its shape.
- **Playback rate** down to 0.25×. Slowed down, a buzz is audible on laptop speakers.
- **Mute** for when you are working visually.

A Hume's Leaf Warbler buzz is a **narrow-band** smear roughly between 5 and 9 kHz, 0.3–0.8 s long, often with a slight upward sweep. Wind, handling noise and most insects are **broadband** (energy across all frequencies) or sit in a different band.

---

## 4. A keyboard-driven pass

Press `?` to show the shortcut sheet. The core loop is:

| Key | Action |
|---|---|
| `J` / `↓` | select the next event |
| `K` / `↑` | select the previous event |
| `C` | confirm and move on |
| `X` | reject and move on |
| `U` | reset to unreviewed |
| `N` | jump to the next unreviewed event, wrapping around |

Selecting an event scrolls the spectrogram to it. A typical file goes:

1. Click the file. Press `N` to land on the first unreviewed event.
2. Look, listen if unsure (Play), press `C` or `X`. The selection advances.
3. When the counter reaches `total/total`, click the next file.

Shortcuts are ignored while the cursor is in a text field, so the search box and label editor do not steal keystrokes.

> **Tip:** decide, don't deliberate. If an event needs more than a few seconds, press `U` to leave it unreviewed and come back with the verification queue (section 8) or after you have seen more examples.

---

## 5. Fixing boxes

Duration and centre frequency in every export come straight from the box, so bounds matter for confirmed events.

- **Drag an edge** of the selected box on the spectrogram. Left and right edges move the start and end time; top and bottom move the frequency limits.
- The change is saved immediately through `update_event_bounds`; `duration` and `center_freq` are recomputed.
- Every edit goes on the undo stack (section 7).

Aim for the box to hug the visible energy. Do not stretch it to include a reverberant tail or a second call; add a second box for a second call.

---

## 6. Adding a call the model missed

Click **Draw Bounding Box**, then drag over the call on the spectrogram. You can also drag directly on the spectrogram without pressing the button.

The new event is stored with:

- `source = 'manual'` so it is never confused with detector output;
- `review_status = 'confirmed'` because you just identified it;
- no Stage A or Stage B score, and completeness left **unresolved** rather than guessed.

Manual events appear in confirmed-only exports and in Analytics under manual annotations. They do **not** raise the detector's precision or recall numbers.

> **Caution for inference:** a manual find is opportunistic. Unless every recording was searched systematically, do not add manual events to a rate you intend to compare across sites.

---

## 7. Deleting, undoing and redoing

Delete removes an event row entirely. Prefer **reject** for detector errors: a rejected event still tells you where the model goes wrong and becomes a negative example for [active learning](tutorial-active-learning.md). Delete is for boxes that should never have existed, such as dozens of boxes on a stretch of static.

- Select the box and press `Delete`, `Backspace` or `D`, or use the Delete button in the event table.
- `Cmd/Ctrl+Z` undoes the last box action (delete, add, or bounds edit). A deleted event is restored with its scores intact.
- `Cmd/Ctrl+Shift+Z` or `Cmd/Ctrl+Y` redoes it.

The Undo and Redo buttons above the spectrogram show how many steps are available. The history is per file and clears when you open another file.

---

## 8. Working a verification queue

With hundreds of unreviewed events you cannot check them all, and checking the first fifty in file order does not tell you the detector's precision. Expand **Verification plan** above the spectrogram.

Settings:

| Field | What it does |
|---|---|
| **Threshold θ_A** | the operating point whose precision you want to know; starts at the session's θ_A |
| **Target ±** | the precision half-width you want, for example 0.05 |
| **Strategy** | `random` (uniform sample), `stratified` (proportional across confidence bands), `uncertainty` (closest to the detection threshold first), `completeness` (closest to the quality threshold first) |
| **Queue size** | how many events to list |

Press the compute button. The panel reports:

- **Precision at θ_A** with a Wilson interval, and how many detections have been verified so far. Before any review it says *No verified labels yet* rather than 0.
- **More to reach ±** — the number of additional decisions needed for the target half-width.
- **Estimated time**, measured from your own recorded decisions when telemetry exists, otherwise an assumed pace.
- The **queue**: click an entry to jump to that event, in whichever file it lives. Decide it with `C` or `X`, then click the next.

Use `random` or `stratified` when you want a defensible precision estimate. Use `uncertainty` when you are choosing a threshold and want to see the borderline cases. Recompute after a batch of decisions; the interval tightens as verified labels accumulate.

---

## 9. What gets recorded

Every decision is written to `batch.db` immediately. Alongside the status, the app logs each action to a `review_events` table with a timestamp: confirm, reject, reset, bounds edits, manual adds, deletes, and navigation such as opening a file, playing, seeking, and picking from the verification queue.

Gaps longer than two minutes count as breaks, so the seconds-per-decision figure the verification planner uses reflects real review time. Export the log with the **telemetry** format or `batch --export-telemetry`.

Nothing here is lost when you close the app. Open the same folder with **View Existing Results** and continue.

---

## 10. Habits that keep the data clean

- **Confirm or reject; do not delete detector errors.** Rejections are data.
- **Do not confirm on completeness.** Real and messy is still real.
- **Fix bounds on confirmed events only.** Bounds on rejected events do not matter.
- **Use the queue for precision claims.** File-order review is not a sample.
- **Note the protocol.** If two people review, agree on the buzz definition and the bounds convention first; the label and note fields on each event are there for edge cases.
- **Export confirmed only** for downstream analysis, and keep the full export for error analysis. The [Export Cookbook](tutorial-export-cookbook.md) shows both.
