# ADR 0001 — Frame is a pure function of time

## Status
Accepted, 2026-01.

## Context
Frame skipping, multi-worker segmented rendering, pixel-level seam comparison, motion-blur sub-sampling,
resumable renders and local edits all depend on one property: the picture at time `t` must be
reproducible from `t` alone plus time-invariant inputs. The prior art states the rule and holds it
weakly: `reference/dalabengba-mv` states it in the engine header and in dozens of scene files and
enforces it with a shell `grep` for three API names, and `reference/world-execute-me-lyric-mv` states it
and relies on review. A `grep` is defeated by aliasing — `const r = Math.random; r()` passes it — so the
rule holds only while every author is careful.

## Decision
A frame MUST be a pure function of `t` and immutable, time-invariant inputs ([SPEC](../SPEC.md) D1).

- The frame-drawing path MUST NOT call `Math.random`, `Date.now`, `new Date`, `performance.now`,
  `crypto.getRandomValues`, `requestAnimationFrame`, `setTimeout`, or read any wall-clock or entropy
  source (D2); randomness comes from the seeded generators in `@cvpw/kernel/src/rng.ts`.
- Enforcement is static and AST-based (`cvpw lint`, `determinism.bannedApi`) and empirical
  (`cvpw check --determinism`, `--gold`): the same time rendered twice, and one worker versus three, MUST
  produce identical frame hashes ([QA](../QA.md) §2).
- Per-frame jitter uses `frameIndex(t)`, never `Math.floor(t * fps)` (D4); sub-frames share one
  `frameIndex` (D6).
- Simulation MUST declare `stateful: true` on the shot with `reset()` + `step(dt, t)`, replayed from the
  shot start on every seek (D3); unavoidable drift is recorded in `qa/exemptions.json` (D8).

## Consequences
**Positive**
- Any worker can render any frame in any order: segmented render, `--workers` and `--only` are one mechanism.
- Renders are resumable; a crash costs only the frames not yet written.
- Seams can be compared numerically instead of by eye, and a local edit stays local — gold hashes prove it.

**Negative**
- No stateful shortcuts: simulation must be replayable, and a seek into a stateful shot costs a replay.
- Third-party animation code that touches `Math.random` or `Date.now` cannot be dropped into a scene.
- Authors must use the seeded helpers and `frameIndex(t)`; the naive versions are the familiar ones.

**Neutral, and needs monitoring**
- Replay cost grows with the number of `stateful` shots; watch `scene.perf` p95.
- The AST scan MUST keep up with aliasing evasions; `tests/fixtures/` MUST exercise them.
- Real entropy (a hand-drawn texture) must be baked into an asset at stage 4, never generated per frame.

## Alternatives considered
- **A stateful render loop.** Rejected: output becomes order-dependent, so frame skipping, resumption and
  multi-worker rendering are unsound and the frame hash witnesses nothing.
- **A cached global timeline object.** Rejected: state leaks between frames, so the first frame after a
  seek differs from the same frame inside a full render — the hardest defect to find.
- **"Just be careful", unenforced.** Rejected: both reference projects state the rule in prose and one
  enforces it with a regex that aliasing defeats; a rule that cannot fail a build is a preference.

## References
- [SPEC](../SPEC.md) §4 (D1–D9), §6 (C1–C4); [QA](../QA.md) §2; [WORKFLOW](../WORKFLOW.md) stages 5–6.
- [ADR 0002](./0002-time-as-an-expression-not-a-number.md), [ADR 0004](./0004-filesystem-frame-transport-first.md).
- Prior art: [engine.js](../../reference/dalabengba-mv/src/core/engine.js),
  [tools/lint.sh](../../reference/dalabengba-mv/tools/lint.sh) (regex scan, defeated by aliasing),
  [world-execute-me-lyric-mv](../../reference/world-execute-me-lyric-mv).
