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
