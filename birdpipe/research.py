"""Research-ready curation, effort normalization, uncertainty, and models.

This module keeps the scientific event set explicit.  A final curated event is
either a manual annotation, a confirmed detector event, or an unreviewed event
that passes the selected thresholds.  Rejected detector events never enter it.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Dict, Iterable, List, Mapping, Optional, Sequence

import numpy as np
from scipy import stats

from . import ecology


WEATHER_FIELDS = ("temperature_c", "precipitation_mm", "wind_mps", "humidity_pct")


def curate_records(
    records: Iterable[Dict], theta_a: Optional[float] = None,
    theta_b: Optional[float] = None,
) -> List[Dict]:
    """Return the documented final event set, preserving its provenance."""
    originals = list(records)
    thresholded = ecology.apply_thresholds(originals, theta_a, theta_b)
    curated: List[Dict] = []
    for original, rec in zip(originals, thresholded):
        row = dict(rec)
        source = str(original.get("source") or "ml").lower()
        review = str(original.get("review_status") or "unreviewed").lower()
        if review == "rejected":
            continue
        if source == "manual":
            row["curation_basis"] = "manual_annotation"
        elif review == "confirmed":
            row["curation_basis"] = "reviewer_confirmed"
        elif row.get("retained"):
            row["curation_basis"] = "threshold_retained_unreviewed"
        else:
            continue
        curated.append(row)
    return curated


def poisson_rate_interval(count: int, exposure_hours: float, alpha: float = 0.05):
    """Central exact (Garwood) interval for a Poisson event rate."""
    if exposure_hours <= 0:
        return None, None
    low = 0.0 if count == 0 else stats.chi2.ppf(alpha / 2, 2 * count) / (2 * exposure_hours)
    high = stats.chi2.ppf(1 - alpha / 2, 2 * (count + 1)) / (2 * exposure_hours)
    return float(low), float(high)


def activity_by_recording_time(
    records: Iterable[Dict], effort_by_path: Mapping[str, float], bin_minutes: float = 5.0,
) -> List[Dict]:
    """Counts and exposed recording-hours in equal elapsed-time bins."""
    bin_seconds = max(1.0, float(bin_minutes) * 60.0)
    max_seconds = max((hours * 3600.0 for hours in effort_by_path.values()), default=0.0)
    n_bins = max(1, int(math.ceil(max_seconds / bin_seconds)))
    counts = [0] * n_bins
    invalid_events = 0
    for rec in records:
        start = rec.get("t_start")
        path = str(rec.get("path") or "")
        duration_seconds = float(effort_by_path.get(path, 0.0)) * 3600.0
        if (start is None or not math.isfinite(float(start)) or float(start) < 0
                or duration_seconds <= 0 or float(start) >= duration_seconds):
            invalid_events += 1
            continue
        index = int(float(start) // bin_seconds)
        counts[index] += 1

    rows = []
    for index, count in enumerate(counts):
        start = index * bin_seconds
        end = start + bin_seconds
        exposed_seconds = sum(max(0.0, min(end, hours * 3600.0) - start) for hours in effort_by_path.values())
        at_risk = [path for path, hours in effort_by_path.items() if hours * 3600.0 > start]
        exposure = exposed_seconds / 3600.0
        low, high = poisson_rate_interval(count, exposure)
        known_recorders = {ecology.parse_recorder_id(path) for path in at_risk}
        known_recorders.discard(None)
        rows.append({
            "bin_start_minutes": start / 60.0,
            "bin_end_minutes": end / 60.0,
            "n_events": count,
            "exposure_hours": exposure,
            "n_files_at_risk": len(at_risk),
            "n_recorders_at_risk": len(known_recorders),
            "n_unattributed_files_at_risk": sum(
                ecology.parse_recorder_id(path) is None for path in at_risk
            ),
            "invalid_events_excluded": invalid_events,
            "rate_per_hour": count / exposure if exposure > 0 else None,
            "ci_low": low,
            "ci_high": high,
        })
    return rows


def _parse_recording_date(path: str) -> Optional[datetime]:
    match = re.search(r"(?<!\d)(20\d{6})[_-]?(\d{6})(?!\d)", str(path))
    if not match:
        return None
    try:
        return datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _season(month: int) -> str:
    return ("winter", "spring", "summer", "autumn")[((month % 12) // 3)]


def build_file_rows(
    records: Iterable[Dict], file_paths: Sequence[str], effort_by_path: Mapping[str, float],
    metadata: Mapping[str, Dict],
) -> List[Dict]:
    """One model row per recording, including zero-detection recordings."""
    counts = Counter(str(r.get("path")) for r in records if r.get("path"))
    rows = []
    for path in file_paths:
        recorder = ecology.resolve_recorder_id(path, metadata)
        meta = metadata.get(recorder.upper(), {}) if recorder else {}
        recorded = _parse_recording_date(path)
        season = meta.get("season") or (_season(recorded.month) if recorded else None)
        row = {
            "path": path,
            "recorder_id": recorder,
            "site_id": meta.get("site_id"),
            "recording_date": recorded.date().isoformat() if recorded else None,
            "season": season,
            "elevation_m": meta.get("elevation_m"),
            "effort_hours": float(effort_by_path.get(path, ecology.DEFAULT_EFFORT_HOURS_PER_FILE)),
            "n_events": int(counts.get(path, 0)),
        }
        for field in WEATHER_FIELDS:
            row[field] = meta.get(field)
        rows.append(row)
    return rows


def fit_adjusted_rate_model(rows: Sequence[Dict], alpha: float = 0.05) -> Dict:
    """Poisson rate model with log-effort offset and recorder-clustered SEs.

    Elevation is the focal effect.  Date seasonality and supplied weather are
    fixed effects; repeated recordings are handled by a recorder-clustered
    sandwich covariance.  Site is reported as a design limitation when it is
    inseparable from recorder/elevation rather than silently overfit.
    """
    usable = [r for r in rows if (r.get("effort_hours") or 0) > 0]
    recorders = sorted({r.get("recorder_id") for r in usable if r.get("recorder_id")})
    if len(usable) < 20 or len(recorders) < 10:
        return {"status": "not_fitted", "reason": "Need at least 20 recordings across 10 recorders for clustered inference.",
                "n_recordings": len(usable), "n_recorders": len(recorders)}

    columns = [np.ones(len(usable))]
    names = ["intercept"]
    used_controls = []
    elevation = np.array([float(r["elevation_m"]) if r.get("elevation_m") is not None else np.nan for r in usable])
    if not np.isfinite(elevation).all() or np.ptp(elevation) <= 0:
        return {"status": "not_fitted", "reason": "Every modeled recording needs a known elevation, with variation across recorders.",
                "n_recordings": len(usable), "n_recorders": len(recorders)}
    columns.append(elevation / 100.0)
    names.append("elevation_per_100m")

    sites = [r.get("site_id") for r in usable]
    site_levels = sorted({site for site in sites if site})
    if 1 < len(site_levels) <= max(2, min(8, len(usable) // 4)) and all(sites):
        added_site = False
        for level in site_levels[1:]:
            candidate = np.array([1.0 if site == level else 0.0 for site in sites])
            trial = np.column_stack(columns + [candidate])
            if np.linalg.matrix_rank(trial) == trial.shape[1]:
                columns.append(candidate)
                names.append("site_{}".format(level))
                added_site = True
        if added_site:
            used_controls.append("site")

    dates = [_parse_recording_date(r["path"]) for r in usable]
    if all(d is not None for d in dates):
        angle = np.array([2 * math.pi * (d.timetuple().tm_yday / 365.25) for d in dates])
        columns.extend([np.sin(angle), np.cos(angle)])
        names.extend(["date_sin", "date_cos"])
        used_controls.append("date (annual cycle)")

    seasons = [r.get("season") for r in usable]
    season_levels = sorted({s for s in seasons if s})
    if len(season_levels) > 1 and all(seasons):
        for level in season_levels[1:]:
            columns.append(np.array([1.0 if s == level else 0.0 for s in seasons]))
            names.append("season_{}".format(level))
        used_controls.append("season")

    for field in WEATHER_FIELDS:
        values = np.array([float(r[field]) if r.get(field) is not None else np.nan for r in usable])
        if np.isfinite(values).all() and np.ptp(values) > 0:
            columns.append((values - values.mean()) / values.std())
            names.append(field)
            used_controls.append(field)

    X = np.column_stack(columns)
    y = np.array([float(r["n_events"]) for r in usable])
    if not np.isfinite(y).all() or np.any(y < 0) or y.sum() < 5:
        return {"status": "not_fitted", "reason": "Need at least 5 valid detector events for a stable rate model.",
                "n_recordings": len(usable), "n_recorders": len(recorders), "terms": names}
    positive_clusters = {
        row.get("recorder_id") or row["path"] for row, count in zip(usable, y) if count > 0
    }
    if len(positive_clusters) < 2:
        return {"status": "not_fitted", "reason": "Events must occur in at least 2 recorder clusters.",
                "n_recordings": len(usable), "n_recorders": len(recorders), "terms": names}
    offset = np.log(np.array([float(r["effort_hours"]) for r in usable]))
    condition_number = float(np.linalg.cond(X))
    if (X.shape[1] >= len(usable) - 2 or np.linalg.matrix_rank(X) < X.shape[1]
            or not math.isfinite(condition_number) or condition_number > 1e8):
        return {"status": "not_fitted", "reason": "Available controls are rank-deficient for this dataset.",
                "n_recordings": len(usable), "n_recorders": len(recorders), "terms": names}

    beta = np.zeros(X.shape[1])
    beta[0] = math.log(max(y.sum(), 0.5) / max(np.exp(offset).sum(), 1e-9))
    try:
        converged = False
        for _ in range(200):
            mu = np.exp(np.clip(X @ beta + offset, -30, 30))
            bread_inv = np.linalg.inv(X.T @ (X * mu[:, None]))
            step = bread_inv @ (X.T @ (y - mu))
            beta += step
            if np.max(np.abs(step)) < 1e-9:
                converged = True
                break
        if not converged or not np.isfinite(beta).all() or np.max(np.abs(beta)) > 30:
            raise FloatingPointError("model did not converge to finite, stable coefficients")
        mu = np.exp(np.clip(X @ beta + offset, -30, 30))
        bread_inv = np.linalg.inv(X.T @ (X * mu[:, None]))
    except (np.linalg.LinAlgError, ValueError, FloatingPointError) as exc:
        return {"status": "not_fitted", "reason": "Model fitting failed: {}".format(exc),
                "n_recordings": len(usable), "n_recorders": len(recorders)}

    scores = defaultdict(lambda: np.zeros(X.shape[1]))
    for i, row in enumerate(usable):
        scores[row.get("recorder_id") or row["path"]] += X[i] * (y[i] - mu[i])
    meat = sum((np.outer(score, score) for score in scores.values()), np.zeros((X.shape[1], X.shape[1])))
    clusters = len(scores)
    correction = (clusters / (clusters - 1)) * ((len(usable) - 1) / (len(usable) - X.shape[1]))
    covariance = correction * bread_inv @ meat @ bread_inv
    se = np.sqrt(np.maximum(np.diag(covariance), 0))
    if not np.isfinite(covariance).all() or not np.isfinite(se).all():
        return {"status": "not_fitted", "reason": "Clustered uncertainty was not finite for this dataset.",
                "n_recordings": len(usable), "n_recorders": len(recorders)}
    zcrit = stats.norm.ppf(1 - alpha / 2)
    terms = []
    for name, estimate, stderr in zip(names, beta, se):
        z = estimate / stderr if stderr > 0 else None
        bounds = np.array([estimate, estimate - zcrit * stderr, estimate + zcrit * stderr])
        if not np.isfinite(bounds).all() or np.max(np.abs(bounds)) > 700:
            return {"status": "not_fitted", "reason": "Model effect estimates were numerically unstable.",
                    "n_recordings": len(usable), "n_recorders": len(recorders)}
        terms.append({
            "term": name, "estimate": float(estimate), "se": float(stderr),
            "rate_ratio": float(math.exp(estimate)),
            "ci_low": float(math.exp(estimate - zcrit * stderr)),
            "ci_high": float(math.exp(estimate + zcrit * stderr)),
            "p_value": float(2 * stats.norm.sf(abs(z))) if z is not None else None,
        })
    dispersion = float(np.sum((y - mu) ** 2 / np.maximum(mu, 1e-12)) / max(len(y) - X.shape[1], 1))
    model_status = "fitted" if clusters >= 20 and dispersion <= 1.5 else "exploratory"
    return {
        "status": model_status,
        "family": "Poisson log-rate model",
        "uncertainty": "recorder-clustered sandwich 95% confidence intervals",
        "n_recordings": len(usable), "n_recorders": clusters,
        "terms": terms, "controls_used": used_controls,
        "controls_unavailable": [x for x in ("date", "site", "season", *WEATHER_FIELDS) if not any(x in y for y in used_controls)],
        "site_handling": "Estimable site contrasts are fixed effects; aliased site terms remain in the model-ready dataset but are not fitted.",
        "dispersion": dispersion,
        "overdispersed": dispersion > 1.5,
        "warning": (
            "Overdispersion makes the Poisson result provisional; fit a negative-binomial or GEE sensitivity model."
            if dispersion > 1.5 else None if clusters >= 20 else
            "Fewer than 20 recorder clusters: clustered intervals are exploratory."
        ),
    }
