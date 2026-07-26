# Build log — research-enabling features

Branch `leyang/research-directions`, built 2026-07-26. Companion to
[`research-directions.md`](research-directions.md), which explains *why* each of these exists.

Every claim below is backed by a command that was actually run. Where something was not
verified, it says so.

## Baseline before any change

- `cargo test --workspace` — 48 passing
- `uv run pytest` — 59 passing
- Working tree had `src-tauri/` deleted but uncommitted, which broke the cargo workspace
  (`failed to load manifest for workspace member .../src-tauri`). Restored from git so the
  branch builds. `main` untouched.

## After

- `cargo test --workspace` — **69 passing, 0 failed**
- `uv run pytest` — **203 passing, 0 failed**
- `npx tsc -b` — clean; `npm run build` — clean; `npm run lint` — no new errors from any new file

---

## 1. Ecological inference (`birdpipe/ecology.py`, `scripts/ecological_analysis.py`)

Serves Direction A. Closes the manuscript's two untested predictions.

- Effort-normalized `rate_per_hour` — the metric the manuscript never computed. Effort comes from
  the full `files` table, not the events join, because recorders that produced **zero** retained
  events still contribute survey effort. Omitting them inflates every rate and silently drops the
  low-detection high-elevation sites — biasing P1 in exactly the direction it predicts.
- Recorder is the unit of replication, per the manuscript's own Discussion.
- **P1**: Poisson GLM with `log(effort_hours)` offset via hand-rolled IRLS, plus a Pearson
  dispersion check that auto-selects a quasi-Poisson scale correction when dispersion > 1.2.
  Spearman always reported as a distribution-free fallback. `statsmodels` is not installed and no
  dependency was added, so there is no true negative binomial — quasi-Poisson corrects the standard
  errors but does not ML-estimate a dispersion parameter.
- **P2**: weighted least squares of recorder-mean duration on elevation, weights = n_events, with
  R², t-based CI, and Spearman.
- Honesty guards: below 3 recorders no model is fitted at all (`estimate`, `se`, `p_value` all
  `None`, `n` still reported); below 4 the verdict is forced to INCONCLUSIVE regardless of p.
  `NOT SUPPORTED` is reserved for a *significant effect in the opposite direction*, not for
  non-significance. A missing `elevation_m` maps to `None`, not `0.0` as `export.rs` does — a 0 m
  elevation would corrupt the regression rather than be excluded.

**Verified.** On the real `data/batch.db` with a deployment CSV:

```
recorder_id site_id elevation_m elevation_band n_files effort_hours n_events rate_per_hour duration_mean
   20250611   PSL01   3210.0000            Low       1       0.2500       79      316.0000        1.2311
   20250612   PSH01   3790.0000           High       1       0.2500      137      548.0000        1.2723
[P1] VERDICT: INCONCLUSIVE ... Model not fitted (fewer than 3 recorders ...), n = 2 recorders.
```

79 + 137 = 216 retained, matching the database exactly — the metadata join loses nothing. With
only 2 recorders it correctly refuses to produce a p-value.

On a synthetic 22-recorder gradient (7 Low / 8 Medium / 7 High, unequal effort, planted log-rate
slope −0.006/m and duration slope −0.00025 s/m) both planted effects were recovered with the
correct sign and magnitude: quasi-Poisson slope −0.005806, 95% CI [−0.006260, −0.005352],
p = 4.1e−17, dispersion 2.05; WLS duration slope −0.000276, R² = 0.834, p = 3.0e−09.

**Measured survey effort.** Effort was originally assumed uniform at 0.25 h per file. That biases
every rate whenever recordings differ in length — truncated files from a full SD card or a flat
battery are routine in PAM, and the `files` table has no duration column to correct from.
`--measure-effort` now reads each file's true duration from its audio header (a header-only
`soundfile.info` read, effectively instant), falls back to the assumed value per unreadable file,
and **reports the split** rather than hiding it:

```
Event set: retained events   effort: measured from audio headers (2 read, 0 fell back to 0.25 h)
```

