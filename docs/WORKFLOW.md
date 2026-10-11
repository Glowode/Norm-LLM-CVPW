# WORKFLOW — the eight stages

**Status:** normative (authority level 4). Companion to `docs/SPEC.md` and `docs/CONTRACTS.md`.

Each stage below has the same shape: **purpose · inputs · command · output · acceptance · failure modes ·
escape hatch**. A stage is finished when its acceptance criteria have produced *evidence* — a numeric
gate result and, where the stage produces pictures, an agent that has looked at them
(`docs/SPEC.md` V1–V3).

The stages are numbered 0–7. Numbers are stable; do not renumber. New capability is added as a new
command inside an existing stage, or as a new stage appended (never inserted).

---

## The loop at a glance

```
0 Setup ──▶ 1 Brief ──▶ 2 Timebase ──▶ 3 Storyboard ──▶ 4 Assets ──▶ 5 Build ──▶ 6 Review ──▶ 7 Deliver
   env        intent      when            what             with          how        look          ship
                          ▲                                               │
                          └────────────── re-timebase after a re-cut ◀────┘

Checkpoints (a human/agent must look before continuing):  ◆ after 2   ◆ after 3   ◆ first stills   ◆ preview render
```

**Rules that apply to every stage**

- Run `cvpw validate` before and after. A stage that consumes an invalid artifact MUST refuse to run.
- Write the gate result to `qa/report.json` (`--json`). Undocumented success is not success.
- Commit at every stage boundary (`docs/SPEC.md` S4).
- If you leave a stage unfinished, append to `docs/PROGRESS.md` what is done, what is not, and where
  you deviated from this document and why.

---

## Stage 0 — Setup

**Purpose.** Make the machine and the project ready, and tell the operator honestly what is missing.

**Inputs.** Nothing (for `doctor`) / a target directory and optional song + lyrics (for `new`).

**Commands.**
```bash
cvpw doctor [--json]                 # machine state; REQUIRED vs OPTIONAL; shows the cost of each gap
cvpw new <dir> [--song <f>] [--lyrics <f>] [--template project] [--link]
cvpw env [--json]                    # resolved external tool paths and versions
cvpw validate [--all]                # every artifact in the project
```

**Output.** A project tree from `templates/project/`, `git init`-ed with one commit; an environment report.

**Acceptance.**
1. Every REQUIRED item present: Node ≥ 20, Python ≥ 3.10, `ffmpeg`, `ffprobe`, a Chromium-family
   browser, and **git** — which is REQUIRED because `docs/SPEC.md` S4 requires a project to be a git
   repository from its first commit, and a stage boundary that cannot be committed cannot be rolled
   back.
2. `doctor` reports the **actual WebGL renderer** from a real headless probe. A software renderer
   (SwiftShader / WARP / llvmpipe) MUST be reported as a warning with its measured cost, not hidden.
3. `doctor` reports hardware encoder availability **by attempting an encode**, not by listing encoders.
   On the current reference machine `h264_nvenc` is listed but fails with exit `-40`
   (`Driver does not support the required nvenc API version. Required: 13.0 Found: 12.2`); reporting
   "NVENC available" there would be a lie, and the renderer would later fail or emit a corrupt file.
4. The project directory was empty or absent before scaffolding; `new` MUST refuse to write into a
   non-empty directory without `--force`.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| `cvpw: command not found` | CLI not built/linked | `pnpm -C packages/cli build && pnpm link --global` |
| Doctor says OPTIONAL `librosa` missing | Not installed | Fine — `cvpw analyze` uses the numpy path; upgrade only if beat detection is poor |
| Software renderer reported | No GPU access under headless | Fix browser flags / GPU driver before rendering; software is ~10× slower |
| `new` refuses to write | Directory not empty | Choose another directory or pass `--force` (destroys nothing that is committed) |

**Escape hatch.** `cvpw new --minimal` scaffolds without the template's sample scenes, for a project
that intends to write everything itself.

---

## Stage 1 — Brief

**Purpose.** Decide what the film *is*, before any code. Produce the intent that every later stage is
judged against.

**Inputs.** The user's request; the song, if any; the lyrics, if any.

**Command.** No command. This stage produces authored documents.

**Output.**
- `docs/BRIEF.md` — thesis (one sentence), logline, emotional arc per section, colour script, motifs and
  what they mean, 5–10 signature moments mapped to time expressions, the ending idea, and an explicit
  statement of what makes *this* film different from the reference examples.
