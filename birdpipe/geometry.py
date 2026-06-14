"""Pure time-frequency geometry helpers."""
from __future__ import annotations

from typing import Tuple


def clip01(x: float) -> float:
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


def interval_overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def interval_iou(a0: float, a1: float, b0: float, b1: float) -> float:
    inter = interval_overlap(a0, a1, b0, b1)
    union = (a1 - a0) + (b1 - b0) - inter
    return inter / union if union > 0 else 0.0


def _area(box) -> float:
    return (box.t_end - box.t_start) * (box.f_high - box.f_low)


def box_iou_2d(a, b) -> float:
    inter = (interval_overlap(a.t_start, a.t_end, b.t_start, b.t_end)
             * interval_overlap(a.f_low, a.f_high, b.f_low, b.f_high))
    union = _area(a) + _area(b) - inter
    return inter / union if union > 0 else 0.0


def smaller_box_coverage(a, b) -> float:
    inter = (interval_overlap(a.t_start, a.t_end, b.t_start, b.t_end)
             * interval_overlap(a.f_low, a.f_high, b.f_low, b.f_high))
    smaller = min(_area(a), _area(b))
    return inter / smaller if smaller > 0 else 0.0


def center(lo: float, hi: float) -> float:
    return 0.5 * (lo + hi)


def edge_proximity(norm_left: float, norm_right: float, eta: float) -> float:
    """e_i = clip01((eta - min(left_dist, right_dist)) / eta).

    left_dist = norm_left, right_dist = 1 - norm_right. A box touching either
    time edge of its source window scores ~1; a centred box scores 0.
    """
    dist = min(norm_left, 1.0 - norm_right)
    return clip01((eta - dist) / eta)


def containment(p, env) -> Tuple[float, float, float]:
    """Eq A.1 containment of box p within envelope env: (C_area, C_t, C_f)."""
    inter_t = interval_overlap(p.t_start, p.t_end, env.t_start, env.t_end)
    inter_f = interval_overlap(p.f_low, p.f_high, env.f_low, env.f_high)
    area_p = _area(p)
    dur_p = p.t_end - p.t_start
    bw_p = p.f_high - p.f_low
    c_area = (inter_t * inter_f) / area_p if area_p > 0 else 0.0
    c_t = inter_t / dur_p if dur_p > 0 else 0.0
    c_f = inter_f / bw_p if bw_p > 0 else 0.0
    return c_area, c_t, c_f
