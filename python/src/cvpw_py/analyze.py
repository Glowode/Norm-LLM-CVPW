"""`cvpw analyze` — audio to a timebase.

Produces, per docs/CONTRACTS.md §4 and §5:

    analysis/audio.json       the time authority
    analysis/envelope.json    metadata for the per-frame feature blob
    analysis/envelope.f32     flat little-endian float32 [frames][channels]
    analysis/overview.png     the plot a human must LOOK at before trusting the grid
    analysis/sections_auto.json   an automated section proposal, for review into sections.json

Two rules shape the whole module:

- **`generatedAt` is null.** A timestamp would make the artifact non-reproducible (docs/SPEC.md A6).
  The *run* is dated in render/report.json, which is never an input to a stage.
- **Every number that a reader might have to trust carries a confidence and a prose `notes` field.**
  An analysis that states its own uncertainty is one an operator can act on.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import wav as wavio
from .features import (
    EPS,
    band_energy,
    median,
    mel_filterbank,
    normalise,
    onset_envelope,
    percentile,
    resample_linear,
    smooth,
    stft_magnitude,
    to_mono,
)
from .tempo import BeatTracking, TempoEstimate, estimate_tempo, find_onsets, onset_strength, track_beats

SCHEMA_AUDIO = "schemas/audio.schema.json"
SCHEMA_ENVELOPE = "schemas/envelope.schema.json"

ANALYSIS_RATE = 24_000
N_FFT = 1024
HOP = 256
# The envelope grid is the video frame grid, so a consumer can index it by frame index with no
# interpolation. `frames` is derived from the project's fps, never hard-coded.
ENVELOPE_CHANNELS = ("rms", "low", "mid", "high", "onset", "beat", "bar", "vocal")

BANDS = {"low": (20.0, 150.0), "mid": (150.0, 2500.0), "high": (2500.0, 12_000.0)}


@dataclass
class AnalysisOptions:
    audio: Path
    out_dir: Path
    fps: int = 30
    bpm_range: tuple[float, float] | None = None
    duration_hint: float | None = None
    sections_override: Path | None = None
    label: str = "cvpw analyze@1"


@dataclass
class AnalysisResult:
    audio_json: Path
    envelope_json: Path
    envelope_bin: Path
    overview_png: Path | None
    sections_auto: Path
    audio: dict = field(default_factory=dict)
    summary: list[str] = field(default_factory=list)


def analyse(options: AnalysisOptions) -> AnalysisResult:
    out_dir = options.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    source = wavio.read(options.audio)
    mono = to_mono(source.samples)
    analysis = resample_linear(mono, source.sample_rate, ANALYSIS_RATE)
    hop_seconds = HOP / ANALYSIS_RATE
    frame_seconds = 1.0 / max(1, options.fps)

    spec = stft_magnitude(analysis, N_FFT, HOP)
    env_raw = onset_envelope(spec)
    env = onset_strength(spec, hop_seconds)

    onset_times, onset_values = find_onsets(env, hop_seconds)
    tempo = estimate_tempo(
        env,
        hop_seconds,
        options.bpm_range,
        onset_times=onset_times,
        onset_values=onset_values,
    )
    tracking = track_beats(env, hop_seconds, tempo, onset_times, onset_strength_values=onset_values)

    duration = options.duration_hint if options.duration_hint else len(mono) / source.sample_rate
    beats = tracking.beats[tracking.beats < duration]

    bars, meter_beats = build_bars(beats, duration, tempo)
    envelope = build_envelope(analysis, spec, env, beats, bars, duration, options.fps)
    sections = build_sections(envelope, bars, duration, tracking, options.sections_override)
    stops = find_stops(envelope, duration)
    impacts = find_impacts(beats, bars, sections, envelope, duration, tracking)
    vocal_activity = find_vocal_activity(envelope, duration)

    audio_doc = build_audio_doc(
        options=options,
        source_rate=source.sample_rate,
        duration=duration,
        fps=options.fps,
        tempo=tempo,
        meter=f"{meter_beats}/4",
        tracking=tracking,
        beats=beats,
        bars=bars,
        sections=sections,
        stops=stops,
        impacts=impacts,
        onsets=build_onsets(beats, bars, onset_times, onset_values, duration),
        vocal_activity=vocal_activity,
    )

    audio_json = out_dir / "audio.json"
    write_json(audio_json, audio_doc)

    envelope_json = out_dir / "envelope.json"
    envelope_bin = out_dir / "envelope.f32"
    write_envelope(envelope_json, envelope_bin, envelope, options.fps, duration)

    sections_auto = out_dir / "sections_auto.json"
    write_json(sections_auto, {"sections": sections})

    overview_png = out_dir / "overview.png"
    drawn = draw_overview(
        overview_png,
        duration=duration,
        envelope=envelope,
        beats=beats,
        downbeats=bars_to_downbeats(bars),
        sections=sections,
        stops=stops,
        impacts=impacts,
    )

    summary = [
        f"duration {duration:.3f} s   source {source.sample_rate} Hz -> analysis {ANALYSIS_RATE} Hz",
        f"tempo {tempo.bpm:.2f} BPM   confidence {tempo.confidence:.2f}   octave {tempo.octave_check}",
        f"beats {len(beats)}   bars {len(bars)}   snapped {tracking.snapped_fraction * 100:.0f}%   "
        f"residual median {tracking.residual_median_ms:.1f} ms / p95 {tracking.residual_p95_ms:.1f} ms",
        f"sections {len(sections)}   stops {len(stops)}   impacts {len(impacts)}",
    ]
    if tempo.octave_check != "ok":
        summary.append(
            f"TEMPO OCTAVE IS AMBIGUOUS ({tempo.octave_check}): look at overview.png and, if the grid is "
            f"wrong, re-run with --bpm-range around {(tempo.bpm / 2):.1f},{tempo.bpm:.1f} or "
            f"{tempo.bpm:.1f},{tempo.bpm * 2:.1f}"
        )
    summary.append(f"LOOK AT {overview_png} before trusting any of the above")

    return AnalysisResult(
        audio_json=audio_json,
        envelope_json=envelope_json,
        envelope_bin=envelope_bin,
        overview_png=overview_png if drawn else None,
        sections_auto=sections_auto,
        audio=audio_doc,
        summary=summary,
    )


# --- bars and sections ----------------------------------------------------------------------------


def build_bars(beats: np.ndarray, duration: float, tempo: TempoEstimate) -> tuple[list[dict], int]:
    """Group beats into bars of four.

    Four is an assumption, stated rather than hidden: `meter` in the output says `4/4` and a project
    whose music is in 3 or 7 must override it. Detecting meter from an onset envelope is unreliable
    enough that guessing would be worse than declaring the default.
    """
    meter_beats = 4
    bars: list[dict] = []
    if len(beats) < 2:
        return bars, meter_beats
    period = float(np.median(np.diff(beats))) if len(beats) > 1 else 60.0 / tempo.bpm
    index = 0
    i = 0
    # A pickup: if the first downbeat is late enough that a whole bar would not fit, call the leading
    # beats a partial bar rather than shifting every bar number in the song.
    lead = beats[0]
    if lead > period * 1.5:
        bars.append(
            {
                "index": -1,
                "start": 0.0,
                "end": float(beats[0]),
                "bpm": round(60.0 / max(period, EPS), 3),
                "pickup": True,
                "beats": int(max(1, round(lead / max(period, EPS)))),
            }
        )
    while i < len(beats):
        start = float(beats[i])
        j = min(i + meter_beats, len(beats))
        end = float(beats[j]) if j < len(beats) else min(duration, start + period * meter_beats)
        if end <= start:
            break
        bars.append(
            {
                "index": index,
                "start": round(start, 6),
                "end": round(end, 6),
                "bpm": round(60.0 / max(period, EPS), 3),
                "pickup": False,
                "beats": j - i,
            }
        )
        index += 1
        i = j
    return bars, meter_beats


def bars_to_downbeats(bars: list[dict]) -> np.ndarray:
    return np.array([b["start"] for b in bars if not b.get("pickup")], dtype=np.float64)


def build_sections(
    envelope: dict,
    bars: list[dict],
    duration: float,
    tracking: BeatTracking,
    override: Path | None,
) -> list[dict]:
    """Sections from bar-level energy novelty, or from a human override when one exists.

    The override is read first and wins outright. Automatic grouping is unreliable on a real master —
    a compressed mix has a nearly flat energy curve — and a labelled section that is wrong is worse
    than one an operator wrote by ear. This is why the framework generates `sections_auto.json` for
    review rather than treating its own output as final.
    """
    if override is not None and override.is_file():
        data = json.loads(override.read_text(encoding="utf-8"))
        rows = data["sections"] if isinstance(data, dict) and "sections" in data else data
        out: list[dict] = []
        for i, row in enumerate(rows):
            if isinstance(row, list):
                # The compact `[firstBar, lastBar, label, group]` form from the prior art is accepted
                # because it is far easier to hand-edit than a nested object.
                first_bar, last_bar, label = row[0], row[1], row[2] if len(row) > 2 else f"section{i}"
                start = bar_start(bars, int(first_bar))
                end = bar_start(bars, int(last_bar) + 1) or duration
                out.append(
                    {"index": i, "name": str(label), "start": start, "end": end, "manual": True}
                )
            else:
                out.append(
                    {
                        "index": i,
                        "name": str(row.get("name", f"section{i}")),
                        "start": float(row.get("start", 0.0)),
                        "end": float(row.get("end", duration)),
                        "energy": float(row.get("energy", 0.0)),
                        "confidence": float(row.get("confidence", 1.0)),
                        "manual": True,
                    }
                )
        return out

    if len(bars) < 4:
        return [{"index": 0, "name": "all", "start": 0.0, "end": round(duration, 6), "energy": 0.0, "confidence": 0.2, "manual": False}]

    # Bar-level energy from the envelope, aligned by time.
    rms = np.array(envelope["rms"], dtype=np.float64)
    fps = int(envelope["fps"])
    bar_energy = np.array(
        [segment_mean(rms, b["start"], b["end"], fps) for b in bars], dtype=np.float64
    )
    novelty = np.abs(np.diff(bar_energy, prepend=bar_energy[0]))
    # Smooth the novelty over two bars so a single loud bar does not create a boundary.
    novelty = smooth(novelty, 3)
    threshold = max(percentile(novelty, 82), novelty.mean() + novelty.std())
    candidates = [i for i in range(1, len(bars)) if novelty[i] >= threshold]

    # Merge boundaries that are closer than eight bars: a section shorter than that is not a section.
    merged: list[int] = []
    for idx in candidates:
        if not merged or idx - merged[-1] >= 8:
            merged.append(idx)
    if not merged or merged[0] != 0:
        merged.insert(0, 0)

    names = default_section_names(len(merged))
    out = []
    for i, first_bar in enumerate(merged):
        last_bar = (merged[i + 1] - 1) if i + 1 < len(merged) else len(bars) - 1
        start = float(bars[first_bar]["start"])
        end = float(bars[last_bar]["end"])
        energy = float(bar_energy[first_bar : last_bar + 1].mean()) if last_bar >= first_bar else 0.0
        out.append(
            {
                "index": i,
                "name": names[i],
                "start": round(start, 6),
                "end": round(min(end, duration), 6),
                "energy": round(energy, 6),
                "confidence": 0.4,
                "manual": False,
            }
        )
    return out


def default_section_names(count: int) -> list[str]:
    if count <= 0:
        return []
    if count == 1:
        return ["all"]
    pool = ["intro", "verse", "pre", "chorus", "break", "bridge", "outro"]
    names = []
    for i in range(count):
        if i == 0:
            names.append("intro")
        elif i == count - 1:
            names.append("outro")
        else:
            names.append(pool[1 + (i - 1) % (len(pool) - 2)])
    return names


def bar_start(bars: list[dict], index: int) -> float:
    for b in bars:
        if b["index"] == index:
            return float(b["start"])
    return 0.0


def segment_mean(values: np.ndarray, start: float, end: float, fps: int) -> float:
    a = max(0, int(round(start * fps)))
    b = min(len(values), int(round(end * fps)))
    if b <= a:
        return 0.0
    return float(values[a:b].mean())


# --- envelope -------------------------------------------------------------------------------------


def build_envelope(
    analysis: np.ndarray,
    spec: np.ndarray,
    env: np.ndarray,
    beats: np.ndarray,
    bars: list[dict],
    duration: float,
    fps: int,
) -> dict:
    """Per-frame features on the video frame grid.

    Resampled to the output frame rate rather than kept at the analysis hop, because every consumer
    indexes it by frame index. Keeping two grids in play is how a feature ends up read one frame late.
    """
    frames = max(1, int(round(duration * fps)))
    hop_seconds = HOP / ANALYSIS_RATE
    env_frames = np.arange(frames, dtype=np.float64) / fps

    def resample_env(values: np.ndarray) -> np.ndarray:
        if len(values) == 0:
            return np.zeros(frames, dtype=np.float64)
        src_t = np.arange(len(values), dtype=np.float64) * hop_seconds
        if len(values) == 1:
            return np.full(frames, float(values[0]))
        return np.interp(env_frames, src_t, values, left=float(values[0]), right=float(values[-1]))

    rms_hop = frame_rms(spec)
    low_hop = band_energy(spec, ANALYSIS_RATE, N_FFT, *BANDS["low"])
    mid_hop = band_energy(spec, ANALYSIS_RATE, N_FFT, *BANDS["mid"])
    high_hop = band_energy(spec, ANALYSIS_RATE, N_FFT, *BANDS["high"])

    rms = normalise(resample_env(rms_hop))
    low = normalise(resample_env(low_hop))
    mid = normalise(resample_env(mid_hop))
    high = normalise(resample_env(high_hop))
    onset = normalise(resample_env(env))

    # Beat and bar phase as fractional positions, so a consumer can ask "how far through the bar am I"
    # without re-deriving the grid. -1 means "no grid here", which is different from 0.
    beat_channel = np.full(frames, -1.0)
    bar_channel = np.full(frames, -1.0)
    if len(beats) >= 2:
        pos = np.interp(env_frames, beats, np.arange(len(beats), dtype=np.float64), left=-1.0, right=-1.0)
        beat_channel = pos
    if bars:
        starts = np.array([b["start"] for b in bars], dtype=np.float64)
        idx = np.clip(np.searchsorted(starts, env_frames, side="right") - 1, 0, len(starts) - 1)
        spans = np.array([max(b["end"] - b["start"], EPS) for b in bars], dtype=np.float64)
        bar_channel = np.where(env_frames >= starts[0], (env_frames - starts[idx]) / spans[idx], -1.0)

    # A cheap vocal proxy: energy in the mid band relative to the full band, which is where a human
    # voice sits in a typical mix. It is a proxy and it is documented as one — a real vocal-activity
    # detector needs source separation, which is phase 2.
    vocal = normalise(np.clip(mid - 0.6 * low, 0.0, None))

    silent = np.where(rms <= 1e-6)[0].tolist()

    return {
        "fps": fps,
        "frames": frames,
        "duration": duration,
        "channels": list(ENVELOPE_CHANNELS),
        "rms": rms,
        "low": low,
        "mid": mid,
        "high": high,
        "onset": onset,
        "beat": beat_channel,
        "bar": bar_channel,
        "vocal": vocal,
        "silentFrames": silent,
    }


def frame_rms(spec: np.ndarray) -> np.ndarray:
    if spec.shape[0] == 0:
        return np.zeros(0, dtype=np.float64)
    return np.sqrt((spec**2).mean(axis=1))


# --- events ---------------------------------------------------------------------------------------


def find_stops(envelope: dict, duration: float, min_seconds: float = 0.25, depth: float = 0.06) -> list[dict]:
    """Silence gaps and stops.

    A `stop` is a hard cut to near-silence a listener hears as an event — the ending of one of these
    songs usually is one, and it is a signature moment, so it is worth naming apart from a mere gap.
    """
    rms = np.array(envelope["rms"], dtype=np.float64)
    fps = int(envelope["fps"])
    if len(rms) == 0:
        return []
    quiet = rms <= depth
    out: list[dict] = []
    start: int | None = None
    for i, is_quiet in enumerate(quiet):
        if is_quiet and start is None:
            start = i
        elif not is_quiet and start is not None:
            push_stop(out, start, i, rms, fps, min_seconds)
            start = None
    if start is not None:
        push_stop(out, start, len(quiet), rms, fps, min_seconds)
    return out


def push_stop(out: list[dict], start: int, end: int, rms: np.ndarray, fps: int, min_seconds: float) -> None:
    if (end - start) / fps < min_seconds:
        return
    level = float(rms[start:end].mean()) if end > start else 0.0
    kind = "stop" if level <= 0.02 else "gap"
    out.append(
        {
            "start": round(start / fps, 6),
            "end": round(end / fps, 6),
            "depthDb": round(20.0 * math.log10(max(level, 1e-6)), 2),
            "kind": kind,
        }
    )


def find_impacts(
    beats: np.ndarray,
    bars: list[dict],
    sections: list[dict],
    envelope: dict,
    duration: float,
    tracking: BeatTracking,
) -> list[dict]:
    """Named structural moments, derived rather than guessed.

    These are what `HIT('hit')` and `HIT('final_cut')` resolve against, so each one needs a defensible
    origin: a section start is a section start, and the final cut is where the energy collapses.
    """
    rms = np.array(envelope["rms"], dtype=np.float64)
    fps = int(envelope["fps"])
    out: list[dict] = []

    if len(beats):
        out.append({"t": round(float(beats[0]), 6), "strength": 1.0, "kind": "first_sound"})

    for section in sections:
        out.append(
            {
                "t": round(float(section["start"]), 6),
                "strength": 0.8,
                "kind": "section_start",
            }
        )

    # The biggest positive energy jump in each section is a `hit`, which is where a chorus lands on a
    # real record and therefore where the film's biggest picture should land too.
    for section in sections:
        a = max(0, int(round(section["start"] * fps)))
        b = min(len(rms), int(round(section["end"] * fps)))
        if b - a < 4:
            continue
        window = rms[a:b]
        jump = np.diff(window)
        if len(jump) == 0:
            continue
        idx = int(np.argmax(jump))
        if jump[idx] <= 0.12:
            continue
        out.append(
            {
                "t": round((a + idx + 1) / fps, 6),
                "strength": float(min(1.0, 0.5 + jump[idx])),
                "kind": "hit",
            }
        )

    # The final cut: the last frame with meaningful energy, which is where the picture must end on an
    # idea rather than fading out of nothing.
    if len(rms):
        loud = np.where(rms >= 0.05)[0]
        if len(loud):
            last = int(loud[-1])
            out.append(
                {
                    "t": round(last / fps, 6),
                    "strength": 0.6,
                    "kind": "final_cut",
                }
            )
            if last < len(rms) - 1:
                out.append(
                    {
                        "t": round((last + 1) / fps, 6),
                        "strength": 0.2,
                        "kind": "end_of_tail",
                    }
                )

    out.sort(key=lambda r: r["t"])
    # Deduplicate, keeping the first at a given time so the strongest kind wins by insertion order.
    seen: set[float] = set()
    unique: list[dict] = []
    for row in out:
        if row["t"] in seen:
            continue
        seen.add(row["t"])
        unique.append(row)
    del beats, bars, duration, tracking  # only kept in the signature for future extensions
    return unique


def build_onsets(
    beats: np.ndarray,
    bars: list[dict],
    onset_times: np.ndarray,
    onset_values: np.ndarray,
    duration: float,
) -> list[dict]:
    """Strong onsets, tagged with which band they came from and where they sit on the grid.

    The `grid` and `beat` tags are the point: they let a later pass answer "is this onset on the beat"
    without re-deriving the grid, and they make an off-grid accent visible as a deliberate syncopation
    rather than a measurement error.
    """
    out: list[dict] = []
    strength_max = float(onset_values.max()) if len(onset_values) else 1.0
    for t, s in zip(onset_times, onset_values):
        if t >= duration:
            continue
        nearest = nearest_index(beats, float(t)) if len(beats) else -1
        delta = abs(float(t) - float(beats[nearest])) if nearest >= 0 else 1.0
        out.append(
            {
                "t": round(float(t), 6),
                "strength": round(float(s) / max(strength_max, EPS), 4),
                "band": "full",
                "grid": round(delta, 6),
                "beat": int(nearest),
            }
        )
    del bars
    return out


def nearest_index(sorted_values: np.ndarray, t: float) -> int:
    if len(sorted_values) == 0:
        return -1
    idx = int(np.searchsorted(sorted_values, t))
    if idx <= 0:
        return 0
    if idx >= len(sorted_values):
        return len(sorted_values) - 1
    before, after = sorted_values[idx - 1], sorted_values[idx]
    return idx - 1 if abs(t - before) <= abs(after - t) else idx


def find_vocal_activity(envelope: dict, duration: float) -> list[dict]:
    """Runs where the mid-band proxy suggests a voice.

    Deliberately coarse and honestly named a proxy in `notes`. Its job is to give `lyrics.alignment`
    something to compare against where a voice certainly exists, and to avoid complaining about lines
    that sit in an instrumental passage.
    """
    vocal = np.array(envelope["vocal"], dtype=np.float64)
    rms = np.array(envelope["rms"], dtype=np.float64)
    fps = int(envelope["fps"])
    if not len(vocal):
        return []
    active = (vocal >= 0.35) & (rms >= 0.08)
    out: list[dict] = []
    start: int | None = None
    for i, is_active in enumerate(active):
        if is_active and start is None:
            start = i
        elif not is_active and start is not None:
            if (i - start) / fps >= 0.25:
                out.append({"start": round(start / fps, 6), "end": round(i / fps, 6)})
            start = None
    if start is not None and (len(active) - start) / fps >= 0.25:
        out.append({"start": round(start / fps, 6), "end": round(min(duration, len(active) / fps), 6)})
    return out


# --- documents ------------------------------------------------------------------------------------


def build_audio_doc(
    *,
    options: AnalysisOptions,
    source_rate: int,
    duration: float,
    fps: int,
    tempo: TempoEstimate,
    meter: str,
    tracking: BeatTracking,
    beats: np.ndarray,
    bars: list[dict],
    sections: list[dict],
    stops: list[dict],
    impacts: list[dict],
    onsets: list[dict],
    vocal_activity: list[dict],
) -> dict:
    frames = max(1, int(round(duration * fps)))
    notes = (
        f"Produced by {options.label}. Onset envelope from a {N_FFT}-point STFT at hop {HOP} "
        f"({HOP / ANALYSIS_RATE * 1000:.0f} ms) over a {ANALYSIS_RATE} Hz mono downmix. {tempo.method}. "
        f"Beats were snapped to measured onsets within 45 ms, preferring the strongest onset in the "
        f"window rather than the nearest; {tracking.snapped_fraction * 100:.0f}% of beats snapped, "
        f"median residual {tracking.residual_median_ms:.1f} ms. "
        f"Meter is assumed {meter}: override it in project.json if the music is not in four. "
        f"'vocalActivity' is a mid-band energy proxy, not source-separated vocal detection. "
        f"Expected accuracy: beat positions to roughly +-20 ms through a stable-tempo passage, and worse "
        f"through a rubato one; tempo may be an octave out despite the check, so LOOK at overview.png. "
        f"`bpm` is a label only - derive cuts from beats[]/bars[], never from a constant period."
    )
    return {
        "$schema": SCHEMA_AUDIO,
        "schemaVersion": 1,
        "source": relative_to(options.out_dir.parent, options.audio),
        "generator": options.label,
        "generatedAt": None,
        "duration": round(duration, 6),
        "sampleRate": int(source_rate),
        "analysisRate": ANALYSIS_RATE,
        "fps": int(fps),
        "frames": frames,
        "tempo": {
            "bpm": round(tempo.bpm, 3),
            "confidence": round(tempo.confidence, 3),
            "method": tempo.method,
            "octaveCheck": tempo.octave_check,
            "beatPeriod": round(60.0 / max(tempo.bpm, EPS), 6),
            "firstBeat": round(float(beats[0]), 6) if len(beats) else 0.0,
            "driftMsPerMin": 0.0,
        },
        "meter": meter,
        "beats": [round(float(b), 6) for b in beats],
        "beatsSmooth": [round(float(b), 6) for b in tracking.beats_smooth if b < duration],
        "bars": bars,
        "sections": sections,
        "onsets": onsets,
        "impacts": impacts,
        "stops": stops,
        "vocalActivity": vocal_activity,
        "notes": notes,
    }


def relative_to(root: Path, target: Path) -> str:
    try:
        return target.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return target.name


def write_envelope(json_path: Path, bin_path: Path, envelope: dict, fps: int, duration: float) -> None:
    """Write the metadata sidecar and the flat float32 blob, with a digest so a mismatch is detectable."""
    import hashlib

    channels = list(envelope["channels"])
    frames = int(envelope["frames"])
    matrix = np.zeros((frames, len(channels)), dtype=np.float32)
    for i, name in enumerate(channels):
        column = np.asarray(envelope[name], dtype=np.float64)
        if len(column) != frames:
            column = np.resize(column, frames) if len(column) else np.zeros(frames)
        matrix[:, i] = column.astype(np.float32)
    blob = matrix.tobytes(order="C")
    bin_path.write_bytes(blob)

    doc = {
        "$schema": SCHEMA_ENVELOPE,
        "schemaVersion": 1,
        "fps": int(fps),
        "frames": frames,
        "duration": round(duration, 6),
        "channels": channels,
        "layout": (
            "little-endian float32, row-major [frames][channels]; frame i is centred at t = i / fps"
        ),
        "normalization": (
            "per channel (x - p01) / (p99 - p01), clipped to [0,1]; no temporal smoothing. "
            "The 'beat' and 'bar' channels are positions, not energies: beat is a fractional beat "
            "index and bar is a fraction through the bar, with -1 meaning no grid at that frame."
        ),
        "silentFrames": [int(i) for i in envelope.get("silentFrames", [])],
        "units": {
            "rms": "normalized 0..1",
            "low": "normalized 0..1",
            "mid": "normalized 0..1",
            "high": "normalized 0..1",
            "onset": "normalized 0..1",
            "beat": "fractional beat index, -1 when no grid",
            "bar": "fraction 0..1 through the bar, -1 when no grid",
            "vocal": "normalized mid-band proxy, not source-separated",
        },
        "features": {name: [lo, hi] for name, (lo, hi) in BANDS.items()},
        "sha256": hashlib.sha256(blob).hexdigest(),
        "notes": (
            "Validate with byteLength == frames * channels.length * 4. A mismatch means the sidecar and "
            "the blob describe different runs; a loader must degrade to zeros with a named warning "
            "rather than throwing, so that a preview survives a missing analysis."
        ),
    }
    write_json(json_path, doc)


def write_json(path: Path, value: object) -> None:
    """UTF-8, LF, 2-space indent, trailing newline. Deterministic byte-for-byte (docs/SPEC.md A6)."""
    text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.replace("\r\n", "\n") + "\n", encoding="utf-8", newline="\n")


# --- the overview plot ----------------------------------------------------------------------------


def draw_overview(
    path: Path,
    *,
    duration: float,
    envelope: dict,
    beats: np.ndarray,
    downbeats: np.ndarray,
    sections: list[dict],
    stops: list[dict],
    impacts: list[dict],
) -> bool:
    """A PNG an operator can read.

    This is not decoration. An octave error in the tempo is invisible in JSON and obvious here, and the
    framework's whole position is that the grid must be looked at before it is trusted. Drawn with
    pure numpy by writing a PNG directly, so the analysis has no plotting dependency.

    Returns False when no PNG could be written; the analysis still succeeds, because an unwritable plot
    is a lost convenience and not a reason to lose an hour of analysis.
    """
    try:
        width, height = 1600, 900
        rms = np.asarray(envelope["rms"], dtype=np.float64)
        fps = int(envelope["fps"])
        low = np.asarray(envelope["low"], dtype=np.float64)
        high = np.asarray(envelope["high"], dtype=np.float64)
        onset = np.asarray(envelope["onset"], dtype=np.float64)
        if len(rms) == 0:
            return False

        canvas = np.zeros((height, width, 3), dtype=np.uint8)
        canvas[:, :, :] = (16, 18, 26)

        def col(t: float) -> int:
            return int(np.clip(t / max(duration, EPS) * (width - 1), 0, width - 1))

        def row(v: float, top: int, bottom: int) -> int:
            return int(np.clip(bottom - v * (bottom - top), top, bottom))

        def fill_column(x: int, top: int, bottom: int, colour: tuple[int, int, int]) -> None:
            if 0 <= x < width and bottom > top:
                canvas[top : bottom + 1, x, :] = colour

        # Three stacked bands: energy, transient, band split.
        band_energy_top, band_energy_bottom = 40, 360
        band_onset_top, band_onset_bottom = 380, 560
        band_split_top, band_split_bottom = 580, 860

        for x in range(width):
            t = x / max(width - 1, 1) * duration
            f = int(np.clip(round(t * fps), 0, len(rms) - 1))
            fill_column(x, row(float(rms[f]), band_energy_top, band_energy_bottom), band_energy_bottom, (70, 140, 220))
            fill_column(
                x,
                row(float(onset[f]), band_onset_top, band_onset_bottom),
                band_onset_bottom,
                (220, 150, 70),
            )
            fill_column(x, row(float(low[f]), band_split_top, band_split_bottom), band_split_bottom, (180, 80, 110))
            fill_column(
                x,
                row(float(high[f]), band_split_top, band_split_bottom),
                band_split_bottom,
                (90, 200, 170),
                )

        # Section boundaries as full-height rules with a label band.
        label_y = 880
        for i, section in enumerate(sections):
            x = col(float(section["start"]))
            canvas[30:870, x, :] = (240, 230, 200)
            name = str(section.get("name", ""))[:14]
            draw_label(canvas, x + 4, label_y, name, (240, 230, 200))
            if i == len(sections) - 1:
                draw_label(canvas, col(float(section["end"])) + 4, label_y, "end", (240, 230, 200))

        # Beats: ticks at the bottom of the energy band. Downbeats taller, so a mis-grouped bar is visible.
        for b in beats:
            x = col(float(b))
            canvas[band_energy_bottom - 12 : band_energy_bottom, x, :] = (120, 120, 140)
        for b in downbeats:
            x = col(float(b))
            canvas[band_energy_bottom - 24 : band_energy_bottom, x, :] = (230, 230, 240)

        for stop in stops:
            a, b = col(float(stop["start"])), col(float(stop["end"]))
            canvas[band_energy_top:band_energy_bottom, a : max(a + 1, b), :] = (200, 60, 60)

        for impact in impacts:
            x = col(float(impact["t"]))
            colour = (255, 120, 40) if impact["kind"] == "hit" else (255, 255, 255)
            canvas[20:34, x, :] = colour

        draw_label(canvas, 8, 24, f"cvpw overview  duration {duration:.2f}s  beats {len(beats)}", (200, 210, 230))
        draw_label(canvas, 8, band_energy_top + 14, "rms", (150, 190, 240))
        draw_label(canvas, 8, band_onset_top + 14, "onset", (240, 190, 140))
        draw_label(canvas, 8, band_split_top + 14, "low / high", (220, 160, 190))

        write_png(path, canvas)
        return True
    except Exception:  # noqa: BLE001 - a failed plot must never lose the analysis
        return False


FONT: dict[str, list[str]] = {}


def glyph_rows(ch: str) -> list[str]:
    """A 5x7 bitmap font, only for the labels this plot needs.

    Hand-rolled because the analysis must not depend on a font renderer: a missing glyph would
    otherwise mean a missing plot, and the plot is the one artifact a human is required to read.
    """
    if not FONT:
        FONT.update(_build_font())
    return FONT.get(ch.upper(), FONT.get("?", ["00000"] * 7))


def _build_font() -> dict[str, list[str]]:
    # fmt: off
    raw = {
        "A": ["01110","10001","10001","11111","10001","10001","10001"],
        "B": ["11110","10001","11110","10001","10001","10001","11110"],
        "C": ["01110","10001","10000","10000","10000","10001","01110"],
        "D": ["11110","10001","10001","10001","10001","10001","11110"],
        "E": ["11111","10000","11110","10000","10000","10000","11111"],
        "F": ["11111","10000","11110","10000","10000","10000","10000"],
        "G": ["01110","10001","10000","10111","10001","10001","01111"],
        "H": ["10001","10001","11111","10001","10001","10001","10001"],
        "I": ["11111","00100","00100","00100","00100","00100","11111"],
        "J": ["00111","00010","00010","00010","10010","10010","01100"],
        "K": ["10001","10010","11100","10100","10010","10010","10001"],
        "L": ["10000","10000","10000","10000","10000","10000","11111"],
        "M": ["10001","11011","10101","10101","10001","10001","10001"],
        "N": ["10001","11001","10101","10011","10001","10001","10001"],
        "O": ["01110","10001","10001","10001","10001","10001","01110"],
        "P": ["11110","10001","10001","11110","10000","10000","10000"],
        "Q": ["01110","10001","10001","10001","10101","10010","01101"],
        "R": ["11110","10001","10001","11110","10100","10010","10001"],
        "S": ["01111","10000","10000","01110","00001","00001","11110"],
        "T": ["11111","00100","00100","00100","00100","00100","00100"],
        "U": ["10001","10001","10001","10001","10001","10001","01110"],
        "V": ["10001","10001","10001","10001","10001","01010","00100"],
        "W": ["10001","10001","10001","10101","10101","11011","10001"],
        "X": ["10001","10001","01010","00100","01010","10001","10001"],
        "Y": ["10001","10001","01010","00100","00100","00100","00100"],
        "Z": ["11111","00001","00010","00100","01000","10000","11111"],
        "0": ["01110","10001","10011","10101","11001","10001","01110"],
        "1": ["00100","01100","00100","00100","00100","00100","01110"],
        "2": ["01110","10001","00001","00010","00100","01000","11111"],
        "3": ["11111","00010","00100","00010","00001","10001","01110"],
        "4": ["00010","00110","01010","10010","11111","00010","00010"],
        "5": ["11111","10000","11110","00001","00001","10001","01110"],
        "6": ["00110","01000","10000","11110","10001","10001","01110"],
        "7": ["11111","00001","00010","00100","01000","01000","01000"],
        "8": ["01110","10001","10001","01110","10001","10001","01110"],
        "9": ["01110","10001","10001","01111","00001","00010","01100"],
        " ": ["00000"] * 7,
        ".": ["00000","00000","00000","00000","00000","01100","01100"],
        ":": ["00000","01100","01100","00000","01100","01100","00000"],
        "-": ["00000","00000","00000","11111","00000","00000","00000"],
        "+": ["00000","00100","00100","11111","00100","00100","00000"],
        "/": ["00001","00010","00010","00100","01000","01000","10000"],
        "%": ["11001","11010","00010","00100","01000","01011","10011"],
        "(": ["00010","00100","01000","01000","01000","00100","00010"],
        ")": ["01000","00100","00010","00010","00010","00100","01000"],
        "[": ["01110","01000","01000","01000","01000","01000","01110"],
        "]": ["01110","00010","00010","00010","00010","00010","01110"],
        "?": ["01110","10001","00001","00010","00100","00000","00100"],
    }
    # fmt: on
    return raw


def draw_label(canvas: np.ndarray, x: int, y: int, text: str, colour: tuple[int, int, int], scale: int = 2) -> None:
    height, width, _ = canvas.shape
    cursor = x
    for ch in text:
        rows = glyph_rows(ch)
        for ry, pattern in enumerate(rows):
            for rx, bit in enumerate(pattern):
                if bit != "1":
                    continue
                px = cursor + rx * scale
                py = y + ry * scale
                if 0 <= px < width - scale and 0 <= py < height - scale:
                    canvas[py : py + scale, px : px + scale, :] = colour
        cursor += 6 * scale


def write_png(path: Path, canvas: np.ndarray) -> None:
    """Write an RGB PNG with zlib from the standard library.

    No image library: the analysis toolchain's dependency list is a feature, and PIL would be a large
    one for a single debug plot.
    """
    import struct
    import zlib

    height, width, _ = canvas.shape
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(canvas[y].tobytes())

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def as_dict(result: AnalysisResult) -> dict:
    return {
        "audioJson": str(result.audio_json),
        "envelopeJson": str(result.envelope_json),
        "envelopeBin": str(result.envelope_bin),
        "overviewPng": str(result.overview_png) if result.overview_png else None,
        "sectionsAuto": str(result.sections_auto),
        "summary": result.summary,
        "tempo": result.audio.get("tempo"),
        "beats": len(result.audio.get("beats", [])),
        "bars": len(result.audio.get("bars", [])),
        "sections": len(result.audio.get("sections", [])),
    }


def unused(*_args: object) -> None:
    """Keeps linters quiet about intentionally-unused parameters in the signature above."""
