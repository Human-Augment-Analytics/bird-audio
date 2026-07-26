# Two Research Directions for the Bird Audio Analyzer

Branch: `leyang/research-directions`. Written 2026-07-26.

This document answers one question: **what would make this project a good research paper, in
ecology & evolution or in CHI?** It is grounded in three things — the 46-page manuscript already
in the repo (`ecoinf_hlw_buzz_v2_skeleton.pdf`), a full inventory of what the software actually
does, and a survey of the competing tool landscape as of mid-2026.

---

## 0. Where the project actually stands

### The manuscript is half-finished, and the missing half is the ecology

The in-repo manuscript, *"Event-Level Spectrogram Object Detection and Curation for Avian
Acoustic Analysis"* (Ecological Informatics format), is **methodologically complete and
publishable**. It has:

- A held-out test set of 54 field recordings, 1,081 expert-adjudicated buzz events,
  inter-annotator Krippendorff's α = 0.92.
- Stage A event-level results: AP = 0.9995 and peak F1 = 0.9911 on complete buzzes
  (388/391 recovered, 4 false positives); AP = 0.9600 across all buzzes.
- Retrained AST and YOLO-classification baselines scored under a shared window-level protocol,
  with paired 95% recording-level bootstrap CIs.
- Stage B completeness classifier: P 0.9389 / R 0.9407 / F1 0.9398 / AUCPR 0.9839, θ_B = 0.530306.
- Full parameter documentation (Tables A.6–A.8) and a real corpus: 2,673 h of AudioMoth audio,
  30 sites, 3,171–3,818 m elevation, 2024 and 2025 seasons, 200,737 consolidated events of which
  65,280 were exported as complete-buzz duration records.

**What it does not have is any ecology.** The Introduction states two falsifiable predictions —
(P1) buzzes occur more frequently at lower elevations, (P2) buzzes are longer at lower elevations
— and the paper tests **neither**. There is no GLM, no GLMM, no occupancy model, no regression,
no p-value, no effect size, and no confidence interval on any ecological quantity anywhere in the
document. The only CIs present are the methodological bootstrap CIs on detector AP differences.

The authors say so themselves, three separate times:

> "This section illustrates analysis-ready summaries produced by the finalized two-stage pipeline.
> **It does not present new ecological inference claims.**" (§7.8)

> "We present these outputs as an example data product for downstream ecological modeling,
> **not as a formal ecological test**." (§7.8.2)

> "The ecological summaries are **intentionally presented as data products rather than formal
> ecological inference**." (§8)

What exists instead is a descriptive table (2025 only) that does not obviously support either
prediction. Duration is **non-monotonic** in elevation — Low 1.2823 s < Medium 1.3082 s > High
1.1335 s — and the count column is not effort-normalized at all, so "more frequently" has never
actually been measured. There is no calls-per-hour metric anywhere in the pipeline.

Three further gaps a reviewer will find: the headline Stage B numbers are **validation** numbers
on the same split used for checkpoint selection and threshold calibration (the authors flag this
twice, and there is no held-out Stage B test set); Table 3 reports only *deltas* against the
baselines and omits absolute baseline APs; and no sensitivity analysis exists over θ_A = 0.539,
θ_B = 0.530306, or the ~25 fixed consolidation parameters, despite the Discussion saying such
audits are needed.

Read honestly, the OD-vs-baselines result is also weaker than the abstract implies. Across the
eight comparisons in Table 3, object detection **loses significantly in three**, ties in three,
and wins in **one** (PW|Complete vs AST, +0.0178, CI excluding zero). The Discussion concedes the
real argument is structural rather than performance-based: a window classifier would still need a
second localization step to produce duration and frequency bounds.

### The software is substantial and completely absent from the manuscript

