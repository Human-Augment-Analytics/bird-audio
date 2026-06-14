from __future__ import annotations

import math

from birdpipe import evaluate
from tests.conftest import make_box


def _pred(t0, t1, f0, f1, conf=0.9):
    b = make_box(t0, t1, f0, f1)
    b.conf = conf  # evaluate scoring reads .conf on predictions
    return b


def test_match_one_to_one_tp():
    preds = [_pred(1.0, 2.0, 5000, 6000)]
    refs = [make_box(1.0, 2.0, 5000, 6000)]
    pairs, fp, fn = evaluate.match(preds, refs)
    assert pairs == [(0, 0)]
    assert fp == [] and fn == []


def test_match_no_candidate_is_fp_and_fn():
    preds = [_pred(0.0, 0.5, 5000, 6000)]
    refs = [make_box(10.0, 11.0, 5000, 6000)]   # far in time -> not a candidate
    pairs, fp, fn = evaluate.match(preds, refs)
    assert pairs == []
    assert fp == [0] and fn == [0]


def test_prf_perfect():
    p, r, f = evaluate.prf(tp=5, fp=0, fn=0)
    assert p == 1.0 and r == 1.0 and f == 1.0


def test_prf_mixed():
    p, r, f = evaluate.prf(tp=8, fp=2, fn=2)
    assert math.isclose(p, 0.8) and math.isclose(r, 0.8) and math.isclose(f, 0.8)
