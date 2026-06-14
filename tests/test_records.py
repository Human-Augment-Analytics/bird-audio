from __future__ import annotations

from birdpipe import records
from birdpipe.types import Event


def _ev(conf, score):
    e = Event(t_start=1.0, t_end=2.5, f_low=5000, f_high=6000, conf=conf, members=[0, 1])
    e.completeness_score = score
    return e


def test_label_and_retention_complete():
    e = _ev(conf=0.9, score=0.8)
    records.finalize_events([e], theta_a=0.2, theta_b=0.530306)
    assert e.completeness_label == "complete"
    assert e.retained is True


def test_label_incomplete_below_theta_b():
    e = _ev(conf=0.9, score=0.4)
    records.finalize_events([e], theta_a=0.2, theta_b=0.530306)
    assert e.completeness_label == "incomplete"
    assert e.retained is False


def test_not_retained_below_theta_a_even_if_complete():
    e = _ev(conf=0.1, score=0.99)
    records.finalize_events([e], theta_a=0.2, theta_b=0.530306)
    assert e.completeness_label == "complete"
    assert e.retained is False


def test_to_record_fields():
    e = _ev(conf=0.9, score=0.8)
    records.finalize_events([e], theta_a=0.2, theta_b=0.530306)
    r = records.to_record(e)
    assert r["duration"] == 1.5
    assert r["center_freq"] == 5500
    assert r["completeness_label"] == "complete"
    assert r["retained"] is True
    assert r["n_members"] == 2