The repo is a working Tauri 2 desktop app plus a Rust orchestration engine plus a Python ML
pipeline: quarter-step streaming Stage A, a five-phase geometry-informed consolidation with a
one-detection-per-window invariant that preserves overlapping vocalizations, Stage B completeness
curation, resumable idempotent SQLite batch runs, a review UI with spectrogram editing and manual
annotation, four export formats including warbleR and Raven selection tables, deployment-metadata
joins with effort-hours accounting, 3-platform CI, and 103 tests.

**The manuscript mentions none of it.** Searching the full text for software, desktop, GUI,
application, open-source, repository, toolkit, usability, user study, or human-in-the-loop returns
nothing. The only tools named are third-party instruments used for annotation (CVAT.ai, Audacity).
The Data Availability statement covers datasets only — no code, no weights, no software DOI.

That is a genuine opportunity: **a companion software paper would not overlap the existing
manuscript at all.** And the manuscript's own limitations section names precisely the gaps such a
tool would fill — "motivates future consolidation into a standardized execution protocol,"
"identify sensitivity checks needed for downstream ecological inference," "annotation effort
requirements."

---

## 1. The novelty constraint: what the landscape has already taken

This is the part that changes the strategy, so it comes before the directions.

**BirdNET-Analyzer already ships a GUI with `analysis, embeddings, search, review, train,
evaluation, segments, species, localization` tabs.** Its Search tab is genuine query-by-example
vector search over a `perch_hoplite` SQLite+usearch vector database. Its Review tab fits a
logistic regression over validated positives/negatives, implementing the Wood & Kahl (2024)
score-calibration procedure as a GUI feature. Separately, `perch_hoplite/agile` already contains
margin-based active-learning sampling, CSV deployment-metadata ingestion, and call-density
estimation implementing "All Thresholds Barred" (arXiv:2402.15360).

So the following claims are **burned** — a reviewer who knows this field will reject them on sight:

| Claim | Verdict |
|---|---|
| First GUI for embedding-based search-by-example in bioacoustics | Already done — BirdNET-Analyzer Search tab |
| Active learning for bioacoustic annotation | Already done — margin sampling in perch-hoplite |
| GUI for calibrating classifier scores on a validated subsample | Already done — BirdNET Review tab |
| Principled estimation from a validated subsample | Already done — All Thresholds Barred |
| Local-first / offline desktop bioacoustics | Already the norm — Raven, AviaNZ, Whombat, Chirpity |
| Annotation tool designed for ML workflows | Whombat owns this (MEE 2025); field is consolidating on it |
| "Integrated end-to-end pipeline" / "Rust for performance" / "YOLO on spectrograms" | Engineering, not contribution |

This kills the two features that looked most attractive in the repo backlog — the
query-by-example search and the active-learning loop. They are worth *shipping* because they make
the tool usable, but they cannot carry a paper.

**What survives as defensible white space:**

1. **Completeness scoring as a stage separate from identity.** Stage B scores `p(full)` — how
   cleanly formed a vocalization is — rather than what species it is. No surveyed tool treats call
   completeness as a first-class, learned, thresholdable output; every other system collapses to
   identity + confidence. This matters because measurement-grade analysis (duration, bandwidth,
   repertoire, acoustic parameters) needs *usable* exemplars, not merely *present* ones, and
   everyone else filters by hand. **This is the strongest claim available and it is uncontested.**

2. **Verification-effort planning as a first-class primitive.** All the statistics exist
   (Wood & Kahl logistic calibration; ATB call density; Chambert false-positive occupancy) but no
   tool answers the question the ecologist actually asks: *"how many more clips must I verify to
   pin precision to ±0.05, and which ones next?"* BirdNET's Review tab fits a curve to what you
   already did; it does not plan effort or tell you when to stop. This is unclaimed, buildable,
   and directly measurable against a random-review baseline.

3. **Provenance that closes the loop.** BirdNET's loop is folder-based — Search exports WAVs to a
   directory, Review sorts them into `Positive/`/`Negative/` subfolders, Train re-reads folders and
   re-extracts embeddings from audio rather than reusing the vector DB. Embeddings get computed up
   to three times and there is no audit trail from raw file → detection → verifier → label →
   exported table. "The loop exists but does not close" is defensible if paired with a measured claim.

