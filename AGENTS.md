# AGENTS.md — start here

**For any coding agent, on any platform.** Human entry point: [`README.md`](./README.md).
Chinese mirror: [`AGENTS.zh-CN.md`](./AGENTS.zh-CN.md).

This repository is a **framework**, not a film. You are usually here for one of two jobs:

| Your job | Start at | Then |
|---|---|---|
| **A. Make a video** using this framework | §3 Quickstart | [`skills/cvpw/SKILL.md`](./skills/cvpw/SKILL.md) |
| **B. Extend the framework** (new scene, style, artifact, check, tool) | [`docs/EXTENDING.md`](./docs/EXTENDING.md) | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| **C. Work inside a project** someone already scaffolded | that project's `docs/BRIEF.md` | that project's `docs/PROGRESS.md`, then §4 below |

If you are unsure which you are doing, you are doing **A** or **C**. Extending the framework is a
decision, never a default — and it is never the way to solve a project problem.

---

## 1. Authority order (resolve conflicts top-down, stop if you cannot)

```
1. docs/SPEC.md                 the constitution — wins over everything
2. docs/CONTRACTS.md            artifact + time-vocabulary definitions
3. schemas/*.schema.json        machine-readable form of (2)
4. docs/WORKFLOW.md  docs/QA.md  docs/EXTENDING.md   procedure (normative)
5. project.json                 the knobs of the project you are in
6. generated artifacts          analysis/  cues/  timeline.json  reports/
7. code                         engine/  scenes/  tools/
8. prose docs                   README  AGENTS  ARCHITECTURE  ENVIRONMENT  BRIEF  STORYBOARD  notes
```

**Normative versus descriptive.** Levels 1–4 are *normative*: if code disagrees with them, the code is
wrong. Levels 5–7 are factual records of a particular project. Level 8 is *descriptive*: if a prose doc
disagrees with code, fix the **doc** in the same change. `ARCHITECTURE.md` and `ENVIRONMENT.md` sit at
level 8 deliberately — they explain and measure, they do not legislate. Never silently trust one side.
If you cannot tell which level applies, **stop and ask**.

---

## 2. The twelve rules that matter most

Read these before touching anything. Each one exists because a specific failure was observed in
practice — the parenthesised references point at the reasoning.

1. **A frame is a pure function of `t`.** No `Math.random`, `Date.now`, `new Date`, `performance.now`,
   `crypto.getRandomValues`, `requestAnimationFrame`, `setTimeout`, or stored state between frames.
   All randomness comes from `@cvpw/kernel`'s seeded generators. (`docs/SPEC.md` D1–D3)
2. **Never hand-type a time.** Use a time expression — `"b(32,0)"`, `"cue('chorus')"`,
   `"VOX('sudden')"`, `"L(12)"`. A reference the timebase cannot support is an **error**, and that is
   the point. If it throws, fix the music analysis or the storyboard — never the expression.
   (`docs/SPEC.md` T2–T3)
3. **`bpm` is a label, not a grid.** Derive cuts from measured `beats[]`/`bars[]`, never from
   `n * 60 / bpm`. Tempo drifts. (`docs/SPEC.md` T4–T5)
4. **A time that is neither on the grid nor a cue id does not belong in code.** Register it as a cue,
   with a `source`. (`docs/SPEC.md` T8)
5. **Unknown artifact keys are rejected and unresolved times throw.** That is deliberate. Do not add a
   fallback, do not catch-and-default, do not "make it work". If you are tempted, re-read rule 2: every
   silent fallback in the prior art cost someone a day.
6. **Look at every result.** Render stills, read the PNGs, critique like an art director, fix, repeat.
   Do not trust that code "should" look right. A review with no manifest in `review/report.json` is not
   a review. (`docs/SPEC.md` V1–V3)
7. **Blocks have one owner and disjoint files.** Shared files — `engine/core`, `engine/lib`,
   `timeline.json`, `handoff.json`, styles, `project.json` — belong to the integrator. If you need a
   shared change, request it and record the request in `docs/INTEGRATION_NOTES.md`. Do not make it.
   (`docs/SPEC.md` S1–S2)
8. **Write to disk early, and keep a progress log.** Long runs get interrupted. On takeover: read what
   is on disk and run the relevant check **before** re-running anything. (`docs/SPEC.md` S3)
9. **Every deviation gets written down** in `docs/PROGRESS.md` with a reason. An undocumented deviation
   is indistinguishable from a bug, and the next agent will either repeat it or "fix" your deliberate
   decision. (`docs/SPEC.md` §10)
