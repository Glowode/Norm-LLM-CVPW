# 01 — The gate book

Every check id, what it measures, its default threshold and where that number comes from, how to run it
alone, what a failure looks like in the output, and what to do about it.

**Sources of truth**: the gate table is [`../../../docs/QA.md`](../../../docs/QA.md) §2; the flag→check-id
mapping is [`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7; the report row shape is
[`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §10. Where any of them disagree about an id or a
threshold, [`../../../docs/QA.md`](../../../docs/QA.md) wins — and the disagreement is a bug worth
reporting.

Every row below carries `{ id, threshold, observed, ok, offenders[] }` in `qa/report.json::checks`, and a
waiver, when present, adds `waivedBy` ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) V2). `offenders` are
the tokens that name a shot or a time, so a defect maps to a place without guessing.

---

## `--contract`

```bash
cvpw validate --all --json        # contract.validate
cvpw check --contract --json      # all four ids in this block
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `contract.validate` | Every artifact validates against its schema; 0 unknown keys; `$schema` + `schemaVersion` present. | 0 violations ([QA](../../../docs/QA.md) §2) | `unknown-key <ptr>`, `schema-version`, `missing-artifact` | no |
| `encoding.utf8` | 0 BOM, 0 CRLF, 0 U+FFFD, 0 bytes that are not valid UTF-8, LF endings. | 0 ([QA](../../../docs/QA.md) §2, [SPEC](../../../docs/SPEC.md) A1/P4) | `bom`, `crlf`, `u-fffd`, `invalid-utf8` | no |
| `determinism.bannedApi` | Occurrences of `Math.random`, `Date.now`, `new Date`, `performance.now`, `crypto.getRandomValues`, `requestAnimationFrame`, `setTimeout` in the frame-drawing path, found by AST analysis. | 0 ([SPEC](../../../docs/SPEC.md) D2) | `banned-api <name>@<file>:<line>` | no |
| `text.whitelist` | On-screen strings outside `project.json::textWhitelist`. | 0 ([SPEC](../../../docs/SPEC.md) C6) | `unlisted-text <string>@<shotId>` | no — edit the whitelist with a reason |

**A failure looks like**: `cvpw validate` exits 1 with `unknown-key /timeline/shots/3/args/huee` — note the
pointer, because unknown keys are rejected on purpose and the key that was meant is usually one character
away. Encoding failures show the *offset*, not the line: a `bom` at byte 0, `crlf` throughout, or `u-fffd`
at the one place a console handle mangled the text.

**What to do**:

- Unknown key → fix the typo. Do not add the key to the schema; `additionalProperties: false` exists
  precisely because a misspelled key falling back to a default has cost every project that tried this a day
  or more.
- Encoding → find the **handle** that wrote the file, fix the handle, and regenerate the artifact from its
  inputs. Never repair mojibake by re-typing the text; two of three repair attempts produce valid UTF-8
  that says the wrong thing ([`../../../docs/ENVIRONMENT.md`](../../../docs/ENVIRONMENT.md) §6).
- Banned API → seed from the kernel's generators, keyed on `frameIndex(t)` or an explicit string. If the
  scene genuinely simulates, declare `stateful: true` with `reset()`/`step()` on the **shot**, not the
  scene ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) D3).
- Unlisted text → either the string belongs on screen (add it to `textWhitelist`, with a reason in
  `docs/PROGRESS.md`) or it does not (remove it). An empty whitelist is legal and means "this film puts no
  text on screen", which is a stronger statement than an absent key.

---

## `--determinism`

```bash
cvpw check --determinism --json
cvpw check --gold --json                                   # just determinism.gold
cvpw check --gold --update-gold                            # only for the three legitimate reasons
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `determinism.gold` | Recomputed frame hashes at the declared times, compared with `qa/gold.json`. | exact ([QA](../../../docs/QA.md) §3, "Gold frames: exact, by default") | `gold-mismatch <t> <delta>` | yes ([SPEC](../../../docs/SPEC.md) D8) |
| `determinism.workerCount` | Identical frame hashes for `--workers 1` and `--workers 3` on the same times. | identical ([QA](../../../docs/QA.md) §2) | `worker-divergence <t>` | no |

