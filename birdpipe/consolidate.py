"""Window-geometry event consolidation (paper §5.3.3, Table A.6, Eq A.1).

Port of SpectroBird's locked A3 linker (``_a3_reference``, BELC_A3_v1_20260418):
mutual-best candidate edges per window pair, strong/support track assembly,
edge-singleton absorption, and edge-censored boundary fusion with extent
preservation. Given the same raw detections it yields the same events.
"""
from __future__ import annotations

import statistics
from typing import Dict, List, Sequence

from . import geometry as g
from .constants import ConsolidationParams
from .types import Box, Event, RawDetection

EPS = 1e-12
_RULE_RANK = {"strong": 0, "support": 2}


def _edge_value(d: RawDetection, p: ConsolidationParams) -> float:
    """Time-edge proximity: 0 away from a window edge, 1 at/past one."""
    dist = min(d.norm_left, 1.0 - d.norm_right)
    return g.clip01((p.eta - dist) / max(p.eta, EPS))


def affinity(a: RawDetection, b: RawDetection, p: ConsolidationParams) -> float:
    """Pairwise association score A_ij (Eq 1), clipped to [0,1]."""
    w = p.affinity
    d_a, d_b = max(0.0, a.t_end - a.t_start), max(0.0, b.t_end - b.t_start)
    bw_a, bw_b = max(0.0, a.f_high - a.f_low), max(0.0, b.f_high - b.f_low)
    max_d, max_bw = max(d_a, d_b), max(bw_a, bw_b)
    rho_t = min(d_a, d_b) / max_d if max_d > 0 else 0.0
    rho_f = min(bw_a, bw_b) / max_bw if max_bw > 0 else 0.0
    dct = abs(g.center(a.t_start, a.t_end) - g.center(b.t_start, b.t_end))
    dcf = abs(g.center(a.f_low, a.f_high) - g.center(b.f_low, b.f_high))
    delta_t = dct / max_d if max_d > 0 else 1.0
    delta_f = dcf / max_bw if max_bw > 0 else 1.0
    iou2d = g.box_iou_2d(a, b)
    iou_t = g.interval_iou(a.t_start, a.t_end, b.t_start, b.t_end)
    iou_f = g.interval_iou(a.f_low, a.f_high, b.f_low, b.f_high)
    e_ij = max(_edge_value(a, p), _edge_value(b, p))
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
    if all(w <= 0.0 for _, w in pairs):
        return float(statistics.median(values))
    half = 0.5 * sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= half:
            return v
    return pairs[-1][0]


def _time_bounds(members: List[int], dets: Sequence[RawDetection], p: ConsolidationParams):
    """Edge-censored weighted median with extent preservation.

    Starts near a window's left edge (ends near its right edge) are censored: they do
    not vote in the weighted median, but they can still widen the fused boundary to
    the observed extent.
    """
    start_edge = [m for m in members if dets[m].norm_left <= p.eta + EPS]
    end_edge = [m for m in members if (1.0 - dets[m].norm_right) <= p.eta + EPS]
    start_ok = [m for m in members if m not in start_edge] or list(members)
    end_ok = [m for m in members if m not in end_edge] or list(members)
    t_start = weighted_median([dets[m].t_start for m in start_ok], [dets[m].conf for m in start_ok])
    t_end = weighted_median([dets[m].t_end for m in end_ok], [dets[m].conf for m in end_ok])
    if start_edge:
        t_start = min(t_start, min(dets[m].t_start for m in start_edge))
    if end_edge:
        t_end = max(t_end, max(dets[m].t_end for m in end_edge))
    return t_start, t_end


def _fuse(members: List[int], dets: Sequence[RawDetection], p: ConsolidationParams) -> Event:
    """Convert a track (member indices) into a consolidated Event."""
    confs = [dets[m].conf for m in members]
    t_start, t_end = _time_bounds(members, dets, p)
    f_low = weighted_median([dets[m].f_low for m in members], confs)
    f_high = weighted_median([dets[m].f_high for m in members], confs)
    if t_end < t_start:
        t_start, t_end = t_end, t_start
    if f_high < f_low:
        f_low, f_high = f_high, f_low
    return Event(t_start=t_start, t_end=t_end, f_low=f_low, f_high=f_high,
                 conf=max(confs), members=sorted(members))


def _envelope(members, dets: Sequence[RawDetection]) -> Box:
    return Box(
        t_start=min(dets[m].t_start for m in members),
        t_end=max(dets[m].t_end for m in members),
        f_low=min(dets[m].f_low for m in members),
        f_high=max(dets[m].f_high for m in members),
    )