The scale of the problem is well documented and citable. The living systematic review
(Hanf-Dressler & Darras 2025, *F1000Research* 15:48) catalogues 221 tools and finds only 92 offer
any data-handling capability; in aquatic PAM work, **custom scripts are the single most-used
"tool" at 25.2%**. Wood & Kahl (2024) note review depth "will be determined by some balance of the
amount of time that can be allocated to manual review and the quality of the data" — with Kelly
et al. (2023) reviewing >30,000 predictions for two species.

---

## 2. Direction A — Ecology & Evolution

### Framing

**"From detections to ecological inference: effort-normalized, completeness-curated, and
threshold-robust."**

Do not write a second methods paper. Write the paper the current manuscript promises and does not
deliver, and make the *methodological* contribution the thing that stands between a detector and a
defensible ecological claim.

The pitch: PAM pipelines emit event counts, and ecologists turn those counts into conclusions by
choosing thresholds nobody audits. This paper (a) actually tests the two elevation predictions
with effort-normalized, recorder-level models, and (b) shows how much the conclusion depends on
the detector's threshold and completeness-curation choices — which no PAM paper currently reports.

### What has to be true for this to be accepted

1. **Effort normalization.** Counts must become rate per recorder-hour. The pipeline already
   tracks 0.25 h per 15-minute file and joins deployment metadata; the metric was simply never
   computed.
2. **The right unit of replication.** Recorder-level, not event-level. The manuscript's own
   Discussion says so: "events from the same recorder share sampling context and are not
   independent observations of elevation." A Poisson or negative-binomial GLM with a
   `log(effort_hours)` offset, or a GLMM with recorder as a random effect across the two seasons.
3. **Both seasons.** The descriptive table uses 2025 only "to keep the illustration readable."
   A real analysis uses 2024 and 2025 with year as a term — that is 2,673 h and 200,737 events.
4. **Threshold sensitivity as a first-class result.** Sweep θ_A × θ_B, refit, and report whether
   the sign and significance of the elevation effect survive. If the conclusion flips inside the
   plausible threshold range, that is a *more* interesting and more honest paper than one that
   reports a single point estimate.
5. **Detector error propagated into the inference.** Precision is not 1.0. A false-positive-aware
   occupancy or count model (Chambert, Miller & Nichols 2015; Chambert et al. 2018 MEE) using the
   verified subsample is the reviewer-proof version.

### A finding that emerged from building this, and is worth a paragraph in the paper

Running a generated reproduction script end to end produced **187 events / 153 retained** against
the original session's **260 / 216** — at identical thresholds, with the provenance preflight
*passing*. The cause is that the manifest was built retrospectively from the current environment
rather than captured when the session ran, so it compared today's code against today's code.

Once the manifest was captured *by the worker at run time* and used as the preflight baseline, the
same flow reproduced the session exactly — 187/153 against 187/153, with the preflight reporting
"Manifests are identical." The before/after contrast is the evidence.

This generalises beyond this codebase. A reproducibility check that reconstructs provenance *after
the fact* cannot detect that the original analysis used different code, and will report a clean bill
of health while the numbers move. Given how much PAM analysis runs through pipelines that evolve
between the run and the write-up, "we recorded the model version and the thresholds" is not
sufficient, and saying so with a worked example is a genuine contribution to the reproducibility
discussion that both MEE and RSEC are actively pushing.

### Risks

- **The result may be null or non-monotonic.** The descriptive numbers already hint at this:
  duration peaks at Medium, and Medium has a far higher median events-per-recorder than Low. A
  null is publishable if the *method* is the contribution and the power analysis is honest — but
  it must be framed that way from the start, not discovered in review.
- **Detection rate confounds calling rate with detectability.** Density, microphone placement,
  vegetation, and wind all vary with elevation. This needs to be addressed explicitly, and is the
  single most likely reviewer objection.
