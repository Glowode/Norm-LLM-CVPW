# 01 — the eight stages, procedurally

The stages are numbered 0–7 and the numbers are stable. This file is what you read **while** you are in a
stage: inputs, the acts, the commands, the acceptance criteria you can actually check, the failure modes,
and the escape hatch when the honest answer is "this stage is too big for what we have".

Normative source: [`docs/WORKFLOW.md`](../../../docs/WORKFLOW.md). Where this file and that document
disagree, that document wins and this file is a bug. Gates and thresholds belong to
[`docs/QA.md`](../../../docs/QA.md) — no number in this file overrides one there.

```
0 Setup ─▶ 1 Brief ─▶ 2 Timebase ─▶ 3 Storyboard ─▶ 4 Assets ─▶ 5 Build ─▶ 6 Review ─▶ 7 Deliver
  env       intent      when           what            with        how       look        ship
                        ▲                                          │
                        └────────── re-timebase after a re-cut ◀────┘
```

## The four checkpoints

A checkpoint is a **stop**, not a status update. You MUST show a human (or the requesting agent) the thing
below, in a form they can disagree with, before spending work on the next stage.

| # | After stage | You MUST show | "Continue" means |
|---|---|---|---|
| C1 | 1 Brief | the brief in ~6 lines: thesis, two or three signature moments, and the refusal | the film's intent is agreed |
| C2 | 2 Timebase | `analysis/overview.png` opened and read aloud (waveform, energy, beat rulers, section boundaries) plus the section labels | the grid is trusted; a wrong grid here poisons every later stage |
| C3 | 3 Storyboard | the storyboard table: shot ids, `at`, `to`, durations, `moment` sentences, and the block partition | the shape of the film is agreed before scenes are written in volume |
| C4 | 6 Review, first stills | the stills you actually opened, with the shot id and time of each, and what you saw | the look is agreed before a full render is paid for |

Checkpoints C2 and C3 are the two that pay for themselves most often: an octave error in the tempo and a
storyboard with no contrast are both free to fix at the checkpoint and expensive afterwards.

## Stage 0 — Setup

**Purpose.** Make the machine and the project ready, and tell the operator honestly what is missing.

**Inputs.** Nothing (for `doctor`); a target directory, optional `--song`, optional `--lyrics` (for `new`).

**Do.**
```bash
cvpw doctor                       # READ IT. REQUIRED vs OPTIONAL, and the cost of each gap.
cvpw env                          # resolved external tool paths and versions
cvpw new ../my-film --song song.wav --lyrics lyrics.txt
cd ../my-film
cvpw validate                     # must pass on the scaffold as committed
git log --oneline                 # S4: a project is a git repository from its first commit
```

**Acceptance.**
1. Every REQUIRED item is present: Node ≥ 20, Python ≥ 3.10, `ffmpeg`, `ffprobe`, a Chromium-family
   browser, and **git** — REQUIRED because every stage boundary MUST be committable
   ([`docs/SPEC.md`](../../../docs/SPEC.md) S4).
2. `doctor` reports the **actual WebGL renderer** from a real headless probe; a software renderer
   (SwiftShader / WARP / llvmpipe) is reported as a warning with its measured cost, not hidden.
3. Hardware encoders are reported **by attempting an encode**, not by listing them.
4. The target directory was empty or absent before scaffolding; `new` refuses a non-empty directory
   without `--force`.
5. `cvpw validate` exits 0 on the fresh scaffold.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| `cvpw: command not found` | CLI not built or linked | `pnpm -C packages/cli build && pnpm link --global` |
| `doctor` says OPTIONAL `librosa` missing | Not installed | Fine — `cvpw analyze` uses the numpy path; upgrade only if beat detection is poor |
| Software renderer reported | No GPU access headless | Fix browser flags / GPU driver before rendering; software is roughly 10× slower |
| `new` refuses to write | Directory not empty | Pick another directory, or `--force` — nothing committed is destroyed |
| NVENC listed as available but a render fails | "Available" was inferred from a list | Re-read the doctor line: it probes by encoding. Trust the probe, not the list |

