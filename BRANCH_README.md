# Branch: `users/haley/feedback-062926` — Card-Based Setup Flow

This branch replaces the single-page settings form with a step-by-step, card-based
setup flow designed for non-technical ecology researchers. The old layout is still
available — everything on this branch is gated behind feature flags.

## What's new

### Card-by-card setup (`card_ui`)

Instead of one form full of fields, the researcher moves through one decision at a time:

1. **Choose the folder your audio files are in** — one button, plus a sentence
   explaining what the app does. After picking, the app counts the recordings found.
2. **Welcome back** *(only when earlier progress exists in that folder)* — shows
   "112 of 240 recordings are already analyzed" with **Pick up where I left off**
   as the primary action, or the option to erase progress and start over.
   No "cache" jargon anywhere.
3. **Set detection sensitivity and quality filter** — pre-filled with recommended
   defaults, a plain-English explanation of the trade-off, and a one-click
   **Reset to recommended**. Advanced settings appear here as an optional
   disclosure *only* when the `advanced_settings` flag is on.
4. **Ready to analyze!** — a bird, a summary of exactly what will happen
   ("We'll listen through 240 recordings in *field-june*… this should take about
   2 hours"), and one big **Analyze!** button.

### Time awareness (`time_estimates`)

- The app remembers how long each recording took on your last run and uses that to
  estimate the next run's duration *before* it starts.
- During a run, a plain-language line sits under the progress bar:
  *"112 of 240 recordings finished · about 40 min left — should finish around 3:15 PM."*

### Resuming interrupted runs (`resume_runs`)

The backend has always saved progress per-file in `batch.db` and skipped finished
files on re-run. This branch surfaces that in the UI: if a run ends unexpectedly
(crash, closed laptop, power loss), re-selecting the same folder offers to pick up
where you left off, and explains that finished recordings will be skipped.

### Navigation polish

The top-level **Batch** tab is now labeled **Analyze**, and the Analyze/Review
buttons are spaced further apart.

### Layout toggle: guided cards vs. full page

Early feedback was that the card flow is a big change for researchers already
used to the single-page form. Rather than a global, restart-required flag,
there's now a **Guided cards / Full page** switch in the top-right of the
Analyze screen that flips between `CardSetupView` and `SetupView` instantly.
It defaults to whatever `card_ui` says, but the moment someone clicks it, that
choice is remembered per-browser (`localStorage["birdaudio.uiMode"]`) and wins
over the flag from then on — so a lab can ship `card_ui: true` for new users
while a veteran researcher on the same install can opt back into the classic
form for good.

### Step transitions

Moving between cards (and into/out of the cache-inspection view) now animates
as a direction-aware slide + fade — forward steps slide in from the right,
"Back" slides in from the left — via a small `goTo(step, direction)` helper
in `CardSetupView` and `.card-step` / `.card-step--forward` / `.card-step--back`
in `index.css`. Respects `prefers-reduced-motion`.

### Inspecting cached results before reusing them

The "Welcome back" card previously offered only two options: resume or erase
everything. Neither let a researcher see *what* was cached, which is a problem
because a crashed run can leave `batch.db` in a state where blindly resuming
silently reuses broken results.

- **Auto-detected "broken" files** — a cached file is flagged `broken` when it
  terminally failed (has an error message) or when it's still marked
  `in_progress` from a run that never got the chance to finish cleanly (the
  engine normally resets `in_progress → pending` at the start of the next run
  on that session; a leftover row here means the app was killed before that
  point). The resume card shows a warning with a count and a link straight
  into the inspector when any exist.
- **Stage flagging** — each cached, successfully-run file is labeled with how
  far it got: **Stage A only** (detections were found but the completeness
  classifier never ran on them — e.g. the classifier model failed to load)
  or **Complete** (Stage A ran and every detected event was scored, or no
  events were found at all).
- **"Review cached files →" / "See which recordings were cached →"** on the
  resume card opens a new `inspect` step that embeds `ManageCache`, now
  showing the stage pill and a broken-file warning icon per row, plus quick
  filters to select all **Broken** or all **Stage A only** files. Clearing a
  selection deletes just those rows, which makes them fresh again for the
  next run — everything left checked stays cached and gets skipped.

This reuses the existing per-file delete/clear cache commands; the new
`get_cached_files` payload additionally reports `nEvents`, `nComplete`,
`error`, `stage`, and `broken` per file (computed in
`batch-core/src/store.rs::list_cached_files`).

## Feature flags

All flags live in [`config/features.yaml`](config/features.yaml) and are read at
app launch (no rebuild needed to toggle):

| Flag | Default | What it controls |
|---|---|---|
| `card_ui` | `false` | Default layout for first-time users of this install. When off, the classic single-page form is used. Anyone can override this per-browser with the Guided cards / Full page toggle on the Analyze screen. |
| `advanced_settings` | `true`* | In the card flow this is **opt-in** (`true` shows the disclosure); in the classic form it keeps its original opt-out behavior. |
| `time_estimates` | `true` | Pre-run duration estimates and the live "time left" line. |
| `resume_runs` | `true` | The "Welcome back" card for folders with earlier progress. |
| `cloud_import` | `false` | A hint on the folder card guiding OneDrive users to their synced folder. |

\* Default when `config/features.yaml` is missing. This branch's checked-in config
sets `card_ui: true` and `advanced_settings: false` so researchers get the
simplified flow.

## Design rationale

The flow follows Amershi et al., [*Guidelines for Human-AI Interaction*](https://dl.acm.org/doi/10.1145/3290605.3300233)
(CHI 2019). Highlights:

- **G1/G2** — the first card states what the system does; settings copy explains
  the sensitivity/quality trade-off and estimates are hedged ("about 2 hours").
- **G3/G4** — the resume card only appears when relevant; the analyze card
  summarizes exactly what's about to happen.
- **G7–G9** — one obvious primary action per card, a visible Back button on every
  step, and one-click reset to recommended settings.
- **G10** — a folder with no audio files produces a helpful message, not a guess.
- **G12/G13** — saved progress powers resume; the previous run's speed powers the
  next run's estimate.
- **G16** — destructive actions say what they do ("Erase progress and start over");
  the analyze card notes that closing the app is safe because progress is saved.

## About OneDrive

Full OAuth integration was considered and deliberately not built:

1. It requires an Azure AD app registration (client ID + admin-consented Graph
   scopes) that only the org can create.
2. The ML engine reads audio from local disk, so a cloud integration would just
   re-download files that OneDrive's own sync client already handles better.
3. The reliable path — pointing the folder picker at the locally synced OneDrive
   folder — already works, and the `cloud_import` flag adds in-app guidance for it.

If a client ID becomes available, a PKCE auth-code flow with Graph folder browsing
can be added on top of this flow.

## Files changed

- [`src/components/CardSetupView.tsx`](src/components/CardSetupView.tsx) — card flow, step animation, cache-inspection step
- [`src/App.tsx`](src/App.tsx) — flag check, view switch, nav polish, run-speed memory, layout toggle
- [`src/components/RunView.tsx`](src/components/RunView.tsx) — plain-language progress line
- [`src/components/ManageCache.tsx`](src/components/ManageCache.tsx) — stage pill, broken-file warnings, Broken/Stage A quick filters
- [`src/api.ts`](src/api.ts) — `countAudioFiles` wrapper
- [`src/types.ts`](src/types.ts) — enriched `CachedFile` type
- [`src/index.css`](src/index.css) — `.card-step` transition keyframes
- [`src-tauri/src/commands.rs`](src-tauri/src/commands.rs) — `count_audio_files` command, new flag defaults, enriched `get_cached_files`
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) — command registration
- [`batch-core/src/store.rs`](batch-core/src/store.rs) — `list_cached_files` (stage + broken detection)
- [`config/features.yaml`](config/features.yaml) — new flags

## Trying it out

```bash
npm run tauri dev
```

Use the **Guided cards / Full page** toggle at the top of the Analyze screen to
switch layouts live (or set `card_ui` in `config/features.yaml` to change the
default for browsers that haven't chosen yet). To see the resume card, start a
run, quit mid-way, and pick the same folder again — if you kill the app while
a file is still processing (rather than letting it fail or finish), that file
will show up as **broken** in the cache inspector next time.
