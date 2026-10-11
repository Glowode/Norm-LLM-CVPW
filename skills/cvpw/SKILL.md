---
name: cvpw
description: >-
  Produce a video from code with the Norm-LLM-CVPW framework: a normalized eight-stage pipeline
  (Setup, Brief, Timebase, Storyboard, Assets, Build, Review, Deliver) with schema-validated artifacts,
  a deterministic frame-as-a-pure-function-of-time renderer, and a gate suite that turns "look at every
  result" into something verifiable. Use it whenever someone wants a video — a music video (MV / PV /
  手书 / 文字PV / lyric video / 歌词视频 / 动态歌词 / リリックビデオ), a data or math visualisation, an
  explainer, an animated title sequence, a promo, a vertical Short, or any "make me a video from this
  song / script / dataset" request — and whenever you must work inside an existing cvpw project
  (there is a project.json) or extend the framework with a new scene, style, gate or artifact.
  Triggers: "make a video", "make an MV", "给这首歌做个MV", "做个PV", "做个视频", "剪个MV",
  "この曲のMVを作って", "ボカロPV作って", "animate this", "code-based video", "programmatic video",
  "render a video with ffmpeg", "cvpw project", "timeline.json". Not for editing existing footage,
  for clip compilations, for a screen recording, or for a purely hand-authored NLE edit — the framework
  draws every frame from code and has no NLE, no timeline GUI, and no import of shot footage.
---

# cvpw — make a video from code

You are about to drive a video project from intent to a verified master. Read this file first; it tells
you what the framework guarantees, the order of work, and the rules that keep you out of trouble. Read
the references when a specific stage needs them — the routing table is at the end.

## What this framework is, and what it is not

**It is** contracts, a toolchain and a gate suite. Every stage boundary is a JSON artifact with a schema
and a version. A frame is a pure function of time. Every aesthetic choice is *registered*, so the
project accumulates capability instead of accreting patches.

**It is not** a renderer you write from scratch, a language, or an NLE. You do not invent a timeline
format, a shot shape, a determinism strategy or a file layout — all four exist and are normative.
Your job is to fill in *this* film: the concept, the timing, the scenes, the review.

## The one-sentence version of every rule

> Nothing may be a guess: not a time, not an argument name, not a threshold, not a colour, not the
> claim that a frame looks right.

Everything below is a consequence.

## Before anything: read the project's own state

If you are inside a project (there is a `project.json`), read in this order and do not skip:

1. `docs/BRIEF.md` — what the film is *for*
2. `docs/CONCEPT.md` — the visual law: palette, motifs, typography, camera language
3. `docs/BLOCKS.md` — who owns which time range and which files
4. `docs/PROGRESS.md` — what is done, what is not, and every deliberate deviation so far
5. `docs/INTEGRATION_NOTES.md` — arguments already settled, and requests to the integrator

Skipping step 5 is how two agents do the same work twice. Skipping step 4 is how you "fix" a decision
someone made on purpose.

If there is no project yet, you are at Stage 0.

## The eight stages

Each ends with something on disk that you can show a human. **Stop at every checkpoint.**

| # | Stage | Command or act | Output | Checkpoint |
|---|---|---|---|---|
| 0 | Setup | `cvpw doctor` | env report | read it before believing anything |
| 1 | Brief | write | `docs/BRIEF.md`, `docs/CONCEPT.md`, `textWhitelist` | **yes** — a few lines |
| 2 | Timebase | `cvpw analyze`, `cvpw cues`, `cvpw lyrics` | `analysis/audio.json`, `cues/*` | **yes** — the overview plot |
| 3 | Storyboard | `cvpw storyboard` | `timeline.json`, `docs/STORYBOARD.md` | **yes** — the table |
| 4 | Assets | `cvpw assets` | `assets/**` + manifest | master picks |
| 5 | Build | write scenes | `engine/scenes/*.js` | — |
| 6 | Review | `cvpw stills`, `cvpw sheet`, `cvpw review` | `review/**` + manifest | **yes** — first stills |
| 7 | Deliver | `cvpw handoff`, `cvpw render`, `cvpw check`, `cvpw deliver` | `render/*.mp4`, reports | **yes** — the master |

Stage 2 is where projects are won or lost. Open the overview plot and *read* it: waveform, energy,
beat rulers, section boundaries. A tempo octave error — beats at double or half the true rate — is the
single most common analysis failure, it is obvious on the plot, and it is invisible in the JSON.

Stage 6 is where the quality comes from. Budget two to three passes. If a pass finds nothing, you were
probably not looking at the right frames: for every changed shot, look at the first frame after the
cut, the frame at the main event, and the last frame before the end.

## Rules that will bite you if you skip them

**Time.** Never hand-type a second. Write `"b(32,0)"`, `"cue('chorus')"`, `"L(12)"`, `"VOX('sudden')"`,
`"p(0.85)"`. Resolution is strict: a reference the timebase cannot substantiate **throws**, and that is
the feature. If it throws, fix the analysis, the cue list or the storyboard — never the expression.
`bpm` is a label; the grid is `beats[]`/`bars[]`, because tempo drifts.

