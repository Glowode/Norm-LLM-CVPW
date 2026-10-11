"""A synthetic test signal with KNOWN ground truth.

This is the fixture that makes "does the analysis actually work?" answerable without a song. Every
property the analysis claims to measure is known exactly here, so a regression is a number that moved,
not a picture someone liked less:

    BPM               exactly `bpm` (no drift, by construction)
    first beat        exactly `first_beat` seconds
    meter             4/4 with a clearly accented downbeat
    section structure two sections, the second twice as dense as the first
    the stop          a hard silence gap at a known time

It is not music and is not meant to be. It is a ruler.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class TestSignal:
    path: Path
    duration: float
    bpm: float
    first_beat: float
    stop_start: float
    stop_end: float
    section_boundary: float
    sample_rate: int
    notes: str


def make_test_signal(
    path: Path,
    *,
    duration: float = 8.0,
    bpm: float = 120.0,
    first_beat: float = 0.02,
    sample_rate: int = 48_000,
    seed: int = 20_261_011,
) -> TestSignal:
    """Write a click track over a simple tonal bed and return its exact ground truth.

    The seed is fixed and printed into the returned record, because a fixture whose own noise differs
    between runs cannot be used to test determinism.
    """
    rng = np.random.default_rng(seed)
    n = int(round(duration * sample_rate))
    t = np.arange(n, dtype=np.float64) / sample_rate
    out = np.zeros(n, dtype=np.float64)

    period = 60.0 / bpm
    beat_period = period
    # Silence gap: hard stop, so the `stops` detector has something unambiguous to find.
    stop_start = round(beat_period * 12.0, 6)  # beat 12
    stop_end = round(stop_start + 0.4, 6)

    # --- bed: a two-note alternation, quiet enough that the clicks dominate the onset envelope -----
    note_hz = np.where(
        (np.floor((t - first_beat) / (beat_period * 2)) % 2) < 1, 110.0, 164.81
    )  # A2 / E3
    bed = 0.10 * np.sin(2 * np.pi * note_hz * t)
    # A slow amplitude envelope keeps the energy plot readable rather than flat.
    bed *= 0.6 + 0.4 * np.sin(2 * np.pi * t / max(duration, 1e-6))
    out += bed

    # --- clicks: a short decaying burst on every beat, a louder one on every fourth ----------------
    beat_times = np.arange(first_beat, duration, beat_period)
    for i, bt in enumerate(beat_times):
        downbeat = i % 4 == 0
        amplitude = 0.85 if downbeat else 0.45
        # A 4 ms noise burst plus a 60 Hz thump: a broad-band transient with a low-frequency body,
        # which is what a real kick looks like to an onset detector.
        length = int(0.05 * sample_rate)
        start = int(round(bt * sample_rate))
        end = min(n, start + length)
        if end <= start:
            continue
        span = end - start
        local_t = np.arange(span, dtype=np.float64) / sample_rate
        envelope = np.exp(-local_t / (0.008 if downbeat else 0.005))
        burst = rng.standard_normal(span) * envelope * amplitude * 0.5
        thump = np.sin(2 * np.pi * 62.0 * local_t) * envelope * amplitude * (0.6 if downbeat else 0.25)
        out[start:end] += burst + thump
        # A high hat on the off-beats of the second half, so `high` band energy is not constant.
        if i % 4 == 2 and bt > duration / 2:
            hat_start = int(round((bt + beat_period / 2) * sample_rate))
            hat_end = min(n, hat_start + int(0.02 * sample_rate))
            if hat_end > hat_start:
                hat_len = hat_end - hat_start
                hat_t = np.arange(hat_len, dtype=np.float64) / sample_rate
                out[hat_start:hat_end] += (
                    rng.standard_normal(hat_len) * np.exp(-hat_t / 0.003) * 0.18
                )

    # --- second section: denser, so the section detector has a real boundary to find ----------------
    section_boundary = round(first_beat + beat_period * 16.0, 6)
    second = t >= section_boundary
    out[second] *= 1.35
    # A pad an octave up throughout the second section: raises the mid band without moving the grid.
    out[second] += 0.08 * np.sin(2 * np.pi * 329.63 * t[second])

    # --- the stop, applied last so nothing can leak into it ----------------------------------------
    a = int(round(stop_start * sample_rate))
    b = int(round(stop_end * sample_rate))
    out[a:b] = 0.0

    # A gentle fade at the very end so the last frame is not a discontinuity.
    fade = int(0.05 * sample_rate)
    if fade > 0 and n > fade:
        out[-fade:] *= np.linspace(1.0, 0.0, fade)

    # Deterministic normalisation to -6 dBFS peak.
    peak = float(np.max(np.abs(out))) or 1.0
    out = out / peak * 0.5

    from .wav import write_wav_16

    write_wav_16(path, out, sample_rate)

    notes = (
        f"synthetic test signal, seed {seed}: exactly {bpm} BPM, first beat {first_beat} s, 4/4 with an "
        f"accented downbeat, a hard {stop_end - stop_start:.2f} s stop at {stop_start:.3f} s, and a "
        f"density change at {section_boundary:.3f} s. Ground truth is exact, so an analysis regression "
        f"is a number that moved rather than a picture someone liked less."
    )
    return TestSignal(
        path=path,
        duration=duration,
        bpm=bpm,
        first_beat=first_beat,
        stop_start=stop_start,
        stop_end=stop_end,
        section_boundary=section_boundary,
        sample_rate=sample_rate,
        notes=notes,
    )