def link_kind(affinity_value: float, iou2d: float, min_conf: float, max_conf: float,
              margin: float, gap: int, e_ij: float, p: ConsolidationParams) -> str:
    """Classify a mutual-best candidate link as 'strong', 'support', or 'none'."""
    if (affinity_value + EPS >= p.strong_affinity and iou2d + EPS >= p.strong_iou2d
            and min_conf + EPS >= p.strong_min_conf and margin + EPS >= p.strong_margin):
        return "strong"
    if (gap <= p.support_gap_max
            and affinity_value + EPS >= p.support_affinity and iou2d + EPS >= p.support_iou2d
            and min_conf + EPS >= p.support_min_conf and margin + EPS >= p.support_margin
            and (max_conf + EPS >= p.support_edge_conf or e_ij + EPS >= p.support_edge)):
        return "support"
    return "none"


def _second(values: List[float]) -> float:
    return sorted(values)[-2] if len(values) > 1 else 0.0


def _candidate_edges(dets: Sequence[RawDetection], p: ConsolidationParams) -> List[tuple]:
    """Mutual-best links between every pair of windows at most G apart."""
    by_window: Dict[int, List[int]] = {}
    for i, d in enumerate(dets):
        by_window.setdefault(d.window, []).append(i)
    windows = sorted(by_window)

    edges = []
    for pos, w0 in enumerate(windows):
        left = by_window[w0]
        for w1 in windows[pos + 1:]:
            gap = w1 - w0
            if gap > p.window_gap_max:
                break
            right = by_window[w1]
            aff = [[affinity(dets[i], dets[j], p) for j in right] for i in left]
            cols = [[aff[r][c] for r in range(len(left))] for c in range(len(right))]
            row_best = [row.index(max(row)) for row in aff]
            col_best = [col.index(max(col)) for col in cols]
            for r, c in enumerate(row_best):
                if col_best[c] != r:
                    continue
                i, j = left[r], right[c]
                a = aff[r][c]
                iou = g.box_iou_2d(dets[i], dets[j])
                if iou <= 0.0 or a <= 0.0:
                    continue
                margin = min(a - _second(aff[r]), a - _second(cols[c]))
                ci, cj = dets[i].conf, dets[j].conf
                kind = link_kind(a, iou, min(ci, cj), max(ci, cj), margin, gap,
                                 max(_edge_value(dets[i], p), _edge_value(dets[j], p)), p)
                if kind != "none":
                    edges.append((i, j, kind, a, iou, min(ci, cj), margin, gap))
    # strongest rule first, then affinity, IoU, confidence, margin desc; smaller gap first
    edges.sort(key=lambda e: (_RULE_RANK[e[2]], -e[3], -e[4], -e[5], -e[6], e[7]))
    return edges