- `docs/CONCEPT.md` — the visual half: palette, master shapes, typography rules, texture, camera language.
- `project.json::textWhitelist` — every string that may legally appear on screen (`docs/SPEC.md` C6).

**Acceptance.**
1. Thesis is one sentence and names a *visual* idea, not a mood.
2. Every signature moment is written as a time expression, not a timestamp.
3. `textWhitelist` is populated (possibly empty, with a reason).
4. The brief names at least one thing the film will **not** do. A brief with no refusals has no taste.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| Brief is generic | Written before reading the lyrics/song | Read them; name concrete images |
| Signature moments are timestamps | Ignorance of stage 2 | Write time expressions; they will fail loudly until the timebase exists — that is correct |
| No ending idea | Avoided the hardest decision | Decide it now; endings are not discovered in the render loop |

**Escape hatch.** For a small job, `docs/BRIEF.md` may be six lines. It MUST still contain thesis,
signature moments and the refusal.

**Checkpoint.** Show the brief in a few lines before continuing. Do not generate art without this.

---

## Stage 2 — Timebase

**Purpose.** Establish **when**. Convert audio and lyrics into the machine-checkable time authority
that every later stage resolves against.

**Inputs.** `audio/<file>`, optional lyrics text, optional `analysis/sections.json` overrides,
`project.json`.

**Commands.**
```bash
cvpw analyze [--audio <f>] [--bpm-range LO,HI] [--json]
cvpw cues    [--from analysis] [--json]      # map initial/analysis cues onto measured onsets
cvpw lyrics  [--join <file>] [--json]        # LRC or plain text → timing (and text, if licensed)
```

**Output.** `analysis/audio.json`, `analysis/envelope.json` + `.f32`, `analysis/overview.png`,
`cues/cues.json`, `cues/lyrics.timing.json` (+ `cues/lyrics.json` when text is being kept).

**Acceptance.**
1. `analysis/overview.png` exists and an agent has **looked at it**: waveform, energy, beat rulers,
   section boundaries. Reading the JSON is not reviewing the grid.
2. Tempo confidence reported; `octaveCheck` is `ok`. A tempo that is off by a factor of two is the
   single most common analysis failure and is obvious on the overview.
3. Every lyric line has a time, and the time is within the tolerance declared in `docs/QA.md`
   (default ±150 ms) of a detected vocal onset where vocal activity exists.
4. Every cue has a `source`. Anything still marked `initial` is listed for the operator.
5. Sections are labelled. Automatic grouping is unreliable on real masters: copy
   `analysis/sections_auto.json` → `analysis/sections.json`, fix boundaries by ear and by the plot,
   and re-run `cvpw analyze`.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| Beats look doubled/halved | Octave error | `--bpm-range 55,70` (a range around the true half/double) |
| Beat grid drifts late | Constant-tempo assumption on a live take | Confirm `beats[]` comes from tracking, not `n·60/bpm`; if the source has real rubato, this is a limitation to report |
| Every lyric line is early | Word timestamps taken from ASR | ASR word timings run 40 ms–2 s early; derive onsets from the vocal-band onset envelope |
| Sections look wrong | No manual override | Author `analysis/sections.json`; analysis is a proposal, not a verdict |
| Analysis takes minutes | Full transcription path | Not in step 1; official lyrics + alignment only |

**Escape hatch.** `project.json::timebase.mode = "manual"` — a project with no audio (a silent
explainer) uses cue times and absolute seconds only. `b()`/`h()`/`VOX()` then throw, which is correct:
there is no grid to honour.

**Checkpoint.** Show the overview plot and the section labels. A wrong grid poisons everything downstream.

---

## Stage 3 — Storyboard

**Purpose.** Decide **what** happens, and in what order, and express it as data.

**Inputs.** `docs/BRIEF.md`, `analysis/audio.json`, `cues/cues.json`.

**Command.**
```bash
cvpw storyboard [--out docs/STORYBOARD.md] [--blocks b01,b02,...] [--json]
```

**Output.** `timeline.json`, `docs/STORYBOARD.md` (human-readable table of the same data),
`docs/BLOCKS.md` (the machine-readable partition: id, file, range, cues, entry state, exit state,
handoff to the next block).