**If you must improvise.** `cvpw new --minimal` scaffolds without the template's sample scenes. Use it only
for a project that intends to write every scene itself; you lose the working example that `cvpw selftest`
guarantees.

## Stage 1 — Brief

**Purpose.** Decide what the film *is*, before any code. Produce the intent every later stage is judged
against.

**Inputs.** The user's request; the song, if any; the lyrics, if any. Read the lyrics before writing a word.

**Do.** No command — this stage authors documents.

```bash
# 1. read the inputs
#    audio/song.wav, audio/lyrics.txt (or the user's message)
# 2. write the three authored outputs
#    docs/BRIEF.md   thesis / logline / arc per section / colour script / motifs /
#                    5-10 signature moments AS TIME EXPRESSIONS / the ending idea / the refusal
#    docs/CONCEPT.md palette, master shapes, typography rules, texture, camera language
#    project.json    textWhitelist — every string that may legally appear on screen
cvpw validate                     # textWhitelist + output invariants are schema-checked
```

**Acceptance.**
1. The thesis is one sentence and names a **visual** idea, not a mood.
2. Every signature moment is written as a time expression (`"cue('chorus')"`, `"b(32,0)"`, `"S('bridge')"`),
   never a timestamp. They will throw until stage 2 exists; that is correct and expected.
3. `textWhitelist` is present and populated, possibly empty **with a reason**.
4. The brief names at least one thing the film will **not** do. A brief with no refusals has no taste.
5. The ending idea is decided. Endings are not discovered in the render loop.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| The brief is generic | Written before reading the song or lyrics | Read them; name concrete images that only fit this song |
| Signature moments are timestamps | Stage 2 does not exist yet | Write the expression anyway; a thrown expression is the stage-2 to-do list |
| No ending idea | The hardest decision was deferred | Decide it now — it constrains the last two blocks |
| Text appears on screen that is not in the whitelist | `text.whitelist` was treated as a formality | Add the string with a reason, or drop the text; the whitelist is the deliverable, not a permission slip |

**If you must improvise.** For a small job `docs/BRIEF.md` MAY be six lines. It MUST still contain the
thesis, the signature moments and the refusal. **Checkpoint C1**: show it before generating any art.

## Stage 2 — Timebase

**Purpose.** Establish **when**. Convert audio and lyrics into the machine-checkable time authority that
every later stage resolves against.

**Inputs.** `audio/<file>`, optional lyrics, optional `analysis/sections.json` overrides, `project.json`.

**Do.**
```bash
cvpw analyze                                   # audio → analysis/audio.json, envelope.*, overview.png
# OPEN analysis/overview.png. Read it: waveform, energy, beat rulers, section boundaries.
cvpw analyze --bpm-range 55,70                 # only if the plot shows an octave error
cp analysis/sections_auto.json analysis/sections.json   # then fix boundaries by ear and by the plot
cvpw analyze                                   # re-run so the override is honoured
cvpw cues                                      # settle guesses onto measured onsets
cvpw lyrics                                    # LRC or plain text → timing (and text, if licensed)
cvpw lyrics --check                            # lyrics.alignment against measured vocal onsets
cvpw validate --all
```
The gate for this stage is `lyrics.alignment` (every line within ±150 ms of a detected vocal onset where
vocal activity exists) — see [`docs/QA.md`](../../../docs/QA.md) §2.

**Acceptance.**
1. `analysis/overview.png` exists and an agent has **looked at it**. Reading the JSON is not reviewing the
   grid.
2. Tempo confidence is reported and `octaveCheck` is `ok`.
3. Every lyric line has a time within the declared tolerance of a detected vocal onset, where vocal
   activity exists.
4. Every cue has a `source` ∈ `measured | analysis | audit | initial | manual`; everything still `initial`
   is listed for the operator.
5. Sections are labelled, and any manual override lives in `analysis/sections.json`, not in the derived
   `audio.json`.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| Beats look doubled or halved on the plot | Octave error in tempo detection | `cvpw analyze --bpm-range 55,70` around the true half or double, then re-read the plot |