**A failure looks like**: `gold-mismatch 4.0` — the time, and the observed delta. A hash has no partial
credit, so either the change is real or the environment moved. `worker-divergence` names the time where two
worker counts disagreed, which is the single most diagnostic line in the whole report: it means a frame
depends on something other than `t`.

**What to do**:

- `worker-divergence` → run `cvpw lint`. If the AST is clean, the scene carries state: declare
  `stateful: true` and expose `reset()`/`step()`. Never "fix" it by pinning `--workers 1`; that hides the
  defect and the same scene will flicker in a parallel render.
- `gold-mismatch` on times you did not mean to touch → a shared-file edit changed someone else's work.
  Revert or fix; do not update the gold.
- `gold-mismatch` on times you did mean to change → the three legitimate update conditions in
  [`../../../docs/QA.md`](../../../docs/QA.md) §5 apply. Before `--update-gold`: render the affected frames,
  **look at them**, compare with the previous gold's frames, and write the reason in the commit message and
  `docs/PROGRESS.md`.
- Environment drift → record the observed delta in `qa/exemptions.json` as well; a gold update alone does
  not document a driver or browser change.

---

## `--timeline`

```bash
cvpw storyboard --json
cvpw check --timeline --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `timeline.coverage` | Coverage of exactly `[0, duration)`; 0 gaps; 0 overlaps not owned by a `transition`. | exact ([SPEC](../../../docs/SPEC.md) C1–C2) | `gap [t0,t1)`, `unowned-overlap`, `beyond-duration` | no |
| `timeline.moment` | Every shot declares a non-empty one-sentence `moment`. | all shots ([SPEC](../../../docs/SPEC.md) C3) | `missing-moment <shotId>` | no |
| `timeline.absoluteTimes` | Every bare-number time is emitted as a warning and each warning is acknowledged. | all acknowledged ([SPEC](../../../docs/SPEC.md) T2) | `absolute-time <shotId> <value>` | yes (acknowledgement recorded) |
| `timeline.pacing` | For a song: median chorus shot ≤ 0.75 × median verse shot; ≥ 3 genuine holds ≥ 1.0 s; no run of > 6 shots of equal length. | those numbers ([QA](../../../docs/QA.md) §2) | `equal-durations`, `too-few-holds`, `no-contrast` | yes |

**A failure looks like**: `gap [4.0,6.4)` names the exact hole, and the fix is a missing shot or an
extended neighbour — never letting the engine fill it. `missing-moment s07_door` is the cheapest possible
defence against filler, and it is also the best prompt you will get: writing the sentence often reveals
that the shot has no reason to exist. Pacing failures come back as a list of equal-duration runs, which is
what a storyboard written as a table of equal rows looks like from the inside.

**What to do**:

- Gap or unowned overlap → fix the storyboard. If two shots genuinely overlap, the **later** one MUST own
  the transition.
- Missing `moment` → write one sentence naming what the shot is *for*. If you cannot, delete the shot.
- Absolute time → replace it with a time expression. If the grid does not contain the moment, register a
  cue ([`../../cvpw-timing/references/03-cue-curation.md`](../../cvpw-timing/references/03-cue-curation.md)),
  never keep the literal.
- Pacing → this is a Stage 1/Stage 3 problem, not a render bug. Re-read the sections and vary by section
  dynamics; add the genuine holds a song needs.

---

## `--scenes`

```bash
cvpw check --scenes --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `scene.errors` | `pageerror` and `console.error` while loading and rendering every scene alone. | 0 of each ([WORKFLOW](../../../docs/WORKFLOW.md) stage 5) | `pageerror <shotId>`, `console-error <shotId>` | no |
| `scene.emptyFrames` | Sampled times with no active shot. | 0 ([WORKFLOW](../../../docs/WORKFLOW.md) stage 5) | `empty-frame <t>` | no |
| `scene.perf` | `msPerFrame.p95` against the project's per-frame budget. | ≤ `project.json::budgets.msPerFrame`, default 40 ms ([QA](../../../docs/QA.md) §2.1) | `slow-shot <shotId> <ms>` | yes |

