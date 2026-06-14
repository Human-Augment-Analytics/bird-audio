"""Window-geometry event consolidation (paper §5.3.3, Table A.6, Eq A.1)."""
from __future__ import annotations

from typing import List, Sequence

from . import geometry as g
from .constants import ConsolidationParams
from .types import Box, Event, RawDetection


def affinity(a: RawDetection, b: RawDetection, p: ConsolidationParams) -> float:
    """Pairwise association score A_ij (Eq 1), clipped to [0,1]."""
    w = p.affinity
    d_a, d_b = a.t_end - a.t_start, b.t_end - b.t_start
    bw_a, bw_b = a.f_high - a.f_low, b.f_high - b.f_low
    max_d, max_bw = max(d_a, d_b), max(bw_a, bw_b)
    rho_t = min(d_a, d_b) / max_d if max_d > 0 else 0.0
    rho_f = min(bw_a, bw_b) / max_bw if max_bw > 0 else 0.0
    delta_t = abs(g.center(a.t_start, a.t_end) - g.center(b.t_start, b.t_end)) / max_d if max_d > 0 else 0.0
    delta_f = abs(g.center(a.f_low, a.f_high) - g.center(b.f_low, b.f_high)) / max_bw if max_bw > 0 else 0.0
    iou2d = g.box_iou_2d(a, b)
    iou_t = g.interval_iou(a.t_start, a.t_end, b.t_start, b.t_end)
    iou_f = g.interval_iou(a.f_low, a.f_high, b.f_low, b.f_high)
    e_ij = max(g.edge_proximity(a.norm_left, a.norm_right, p.eta),
               g.edge_proximity(b.norm_left, b.norm_right, p.eta))
    gap = abs(a.window - b.window)
    score = (w.iou2d * iou2d + w.iou_t * iou_t + w.iou_f * iou_f
             + w.dur_ratio * rho_t + w.bw_ratio * rho_f
             + w.min_conf * min(a.conf, b.conf) + w.edge * e_ij
             - w.center_t * min(delta_t, 2.0) - w.center_f * min(delta_f, 2.0)
             - w.window_gap * max(gap - 1, 0))
    return g.clip01(score)


def weighted_median(values: Sequence[float], weights: Sequence[float]) -> float:
    """Lower weighted median: smallest v where cumulative weight >= half of total."""
    pairs = sorted(zip(values, weights), key=lambda vw: vw[0])
    total = sum(w for _, w in pairs)
    if total <= 0:
        vals = sorted(values)
        return vals[len(vals) // 2]
    half = total / 2.0
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= half:
            return v
    return pairs[-1][0]


def _fuse(members: List[int], dets: Sequence[RawDetection], p: ConsolidationParams) -> Event:
    """Convert a track (member indices) into a consolidated Event.

    Frequency bounds: confidence-weighted median over all members. Time bounds:
    edge-censored confidence-weighted median (starts near a window's left edge are
    excluded from the start vote; ends near the right edge from the end vote), so
    truncated partial views do not pull the boundary inward.

    NOTE (fidelity risk #4): the paper's "expand the final boundary when necessary"
    extent-preservation nuance is approximated here by the ordering guard; validate
    against reference outputs.
    """
    confs = [dets[m].conf for m in members]
    conf = max(confs)
    f_low = weighted_median([dets[m].f_low for m in members], confs)
    f_high = weighted_median([dets[m].f_high for m in members], confs)

    left_ok = [m for m in members if dets[m].norm_left > p.eta]
    right_ok = [m for m in members if (1.0 - dets[m].norm_right) > p.eta]
    if not left_ok:
        left_ok = list(members)
    if not right_ok:
        right_ok = list(members)
    t_start = weighted_median([dets[m].t_start for m in left_ok], [dets[m].conf for m in left_ok])
    t_end = weighted_median([dets[m].t_end for m in right_ok], [dets[m].conf for m in right_ok])
    if t_end <= t_start:
        t_start = min(dets[m].t_start for m in members)
        t_end = max(dets[m].t_end for m in members)
    return Event(t_start=t_start, t_end=t_end, f_low=f_low, f_high=f_high,
                 conf=conf, members=sorted(members))


def _envelope(members: List[int], dets: Sequence[RawDetection]) -> Box:
    return Box(
        t_start=min(dets[m].t_start for m in members),
        t_end=max(dets[m].t_end for m in members),
        f_low=min(dets[m].f_low for m in members),
        f_high=max(dets[m].f_high for m in members),
    )
