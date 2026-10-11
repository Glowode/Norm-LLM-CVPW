# 02 — The review loop

Review is where a technically-correct render becomes a film. It is a loop with a fixed shape, not an
inspection at the end: each pass costs minutes, and a defect found in pass three costs an afternoon
([`../../../docs/QA.md`](../../../docs/QA.md) §4).

The rule the whole loop serves: **an agent claiming a review without a populated `review/report.json` has
not reviewed** ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) V3). The manifest lists every image
produced, its time, and the active shot ids at that time — which is what turns "the third panel looks a bit
off" into "shot `s07_glass` at 41.2 s".

---

## 1. The four review artifacts

```bash
cvpw stills --times 1.0,2.5,4.0 [--overlay] [--out review/stills]
cvpw sheet  --from 0 --to 8 --every 1.0 [--cols 4] [--out review/sheet.jpg]
cvpw sheet  --cues [--offset 0.12] [--out review/cues.jpg]
cvpw review --mp4 render/mv_preview.mp4 --step 1.8 [--out review/pass1]
```

| Artifact | What it answers | What it structurally cannot show |
|---|---|---|
| **`cvpw stills --overlay`** | Does this specific shot, at this specific time, do what its `moment` says? | Anything about motion, and anything about the frames you did not name. |
| **`cvpw sheet` at an interval** | Pacing, palette drift, repetition, dead stretches — the film as a strip. | Detail: at contact-sheet size, small text is a smudge and a two-frame flash is invisible. |
| **`cvpw sheet --cues`** | **Is every lyric line's picture right?** One frame per cue, in order. | Motion, and anything between cues. |
| **`cvpw review` over a rendered master** | Motion defects that stills cannot show: flicker at joins, crawl, drift, a flash you feel rather than see. | Detail at full resolution; it is a low-resolution pass by design. |

**`--overlay` is not decoration.** It burns in time, frame index and the active shot ids, so a defect in an
image maps to a shot without guessing. Every still you intend to act on SHOULD carry it; a full-resolution
clean still is for the one frame you are about to defend to a human.

**The per-cue sheet is the single most useful image in the whole toolkit.** `cvpw sheet --cues` puts one
frame after each cue side by side, which is precisely the set of moments a lyric video lives or dies on: it
shows the cut, the text, and the frame the viewer actually sees at the cue, together, in order. Read it top
to bottom and ask one question per panel — *is this the right picture for this line?* If you only ever look
at one image in a project, make it this one.

`--offset 0.12` is legitimate and often necessary: the frame *at* a cue can still be the previous shot's
last frame, because of how the containing frame is chosen. Offsetting by a little shows the picture the
viewer actually experiences. Record the offset you used; a defect found at +0.12 s is still a defect at the
cue.

---

## 2. The three-frames rule

> For **every shot that changed**, inspect three frames: the **first frame after the cut**, the **main
> event**, and the **last frame before the end**.

Why those three, specifically:

| Frame | What only it can reveal |
|---|---|
| **First frame after the cut** | Whether the new shot's first frame is actually the new shot: a flash of the previous shot's colours, an uninitialised buffer, a transition that starts one frame late, a text layer that has not faded in yet. This is the frame a viewer reads as "the cut", and it is the one a midpoint-only review never opens. |
| **Main event** | Whether the shot's declared `moment` is legible at the instant it is supposed to land. The main event is usually on a beat or a cue; find it via `docs/STORYBOARD.md`. |
| **Last frame before the end** | The exit state: what the next shot inherits. This is where a held element that should have cleared is still on screen, where a fade has not finished, and where a `pixel` handoff either matches or does not. |

Defects cluster at exactly those three places because they are the only places where the state *changes*.
A reviewer who opens only the middle frame approves a shot whose first frame is a flash.

Apply the rule to **every shot the change touched** — not every shot in the film. That is what makes a pass
cheap enough to run three times.

---

## 3. The pass budget, and how to tell a pass was real

**Budget two to three passes** ([`../../../docs/QA.md`](../../../docs/QA.md) §4). The first finds the real
defects, the second finds what the fixes broke, the third is usually clean.

A pass that finds nothing is one of two very different events. Distinguish them with evidence, not with a
feeling:

