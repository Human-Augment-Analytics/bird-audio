from __future__ import annotations

import math

from birdpipe import consolidate as cons
from birdpipe.constants import ConsolidationParams
from tests.conftest import make_det

P = ConsolidationParams()


def test_affinity_identical_adjacent_windows():
    # identical centred boxes, gap 1 -> A = 0.45+0.14+0.14+0.10+0.08+0.05*0.9 = 0.955
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.45, norm_right=0.55)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.45, norm_right=0.55)
    assert math.isclose(cons.affinity(a, b, P), 0.955, abs_tol=1e-6)


def test_affinity_window_gap_penalty():
    # same boxes, gap 3 -> minus 0.03*(3-1)=0.06 -> 0.895
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.45, norm_right=0.55)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=3, norm_left=0.45, norm_right=0.55)
    assert math.isclose(cons.affinity(a, b, P), 0.895, abs_tol=1e-6)


def test_weighted_median_uniform():
    assert cons.weighted_median([1.0, 2.0, 3.0], [1.0, 1.0, 1.0]) == 2.0


def test_weighted_median_skewed():
    # heavy weight on 3 pulls the median up
    assert cons.weighted_median([1.0, 2.0, 3.0], [1.0, 1.0, 5.0]) == 3.0


def test_fuse_conf_and_weighted_freq():
    a = make_det(1.0, 2.0, 5000, 6000, conf=0.8, window=0, norm_left=0.4, norm_right=0.6)
    b = make_det(1.1, 2.1, 5100, 6100, conf=0.9, window=1, norm_left=0.4, norm_right=0.6)
    ev = cons._fuse([0, 1], [a, b], P)
    assert ev.conf == 0.9                      # max member confidence
    assert ev.f_low == 5100 and ev.f_high == 6100   # conf-weighted median favours b
    assert ev.t_start == 1.1 and ev.t_end == 2.1
    assert ev.members == [0, 1]


def test_fuse_excludes_left_truncated_from_start_vote():
    # a hugs the left window edge (norm_left=0.0 -> censored from start vote)
    a = make_det(1.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.0, norm_right=0.5)
    b = make_det(1.3, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.3, norm_right=0.6)
    ev = cons._fuse([0, 1], [a, b], P)
    assert ev.t_start == 1.3                    # a excluded -> b's start wins


def test_link_kind_strong():
    assert cons.link_kind(0.80, 0.60, 0.30, 0.90, 0.10, 1, 0.0, P) == "strong"


def test_link_kind_support():
    # below strong gates, above support gates, high max-conf satisfies edge requirement
    assert cons.link_kind(0.65, 0.40, 0.15, 0.80, 0.05, 1, 0.0, P) == "support"


def test_link_kind_support_needs_conf_or_edge():
    # support thresholds met but max-conf<0.70 and e_ij<0.50 -> none
    assert cons.link_kind(0.65, 0.40, 0.15, 0.50, 0.05, 1, 0.0, P) == "none"


def test_link_kind_none():
    assert cons.link_kind(0.50, 0.20, 0.05, 0.20, 0.01, 1, 0.0, P) == "none"


def test_consolidate_merges_strong_pair():
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.45, norm_right=0.55)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.45, norm_right=0.55)
    events = cons.consolidate([a, b], P)
    assert len(events) == 1
    assert events[0].members == [0, 1]


def test_consolidate_same_window_never_merges():
    # two detections in the SAME window must stay separate (overlap preservation)
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0)
    events = cons.consolidate([a, b], P)
    assert len(events) == 2


def test_consolidate_ingest_conf_filter():
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.0005, window=0)
    assert cons.consolidate([a], P) == []


def test_consolidate_absorbs_edge_singleton():
    # strong pair in windows 0,1 forms a track; a small near-edge box in window 2,
    # fully contained in the envelope, is absorbed (not linked: IoU too low).
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.4, norm_right=0.6)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.4, norm_right=0.6)
    c = make_det(0.1, 0.4, 5400, 5600, conf=0.5, window=2, norm_left=0.0, norm_right=0.06)
    events = cons.consolidate([a, b, c], P)
    assert len(events) == 1
    assert events[0].members == [0, 1, 2]


def test_duplicate_merging_1d_time_iou_threshold():
    # a and b are in different windows, high/low frequency (no affinity link).
    # Time IoU is 1.8 / 2.2 = 0.818 >= 0.75 -> should merge.
    a = make_det(0.0, 2.0, 1000, 2000, conf=0.9, window=0)
    b = make_det(0.2, 2.2, 8000, 9000, conf=0.8, window=1)
    events = cons.consolidate([a, b], P)
    assert len(events) == 1
    assert events[0].members == [0, 1]

    # d and e have Time IoU of 1.4 / 2.6 = 0.538 < 0.75 -> should not merge.
    d = make_det(0.0, 2.0, 1000, 2000, conf=0.9, window=0)
    e = make_det(0.6, 2.6, 8000, 9000, conf=0.8, window=1)
    events2 = cons.consolidate([d, e], P)
    assert len(events2) == 2