**Determinism.** A frame is a pure function of `t`. No `Math.random`, no `Date.now`, no
`performance.now`, no timers, no state between frames. Randomness comes from `cvpw`'s seeded generators,
keyed on an explicit string or the frame index. If a scene truly must simulate, declare
`stateful: true` and expose `reset()`/`step()`; the engine replays it deterministically.

**Arguments.** A scene declares an `argsSchema`. An unknown key is an **error**, not a default. This
exists because a misspelled argument silently falling back to a default has cost every project that
tried this a day or more.

**Layout.** Never write `1920` or `1080` in a scene. Ask the layout. That is what makes a vertical
variant a layout change rather than a rewrite.

**Text.** Only strings from `project.json::textWhitelist` may appear on screen. Inside the safe inset,
clear of the subtitle band.

**Ownership.** Your files are the ones `docs/BLOCKS.md` lists for your block. Shared files —
`engine/core`, `engine/lib`, `timeline.json`, `handoff.json`, styles, `project.json` — belong to the
integrator. Need a change there? Record a request in `docs/INTEGRATION_NOTES.md` and work around it.

**Deviation.** Every place you depart from the spec goes in `docs/PROGRESS.md` with a reason. An
undocumented deviation is indistinguishable from a bug, and the next agent will either repeat it or
"fix" your deliberate decision.

## Look at the result, and prove you did

`cvpw review` writes `review/report.json` listing every image and what was on screen at its time.
An agent claiming to have reviewed without a populated manifest has not reviewed. Open the images —
the contact sheet for pacing, the per-cue sheet for "is every lyric line's picture right", and single
full-resolution stills for anything you are about to defend.

Two habits that separate a good result from a technically-correct one:

- **Measure where the section is finished, not at the end.** A photosensitivity budget measured at the
  end is a report about a film you can no longer fix cheaply.
- **Verify untouched work numerically.** After any change, compare the ranges you did not mean to touch
  against the gold frames. A shared-file edit that changed nobody's work is a claim until it is a number.

## Working style

- Write to disk early and often, and keep a progress log. Long runs get interrupted; the work that
  survives is the work that was already written. On takeover, read the disk and run the relevant check
  **before** re-running anything.
- Parallelise by **block**: a contiguous time range with one owner and disjoint files. Give each author
  a test timeline so they render only their own range. Cap concurrency at `min(16, logicalCPUs - 2)` —
  beyond that, GPU contention makes everything slower.
- Prefer extending an existing scene's arguments over writing a new scene. A new scene must be
  justified by a *new visual idea*.
- Every risky picture gets a **pre-declared fallback** before you attempt it. If the attempt fails, use
  the fallback. Do not keep a weak picture because effort was spent on it.

## When something goes wrong

| Symptom | Do |
|---|---|
| A time expression throws | The timebase genuinely lacks that moment. Fix the analysis, the cue list, or the storyboard. **Never** substitute a literal. |
| A gate fails | Read the offenders in the `--json` output. Find the cause. Do not retry; do not widen the threshold in code. |
| Frames differ between workers | Unseeded randomness, a clock read, or state between frames. Run `cvpw lint`; if it is clean, the scene is `stateful` and needs `reset()`/`step()`. |
| A seam fails | Re-read the shared contract both sides import. Neither side may hard-code it. Always measure with grain **off**. |
| The checks pass but the film is boring | Not a render bug. Go back to Stage 1 or 3 — the holds, the escalation, the `moment` sentences. |
| A suspiciously small output file | The renderer deletes its output on failure. Check `render/report.json` for `errors` before believing any file. |
| You need a threshold changed | `project.json::budgets` or `docs/QA.md`, with the reason in `docs/PROGRESS.md`. |

## References — read the one the stage needs

| file | read when |
|---|---|
| [`references/01-stages.md`](./references/01-stages.md) | You are starting a stage and want its inputs, commands, acceptance criteria and failure modes in one place. |
| [`references/02-principles.md`](./references/02-principles.md) | You are about to make a design or architecture decision and want to know which rule governs it, and why. |
| [`references/03-parallel-work.md`](./references/03-parallel-work.md) | More than one agent is working, or you are the integrator. |
| [`references/04-artifacts.md`](./references/04-artifacts.md) | You need the exact shape of an artifact, or you are adding one. |
| [`references/05-troubleshooting.md`](./references/05-troubleshooting.md) | Something is failing and you need the symptom-to-cause table. |
| [`../cvpw-timing/SKILL.md`](../cvpw-timing/SKILL.md) | The question is "when" — audio analysis, lyric timing, cue curation. |
| [`../cvpw-qa/SKILL.md`](../cvpw-qa/SKILL.md) | You are running gates, reviewing, or delivering. |

Framework-level, normative, and worth reading once in full if you are new to the project:
`docs/SPEC.md` (the constitution), `docs/CONTRACTS.md` (artifacts and the time grammar),
`docs/WORKFLOW.md` (the eight stages in detail), `docs/QA.md` (thresholds), `docs/EXTENDING.md`
(how to add capability). Your platform may ship these alongside the skill; if not, they are in the
framework repository the skill came from.
