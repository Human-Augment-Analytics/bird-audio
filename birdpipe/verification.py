"""Verification effort planning: how many clips to review, and which ones next.

Manual verification of a detector subsample is the accepted way to estimate
precision at an operating threshold (Wood & Kahl 2024). This module plans that
effort: interval-aware precision estimates, required sample sizes, review
queues under several sampling strategies, and a stopping rule.
"""
from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
from scipy.stats import norm

from .constants import StageBParams

DEFAULT_THETA_B = StageBParams().theta_b
DEFAULT_SECONDS_PER_VERIFICATION = 8.0
MIN_EVIDENCE = 10
STRATEGIES = ("random", "stratified", "uncertainty", "completeness")

# A dwell longer than this is a break, not a decision, and must not inflate the
# measured cost per verification. Mirrors DEFAULT_IDLE_CUTOFF_MS in batch-core.
DEFAULT_IDLE_CUTOFF_MS = 120_000
DECISION_ACTIONS = ("confirm", "reject", "reset", "confirmed", "rejected", "unreviewed")

_MAX_SAMPLE_SIZE = 10_000_000


def _field(record: Any, key: str, default: Any = None) -> Any:
    """Read `key` from a mapping-like record (dict, sqlite3.Row) or an object."""
    if hasattr(record, "keys"):
        try:
            return record[key]
        except (KeyError, IndexError):
            return default
    return getattr(record, key, default)


def _z(confidence: float) -> float:
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be in (0, 1)")
    return float(norm.ppf(1.0 - (1.0 - confidence) / 2.0))


def wilson_interval(successes: int, n: int, confidence: float = 0.95) -> Tuple[float, float]:
    """Wilson score interval for a binomial proportion.

    Stays inside [0, 1] and remains asymmetric near p=0 or p=1, where the
    normal approximation degenerates.
    """
    if n < 0 or successes < 0:
        raise ValueError("successes and n must be non-negative")
    if successes > n:
        raise ValueError("successes cannot exceed n")
    if n == 0:
        return (0.0, 1.0)
    z = _z(confidence)
    p = successes / n
    denom = 1.0 + z * z / n
    center = (p + z * z / (2.0 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n))
    return (max(0.0, center - half), min(1.0, center + half))


@dataclass(frozen=True)
class PrecisionEstimate:
    """Precision of the detector at `threshold`, with the evidence behind it.

    `point` is None when nothing has been verified: absence of labels is not
    the same as a precision of zero.
    """
    threshold: float
    n_verified: int
    n_true: int
    point: Optional[float]
    ci_low: float
    ci_high: float
    half_width: float
    n_above_threshold: int
    n_unreviewed: int
    confidence: float = 0.95

    def to_dict(self) -> Dict[str, Any]:
        return {
            "threshold": self.threshold,
            "n_verified": self.n_verified,
            "n_true": self.n_true,
            "point": self.point,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "half_width": self.half_width,
            "n_above_threshold": self.n_above_threshold,
            "n_unreviewed": self.n_unreviewed,
            "confidence": self.confidence,
        }


def _detector_events(records: Iterable[Any], threshold: float, score_key: str) -> List[Any]:
    """Detector output at or above threshold; manual annotations are not detections."""
    out = []
    for r in records:
        if _field(r, "source", "ml") == "manual":
            continue
        score = _field(r, score_key)
        if score is None:
            continue
        if float(score) >= threshold:
            out.append(r)
    return out


def precision_estimate(
    records: Iterable[Any],
    threshold: float,
    score_key: str = "stage_a_conf",
    confidence: float = 0.95,
) -> PrecisionEstimate:
    """Estimate precision from reviewed detector events at or above `threshold`."""
    pool = _detector_events(records, threshold, score_key)
    n_true = 0
    n_verified = 0
    n_unreviewed = 0
    for r in pool:
        status = _field(r, "review_status", "unreviewed")
        if status == "confirmed":
            n_verified += 1
            n_true += 1
        elif status == "rejected":
            n_verified += 1
        else:
            n_unreviewed += 1

    lo, hi = wilson_interval(n_true, n_verified, confidence)
    point = (n_true / n_verified) if n_verified > 0 else None
    return PrecisionEstimate(
        threshold=float(threshold),
        n_verified=n_verified,
        n_true=n_true,
        point=point,
        ci_low=lo,
        ci_high=hi,
        half_width=(hi - lo) / 2.0,
        n_above_threshold=len(pool),
        n_unreviewed=n_unreviewed,
        confidence=confidence,
    )