On the real recordings the measured and assumed values agree exactly (both files are 900.0 s =
0.25 h), which is the correct outcome and confirms the measurement path rather than contradicting it.

**Fix applied on review:** `elevation_band` was derived from the recorder-ID prefix only, so a
deployment whose recorder IDs are timestamps (`20250611_080000`) but whose sites are named by band
(`PSL01`) reported every recorder as `Unassigned`. Added `resolve_band()` — declared column, then
recorder ID, then site ID — with 4 tests. The band columns above are the result.

## 2. Threshold sensitivity (`scripts/threshold_sensitivity.py`)

Serves Direction A. Closes "sensitivity checks needed for downstream ecological inference" (§8.1).
This is the novel methodological contribution: *does the ecological conclusion survive the
detector's threshold choices?*

Sweeps a θ_A × θ_B grid, recomputes retention on the fly, refits P1 and P2 in every cell, and
reports verdict stability, slope range, sign flips, and band-ordering stability.

**Verified** on the synthetic gradient — 36 cells, retained events 286–2683:

```
[P1] modal verdict : SUPPORTED in 100% of cells ; slope range -0.006599 to -0.005580 ; sign flips: no
[P2] modal verdict : SUPPORTED in 100% of cells ; slope range -0.000304 to -0.000180 ; sign flips: no
Band ordering by rate/hour: Low>Medium>High in 100% of cells
STABILITY: conclusions are invariant across the whole threshold grid
```

On the real 2-recorder database it instead prints:

```
STABILITY: no grid cell produced a fittable model (2 recorders with a known elevation)
           -- the sweep is uninformative, not stable
```

That distinction matters and was a deliberate correction: an earlier version reported "conclusions
are invariant across the whole threshold grid," which was vacuously true because every cell was
INCONCLUSIVE. Uniform un-fittability is not stability.

## 3. Verification-effort planner (`birdpipe/verification.py`, `scripts/verification_planner.py`)

Serves Direction B. This is the unclaimed white space — no surveyed tool plans verification effort
or tells the reviewer when to stop.

- Wilson score intervals (correct at small n and near p = 0 or 1, unlike the normal approximation).
- `required_sample_size` by bisection on the Wilson half-width, with finite-population correction
  against the pool above threshold.
- Four review-queue strategies: `random` (the baseline a study compares against), `stratified`,
  `uncertainty` (closest to the decision threshold), and `completeness` (closest to θ_B — the one
  no other tool can have, because no other tool models completeness separately from identity).
- A stopping rule with human-readable reasons.
- **Precision with zero verified labels is `None`, not `0.0`** — the code never implies zero
  precision when it means no data.
- Manual events (`source='manual'`) are excluded from detector precision.

**Verified** on the real database, cold start at threshold 0.6, completeness strategy:

```
Detector detections above threshold : 250
Precision : no verified labels yet - cold start, precision is unknown (not zero)
Next 3 to review (strategy=completeness, seed=0):
  event 142  conf=0.8810  completeness=0.6092
  event 145  conf=0.8609  completeness=0.4353
  event 144  conf=0.8819  completeness=0.6311
```

Those are the three events nearest θ_B = 0.530306 — the ordering is correct.

Warm start, after labelling 30 confirmed / 6 rejected detector events on a copy:

```
Verified so far : 36 (30 confirmed, 6 rejected)
Precision       : 0.833  [0.681, 0.921]  (+/-0.120 at 95%)
More verifications needed : 27      Estimated human time : 3.6 min at 8.0 s/clip
Stopping rule   : CONTINUE
  Half-width 0.1201 exceeds the 0.0800 target after 36 verifications; 214 detections remain unreviewed.
```

The interval is correctly asymmetric, and the 8 pre-existing *manual* confirmations were excluded
from the 30.

### In the app, not just the CLI

