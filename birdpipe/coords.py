"""Stage A box → absolute time/frequency mapping (paper §5.3.2)."""
from __future__ import annotations

from . import constants as C
from .types import RawDetection


def map_box(x: float, y: float, w: float, h: float, conf: float, window: int,
            dt: float = C.DELTA_T, tw: float = C.T_W,
            f_min: float = C.F_MIN_HZ, f_max: float = C.F_MAX_HZ) -> RawDetection:
    """Map a normalized YOLO box (centres x,y; size w,h in [0,1]) to absolute."""
    t_start = window * dt + tw * (x - w / 2.0)
    t_end = window * dt + tw * (x + w / 2.0)
    f_low = f_max - (y + h / 2.0) * (f_max - f_min)
    f_high = f_max - (y - h / 2.0) * (f_max - f_min)
    return RawDetection(
        t_start=t_start, t_end=t_end, f_low=f_low, f_high=f_high,
        conf=conf, window=window,
        norm_left=x - w / 2.0, norm_right=x + w / 2.0,
    )
