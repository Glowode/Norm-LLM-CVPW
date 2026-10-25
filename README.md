# Norm-LLM-CVPW

**Normalized, agent-agnostic framework for producing video from code.**

> 规范化、平台无关的「代码化视频制作」框架。

An agent reads a brief, a song and a set of contracts, and drives a video project from an empty
directory to a finished, verified deliverable — using nothing but the files in this repository and a
shell. Every stage boundary is a versioned artifact; every frame is a reproducible function of time;
every aesthetic choice is registered, never hard-coded, so the framework accumulates capability
instead of accreting patches.

**Documentation languages:** this file has a Chinese mirror at [`README.zh-CN.md`](./README.zh-CN.md).
English is normative — see [`docs/SPEC.md`](./docs/SPEC.md) §8 (P3). Everything else is English.

---

## Why this exists

Code-based video work has been done well, repeatedly, by agents — and every time the useful part was
thrown away. Six strong reference projects sit in [`reference/`](./reference) (see the credit table
below). Each solved a piece of the problem and each hit the same walls:

| Wall | What it looked like in practice | What this framework does about it |
|---|---|---|
| **Silent contract drift** | A renamed JSON field breaks the consumer with no error; a misspelled key falls back to a default; a missing file renders a layer-less film with only a warning. No prior-art project had a formal schema. | `schemas/` is normative. Every artifact carries `$schema` + `schemaVersion`, unknown keys are rejected, and each stage refuses to run on an invalid input. |
| **Time that drifts** | An off-grid time is hand-typed, then re-analysis moves the music and the cut no longer lands. One project wrote a dedicated tool just to measure how far its cues had drifted; another forbade per-beat sync entirely because its beat phase was unmeasured. | Times are **expressions**, not numbers (`"b(32,0)"`, `"cue('chorus')"`, `"VOX('sudden')"`), resolved against the timebase, and resolution **throws** when the music cannot substantiate the reference. |
| **Determinism as folklore** | "Pure function of `t`" is stated as a rule and enforced — if at all — by a regex scan that aliasing defeats, in a shell script that only runs on the author's OS. | Three layers: an AST-based static analyzer, seeded generators in the kernel, and a frame-hash gate with a dated exemption list. |
| **Hardware assumed to work** | Encoder selection trusts `ffmpeg -encoders`. On the reference machine `h264_nvenc` is **listed and fails** (exit `-40`). | Encoders are **probed by attempting an encode** and falling back, and a failed render deletes its output so a truncated file can never look finished. |
| **Nothing to look at** | Verification is "look at every result" — true, but with no artifact telling an agent *which* frames matter or *what* was active in them. | `cvpw review` produces per-cue contact sheets, per-shot strips with the active shot ids burned in, and a machine-readable manifest of what to inspect. |
| **Extension means surgery** | A new visual idea required editing a shared timeline or engine file, which is exactly where parallel authors collide. | Scenes, styles, transports and checks are **registered**. Adding one is a file plus a manifest line. |

The framework is not a renderer and not a language. It is the part that survives: **contracts, gates,
and a vocabulary that fails loudly**.

---

## Install

```bash
git clone <this repo> Norm-LLM-CVPW
cd Norm-LLM-CVPW
pnpm install
pnpm build
node packages/cli/bin/cvpw.mjs doctor
```

