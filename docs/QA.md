# QA — gates, thresholds, and the review loop

**Status:** normative (authority level 4 — [SPEC](./SPEC.md) §1).
**Companions:** [SPEC](./SPEC.md) §7 (V1–V7), [CONTRACTS](./CONTRACTS.md) §9–§10, [WORKFLOW](./WORKFLOW.md).
**Keywords** MUST, MUST NOT, SHOULD, MAY are RFC 2119.

## 1. Purpose and the two-part evidence rule

Every threshold any tool applies MUST live in this document or in `project.json::budgets`
([SPEC](./SPEC.md) V5). A tool MUST NOT invent a threshold, and a number that appears only inside
`packages/` is a bug: nobody can review it, and nobody can change it on purpose.

A stage is finished when it has produced **both** halves of the evidence ([SPEC](./SPEC.md) V1–V3):

1. **A numeric gate result.** Machine-readable (`--json`), with the check id, the threshold, the
   observed value, pass/fail, and the offending times or ids — written into `qa/report.json`
   ([SPEC](./SPEC.md) V2, [CONTRACTS](./CONTRACTS.md) §10). Undocumented success is not success.
2. **An agent that has looked at the images.** `cvpw review` writes `review/report.json` listing every
   image produced, the time it was taken, and the active shot ids at that time. An agent claiming a
   review without a populated manifest has not reviewed ([SPEC](./SPEC.md) V3).

Neither half is sufficient. A frame count proves the render finished, not that it is any good; an
opinion about a still proves nothing about the other 240 frames. Gates exist to make looking cheap and
honest — not to replace it.

The default thresholds below are **starting points**. A project MAY tighten or loosen any of them in
`project.json::budgets` (or by declaring a different value in a project-local note referenced from
`docs/PROGRESS.md`) **with a stated reason**. Changing a threshold without a reason is
indistinguishable from hiding a defect ([SPEC](./SPEC.md) §10 rule 5).

## 2. The gate table

`stage` is the [WORKFLOW](./WORKFLOW.md) stage that owns the gate. `failure names` are the tokens that
MUST appear in `qa/report.json::checks[].offenders` so a defect maps to a shot or a time without
guessing. `waiver allowed?` is answered in §6. Flags named in the `measured by` column are the contract
for `cvpw check` and its siblings: a named flag that does not yet exist is a missing tool, never a
reason to skip the check by hand.

