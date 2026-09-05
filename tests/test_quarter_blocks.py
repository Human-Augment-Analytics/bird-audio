import librosa
import numpy as np
import pytest
import soundfile as sf

from birdpipe import constants as C
from scripts.ml_engine import iter_quarter_blocks


def _reference(path):
    return list(librosa.stream(
        path, block_length=C.BLOCK_FRAMES, frame_length=C.N_FFT,
        hop_length=C.HOP_LENGTH, fill_value=0,
    ))


BLOCK = C.BLOCK_FRAMES * C.HOP_LENGTH          # 32768 samples per quarter block
SPAN = BLOCK + C.N_FFT - C.HOP_LENGTH          # 33536 samples per yielded block
READ = C.STREAM_READ_BLOCKS * BLOCK            # samples per multi-block read


@pytest.mark.parametrize("n_samples", [
    500, 1024, 1025, SPAN, SPAN + 1, 100_000,
    READ - 1, READ, READ + 1, READ + SPAN, 3 * READ + 12_345,
])
def test_matches_single_block_stream(tmp_path, n_samples):
    path = tmp_path / "x.wav"
    rng = np.random.default_rng(n_samples)
    sf.write(path, (rng.standard_normal(n_samples) * 0.1).astype(np.float32), C.SAMPLE_RATE)

    ref = _reference(str(path))
    got = list(iter_quarter_blocks(str(path)))

    assert len(got) == len(ref)
    for a, b in zip(ref, got):
        assert a.shape == b.shape == (SPAN,)
        assert a.dtype == b.dtype
        assert np.array_equal(a, b)


def test_stft_identical_to_reference(tmp_path):
    path = tmp_path / "x.wav"
    rng = np.random.default_rng(0)
    sf.write(path, (rng.standard_normal(READ + 4321) * 0.1).astype(np.float32), C.SAMPLE_RATE)
    kw = dict(n_fft=C.N_FFT, hop_length=C.HOP_LENGTH, center=False)
    for a, b in zip(_reference(str(path)), iter_quarter_blocks(str(path))):
        assert np.array_equal(np.abs(librosa.stft(a, **kw)), np.abs(librosa.stft(b, **kw)))