| Beat grid drifts late | Constant-tempo assumption on a live take | Confirm `beats[]` comes from tracking, not `n·60/bpm`; if the source has real rubato, report it as a known limitation |
| Every lyric line is early | Word timings taken from ASR | Derive onsets from the vocal-band onset envelope; ASR word times run 40 ms–2 s early |
| Sections look wrong | No manual override | Author `analysis/sections.json`; analysis is a proposal, not a verdict |
| Cue list quietly lost a hand-set time | A tool overwrote a `manual` cue | `cvpw cues` MUST NOT modify `manual` cues — it reports them as skipped; if one moved, the cause is elsewhere |
| Analysis runs for minutes | Full transcription path | Not in step 1; official lyrics plus alignment only |

**If you must improvise.** `project.json::timebase.mode = "manual"` for a project with no audio (a silent
explainer). Every time is then a cue or absolute seconds, and `b()` / `h()` / `VOX()` throw — which is
correct: there is no grid to honour. **Checkpoint C2**: show the overview plot and the section labels.

## Stage 3 — Storyboard

**Purpose.** Decide **what** happens, in what order, and express it as data.

**Inputs.** `docs/BRIEF.md`, `analysis/audio.json`, `cues/cues.json`.

**Do.**
```bash
cvpw storyboard                                # timeline.json + docs/STORYBOARD.md + docs/BLOCKS.md
cvpw storyboard --blocks b01,b02,b03           # when you are partitioning a long film deliberately
cvpw storyboard --stats                        # timeline.pacing: holds, equality runs, chorus/verse contrast
cvpw validate --all
# THEN: register every seam in handoff.json BEFORE either side of it is written.
```
The gate flags here are `--timeline` (`timeline.coverage`, `timeline.moment`, `timeline.absoluteTimes`,
`timeline.pacing`) and `--contract`. Thresholds: [`docs/QA.md`](../../../docs/QA.md) §2.

**Acceptance.**
1. Every `at` resolves. A failure names the shot and lists the nearest valid alternatives.
2. Coverage is exactly `[0, duration)` — no gaps, no unowned overlaps.
3. Every shot has a `moment`: one sentence naming what the shot is *for*.
4. No shot uses a bare-number time without the warning having been acknowledged (`timeline.absoluteTimes`).
5. Durations respect the declared grammar (`timeline.pacing`): for a song, median chorus shot ≤ 0.75 ×
   median verse shot, at least three genuine holds ≥ 1.0 s, no run of more than six shots of equal length.
6. `docs/BLOCKS.md` partitions the film into blocks with **disjoint time ranges and disjoint files**, each
   with an entry state and an exit state. Where two blocks meet without an overlap and without a
   transition, a seam MUST be registered in `handoff.json` **before** either block is written.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| `unknown cue 'choru'` | Typo | The error lists near matches; fix the timeline, not the cue file |
| Coverage gap reported as `[4.0, 6.4)` | A shot was forgotten | Add the missing shot or extend a neighbour; never let the engine fill it |
| Every shot has the same duration | The storyboard was written as a table of equal rows | Re-read the sections and vary by section dynamics |
| Two blocks overlap in time with no designed transition | No partition discipline | Split the range, or register a seam, before authoring |
| A seam is discovered after both sides exist | Registered late | It is a rewrite of both sides. Register seams at this stage, always |
| A shot exists only to fill time | It has no honest `moment` sentence | Cut it or merge it; filler is what C3 exists to catch |

**If you must improvise.** Render an **animatic**: stills at every shot midpoint with placeholder scenes.
It reveals pacing problems before any scene is written, and it is the cheapest way to settle an uncertain
storyboard. **Checkpoint C3**: show the storyboard table (or its stills) before writing scenes in volume.

## Stage 4 — Assets

**Purpose.** Produce the non-code material the film needs, with provenance.