- **Splitting the methods paper.** If the existing manuscript goes out as-is, this paper must not
  duplicate it. Cleanest split: manuscript 1 = detector and curation method; paper 2 = ecological
  inference with threshold-robustness. They cite each other.

### Venue

Ecological Informatics is the current target and remains sensible for the methods manuscript.
For the inference paper, Methods in Ecology and Evolution is the better fit if the threshold-
sensitivity methodology leads; a specialist ecology journal is better if the elevation result leads.

---

## 3. Direction B — CHI / HCI

### Framing

**"Verification is the instrument: budgeting expert attention over machine detections."**

Not "we built a bioacoustics GUI" — that gets desk-rejected. The contribution is that verification
effort is treated as a measurable, plannable, budgetable resource, and the system is the vehicle
for studying it.

The pitch: detectors produce more candidates than experts can check, so every PAM result rests on
an unexamined sampling decision. We instrument expert verification, model precision as a function
of effort with proper intervals, plan which detections to verify next, and tell the reviewer when
to stop. Then we measure whether planned review reaches a target precision in fewer person-hours
than the standard practice of reviewing by confidence rank or at random.

### Why this is a real HCI contribution rather than a tool demo

- The dependent variable is **person-hours to a target confidence interval** — a real, measurable
  quantity that the field currently does not optimize or even record.
- It engages the appropriate-reliance literature directly: an expert deciding *which* model
  outputs to check is calibrating trust under budget, and the stopping rule is an explicit
  intervention on over- and under-reliance.
- The completeness dimension gives a second decision axis (is this event *usable*, not just
  *present*) that no existing interface exposes — so there is genuinely new interaction design,
  not just a queue reordering.

### What has to be true for this to be accepted

1. **Telemetry.** The app previously recorded *what* a reviewer decided but nothing about the
   *cost* of deciding, so verification effort was unmeasurable. This is now instrumented
   (see §4) — per-action timing with an idle cutoff so an overnight gap is not counted as review time.
2. **A baseline condition.** Planned/uncertainty-ordered review vs. confidence-ranked or random
   review, same reviewer, counterbalanced. Without a baseline this is a demo.
3. **Real experts.** A handful of ecologists actually doing their own data. Small-N expert studies
   are publishable at CHI when the task is genuinely specialized and the measurement is careful.
4. **A pre-registered target.** "Reach precision ±0.05" fixes the endpoint before the study, which
   is what makes person-hours comparable across conditions.

### Risks

- **Recruiting enough expert reviewers.** This is the binding constraint, and it is a scheduling
  problem, not a technical one. Start recruiting before building anything else.
- **The IJCAI 2023 paper "A Human-in-the-Loop Tool for Annotating Passive Acoustic Monitoring
  Datasets" (doi:10.24963/ijcai.2023/835) is paywalled and unread.** It is directly on-topic and
  could materially affect claims 2 and 3 above. **Read it through an institutional proxy before
  committing to this direction.** This is the single largest unresolved risk in this document.
- CHI reviewers will ask why this is not just an ML-efficiency result. The answer must be that the
  measured quantity is human time under a human-chosen quality target, not model accuracy.

---

## 4. Recommendation

**Do Direction A first, and build Direction B's instrument now so the option stays open.**

Reasoning:

- Direction A is 80% written. The manuscript's methods, dataset, annotations, and baselines are
  done. What is missing — effort normalization, a recorder-level model, threshold sensitivity — is
  a few hundred lines of analysis code and one honest statistics pass, not another field season.
- Direction A has a deadline advantage: the existing draft is stale (`Author list to finalize`,
  Acknowledgements "To be completed") and every month it sits, BirdNET/Perch move.
- Direction B depends on recruiting expert participants, which cannot be compressed. But its
  instrument — review telemetry — must be running *before* any study, and costs little to add now.
- The two directions share the same substrate: completeness-aware measurement, verified subsamples,
  and provenance. Nothing is wasted.