**A failure looks like**: `pageerror s05_glass` with the browser's own message — read the message, not just
the id. `empty-frame 61.2` means the scene's active-interval logic is wrong (it exits before its shot
starts, or starts after). `slow-shot s09_particles 118` names the shot and the p95 in milliseconds.

**What to do**:

- `pageerror` / `console-error` → fix the scene. These are never acceptable; a console error in a render is
  an unhandled branch that will behave differently on the next machine.
- `empty-frame` → fix the interval, then add the shot's first and last frame to the stills set for the next
  review pass. A one-time sample that coincides with real content can miss this class entirely, which is
  why `render.noDeadFrames` exists separately.
- `slow-shot` → cache what is constant, cap particle counts, move a full-screen filter into the post chain.
  Never raise `budgets.msPerFrame` to silence it; raise it only to a *measured* value with a reason.

---

## `--text`

```bash
cvpw check --text --json
cvpw stills --times <t> --overlay          # the visual half of the same question
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `text.safeArea` | Every on-screen text box inside the declared `safe` inset and clear of the subtitle band. | per `project.json::output.safe` / `subtitleBand` ([SPEC](../../../docs/SPEC.md) C8) | `safe-area <shotId> <edge>`, `subtitle-band <shotId>` | yes |
| `text.legibility` | Names ≥ 48 px at 1080p; readable ≥ 0.25 s before leaving; any text < 6 px replaced or dropped. | 48 px / 0.25 s / 6 px ([QA](../../../docs/QA.md) §3) | `small-text <shotId> <px>`, `short-hold <shotId> <s>` | yes |

**A failure looks like**: `safe-area s03_title bottom` — the edge is named because "outside the safe area"
is not actionable and "2 px below the bottom inset" is. `small-text s11_credit 4` is text that is
technically drawn and physically unreadable; it also makes `text.whitelist` unenforceable in practice,
because nobody can read what is on screen.

**What to do**:

- Safe area → route the position through `engine/lib/layout.js`. The failure is almost always raw
  `1920`/`1080` arithmetic, which is also exactly what breaks the vertical variant
  ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) C7).
- Subtitle band → move the text out. The band exists because the lyric layer will occupy it; text that
  collides with it is unreadable for the whole duration of the lyric.
- Legibility → ≥ 48 px for names, ≥ 0.25 s of readable time, replace anything under 6 px. Overlay a still
  and **look** — the number passing while the picture is unreadable means the check is measuring the wrong
  box.

---

## `--lyrics`

```bash
cvpw lyrics --check --json
cvpw check --lyrics --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `lyrics.alignment` | Every lyric line's start against a detected vocal onset, where vocal activity exists. | **±150 ms** ([QA](../../../docs/QA.md) §2.1) | `lyric-early <line> <ms>`, `lyric-late <line> <ms>` | yes |

**A failure looks like**: `lyric-early 12 240` — line 12 is 240 ms early. A *systematic* offset across
every line is a different defect from a scattered one, and the report row's `observed` value is where you
say which: put the median and the IQR there, not just the worst line.

**What to do**: see [`../../cvpw-timing/references/02-lyric-timing.md`](../../cvpw-timing/references/02-lyric-timing.md).
The short version: derive onsets from the vocal-band onset envelope, never from speech-recognition word
timestamps (they run 40 ms–2 s early), fix a constant offset as a constant, and mark hand-corrected lines
manual so the next analysis run cannot overwrite them. A waiver here means the film shows the wrong words
at the wrong moment — it needs a reason a viewer would accept.