**Acceptance.**
1. Every `at` resolves. A failure names the shot and lists the nearest valid alternatives.
2. Coverage is exactly `[0, duration)` with no gaps and no unowned overlaps.
3. Every shot has a `moment`.
4. No shot uses a bare-number time without a warning having been acknowledged.
5. Shot durations respect the declared grammar for the content type (see `docs/QA.md`; for a song,
   chorus shots are short and verse shots long, and there are at least three genuine holds).
6. `docs/BLOCKS.md` partitions the film into blocks with **disjoint time ranges and disjoint files**,
   each with an entry state and an exit state. If two blocks meet without an overlap and without a
   transition, a seam MUST be registered in `handoff.json` **before** either block is written.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| `unknown cue 'choru'` | Typo | The error lists near matches; fix the timeline, not the cue file |
| Coverage gap reports `[4.0, 6.4)` | The author's mistake | Add the missing shot or extend a neighbour; never let the engine fill it |
| Every shot has the same duration | Storyboard written as a table of equal rows | Re-read the sections; vary by section dynamics |
| Blocks overlap in time but the overlap is not a designed transition | No partition discipline | Split the range or register a seam |

**Escape hatch.** An animatic of stills at every shot midpoint, rendered immediately with placeholder
scenes, reveals pacing problems before any scene is written. Do this if the pacing is uncertain.

**Checkpoint.** Show the storyboard table (or its stills) before writing scenes in volume.

---

## Stage 4 — Assets

**Purpose.** Produce the non-code material the film needs, with provenance.

**Status in step 1:** the contract is reserved; `cvpw assets` is a stub that validates and reports an
existing manifest. Asset *generation* is phase 2, and MUST NOT be required by the core pipeline.

**Inputs.** `docs/CONCEPT.md`, `docs/STORYBOARD.md`, an asset job list, any generator.

**Output.** `assets/**` plus `assets/manifest.json`:
```jsonc
{ "$schema": "schemas/assets.schema.json", "schemaVersion": 1,
  "assets": [{ "id": "hero_master", "path": "assets/char/hero_master.png",
               "size": [2048, 2048], "transparent": true, "alphaMethod": "chroma",
               "prompt": "…", "generator": "…", "source": "…", "licence": "…", "sha256": "…" }] }
```

**Acceptance.**
1. Every asset the engine loads appears in the manifest, and every manifest entry exists on disk
   (`sha256` verified).
2. Every asset has a `licence` and a `source`. An asset with unknown provenance MUST fail.
3. Every image has been **looked at**, and the review is recorded in `review/report.json`.
4. Character consistency: the same character reads as the same character across poses. This is a human
   judgement and MUST be made explicit, not assumed.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| Green fringes on a keyed asset | Despill missing or key too aggressive | Re-key with a two-colour edge model; keep the un-keyed `*.raw.png` |
| Character drifts across poses | No master reference | Generate every pose with the master image attached and a verbatim style block |
| Manifest/paths diverge | Manual file shuffling | Re-run `cvpw assets --reindex`; never hand-edit the manifest |

**Escape hatch.** A code-only film (procedural drawing, kinetic typography) needs no assets. Set
`assets: null` in `project.json` and this stage is skipped without a warning.

---

## Stage 5 — Build

**Purpose.** Write the scenes.

**Inputs.** `timeline.json`, `docs/BLOCKS.md`, `handoff.json`, the engine core, styles.

**Command.** No build command: this stage writes code. It is verified by:
```bash
cvpw lint [--json]                       # determinism, encoding, absolute-time, whitelist, layout
cvpw validate --all
cvpw check --scenes [--json]             # load every scene/shot alone; catch errors and empty frames
```

**Output.** `engine/scenes/*.js`, `engine/styles/*.js`, and any new registered scenes/styles.

**Acceptance.**
1. `cvpw lint` clean. Zero banned APIs, zero U+FFFD, zero invalid UTF-8, zero raw `1920`/`1080`
   arithmetic, no off-whitelist on-screen text.
2. `cvpw check --scenes` reports no `pageerror`, no `console.error`, and no empty frames.
3. Every scene's `argsSchema` validates the args used in `timeline.json`.
4. A scene author touched only their own files (`docs/SPEC.md` S1–S2). A needed shared change is
   recorded as a request in `docs/INTEGRATION_NOTES.md`, with the requested signature.