**Status of the gates, as of this branch:** MEE's script-export requirement is **closed and verified
end to end** — `scripts/export_protocol.py` emits a `reproduce.sh` that reproduced a session exactly
(187/153 against 187/153) with its preflight checking against a manifest recorded when the session
ran. The generality requirement is **closed in the product**, not just the code: the Analysis-target
UI exposes species, frequency band, and per-stage models, and a narrowed band was verified to
actually confine detections. RSEC's "unit tests plus a demonstration dataset a reviewer can run in
minutes" is met by the 203-test Python suite, the 67-test Rust suite, and the two 15-minute
recordings in `data/`. So both venues are now open; the remaining work is scientific, not
architectural.

**Do not** build a general-purpose bioacoustics workbench. That race is lost to BirdNET-Analyzer
and Whombat. The defensible identity of this project is narrow and specific: *a measurement
instrument for a call type, where completeness is modeled separately from identity, and where the
human verification budget is planned rather than improvised.*

---

## 5. What was built on this branch to support the above

See `docs/research-directions-buildlog.md` for the implementation and smoke-test record.

| Feature | Serves | Closes |
|---|---|---|
| Effort-normalized recorder/band summaries + elevation models (P1, P2) | A | The untested Introduction predictions |
| θ_A × θ_B sensitivity sweep with stability verdict | A | "sensitivity checks needed" (§8.1) |
| Run provenance manifest + reproducibility diff | A, B | "motivates ... a standardized execution protocol" (§8.1) |
| Verification-effort planner (Wilson CIs, sample-size, review queue, stopping rule) | B | Unclaimed white space |
| Review telemetry (per-action timing, idle cutoff, export) | B | Verification effort was unmeasurable |
| Keyboard-driven review + progress indicator | B | No shortcuts existed; throughput was floor-limited by the mouse |
| PCEN / active-learning / QBE commands implemented | usability | Three `Err("Not implemented")` stubs |
| Reproducible protocol export (`reproduce.sh` + provenance preflight) | **MEE gate** | GUIs are unreviewable at MEE without executable script export |
| `--export-json` / `--complete-only` / `--confirmed-only` / `--metadata` on the CLI | **MEE gate** | GUI-only export paths a script could not reproduce |
| Analysis-target UI (species, frequency band, per-stage model pickers) | **MEE generality rule** | Single-taxon methods "unlikely to meet these criteria" |

---

## 6. Venue mechanics — including one clause that gates the architecture

### Read this before writing anything: MEE's GUI rule

Methods in Ecology and Evolution Applications guidelines, verbatim:

> "**Packages that allow for execution via point-and-click menus (e.g., Shiny Apps in R or Python)
> or graphical user interfaces (GUIs) will be reviewed only if they are also able to export
> executable scripts that allow for reproducibility of their graphical, statistical, or analytical
> outputs.**"

A Tauri desktop app with no scriptable path **is not reviewable at MEE**. This is an architecture
requirement, not a writing problem. The repo is partway there — `batch-core/src/bin/batch.rs` is a
real headless CLI and the new analysis tools are all CLIs — but the GUI does not currently *emit* a
script that reproduces what it just did. Closing that gap is the single highest-leverage build task
remaining, and it composes well with the provenance manifest already built.

Second binding MEE rule, and it is a problem for a Hume's-Leaf-Warbler-specific tool:

> "Papers describing methods that apply only to a single taxon or ecosystem are unlikely to meet
> these criteria."

Frame as taxon-agnostic PAM tooling. The pipeline already supports dynamic species/model/frequency
configuration; that work is currently invisible because no UI exposes it.

### The precedent