| id | stage | threshold | measured by | failure names | waiver allowed? |
|---|---|---|---|---|---|
| `contract.validate` | 0,3,5,7 | every artifact validates against its schema; 0 unknown keys; `$schema` + `schemaVersion` present | `cvpw validate --all` | `unknown-key <ptr>`, `schema-version`, `missing-artifact` | no |
| `encoding.utf8` | 0,5 | 0 BOM, 0 CRLF, 0 U+FFFD, 0 bytes that are not valid UTF-8, LF endings | `cvpw lint` | `bom`, `crlf`, `u-fffd`, `invalid-utf8` | no |
| `determinism.bannedApi` | 5 | 0 occurrences in the frame-drawing path (`Math.random`, `Date.now`, `new Date`, `performance.now`, `crypto.getRandomValues`, `requestAnimationFrame`, `setTimeout`) | `cvpw lint` (AST) | `banned-api <name>@<file>:<line>` | no |
| `determinism.gold` | 7 | every frame hash equals `qa/gold.json` within the declared tolerance (default: exact) | `cvpw check --gold` | `gold-mismatch <t> <delta>` | yes ([SPEC](./SPEC.md) D8) |
| `determinism.workerCount` | 7 | identical frame hashes for `--workers 1` and `--workers 3` on the same times | `cvpw check --determinism` | `worker-divergence <t>` | no |
| `timeline.coverage` | 3 | coverage exactly `[0, duration)`; 0 gaps; 0 overlaps not owned by a `transition` | `cvpw storyboard`, `cvpw validate` | `gap [t0,t1)`, `unowned-overlap`, `beyond-duration` | no |
| `timeline.moment` | 3 | every shot declares a non-empty one-sentence `moment` | `cvpw storyboard` | `missing-moment <shotId>` | no |
| `timeline.absoluteTimes` | 3 | every bare-number time is emitted as a warning and each warning is acknowledged | `cvpw lint`, `cvpw storyboard` | `absolute-time <shotId> <value>` | yes (acknowledgement recorded) |
| `timeline.pacing` | 3 | for a song: median chorus shot ≤ 0.75 × median verse shot; ≥ 3 genuine holds ≥ 1.0 s; no run of > 6 shots of equal length | `cvpw storyboard --stats` | `equal-durations`, `too-few-holds`, `no-contrast` | yes |
| `lyrics.alignment` | 2 | every lyric line within **±150 ms** of a detected vocal onset where vocal activity exists | `cvpw lyrics --check` | `lyric-early <line> <ms>`, `lyric-late <line> <ms>` | yes |
| `scene.errors` | 5 | 0 `pageerror` and 0 `console.error` while loading and rendering every scene alone | `cvpw check --scenes` | `pageerror <shotId>`, `console-error <shotId>` | no |
| `scene.emptyFrames` | 5 | 0 sampled times with no active shot | `cvpw check --scenes` | `empty-frame <t>` | no |
| `scene.perf` | 5 | `msPerFrame.p95` ≤ `project.json::budgets.msPerFrame` (default 40 ms) | `cvpw check --scenes`, `render/report.json` | `slow-shot <shotId> <ms>` | yes |
| `render.frameCount` | 7 | MP4 frame count **==** `round(duration × fps)` | `cvpw check --frames` | `frame-count <observed> != <expected>` | no |
| `av.sync` | 7 | decoded-track cross-correlation lag ≤ **1 frame** (33.3 ms at 30 fps) | `cvpw check --av-sync` | `av-lag <ms>` | yes |
| `handoff.pixel` | 7 | mean-abs-diff **< 0.03** (and **< 0.01** is `ok`), grain disabled | `cvpw handoff` | `ALIGN <seamId> <diff>` | yes |
| `flash.rate` | 6,7 | ≤ 3 large-area luminance round-trips per 1 s window **OR** a photosensitivity warning on screen at the start | `cvpw check --flash` | `flash <t> <n>/s`, `red-flash <t>` | no — see below |
| `text.safeArea` | 5,6 | every on-screen text box inside the declared `safe` inset and clear of `subtitleBand` | `cvpw check --text`, `cvpw stills --overlay` | `safe-area <shotId> <edge>`, `subtitle-band <shotId>` | yes |
| `text.legibility` | 6 | names ≥ **48 px** at 1080p; readable ≥ **0.25 s** before leaving; any text < **6 px** replaced or dropped | `cvpw check --text` | `small-text <shotId> <px>`, `short-hold <shotId> <s>` | yes |
| `text.whitelist` | 5 | 0 on-screen strings outside `project.json::textWhitelist` | `cvpw lint` | `unlisted-text <string>@<shotId>` | no — edit the whitelist with a reason |
| `assets.manifest` | 4 | every loaded asset is in `assets/manifest.json`, present on disk, `sha256`-verified; every entry has `licence` and `source` | `cvpw assets` | `asset-missing`, `sha256-mismatch`, `no-licence`, `no-source` | no |
| `publish.lyricText` | 7 | 0 lyric text published unless the project declares it licensed | `cvpw deliver` | `lyric-text-unlicensed` | no ([SPEC](./SPEC.md) T7) |
| `render.noDeadFrames` | 7 | something changes in every 0.5 s window | `cvpw check --dead-frames` | `dead-window [t0,t1)` | yes |
| `render.frameContent` | 5,6 | every sampled frame has **> 0.0001** of its pixels differing from its own dominant colour | `cvpw check --scenes` | `frame-empty <t> <dominant>` | no |
| `deliver.credit` | 7 | `credit`, when non-empty, appears verbatim in the end card and in `README.md` | `cvpw deliver` | `credit-missing`, `credit-mismatch` | no |

**`render.frameContent` exists because its absence was expensive.** `scene.emptyFrames` counts sampled times
with *no active shot*, and `render.noDeadFrames` compares consecutive frames of the master. Neither asks
whether a frame contains anything. A shot that drew its subject in the colour of its own background — which
happened, and is written up in [PROGRESS](./PROGRESS.md) — has an active shot at every time, changes between
frames, and is completely black. It passed `cvpw validate`, a typecheck, and a render that wrote four
plausible PNGs, because every gate asked whether the film was *valid* and none asked whether it was
*visible*. This is that gate.

