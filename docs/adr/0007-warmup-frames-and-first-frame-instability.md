# ADR 0007 — Warm-up frames, and the instability of a session's first frames

**Status:** Accepted, 2026-01. **Supersedes nothing. Amends:** `docs/SPEC.md` D7, D8 and `docs/QA.md`
`determinism.gold`.

## Context

`docs/PROGRESS.md` named one assumption as the highest risk in the whole design: that
`renderFrame(t)` in a headless browser returns the same pixels for the same `t`. Every other property —
parallel workers, frame skipping, pixel-level seam comparison, the gold-frame gate, resumable renders —
follows from it. So it was measured before anything was built on it, with four scripts under `scripts/`
that are kept as executable documentation.

The measurement, on the reference machine (Edge 155, ANGLE/D3D11, GTX 1050), with a deliberately
adversarial page — gradient background, antialiased rotated paths, text, a canvas `filter` blur, and a
hash-keyed grain pass:

| Experiment | Result |
|---|---|
| Two browser sessions, identical 7-frame sequence | **7/7 byte-identical** |
| Three sessions, identical 24-frame sequence | **24/24 identical**, byte histograms equal |
| Five identical 25-frame walks in five sessions | **25/25 identical** |
| Two identical 40-frame walks in **the same session** | **2 frames differ: 0 and 1** |
| Three contiguous chunks, each jumped cold to its start | chunk boundaries at 14 and 28: **stable** |
| Frames 2..39 across walks, sessions and chunk boundaries | **stable** |
| Frames 0 and 1 across walks in one session | **two values, alternating by walk: 440053e8 then 40ec70f4** |

Three findings, in order of how much they matter:

1. **The film is deterministic.** Frames 2 onwards are byte-identical across sessions, across
   re-renders, and at chunk boundaries. The architecture is sound.
2. **A session's first two frames are not.** Frames 0 and 1 take one value on a session's first walk and
   a different, stable value on every subsequent walk. This is not a function of the time values: frame
   0 and frame 1 are ordinary frames.
3. **Warming the canvas does not remove it.** Drawing three throwaway frames before `window.ready`, even
   drawing *the same frames that will be captured*, changed nothing. Nor did drawing arbitrary frames, nor
   a one-frame preroll before a chunk. The transition is not "the canvas is cold"; it is "these are the
   first two frames this page has ever produced", and no amount of prior drawing inside the same page
   moves it.

## Decision

**Accept the instability as a bounded, documented exception rather than fighting it.**

1. `project.json::render.warmupFrames` is a new knob, default **2**. The renderer renders and discards
   that many frames at the head of the timeline before capturing, so a render is never the session's
   first walk. This is cheap (2 frames of a 2000-frame film is 0.1 %) and it makes a re-render
   reproduce the previous render rather than the previous session's first attempt.
2. `qa/gold.json` MUST exclude frames below `warmupFrames`. A gold file that includes them would fail
   on a coin flip, and a check that fails randomly is a check people learn to ignore.
3. `frameHash` MUST be computed from captured frame bytes, not from an in-page `getImageData` read.
   The spikes proved readback is stable, so in-page hashing would *work* — but it would witness the
   canvas rather than the artefact, and the two can diverge (different encoding settings produce
   different bytes from identical pixels). The witness must be the thing that ships.
4. The renderer MUST report `warmupFrames` and the frame hashes it actually captured in
   `render/report.json`, so the exception is visible in the artefact rather than living only here.

## Consequences

**Positive.** The determinism claim is now measured rather than asserted, and its one exception is
quantified. Parallel rendering is safe: chunk boundaries — the only place a worker's cold start could
show — are stable, so no preroll is needed for chunking. The gold-frame gate is usable because it no
longer depends on a frame that alternates.

**Negative.** Two frames of every render are wasted, and the film's first two frames remain
irreproducible across sessions. A `pixel` seam at exactly frame 0 or 1 cannot be verified by hash.

**Neutral, and needs monitoring.** The cause is not understood — only measured. Chromium's canvas
implementation is the likely place, which means a browser update could move the boundary from two frames
to zero, to ten, or to anywhere. `determinism-chunks.mjs` therefore stays in the repository as a
regression check to be re-run after a browser or driver update, not as a one-off investigation.
`warmupFrames` being a project knob rather than a constant is what makes that cheap.

## Alternatives considered

- **Fight it with a longer warm-up.** Rejected on evidence: three different warm-up strategies, including
  drawing the exact frames to be captured, all changed nothing. Continuing down this path would have been
  guessing dressed as engineering.
- **Ignore it as GPU float noise.** Rejected because it is not noise: the values are *exactly* two
  distinct states, stable within a session, alternating by walk. Noise is not stable.
- **Serialise rendering to a single pass from frame 0.** Rejected because a multi-minute film cannot be
  re-rendered to fix one shot, and because it would discard the parallelism the framework is built on for
  a defect confined to two frames.
- **Compute `frameHash` in-page.** Rejected for the reason in Decision 3: it witnesses the canvas, not
  the deliverable.

## References

- Measurements: `scripts/determinism-spike.mjs`, `determinism-session.mjs`, `determinism-repeat.mjs`,
  `determinism-chunks.mjs`
- `docs/SPEC.md` D7 (observable determinism), D8 (documented exemptions)
- `docs/QA.md` `determinism.gold`
- `reference/vocaloid-style-mv-pipeline` documented the same class of effect as an "ImageBitmap warm-up"
  and worked around it positionally; this ADR replaces that with a measured boundary and a knob.
- Related: ADR 0004 (filesystem frame transport), which the ordering invariant belongs to.