10. **Strict beats permissive, everywhere.** Even dimensions, valid UTF-8 without BOM, LF endings,
    labels inside the safe area, text only from the whitelist, a `moment` on every shot. These are
    cheap now and expensive later. (`docs/SPEC.md` A1, C3, C6–C8)
11. **Measure, do not guess.** Frame cost, flash rate, audio/video lag, seam delta — report the number
    and where it came from. Thresholds live in `docs/QA.md` or `project.json::budgets`; never invent one
    inside code. (`docs/SPEC.md` V5)
12. **Prefer a documented exemption to a silent tolerance.** A waiver needs a date, a reason and an
    owner, and it appears in the delivery report. Never "retry until it passes". (`docs/SPEC.md` V6)

---

## 3. Quickstart — make a video

```bash
cvpw doctor                                   # what this machine can and cannot do. READ IT.
cvpw new ../my-film --song song.wav --lyrics lyrics.txt
cd ../my-film
```

Then follow the eight stages. **Stop at every checkpoint and show a human something.**

```
Stage 0  Setup        cvpw doctor ; cvpw validate
Stage 1  Brief        write docs/BRIEF.md, docs/CONCEPT.md, project.json::textWhitelist
                                                                        ◆CHECKPOINT: brief in ~6 lines
Stage 2  Timebase     cvpw analyze  →  LOOK at analysis/overview.png
                      cvpw cues ; cvpw lyrics                            ◆CHECKPOINT: overview + sections
Stage 3  Storyboard   cvpw storyboard  →  timeline.json + docs/STORYBOARD.md
                      register seams in handoff.json BEFORE writing blocks
                                                                        ◆CHECKPOINT: storyboard table
Stage 4  Assets       cvpw assets (validates a manifest; generation is phase 2)
Stage 5  Build        write scenes → cvpw lint ; cvpw check --scenes --text
Stage 6  Review       cvpw stills --overlay ; cvpw sheet --cues ; LOOK AT EVERY IMAGE
                                                                        ◆CHECKPOINT: first stills
Stage 7  Deliver      cvpw handoff ; cvpw render ; cvpw check --profile deliver ; cvpw deliver
```

Detail, acceptance criteria and failure modes per stage: [`docs/WORKFLOW.md`](./docs/WORKFLOW.md).

**Stage 2 is where projects are won or lost.** Open `analysis/overview.png` and actually read it —
waveform, energy, beat rulers, section boundaries. An octave error in the tempo (beats at double or half
the true rate) is the most common analysis failure and is obvious on the plot and invisible in the JSON.

---

## 4. Working inside a project

Read, in this order: `docs/BRIEF.md` → `docs/CONCEPT.md` → `docs/BLOCKS.md` → `docs/PROGRESS.md` →
`docs/INTEGRATION_NOTES.md`. That sequence tells you the intent, the partition, what is already done,
and what has already been argued about. Skipping it is how two agents do the same work twice.

Before you write:

- `cvpw validate` — refuse to build on an invalid artifact.
- `cvpw lint` — know the baseline before you add to it.
- Find your block in `docs/BLOCKS.md`. Your files are the ones it lists. Nothing else is yours.

While you write:

- Keep a per-block progress log from the first commit.
- Render only your own range: `cvpw render --only <block>`, `cvpw stills --times ... --shot <id>`.
- Add a `moment` to every shot you create. One sentence: what is this shot *for*.

Before you claim done:

- `cvpw lint` clean, `cvpw validate --all` passes.
- `cvpw check --scenes` reports no errors and no empty frames.
- You have **looked** at stills — first frame after each cut, the main event, the last frame before
  each end — at least twice, and written down what you saw and what you changed.
- Untouched ranges still match numerically (`cvpw check --gold`). Your change must not have restyled
  someone else's work.

---

## 5. Skills

The framework's agent-facing capability ships as portable skill bundles: a directory with `SKILL.md`
(YAML frontmatter, `name` + `description` only), `references/`, and `scripts/` that are documented shims
over `cvpw`. They work with no Node project present — a shim can print the command instead of running it.

| Skill | Use when |
|---|---|
| [`skills/cvpw`](./skills/cvpw/SKILL.md) | Any video production work. The eight stages, principles, checkpoint discipline, parallelisation and ownership rules. |
| [`skills/cvpw-timing`](./skills/cvpw-timing/SKILL.md) | Audio into a timebase; lyric timing; cue curation with provenance; anything where "when" is the question. |
| [`skills/cvpw-qa`](./skills/cvpw-qa/SKILL.md) | Gates, thresholds, the review loop, the failure-mode catalogue, the delivery checklist. |

**Installing them into your platform:**