5. Frame cost is measured and within `project.json::budgets.msPerFrame`. Measure, do not guess.
6. Each scene was rendered as stills and looked at **at least twice**, with the findings written down.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| Frames differ between workers | Unseeded randomness, wall-clock, or carried state | `cvpw lint`; if AST-clean, add `stateful: true` and `reset()`/`step()` |
| One-frame flicker at a join | `Math.floor(t*fps)` instead of `frameIndex(t)` | Use the helper (`docs/SPEC.md` D4) |
| Seam fails after a shared edit | Shared value changed on one side only | Both sides read `handoff.json`; re-run `cvpw handoff` |
| A scene renders nothing at some t | Wrong active-interval logic | `cvpw check --scenes` reports empty frames; render the midpoint |
| Scene is slow | Per-shape shadow blur, unbounded particles, full-screen filters per layer | Respect the per-shot budget in `docs/QA.md` |

**Escape hatch.** Extend an existing scene with new args before writing a new one. A new scene is
justified by a *new visual idea*, not by a new set of parameters.

---

## Stage 6 — Review

**Purpose.** Look at the film and fix it. This is where the quality comes from.

**Inputs.** A project that lints and checks clean.

**Commands.**
```bash
cvpw stills --times 1.0,2.5,4.0 [--overlay] [--out review/stills]
cvpw sheet  --from 0 --to 8 --every 1.0 [--cols 4] [--out review/sheet.jpg]
cvpw sheet  --cues [--offset 0.12] [--out review/cues.jpg]     # one frame per cue — the single most useful image
cvpw review --mp4 render/mv.mp4 --step 1.8 [--out review/pass1]
```

**Output.** Images under `review/`, plus `review/report.json` listing every image produced, its time,
and the active shot ids at that time (so an agent can correlate a visual defect with a shot id without
guessing).

**Acceptance.**
1. Contact sheets exist and an agent has read them.
2. For every shot that changed, three frames were inspected: the first frame after the cut, the main
   event, and the last frame before the end.
3. Every defect found is recorded with a shot id and a time, and fixed or explicitly accepted.
4. The pass is repeated until a pass finds no new defects. Budget two to three passes.
5. Safety measurement is run **on the section that just changed**, not only at the end
   (`docs/SPEC.md` V7).

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| "Looks fine" with no image read | Reviewing by inference | `cvpw review` manifest MUST be populated; an agent claiming review without it has not reviewed |
| Defects fixed, new ones appear elsewhere | Changed a shared file | Re-render the untouched ranges and compare **numerically**, not by eye |
| The film is boring but technically clean | No attention at stage 1 or 3 | Revisit the storyboard's holds and escalation; this is not a render bug |
| Text is unreadable at speed | Text too small, or not held long enough | Names ≥ 48 px at 1080p, readable for ≥ 0.25 s before leaving (`docs/QA.md`) |

**Escape hatch.** Review a single block in isolation by rendering its range only
(`cvpw render --only b05`), which is far faster than a full pass.

---

## Stage 7 — Deliver

**Purpose.** Produce final files, prove they are correct, and report honestly.

**Inputs.** A reviewed project.

**Commands.**
```bash
cvpw handoff [--list "s02|s03"] [--json]     # seam A|REF|B strips + numeric grades → handoff.report.json
cvpw render  [--name mv] [--workers 2] [--preview] [--only b05] [--json]
cvpw check   [--profile preview|deliver] [--only b05] [--json]
cvpw deliver [--variants master,vertical] [--json]
```

`cvpw check` runs the gate set appropriate to `--profile`; the profile decides *which* gates run, and
the thresholds come from [`docs/QA.md`](./QA.md) and `project.json::budgets` — never from a flag. A
named gate can be forced with `--gate <checkId>` for focused work; a check id that does not exist is an
error, not a silent skip. `--only <block>` restricts every gate to one block's time range, which is how
a block author gets a fast, honest signal without rendering the film.

**The canonical gate set and its flags.** These are the only gate flags. The check ids are the ones
that appear in `qa/report.json` and in `qa/exemptions.json`, and they are defined — with thresholds and
bands — Once, in [`docs/QA.md`](./QA.md) §2. Where this table and `docs/QA.md` disagree about a check
id, `docs/QA.md` wins.

