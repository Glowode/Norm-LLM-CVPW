# 05 — Troubleshooting

**Read when:** something is failing and you want the cause rather than a theory.

Organised symptom-first, because that is what you have. Find your symptom, run the confirming command,
apply the fix. When the table says "stop", stop — an agent that keeps going after an unresolved contract
failure is producing work that will be thrown away.

---

## By symptom

| What you see | Most likely cause | Confirm with | Fix |
|---|---|---|---|
| A time expression throws | The timebase genuinely lacks that moment | read the error's `nearest:` list | Fix the analysis, the cue list or the storyboard. **Never** substitute a literal second. |
| `no bar with index N` | Bar numbered by array position, or a pickup bar | `cvpw validate` then look at `bars[].index` | Use the `index` field. A pickup bar makes bar 0 sit where you did not expect. |
| `no cue named '…'` | Typo, or the cue was never created | the error lists near matches | Fix the timeline. If the moment is real, add the cue. |
| `VOX('…')` fails | No alignment data, or the word is repeated | `cues/lyrics.timing.json` exists? word count? | Without alignment, `VOX` cannot work. Use `L(n)` and an offset instead. |
| Everything is 4 frames late | Analysis without snap-to-onset | `snapped fraction` in the analysis summary | Re-run `cvpw analyze`; a grid that is not snapped cuts late on every percussive attack. |
| Beats at double or half the true rate | Tempo octave error | **look at `analysis/overview.png`** | `cvpw analyze --bpm-range LO,HI` around the candidate. |
| `octaveCheck` is not `ok` | A real ambiguity, not necessarily an error | the candidates list | Look at the plot. A confident wrong tempo costs the whole film; an ambiguous flag costs one look. |
| Every lyric line is early | Word timestamps taken from transcription | compare to a vocal-band onset | Transcription timings run 40 ms–2 s early. Derive onsets from the envelope. |
| `unknown key "…"` in a schema error | Typo, or a key you invented | `cvpw validate` names the pointer | Fix the key. Unknown keys are rejected on purpose (SPEC A4) — do not add a permissive schema. |
| `scene X has invalid args: unknown arg "…"` | Misspelled arg | the error lists the known args | Fix the timeline. A silent default is what this rule exists to prevent. |
| `no scene named "…"` | Not registered, or typo in the manifest | `cvpw storyboard --list-scenes` | Register it and add the manifest line. |
| `NO SHOT @ t=…` in a rendered frame | A gap in coverage | `cvpw storyboard` reports the gap | Extend a neighbour or add the shot. Never let the engine fill it. |
| A frame renders red with `[shotId]` | The scene's `draw()` threw | the console line names the shot id | Fix the scene. The error card means the film kept rendering, not that the frame is fine. |
| Frames differ between workers | Unseeded randomness, a clock read, or state between frames | `cvpw check --determinism`, then `cvpw lint` | Seed from `frameIndex(t)`; if the scene truly simulates, declare `stateful: true` with `reset()`/`step()`. |
| One-frame flicker at a join | `Math.floor(t*fps)` instead of `frameIndex(t)` | `cvpw lint` | Use the helper. The two disagree on exact frame boundaries. |
| A seam fails, or fails only with grain on | Grain was not disabled, or one side hard-coded the contract | `cvpw handoff` forces grain off; compare `diffARef` vs `diffBRef` | Never measure a seam with grain. If one side's `diffRef` is large, that side hard-coded a shared value. |
| Text is unreadable at speed | Too small, or not held long enough | `cvpw check --text` | Names ≥ 48 px at 1080p, readable ≥ 0.25 s before leaving. |
| Text collides with subtitles | Drawn below the declared band | `cvpw check --text` | Move it above `project.json::output.subtitleBand`. |
| The vertical variant clips text | Composed for 16:9 | render and look at the vertical stills | Re-run the layout through `layout`; **never** scale or crop the master. |
| A scene renders nothing at some times | Wrong active-interval logic | `cvpw check --scenes` reports empty frames | Fix the interval. Render the midpoint, not frame 0. |
| A scene is suddenly 3× slower | A per-shape shadow blur, unbounded particles, or a full-screen filter per layer | `render/report.json::msPerFrame.p95`, `cvpw check --scenes` | Respect the per-shot budget. Measure before and after every change. |
| The audio drifts late | Offset applied by editing the audio file | `cvpw check --av-sync` reports the lag | Apply the offset at mux time only (SPEC P6). The source is never edited. |
| A suspiciously small output file | A render that failed part-way | `render/report.json::errors` | The renderer deletes its output on failure. A file that exists and is short means the deletion did not happen — report it as a bug. |
| The MP4 is a frame short | `floor` instead of `round` on the frame count | `cvpw check --frames` | `frames == round(duration × fps)`. Fix the count, not the threshold. |
| Mojibake in a rendered text card | The text was corrupted in the file, not at render time | grep for U+FFFD; `cvpw lint` | Recover the original bytes. Retyping by hand silently changes the text. |
| A glyph renders as a box | The font lacks the glyph, or the font never loaded | look at the still | Load the font and wait for `document.fonts.ready`; add the glyph or draw it as a path. |
| `Cannot read properties of undefined` at frame 0 only | Fonts or assets not ready | `window.cvpw.ready` resolved before the first frame? | The engine must not resolve `ready` until fonts and assets are in place. |
| Everything renders but nothing moves | `t` is not reaching the scene | `--overlay` shows the time | Check that `draw` receives and uses `f.t`. |
| The render is ~10× slower than expected | Software rasteriser | `cvpw doctor` reports the renderer | Fix the GPU flags or driver. `cvpw render` refuses software unless `--allow-software`. |
| The encoder "is available" but fails | Only a probe tells the truth | `cvpw doctor` shows the probe's error | Hardware encoders are probed by encoding. The fallback is software, and that is correct. |
| Disk fills during a render | No budget | `project.json::budgets.peakDiskGb` | Use `--preview`, lower the frame quality, or clear space. The filesystem sink is resumable. |
| `cvpw` exits 3 saying it is not built | `dist/` is missing | — | `pnpm install && pnpm build`. |