**Inputs.** `docs/CONCEPT.md`, `docs/STORYBOARD.md`, an asset job list, any generator.

**Do.**
```bash
# generation itself is phase 2 and MUST NOT be required by the core pipeline;
# in step 1 the command validates and reports.
cvpw assets                    # validate assets/manifest.json: on-disk presence, sha256, licence, source
cvpw assets --reindex          # after files were moved or renamed — never hand-edit the manifest
cvpw validate --all
cvpw stills --times <the times each asset first appears> --overlay   # then OPEN the frames
```
Gate: `assets.manifest` (every loaded asset is in the manifest, present on disk, `sha256`-verified, with a
`licence` and a `source`).

**Acceptance.**
1. Every asset the engine loads appears in the manifest, and every manifest entry exists on disk with a
   matching `sha256`.
2. Every asset has a `licence` and a `source`. Unknown provenance MUST fail — not warn.
3. Every image has been **looked at**, and the review is recorded in `review/report.json`.
4. Character consistency — the same character reads as the same character across poses — is stated as an
   explicit human judgement, not assumed.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| Green fringes on a keyed asset | Despill missing, or the key is too aggressive | Re-key with a two-colour edge model; keep the un-keyed `*.raw.png` |
| Character drifts across poses | No master reference | Generate every pose with the master image attached and a verbatim style block |
| Manifest and paths diverge | Manual file shuffling | `cvpw assets --reindex`; never hand-edit the derived manifest |
| An asset renders as a placeholder | The load silently failed | `assets.manifest` fails on a missing file; if it passed, look for a wrong `path` or a case mismatch |
| Asset generation blocks the whole pipeline | Generation was treated as REQUIRED | Keep it out of the critical path; a code-only film skips this stage entirely |

**If you must improvise.** A code-only film (procedural drawing, kinetic typography) needs no assets at all.
Set `assets: null` in `project.json` and this stage is skipped without a warning.

## Stage 5 — Build

**Purpose.** Write the scenes.

**Inputs.** `timeline.json`, `docs/BLOCKS.md`, `handoff.json`, the engine core, the styles.

**Do.**
```bash
cvpw validate                  # refuse to build on an invalid artifact
cvpw lint                      # baseline BEFORE you add to it
# ... write engine/scenes/*.js ; each new file needs one line in engine/scenes/manifest.js ...
cvpw lint                      # determinism.bannedApi, encoding.utf8, timeline.absoluteTimes, text.whitelist
cvpw validate --all            # args used in timeline.json validate against each scene's argsSchema
cvpw check --scenes --text     # load every scene/shot alone: pageerror, console.error, empty frames
cvpw stills --times 2.02,2.4,3.1 --shot b03_prism --overlay --out review/prism
# then OPEN review/prism/*.png. Look. Twice.
```
`cvpw lint` and `cvpw check` MUST report the same ids and the same verdicts for the four static checks
(`encoding.utf8`, `determinism.bannedApi`, `timeline.absoluteTimes`, `text.whitelist`). A check whose
answer depends on which command asked is worse than no check.

**Acceptance.**
1. `cvpw lint` clean: zero banned APIs, zero U+FFFD, zero invalid UTF-8, zero raw `1920`/`1080`
   arithmetic, no off-whitelist on-screen text.
2. `cvpw check --scenes` reports no `pageerror`, no `console.error`, no empty frames.
3. Every scene's `argsSchema` validates the args used in `timeline.json`; an unknown key is an error.
4. You touched only your own files. A needed shared change is a request recorded in
   `docs/INTEGRATION_NOTES.md`, with the requested signature.
