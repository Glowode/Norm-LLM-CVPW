# SPEC — Norm-LLM-CVPW constitution

**Status:** normative. **Version:** 1. **Applies to:** every artifact, tool, skill and project produced under this framework.

This document is the highest authority in the project. Where anything else disagrees with it —
another document, a schema, a template, generated code — this document wins and the other thing is a bug.

Keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** are used in the RFC 2119 sense.

---

## 0. What this framework is

Norm-LLM-CVPW is a **normalized, agent-agnostic framework for producing video from code**.

It is not a renderer, a language, or an application. It is a set of **contracts plus a toolchain plus a
skill catalogue** that lets any coding agent (Claude Code, Codex, DeepSeek Harness, a plain shell script,
a human) drive a video project to a finished deliverable without making design decisions at the wrong time.

Three properties define the framework. Everything else is implementation.

| Property | Meaning | Where it is enforced |
|---|---|---|
| **Normalization** | Every stage boundary is a versioned, schema-validated artifact. There is exactly one way an artifact enters a stage and one way it leaves. | `schemas/`, `packages/cli` (`cvpw validate`) |
| **Determinism** | A frame is a pure function of time. Re-rendering always yields the same bytes; any worker can render any frame in any order. | `docs/SPEC.md` §4, `@cvpw/audit` (static), `@cvpw/kernel` (runtime), `cvpw check --gold` (empirical) |
| **Accumulation** | The project grows by *registering* new scenes, styles, tools, schemas and skills. It never grows by editing a monolith. | `docs/EXTENDING.md`, `kernel/src/plugin.ts`, `schemas/` versioning |

### 0.1 Target audience order

When two readers conflict, the earlier one wins:

1. **An agent with no memory of this repo.** It must be able to start from `AGENTS.md` and reach a
   finished video using only files in the repository.
2. **The framework author**, adding capability.
3. **A human reviewer**, inspecting the result.

### 0.2 Non-goals

- Not an NLE. Not a timeline GUI. There is no interactive editor, and none is planned.
- Not a hosted service. No network dependency at render time; a render MUST work offline.
- Not a media transcoder. ffmpeg is used as an encoder and muxer, not as the compositor.
- Not a generative-art API client. Asset generation is a *stage* with a manifest, not a core concern.

---

## 1. Authority order

An agent resolves conflicts in this order, top to bottom:

```
1. docs/SPEC.md                 (this file)          — the constitution
2. docs/CONTRACTS.md                                 — artifact + time vocabulary definitions
3. schemas/*.schema.json                             — machine-readable form of (2)
4. docs/WORKFLOW.md, docs/QA.md, docs/EXTENDING.md   — procedure (normative)
5. project.json of the project you are working in    — the project's own knobs
6. generated artifacts (analysis/, cues/, timeline.json, reports/)
7. code (engine/, scenes/, tools/)
8. prose docs (README, AGENTS, ARCHITECTURE, BRIEF, STORYBOARD, notes)  — descriptive
```

**Normative versus descriptive.** Levels 1–4 are normative: if code disagrees with them, the code is
wrong. Levels 5–7 are factual records of a particular project. Level 8 is descriptive: if a prose doc
disagrees with code, the **doc** is wrong — fix the doc in the same change, never silently trust one
side. `docs/ARCHITECTURE.md` and `docs/ENVIRONMENT.md` live at level 8 deliberately: they explain and
measure, they do not legislate, and where either disagrees with levels 1–4 the higher level wins.

This rule exists because every reference project suffered from unmanaged doc/code drift; one of them
had to legislate "when doc and code disagree, the code wins", which makes its docs unverifiable.

An agent that cannot resolve a conflict MUST stop and report, not guess.

---

## 2. Glossary

Definitions are binding; the framework uses these words in exactly these senses.

| Term | Definition |
|---|---|
| **Project** | A directory containing `project.json`. The unit of work. Lives outside this repository by default. |
| **Artifact** | A file under a project that crosses a stage boundary. Every artifact has a `$schema` and a `schemaVersion`. |
| **Timebase** | The triple (duration, fps, event grid) derived from audio and/or cue data. The single authority on *when* things happen. |
| **Cue** | A named, absolute time with recorded **provenance**. The only permitted home for an off-grid time. |
| **Time expression** | A *string* in a timeline that resolves to seconds against the timebase. Never a bare number in authored scene code. |
| **Shot** | One entry in `timeline.json`: a scene, a time expression for its start, args, and optional handoff. |
| **Scene** | A registered drawing function + args schema. Pure function of time. The unit of authoring. |
| **Style** | A registered bundle (palette + defaults + post params) that scenes may read. The unit of aesthetic accumulation. |
| **Block** | A named contiguous time range owned by one author, containing several shots. The unit of *parallelism*. |
| **Handoff** | The contract describing how two blocks meet. Two modes: `pixel` (seam) and `transition`. |
| **Seam** | A `pixel` handoff: A's last frame and B's first frame must be near-identical. |
| **Frame hash** | A deterministic content hash of a rendered frame at a given time. The determinism witness. |
| **Gate** | A check with a numeric threshold that must pass before the next stage. |
| **Checkpoint** | A point where a human must be shown something before work continues. |
| **Fold** | `<framework-repository>` — this framework repository. Distinct from a *project*. |