def consolidate(dets: Sequence[RawDetection], p: ConsolidationParams = ConsolidationParams()) -> List[Event]:
    """Consolidate raw window-level detections into event-level tracks (§5.3.3)."""
    dets = [d for d in dets if d.conf + EPS >= p.ingest_conf]
    n = len(dets)
    if n == 0:
        return []

    tracks: Dict[int, dict] = {}
    track_of: Dict[int, int] = {}

    def ensure_track(i: int) -> int:
        if i not in track_of:
            tid = ensure_track.next_id
            ensure_track.next_id += 1
            track_of[i] = tid
            tracks[tid] = {"members": {i}, "windows": {dets[i].window},
                           "max_conf": dets[i].conf, "has_strong": False}
        return track_of[i]
    ensure_track.next_id = 0

    def seeded(t: dict) -> bool:
        return t["has_strong"] or t["max_conf"] + EPS >= p.support_edge_conf

    def established(t: dict) -> bool:
        return t["has_strong"] or len(t["members"]) > 1

    # Track assembly: strong links merge any two tracks; a support link may only
    # extend a seeded track by a track that is not itself established.
    for i, j, kind, *_ in _candidate_edges(dets, p):
        ta, tb = ensure_track(i), ensure_track(j)
        if ta == tb:
            if kind == "strong":
                tracks[ta]["has_strong"] = True
            continue
        A, B = tracks[ta], tracks[tb]
        if A["windows"] & B["windows"]:
            continue
        keep, drop = ta, tb
        if kind == "support":
            if not seeded(A) and not seeded(B):
                continue
            if established(A) and established(B):
                continue
            if seeded(B) and not seeded(A):
                keep, drop = tb, ta
            elif not (seeded(A) and not seeded(B)) and len(B["members"]) > len(A["members"]):
                keep, drop = tb, ta
        elif len(B["members"]) > len(A["members"]):
            keep, drop = tb, ta
        K, D = tracks[keep], tracks[drop]
        K["members"] |= D["members"]
        K["windows"] |= D["windows"]
        K["max_conf"] = max(K["max_conf"], D["max_conf"])
        K["has_strong"] = K["has_strong"] or D["has_strong"] or kind == "strong"
        for m in D["members"]:
            track_of[m] = keep
        del tracks[drop]

    for i in range(n):
        ensure_track(i)

    # Edge-singleton absorption into established multi-window tracks. Candidates are
    # scored against the pre-absorption tracks, then assigned singleton by singleton.
    active = list(tracks)
    candidates: Dict[int, List[tuple]] = {}
    aw = p.absorption
    for s_tid in active:
        if len(tracks[s_tid]["members"]) != 1:
            continue
        s = next(iter(tracks[s_tid]["members"]))
        edge = _edge_value(dets[s], p)
        if edge + EPS < p.absorb_edge:
            continue
        d = dets[s]
        d_s, bw_s = max(0.0, d.t_end - d.t_start), max(0.0, d.f_high - d.f_low)
        for t_tid in active:
            target = tracks[t_tid]
            if t_tid == s_tid or len(target["members"]) <= 1 or d.window in target["windows"]:
                continue
            if not seeded(target):
                continue
            env = _envelope(target["members"], dets)
            c_area, c_t, c_f = g.containment(d, env)
            if c_area + EPS < p.absorb_area or c_t + EPS < p.absorb_time or c_f + EPS < p.absorb_freq:
                continue
            dt = abs(g.center(d.t_start, d.t_end) - g.center(env.t_start, env.t_end))
            df = abs(g.center(d.f_low, d.f_high) - g.center(env.f_low, env.f_high))
            dt /= max(d_s, env.t_end - env.t_start, EPS)
            df /= max(bw_s, env.f_high - env.f_low, EPS)
            score = (aw.area * c_area + aw.time * c_t + aw.freq * c_f + aw.edge * edge
                     + aw.singleton_conf * d.conf + aw.track_conf * min(target["max_conf"], 1.0)
                     - aw.center_t * min(dt, 2.0) - aw.center_f * min(df, 2.0))
            if score + EPS < p.absorb_score:
                continue
            candidates.setdefault(s_tid, []).append((score, t_tid, s))

    for s_tid, cands in candidates.items():
        cands.sort(key=lambda x: -x[0])
        if len(cands) > 1 and (cands[0][0] - cands[1][0]) + EPS < p.absorb_margin:
            continue
        _, t_tid, s = cands[0]
        target = tracks[t_tid]
        if dets[s].window in target["windows"]:
            continue
        target["members"].add(s)
        target["windows"].add(dets[s].window)
        target["max_conf"] = max(target["max_conf"], dets[s].conf)
        track_of[s] = t_tid
        del tracks[s_tid]

    fused = [(tid, _fuse(sorted(tracks[tid]["members"]), dets, p)) for tid in sorted(tracks)]
    fused.sort(key=lambda te: (te[1].t_start, te[0]))
    events = [e for _, e in fused]

    if p.post_dedup:
        events = _post_dedup(events, dets, p)
    return events


def _post_dedup(events: List[Event], dets: Sequence[RawDetection], p: ConsolidationParams) -> List[Event]:
    """Optional extra passes (not in SpectroBird): time-IoU duplicate merge, then
    contained-singleton folding."""
    # Duplicate merging (1D time IoU >= 0.75) between events from disjoint windows.
    merged_any = True
    while merged_any:
        merged_any = False
        m = len(events)
        for i in range(m):
            for j in range(i + 1, m):
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

    # Contained-singleton folding: a singleton almost entirely inside a longer event in
    # the same band is a partial view of it. Keep the host's boundaries, take the max
    # confidence. Hosts are established tracks first, then any strictly longer event.
    folded: set = set()
    order = sorted(range(len(events)), key=lambda k: events[k].t_end - events[k].t_start)
    for k in order:
        ev = events[k]
        if len(ev.members) != 1:
            continue
        dur = ev.t_end - ev.t_start
        best, best_key = None, None
        for h, host in enumerate(events):
            if h == k or h in folded:
                continue
            host_dur = host.t_end - host.t_start
            if len(host.members) < 2:
                if host_dur <= dur or dets[host.members[0]].window == dets[ev.members[0]].window:
                    continue
            _, c_t, c_f = g.containment(ev, host)
            if c_t >= p.contained_time and c_f >= p.contained_freq:
                key = (len(host.members) >= 2, c_t, c_f, host_dur)
                if best_key is None or key > best_key:
                    best, best_key = host, key
        if best is not None:
            best.members = sorted(set(best.members) | set(ev.members))
            best.conf = max(best.conf, ev.conf)
            folded.add(k)
    events = [e for k, e in enumerate(events) if k not in folded]
    events.sort(key=lambda e: e.t_start)
    return events