def _wilson_half_width(p: float, n: int, z: float, population: Optional[int] = None) -> float:
    if n <= 0:
        return math.inf
    if population is not None:
        if n >= population:
            return 0.0
        if population <= 1:
            return 0.0
    denom = 1.0 + z * z / n
    hw = (z / denom) * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n))
    if population is not None and population > 1:
        hw *= math.sqrt((population - n) / (population - 1.0))
    return hw


def required_sample_size(
    p_hat: Optional[float],
    target_half_width: float,
    confidence: float = 0.95,
    population: Optional[int] = None,
) -> int:
    """Smallest n whose Wilson half-width is at or below `target_half_width`.

    The Wilson half-width has no clean inverse, so n is found by search over a
    function that is monotone decreasing in n. `p_hat=None` falls back to 0.5,
    the variance-maximising (most conservative) assumption.
    """
    if target_half_width <= 0.0:
        raise ValueError("target_half_width must be positive")
    p = 0.5 if p_hat is None else float(p_hat)
    if not 0.0 <= p <= 1.0:
        raise ValueError("p_hat must be in [0, 1]")
    z = _z(confidence)

    if population is not None:
        population = int(population)
        if population <= 0:
            return 0
        # A census of the pool has no sampling error, so n=population always qualifies.
        hi = population
    else:
        hi = 1
        while _wilson_half_width(p, hi, z, population) > target_half_width:
            hi *= 2
            if hi > _MAX_SAMPLE_SIZE:
                return _MAX_SAMPLE_SIZE

    lo = 1
    if _wilson_half_width(p, lo, z, population) <= target_half_width:
        return lo
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if _wilson_half_width(p, mid, z, population) <= target_half_width:
            hi = mid
        else:
            lo = mid
    return hi


@dataclass(frozen=True)
class EffortEstimate:
    """How much more verification is needed, and what it costs in human time."""
    n_verified: int
    n_required: int
    n_additional: int
    n_available: int
    p_assumed: float
    target_half_width: float
    seconds_per_verification: float
    estimated_seconds: float
    requires_census: bool

    @property
    def estimated_minutes(self) -> float:
        return self.estimated_seconds / 60.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "n_verified": self.n_verified,
            "n_required": self.n_required,
            "n_additional": self.n_additional,
            "n_available": self.n_available,
            "p_assumed": self.p_assumed,
            "target_half_width": self.target_half_width,
            "seconds_per_verification": self.seconds_per_verification,
            "estimated_seconds": self.estimated_seconds,
            "estimated_minutes": self.estimated_minutes,
            "requires_census": self.requires_census,
        }


def measured_seconds_per_verification(
    db_path: str,
    session_id: Optional[int] = None,
    idle_cutoff_ms: int = DEFAULT_IDLE_CUTOFF_MS,
    min_decisions: int = 5,
) -> Optional[Dict[str, Any]]:
    """Median seconds per decision from recorded review telemetry.

    Returns None when the telemetry table is absent or holds too few decisions to
    be worth trusting, so the caller falls back to a stated assumption rather than
    presenting a guess as a measurement.
    """
    placeholders = ",".join("?" for _ in DECISION_ACTIONS)
    sql = (
        f"SELECT dwell_ms FROM review_events"
        f" WHERE action IN ({placeholders})"
        f" AND dwell_ms IS NOT NULL AND dwell_ms > 0 AND dwell_ms < ?"
    )
    params: List[Any] = [*DECISION_ACTIONS, int(idle_cutoff_ms)]
    if session_id is not None:
        sql += " AND session_id = ?"
        params.append(int(session_id))

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        dwells = [row[0] for row in conn.execute(sql, params)]
    except sqlite3.Error:
        return None
    finally:
        conn.close()

    if len(dwells) < min_decisions:
        return None
    arr = np.asarray(dwells, dtype=float) / 1000.0
    return {
        "seconds_per_verification": float(np.median(arr)),
        "mean_seconds": float(np.mean(arr)),
        "n_decisions": int(arr.size),
        "idle_cutoff_ms": int(idle_cutoff_ms),
        "source": "measured",
    }