| Signal | Good pass | Pass that looked at the wrong frames |
|---|---|---|
| `review/report.json` times | Cover the first frame after every changed cut, its main event, and its last frame — for **every** changed shot | Only midpoints; only the shots you remember; the same times as the previous pass |
| The change set | Measurably smaller than last pass (a handful of shots, described in `docs/PROGRESS.md`) | Large: ten shots edited at once, so nothing can be attributed |
| `cvpw check --gold` | Run, and untouched ranges match | Not run, or failures explained away |
| The notes you wrote | Specific and few ("`s07_glass` first frame still carries the old sky for one frame — fixed") | "Looks good overall" |
| Safety | `cvpw check --flash` on the section that just changed | Deferred to the end |
| Timing | The per-cue sheet was read this pass | Not opened since pass one |

A **fourth** pass that finds nothing means the earlier passes were done by eye only; a fourth pass that
keeps finding new defects means the previous step changed too much at once. Both are diagnostics about the
process, not about the film.

**Fix the worst three things per pass, not ten** ([`../../../docs/QA.md`](../../../docs/QA.md) §4 step 3).
Ten changes invalidate the next pass, because you can no longer attribute a new defect to a fix.

---

## 4. Prove a local edit stayed local

After any change, compare the ranges you did **not** mean to touch, numerically:

```bash
cvpw check --gold --json
```

Eye comparison across a re-render is worthless — the encoder, the grain and your own expectations all move.
A shared-file edit that changed nobody's work is a claim until it is a hash. The two outcomes:

- **Untouched ranges match** → your change was local, and you may say so.
- **Untouched ranges moved** → something shared changed: a style, `engine/core`, `engine/lib`, a handoff
  contract. That is not automatically wrong, but it *is* unreviewed work, and it now needs the three-frames
  treatment before it can be defended.

If the change was deliberate and widespread, [`../../../docs/QA.md`](../../../docs/QA.md) §5 governs the
gold update: render the affected frames, look at them, compare with the previous gold's frames, and write
the reason. Never update gold to make a red check green.

---

## 5. Writing a defect note an author can act on

A note that cannot be acted on is a note that will be argued with. Every defect gets four things:

```text
shot    s07_glass
time    41.20 s   (frame 1236, cue 'chorus2', +0.12 s after the cut)
wrong   the first frame after the cut still carries the previous shot's warm sky for one frame;
        the glass edge flashes orange before settling to the cool ramp
right   the first frame of s07_glass should already be on the cool ramp, matching the seam contract
        in handoff.json (camera drift, env 'studio') — no flash, no warm frame
```

Rules:

- **Shot id and time, always.** The overlay gives you both; use them. "The glass bit" is not a location.
- **Describe what is on screen, not what the code does.** "The warm sky bleeds for one frame" is a defect
  report; "the palette lerp is wrong" is a hypothesis, and a wrong hypothesis sends the author to the wrong
  file.
- **Say what "right" would look like.** Without it the author guesses, and the guess is usually smaller
  than the problem.
- **One defect per note.** A note with three defects gets one of them fixed.
- **Record it where it will be seen**: the block's progress log, and `docs/PROGRESS.md` when it is a
  deviation or an accepted defect.
- **Fixed or explicitly accepted.** Every defect ends in one of those two states; "noted" is not a state.

Record accepted defects as waivers when they trip a gate ([`../../../docs/QA.md`](../../../docs/QA.md) §6)
and list them in the delivery report. A defect accepted silently is a defect that reappears in the next
project.

---

## 6. Photo-sensitivity: measure at the end of each section

```bash
cvpw check --flash --only <block> --json
```

Flash rate is a **hard gate**, not an aesthetic preference
([`../../../docs/SPEC.md`](../../../docs/SPEC.md) V7), and the rule about *when* to measure is as important
as the threshold:

> Measure when the section is finished, not at the end of the film.

Two reasons, and they compound:

1. **Cost.** A flash problem found at the end is a re-encode of a finished master, or — worse — a re-edit
   after the gold frames, the handoff grades and the review passes were all done against the old cut.
2. **Attribution.** A section-level measurement is attached to the shots that caused it. A whole-film
   measurement gives you a number and a time range in the middle of a two-minute file, and you then have to
   work backwards to find which of forty shots is strobing.

The eye integrates pattern differently from flash: tear and stripe patterns held for six frames or more
(~200 ms at 30 fps) are counted as a pattern, not a flash, and saturated red is weighted because it is the
most provocative colour for a photosensitive viewer. The practical consequence for review: if you *feel*
the section is strobing, it is worth measuring even when the number passes, and if the number fails it is
not negotiable by taste.

---

## 7. Critique checklist, organised by what actually goes wrong

Work down this list rather than "does it look nice". Each line names the failure it catches and the artifact
that shows it.

### Pacing