The planner is the instrument Direction B's study depends on, so it now has a **Verification panel**
in Review mode (`src/components/VerificationPanel.tsx`), backed by a `run_verification_plan` Tauri
command that shells out through the same `uv run` machinery as the other Python-backed commands.
It shows the precision interval, the remaining verifications and estimated time, the stopping-rule
verdict, and the next queue — each queued event clickable to select it. Requesting a plan and
picking from the queue are logged as telemetry, so the study can measure whether planned review
actually beats reviewing by confidence rank.

Two display rules are enforced because getting them wrong would misreport the science:
**precision renders as "unknown, not zero" when nothing is verified** (never `0%`), and the pace is
always labelled with its provenance — measured, supplied, or assumed.

All three branches were exercised against real databases:

```
cold start : precision.point = None   pace = assumed              stopping_rule = CONTINUE
warm start : precision.point = 0.833 CI [0.681, 0.921]
             pace = measured (n_decisions = 6)                    stopping_rule = STOP
             "Target met: 36 verified give a 95% half-width of 0.1201 (target 0.2000)"
```

The panel itself was **not exercised in a running Tauri window** — correctness here rests on the
Rust tests, the TypeScript compile, and the verified JSON contract, not on having seen it render.

### Closing the loop: measured effort

`measured_seconds_per_verification()` reads the review telemetry (§5) and returns the median
seconds per *decision*, excluding navigation actions and any dwell above the idle cutoff. The
planner uses it automatically; an explicit `--seconds-per-verification` flag still wins, and with
too few recorded decisions it falls back to the nominal 8 s and **says so** rather than presenting
an assumption as a measurement.

This is what makes the effort estimate empirical. Verified across all three paths:

```
no telemetry   : 20.1 min at  8.0 s/clip (assumed - no review telemetry recorded yet)
with telemetry :  5.4 min at 12.0 s/clip (measured from 6 recorded decisions)
explicit flag  :  1.4 min at  3.0 s/clip (supplied on the command line)
```

## 4. Run provenance (`birdpipe/provenance.py`, `scripts/run_manifest.py`)

Serves both directions. Closes "motivates future consolidation into a standardized execution
protocol" (§8.1).

Captures model SHA-256 digests, every Table A.6/A.8 constant flattened to dotted keys, tracked
package versions, git commit/branch/dirty state, and the session config. `--compare` diffs two
manifests and returns a non-zero exit when weights or constants differ, so it can gate CI.

**Verified** against the real database and real 51 MB / 26 MB checkpoints:

```
$ run_manifest.py --db ... --out m1.json
Session 1: 260 events, 216 retained, theta_a=0.0 theta_b=0.530306

$ run_manifest.py --compare m1.json m2.json          # identical
Manifests are identical (ignoring timestamps).                       exit=0

$ run_manifest.py --compare m1.json m2.json          # theta_b tampered to 0.75
  constants.stage_b.theta_b   A: 0.530306   B: 0.75
NOT REPRODUCIBLE: model weights or pipeline constants differ.        exit=1
```

Environment drift alone (a torch version bump) is reported as a difference but does **not** mark
the run irreproducible — only weights and constants do.

## 5. Review telemetry (`batch-core/src/store.rs`, `src-tauri/src/commands.rs`, `export.rs`)

Serves Direction B. The app recorded *what* a reviewer decided but nothing about the *cost* of
deciding, so verification effort was unmeasurable — which is the dependent variable of the whole
CHI direction.

New `review_events` table via an idempotent `ensure_review_telemetry` migration, following the
existing `ensure_curation_columns` pattern. Per-action rows with `dwell_ms` computed against the
previous row in the same session. Aggregates drop any dwell above an idle cutoff (default 120 s)
so an overnight gap is not counted as review time. Decisions are `confirm`/`reject`/`reset` only,
so play/seek navigation does not dilute per-decision cost.

Wired into `set_event_review`, `update_event_bounds`, `add_manual_event`, `delete_event`, plus new
`log_review_action` and `get_review_telemetry` commands. Exportable via `export_session(fmt:
"telemetry")` and `batch --export-telemetry`.

