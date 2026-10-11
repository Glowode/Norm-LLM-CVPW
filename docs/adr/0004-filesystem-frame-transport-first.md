# ADR 0004 — Filesystem frame transport first

## Status
Accepted, 2026-01.

## Context
The renderer draws frames in a browser and ffmpeg encodes them: either each frame goes to disk and ffmpeg
reads an image sequence, or frames stream over a socket straight into the encoder. The prior art
contains a measured streaming implementation: `reference/world-execute-me-lyric-mv/export/wsframes.mjs`
is a receive-only WebSocket endpoint with back-pressure — one frame, then wait for `ok` — and its header
records **~7× faster than `fetch(POST)` for 33 MB 4K frames**. That result is real and also a special
case: 33 MB is a 4K RGBA frame, while this machine renders 1080p at roughly 0.3–0.5 MB per JPEG frame,
where the win shrinks. The machine's constraints point the other way: 16 GB RAM and 2 GB VRAM
(buffering is a liability), a 5 GB default disk budget on 29.2 GB free, and an interruption-prone
workflow where a resumable render beats a fast one.

## Decision
The default sink **writes frames to an ASCII-safe temp directory** and feeds ffmpeg an image sequence. A
streaming WebSocket sink is reserved for phase 2 **behind the same interface**: a sink accepts
`(frameIndex, t, bytes)` and owns ordering and back-pressure, so swapping transports touches no scene
code, CLI surface or QA gate.

The ordering invariant is non-negotiable: **concurrent render, strictly ascending writes with a bounded
look-ahead**, so worker count cannot change the output. Workers may finish out of order; frames are
committed in ascending index and a worker ahead of the window blocks. This is what makes `--workers 1`
and `--workers 3` byte-identical ([QA](../QA.md) §2, `determinism.workerCount`). Temp paths handed to
ffmpeg and to browser profiles MUST be ASCII-only ([SPEC](../SPEC.md) P4).

## Consequences
**Positive**
- Resumable: frames on disk survive a crash or a reboot; re-render only what is missing.
- Debuggable by inspection, which is what makes `determinism.gold` and `handoff.pixel` possible.
- No memory pressure: the sequence is bounded by the disk budget, not by RAM or VRAM.

**Negative**
- Every frame is written and read again (disk bandwidth plus an extra encode pass), and the gap to
  streaming grows at 4K — a resolution this machine cannot render anyway.
- The frame sequence is a second artifact needing a temp root, a naming scheme and cleanup; a full disk
  becomes a render failure mode.

**Neutral, and needs monitoring**
- The look-ahead window is a throughput/memory trade-off; measure it rather than guessing it.
- Temp cleanup policy: an abandoned sequence can silently consume the disk budget.
- A future streaming sink MUST satisfy the same ordering invariant and be measured here, not assumed.

## Alternatives considered
- **WebSocket-first.** Rejected: faster only for large frames (the reference figure is for 33 MB 4K
  frames), not resumable — a dropped connection leaves memory instead of evidence — harder to debug, and
  every render would depend on a live socket.
- **Screenshot-to-disk with no sink interface.** Rejected: it hard-codes the transport into the CLI and
  blocks the phase-2 streaming upgrade, which has a working reference implementation.
- **In-memory buffering before muxing.** Rejected: 16 GB RAM and 2 GB VRAM make it a liability, a 4K
  RGBA frame is ~33 MB, and the post chain needs several live at once.

## References
- [SPEC](../SPEC.md) P6, P8, S3, §4; [QA](../QA.md) §2 and §2.2 (peak-disk rule);
  [ENVIRONMENT](../ENVIRONMENT.md) §4 (`CVPW_TMP`, `CVPW_WORKERS`), §9.
- [ADR 0001](./0001-frame-is-a-pure-function-of-time.md), [ADR 0005](./0005-utf8-discipline-on-a-cp936-host.md).
- Prior art: [wsframes.mjs](../../reference/world-execute-me-lyric-mv/export/wsframes.mjs) (streaming,
  ~7× for 33 MB 4K frames), [export.mjs](../../reference/world-execute-me-lyric-mv/export/export.mjs).