---

## 3. Artifact rules

**A1.** Every artifact MUST be UTF-8 **without** a byte-order mark. Line endings MUST be LF
(`.gitattributes` enforces this in-repo; `cvpw validate` enforces it in projects).

**A2.** Every artifact MUST be a single JSON object (not a top-level array) with:

```json
{ "$schema": "<url or repo-relative path>", "schemaVersion": 1 }
```

**A3.** `schemaVersion` MUST be an integer. Additive, backward-compatible changes MUST NOT bump it;
they MUST go under an `extensions` object. Breaking changes MUST bump it and MUST ship a migration in
`packages/cli/src/cmd/validate.ts` plus a note in `docs/CONTRACTS.md`.

**A4.** Unknown top-level keys MUST be rejected. The schemas set `additionalProperties: false`.
This exists to catch typos: every reference project lost time to a misspelled key that fell back
silently to a default instead of failing.

**A5.** Artifacts MUST NOT contain absolute host paths, usernames, or machine-specific values. Paths are
relative to the project root and use forward slashes on every platform.

**A6.** Derived artifacts MUST be reproducible from their declared inputs. A derived artifact that
legitimately records *when a run happened* MUST confine that to a documented `run` block and MUST NOT
be used as an input to another stage. The three permitted exceptions are:

| Artifact | Why it carries a run record | Consequence |
|---|---|---|
| `render/report.json` | It describes one render: wall time, per-worker timings, the encoder actually selected | Never an input to a stage |
| `handoff.report.json` | It describes one seam measurement run | Never an input; `handoff.json` is the contract |
| `qa/report.json` | It records which gates ran and their observed values | Never an input to a stage |

Every other derived artifact MUST be byte-reproducible: no timestamps, no host paths, no durations, no
"generated at" fields. `analysis/audio.json` explicitly carries `generatedAt: null` for this reason —
date the *run*, in a report, not the *analysis*.

An artifact that cannot be regenerated at all MUST be listed in `docs/CONTRACTS.md` as *authored*, with
the reason.

**A7.** Every artifact produced by a model or an analysis pass SHOULD carry a `notes` string recording
provenance: what produced it, with what method, and what its known error is. Readers trust artifacts
that state their own uncertainty.

---

## 4. Determinism

This is the load-bearing invariant. Every capability downstream — parallel rendering, frame skipping,
pixel-level seam comparison, motion-blur sub-sampling, resumable renders, local edits — is a
consequence of it.

**D1.** A frame MUST be a pure function of `t` (and immutable, time-invariant inputs: config, assets,
the timebase). Given the same project state and the same `t`, any worker on any machine MUST produce
the same frame.

**D2.** The frame-drawing path MUST NOT call, directly or indirectly:
`Math.random`, `Date.now`, `new Date`, `performance.now`, `crypto.getRandomValues`, `requestAnimationFrame`,
`setTimeout`, or read any wall-clock or entropy source. All randomness MUST come from the seeded
generators in `@cvpw/kernel/src/rng.ts` (`hash1`, `hash2`, `mulberry32`, `noise1`, `fbm1`).

**D3.** A scene MUST NOT carry state between frames. A scene that genuinely needs simulation (particles,
feedback buffers, springs) MUST declare `stateful: true` and expose `reset()` + `step(dt, t)`.
The engine replays it deterministically from the shot start on every seek. A `stateful` shot MUST be
rendered with a fixed sub-frame count; adaptive sampling MUST refuse it.

**D4.** Per-frame jitter or flicker keyed to the frame rate MUST use `frameIndex(t)` and MUST NOT use
`Math.floor(t * fps)`. The helpers differ on exact frame boundaries, and using the wrong one produces
one-frame flicker at shot joins.

**D5.** Randomness that varies continuously with `t` MUST be seeded with `frameIndex(t)`, not with `t`
itself, unless the value is intentionally meant to smooth out. Continuous seeding makes noise crawl.

