# ADR 0002 — Time as an expression, not a number

## Status
Accepted, 2026-01.

## Context
A music video is authored against music that will be re-analysed. A cut written as `12.48` is correct on
the day it is typed and wrong after the next analysis pass or a remaster, and nothing in the file can
tell that it has gone stale: the error surfaces during review as "the cut feels off". The prior art
shows the same lesson three times. `reference/world-execute-web` gives shots a vocabulary
(`T.section('verse').start`, `T.findLine('TESSERACT').start`) that **throws** on a reference it cannot
substantiate; `reference/dalabengba-mv` authors in canonical "default seconds", maps real audio through
a piecewise-linear warp, and states the rule outright — never write absolute seconds; the lyric-mv
project needed a dedicated cue-measuring tool for cue values that had drifted from measured onsets.

## Decision
A time in authoring code MUST be a time expression string resolved against the timebase
([SPEC](../SPEC.md) T2; grammar in [CONTRACTS](../CONTRACTS.md) §3). Resolution MUST be strict: a
reference the timebase cannot substantiate MUST throw, naming the failing token and up to three nearest
valid alternatives. There is no fallback and no default (T3).

- Absolute seconds are permitted only as `"12.5"` / `"12.5s"` and MUST raise an acknowledged `lint`
  warning (`timeline.absoluteTimes`).
- `bpm` is a label, not a grid: cuts derive from measured `beats[]`/`bars[]`, and `b(i,j)` looks a bar up
  by its `index` field, never by array position (T4, [CONTRACTS](../CONTRACTS.md) §3 rule 6).
- Off-grid moments MUST be registered as cues with a `source` before they can be referenced (T6, T8).
- Resolution is deterministic, cacheable, and audited in `render/report.json::resolvedTimes`.

## Consequences
**Positive**
- A re-analysis moves every cut with the music, because no cut contains a number.
- A typo (`cue('choru')`) fails at storyboard time with near matches listed, not at review.
- A missing grid throws instead of rendering a silently wrong picture; resolved times can be diffed.

**Negative**
- Authoring is more verbose, and every authored time depends on stage 2: an analysis re-run invalidates
  resolved times everywhere and requires `storyboard` and `handoff` to be re-run.
- A project with no audio must declare `timebase.mode: "manual"`, where `b()`, `h()` and `VOX()` throw.

**Neutral, and needs monitoring**
- Tolerance defaults (word 80 ms, impact 60 ms) are per-project judgement: too tight rejects real
  onsets, too loose accepts neighbours.
- The nearest-alternative list MUST stay short; manual mode should be a deliberate choice.

## Alternatives considered
- **Bare seconds.** Rejected: silently wrong after any re-analysis, and undetectable — the failure
  presents as taste rather than as an error.
- **Build-time codegen into a numeric `timeline.json`.** Rejected: a stale generated file is worse than a
  late failure, because nothing can tell that it is stale, and a build step sits between author and error.
- **Tolerant snapping with a default.** Rejected: the failure that produced the dedicated cue-measuring
  tool in `reference/world-execute-me-lyric-mv` — a human process compensating for a machine default.

## References
- [SPEC](../SPEC.md) §5 (T1–T8); [CONTRACTS](../CONTRACTS.md) §3, §6, §7; [QA](../QA.md) §2
  (`timeline.absoluteTimes`), [WORKFLOW](../WORKFLOW.md) stages 2–3.
- Prior art: [timing.js](../../reference/world-execute-web/src/engine/timing.js) and
  [edit.js](../../reference/world-execute-web/src/engine/edit.js) (vocabulary and tolerance that throw);
  [复现全流程.md](../../reference/dalabengba-mv/复现全流程.md) §3.3 (canonical time plus warp);
  [storyboard.md](../../reference/dalabengba-mv/docs/storyboard.md) ("never absolute seconds");
  [measure_cues.py](../../reference/world-execute-me-lyric-mv/tools/measure_cues.py).