def additional_effort(
    current: PrecisionEstimate,
    target_half_width: float,
    seconds_per_verification: float = DEFAULT_SECONDS_PER_VERIFICATION,
    confidence: Optional[float] = None,
) -> EffortEstimate:
    """Verifications still owed to reach `target_half_width`, plus time cost.

    `seconds_per_verification` defaults to a nominal 8s but should be passed
    from measured review telemetry when available.
    """
    if seconds_per_verification < 0:
        raise ValueError("seconds_per_verification must be non-negative")
    conf = current.confidence if confidence is None else confidence
    p = 0.5 if current.point is None else current.point
    population = current.n_above_threshold
    n_required = required_sample_size(p, target_half_width, conf, population)
    n_additional = max(0, n_required - current.n_verified)
    n_available = current.n_unreviewed
    requires_census = population > 0 and n_required >= population
    n_additional = min(n_additional, n_available)
    return EffortEstimate(
        n_verified=current.n_verified,
        n_required=n_required,
        n_additional=n_additional,
        n_available=n_available,
        p_assumed=p,
        target_half_width=float(target_half_width),
        seconds_per_verification=float(seconds_per_verification),
        estimated_seconds=n_additional * float(seconds_per_verification),
        requires_census=requires_census,
    )


def _candidates(
    records: Iterable[Any],
    threshold: float,
    score_key: str,
) -> List[Any]:
    """Unreviewed detector events at or above threshold, in stable id order."""
    pool = [
        r for r in _detector_events(records, threshold, score_key)
        if _field(r, "review_status", "unreviewed") == "unreviewed"
    ]
    return sorted(pool, key=lambda r: _sort_id(_field(r, "id")))


def _sort_id(value: Any) -> Tuple[int, float, str]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (0, float(value), "")
    return (1, 0.0, str(value))


def _allocate(budget: int, sizes: Sequence[int]) -> List[int]:
    total = sum(sizes)
    if total == 0:
        return [0] * len(sizes)
    budget = min(budget, total)
    raw = [budget * s / total for s in sizes]
    alloc = [min(int(math.floor(x)), s) for x, s in zip(raw, sizes)]
    remaining = budget - sum(alloc)
    order = sorted(range(len(sizes)), key=lambda i: (-(raw[i] - math.floor(raw[i])), i))
    while remaining > 0:
        progressed = False
        for i in order:
            if remaining == 0:
                break
            if alloc[i] < sizes[i]:
                alloc[i] += 1
                remaining -= 1
                progressed = True
        if not progressed:
            break
    return alloc


def plan_review_queue(
    records: Iterable[Any],
    threshold: float,
    budget: int,
    strategy: str = "uncertainty",
    rng_seed: Optional[int] = None,
    score_key: str = "stage_a_conf",
    theta_b: float = DEFAULT_THETA_B,
    n_strata: int = 4,
) -> List[Any]:
    """Ordered event ids to verify next, drawn from the unreviewed pool.

    Every strategy is deterministic given `rng_seed`; ties break on event id.
    """
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy {strategy!r}; expected one of {STRATEGIES}")
    if budget < 0:
        raise ValueError("budget must be non-negative")
    pool = _candidates(records, threshold, score_key)
    if not pool or budget == 0:
        return []

    if strategy == "random":
        rng = np.random.default_rng(rng_seed)
        idx = rng.permutation(len(pool))
        chosen = [pool[i] for i in idx[:budget]]
    elif strategy == "uncertainty":
        chosen = sorted(
            pool,
            key=lambda r: (abs(float(_field(r, score_key)) - threshold), _sort_id(_field(r, "id"))),
        )[:budget]
    elif strategy == "completeness":
        def _completeness_key(r: Any) -> Tuple[int, float, Tuple[int, float, str]]:
            q = _field(r, "completeness_score")
            if q is None:
                return (1, 0.0, _sort_id(_field(r, "id")))
            return (0, abs(float(q) - theta_b), _sort_id(_field(r, "id")))
        chosen = sorted(pool, key=_completeness_key)[:budget]
    else:
        chosen = _stratified(pool, threshold, budget, rng_seed, score_key, n_strata)

    return [_field(r, "id") for r in chosen]