def test_duplicate_merging_tracks_and_singletons():
    # a and b will link in Phase 1 (same box, adjacent windows) to form a track.
    # c is a singleton in window 2 at high frequency (no tracking link).
    # Track has interval [0.0, 2.0], c has interval [0.2, 2.2].
    # Time IoU between track and c is 0.818 >= 0.75 -> should merge.
    a = make_det(0.0, 2.0, 1000, 1100, conf=0.9, window=0, norm_left=0.5, norm_right=0.5)
    b = make_det(0.0, 2.0, 1000, 1100, conf=0.9, window=1, norm_left=0.5, norm_right=0.5)
    c = make_det(0.2, 2.2, 8000, 8100, conf=0.8, window=2)
    events = cons.consolidate([a, b, c], P)
    assert len(events) == 1
    assert events[0].members == [0, 1, 2]


def test_duplicate_merging_respects_overlap_preservation():
    # a and b overlap in time (IoU = 0.818) but are in the SAME window (window=0).
    # They should not be merged (overlap preservation constraint).
    a = make_det(0.0, 2.0, 1000, 1100, conf=0.9, window=0)
    b = make_det(0.2, 2.2, 8000, 8100, conf=0.8, window=0)
    events = cons.consolidate([a, b], P)
    assert len(events) == 2


def test_duplicate_merging_iterative_disjoint_window_chains():
    # a (window 0) and b (window 1) overlap with Time IoU >= 0.75
    # b (window 1) and c (window 0) overlap with Time IoU >= 0.75
    # a and c share window 0.
    # One of them will merge with b, but the remaining one cannot merge (no shared windows allowed).
    # Thus, we must end up with exactly 2 events.
    a = make_det(0.0, 2.0, 1000, 1100, conf=0.9, window=0)
    b = make_det(0.1, 2.1, 8000, 8100, conf=0.8, window=1)
    c = make_det(0.0, 2.0, 5000, 5100, conf=0.9, window=0)
    events = cons.consolidate([a, b, c], P)
    assert len(events) == 2
    # Ensure one event has 2 members, and the other has 1 member
    lens = sorted([len(ev.members) for ev in events])
    assert lens == [1, 2]



def test_contained_singleton_is_folded_into_track():
    # Windows 0 and 1 form a strong track spanning 0.0-2.0 s. A lone box from window 1
    # covering only 1.2-2.0 s cannot be absorbed (its window is already in the track) and
    # has time IoU 0.4 (< 0.75), so it used to survive as a duplicate row.
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.4, norm_right=0.6)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.4, norm_right=0.6)
    dup = make_det(1.2, 2.0, 5100, 5900, conf=0.95, window=1, norm_left=0.7, norm_right=0.95)
    events = cons.consolidate([a, b, dup], P)
    assert len(events) == 1
    assert events[0].members == [0, 1, 2]
    assert events[0].conf == 0.95
    assert (events[0].t_start, events[0].t_end) == (0.0, 2.0)  # track boundaries unchanged


def test_contained_singleton_in_other_band_is_kept():
    # Same geometry in time, but a different frequency band: a distinct simultaneous call.
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.4, norm_right=0.6)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.4, norm_right=0.6)
    other = make_det(1.2, 2.0, 8000, 9000, conf=0.8, window=1, norm_left=0.7, norm_right=0.95)
    events = cons.consolidate([a, b, other], P)
    assert len(events) == 2


def test_partially_contained_singleton_is_kept():
    # Only half of the singleton lies inside the track: below the 0.90 containment gate.
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0, norm_left=0.4, norm_right=0.6)
    b = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=1, norm_left=0.4, norm_right=0.6)
    tail = make_det(1.6, 2.4, 5000, 6000, conf=0.8, window=1, norm_left=0.8, norm_right=1.0)
    events = cons.consolidate([a, b, tail], P)
    assert len(events) == 2


def test_two_singletons_from_one_window_never_suppress_each_other():
    # Two boxes the localizer emitted in the same window are distinct by construction.
    a = make_det(0.0, 2.0, 5000, 6000, conf=0.9, window=0)
    inner = make_det(0.5, 1.5, 5000, 6000, conf=0.8, window=0)
    events = cons.consolidate([a, inner], P)
    assert len(events) == 2


def test_singleton_contained_in_longer_singleton_from_other_window_is_folded():
    # Real case (20250530_070000.WAV): 391.94-392.82 and 391.95-392.55 in the same band
    # from adjacent windows. Time IoU 0.68 misses phase 5; neither is a multi-window track.
    host = make_det(0.0, 0.88, 6725, 8860, conf=0.31, window=0, norm_left=0.5, norm_right=0.9)
    inner = make_det(0.01, 0.61, 6713, 8839, conf=0.38, window=1, norm_left=0.05, norm_right=0.4)
    events = cons.consolidate([host, inner], P)
    assert len(events) == 1
    assert events[0].members == [0, 1]
    assert events[0].conf == 0.38
    assert (events[0].t_start, events[0].t_end) == (0.0, 0.88)