The measurement is deliberately crude: **content fraction**, the share of pixels differing from the frame's
own dominant colour by more than 10 of 765. A blank frame is one flat fill, so its dominant colour is the
whole frame and the fraction is 0. 0.0001 is about 200 pixels at 1080p — a 14×14 block — so a frame fails
only when it carries essentially nothing. It is set that low on purpose: a gate that fails a legitimate
title card would be routed around within a week and would then protect nothing. A frame between 0.0001 and
0.004 is reported as **thin** and never failed; composition quality is not a measurement's business, which
is what looking at the stills is for.

Measured on the canvas via `getImageData`, not from captured bytes: JPEG artefacts would make two identical
blank frames differ slightly, and a threshold carrying slack for that is exactly what this gate must not
have. This is a *visibility* check, so reading the canvas is the right instrument; `frameHash` still comes
from captured bytes, for the reason [ADR 0007](./adr/0007-warmup-frames-and-first-frame-instability.md) gives.

**`flash.rate` is two-tier, and the second tier is not a warning.** The budget is 3 large-area luminance
round-trips per second, with saturated red weighted more heavily because it is the most provocative frequency
for a photosensitive viewer. A film within budget passes and needs nothing.

A film that **exceeds** it is not rejected outright. That would be the wrong instrument: some genres genuinely
want a strobe, and the harm is preventable rather than inevitable. What the guideline actually requires is that
the audience is told before it starts. So an over-budget film passes **only if** it declares and displays a
photosensitivity caution:

```json
"accessibility": {
  "photoSensitivityWarning": {
    "text": "Photosensitivity warning: this film contains flashing images",
    "minDuration": 3,
    "atExpression": "0"
  }
}
```

The warning must (a) be the exact declared string, (b) be drawn within the film's opening moments, (c) be held
for at least `minDuration` seconds, and (d) therefore also pass `text.safeArea`. A declared warning that never
reaches the screen protects nobody, and the gate verifies it by instrumenting `fillText` rather than trusting
`project.json` — the declaration says what was intended, the screen says what happened.

Three failure codes, each naming what to do: `flash.no-warning` (over budget, nothing declared),
`flash.warning-missing` (declared but never drawn), `flash.warning-too-brief` (drawn, not long enough). A film
that exceeds the budget **and** warns is reported as `flash.warned` with its measured window, so the delivery
report states the exception rather than hiding it.

**Tear and stripe patterns are specified and not measured.** Detecting a stationary high-contrast grating needs
spatial frequency analysis; claiming it with a luminance scan would be a gate whose name promised more than it
checked. The limitation is printed in the measurement output, not buried in a comment.

**`render.noDeadFrames` is not redundant with `scene.emptyFrames`.** `scene.emptyFrames` samples
scenes at named times; `render.noDeadFrames` is a **full-rate, low-resolution pass** over every frame of
the master, comparing consecutive frames. It is the check that catches a frame between two sample
points where nothing at all is drawn — the gap that a sampled check structurally cannot see. It costs
one decode pass and MUST NOT be skipped on a delivery candidate.

**Gate flags versus check ids.** `cvpw check` takes gate *flags* (`--determinism`, `--frames`, …); each
flag runs one or more check *ids* from the table above. The mapping is defined once, in
[`docs/WORKFLOW.md`](./WORKFLOW.md) stage 7. `cvpw lint` is the same engine reached through the fast
path, and MUST agree with `cvpw check` on the four static ids it reports.

### 2.1 Where the numbers come from

| Threshold | Default | Why this number |
|---|---|---|
| `msPerFrame` | 40 ms | One frame per 40 ms per worker leaves headroom over the 33.3 ms of 30 fps, so a two-worker render on the reference machine finishes faster than real time. Tighten on a fast machine; loosen only to a measured value. |
| `peakDiskGb` | 5 | See §2.2. |
| `av.sync` | 1 frame | Below one frame the error is not expressible in the output; above it, a lip or a beat visibly lands late. |
| `flash.rate` | 3 per 1 s | See §3. |
| `text.legibility` | 48 px / 0.25 s / 6 px | See §3. |
| `handoff.pixel` | 0.03 / 0.01 | See §3. |
| `lyrics.alignment` | ±150 ms | Below ~100 ms a lyric line reads as early on the beat; above ~200 ms it reads as late against the vocal. Measured word onsets are the reference, not ASR timestamps ([WORKFLOW](./WORKFLOW.md) stage 2). |

### 2.2 The peak-disk budget rule