5. Frame cost is measured and within `project.json::budgets.msPerFrame` — `scene.perf` p95, default 40 ms.
6. Each scene was rendered as stills and looked at **at least twice**, with the findings written down.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| Frames differ between workers | Unseeded randomness, wall-clock read, or state carried between frames | `cvpw lint`; if AST-clean, add `stateful: true` on the shot with `reset()` / `step()` |
| One-frame flicker at a join | `Math.floor(t*fps)` instead of `frameIndex(t)` | Use the helper; the two disagree exactly on frame boundaries |
| A seam fails after a shared edit | A shared value changed on one side only | Both sides read `handoff.json`; re-run `cvpw handoff` |
| A scene renders nothing at some `t` | Wrong active-interval logic | `cvpw check --scenes` reports empty frames; render the midpoint |
| A scene is 3× slower than it was | Unbounded particles, per-shape shadow blur, a full-screen filter per layer | Cache what is constant, cap particle counts, move the filter to the post chain |
| `unknown-key` on a scene arg | A typo became a candidate for a default | Fix the key in `timeline.json`; never relax `additionalProperties` |

**If you must improvise.** Extend an existing scene's `argsSchema` with a new property **and a default**
before writing a new scene. A new scene MUST be justified by a *new visual idea*, not a new parameter set.
An argument added without a default breaks every timeline that omits it.

## Stage 6 — Review

**Purpose.** Look at the film and fix it. This is where the quality comes from.

**Inputs.** A project that lints and checks clean.

**Do.**
```bash
cvpw stills --times <shot midpoints> --overlay --out review/stills
cvpw sheet  --from 0 --to <duration> --every <duration/24> --cols 4 --out review/sheet.jpg
cvpw sheet  --cues --offset 0.12 --out review/cues.jpg      # the single most useful image
cvpw review --mp4 render/mv_preview.mp4 --step 1.8 --out review/pass1
cvpw check --flash --only <block>          # safety on the section that just changed, NOT at the end
cvpw check --gold                          # prove untouched ranges did not move
# fix the worst THREE things, then go back to the top until a pass finds nothing new
```

**Acceptance.**
1. Contact sheets exist and an agent has read them.
2. For every shot that changed, three frames were inspected: the **first frame after the cut**, the **main
   event**, and the **last frame before the end**.
3. Every defect is recorded with a shot id and a time, and is either fixed or explicitly accepted.
4. `review/report.json` is populated: every image, its time, and the active shot ids at that time.
5. Safety (`flash.rate`) was measured on the section that just changed, not only at the end.
6. Untouched ranges still match the gold numerically.
7. Passes are repeated until one finds no new defects. Budget two to three passes.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| "Looks fine", with no image opened | Reviewing by inference | A review without a populated manifest has not happened. Re-run the loop |
| Fixes land, new defects appear elsewhere | A shared file was changed | Re-render the untouched ranges and compare **numerically** — `cvpw check --gold` |
| A pass finds nothing at all | The wrong frames were open: midpoints only | Use the three-frames rule, the per-cue sheet, and a full pass |
| A pass keeps finding new defects | More than three things are being changed at once | Fix three, re-review, repeat |
| Text is unreadable at speed | Too small, or not held long enough | Names ≥ 48 px at 1080p, readable ≥ 0.25 s, nothing under 6 px |
| The film is boring but technically clean | No attention at stage 1 or 3 | Not a render bug: revisit the holds, the escalation, the `moment` sentences |

**If you must improvise.** Review one block in isolation: `cvpw render --only b05` and
`cvpw check --profile all --only b05`. Far faster than a full pass, and it is the correct loop for a block
author. **Checkpoint C4**: show the first stills before paying for a full render.

## Stage 7 — Deliver

**Purpose.** Produce final files, prove they are correct, and report honestly.

**Inputs.** A reviewed project.

