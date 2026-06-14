"""Event-target matching for native event-level evaluation (Table A.7)."""
from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np
from scipy.optimize import linear_sum_assignment

from . import geometry as g

_BIG = 1e6


def _is_candidate(pred, ref) -> bool:
    t_ok = (g.interval_overlap(pred.t_start, pred.t_end, ref.t_start, ref.t_end) > 0
            or abs(g.center(pred.t_start, pred.t_end) - g.center(ref.t_start, ref.t_end)) <= 0.50)
    f_ok = (g.interval_overlap(pred.f_low, pred.f_high, ref.f_low, ref.f_high) > 0
            or abs(g.center(pred.f_low, pred.f_high) - g.center(ref.f_low, ref.f_high)) <= 1000.0)
    return t_ok and f_ok


def _score(pred, ref) -> float:
    iou2d = g.box_iou_2d(pred, ref)
    iou_t = g.interval_iou(pred.t_start, pred.t_end, ref.t_start, ref.t_end)
    iou_f = g.interval_iou(pred.f_low, pred.f_high, ref.f_low, ref.f_high)
    c_small = g.smaller_box_coverage(pred, ref)
    max_d = max(pred.t_end - pred.t_start, ref.t_end - ref.t_start)
    max_bw = max(pred.f_high - pred.f_low, ref.f_high - ref.f_low)
    dt = abs(g.center(pred.t_start, pred.t_end) - g.center(ref.t_start, ref.t_end)) / max_d if max_d > 0 else 0.0
    df = abs(g.center(pred.f_low, pred.f_high) - g.center(ref.f_low, ref.f_high)) / max_bw if max_bw > 0 else 0.0
    conf = getattr(pred, "conf", 0.0)
    return iou2d + 0.25 * iou_t + 0.25 * iou_f + 0.25 * c_small - 0.10 * dt - 0.10 * df + 0.001 * conf


def match(preds: Sequence, refs: Sequence) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Return (matched pairs, false-positive pred indices, false-negative ref indices)."""
    if not preds or not refs:
        return [], list(range(len(preds))), list(range(len(refs)))
    cost = np.full((len(preds), len(refs)), _BIG)
    cand = np.zeros((len(preds), len(refs)), dtype=bool)
    for i, pr in enumerate(preds):
        for j, rf in enumerate(refs):
            if _is_candidate(pr, rf):
                cand[i, j] = True
                cost[i, j] = -_score(pr, rf)
    rows, cols = linear_sum_assignment(cost)
    pairs, matched_p, matched_r = [], set(), set()
    for i, j in zip(rows, cols):
        if cand[i, j]:
            pairs.append((int(i), int(j)))
            matched_p.add(int(i))
            matched_r.add(int(j))
    fp = [i for i in range(len(preds)) if i not in matched_p]
    fn = [j for j in range(len(refs)) if j not in matched_r]
    return pairs, fp, fn


def prf(tp: int, fp: int, fn: int) -> Tuple[float, float, float]:
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return precision, recall, f1