---

## By error message

### Time-expression errors

Every one of these is a *contract failure*, not a lookup miss. The message always names the failing token
and lists up to three nearest valid alternatives. The fix is never in the expression.

```
cannot resolve time "cue('choru')": [cue('choru')] no cue named "choru". nearest: chorus@41.900s, chorus2@97.400s
```

```
cannot resolve time "b(99,0)": [b(99,…)] no bar with index 99. nearest: b(63,0)@126.020s, b(62,0)@124.020s
```

```
cannot resolve time "VOX('sudden')": [VOX('sudden')] the word occurs 2 times; address the line with L(n) and add an offset. nearest: L(12)@41.900s, L(28)@97.400s
```

```
cannot resolve time "HIT('hit',5.5)": [HIT('hit',5.5)] the nearest hit is 1.480s away, beyond the 0.06s tolerance
```

```
cannot resolve time "b(1,0)": [b(…)] the timebase has no beat grid; use a cue or absolute seconds, or analyse the audio
```

**The whiteboard test:** if you cannot say which cue or which bar a moment belongs to, the storyboard is
not finished — not the expression.

### Contract and validation errors

```
project.json: /output/fps: must be equal to one of the allowed values — got 29
```
29 is not a legal frame rate. Allowed: 24, 25, 30, 50, 60. A non-standard rate causes a
silent pulldown mismatch in every player.

```
timeline.json: /shots/3: unknown key "momennt"
```
A typo. `momennt` would have been silently ignored, and the shot would have had no `moment`, and the
`timeline.moment` gate would have failed somewhere less obvious.

```
analysis/envelope.json: /frames: envelope.f32 has 7680 bytes, expected 9600
```
The sidecar and the blob describe different runs. Regenerate both. A loader must degrade to zeros with a
named warning rather than throwing, so that a preview survives; a *gate* must fail.

```
handoff.json: /seams/0: missing required key "contract"
```
A seam with no contract is not a contract. Both sides must have shared values to read.

### Render-time messages

```
[pageerror] Cannot read properties of undefined (reading 'width')
[console] [s07_grid] draw() threw at t=41.900: ...
```
Both carry a shot id. **Read them.** The render prints them precisely because the alternative is a
mysterious visual glitch with no address. A non-empty error list means `render/report.json::errors` is
populated and the output was deleted.

```
NO SHOT @ t=63.500
```
Coverage gap. `cvpw storyboard` will find it in a second, without rendering.

---

## By gate id

