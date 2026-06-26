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


def link_kind(affinity_value: float, iou2d: float, min_conf: float, max_conf: float,
              margin: float, gap: int, e_ij: float, p: ConsolidationParams) -> str:
    """Classify a mutual-best candidate link as 'strong', 'support', or 'none'."""
    if (affinity_value >= p.strong_affinity and iou2d >= p.strong_iou2d
            and min_conf >= p.strong_min_conf and margin >= p.strong_margin):
        return "strong"
    if (affinity_value >= p.support_affinity and iou2d >= p.support_iou2d
            and min_conf >= p.support_min_conf and margin >= p.support_margin
            and gap <= p.support_gap_max
            and (max_conf >= p.support_edge_conf or e_ij >= p.support_edge)):
        return "support"
    return "none"


class _Track:
    __slots__ = ("members", "windows", "has_strong")

    def __init__(self) -> None:
        self.members: List[int] = []
        self.windows: set = set()
        self.has_strong: bool = False

    def add(self, idx: int, window: int, strong: bool) -> None:
        self.members.append(idx)
        self.windows.add(window)
        if strong:
            self.has_strong = True


def consolidate(dets: Sequence[RawDetection], p: ConsolidationParams = ConsolidationParams()) -> List[Event]:
    """Consolidate raw window-level detections into event-level tracks (§5.3.3)."""
    dets = [d for d in dets if d.conf >= p.ingest_conf]
    n = len(dets)
    if n == 0:
        return []

    eprox = [g.edge_proximity(d.norm_left, d.norm_right, p.eta) for d in dets]

    # candidate affinities (1 <= |w_i - w_j| <= G)
    nbr: List[dict] = [dict() for _ in range(n)]
    pairs: List[tuple] = []
    for i in range(n):
        for j in range(i + 1, n):
            gap = abs(dets[i].window - dets[j].window)
            if 1 <= gap <= p.window_gap_max:
                a = affinity(dets[i], dets[j], p)
                nbr[i][j] = a
                nbr[j][i] = a
                pairs.append((i, j, a))

    def best_partner(i: int):
        return max(nbr[i].items(), key=lambda kv: kv[1]) if nbr[i] else None

    def second_best(i: int, excl: int) -> float:
        vals = [a for k, a in nbr[i].items() if k != excl]
        return max(vals) if vals else 0.0

    bp = [best_partner(i) for i in range(n)]

    strong, support = [], []
    for i, j, a in pairs:
        if bp[i] is None or bp[j] is None or bp[i][0] != j or bp[j][0] != i:
            continue  # mutual-best only
        margin = min(a - second_best(i, j), a - second_best(j, i))
        ci, cj = dets[i].conf, dets[j].conf
        kind = link_kind(a, g.box_iou_2d(dets[i], dets[j]), min(ci, cj), max(ci, cj),
                         margin, abs(dets[i].window - dets[j].window),
                         max(eprox[i], eprox[j]), p)
        if kind == "strong":
            strong.append((a, i, j))
        elif kind == "support":
            support.append((a, i, j, max(ci, cj)))

    track_of: dict = {}
    tracks: dict = {}
    counter = [0]

    def new_track() -> int:
        tid = counter[0]
        counter[0] += 1
        tracks[tid] = _Track()
        return tid

    # Phase 1: strong links seed/merge tracks (descending affinity)
    for a, i, j in sorted(strong, key=lambda x: -x[0]):
        ti, tj = track_of.get(i), track_of.get(j)
        if ti is None and tj is None:
            tid = new_track()
            tracks[tid].add(i, dets[i].window, True)
            tracks[tid].add(j, dets[j].window, True)
            track_of[i] = track_of[j] = tid
        elif ti is not None and tj is None:
            if dets[j].window not in tracks[ti].windows:
                tracks[ti].add(j, dets[j].window, True)
                track_of[j] = ti
        elif ti is None and tj is not None:
            if dets[i].window not in tracks[tj].windows:
                tracks[tj].add(i, dets[i].window, True)
                track_of[i] = tj
        elif ti != tj and tracks[ti].windows.isdisjoint(tracks[tj].windows):
            for m in tracks[tj].members:
                tracks[ti].add(m, dets[m].window, True)
                track_of[m] = ti
            del tracks[tj]

    # Phase 2: support links extend seeded tracks; never merge two established tracks
    for a, i, j, maxc in sorted(support, key=lambda x: -x[0]):
        ti, tj = track_of.get(i), track_of.get(j)
        if ti is not None and tj is not None:
            continue
        if ti is None and tj is None:
            tid = new_track()
            tracks[tid].add(i, dets[i].window, False)
            tracks[tid].add(j, dets[j].window, False)
            track_of[i] = track_of[j] = tid
        elif ti is not None:
            if dets[j].window not in tracks[ti].windows and (maxc >= p.support_edge_conf or tracks[ti].has_strong):
                tracks[ti].add(j, dets[j].window, False)
                track_of[j] = ti
        else:
            if dets[i].window not in tracks[tj].windows and (maxc >= p.support_edge_conf or tracks[tj].has_strong):
                tracks[tj].add(i, dets[i].window, False)
                track_of[i] = tj

    # Phase 3: edge-singleton absorption into established multi-window tracks
    established = [tid for tid, t in tracks.items() if len(t.windows) >= 2]
    for s in [i for i in range(n) if i not in track_of]:
        if eprox[s] < p.absorb_edge:
            continue
        scored = []
        for tid in established:
            if dets[s].window in tracks[tid].windows:
                continue
            env = _envelope(tracks[tid].members, dets)
            c_area, c_t, c_f = g.containment(dets[s], env)
            if c_area < p.absorb_area or c_t < p.absorb_time or c_f < p.absorb_freq:
                continue
            aw = p.absorption
            d_s, bw_s = dets[s].t_end - dets[s].t_start, dets[s].f_high - dets[s].f_low
            dt = abs(g.center(dets[s].t_start, dets[s].t_end) - g.center(env.t_start, env.t_end)) / d_s if d_s > 0 else 0.0
            df = abs(g.center(dets[s].f_low, dets[s].f_high) - g.center(env.f_low, env.f_high)) / bw_s if bw_s > 0 else 0.0
            c_tk = max(dets[m].conf for m in tracks[tid].members)
            score = (aw.area * c_area + aw.time * c_t + aw.freq * c_f + aw.edge * eprox[s]
                     + aw.singleton_conf * dets[s].conf + aw.track_conf * c_tk
                     - aw.center_t * min(dt, 2.0) - aw.center_f * min(df, 2.0))
            scored.append((score, tid))
        if not scored:
            continue
        scored.sort(key=lambda x: -x[0])
        best_score, best_tid = scored[0]
        second = scored[1][0] if len(scored) > 1 else 0.0
        if best_score >= p.absorb_score and (best_score - second) >= p.absorb_margin:
            tracks[best_tid].add(s, dets[s].window, False)
            track_of[s] = best_tid

    # Phase 4: build events from tracks + remaining untracked singletons
    events: List[Event] = [_fuse(t.members, dets, p) for t in tracks.values()]
    for i in range(n):
        if i not in track_of:
            d = dets[i]
            events.append(Event(d.t_start, d.t_end, d.f_low, d.f_high, d.conf, [i]))

    # Phase 5: duplicate merging pass (1D Time IoU >= 0.75)
    merged_any = True
    while merged_any:
        merged_any = False
        m = len(events)
        for i in range(m):
            for j in range(i + 1, m):
                # Respect overlap preservation: do not merge if they share any source windows
                win_i = {dets[idx].window for idx in events[i].members}
                win_j = {dets[idx].window for idx in events[j].members}
                if not win_i.isdisjoint(win_j):
                    continue

                iou_t = g.interval_iou(events[i].t_start, events[i].t_end, events[j].t_start, events[j].t_end)
                if iou_t >= 0.75:
                    union_members = list(set(events[i].members) | set(events[j].members))
                    new_event = _fuse(union_members, dets, p)
                    events = [events[k] for k in range(m) if k != i and k != j] + [new_event]
                    merged_any = True
                    break
            if merged_any:
                break

    events.sort(key=lambda e: e.t_start)
    return events