**D6.** All sub-frames within one output frame MUST see the same `frameIndex`, and the same `t` for any
non-motion-blurred element. Grain, dither and HUD are per-output-frame, not per-sub-frame.

**D7.** Determinism MUST be observable. The engine MUST expose `cvpw.frameHash(t)`. `cvpw check --gold`
MUST compare against a committed `gold.json`. A mismatch MUST fail the check with the offending times
and the observed delta.

**D8.** A known, unavoidable nondeterminism (GPU float rounding, a driver-specific path) MUST be
recorded in `qa/exemptions.json` with a date, a reason, an observed delta and an owner. Silently
tolerating drift is forbidden; a documented exemption is not.

**D9.** Changing a *published* effect MUST produce a new variant, never an in-place edit, once a
project has shipped a master. In-place edits silently invalidate every previous review.

---

## 5. Time

**T1.** The **timebase** is the single authority on when things happen. Authored code MUST NOT invent
times that the timebase does not contain.

**T2.** A time in authoring code MUST be a **time expression string** resolved against the timebase
(grammar in `docs/CONTRACTS.md` §3). A bare numeric literal in a scene or timeline is permitted only
as `"12.5"`/`"12.5s"` (absolute seconds) and MUST raise a `lint` warning.

**T3.** Resolution MUST be **strict**: a time expression that the timebase cannot substantiate MUST
throw, naming the failing token and listing the nearest valid alternatives. Silent fallback to a
default time is forbidden. This is the single most important rule in this section: it is what converts
"the beat grid is law" from a slogan into a property the machine enforces.

**T4.** `bpm` is a **label, not a grid**. Cuts MUST be derived from measured beat/bar/section times,
never from `n * 60 / bpm`.

**T5.** The tempo grid MUST be allowed to drift. A project whose tempo varies over time MUST use
`beats[]`/`bars[]` from the timebase, never a constant period.

**T6.** Every cue MUST carry `source` ∈ `measured | analysis | audit | initial | manual`. A tool MAY
refine `initial`/`analysis` cues; a tool MUST NOT overwrite a `manual` cue.

**T7.** Lyric **text** and lyric **timing** MUST be separable artifacts. The framework MUST NOT require
lyric text to be committed. A delivery check MUST refuse to publish a project containing lyric text
unless the project explicitly declares the text is licensed for distribution.

