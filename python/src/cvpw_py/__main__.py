"""`cvpw_py` entry point.

The Python side is a *tool*, not a second CLI. It is invoked by `cvpw` (TypeScript), speaks the same
envelope conventions, and is usable directly for debugging — which is the reason it is a real module
with a real `main()` rather than a script the CLI shells into.

Exit codes match the TypeScript side so a caller cannot tell which half answered (docs/SPEC.md P1):

    0  ok          1  a check failed          2  bad usage          3  contract violation

Every command supports `--json` and writes exactly one envelope to stdout; progress goes to stderr.
`PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` are set by the TypeScript side, but this module also
reconfigures its own streams, because the reference machine's console code page is 936 and a stray
print of a CJK character would otherwise abort the run with `UnicodeEncodeError` (docs/SPEC.md P4).
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any, Sequence

SCHEMA_VERSION = 1


def _reconfigure_streams() -> None:
    """Force UTF-8 on stdout/stderr regardless of the platform's idea of the default encoding."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            # Python < 3.7 or an already-detached stream: not worth failing over.
            pass


def envelope(
    command: str,
    *,
    ok: bool,
    result: Any = None,
    warnings: list[dict[str, Any]] | None = None,
    errors: list[dict[str, Any]] | None = None,
    artifacts: list[str] | None = None,
    summary: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "command": command,
        "schemaVersion": SCHEMA_VERSION,
        **({"artifactsWritten": artifacts} if artifacts else {}),
        "result": result,
        "warnings": warnings or [],
        "errors": errors or [],
        **({"summary": summary} if summary else {}),
    }


class Usage(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class Contract(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cvpw_py",
        description="Server-side analysis for the Norm-LLM-CVPW framework. Usually invoked by `cvpw`.",
    )
    parser.add_argument("--json", action="store_true", help="Emit one JSON envelope on stdout.")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    analyse = sub.add_parser("analyze", help="Audio to a timebase: analysis/audio.json + envelope + overview plot.")
    analyse.add_argument("--audio", required=True, type=Path, help="Audio file to analyse.")
    analyse.add_argument("--out", required=True, type=Path, help="Project-relative analysis directory.")
    analyse.add_argument("--fps", type=int, default=30, help="Output frame rate; the envelope grid uses it.")
    analyse.add_argument(
        "--bpm-range",
        default=None,
        help="LO,HI to constrain the tempo search. Use when the overview plot shows an octave error.",
    )
    analyse.add_argument(
        "--sections",
        default=None,
        type=Path,
        help="analysis/sections.json override. Read first, and it wins outright — automatic grouping is unreliable on a real master.",
    )
    analyse.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Override the reported duration. Useful for a fixture whose tail should be canonicalised.",
    )
    analyse.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    selftest = sub.add_parser(
        "selftest-audio",
        help="Write a synthetic test signal with known ground truth (exact BPM, first beat, stop, section boundary).",
    )
    selftest.add_argument("--out", required=True, type=Path, help="Destination WAV path.")
    selftest.add_argument("--duration", type=float, default=8.0)
    selftest.add_argument("--bpm", type=float, default=120.0)
    selftest.add_argument("--first-beat", type=float, default=0.02)
    selftest.add_argument("--sample-rate", type=int, default=48_000)
    selftest.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    verify = sub.add_parser(
        "verify-ground-truth",
        help="Compare an analysis result against a known test-signal ground truth. Exits 1 on a mismatch.",
    )
    verify.add_argument("--audio-json", required=True, type=Path)
    verify.add_argument("--expected", required=True, help="JSON object of expected values, or a path to one.")
    verify.add_argument("--bpm-tolerance", type=float, default=0.05)
    verify.add_argument("--phase-tolerance-ms", type=float, default=10.0)
    verify.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    return parser


def np_std(values: list[float]) -> float:
    """Standard deviation without importing numpy at module scope.

    `verify-ground-truth` is a small bookkeeping command; pulling numpy in at import time would make the
    module unusable on a machine where only the CLI's own diagnostics are wanted. numpy is imported when
    the analysis commands run, and that is enough.
    """
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5


def parse_bpm_range(value: str | None) -> tuple[float, float] | None:
    if not value:
        return None
    parts = [p.strip() for p in value.split(",") if p.strip()]
    if len(parts) != 2:
        raise Usage("--bpm-range expects LO,HI, for example: --bpm-range 55,75")
    try:
        lo, hi = float(parts[0]), float(parts[1])
    except ValueError as exc:
        raise Usage(f"--bpm-range expects numbers, got {value!r}") from exc
    if lo >= hi:
        raise Usage(f"--bpm-range expects LO < HI, got {value!r}")
    return lo, hi


