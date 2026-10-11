"""Audio file reading, with the two failure modes that actually happen on a real machine handled.

1. **A compressed source.** `soundfile` handles mp3/m4a/flac/ogg when libsndfile supports them and
   raises when it does not. The fallback is `ffmpeg`, which is already a REQUIRED dependency, rather
   than an error telling the operator to convert by hand — but the choice is *reported*, because a
   silent decode path change is the kind of thing that later looks like an analysis bug.
2. **A lossless source that would be needlessly re-encoded.** A 24-bit WAV is read directly. Nothing
   in this framework ever rewrites the source: `docs/SPEC.md` P6 forbids achieving an offset by editing
   the audio, and the same reasoning applies to touching it at all.

`soundfile` is imported lazily so that a machine with only the stdlib and ffmpeg can still read a WAV.
"""

from __future__ import annotations

import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class AudioSource:
    samples: np.ndarray
    sample_rate: int
    channels: int
    frames: int
    path: Path
    #: How the samples were obtained, recorded in the analysis provenance.
    decoder: str
    subtype: str = "unknown"

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


def read(path: Path) -> AudioSource:
    """Read an audio file to float64 samples in -1..1, shape [frames] or [frames][channels]."""
    if not path.is_file():
        raise SystemExit(f"cvpw: no such audio file: {path}")

    try:  # pragma: no cover - depends on the machine's libsndfile
        import soundfile as sf  # type: ignore

        data, rate = sf.read(str(path), dtype="float64", always_2d=True)
        subtype = "unknown"
        try:
            info = sf.info(str(path))
            subtype = getattr(info, "subtype", "unknown")
        except Exception:  # noqa: BLE001
            pass
        return AudioSource(
            samples=data,
            sample_rate=int(rate),
            channels=int(data.shape[1]),
            frames=int(data.shape[0]),
            path=path,
            decoder="soundfile",
            subtype=str(subtype),
        )
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001 - libsndfile refusing the container is expected for mp4
        fallback = _via_ffmpeg(path)
        if fallback is not None:
            return fallback
        raise SystemExit(
            f"cvpw: soundfile could not read {path} ({exc}), and the ffmpeg fallback also failed.\n"
            f"       Convert to a WAV once, by hand, and point project.json at that file:\n"
            f"       ffmpeg -i {path} -c:a pcm_s24le {path.with_suffix('.wav')}"
        ) from exc

    # No soundfile at all: try ffmpeg, then a stdlib WAV reader.
    fallback = _via_ffmpeg(path)
    if fallback is not None:
        return fallback
    wav = _via_stdlib(path)
    if wav is not None:
        return wav
    raise SystemExit(
        f"cvpw: cannot read {path}. Install soundfile (`pip install soundfile`) or ensure ffmpeg is on PATH."
    )


def _via_ffmpeg(path: Path) -> AudioSource | None:
    """Decode with ffmpeg to f32le on stdout: no temp file, no re-encode of a lossless source."""
    exe = _ffmpeg()
    if exe is None:
        return None
    probe = subprocess.run(
        [
            _ffprobe() or "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if probe.returncode != 0 or not probe.stdout.strip():
        return None
    parts = probe.stdout.strip().split(",")
    try:
        rate = int(float(parts[0]))
        channels = int(float(parts[1]))
    except (IndexError, ValueError):
        return None

    decode = subprocess.run(
        [
            exe,
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "-",
        ],
        capture_output=True,
    )
    if decode.returncode != 0 or not decode.stdout:
        return None
    flat = np.frombuffer(decode.stdout, dtype="<f4").astype(np.float64)
    usable = (len(flat) // channels) * channels
    data = flat[:usable].reshape(-1, channels)
    return AudioSource(
        samples=data,
        sample_rate=rate,
        channels=channels,
        frames=int(data.shape[0]),
        path=path,
        decoder="ffmpeg",
        subtype="pcm_f32le",
    )


def _via_stdlib(path: Path) -> AudioSource | None:
    """Last resort: the standard library's own WAV reader. Handles PCM WAV only, and says so."""
    if path.suffix.lower() not in {".wav", ".wave"}:
        return None
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            rate = handle.getframerate()
            width = handle.getsampwidth()
            frames = handle.getnframes()
            raw = handle.readframes(frames)
    except Exception:  # noqa: BLE001
        return None
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype="<u1").astype(np.float64) - 128.0) / 128.0
    else:
        return None
    usable = (len(data) // channels) * channels
    shaped = data[:usable].reshape(-1, channels)
    return AudioSource(
        samples=shaped,
        sample_rate=int(rate),
        channels=int(channels),
        frames=int(shaped.shape[0]),
        path=path,
        decoder="stdlib-wave",
        subtype=f"pcm_s{width * 8}le",
    )


def _ffmpeg() -> str | None:
    import os
    import shutil

    override = os.environ.get("CVPW_FFMPEG")
    if override:
        return override
    return shutil.which("ffmpeg")


def _ffprobe() -> str | None:
    import os
    import shutil

    override = os.environ.get("CVPW_FFPROBE")
    if override:
        return override
    return shutil.which("ffprobe")


def write_wav_16(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write 16-bit PCM WAV via the standard library.

    Used only by the self-test signal, which is generated rather than delivered. Writing it here rather
    than with soundfile keeps the self-test runnable on a machine that has numpy and nothing else —
    `cvpw doctor` is supposed to be able to prove the toolchain works before anything is installed.
    """
    clipped = np.clip(samples, -1.0, 1.0)
    if clipped.ndim == 1:
        channel_count = 1
        pcm = (clipped * 32767.0).astype("<i2")
    else:
        channel_count = clipped.shape[1]
        # `reshape(-1)` is what makes the interleaving correct for any channel count; writing the 2-D
        # array's bytes directly would produce [all of ch0][all of ch1], which plays back as noise.
        pcm = (clipped * 32767.0).astype("<i2").reshape(-1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channel_count)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