**Telemetry is strictly best-effort**: a failed insert can never fail a curation operation. There
is a test that proves it by corrupting the `review_events` schema so the INSERT fails — the
`review_status` still lands and zero telemetry rows are written.

## 6. Keyboard-driven review (`src/reviewShortcuts.ts`, `ReviewView.tsx`)

Serves Direction B. No keyboard shortcuts existed; review throughput was floor-limited by the
mouse, which would have confounded any effort measurement.

`J`/`K`/arrows navigate, `C` confirms and advances, `X` rejects and advances, `U` resets, `N` jumps
to the next unreviewed (wrapping, so skipped events are still reached), `?` toggles help. Suppressed
while typing in an input. A `REVIEWED n/total` counter was added. Every keyboard decision emits a
telemetry action.

**Verified** by compiling the module standalone and asserting the pure navigation functions —
12/12 assertions covering forward/backward stepping, clamping at both ends, the no-selection case,
empty lists, unreviewed-skipping, and wraparound. Typecheck and production build clean.

## 7. Previously stubbed commands (`src-tauri/src/active_learning_commands.rs`)

`run_pcen`, `run_active_learning`, and `run_qbe_search` returned `Err("Not implemented")`. They now
shell out to the existing Python CLIs through the same `find_uv()` / `resolve_cwd()` machinery as
`check_health`, capturing stderr into the error so failures are diagnosable.

**Verified live**: `run_qbe_search` returned 3 parsed matches against the real database;
`run_pcen` exited 0 on a real 86 MB recording; `active_learning.py` generated 216 clips with the
exact flag set the command emits.

These ship because they make the tool usable — but per the landscape survey they are **not**
publishable novelty. BirdNET-Analyzer already has embedding search and perch-hoplite already has
margin-based active learning.

## 8. Analysis-target UI (`SetupView.tsx`, `src/types.ts`, `src/api.ts`)

Serves the **MEE generality requirement**: "Papers describing methods that apply only to a single
taxon or ecosystem are unlikely to meet these criteria."

The backend has supported dynamic species name, frequency band, and per-session model paths since
July 2026 — `StartOpts` in `src-tauri/src/commands.rs` carries `localizer`, `classifier`,
`classifier_c`, `f_min_hz`, `f_max_hz`, `species_name`, and forwards them to the worker. But the
TypeScript `StartOpts` did not declare those fields and no UI exposed them, so from a user's point
of view the tool was hard-wired to one species. The generality claim was true in the code and false
in the product.

Added an "Analysis target" disclosure: species/call type, frequency band low/high, and file pickers
for the Stage A, Stage B, and Stage C models, each with a Reset. **Blank means "use the pipeline
default"** — the UI sends `null` rather than guessing a value, so unmodified sessions behave exactly
as before. Band bounds are validated (low must be below high) before the session starts.

Also wired `check_health` to receive the chosen model paths. The Rust command already accepted and
validated `localizer`/`classifier`/`classifier_c`, but the frontend only ever passed `cwd` — so
selecting a custom model would report the *bundled* models as healthy and then fail at run time.
The health panel now re-checks whenever a model path changes.

Verified: `npx tsc -b` clean, `npm run build` clean, and no new lint errors (the two reported in
`SetupView.tsx` are pre-existing, at lines 44 and 81).

**The dynamic band was verified to actually change the analysis**, not merely to be accepted as a
parameter. Same recording, two runs:

```
default 4125-11625 Hz : 66 events, 53 complete ; f_low 4618-6898 Hz, f_high 8321-9636 Hz
narrow  6000-9000  Hz : 68 events, 56 complete ; f_low 6508-7236 Hz, f_high 7812-8276 Hz
```

Under the narrowed band every detection falls inside 6000–9000 Hz, and the detection set differs
because a different band produces a different spectrogram. This is the evidence behind the
taxon-generality claim: the pipeline really is retargetable, not hard-wired to one call type.

## 9. Reproducible protocol export (`birdpipe/protocol.py`, `scripts/export_protocol.py`)

