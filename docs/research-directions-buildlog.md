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

- `cargo test --workspace` — **60 passing, 0 failed** (45 batch-core + 6 integration + 9 app_lib)
- `uv run pytest` — **157 passing, 0 failed** (153 from the three modules below, plus 4 added
  for the band-resolution fix)
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

---

## Not done / honest gaps

- **No real multi-site validation.** Every statistical result demonstrating the models work comes
  from a synthetic 22-recorder database. `data/batch.db` has 2 files from 1 site-day. Nothing here
  says whether P1 or P2 actually hold — only that the machinery is correct.
- **No negative binomial** (statsmodels absent, no dependency added).
- **Effort is assumed uniform at 0.25 h/file**; the DB has no duration column to derive it from.
  `--effort-hours` overrides globally, which is wrong if file lengths vary.
- **The planner does not yet read measured seconds-per-verification from the telemetry table** —
  it takes `--seconds-per-verification` as a flag. Wiring the measured value in is the obvious
  next step and is what makes the effort estimate empirical rather than assumed.
- **No GUI run.** The new Tauri commands were tested through Rust and through their Python CLIs,
  not inside a running app window.
- **`docs/architecture.md` and `docs/batch-app.md` were not updated** for the new table and commands.
- `--sweep` in the planner uses a fixed 0.0–0.9 grid, not configurable from the command line.
