# Research analysis contract

The **Analytics** tab diagnoses a batch run. The **Research** tab creates a
traceable analysis dataset and quantifies what the current evidence can support.
It reports **pipeline detections per audio hour**. It does not estimate abundance,
occupancy, or a biological calling rate because detection probability and false
negatives are not modeled.

## Event sets

`final_curated_events.csv` uses one explicit rule:

- include manual annotations unless rejected;
- include reviewer-confirmed detector events even if their scores fall below the
  selected thresholds;
- include unreviewed detector events only when both selected thresholds pass;
- exclude reviewer-rejected detector events.

Manual annotations are also exported separately. They are excluded from rate
models and exposure-normalized activity unless a future workflow records that
every recording received an exhaustive, standardized manual search. Otherwise,
opportunistic manual finds would increase the numerator over unscreened effort.

## Uncertainty and activity

For count `y` over `E` audio hours, the displayed rate is `y / E`. The 95%
interval is the central exact Poisson (Garwood) interval:

```text
lower = 0                                      when y = 0
lower = chi2(alpha / 2, 2y) / (2E)            otherwise
upper = chi2(1 - alpha / 2, 2(y + 1)) / (2E)
```

Within-recording activity bins use the actual overlap between each recording
and each bin. A ten-minute file therefore contributes no exposure to a
10–15-minute bin. The output retains counts, exposed hours, files at risk, and
recorders at risk. These exact intervals are reference intervals; clustered
bouts can make them too narrow.

## Adjusted comparison

The focal model is a recording-level Poisson log-rate model:

```text
count ~ elevation_per_100m + estimable_site_terms + annual_date_cycle
        + season + supplied_weather
offset = log(audio_hours)
```

Recorder-clustered sandwich intervals account for repeated recordings. The
model refuses to fit with fewer than 20 recordings across 10 recorders, missing
or invariant elevation, or a rank-deficient design. Results with 10–19 recorder
clusters are labeled exploratory. Overdispersion also downgrades a result to
exploratory and requires a negative-binomial or GEE sensitivity model before
publication. Missing weather is never replaced with zero.

Site terms that are perfectly aliased with elevation are omitted rather than
silently producing an unidentified coefficient. Duplicate `device_id` rows in
metadata are rejected because interval-based deployment joins are not yet
implemented.

## Threshold sensitivity

The Research tab evaluates a 5 × 5 Stage A and Stage B grid. Each cell rebuilds
the inferential event set and refits the same adjusted model. Stage A starts at
0.25 because lower-confidence candidates were not stored by inference; testing
below that floor would require rerunning the detector. The session thresholds
remain the primary analysis—this grid must not be searched for the smallest
p-value.

## Reproducibility outputs

Each run writes:

- `research_spec.json`, including metadata and curated-data SHA-256 hashes;
- `final_curated_events.csv`;
- `manual_annotations.csv` and `curated_detector_events.csv`;
- `model_ready_recordings.csv`, including zero-event recordings;
- `research_analysis.json`, including activity, model diagnostics, and the
  sensitivity grid.

## Duration measurement

Desktop analytics and secondary exports use the shared Rust duration reader.
It probes file contents and walks all demuxed packets for WAV, FLAC, and MP3,
including headerless variable-bit-rate MP3 files. Unreadable or malformed files
fall back to the disclosed 0.25-hour assumption and increment the fallback
counter. The implementation exact-pins Symphonia 0.5.5 to preserve the app's
declared Rust toolchain compatibility.

## Method references

- Garwood, 1936, exact Poisson limits: <https://doi.org/10.1093/biomet/28.3-4.437>
- Statsmodels Poisson rate intervals: <https://www.statsmodels.org/stable/generated/statsmodels.stats.rates.confint_poisson.html>
- Statsmodels GLM offsets/exposure: <https://www.statsmodels.org/stable/generated/statsmodels.genmod.generalized_linear_model.GLM.html>
- Liang & Zeger, 1986, repeated-measures GEE: <https://doi.org/10.1093/biomet/73.1.13>
- Symphonia 0.5.5 documentation: <https://docs.rs/symphonia/0.5.5/symphonia/>
