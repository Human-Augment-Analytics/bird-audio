from __future__ import annotations

import math

from birdpipe import coords, constants as C


def test_centered_box_window_zero():
    # full-width, full-height box centred in window 0
    d = coords.map_box(x=0.5, y=0.5, w=1.0, h=1.0, conf=0.9, window=0)
    assert math.isclose(d.t_start, 0.0)
    assert math.isclose(d.t_end, C.T_W)
    assert math.isclose(d.f_low, C.F_MIN_HZ)
    assert math.isclose(d.f_high, C.F_MAX_HZ)


def test_window_offset_adds_stride():
    d0 = coords.map_box(0.5, 0.5, 0.2, 0.2, 0.9, window=0)
    d3 = coords.map_box(0.5, 0.5, 0.2, 0.2, 0.9, window=3)
    assert math.isclose(d3.t_start - d0.t_start, 3 * C.DELTA_T)


def test_y_is_flipped():
    # small box high in the image (small y) -> high frequency
    high = coords.map_box(0.5, 0.1, 0.1, 0.1, 0.9, window=0)
    low = coords.map_box(0.5, 0.9, 0.1, 0.1, 0.9, window=0)
    assert high.f_low > low.f_low
    assert high.f_high > low.f_high


def test_norm_edges_recorded():
    d = coords.map_box(0.5, 0.5, 0.4, 0.4, 0.9, window=2)
    assert math.isclose(d.norm_left, 0.3)
    assert math.isclose(d.norm_right, 0.7)
