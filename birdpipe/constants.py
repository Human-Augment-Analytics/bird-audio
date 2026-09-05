"""Fixed constants from the paper (ecoinf_hlw_buzz_v2_skeleton.pdf).

Audio/windowing: §5.2. Consolidation: Table A.6 + Eq A.1. Stage B: Table A.8.
"""
from __future__ import annotations

from dataclasses import dataclass

# --- Audio / windowing (paper §5.2; matches existing ml_engine streaming) ---
SAMPLE_RATE = 48000
N_FFT = 1024
HOP_LENGTH = 256
BLOCK_FRAMES = 128            # frames per librosa.stream block (one quarter step)
STREAM_READ_BLOCKS = 32       # quarter blocks read per disk pass (throughput only; no effect on results)
WINDOW_FRAMES = 512           # analysis window = 4 blocks
FREQ_BIN_LOW = 88
FREQ_BIN_HIGH = 248           # band = bins [88:248] -> 160 rows
F_MIN_HZ = 4125.0
F_MAX_HZ = 11625.0
STAGE_A_MODEL_CONF = 0.25
STAGE_A_BATCH_SIZE = 32       # windows per localizer forward pass on GPUs (throughput only; no effect on results)
STAGE_A_BATCH_SIZE_CPU = 1    # on CPU a large batch is ~6x slower per window (activations blow the cache)

# Window stride Δt and duration T_w in seconds (matches paper's 0.6827 s / 2.7467 s).
DELTA_T = BLOCK_FRAMES * HOP_LENGTH / SAMPLE_RATE                 # ≈ 0.6827 s
T_W = ((WINDOW_FRAMES - 1) * HOP_LENGTH + N_FFT) / SAMPLE_RATE    # ≈ 2.7467 s
SEC_PER_FRAME = HOP_LENGTH / SAMPLE_RATE                          # ≈ 0.005333 s


@dataclass(frozen=True)
class AffinityWeights:
    """Table A.6 association-score weights (last three are subtracted)."""
    iou2d: float = 0.45
    iou_t: float = 0.14
    iou_f: float = 0.14
    dur_ratio: float = 0.10
    bw_ratio: float = 0.08
    min_conf: float = 0.05
    edge: float = 0.06
    center_t: float = 0.05
    center_f: float = 0.04
    window_gap: float = 0.03


@dataclass(frozen=True)
class AbsorptionWeights:
    """Table A.6 edge-singleton absorption-score weights (last two subtracted)."""
    area: float = 0.55
    time: float = 0.15
    freq: float = 0.15
    edge: float = 0.08
    singleton_conf: float = 0.04
    track_conf: float = 0.03
    center_t: float = 0.04
    center_f: float = 0.03


@dataclass(frozen=True)
class ConsolidationParams:
    """Table A.6 fixed configuration."""
    ingest_conf: float = 0.001
    window_gap_max: int = 3          # G
    eta: float = 0.08                # edge-proximity scale
    affinity: AffinityWeights = AffinityWeights()
    # strong-link gate
    strong_affinity: float = 0.72
    strong_iou2d: float = 0.55
    strong_min_conf: float = 0.25
    strong_margin: float = 0.04
    # support-link gate
    support_affinity: float = 0.62
    support_iou2d: float = 0.35
    support_min_conf: float = 0.10
    support_margin: float = 0.03
    support_gap_max: int = 2
    support_edge_conf: float = 0.70  # candidate edge: max conf >= this OR e_ij >= support_edge
    support_edge: float = 0.50
    # edge-singleton absorption
    absorb_edge: float = 0.80
    absorb_area: float = 0.70
    absorb_time: float = 0.55
    absorb_freq: float = 0.55
    absorb_score: float = 0.72
    absorb_margin: float = 0.08
    absorption: AbsorptionWeights = AbsorptionWeights()
    # contained-singleton suppression (post duplicate merge): a lone window-level box whose
    # time span sits inside an established multi-window track of the same call is a partial
    # view of that track, not a second buzz. Time IoU is too low to merge it (short vs long),
    # and phase-3 absorption skips windows the track already covers, so it needs its own gate.
    contained_time: float = 0.90     # fraction of the singleton's duration inside the track
    contained_freq: float = 0.50     # fraction of the singleton's bandwidth inside the track


@dataclass(frozen=True)
class StageBParams:
    """Table A.8."""
    crop_frames: int = 288
    out_size: int = 288
    theta_b: float = 0.530306
    complete_class: str = "full"     # classifier.pt's name for the "complete" class


@dataclass(frozen=True)
class ExportParams:
    """§5.5. θ_A is validation-derived; the paper gives no number -> configurable."""
    theta_a: float = 0.0


def is_yolo_model(model) -> bool:
    """Determine if a model is a YOLO instance (or MagicMock test wrapper)."""
    if model is None:
        return False
    module_name = getattr(type(model), "__module__", "") or ""
    class_name = type(model).__name__
    return (
        "ultralytics" in module_name or 
        class_name in ("YOLO", "MagicMock")
    )