---

## `--frames`

```bash
cvpw check --frames --json                 # needs a rendered master
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `render.frameCount` | MP4 frame count against the expected count from duration and fps. | **==** `round(duration × fps)` ([QA](../../../docs/QA.md) §2) | `frame-count <observed> != <expected>` | no |
| `render.noDeadFrames` | A full-rate, low-resolution pass over **every** frame of the master, comparing consecutive frames: something must change in every 0.5 s window. | 0 dead windows ([QA](../../../docs/QA.md) §2) | `dead-window [t0,t1)` | yes |

**`render.noDeadFrames` is not redundant with `scene.emptyFrames`.** The scene check samples at named
times; the dead-frame check sees the frame *between* two sample points where nothing at all is drawn. It
costs one decode pass and MUST NOT be skipped on a delivery candidate
([`../../../docs/QA.md`](../../../docs/QA.md) §2).

**A failure looks like**: `frame-count 6238 != 6240` — two frames short. That is a render that died
mid-write and left a plausible file, not a rounding question
([`../../../docs/SPEC.md`](../../../docs/SPEC.md) P6). `dead-window [41.0,41.5)` names a half-second where
the picture is frozen; sometimes that is a deliberate hold, and then it needs a waiver with a reason.

**What to do**: check `render/report.json::errors` before believing any file. Re-render; if it fails again,
that is a defect to find, not a run to repeat. For a dead window, look at the frames — a hold that reads as
intentional is a waiver, a hold that reads as a stall is an edit.

---

## `--av-sync`

```bash
cvpw check --av-sync --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `av.sync` | The decoded audio track cross-correlated against the source audio, reported as a mux lag. | ≤ **1 frame** (33.3 ms at 30 fps) ([QA](../../../docs/QA.md) §2.1) | `av-lag <ms>` | yes |

**A failure looks like**: `av-lag 96`. Below one frame the error is not expressible in the output; above it,
a lip or a beat visibly lands late — and for a music video *every* cut is a lip.

**What to do**: the cause is almost always that the offset was applied by **editing the audio file** rather
than at mux time. Restore the source byte-identically, apply `audio.offset` with `-itsoffset`/`adelay`, and
re-mux. If the source file's hash changed, that is the defect
([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §2).

---

## `--handoff`

```bash
cvpw handoff --list "s07|s08" --json       # writes handoff.report.json
cvpw check --handoff --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `handoff.pixel` | Mean absolute difference between A's last frame and B's first frame at a `pixel` seam, measured with **grain disabled**. | `< 0.03` passes; `< 0.01` is `ok` ([QA](../../../docs/QA.md) §3) | `ALIGN <seamId> <diff>` | yes |

Bands: `< 0.01` **ok** (below visibility), `0.01–0.03` **minor** (grain, dither or antialiasing rather than
a misplaced object — acceptable, not worth chasing), `≥ 0.03` **ALIGN** (something is genuinely
misaligned and a viewer sees the frame jump).

**A failure looks like**: `ALIGN s07|s08 0.041`. Two causes account for nearly all of them: a seam that
fails only with grain on (the contract is wrong — grain makes two frames at different times differ across
the whole screen), or a shared value changed on one side only.

**What to do**: re-read the shared `contract` in `handoff.json`; both sides MUST import and read it, and
neither may hard-code the values ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) C4). Re-run
`cvpw handoff` after the fix. A waiver needs the observed diff and a specific cause, not "close enough".

---

## `--flash`

```bash
cvpw check --flash --only <block> --json   # measure the section you just finished
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `flash.rate` | Large-area luminance round-trips per 1 s window; saturated red weighted (`R/(R+G+B) ≥ 0.8`); tear/stripe patterns held ≥ 6 frames counted as patterns, not flashes. | ≤ **3** per 1 s window ([QA](../../../docs/QA.md) §3, WCAG 2.3.1) | `flash <t> <n>/s`, `red-flash <t>`, `tear-pattern <t>` | **no** |

**A failure looks like**: `flash 61.2 4/s` — four round-trips inside one second, starting at 61.2 s. This is
a **hard gate, not an aesthetic preference** ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) V7), and the
QA row marks it unwaivable.