`doctor` is the acceptance test for the machine. It reports REQUIRED versus OPTIONAL and states what
each gap costs. On the reference machine it reports, among other things, that **NVENC is present but
unusable**, that the only browser is Microsoft Edge, and that the console code page is 936 — three
findings that each changed the design ([`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md)).

## Make something

```bash
cvpw new ../my-film --song song.wav --lyrics lyrics.txt
cd ../my-film
cvpw analyze                                   # → analysis/audio.json + analysis/overview.png
#   LOOK at analysis/overview.png. Do not trust the beat grid until you have.
cvpw cues                                      # map cue guesses onto measured onsets
cvpw storyboard                                # → timeline.json + docs/STORYBOARD.md
cvpw stills --times 1,3.5,8 --overlay          # → review/stills/*.png   (LOOK at them)
cvpw sheet --cues                              # → review/cues.jpg       (one frame per cue)
cvpw render --workers 2                        # → render/my-film.mp4
cvpw check ; cvpw deliver
```

An agent should start from [`AGENTS.md`](./AGENTS.md) instead, which adds the authority order, the
checkpoint discipline, and the rules about what may and may not be touched.

`cvpw check` runs a **gate suite**: twelve flags, twenty-four check ids, thresholds defined once in
[`docs/QA.md`](./docs/QA.md) and bounds in `project.json::budgets`. `--profile all|render|deliver` selects how
far the suite goes; `--only <block>` restricts it to one block's range so a block author gets a fast,
honest signal. The same gates reached through `cvpw lint` return the same verdicts for the static ones.

---

## The eight stages

```
0 Setup ─▶ 1 Brief ─▶ 2 Timebase ─▶ 3 Storyboard ─▶ 4 Assets ─▶ 5 Build ─▶ 6 Review ─▶ 7 Deliver
  env       intent      when           what            with        how       look        ship
```

Full detail — inputs, commands, acceptance criteria, failure modes and escape hatches per stage — is
in [`docs/WORKFLOW.md`](./docs/WORKFLOW.md). The three checkpoints that matter most: **after the
timebase** (a wrong grid poisons everything), **after the storyboard**, and **at the first stills**.

---

## Repository map

```
docs/          SPEC (the constitution) · CONTRACTS · WORKFLOW · ARCHITECTURE · EXTENDING · ENVIRONMENT · QA · adr/
schemas/       normative JSON Schema 2020-12 — one file per artifact
packages/
  kernel/      @cvpw/kernel   browser-side render core: time expressions, timebase, seeded rng, layers, camera, plugin registry
  render/      @cvpw/render   headless capture backend: static server, browser launcher, frame sink, ffmpeg, encoder probe
  cli/         @cvpw/cli      the `cvpw` binary — 17 commands, every one with a JSON envelope and meaningful exit codes
  runtime/     @cvpw/runtime  DOM-free scene/timeline loader, so validation and storyboard generation run in Node
  audit/       @cvpw/audit    AST determinism + encoding analyzer
python/        cvpw_py        audio analysis, envelopes, cue settlement (numpy + soundfile; librosa optional)
skills/        cvpw · cvpw-timing · cvpw-qa   portable, agent-agnostic skill bundles
templates/     project/       the scaffold. Runs end-to-end out of the box.
examples/      minimal/       the committed vertical slice, with its outputs
tests/         unit/ integration/ e2e/ fixtures/
reference/     six prior-art projects, read-only. Credits below.
```

Where to put a new thing: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) has the decision table.
How to add it without leaving the framework inconsistent: [`docs/EXTENDING.md`](./docs/EXTENDING.md).

---

## Principles

Quoted from [`docs/SPEC.md`](./docs/SPEC.md), because a summary that drifts is worse than a link:

1. **Normalization.** One way in, one way out, per stage. If an artifact crosses a boundary it has a
   schema, a version, and a documented failure mode.
2. **Determinism.** A frame is a pure function of time (D1). No wall clock, no unseeded randomness, no
   state between frames (D2–D3). Verified by hash, not by hope (D7).
3. **Time is data.** Authoring code names moments; the timebase owns seconds; a reference the music
   cannot support is an error, not a default (T2–T3).
4. **Strict beats permissive.** Unknown keys are rejected, unresolved times throw, missing text fails
   the check. Every silent fallback in the prior art cost someone a day.
5. **Evidence, not assertion.** A stage is done when a gate produced a number and an agent looked at an
   image (V1–V3). A review without a manifest is not a review.
6. **Accumulation by registration.** New visual ideas, looks, transports and checks are registered into
   an existing spine. The spine does not grow special cases.
7. **Say what you did not do.** Every deviation is recorded in `docs/PROGRESS.md` with a reason.
   A deviation that is not written down is indistinguishable from a bug (SPEC §10).
---

## Prior art

These projects are the reason this framework exists. They are **read-only prior art** — cited,
credited, and never imported.

| Project | Licence | What it contributed here |
|---|---|---|
| [`vocaloid-style-mv-pipeline`](./reference/vocaloid-style-mv-pipeline) | MIT | Skill packaging with progressive disclosure; phased workflow with per-phase deliverables and acceptance criteria; `check_env` as a first-class tool; the layered compositor and palette/LUT system |
| [`dalabengba-mv`](./reference/dalabengba-mv) | see repo | Block partition with two handoff classes and a shared seam contract; canonical time + piecewise warp; the lint/smoke/seam-diff/jump-detect QA quartet; document-driven contracts for a large agent fleet |
| [`pdoom-video`](./reference/pdoom-video) | MIT | CTC forced-alignment toolchain and the pronunciation step that yields syllable timing; adaptive per-tile sub-frame sampling; per-artifact provenance `notes` |
| [`world-execute-me-lyric-mv`](./reference/world-execute-me-lyric-mv) | MIT (assets CC BY-NC-SA) | The frame sink (page → socket → encoder with ack back-pressure); a cue registry with per-cue provenance; a storyboard generator that imports the real scene modules headlessly; tile-diff regression; copyright-safe text-free lyric timing |
| [`world-execute-web`](./reference/world-execute-web) | AGPL-3.0 | A timing vocabulary that throws when the music has nothing there; the edit table as a data layer; first-class timeline validation; binary float32 feature layout |
| [`abstract-algebra-promo`](./reference/abstract-algebra-promo) | see repo | CDP-direct export with no dependencies and an ordered writer, giving output that is identical for any worker count; deriving the sound cue sheet from the picture rather than maintaining it in parallel |

Each `reference/` tree keeps its own licence and history. Nothing here is copied into
`packages/`, `schemas/`, `skills/` or `templates/`.

---

## Status

**v0.1 - the spine, and the limbs.** Seeded generators, the time-expression grammar, the plugin registry,
the CLI surface, the schemas, and the vertical slice (synthetic click track -> analysis -> deterministic
stills -> MP4 -> QA report). Phase 2 landed on the same contracts without breaking a v0.1 artefact:
procedural asset generation with a hash written back to the manifest, chroma keying as a pure function,
the WebGL2 post chain, the Blender bridge (discovery, version gate, batched render, frame adoption), and
lyric alignment as policy plus an abstract recognition seam with no adapter shipped.

**All 31 gates are implemented**, the example renders end to end, and the first film made with the
framework is its own promotional video - 140 seconds, 4200 frames, delivered, with every claim in the
film pointing at the command that produced it.

See [`docs/PROGRESS.md`](./docs/PROGRESS.md) for what is done, what is not, and every place the work
departs from the spec - which is the same standard the framework demands of its users.

---

## Licence

MIT. See [`LICENSE`](./LICENSE).

The framework is MIT-licensed; **the films you make with it are yours**. Nothing in the pipeline claims
any interest in your audio, your lyrics, or your footage - and by default it will not even commit them.
