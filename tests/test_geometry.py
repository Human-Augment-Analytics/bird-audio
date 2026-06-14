from __future__ import annotations

import math

from birdpipe import geometry as g
from tests.conftest import make_box


def test_clip01_bounds():
    assert g.clip01(-0.5) == 0.0
    assert g.clip01(1.5) == 1.0
    assert g.clip01(0.3) == 0.3


def test_interval_iou_half_overlap():
    # [0,2] vs [1,3]: inter=1, union=3 -> 1/3
    assert math.isclose(g.interval_iou(0, 2, 1, 3), 1 / 3)


def test_interval_iou_disjoint_is_zero():
    assert g.interval_iou(0, 1, 2, 3) == 0.0


def test_box_iou_2d_identical_is_one():
    b = make_box(0, 1, 5000, 6000)
    assert math.isclose(g.box_iou_2d(b, b), 1.0)


def test_box_iou_2d_quarter_overlap():
    # a=[0,2]x[0,2], b=[1,3]x[1,3]; inter=1, areas=4+4, union=7 -> 1/7
    a = make_box(0, 2, 0, 2)
    b = make_box(1, 3, 1, 3)
    assert math.isclose(g.box_iou_2d(a, b), 1 / 7)


def test_edge_proximity_at_left_edge_is_one():
    # box hugging the left edge: norm_left=0 -> dist 0 -> e=1
    assert math.isclose(g.edge_proximity(0.0, 0.1, eta=0.08), 1.0)


def test_edge_proximity_far_from_edges_is_zero():
    # centered box, min dist 0.4 >> eta -> 0
    assert g.edge_proximity(0.4, 0.6, eta=0.08) == 0.0


def test_containment_full_inside():
    p = make_box(1, 2, 5000, 6000)
    env = make_box(0, 3, 4000, 7000)
    c_area, c_t, c_f = g.containment(p, env)
    assert math.isclose(c_area, 1.0)
    assert math.isclose(c_t, 1.0)
    assert math.isclose(c_f, 1.0)


def test_smaller_box_coverage():
    # small box fully inside big -> coverage 1.0
    small = make_box(1, 2, 5000, 6000)
    big = make_box(0, 4, 4000, 8000)
    assert math.isclose(g.smaller_box_coverage(small, big), 1.0)