| Check | A failure usually means |
|---|---|
| `contract.validate` | A typo, or an artifact from an older schema version. Fix the source, never the schema. |
| `encoding.utf8` | A file was written by something that did not honour UTF-8. Look for U+FFFD, a BOM, or CRLF. |
| `determinism.bannedApi` | A clock, an entropy source or a timer reached the draw path. The AST analyzer finds aliases a text scan cannot. |
| `determinism.gold` | The picture changed where you did not intend it to — or the GPU float path differs. Compare the exemption list before assuming a bug, and compare it before assuming noise. |
| `determinism.workerCount` | Real nondeterminism. This one is never a false positive: identical input must give identical output. |
| `timeline.coverage` | A gap or an unowned overlap. Fix the storyboard, not the check. |
| `timeline.moment` | A shot that was never justified. Write the sentence; if you cannot, the shot is filler. |
| `timeline.absoluteTimes` | A bare-number time. Either convert it to an expression or acknowledge the warning deliberately. |
| `timeline.pacing` | Shot durations are uniform. That is a storyboard problem, not a render problem. |
| `lyrics.alignment` | A line is timed wrong. Reconcile against the envelope; check whether the timing came from transcription. |
| `scene.errors` | A scene throws. The offenders name the shot ids. |
| `scene.emptyFrames` | Coverage logic, or a scene that draws nothing at some times. |
| `scene.perf` | A shot exceeds the budget. Find it with `render/report.json`, not by guessing. |
| `render.frameCount` | `floor` used where `round` is required, or a render that stopped early. |
| `av.sync` | The offset was applied by editing the source, or the mux used the wrong time base. |
| `handoff.pixel` | One side drifted. Compare `diffARef` and `diffBRef` to find which. |
| `flash.rate` | Real photosensitivity risk. Not a stylistic question; fix it or exempt it with a reason a reviewer would accept. |
| `text.safeArea` / `text.legibility` | Text outside the safe area or too small to read at speed. |
| `text.whitelist` | A string on screen that the brief never authorised. |
| `assets.manifest` | A missing asset, a hash mismatch, or a missing licence. The last one blocks delivery. |
| `render.noDeadFrames` | A window where nothing changes. A full-rate pass catches what sampling cannot. |
| `publish.lyricText` | Lyric text is about to be published without a licence. This gate exists to be obeyed, not waived. |

---

## Three anti-patterns, and what to do instead

### 1. Substituting a literal for a throwing time expression

**What it looks like:** `"at": "b(99,0)"` throws, so you write `"at": "126.02"`.

**Why it is wrong:** you have replaced "this moment does not exist in the music" with a number that will
be wrong the next time the audio is analysed, and nothing will ever tell you.

**Instead:** decide what the shot is actually for. If the bar does not exist, the shot belongs at a cue
or at the end of a neighbour. If the moment matters, register a cue.

### 2. Retrying a failing gate

**What it looks like:** `cvpw check --gold` fails, so you run it again.

**Why it is wrong:** a determinism check that fails twice has told you the same thing both times. The
second run costs time and teaches nothing.

**Instead:** read `offenders`. Compare against `qa/exemptions.json`. If it is genuine GPU float noise,
record a dated exemption; if it is not, you have found a real bug and the check just paid for itself.

### 3. Widening a threshold in code

**What it looks like:** the seam diff is 0.031 and the band is 0.03, so you change the band.

**Why it is wrong:** you have made the film worse and the tool quieter at the same time, and the change
is invisible to everyone who comes after you.

**Instead:** the threshold has exactly one home (`docs/QA.md` or `project.json::budgets`). Change it
there, with a reason in `docs/PROGRESS.md`, or record a dated exemption. Both are reviewable; a code edit
is not.

---

## "The film is technically clean but bad"

Every gate passes and the result is boring. This is not a bug and no tool will find it.

Work backwards through the storyboard and ask, per shot: **what is the `moment` sentence, and is it
worth saying?** Usually three things are true:

- **Too few holds.** If nothing is held for more than a second, the film has no rhythm to break.
- **No escalation.** Each section should be bigger than the last, and the last one should bring back an
  earlier idea transformed. A flat dynamic curve reads as flatness however good the individual shots are.
- **The shots answer the lyrics rather than the song.** A picture that illustrates the words is a
  slideshow; a picture that answers them is a film.

None of this is measurable, which is exactly why it needs to be looked at rather than checked.

---

## "It looks fine in a stills sheet but wrong in motion"

Stills sample time; motion is continuous. The failures that hide between samples:

| What | Why the sheet missed it | Catch it with |
|---|---|---|
| A frame with nothing drawn | It fell between two sample times | `render.noDeadFrames` (full-rate, low-resolution) |
| One-frame flicker at a join | Sample times rarely land on the join | `cvpw check --determinism`; `frameIndex(t)` rule |
| A seam that pops | Stills of A and B separately look fine | `cvpw handoff` — the A\|REF\|B strip |
| Motion that is too fast to read | Any single frame looks composed | `cvpw review --mp4` at a 1.5–2 s step, and a short clip |
| An effect that crawls rather than moves | Per-frame noise seeded with `t` instead of `frameIndex(t)` | the review sheet, and SPEC D5 |

---

## When to stop and ask a human

Stop, and say precisely what you need, when:

- A **contract failure** has no correct resolution you can see. Do not invent a schema key.
- You are about to **publish** something — a master, an upload, a repository. Delivery is a human
  decision, and the licence gate exists for exactly this.
- You are about to **waive** a safety gate (`flash.rate`, `av.sync`, `publish.lyricText`).
- The **brief and the music disagree** — the chorus the brief describes is not where the analysis puts
  the chorus. That is a creative decision, not a technical one.
- You need to **change a shared contract** that other blocks already read.

In each case the useful message is short and specific: what you were doing, what you found, what the
options are, and which you recommend. "I'm stuck" is not a message; "the cue `chorus_in` is 1.8 s from
the nearest onset, so either the cue is wrong or the section label is — which do you want?" is.