**This is the MEE submission gate.** Their Applications guidelines will not review a GUI-only tool
"unless [it is] also able to export executable scripts that allow for reproducibility of their
graphical, statistical, or analytical outputs."

Given a completed session, `export_protocol.py` emits `reproduce.sh`, `protocol.json`, and a
reference `manifest.json`. The script re-runs the pipeline at the recorded thresholds and device,
re-exports, and runs the ecological analysis, sensitivity sweep, and verification plan — with a
preflight step that recomputes the provenance manifest and **stops unless model digests and paper
constants match the recorded run**.

Design decisions worth knowing:

- The rerun writes to a **fresh** `reproduce.db`, never the source database — re-running into
  `data/batch.db` would mutate the very evidence the protocol documents.
- Shebang is `#!/usr/bin/env bash` rather than `#!/bin/sh`, because `set -euo pipefail` was required
  and `pipefail` does not exist in dash; a `/bin/sh` shebang would abort on line one for a Linux
  reviewer. The body is otherwise POSIX and passes `sh -n`.
- Optional steps are guarded so a missing input skips rather than aborting.
- Multi-root sessions are flagged by `verify_protocol`, not silently mishandled.

**Verified** against the real `data/batch.db`: 7 steps generated, `sh -n` and `bash -n` both exit 0,
and — the test that matters most — a run with an output directory containing both a space and an
apostrophe still passes `sh -n`, because every path goes through `shlex.quote`. 24 unit tests,
including one that recovers the original path by round-tripping the generated argv through
`shlex.split`. The generated script was syntax-checked but never executed end to end.

It also correctly warned on its own generation: *"git tree was dirty at commit f272de3: the script's
code state is not fully described by that commit."*

### The end-to-end run, and what it exposed

The generated script was then **executed end to end** — all 7 steps, exit 0, producing
`reproduce.db`, `events.csv`, a valid 187-row `events.json`, `telemetry.csv`, the ecology summaries,
the sensitivity grid, and the verification plan.

**But it did not reproduce the original session.** At identical thresholds
(θ_A = 0.0, θ_B = 0.530306), and with the manifest preflight *passing*:

| | events | retained |
|---|---|---|
| original `data/batch.db` (recorded 2026-06-22) | 260 | 216 |
| reproduction | 187 | 153 |

This is a genuine limitation of the provenance design, and it is worth stating plainly because it
would otherwise be an invisible false assurance:

> **The manifest is built retrospectively from the current environment, not captured when the
> session ran.** So the preflight compares "today's code" against "today's code" and always matches.
> It can detect that *you* changed a model or a constant between generating and running the script.
> It cannot detect that the *original run* used an older pipeline — which is exactly what happened
> here, since `data/batch.db` predates subsequent consolidation changes.

`verify_protocol` now emits this as a warning on every session that lacks a stored manifest:

```
session stored no run manifest: the preflight compares the rerun against the CURRENT code and
constants, so it cannot detect that the original run used a different pipeline version. Event
counts may differ from the recorded session even when the preflight passes.
```

### The fix, and the second trap inside it

**Run-time capture now exists.** The Python worker — the only process that knows which weights it
actually loaded — builds a manifest and ships it on its `ready` line, carrying the real model paths
plus the effective device, band, and species. The Rust engine stores it on the session row through
an idempotent `ensure_run_manifest_column` migration, **write-once**: workers respawn after crashes
and a pool has several, so the first manifest wins and a later respawn cannot overwrite the record
of what the session started with. Manifest construction can never prevent a worker from starting
(a failure degrades to `manifest: null` plus a stderr warning), and a storage failure is logged and
ignored — a provenance problem must not kill a multi-hour batch.

Verified end to end: a fresh run stored a 2,516-byte manifest carrying the localizer digest
`edb569d7…37de`, `extra.device=mps`, and the git commit.