`project.json::budgets.peakDiskGb` MUST satisfy
`frames × measured_frame_bytes × 1.3 ≤ peakDiskGb ≤ 0.6 × free_space`. `frames` is
`round(duration × fps)`, and `measured_frame_bytes` comes from `render/report.json`, never from a
guess — measure one render, then set the budget.

On the reference machine (29.2 GB free, [ENVIRONMENT](./ENVIRONMENT.md) §3) the default 5 GB is
comfortable for an 8 s template render (240 frames) and for a 3½-minute song at 1080p30 (≈6,240
frames at 0.3–0.5 MB per JPEG frame ≈ 2.5 GB). It is not comfortable for 4K frames, which are roughly
four times larger, or for PNG sequences. When the rule fails, render `--only <block>` or lower the
resolution — never let the encoder finish into a full disk, which produces a truncated MP4 that looks
plausible ([WORKFLOW](./WORKFLOW.md) stage 7).

## 3. Grading bands, and why they are what they are

Bands exist so that "how wrong is it" has one answer across tools, reviews and reports.

| Band | `handoff.pixel` (mean abs diff) | Meaning |
|---|---|---|
| `ok` | < 0.01 | Below the visibility threshold: at 8-bit, 0.01 mean absolute difference is ≈ 2.5/255 averaged over the whole frame. Two frames this close are indistinguishable side by side, let alone across a cut. |
| `minor` | 0.01 – 0.03 | Visible only in a flicker/A-B comparison, and almost always grain, dither or antialiasing rather than a misplaced object. Acceptable at a seam; not something to chase. |
| `ALIGN` | ≥ 0.03 | Something is genuinely misaligned — camera, layer order, colour or exposure — and a viewer will see the frame jump. MUST fail the gate ([CONTRACTS](./CONTRACTS.md) §9). |

These three numbers are the same three numbers as [CONTRACTS](./CONTRACTS.md) §9 and MUST NOT drift
apart; a tool that grades a seam differently from `cvpw handoff` is a bug.

**Gold frames: exact, by default.** A content hash has no partial credit. Any difference is either a
real change (update the gold, §5) or environment nondeterminism (record an exemption, [SPEC](./SPEC.md)
D8). A tolerance on a hash would hide both.

**Flash: ≤ 3 large-area luminance round-trips per 1 s window.** Three flashes per second is the
long-standing photosensitivity limit (WCAG 2.3.1, *Three Flashes or Below Threshold*), and it is a
hard gate, not an aesthetic preference ([SPEC](./SPEC.md) V7). The measurement counts *large-area parts
of the frame* going up-and-back-down once as one round-trip; it weights saturated red (R/(R+G+B) ≥ 0.8)
because red is the most provocative colour for a photosensitive viewer; it treats tear/stripe patterns
held for ≥ 6 frames (~200 ms at 30 fps) as a pattern rather than a flash, because that is how the eye
integrates them; and it prefers brightness achieved by **holding** a level over pulsing to it. Measure
per section, when the section is finished.

**Text: 48 px at 1080p, held ≥ 0.25 s, nothing below 6 px.** 48 px is ≈ 4.4 % of picture height — the
size at which a short name survives a phone-sized review and a one-second glance. 0.25 s is ≈ 7 frames
at 30 fps (6 at 24), the point at which a short word can be read rather than merely seen. Text below
6 px is replaced: at that size it is noise that costs fill rate, and it makes `text.whitelist`
unenforceable in practice because nobody can read what is on screen.

## 4. The review loop protocol

Review is a loop with a fixed shape, not an inspection at the end. Each pass costs minutes; a defect
found in pass 3 costs an afternoon.

| # | Step | Command | What it is for |
|---|---|---|---|
| 1 | Stills at shot midpoints | `cvpw stills --times <shot midpoints> --overlay` | Does each shot do what its `moment` says? |
| 2 | Contact sheet | `cvpw sheet --from 0 --to <duration> --every <duration/24>` | Pacing, palette drift, repetition, dead stretches. |
| 3 | Fix the worst three things | — | Not ten. Ten changes invalidate the next pass. |
| 4 | Per-cue contact sheet | `cvpw sheet --cues --offset 0.12` | The single most useful image: cuts, text, and the frame after each cue, together. |
| 5 | Full / low-res pass | `cvpw review --mp4 render/<name>_preview.mp4 --step 1.8` | Motion defects that stills cannot show: flicker at joins, crawl, drift. |
| 6 | Numeric comparison of untouched ranges | `cvpw check --gold` | Proves a local edit stayed local. A shared-file edit that changed nobody's work is a claim; this is the proof. |
| 7 | Re-review | back to 1 | Until a pass finds no new defects. |