**Martínez Balvanera et al. (2024), *Whombat: An open-source audio annotation tool for machine
learning assisted bioacoustics*, MEE, 10.1111/2041-210x.14468** — an open-source GUI for ML-assisted
human-in-the-loop bioacoustic annotation, published as an MEE Applications paper. That is this
project's shape, in the strongest ecology methods venue. MEE's current appetite on this territory is
demonstrably open: Kitzes (2025) on integrating AI models into bioacoustics workflows
(10.1111/2041-210x.70133), Turlington (2025) on exploratory analysis of unknown sound types
(10.1111/2041-210x.70134), Cretois (2026) on the TABMON PAM network (10.1111/2041-210x.70308).

### Ranking

| # | Venue / type | Words | Standing | Verdict |
|---|---|---|---|---|
| 1 | **MEE — Applications** | 4,000 | IF 5.7, 25% accept, $2,600 (free if not OA) | **Primary.** Whombat is the precedent. ⚠️ Gated on script export |
| 2 | **RSEC — Methods and Tools** | 4,000 | IF 5.2, 19% accept, 6-day first decision, $3,950 | **Best fit for a GUI app** — no GUI clause; scope explicitly names acoustic recorders |
| 3 | Ecological Informatics | ? | strong technical reviewers | Best reviewer match; ⚠️ policies unverified, ScienceDirect blocked every access attempt |
| 4 | Frontiers Ecol & Evol — Technology and Code | **12,000** | IF 3.2, Scopus+WoS | If length is the binding constraint; accepts a prestige discount |
| — | Ecological Solutions and Evidence | 3,000–4,000 | IF 3.3, 66% accept | Only if reframed as a practitioner workflow paper; no software article type |
| — | JOSS / SoftwareX | short | — | Companion artifact DOI, never the lead |
| — | Frontiers in Bird Science | — | ⚠️ likely no Scopus/WoS | Skip |
| — | Journal of Ecoacoustics | — | — | **Dead** — zero papers 2024–2026 |

**Remote Sensing in Ecology and Conservation is the surprise.** Its scope defines remote sensing to
include "data acquisition by hand-held and fixed ground-based sensors, such as camera traps and
**acoustic recorders**," it has a purpose-built Methods and Tools type, and it has **no GUI-exclusion
clause**. Its code bar is the strictest surveyed and stated as a floor: "Code, including AI-generated
code must be published alongside unit tests of critical functionality, and demonstration datasets
must be provided that enable reviewers to quickly run code… we consider these best practices to now
be minimum standards." The 103→164 test suite and a small demo dataset satisfy this directly. RSEC
also wants an explicit comparison-to-existing-tools section — which is exactly §1 of this document.

One more near-precedent worth knowing: **Dubus (2025), *APLOSE: A web-based annotation platform for
underwater passive acoustic monitoring*, SoftwareX** (10.1016/j.softx.2025.102055).

### Build requirements that gate submission

1. **Script export from the GUI** — without it MEE is closed. Highest priority.
2. **A small demonstration dataset a reviewer can run in minutes** — RSEC states this as a minimum.
3. **Public repo with real commit history.**
4. **A comparison-to-existing-tools section** — required by RSEC, and the weakest part of most tool
   papers. §1 above is the draft.
5. **Expose the existing dynamic species/frequency configuration in the UI**, so the taxon-generality
   claim is true in the product and not just in the code.

### Still unverified

Ecological Informatics' entire author-facing policy set (scope, article types, word limits, code
policy, APC) — ScienceDirect defeated every automated access route; open the Guide for Authors
manually. Also unconfirmed: current APC fee tables for MEE and RSEC, Bioacoustics' code/data policy,
and Frontiers in Bird Science's Scopus/WoS status.

## 7. Open questions for the humans

1. Is the existing manuscript already submitted, or still editable? The recommendation changes
   depending on whether the ecology can go *into* it or must be a second paper.
2. Who are the potential expert reviewers for a Direction B study, and how many hours can they give?
3. Can someone pull the IJCAI 2023 human-in-the-loop annotation paper?
4. Is the 2024 season's data processed and available, or only 2025?
5. Does the elevation gradient have covariates recorded (vegetation, wind, temperature)? Without
   them, the detectability confound in Direction A is hard to answer.