**The second trap:** capturing the manifest silences the warning, but the preflight was still
comparing against a manifest *rebuilt at export time* — so the warning would have disappeared while
the check remained today-vs-today. That is the same false assurance one level deeper, and it would
have been easy to ship. The reference manifest is now the **recorded** one whenever a session has
it, and the compare step's own description states which baseline it is using:

```
old session : "Compare against a manifest rebuilt at export time - this CANNOT detect that the
               original run used different code"
new session : "Stop unless model weights and constants match the manifest recorded when the
               session ran"
```

### Capstone: the loop closes

A session run *after* manifest capture, exported and then reproduced through its own generated
script, end to end:

```
Session 1 complete: 2 ok, 0 failed, 187 events (153 complete, 153 retained)
manifest stored: 2517 bytes
export_protocol: No warnings: inputs, models and git state are all present.
  step 2 — "Stop unless model weights and constants match the manifest recorded when the session ran"

$ bash reproduce.sh        SCRIPT_EXIT=0
Manifests are identical (ignoring timestamps).
Session 1 complete: 2 ok, 0 failed, 187 events (153 complete, 153 retained)
Exported 187 event rows to events.csv / events.json

original    187 events / 153 retained
reproduced  187 events / 153 retained
```

The preflight now passes against the manifest **recorded when the session ran**, not one rebuilt
from today's environment, and the reproduction matches the original exactly. Compare this with the
pre-fix run at the top of this section, which silently produced 187/153 against an original 260/216
while reporting success. That contrast is the whole point.

Comparing a worker-captured manifest against a fresh rebuild initially produced 16 spurious diffs,
all in the `session` block — a worker records no session block because the session row is not yet
populated. Descriptive sections (`session.*`, `extra.*`) are now excluded from the diff, since
neither determines pipeline behaviour, while a weight or constant change still surfaces. The same
comparison now reports *"Manifests are identical"*, which is a real reproducibility signal rather
than noise.

### Closing the export hole this exposed

The protocol export surfaced a real reproducibility gap: `batch-core`'s CLI could only write CSV,
while `export_json` and the `complete_only` / `confirmed_only` / metadata-join filters were reachable
**only through the Tauri command layer**. A generated script therefore could not reproduce a GUI JSON
or filtered export — which is precisely what MEE asks for.

Added `--export-json`, `--complete-only`, `--confirmed-only`, and `--metadata` to
`batch-core/src/bin/batch.rs`, reusing the existing `export_json` function rather than duplicating it.

**Verified** on real data: JSON export produced 153 valid rows, and `--complete-only` filtered 187
events down to 153, exactly matching the pipeline's own reported complete count.

---

## Not done / honest gaps

- **No real multi-site validation.** Every statistical result demonstrating the models work comes
  from a synthetic 22-recorder database. `data/batch.db` has 2 files from 1 site-day. Nothing here
  says whether P1 or P2 actually hold — only that the machinery is correct.
- **No negative binomial** (statsmodels absent, no dependency added).
- **Multi-root sessions** in the protocol export emit one run step per root but the export step
  covers only the first; `verify_protocol` warns. Untested against real data (the real DB has one root).
- **No GUI run.** This is the largest untested surface. The new Tauri commands and the Verification
  panel were verified through Rust tests, the TypeScript compile, and their Python CLIs — but no
  Tauri window was ever launched, so nothing here has been *seen* working. Specifically unexercised:
  the panel's rendering and collapse behaviour, the keyboard shortcuts inside the real app, and
  clicking a queued event whose recording is not the one currently open (that case sets `selectedId`
  but does not switch files, and is surfaced to the user as a note rather than handled).
- **A resumed session keeps the manifest from its original run**, by design of the write-once rule.
  That correctly records what the session started with, but leaves no record if a resume happens
  under changed code.
- **Every worker spawn builds its own manifest**, hashing ~77 MB of weights and shelling out to git.
  Invisible at concurrency 1 inside model-load time; at high concurrency each worker pays it once.
- `--sweep` in the planner uses a fixed 0.0–0.9 grid, not configurable from the command line.
- **Windows path handling** for the app-supplied `dbPath` was not tested.
