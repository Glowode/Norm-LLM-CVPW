# ADR 0006 — Probe hardware encoders, never assume

## Status
Accepted, 2026-01.

## Context
The reference machine advertises `h264_nvenc` and `hevc_nvenc` in `ffmpeg -encoders` and reports `cuda`
among its accelerators, yet a five-frame test encode exits with code **-40**: the driver exposes NVENC
API **12.2** while ffmpeg 8.0.1 requires **13.0** ("The minimum required Nvidia driver for nvenc is
570.0 or newer"). The encoder is listed because the *build* contains it and fails because the *driver*
cannot initialise it. Believing the listing is worse than a crash: the render dies mid-write, leaving a
truncated MP4 with a valid header that opens, plays and stops early — exactly the
plausible-looking-but-wrong output [SPEC](../SPEC.md) P6 forbids.

## Decision
Before an encoder is selected it MUST be **probed by attempting an encode**, judged by the process exit
code ([SPEC](../SPEC.md) P6; [ENVIRONMENT](../ENVIRONMENT.md) §5.2):

```bash
ffmpeg -hide_banner -f lavfi -i testsrc2=size=320x240:rate=30 -frames:v 5 -c:v h264_nvenc -f null -
```

- Any non-zero exit means **unavailable**. The framework MUST NOT look for the literal `-40`: a POSIX
  shell reports the same failure as `216`, truncated modulo 256.
- The probe writes nothing (`-f null -`); a failed probe against a real path MUST delete its output.
- On failure the renderer falls back to software (`libx264`) and records `codecRequested` next to the
  `codec` that ran in `render/report.json`, so the master's encoder is never a guess.
- `cvpw doctor` reports UNAVAILABLE **with the exit code**, never availability on the strength of
  `ffmpeg -encoders`. The rule covers QSV, AMF, VAAPI and VideoToolbox as well.

## Consequences
**Positive**
- "Listed but broken" cannot be mistaken for working, and the report states what encoded the master.
- A truncated output becomes much less likely: the fallback is chosen before the first frame.

**Negative**
- About a second added to every `doctor` run; software encoding then costs minutes per pass at 1080p
  here — a planning constraint, not a capability loss.
- A passing probe is not a guarantee: a driver can fail later in a long render, so the renderer MUST
  still delete a failed output and verify the frame count ([QA](../QA.md) §2, `render.frameCount`).

**Neutral, and needs monitoring**
- A driver update can change the verdict, so the probe result is per-run, never cached; its size (five
  frames at 320×240) is a compromise, and other fallible tools (ffprobe versions, browser codec support)
  should be probed rather than inferred from a version string.

## Alternatives considered
- **Trust `ffmpeg -encoders`.** Rejected: the encoder is listed on a machine where it fails with `-40`;
  the listing reports what the build was compiled with, which is not the question being asked.
- **A configuration flag set by hand.** Rejected: people copy configurations between machines, so the
  flag lies in exactly the situation it was invented for, and it lies toward a broken deliverable.
- **Try hardware, retry with software on an unexpected error.** Rejected: a mid-render failure leaves a
  truncated file that looks finished, and the fallback belongs before the first frame.

## References
- [SPEC](../SPEC.md) P6, P5; [WORKFLOW](../WORKFLOW.md) stage 0 (acceptance 3), stage 7 (failure modes);
  [ENVIRONMENT](../ENVIRONMENT.md) §3.1, §5.2, §8; [QA](../QA.md) §2 (`render.frameCount`).
- Prior art: the machine's own measurement (`h264_nvenc` listed, failing with exit `-40`) and the
  hand-chosen software settings in [export.mjs](../../reference/world-execute-me-lyric-mv/export/export.mjs)
  and [tools/render.mjs](../../reference/dalabengba-mv/tools/render.mjs) — the manual version of the probe.