**T8.** Every off-grid moment (an actor's blink, a door slam, an impact) MUST be registered as a cue.
A time that is neither on the grid nor a cue id MUST NOT appear in authored code.

---

## 6. Composition

**C1.** Shots MUST NOT overlap unless at least one of them declares a transition; the **later** shot
owns drawing the transition. Overlap without an owner is a defect.

**C2.** The timeline MUST cover the full `[0, duration)` range with no gaps. A gap MUST fail
`cvpw storyboard`, not render as a black frame.

**C3.** Every shot MUST declare a `moment`: one sentence naming what this shot is *for*. A shot without
a `moment` MUST fail `cvpw storyboard`. This is the cheapest possible defence against filler.

**C4.** A `pixel` handoff MUST have a shared contract (camera, environment, layer order, fx) that
**both** sides import and read. Neither side may hard-code the values. The contract MUST be
machine-readable (`handoff.json`) so that `cvpw handoff` can verify it without a human.

**C5.** The scene layer MUST NOT be the only layer. A film's layers are: environment, actor/foreground,
text, post. A scene MAY draw several, but the engine MUST keep text on its own layer so it stays crisp.

**C6.** Text drawn on screen MUST come from a declared whitelist in `docs/BRIEF.md`. Unlisted text
(especially lyric lines) MUST fail `cvpw lint`.

**C7.** Positions in scene code MUST be expressed relative to the project's declared design space
(`project.json::output`) via `engine/lib/layout.js` helpers. Raw `1920`/`1080` arithmetic in a scene
MUST NOT appear; this is what makes a vertical variant a layout change rather than a rewrite.

**C8.** Safe areas: text MUST stay ≥ the declared `safe` inset from every edge and MUST stay clear of
the declared subtitle band.

---

## 7. Verification

**V1.** Verification is **evidence-based**. A stage is not done because it "should work"; it is done
because a gate produced a numeric result and an agent looked at an image. Both are required.

**V2.** Every gate MUST emit machine-readable output (`--json`) with: check id, threshold, observed
value, pass/fail, and the offending times/ids. A human-readable summary MAY accompany it.

**V3.** The agent MUST open rendered images and critique them. `cvpw review` MUST write a manifest of
what was produced and at what times; an agent claiming review without a populated manifest has not
reviewed.

**V4.** Every risky picture (anything a reasonable person would call "ambitious") MUST have a
**pre-declared fallback** written before it is attempted. If the attempt fails, the fallback is used;
a weak picture MUST NOT be kept because effort was spent on it.

**V5.** Thresholds live in `docs/QA.md` and in `project.json::budgets`. Tools MUST NOT invent
thresholds; a project that needs a different threshold changes `project.json` and says why.

**V6.** Exemptions MUST be explicit, dated and justified (`qa/exemptions.json`). An exemption is a
reviewed decision, not a mute button.

**V7.** Photosensitivity is a hard gate, not an aesthetic preference. Flash rate, saturated-red motion,
and full-frame luminance round-trips MUST be measured per section and MUST respect the budget in
`docs/QA.md`. This MUST be checked when a section is finished, never only at the end.

---

## 8. Portability and interoperability

**P1.** Every tool MUST be invocable as a **CLI** with a stable contract: `--json` emits one JSON
envelope; logs go to stderr; exit codes are `0` ok, `1` check failed, `2` bad usage, `3` contract
violation. This is what makes the framework platform-agnostic: an agent that can run a shell command
can use the framework, whatever its host.

**P2.** Agent-facing capability MUST ship as a **skill bundle**: a directory with `SKILL.md`
(YAML frontmatter, `name` + `description` only) plus `references/` and `scripts/`. The `description`
MUST carry both English and CJK trigger phrases and MUST name explicit negative triggers. Skills MUST
be usable with no Node project present.

**P3.** Language: **English is normative** for SPEC, CONTRACTS, schemas, code comments and commit
messages. Human-facing entry documents (`README.md`, `AGENTS.md`, `docs/WORKFLOW.md`, `docs/QUICKSTART.md`)
SHOULD ship a `.zh-CN.md` mirror. A mirror that drifts from its source is a bug in the mirror.

**P4.** Editor, console and filesystem encoding MUST be treated as hostile. All I/O MUST specify UTF-8
explicitly. Processes that write non-ASCII must force it (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`,
`chcp 65001` for generated Windows helpers). Temp paths used by external processes MUST be ASCII-only.
A `cvpw lint` rule MUST scan for U+FFFD and for bytes that are not valid UTF-8.

**P5.** External executables (ffmpeg, ffprobe, python, a browser) MUST be **discovered** and
**overridable** by environment variable, and MUST be reported by `cvpw doctor`. An absolute path to a
tool MUST NOT be hard-coded.

**P6.** External tools MUST be treated as fallible. Hardware accelerators (NVENC, VideoToolbox, VAAPI)
MUST be **probed** before use and MUST have a working software fallback. A failure MUST NOT produce a
plausible-looking but wrong output file.

**P7.** Optional capability MUST be discovered, not assumed. The environment report MUST separate
REQUIRED from OPTIONAL and MUST state what each missing optional item costs.

**P8.** No network access at render time. Fonts, assets and data MUST be local. A project that needs a
download MUST do it in an explicit fetch stage whose result is pinned and checksummed.

---

## 9. Collaboration

**S1.** A block MUST have exactly one owner. Blocks MUST be disjoint in time and in files.

**S2.** Shared files (engine core, `timeline.json`, handoff contracts, styles, `project.json`) MUST
have a designated owner — the integrator. A block author who needs a shared change MUST request it and
record the request, not make it.

**S3.** Work MUST be written to disk early and often, and every block MUST keep a progress log so that
an interrupted run can be taken over. On takeover, an agent MUST inspect what is on disk and run the
relevant check **before** re-running anything.

**S4.** Every stage boundary MUST be committed to version control. A project MUST be a git repository
from the first commit.

**S5.** When two agents disagree, the disagreement MUST be recorded in one append-only
`docs/INTEGRATION_NOTES.md` with the decision and the reason.

---

## 10. Compliance

An artifact, tool or project is **compliant** when:

1. `cvpw validate` passes on every artifact.
2. `cvpw lint` is clean.
3. `cvpw check` passes, or every failure has a dated entry in `qa/exemptions.json`.
4. Every gate that ran produced `--json` output.
5. `docs/PROGRESS.md` names every place the work departs from this spec, with a reason.

**Rule 5 is not optional bookkeeping.** A deviation that is not written down is indistinguishable from
a bug, and the next agent will either duplicate the mistake or "fix" a deliberate decision.

---

## 11. Amendment

This spec changes by pull request plus an ADR in `docs/adr/`. An ADR states: the decision, the
alternatives considered, the consequences, and the date. Amendments MUST NOT be retrofitted to make a
failed project pass.