**The three-frames rule.** For **every shot that changed**, inspect three frames: the **first frame
after the cut**, the **main event** of the shot, and the **last frame before the end**. Defects cluster
at exactly those three places, and a reviewer who opens only the middle frame will approve a shot whose
first frame is a flash of last shot's colours.

**Budget two to three passes.** The first pass finds the real defects, the second finds what the fixes
broke, the third is usually clean. A fourth pass that finds nothing means the earlier passes were done
by eye only; a fourth pass that keeps finding new defects means step 3 is changing too much at once.

**Safety is measured when the section is finished, not at the end** ([SPEC](./SPEC.md) V7): run
`cvpw check --flash` on the range that just changed, before moving on. A flash problem discovered after
the master is delivered is a re-encode, not an edit.

## 5. Gold frames

`qa/gold.json` holds the determinism witness: frame hashes at declared times, at a declared size and
fps ([CONTRACTS](./CONTRACTS.md) §10). `cvpw check --gold` recomputes those hashes and compares. It is
the only cheap way to prove that a change to one shot did not restyle another, and the only mechanical
answer to "did the render change?".

`cvpw check --gold --update-gold` is legitimate in exactly three situations, and in all three the
**reason is recorded** in the commit message and in `docs/PROGRESS.md`:

1. A deliberate visual change to a shot (the gold is updated for the affected times only).
2. A determinism bug was fixed, so the old gold encoded the bug.
3. A recorded environment change (a driver or browser update) whose drift is understood and measured —
   in which case the drift itself still needs an entry in `qa/exemptions.json` ([SPEC](./SPEC.md) D8).

**A gold update is a reviewed decision, not a command.** Before updating, the frames at the affected
times MUST be rendered, looked at, and compared with the previous gold's frames; "the hashes moved, so
I updated them" is exactly the silent tolerance [SPEC](./SPEC.md) D8 forbids. Updating gold to make a
red check go green — with no image looked at and no reason written — is the same failure as deleting a
test.

```jsonc
// qa/exemptions.json — authored. Every entry needs all seven fields, and a missing one fails validation.
{ "$schema": "schemas/exemptions.schema.json", "schemaVersion": 1,
  "exemptions": [
    { "check": "handoff.pixel", "target": "s07|s08", "date": "2026-01-20",
      "reason": "GPU float rounding differs by 1/255 on 12 pixels of the sky gradient",
      "observed": "0.031", "owner": "integrator", "expires": null } ] }
```

`expires` is a date or `null`. `null` means "until the project ends, and it will be restated in the
delivery report"; a project with more than a handful of non-expiring exemptions is a project whose gate
set does not match its film.

## 6. Waivers

A **waiver** is a check that failed and was accepted anyway. It is not a mute button
([SPEC](./SPEC.md) V6): it is a dated, justified, owned decision that appears in the delivery report.

- Every waiver MUST have a `date`, a `reason`, an `observed` value and an `owner`. A waiver with no
  reason (or with a reason that restates the check id) **fails** `cvpw validate`
  ([CONTRACTS](./CONTRACTS.md) §10).
- Every waiver MUST appear in `qa/report.json::waived` and in the delivery summary, verbatim, including
  the checks in the table marked "waiver allowed? no" — those MUST NOT be waived, and the remedy is to
  fix the thing or to change the project (a declared inset, a whitelist entry, a licence statement),
  not to record an exemption.
- A waiver whose `expires` date has passed MUST be re-confirmed or removed; a stale waiver is a silent
  tolerance wearing a date.
- **The anti-pattern is "retry until it passes".** If a check fails intermittently, the intermittency
  *is* the defect: the cause is unseeded randomness, wall-clock dependence, carried state, or an
  environment difference ([SPEC](./SPEC.md) D2–D3). Re-running until the failure hides produces a
  green report with no information in it, which is worse than a red one. Record what was observed, then
  find the cause — `determinism.workerCount` and `determinism.gold` exist precisely to make the
  randomness visible instead of merely intermittent.

## 7. Failure-mode catalogue