| Flag | Check ids it runs | Runs in profile |
|---|---|---|
| `--contract` | `contract.validate`, `encoding.utf8`, `determinism.bannedApi`, `text.whitelist` | all |
| `--determinism` | `determinism.gold`, `determinism.workerCount` | all |
| `--timeline` | `timeline.coverage`, `timeline.moment`, `timeline.absoluteTimes`, `timeline.pacing` | all |
| `--scenes` | `scene.errors`, `scene.emptyFrames`, `scene.perf` | all |
| `--text` | `text.safeArea`, `text.legibility` | all |
| `--lyrics` | `lyrics.alignment` | all |
| `--frames` | `render.frameCount`, `render.noDeadFrames` | render, deliver |
| `--av-sync` | `av.sync` | render, deliver |
| `--handoff` | `handoff.pixel` | render, deliver |
| `--flash` | `flash.rate` | render, deliver |
| `--assets` | `assets.manifest` | deliver |
| `--publish` | `publish.lyricText`, `deliver.credit` | deliver |

The **static** gates (`encoding.utf8`, `determinism.bannedApi`, `timeline.absoluteTimes`,
`text.whitelist`) are also reachable directly as `cvpw lint`, which is the fast loop an author uses
while writing. `cvpw lint` and `cvpw check` MUST report the same ids and the same verdicts for those
four — a check whose answer depends on which command asked is worse than no check.

**Profiles.** `cvpw check --profile all` (the default) runs the first seven flags; `--profile render`
adds the next four and requires a rendered master; `--profile deliver` runs everything. A gate that
cannot run because its input does not exist yet MUST be reported as `skipped` with the reason — never as
a pass. `--only <block>` restricts every gate to one block's time range, which is how a block author gets
a fast, honest signal without rendering the film.

**Output.** `render/<name>.mp4`, `render/<name>_stats.json`, `render/report.json`, `handoff.report.json`,
`qa/report.json`, a delivery list with sizes and durations, and `docs/PROGRESS.md` updated.

**Acceptance.**
1. Frame count in the MP4 equals `round(duration × fps)`.
2. A/V mux lag ≤ 1 frame, measured by cross-correlating the decoded track against the source audio.
3. `cvpw check --gold` passes, or every mismatch has a dated exemption.
4. All `pixel` handoffs grade `ok` or `minor`; any `ALIGN` either fixed or exempted with a reason.
5. Flash rate within budget, measured per section.
6. Every variant (e.g. 16:9 and 9:16) passes the same checks independently. A vertical variant is a
   layout, not a crop: it MUST be re-checked, not assumed.
7. The credit line appears verbatim where promised.
8. The delivery report states what was **verified**, what is **uncertain**, and what was **not done**.
   An honest uncertainty is worth more than a false pass.

**Failure modes.**
| Symptom | Cause | Action |
|---|---|---|
| MP4 exists but is short | Encoder died mid-write and left a plausible file | The renderer MUST delete a failed output; verify frame count before reporting success |
| Audio drifts late | Offset applied by editing the audio | Apply offset at mux time only (`docs/CONTRACTS.md` §2) |
| Two runs differ | GPU float rounding | Check `qa/exemptions.json`; if absent, record it — do not silently retry |
| Vertical variant has clipped text | Composed for 16:9 | Re-run the layout through `engine/lib/layout.js`; never scale the master |

**Escape hatch.** `--preview` renders at half resolution with a fast encoder for the review checkpoint.
It MUST be clearly named `*_preview.mp4` and MUST NOT be delivered as a master.

---

## Parallelising

The unit of parallelism is the **block** (`docs/BLOCKS.md`): a contiguous time range with one owner
and disjoint files.

- Partition by scene file, not by time alone. Two authors writing the same scene file is the failure
  this prevents.
- Shared files (`engine/core`, `engine/lib`, `timeline.json`, `handoff.json`, styles, `project.json`)
  belong to the integrator. Block authors request changes and record the request.
- Give each block author a **test timeline** so they render only their own range.
- Asset batches and analysis run independently of scene code.
- Long runs get interrupted. Authors write files early, keep a per-block progress log, and an
  interrupted block is taken over by reading the disk and running `cvpw check --only <block>`
  **before** re-running anything.
- Cap concurrency at `min(16, logicalCPUs - 2)`. Beyond that, GPU contention makes everything slower.

## After a re-cut

Re-cutting changes the timebase's *consumers*, not the timebase. When a re-cut happens:

1. `cvpw storyboard` again; resolve every time expression again.
2. `cvpw handoff` again for every affected seam.
3. Render and compare **numerically** (`cvpw check --gold`) any block whose authored range did not
   change. A re-cut must not silently restyle untouched work.
