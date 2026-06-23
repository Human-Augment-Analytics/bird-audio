"""Plain data carriers shared across the pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Box:
    """A time-frequency rectangle: time in seconds, frequency in Hz."""
    t_start: float
    t_end: float
    f_low: float
    f_high: float


@dataclass
class RawDetection:
    """One Stage-A window-level detection in absolute time/frequency.

    norm_left/norm_right are the box's left/right time edges normalized to
    [0,1] WITHIN its source analysis window (used for edge-proximity).
    """
    t_start: float
    t_end: float
    f_low: float
    f_high: float
    conf: float
    window: int
    norm_left: float
    norm_right: float


@dataclass
class Event:
    """A consolidated event-level track."""
    t_start: float
    t_end: float
    f_low: float
    f_high: float
    conf: float                              # c̃ = max member confidence
    members: List[int] = field(default_factory=list)
    completeness_score: Optional[float] = None
    completeness_label: Optional[str] = None
    retained: Optional[bool] = None

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start

    @property
    def center_freq(self) -> float:
        return 0.5 * (self.f_low + self.f_high)