**What to do**: reduce the count by holding a level rather than pulsing to it, and prefer brightness
achieved by a sustained lift over a strobe. **Measure when the section is finished, not at the end**: a
flash problem discovered after the master is delivered is a re-encode, not an edit
([`../../../docs/QA.md`](../../../docs/QA.md) §4).

---

## `--assets`

```bash
cvpw assets --json
cvpw check --assets --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `assets.manifest` | Every loaded asset is in `assets/manifest.json`, present on disk and `sha256`-verified; every entry has a `licence` and a `source`. | all of them ([WORKFLOW](../../../docs/WORKFLOW.md) stage 4) | `asset-missing`, `sha256-mismatch`, `no-licence`, `no-source` | no |

**A failure looks like**: `sha256-mismatch assets/char/hero_master.png` — the file changed under the
manifest, which means the film's look changed without a review. `no-licence` is a legal defect, not a
bookkeeping one.

**What to do**: re-run `cvpw assets --reindex`; never hand-edit the manifest. Undefined provenance fails on
purpose — an asset nobody can account for cannot ship.

---

## `--publish`

```bash
cvpw deliver --json
cvpw check --publish --json
```

| id | What it measures | Default threshold (source) | Failure tokens | Waivable |
|---|---|---|---|---|
| `publish.lyricText` | Lyric text published without the project declaring it licensed. | 0 ([SPEC](../../../docs/SPEC.md) T7) | `lyric-text-unlicensed` | **no** |
| `deliver.credit` | `credit`, when non-empty, appears verbatim in the end card **and** in `README.md`. | verbatim ([CONTRACTS](../../../docs/CONTRACTS.md) §2) | `credit-missing`, `credit-mismatch` | **no** |

**A failure looks like**: `credit-mismatch` with both strings side by side — usually an en dash where the
artist's line has a colon, or a space added for looks. "Verbatim" means verbatim.

**What to do**: for lyric text, set `project.json::lyricsText` honestly. `"local-only"` makes the tool
refuse to include the text in a delivered artifact; `"licensed"` additionally requires `lyricsLicence` saying
who granted it and for what. This is not a formality — without it a lyric-video project cannot legally be
delivered at all, and the check must fail *before* the upload, not after.

---

## The static gates

Four ids are reachable **both** through `cvpw check` and directly as `cvpw lint`
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7,
[`../../../docs/QA.md`](../../../docs/QA.md) §2):

| id | Reported by `--contract`? | Reported by `--timeline`? |
|---|---|---|
| `encoding.utf8` | yes | — |
| `determinism.bannedApi` | yes | — |
| `text.whitelist` | yes | — |
| `timeline.absoluteTimes` | — | yes |

> **`cvpw lint` and `cvpw check` MUST report the same ids and the same verdicts for those four.** A check
> whose answer depends on which command asked is worse than no check.

Note the count: both normative documents say **four**. A summary that says "three static gates" is short by
one, and the one usually dropped is `timeline.absoluteTimes`, because it produces warnings rather than
errors — which is exactly why it needs the rule.

**How to verify agreement**, when you suspect the two paths have drifted:

```bash
cvpw lint  --json > lint.json
cvpw check --contract --timeline --json > check.json
# compare the four rows by id: threshold, observed, ok, offenders
```

Any difference is a tool bug. Report it rather than picking the answer you prefer — and note that
`cvpw lint` is the fast loop an author runs while writing, so its verdict is the one most people will see.

---

## `qa/exemptions.json`

Authored, seven required fields, and a missing one fails validation
([`../../../docs/QA.md`](../../../docs/QA.md) §5, [`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §10).