def _stratified(
    pool: List[Any],
    threshold: float,
    budget: int,
    rng_seed: Optional[int],
    score_key: str,
    n_strata: int,
) -> List[Any]:
    """Proportional allocation over equal-width score strata, round-robin ordered.

    Round-robin means a queue truncated part-way is still balanced across strata.
    """
    if n_strata < 1:
        raise ValueError("n_strata must be >= 1")
    hi = max(float(_field(r, score_key)) for r in pool)
    upper = max(hi, threshold) + 1e-12
    width = (upper - threshold) / n_strata
    strata: List[List[Any]] = [[] for _ in range(n_strata)]
    for r in pool:
        s = float(_field(r, score_key))
        k = n_strata - 1 if width <= 0 else min(n_strata - 1, int((s - threshold) / width))
        strata[max(0, k)].append(r)

    rng = np.random.default_rng(rng_seed)
    alloc = _allocate(budget, [len(s) for s in strata])
    picked: List[List[Any]] = []
    for stratum, k in zip(strata, alloc):
        if k == 0 or not stratum:
            picked.append([])
            continue
        idx = rng.permutation(len(stratum))[:k]
        picked.append([stratum[i] for i in idx])

    out: List[Any] = []
    depth = max((len(p) for p in picked), default=0)
    for d in range(depth):
        for p in picked:
            if d < len(p):
                out.append(p[d])
    return out


def stopping_rule(current: PrecisionEstimate, target_half_width: float) -> Dict[str, Any]:
    """Whether verification can stop, with a human-readable justification."""
    if target_half_width <= 0.0:
        raise ValueError("target_half_width must be positive")
    if current.n_above_threshold == 0:
        return {
            "stop": True,
            "reason": (
                f"No detector detections at or above threshold {current.threshold:.3f}; "
                "there is nothing to verify."
            ),
        }
    if current.n_verified > 0 and current.half_width <= target_half_width:
        return {
            "stop": True,
            "reason": (
                f"Target met: {current.n_verified} verified give a "
                f"{current.confidence:.0%} half-width of {current.half_width:.4f} "
                f"(target {target_half_width:.4f}); precision "
                f"{current.point:.3f} [{current.ci_low:.3f}, {current.ci_high:.3f}]."
            ),
        }
    if current.n_unreviewed == 0:
        if current.n_verified == 0:
            return {
                "stop": True,
                "reason": (
                    f"All {current.n_above_threshold} detections above threshold are "
                    "excluded from review; no precision can be estimated."
                ),
            }
        return {
            "stop": True,
            "reason": (
                f"Population exhausted: all {current.n_above_threshold} detections above "
                f"threshold {current.threshold:.3f} are verified. Half-width "
                f"{current.half_width:.4f} is the best achievable and does not reach the "
                f"{target_half_width:.4f} target."
            ),
        }
    if current.n_verified == 0:
        return {
            "stop": False,
            "reason": (
                f"Cold start: no verified labels among {current.n_above_threshold} detections "
                f"above threshold {current.threshold:.3f}; precision is unknown."
            ),
        }
    return {
        "stop": False,
        "reason": (
            f"Half-width {current.half_width:.4f} exceeds the {target_half_width:.4f} target "
            f"after {current.n_verified} verifications; {current.n_unreviewed} detections "
            "remain unreviewed."
        ),
    }


@dataclass(frozen=True)
class ThresholdEvidence:
    """One row of a threshold sweep: the estimate and how well it is supported."""
    threshold: float
    estimate: PrecisionEstimate
    evidence: str

    def to_dict(self) -> Dict[str, Any]:
        d = self.estimate.to_dict()
        d["evidence"] = self.evidence
        return d


def threshold_sweep_precision(
    records: Iterable[Any],
    thresholds: Sequence[float],
    score_key: str = "stage_a_conf",
    confidence: float = 0.95,
    min_evidence: int = MIN_EVIDENCE,
) -> List[ThresholdEvidence]:
    """Precision at each candidate threshold, flagged by how many labels support it."""
    records = list(records)
    rows = []
    for t in thresholds:
        est = precision_estimate(records, t, score_key=score_key, confidence=confidence)
        evidence = "sufficient" if est.n_verified >= min_evidence else "insufficient"
        rows.append(ThresholdEvidence(threshold=float(t), estimate=est, evidence=evidence))
    return rows