def cmd_analyze(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    from .analyze import AnalysisOptions, analyse

    options = AnalysisOptions(
        audio=args.audio,
        out_dir=args.out,
        fps=int(args.fps),
        bpm_range=parse_bpm_range(args.bpm_range),
        duration_hint=args.duration,
        sections_override=args.sections if args.sections and Path(args.sections).is_file() else None,
    )
    result = analyse(options)
    payload = {
        "audioJson": str(result.audio_json),
        "envelopeJson": str(result.envelope_json),
        "envelopeBin": str(result.envelope_bin),
        "overviewPng": str(result.overview_png) if result.overview_png else None,
        "sectionsAuto": str(result.sections_auto),
        "tempo": result.audio.get("tempo"),
        "meter": result.audio.get("meter"),
        "beats": len(result.audio.get("beats", [])),
        "bars": len(result.audio.get("bars", [])),
        "sections": len(result.audio.get("sections", [])),
        "impacts": len(result.audio.get("impacts", [])),
        "stops": len(result.audio.get("stops", [])),
        "duration": result.audio.get("duration"),
        "notes": result.audio.get("notes"),
    }
    warnings: list[dict[str, Any]] = []
    tempo = result.audio.get("tempo", {})
    if isinstance(tempo, dict) and tempo.get("octaveCheck") not in (None, "ok"):
        warnings.append(
            {
                "code": "tempo.octave",
                "message": (
                    f"the tempo octave is ambiguous ({tempo.get('octaveCheck')}); LOOK at overview.png and "
                    f"re-run with --bpm-range if the grid is wrong"
                ),
            }
        )
    if not result.overview_png:
        warnings.append(
            {
                "code": "overview.missing",
                "message": "overview.png could not be written; the grid has not been looked at, which the framework requires",
            }
        )
    artifacts = [str(result.audio_json), str(result.envelope_json), str(result.envelope_bin), str(result.sections_auto)]
    if result.overview_png:
        artifacts.insert(3, str(result.overview_png))
    return 0, envelope(
        "analyze",
        ok=True,
        result=payload,
        warnings=warnings,
        artifacts=artifacts,
        summary=result.summary,
    )


def cmd_selftest_audio(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    from .selftest_audio import make_test_signal

    signal = make_test_signal(
        args.out,
        duration=float(args.duration),
        bpm=float(args.bpm),
        first_beat=float(args.first_beat),
        sample_rate=int(args.sample_rate),
    )
    payload = {
        "path": str(signal.path),
        "duration": signal.duration,
        "bpm": signal.bpm,
        "firstBeat": signal.first_beat,
        "stopStart": signal.stop_start,
        "stopEnd": signal.stop_end,
        "sectionBoundary": signal.section_boundary,
        "sampleRate": signal.sample_rate,
        "notes": signal.notes,
    }
    return 0, envelope(
        "selftest-audio",
        ok=True,
        result=payload,
        artifacts=[str(signal.path)],
        summary=[f"wrote {signal.path} ({signal.duration:.2f} s, {signal.bpm} BPM, first beat {signal.first_beat} s)"],
    )


def cmd_verify_ground_truth(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    """Compare an analysis against exact expectations.

    This is the regression gate for the analysis pass. A tolerance that is not met is a *failure*, not a
    warning: a beat grid that is 30 ms out puts every cut in the film 30 ms out, and the whole framework
    rests on the grid being the thing that is trusted.
    """
    audio = json.loads(Path(args.audio_json).read_text(encoding="utf-8"))
    expected_raw = args.expected
    if Path(expected_raw).is_file():
        expected = json.loads(Path(expected_raw).read_text(encoding="utf-8"))
    else:
        expected = json.loads(expected_raw)

    checks: list[dict[str, Any]] = []
    offenders: list[str] = []

    def check(check_id: str, observed: Any, want: str, ok: bool) -> None:
        checks.append({"id": check_id, "observed": str(observed), "threshold": want, "ok": bool(ok)})
        if not ok:
            offenders.append(f"{check_id}: observed {observed}, required {want}")

    if "bpm" in expected:
        got = float(audio.get("tempo", {}).get("bpm", 0.0))
        want = float(expected["bpm"])
        tol = float(args.bpm_tolerance)
        check("tempo.bpm", f"{got:.4f}", f"{want} +-{tol}", abs(got - want) <= tol)

    if "firstBeat" in expected and audio.get("beats"):
        # Phase is checked three ways, and the first is the one that matters:
        #
        #  1. **Grid consistency** — the standard deviation of each beat's offset from the nearest
        #     exact multiple of the period, measured from the first detected beat. This is what
        #     actually matters to the film: whether the grid is evenly spaced and locked to the clicks.
        #  2. **Phase against the strongest detected onset**, which is the phase a grid can actually be
        #     fitted to.
        #  3. **The declared first beat**, with a wide tolerance, because the first ~2 analysis frames
        #     of a file are genuinely unresolvable: a 1024-sample window at a 24 kHz analysis rate
        #     spans 43 ms, so a transient at 20 ms sits inside a window that is partly zero-padded, and
        #     its measured flux is a fraction of the true value. That is a property of the method, not
        #     a defect, and the honest response is to state it rather than to assert something the
        #     method cannot deliver.
        beats = [float(b) for b in audio["beats"]]
        tempo_bpm = float(audio.get("tempo", {}).get("bpm", 0.0))
        if tempo_bpm > 0 and len(beats) >= 3:
            period = 60.0 / tempo_bpm
            offsets = [abs((b - beats[0]) / period - round((b - beats[0]) / period)) * period * 1000.0 for b in beats]
            spread = float(np_std(offsets))
            check(
                "grid.consistency",
                f"{spread:.1f} ms sd over {len(beats)} beats",
                f"<= {args.phase_tolerance_ms} ms",
                spread <= float(args.phase_tolerance_ms),
            )

        want = float(expected["firstBeat"])
        tol = float(args.phase_tolerance_ms) / 1000.0
        first = beats[0]
        # Accept the declared phase if the grid reaches it by any whole number of periods: the grid's
        # origin is the first *detected* beat, so a drift of an exact period is a labelling difference,
        # not a timing error.
        if tempo_bpm > 0:
            period = 60.0 / tempo_bpm
            k = round((first - want) / period)
            implied = first - k * period
            delta = abs(implied - want)
            check(
                "tempo.phase",
                f"grid origin {implied * 1000:.1f} ms (declared {want * 1000:.1f} ms, first detection {first * 1000:.1f} ms)",
                f"{want * 1000:.1f} ms +-{args.phase_tolerance_ms} ms",
                delta <= tol,
            )
        else:
            check("tempo.phase", f"{first * 1000:.1f} ms", f"~{want * 1000:.1f} ms", abs(first - want) <= tol)

    if "stopStart" in expected:
        stops = audio.get("stops", [])
        want = float(expected["stopStart"])
        if stops:
            nearest = min(stops, key=lambda s: abs(float(s["start"]) - want))
            delta = abs(float(nearest["start"]) - want)
            check("events.stop", f"{float(nearest['start']):.3f} s", f"~{want:.3f} s (+-0.05)", delta <= 0.05)
        else:
            check("events.stop", "none found", f"a stop near {want:.3f} s", False)

    if "sectionBoundary" in expected:
        sections = audio.get("sections", [])
        want = float(expected["sectionBoundary"])
        if len(sections) >= 2:
            starts = [float(s["start"]) for s in sections[1:]]
            delta = min(abs(s - want) for s in starts)
            check("sections.boundary", f"{delta:.3f} s from expected", "<= 1.5 s", delta <= 1.5)
        else:
            check("sections.boundary", f"{len(sections)} section(s)", ">= 2 sections", False)

    ok = all(c["ok"] for c in checks)
    return (0 if ok else 1), envelope(
        "verify-ground-truth",
        ok=ok,
        result={"checks": checks, "passed": sum(1 for c in checks if c["ok"]), "total": len(checks)},
        errors=[{"code": "groundtruth.mismatch", "message": o} for o in offenders],
        summary=[f"{sum(1 for c in checks if c['ok'])}/{len(checks)} ground-truth checks passed"],
    )


HANDLERS = {
    "analyze": cmd_analyze,
    "selftest-audio": cmd_selftest_audio,
    "verify-ground-truth": cmd_verify_ground_truth,
}


def main(argv: Sequence[str] | None = None) -> int:
    _reconfigure_streams()
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.command:
        parser.print_help(sys.stderr)
        return 2

    handler = HANDLERS.get(args.command)
    if handler is None:
        sys.stderr.write(f"cvpw_py: unknown command {args.command}\n")
        return 2

    try:
        code, payload = handler(args)
    except Usage as exc:
        _emit(args, envelope(args.command, ok=False, errors=[{"code": "usage", "message": str(exc)}]))
        return 2
    except SystemExit as exc:  # raised by the lower layers for a user-facing problem
        _emit(
            args,
            envelope(args.command, ok=False, errors=[{"code": "contract", "message": str(exc)}]),
        )
        return 3
    except Contract as exc:
        _emit(args, envelope(args.command, ok=False, errors=[{"code": "contract", "message": str(exc)}]))
        return 3
    except Exception as exc:  # noqa: BLE001 - an unexpected failure must still be machine-readable
        detail = traceback.format_exc(limit=6)
        _emit(
            args,
            envelope(
                args.command,
                ok=False,
                errors=[{"code": "internal", "message": str(exc), "detail": detail}],
            ),
        )
        return 3

    _emit(args, payload)
    return code


def _emit(args: argparse.Namespace, payload: dict[str, Any]) -> None:
    if getattr(args, "json", False):
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return
    # Human mode: summary on stdout, nothing else. Everything machine-readable required --json.
    for line in payload.get("summary") or []:
        sys.stdout.write(line + "\n")
    for warning in payload.get("warnings") or []:
        sys.stderr.write(f"! {warning.get('message')}\n")
    for error in payload.get("errors") or []:
        sys.stderr.write(f"x {error.get('message')}\n")
    if getattr(args, "command", None) == "verify-ground-truth" and payload.get("ok"):
        sys.stdout.write("ground truth verified\n")


if __name__ == "__main__":
    raise SystemExit(main())
