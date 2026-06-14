from __future__ import annotations

import pytest

from birdpipe.types import RawDetection, Box


def make_det(t_start, t_end, f_low, f_high, conf=0.9, window=0,
             norm_left=0.5, norm_right=0.6):
    """Factory for a RawDetection with sensible defaults for tests."""
    return RawDetection(
        t_start=t_start, t_end=t_end, f_low=f_low, f_high=f_high,
        conf=conf, window=window, norm_left=norm_left, norm_right=norm_right,
    )


def make_box(t_start, t_end, f_low, f_high):
    return Box(t_start=t_start, t_end=t_end, f_low=f_low, f_high=f_high)


@pytest.fixture
def det_factory():
    return make_det


@pytest.fixture
def box_factory():
    return make_box
