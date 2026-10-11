"""Numeric helpers for the analysis pass.

Nothing in this module reads a clock, a random source or an environment variable: given the same
input samples it must produce the same numbers on every machine, because everything downstream
inherits its determinism from here (docs/SPEC.md D1).
"""

from __future__ import annotations

import numpy as np

EPS = 1e-12


def to_mono(samples: np.ndarray) -> np.ndarray:
    """Downmix to mono. Averaged rather than summed, so the level does not depend on the channel count."""
    if samples.ndim == 1:
        return samples.astype(np.float64, copy=False)
    return samples.mean(axis=1).astype(np.float64, copy=False)


def resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Linear resampling.

    Linear rather than polyphase on purpose: the analysis consumes onset *envelopes* and broad band
    energies, not waveforms for playback, so the extra stopband rejection of a windowed sinc would buy
    nothing and cost a dependency. The one thing it must not do is shift the signal in time, and it
    does not.
    """
    if src_rate == dst_rate:
        return samples
    n_out = int(round(len(samples) * dst_rate / src_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float64)
    x_src = np.arange(len(samples), dtype=np.float64)
    x_dst = np.linspace(0.0, len(samples) - 1, n_out, dtype=np.float64)
    return np.interp(x_dst, x_src, samples)


def frame_signal(samples: np.ndarray, frame_length: int, hop_length: int) -> np.ndarray:
    """Split into overlapping frames, zero-padding the tail so the last partial frame is kept."""
    if frame_length <= 0 or hop_length <= 0:
        raise ValueError("frame_length and hop_length must be positive")
    if len(samples) == 0:
        return np.zeros((0, frame_length), dtype=np.float64)
    n_frames = 1 + int(np.ceil(max(0, len(samples) - frame_length) / hop_length))
    padded = np.concatenate([samples, np.zeros(frame_length, dtype=np.float64)])
    idx = np.arange(frame_length)[None, :] + hop_length * np.arange(n_frames)[:, None]
    return padded[idx]


def stft_magnitude(samples: np.ndarray, n_fft: int, hop_length: int) -> np.ndarray:
    """Magnitude spectrogram as [frames][bins]."""
    frames = frame_signal(samples, n_fft, hop_length)
    if frames.shape[0] == 0:
        return np.zeros((0, n_fft // 2 + 1), dtype=np.float64)
    window = np.hanning(n_fft)
    return np.abs(np.fft.rfft(frames * window, axis=1))


def mel_filterbank(n_fft: int, sample_rate: int, n_bands: int, f_min: float = 30.0, f_max: float | None = None) -> np.ndarray:
    """A triangular mel filterbank as [bands][bins].

    Written out rather than imported so the frame grid and the filter shapes are identical everywhere:
    a spectrogram that differs by one bin between two machines would make two analysers disagree about
    where a beat is, and the whole framework treats the grid as authoritative.
    """
    f_max = f_max if f_max is not None else sample_rate / 2
    n_bins = n_fft // 2 + 1
    freqs = np.linspace(0, sample_rate / 2, n_bins)

    def hz_to_mel(f: float) -> float:
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m: float) -> float:
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    mel_points = np.linspace(hz_to_mel(f_min), hz_to_mel(f_max), n_bands + 2)
    hz_points = mel_to_hz(mel_points)
    bank = np.zeros((n_bands, n_bins), dtype=np.float64)
    for b in range(n_bands):
        left, centre, right = hz_points[b], hz_points[b + 1], hz_points[b + 2]
        if right <= left:
            continue
        rising = (freqs - left) / max(centre - left, EPS)
        falling = (right - freqs) / max(right - centre, EPS)
        bank[b] = np.clip(np.minimum(rising, falling), 0.0, None)
    # Normalise each band so a band's energy does not depend on its width in bins.
    sums = bank.sum(axis=1, keepdims=True)
    return bank / np.maximum(sums, EPS)


def band_energy(spectrogram: np.ndarray, sample_rate: int, n_fft: int, lo: float, hi: float) -> np.ndarray:
    """Sum of magnitude in a frequency band, per frame."""
    if spectrogram.shape[0] == 0:
        return np.zeros(0, dtype=np.float64)
    freqs = np.linspace(0, sample_rate / 2, spectrogram.shape[1])
    mask = (freqs >= lo) & (freqs < hi)
    if not mask.any():
        return np.zeros(spectrogram.shape[0], dtype=np.float64)
    return spectrogram[:, mask].sum(axis=1)


def onset_envelope(spectrogram: np.ndarray) -> np.ndarray:
    """Spectral flux, half-wave rectified.

    This is the signal the tempo search and the beat tracker both consume, so a change here moves every
    beat in the film. It is deliberately the simplest thing that works: log-compressed magnitude, then
    positive first differences.
    """
    if spectrogram.shape[0] < 2:
        return np.zeros(max(0, spectrogram.shape[0]), dtype=np.float64)
    log_mag = np.log1p(spectrogram * 100.0)
    diff = np.diff(log_mag, axis=0)
    flux = np.maximum(diff, 0.0).sum(axis=1)
    return np.concatenate([[0.0], flux])


def smooth(values: np.ndarray, window: int) -> np.ndarray:
    """Moving average with edge clamping. A convolution, so it cannot wrap energy from the end to the start."""
    if window <= 1 or len(values) == 0:
        return values
    window = int(window)
    pad = window // 2
    padded = np.pad(values, (pad, pad), mode="edge")
    kernel = np.ones(window, dtype=np.float64) / window
    return np.convolve(padded, kernel, mode="valid")[: len(values)]


def normalise(values: np.ndarray, p_lo: float = 1.0, p_hi: float = 99.0) -> np.ndarray:
    """Percentile normalisation, clipped to 0..1.

    Percentiles rather than min/max: one loud transient at 20x the median would otherwise flatten the
    whole envelope, which is the difference between a usable feature and a useless one.
    """
    if len(values) == 0:
        return values
    lo = float(np.percentile(values, p_lo))
    hi = float(np.percentile(values, p_hi))
    if hi - lo < EPS:
        return np.zeros_like(values)
    return np.clip((values - lo) / (hi - lo), 0.0, 1.0)


def percentile(values: np.ndarray, p: float) -> float:
    if len(values) == 0:
        return 0.0
    return float(np.percentile(values, p))


def median(values: np.ndarray) -> float:
    if len(values) == 0:
        return 0.0
    return float(np.median(values))


def peaks(values: np.ndarray, threshold: float, min_gap_frames: int) -> np.ndarray:
    """Indices of local maxima above `threshold`, at least `min_gap_frames` apart.

    Two decisions here, both forced by a measured failure on the framework's own fixture:

    - **Greedy from the strongest peak**, not left to right. A slightly larger peak two frames later
      wins the position instead of the first one over the line. On a percussive transient the true
      attack is the strongest frame; taking the first crossing lands a frame early, which reads later
      as "the cut is a hair ahead of the beat".
    - **A boundary frame counts as a peak.** Requiring `v[i] > v[i+1]` for the *first* frame of a file
      rejects it whenever the envelope is still rising, and a 1024-sample analysis window cannot
      resolve an attack in the first ~40 ms of audio at all. On the fixture this discarded the opening
      click at 10.7 ms and with it every downbeat, so the detector reported a grid starting at 0.49 s
      and the phase was 470 ms wrong — a silent, systematic error at the start of every file.

    Suppression is by strength within a window rather than by a strict local-maximum test, so a
    plateau or a rising boundary is handled the same way as an interior peak.
    """
    if len(values) < 1:
        return np.zeros(0, dtype=int)
    above = np.where(values >= threshold)[0]
    if len(above) == 0:
        return np.zeros(0, dtype=int)
    candidates = above
    # Strongest first; ties broken by earlier time so the result stays deterministic.
    order = sorted(candidates.tolist(), key=lambda i: (-float(values[i]), int(i)))
    taken: list[int] = []
    for idx in order:
        if all(abs(idx - t) >= max(1, min_gap_frames) for t in taken):
            taken.append(int(idx))
    return np.array(sorted(taken), dtype=int)
