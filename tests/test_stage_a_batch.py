import torch

from birdpipe import constants as C
from scripts.ml_engine import BirdAudioPipeline


def _pipeline(device):
    p = BirdAudioPipeline(localizer_path=None, classifier_path=None, device="cpu")
    p.device = torch.device(device)
    return p


def test_cpu_uses_small_batch():
    assert _pipeline("cpu")._stage_a_batch_size() == C.STAGE_A_BATCH_SIZE_CPU == 1


def test_gpu_uses_large_batch():
    assert _pipeline("mps")._stage_a_batch_size() == C.STAGE_A_BATCH_SIZE
    assert _pipeline("cuda")._stage_a_batch_size() == C.STAGE_A_BATCH_SIZE


def test_explicit_override_wins():
    p = _pipeline("cpu")
    p.stage_a_batch = 8
    assert p._stage_a_batch_size() == 8
    p.stage_a_batch = 0
    assert p._stage_a_batch_size() == 1