- Are there at least three genuine holds of ≥ 1.0 s, and do they land where the music holds?
- Is there any run of more than six shots of equal length? (`timeline.pacing`, `equal-durations`)
- Does the film escalate — does the chorus section *feel* bigger than the verse, in cut rate as well as in
  content?
- **Artifact**: the interval contact sheet. Pacing is a strip property; you cannot see it in a still.

### Legibility

- Is every name ≥ 48 px at 1080p, and readable for ≥ 0.25 s before it leaves?
- Is anything under 6 px still on screen? (It is noise that costs fill rate and makes the whitelist
  unenforceable.)
- Read the text at contact-sheet size. If you cannot read it there, a phone will not read it either.
- **Artifact**: `cvpw stills --overlay` at the text's first and last frame; `text.legibility`.

### Continuity across a cut

- Does the first frame after each cut belong to the new shot? (the three-frames rule)
- Does anything carry over that should have reset: a camera offset, a colour grade, a held shape?
- Is a recurring motif in the same place on both sides of the cut, if it is supposed to persist?
- **Artifact**: stills at `t_cut` and `t_cut + 1/fps`, from the per-cue sheet or a targeted `--times` call.

### Seam visibility

- At a registered `pixel` seam, is the join invisible? (`handoff.pixel`, and the A|REF|B strip)
- Is the seam graded `ok`/`minor`, and is any `ALIGN` either fixed or exempted with a reason?
- Always judge with grain **off** — grain makes two frames at different times differ everywhere, so a
  grain-on comparison fails every seam and teaches you nothing.
- **Artifact**: `review/handoff/<seamId>.jpg` from `cvpw handoff`, plus the two full-resolution frames.

### Dead frames

- Does anything change in every 0.5 s window? (`render.noDeadFrames`)
- A hold is not a dead frame. A hold keeps an element alive — a breath, a slow drift, a grain that moves. A
  *stall* is a frozen picture, and it reads as a rendering failure.
- Watch the section, not just the frames: a dead window is much easier to feel than to see.
- **Artifact**: the full pass (`cvpw review`), then the specific window at full resolution if it is
  borderline.

### Colour drift between shots

- Across the contact sheet, does the palette walk, or does it jump? A jump is usually a style resolution
  difference, not an intentional accent.
- Within a section, are two shots that should read as the same place actually the same place? Compare the
  four corners of the frame, not the subject.
- Is the drift *motivated* — does the colour script in `docs/BRIEF.md` explain the change?
- **Artifact**: the interval contact sheet, read left to right as a palette strip.

### Text colliding with the subtitle band

- Does any non-lyric text enter the declared subtitle band? (`text.safeArea`, `subtitle-band <shotId>`)
- When a lyric line and a title are on screen together, do they overlap — and does the lyric layer win, as
  it must?
- On the vertical variant, is the band still clear? A layout change moves the band, and text that was clear
  at 16:9 can collide at 9:16.
- **Artifact**: `cvpw stills --overlay` at each text's mid-hold, on **both** variants.

---

## 8. The loop, end to end

| # | Step | Command | What it is for |
|---|---|---|---|
| 1 | Stills at shot midpoints | `cvpw stills --times <midpoints> --overlay` | Does each shot do what its `moment` says? |
| 2 | Contact sheet | `cvpw sheet --from 0 --to <duration> --every <duration/24>` | Pacing, palette drift, repetition, dead stretches. |
| 3 | Fix the worst three things | — | Not ten. Ten changes invalidate the next pass. |
| 4 | Per-cue sheet | `cvpw sheet --cues --offset 0.12` | Cuts, text and the frame after each cue, together. |
| 5 | Full / low-res pass | `cvpw review --mp4 render/<name>_preview.mp4 --step 1.8` | Motion defects stills cannot show. |
| 6 | Numeric comparison | `cvpw check --gold` | Proves a local edit stayed local. |
| 7 | Safety, per section | `cvpw check --flash --only <block>` | Cheap now, a re-encode later. |
| 8 | Re-review | back to 1 | Until a pass finds no new defects. |

That ordering is [`../../../docs/QA.md`](../../../docs/QA.md) §4 with the safety step made per-section, as
[`../../../docs/SPEC.md`](../../../docs/SPEC.md) V7 requires. Steps 1–4 are cheap; step 5 is the
expensive one, which is why the stills come first.

**Escape hatch for a single block**: `cvpw render --only b05` renders one block's range, which is far
faster than a full pass and is the right way to review a block in isolation.

Next: [`./03-delivery.md`](./03-delivery.md) — turning a reviewed cut into a master you can defend.