| Field | Type | What it must contain |
|---|---|---|
| `check` | string | The **check id** — not the flag. `handoff.pixel`, not `--handoff`. |
| `target` | string | What the exemption is scoped to: a seam id, a shot id, a time range, an artifact path. |
| `date` | string | `YYYY-MM-DD`. A waiver without a date cannot be aged or re-confirmed. |
| `reason` | string | The **cause**, with a mechanism. A reason that restates the check id fails validation — it carries no information. |
| `observed` | string | The value that failed, as measured, so a later reader can see whether it got better or worse. |
| `owner` | string | A person or role who owns the decision. "The team" is not an owner. |
| `expires` | string \| null | A date, or `null` meaning "until the project ends, and it will be restated in the delivery report". |

Worked example:

```jsonc
{ "$schema": "schemas/exemptions.schema.json", "schemaVersion": 1,
  "exemptions": [
    {
      "check": "handoff.pixel",
      "target": "s07_glass|s08_door",
      "date": "2026-01-20",
      "reason": "GPU float rounding in the sky gradient: 12 pixels differ by 1/255 between the two shots' independently rendered gradient bands; the geometry, camera and layer order are identical",
      "observed": "0.031",
      "owner": "integrator",
      "expires": "2026-02-20"
    },
    {
      "check": "lyrics.alignment",
      "target": "line 27",
      "date": "2026-01-22",
      "reason": "the line is spoken over a sustained chord with no measurable vocal onset; the timing was placed by ear at the breath",
      "observed": "lyric-late 27 310",
      "owner": "timing",
      "expires": null
    }
  ] }
```

Rules that bite:

- A waiver MUST appear in `qa/report.json::waived` and in the delivery summary **verbatim**.
- A waiver on a check whose QA row says "waiver allowed? **no**" is invalid. The remedy is to fix the thing
  or change the project (a declared inset, a whitelist entry, a licence statement).
- An expired waiver MUST be re-confirmed or removed. A project with more than a handful of non-expiring
  exemptions is a project whose gate set does not match its film — that is a finding worth reporting.

---

## Gates that cannot run yet

> **A gate whose input does not exist MUST be reported as `skipped`, with the reason — never as a pass.**

This is the rule that keeps a report honest while a project is half-built. `render.frameCount` cannot run
before a master exists; `av.sync` cannot run without a decoded track; `handoff.pixel` cannot run before the
seams are measured; `determinism.gold` cannot run before a gold file is committed. Each of those is
`skipped: <reason>`, which is a different fact from `ok: true` and must read differently in the report.

**How to recognise a project that has quietly skipped its way to a green report:**

| Tell | What it means |
|---|---|
| `qa/report.json::checks` has fewer rows than the profile's flag set implies | Gates were dropped, not skipped. |
| A row with `ok: true` and `observed` reading `n/a`, `-`, `skipped` or `0` | A skip wearing a pass. |
| `offenders: []` on a check whose input is demonstrably absent (no `render/report.json`, no gold) | The check did not run and said it passed. |
| `run.profile: "deliver"` on a report whose `run.startedAt` precedes the render | The profile was upgraded retroactively. |
| `--only <block>` output presented as a full-project result | The gates did run — over one block. |
| Every gate green on the first full pass of a project nobody has rendered | Suspicious by construction. |
| `waived: []` with several red rows in `checks` | Red rows were ignored rather than waived. |

The remedy is never to change the report. Make the input exist, or accept the skip and say so in the
delivery report's "not done" section — an honest uncertainty is worth more than a false pass
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 7).

---

Next: [`./02-review-loop.md`](./02-review-loop.md) for the half of the evidence that is not a number.