| Symptom | Likely cause | What to measure | Fix |
|---|---|---|---|
| One-frame flicker at a join | `Math.floor(t * fps)` used instead of `frameIndex(t)`; the two disagree exactly on frame boundaries | Frame hashes around the join at `t ± 1/fps`; the flipping element's seed | Use `frameIndex(t)` for per-frame jitter ([SPEC](./SPEC.md) D4); re-render the two shots. |
| Frames differ between workers | Unseeded randomness, wall-clock read, or state carried between frames | `cvpw check --determinism`; then `cvpw lint` for banned APIs | Seed from `frameIndex(t)`; if the scene genuinely simulates, declare `stateful: true` with `reset()`/`step()` ([SPEC](./SPEC.md) D3). |
| A seam fails only when grain is on | Grain is per-frame noise, so two frames at different times differ everywhere | `cvpw handoff` (which forces `nograin`) vs the same frames with grain | The contract is wrong, not the check: move grain out of the seam's shared contract ([CONTRACTS](./CONTRACTS.md) §9). |
| Text unreadable at speed | Text too small, or not held long enough | `text.legibility`: px size at 1080p and hold duration | ≥ 48 px for names, ≥ 0.25 s of readable time; replace anything under 6 px (§3). |
| The film is technically clean but boring | No attention at stage 1 or 3: no contrast, no holds, shots that are all the same length | `timeline.pacing`; read the `moment` sentences in order | Revisit the storyboard: escalation, holds, and at least one thing the film refuses to do. This is not a render bug ([WORKFLOW](./WORKFLOW.md) stage 6). |
| A truncated MP4 that looks plausible | The encoder died mid-write and left a valid header | `render.frameCount`; `render/report.json::errors`; ffprobe duration | The renderer MUST delete a failed output; never report success from the file's existence ([SPEC](./SPEC.md) P6). |
| Audio drifting late | `audio.offset` applied by editing the audio instead of at mux time | `av.sync`; whether the source file's hash changed | Apply the offset at mux only (`-itsoffset`/`adelay`); keep the source byte-identical ([CONTRACTS](./CONTRACTS.md) §2). |
| The vertical variant clips text | Composed for 16:9 with raw arithmetic instead of layout helpers | `text.safeArea` on the vertical variant, run independently | Route positions through `engine/lib/layout.js`; a vertical variant is a layout, never a scaled crop ([SPEC](./SPEC.md) C7, [WORKFLOW](./WORKFLOW.md) stage 7). |
| A scene renders nothing at some times | Wrong active-interval logic; the scene exits before its shot starts | `scene.emptyFrames` at the shot's first and last frame | Fix the interval; add the shot's first frame to the stills set. |
| A scene is suddenly 3× slower | Unbounded particles, per-shape shadow blur, or a full-screen filter per layer | `scene.perf` p95 against `budgets.msPerFrame`; count draw calls before/after | Cache what is constant, cap particle counts, move the filter to the post chain. |
| A corrupted-looking glyph run (mojibake) that is really an encoding bug | A handle wrote UTF-8 text through a CP936 path (or the reverse) | Byte-level check: BOM, U+FFFD, invalid UTF-8 ([ENVIRONMENT](./ENVIRONMENT.md) §6) | Fix the handle, not the text; re-generate the artifact from its inputs; `cvpw lint` catches it at the next stage boundary. |
| A lyric line is consistently early | Word timings taken from ASR, or a tolerant snap that chose a default | `lyrics.alignment` against measured vocal onsets; the cue's `source` | Derive onsets from the vocal-band onset envelope; register the corrected time as a cue with `source: measured` ([SPEC](./SPEC.md) T6, T8). |
| A review that found nothing | Nobody opened the right frames: midpoints only, or no manifest | `review/report.json` — is it populated, and with which times? | Re-run the loop with the three-frames rule, the per-cue sheet and a full pass; a review without a manifest has not happened ([SPEC](./SPEC.md) V3). |

## 8. QA philosophy

Measure a section **where it is finished**, not at the end: flash, legibility and seam geometry are
cheap to fix at the section and expensive to fix after the master. Verify **untouched work numerically**
rather than by eye — gold hashes are how a local edit is proved local. Prefer a **documented exemption**
to a silent tolerance: a date, a reason and an owner cost one line and preserve the meaning of every
other green check. And treat **"look at every result"** as the actual mechanism: every threshold here
exists to make looking cheap, targeted and honest, and a gate that passes while nobody has seen the
frames has verified nothing at all.