- A platform with a skills directory (e.g. `~/.claude/skills/`): copy or symlink the bundle directory.
- A platform with no skill support: read `SKILL.md` directly — it is plain Markdown plus scripts. This
  file plus the skill's references are sufficient.
- `cvpw skill install --target <claude|dsh|generic>` performs the copy and prints the resulting paths.

If a `SKILL.md` `description` does not match your task, read `references/` anyway before concluding the
skill is irrelevant — the skill knows which of its references matter, and you do not yet.

---

## 6. Commands

Every command: `--json` prints one JSON envelope on stdout; logs go to stderr; exit codes are
**0** ok, **1** check failed, **2** bad usage, **3** contract violation.

| Command | What it does |
|---|---|
| `cvpw doctor` | Machine readiness. REQUIRED vs OPTIONAL, with the cost of each gap. Probes the browser's real WebGL renderer and probes hardware encoders **by attempting an encode**. |
| `cvpw env` | Resolved external tool paths and versions. |
| `cvpw new <dir>` | Scaffold a project from `templates/project`. Refuses a non-empty directory without `--force`. |
| `cvpw validate [--all]` | JSON Schema validation of every artifact. |
| `cvpw analyze` | Audio → `analysis/audio.json` + `envelope.json`/`.f32` + `overview.png`. |
| `cvpw cues` | Settle cue guesses onto measured onsets. Never overwrites a `manual` cue. |
| `cvpw lyrics` | LRC or plain text → lyric timing (and text, if it is being kept). |
| `cvpw storyboard` | `timeline.json` + `docs/STORYBOARD.md`; resolves every time expression; checks coverage. |
| `cvpw assets` | Validate `assets/manifest.json` (generation is phase 2). |
| `cvpw stills` / `sheet` / `review` | Review artifacts. `--overlay` burns in time, frame and active shot ids so a defect maps to a shot. |
| `cvpw render` | Frames → MP4 + `render/report.json`. `--workers`, `--only`, `--preview`. |
| `cvpw check` | The gate suite. Twelve gate flags (`--contract`, `--determinism`, `--timeline`, `--scenes`, `--text`, `--lyrics`, `--frames`, `--av-sync`, `--handoff`, `--flash`, `--assets`, `--publish`) against twenty-four check ids; `--profile all\|render\|deliver` selects how far it goes; `--only <block>` restricts it to one block's range. Thresholds come from `docs/QA.md` and `project.json::budgets`, never from a flag. |
| `cvpw lint` | Static audit: banned APIs (AST-based), encoding, absolute times, layout literals, text whitelist. |
| `cvpw handoff` | Seam `A\|REF\|B` strips and numeric grades → `handoff.report.json` (the contract `handoff.json` is authored, never written by a tool). |
| `cvpw deliver` | Final checks, variants, delivery list. |
| `cvpw skill install` | Install a skill bundle into a platform. |

---

## 7. What to do when something is wrong

| Situation | Do this |
|---|---|
| A time expression throws | The timebase genuinely lacks that moment. Fix the analysis, the cue list, or the storyboard. **Never** replace it with a literal. |
| A gate fails | Read the offenders in `--json` output. Investigate the cause. Do not retry, and do not widen the threshold in code. |
| You need a threshold changed | Change `project.json::budgets` or `docs/QA.md`, and say why in `docs/PROGRESS.md`. |
| You need to touch a shared file | You probably do not. Record a request in `docs/INTEGRATION_NOTES.md`; if you are the integrator, do it and say so. |
| The picture is boring but the checks pass | This is not a render bug. Revisit stage 1 or 3 — the holds, the escalation, the `moment` sentences. |
| A render produced nothing / a suspiciously small file | The renderer must delete its output on failure. Check `render/report.json` for `errors` before believing any file. |
| You inherited an interrupted block | Read the block's progress log, run `cvpw check --only <block>`, and only then continue. |

---

## 8. Language and encoding

- **English is normative** for `docs/SPEC.md`, `docs/CONTRACTS.md`, schemas, code and commits.
  Human-facing entry documents ship a Chinese mirror; a drifting mirror is a bug in the mirror.
- **UTF-8 without BOM, LF endings, everywhere.** The reference machine's console code page is 936,
  which will happily mangle your output. Python file handles specify `encoding="utf-8"`, the CLI sets
  `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` when spawning Python, generated Windows helpers run
  `chcp 65001`, and temp paths handed to external processes are **ASCII-only**.
  `cvpw lint` scans for U+FFFD and for bytes that are not valid UTF-8.
  ([`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md), ADR 0005)
- **Do not commit media or lyric text by default.** Audio and lyric inputs are the user's property.
  Lyric *timing* is committable; lyric *text* is not, unless the project declares it licensed.
  (`docs/SPEC.md` T7)
