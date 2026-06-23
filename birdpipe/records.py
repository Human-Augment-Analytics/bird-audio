"""Finalize completeness/retention and serialize analysis-ready records (§5.5)."""
from __future__ import annotations

from typing import Dict, Iterable, List

from .types import Event


def finalize_events(events: Iterable[Event], theta_a: float, theta_b: float) -> List[Event]:
    """Set completeness_label (q >= θ_B) and retained (c >= θ_A AND q >= θ_B)."""
    out = []
    for e in events:
        q = e.completeness_score if e.completeness_score is not None else 0.0
        e.completeness_label = "complete" if q >= theta_b else "incomplete"
        e.retained = (e.conf >= theta_a) and (q >= theta_b)
        out.append(e)
    return out


def to_record(e: Event) -> Dict:
    return {
        "t_start": e.t_start,
        "t_end": e.t_end,
        "duration": e.duration,
        "f_low": e.f_low,
        "f_high": e.f_high,
        "center_freq": e.center_freq,
        "stage_a_conf": e.conf,
        "completeness_score": e.completeness_score,
        "completeness_label": e.completeness_label,
        "retained": e.retained,
        "n_members": len(e.members),
    }