**Do.**
```bash
cvpw handoff --list "s02|s03"              # seam A|REF|B strips + numeric grades → handoff.report.json
cvpw render --name mv --workers 2          # frames → MP4 + render/report.json; deletes output on failure
cvpw check --profile render                # adds --frames, --av-sync, --handoff, --flash
cvpw check --profile deliver               # adds --assets, --publish; runs everything
cvpw deliver --variants master,vertical     # final checks, variants, delivery list
cvpw validate --all && cvpw lint            # compliance, one last time
```
Profiles: `all` (the default) runs the first seven gate flags; `render` adds the next four and requires a
rendered master; `deliver` runs everything. A gate that cannot run because its input does not exist yet
MUST be reported as `skipped` with the reason — never as a pass. `--only <block>` restricts every gate to
one block's time range. The flag-to-check-id mapping is in
[`docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7; the ids and thresholds are in
[`docs/QA.md`](../../../docs/QA.md) §2, and where the two disagree about an id, QA wins.

**Acceptance.**
1. The MP4 frame count equals `round(duration × fps)` (`render.frameCount`).
2. A/V mux lag ≤ 1 frame, measured by cross-correlating the decoded track against the source audio.
3. `cvpw check --gold` passes, or every mismatch has a dated entry in `qa/exemptions.json`.
4. All `pixel` handoffs grade `ok` or `minor`; any `ALIGN` is either fixed or exempted with a date, a
   reason, an observed delta and an owner.
5. Flash rate is within budget, measured per section.
6. Every variant (16:9 and 9:16) passes the same checks **independently**. A vertical variant is a layout,
   not a crop.
7. The credit line appears verbatim where it was promised.
8. The delivery report states what was **verified**, what is **uncertain**, and what was **not done**.

**What goes wrong**

| Symptom | Cause | Fix |
|---|---|---|
| An MP4 exists but is short | The encoder died mid-write and left a plausible file | The renderer MUST delete a failed output; verify the frame count before reporting success |
| Audio drifts late | `audio.offset` was applied by editing the audio | Apply the offset at mux time only; keep the source byte-identical |
| Two runs differ | GPU float rounding, or nondeterminism reaching the picture | `determinism.workerCount`; if the cause is environmental, record an exemption with a measured delta |
| The vertical variant clips text | Composed for 16:9 | Route positions through `engine/lib/layout.js`; never scale the master |
| A gate is green but nobody ran it | It was skipped and reported as a pass | A skipped gate is `skipped`, with the reason. Check the report, not the exit code alone |
| The render filled the disk | `peakDiskGb` not measured | `frames × measured_frame_bytes × 1.3 ≤ peakDiskGb ≤ 0.6 × free_space`; render `--only <block>` |

**If you must improvise.** `--preview` renders at half resolution with a fast encoder for the review
checkpoint. It MUST be named `*_preview.mp4` and MUST NOT be delivered as a master.

## Time budgets where input size dominates

These are **estimates from the reference machine**, not measurements of your project. They exist so you can
tell "slow" from "stuck". Replace each one with your own measurement the first time you run the stage, and
record the number in `docs/PROGRESS.md`.

| Stage | Scale | Estimate | What makes it wrong |
|---|---|---|---|
| 2 Timebase | 3–4 min master, numpy path | 10–60 s | The full transcription path is minutes and is out of scope for step 1 |
| 2 Timebase | same, with `librosa` | 1–3 min | Optional dependency; treat as an upgrade, not a default |
| 4 Assets | 20–40 generated images | 5–40 min, dominated by the generator's latency | A local generator is minutes; a hosted one is a network dependency (P8 forbids it at render time) |
| 7 Deliver, full render | 6,240 frames, 2 workers, GPU, 40 ms/frame | ~2 min of wall clock per 1,000 frames | Software renderer: roughly 10× slower. A `scene.perf` regression: linear in the offending shot's share |
| 7 Deliver, full render | 6,240 frames, 1 worker | 2× the two-worker figure, then worse if `--workers` exceeds the cap | See [03-parallel-work.md](./03-parallel-work.md) on the concurrency cap |
| 6 Review, one pass | full film, `--step 1.8` | minutes | Stills and sheets are seconds; the full pass is the expensive one |

Rules of thumb that survive contact: **still and sheet checks are seconds — run them constantly; a render
is minutes — run it deliberately; an encode is where a plausible wrong answer is produced — verify it.**
Write the real numbers into `render/report.json` (they land there automatically) and read
`msPerFrame.p95` before quoting any budget.

Next: [02-principles.md](./02-principles.md) for the reasoning, [05-troubleshooting.md](./05-troubleshooting.md)
when a stage fails.
