# PROGRESS — what is done, what is not, and every departure

This file is the framework's own compliance artifact. `docs/SPEC.md` §10 requires that every place the
work departs from the spec is written down with a reason, because **an undocumented deviation is
indistinguishable from a bug** — the next agent will either repeat it or "fix" a deliberate decision.

Read this before concluding that something is missing by accident. Some of it is missing on purpose.

---

## Status at v0.1

### Done and verified on this machine

| Area | State | Evidence |
|---|---|---|
| Constitution and contracts | `docs/SPEC.md`, `docs/CONTRACTS.md`, `docs/WORKFLOW.md`, `docs/QA.md`, `docs/EXTENDING.md`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, six ADRs | written; cross-consistent after a review pass that found and fixed six real contradictions |
| JSON Schema contracts | 11 schemas under `schemas/` | `project`, `audio`, `envelope`, `cues`, `lyrics`, `lyrics-timing`, `timeline`, `handoff`, `handoff-report`, `assets`, `render-report`, `qa-report`, `gold`, `exemptions` — every one with `additionalProperties: false` (SPEC A4) |
| Time-expression grammar | `packages/kernel/src/time.ts` | **43/43 tests pass** (`tests/unit/time.test.ts`), including the alias and near-miss cases a textual scan misses |
| Determinism analyzer | `packages/audit/src/index.ts` | **22/22 tests pass**; catches `const r = Math.random; r()`, `globalThis.Date.now()`, `window.performance.now()`, bare `Date`, and forbidden kernel imports |
| Seeded generators, layout, plugin registry | `packages/kernel/src/{rng,layout,plugin,util}.js` | typecheck clean |
| Audio analysis | `python/src/cvpw_py/` | ground truth **4/4 checks pass** on the synthetic fixture; byte-identical across two runs (see below) |
| CLI | `packages/cli/` | `doctor`, `env`, `renderer` implemented and verified here; the other 17 commands registered with full flag surfaces, exiting 3 with a clear "not implemented" |
| Overview plot | `analysis/overview.png` | looked at; 15 onset spikes for 15 beats, the stop visible as a clean gap, the section boost visible |
| Reference reconnaissance | six projects under `reference/` | four subagent reports; their findings drove the contract design |
| Skill bundles | `skills/cvpw`, `skills/cvpw-timing`, `skills/cvpw-qa` | all 13 files written |
| Build and typecheck | five packages | `pnpm build` green; `tsc --noEmit` green for kernel, audit, runtime, render and cli |
| Frame ordering invariant | `packages/render/src/sink.ts` | **25 sink tests pass**; three real bugs found and fixed (see "Not done" §2) |
| Renderer core assumption | `scripts/determinism-*.mjs` | **measured**, not assumed — [ADR 0007](./adr/0007-warmup-frames-and-first-frame-instability.md) |

### The vertical slice, as far as it runs

```
synthetic click track (exact 120 BPM, first beat 0.02 s, stop at 6.02 s)
   -> cvpw_py selftest-audio     -> a WAV with exact, published ground truth
   -> cvpw_py analyze            -> analysis/audio.json, envelope.json, envelope.f32, overview.png
   -> cvpw_py verify-ground-truth -> 4/4 checks pass, exit 0
```

Measured result on the fixture:

```
duration 8.000 s   source 48000 Hz -> analysis 24000 Hz
tempo 119.69 BPM   confidence 1.00   octave ok
beats 15   bars 4   snapped 100%   residual median 5.3 ms / p95 11.7 ms
```

**Byte-level determinism verified**: two independent runs produced identical SHA-256 for
`audio.json`, `envelope.json`, `envelope.f32` and `overview.png`. This is the property the whole
render architecture rests on, and it is now a measured fact rather than a claim.

---

## Not done — and why

### 1. `examples/minimal/` is committed and verified from a fresh clone

The template cannot regress silently now. `examples/minimal/` is a complete project — four shots, one style,
five cues — and **sixteen files are committed**. Everything derived is not: `vendor/kernel` (a build artifact
of `packages/kernel/dist`), `timeline.json`, `docs/STORYBOARD.md`, `render/`, `review/`, `qa/`.

Verified by deleting exactly what git would not restore and running the documented sequence:

```
link  storyboard  validate  lint  check  stills  sheet  render      — 8/8
                                                                      1,547,707-byte master
```

**A new `cvpw link` command makes that possible.** A clone has no `vendor/kernel`, so without it the example
would be a text file rather than a project. `link` is the same vendoring `cvpw new` does, exposed for an
existing project — which is what a clone, or a committed example, actually is.

**One order-of-operations bug, found by running the README rather than writing it:** the first draft said
`validate` before `storyboard`, and `validate` correctly fails because `timeline.json` does not exist yet. A
newcomer's first command would have errored, and the error's advice — "run `cvpw storyboard` once the timebase
exists" — is right, which means the documentation was the wrong thing, not the tool. Both the command order
and a note explaining why are now in the example's README.

The example ships **without audio**, deliberately: the song is the user's property. The consequence is visible
rather than hidden — every cue is `source: manual` because there is no `analysis/audio.json` to settle
against, and every time expression is a `cue(...)` instead of a `b()` or `HIT(...)`. That is exactly what the
framework prescribes without a timebase, and it is what makes the example portable to a machine with nothing
installed.
### 2. The full pipeline has now been run end to end WITH AUDIO

Every earlier render in this project was silent, because the examples ship without music — and that is exactly
why the `apad` hang survived so long. It has now been run properly, on a project with a real track:

```
storyboard   4 shots, 8.000 s, no problems
render       240 frames with audio, 40.1 s wall, 81.5 ms/frame average, 1.62 MiB, libx264
frameCount   expected 240, inFile 240
av.sync      start delta 0.0 ms; video 8.000 s, audio 8.000 s
gold         11 frame witnesses
deliver      READY TO DELIVER — render/master.mp4, 240 frames
```

The container is correct: `h264` video and `aac` audio, both starting at 0.000000, both exactly 8.000000 s.

**No hang.** The previous session killed a 240-frame render after ten minutes and was left with a 49 MB file
that had no `moov` atom. The fix was one flag — `-shortest` beside `-apad` — and the same render now takes
41 seconds.

**What this closes:** the last path in the framework that had never been exercised end to end. Audio in,
measured timebase, resolved cuts, reproducible render, gates, baseline, delivery — with music.

**What it does not close:** `av.sync` still measures only container-level offsets, not wave-
form cross-correlation, and says so in its own output. A film whose audio was muxed from the right file at the
right offset but whose *content* is not the intended take would pass. That is a known, stated limitation.
### 3. OPEN DEFECT: `bloom` is declared in the schema and used by the template, and does nothing

Found while surveying phase 2. Same class as the palette index that started this session: a key that validates,
appears in the template, and has no effect.

| | |
|---|---|
| `timeline.schema.json` declares | `bloom`, `grain`, `tint`, `vignette` |
| the engine honours | `grain`, `tint`, `vignette` |
| the example's timeline uses | `post: { bloom: 0.35 }` on `s03_burst` |

The schema accepts it, so nothing warns. **Worse than an unknown key, because validation vouched for it.**

**What was measured, in order:**

1. `bloom: 0.35` reaches the engine — `window.engine.resolved` shows it on `s03_burst`.
2. A bloom pass was written (blurred copy of the frame screened over itself). Toggled at runtime on one frame:

   | `post.bloom` | mean luminance at frame 130 |
   |---|---|
   | 0 | 39.5906 |
   | 0.35 | 39.5906 |
   | 1.0 | 39.5930 |

   **0.0024 of movement at full strength.** The pass runs and contributes nothing.
3. The pass was then removed and replaced with a warning for any declared post key the engine does not honour.
   The warning **never fired**, even after rendering a frame inside the shot that declares `bloom` — with
   `engine.warnings` confirmed to be the live array (`private readonly warnings` at engine.ts:157, and
   `meta.warnings` is a spread copy at :257).

So the engine reaches `finish()` — vignette and grain visibly work — with a `post` object that contains
`bloom`, and neither the drawing nor the warning inside that block takes effect. **Both changes were reverted
rather than shipped**: a warning that has never been observed to fire is the same defect it was meant to catch.

**Next session, in this order:**

1. Put a `throw new Error("reached")` at the top of the declared-key loop and render a burst frame. If it does
   not throw, `finish()` is not receiving the shot's post and the bug is upstream of it — check whether
   `resolveSceneArgs`'s post merge survives into `ResolvedShot` at the moment `finish` reads it.
2. If it does throw, `this.warnings` is not the array the page exposes; read `engine.meta.warnings` after a
   render instead of `engine.warnings`.
3. Only then decide whether to implement bloom properly (needs a threshold and a multi-radius blur — the WebGL2
   chain phase 2 reserves) or to leave it unwarned and remove it from the schema. **Removing it from the schema is
   the honest option if it cannot be implemented**, because a key that cannot work should not be declarable.
### 4. Every command is implemented and the whole pipeline runs

**All twenty commands are real**, and a scaffolded project goes from an empty directory to a delivery
manifest in fourteen steps with no failures:

```
validate  lint  analyze  cues  lyrics  assets  storyboard
stills  sheet  review  check  gold  handoff  deliver      — 14/14
```

That is the vertical slice the framework was built for: audio becomes a measured timebase, the timebase
becomes cuts, the cuts become stills somebody looks at, the stills become a signed-off review, and the
review becomes a delivery the last gate refuses to release without.

**What each one does that is not obvious:**

| Command | The decision inside it |
|---|---|
| `analyze` | Spawns Python with UTF-8 forced and an ASCII temp path, because the reference host's console is code page 936 and a child that prints a CJK character dies with a message that looks like a script bug. |
| `cues` | Refuses to move a `manual` cue. A human who placed a cut by ear has information the analysis does not, and a tool that "corrects" it is destroying the only authoritative cue in the file. |
| `lyrics` | Writes timing always, text only when `lyricsLicence` is set. Timing is a fact about the recording; the words are somebody's property. |
| `lint` | Scans `engine/` and `tools/` only. A finding in a file the framework did not write and cannot fix is noise, and a lint people stop reading protects nothing. |
| `sheet` | Takes exactly the files the stills manifest lists. A directory is not a review set — the first version silently included a previous run's stills. |
| `review` | Separates `ok` from `accepted`. A film can be fine and not yet signed off, and conflating them is how an unapproved cut gets published. |
| `handoff` | Compares frame−1 with frame, and only for `pixel` seams. Measured the demo's `burst → hold` cut at 0.19 against a 0.03 threshold — which was my authoring error, not the film's, and the gate corrected it. |
| `deliver` | Compares the frame count in the file against the count the sink wrote, because a truncated MP4 passes an existence check and plays for thirty seconds. |

**Writing them found four contract breaks that had been invisible because nothing consumed the artifacts:**

1. `analysis/audio.json` carried `grid` and `beat` on every onset that `audio.schema.json` rejected. The
   fields are genuinely useful — they say which onsets sit on the grid — so the schema and
   `docs/CONTRACTS.md` were extended rather than the data dropped. A4's point is that an unknown key is
   *caught*, not that new keys are forbidden.
2. `qa/report.json` could not be produced by any command, so `deliver` blocked forever on a file nothing could
   write. `cvpw check --write-report` now emits the schema's shape, and the first attempt still failed three
   times on field types (`observed` and `offenders` are strings, `run.only` is a block id, `profile` is an
   enum) — which is the schema doing its job, one round at a time.
3. `handoff.report.json` was missing its required `run` block. Writing `run.grain: "off"` as a string forced
   the question of whether grain is a preference; it is not, because with grain on a seam comparison fails
   whatever the film did.
4. `render/report.json` wrote a `probe` key no schema allowed (fixed in the previous round), and
   `lyrics.timing.json` carried `source`/`generator` where the schema wanted `count`. Every one of these was
   found by `cvpw validate` rejecting a file the framework itself had just written.

**The pattern worth keeping:** each artifact is written by one command and read by another, and the schema is
the contract between them. Four times now, the producer and the contract disagreed and nothing noticed until a
*consumer* was added. That is the argument for `validate` running the whole registry rather than checking only
what a command happens to touch.
### 4. The blank-frame bug is FOUND AND FIXED — and it was a template bug, not a framework one

All four template scenes now render. The bisection described in the previous revision of this file took
about ten minutes once it was set up as a measurement instead of a guess, and the answer was in the frame:

```
band5  cx0=960 cy0=540 tint=#140b1e cr=40.8
```

**`#140b1e` is the palette's `ink` — the background colour.** The scenes read their accent from
`f.style.palette.colors[0]`, and `styles/minimal-paper.js` orders its palette dark-to-light, exactly as its
own comment says. So index 0 was the background, and `open`, `grid` and `burst` drew their subject in the
precise colour behind it.

That explains every symptom at once, and explains why it was so hard to see:

| Symptom | Explanation |
|---|---|
| Frames contained only a vignette | The core was drawn, in the background colour |
| `engine.problems` was empty | Nothing threw — the code was doing exactly what it was told |
| `burst` "worked" | Its particles are 3–10 px squares at varying alpha, so the *shadow* edge was faintly visible; its "CHORUS" text came from `colour(f.style, 2)`, a real mid-tone |
| The first suspect, `cx.layer()`, was innocent | Replacing it changed nothing, because it was never the problem |

**What was genuinely wrong was the API's shape, not the arithmetic.** Indexing a palette positionally is a
silent failure waiting to happen: reorder the palette and every scene changes meaning, with no error. So the
fix is structural rather than local:

- `SceneFrame.color(role)` is new, and it **throws** on an unknown role. There is deliberately no fallback
  parameter — a caller that wants a default can write one and own that decision in the one place it is made.
- All 17 colour lookups across the four scenes go through it.
- `lib/draw.js`'s `colour(style, index)` helper has been **deleted, not deprecated**. A helper whose misuse
  is invisible does not belong in a template other people copy.
- The four scenes' own comments record the failure, because the next person to write a scene needs to know
  why the obvious-looking expression is banned.

The lesson worth keeping: this survived `cvpw validate`, `cvpw lint`, a typecheck, and a render that wrote
four plausible PNGs. Nothing in the pipeline could see it, because every gate asked whether the film was
*valid* and none asked whether it was *visible*. `cvpw check --scenes`'s "no empty frames" rule is the gate
that would have caught it, and it is not implemented yet — which is now the strongest argument for writing
it next.

### 5. `cvpw check` exists, with the gate that was missing

Four checks are implemented and wired: `render.frameContent`, `scenes.registry`, `timeline.time`,
`text.whitelist`. `stills` and `lint` are not, and `docs/QA.md`'s twenty-four ids remain mostly
unimplemented — but the important one is done, and it is the one whose absence cost a session.

**`render.frameContent` is verified in both directions**, which is the only way to trust a gate:

| Run | Result |
|---|---|
| Correct project, `cvpw check --only render.frameContent` | **exit 0**, 28 frames sampled, min content 0.24 %, median 62.9 %, 1 thin frame reported |
| The original bug deliberately reintroduced | **exit 1**, naming `t=0.050s frame=2 shot=s01_open  the frame is 100.0 % #140b1e and nothing else` |

That second row is the whole point: the failure message identifies the time, the frame, the shot, the
dominant colour, and the cause, in one line. Someone staring at a black PNG gets their answer from the gate
rather than from a bisection.

Two design choices are worth recording because they are not obvious:

- **Measured on the canvas, not from captured bytes.** JPEG artefacts would make two identical blank frames
  differ slightly, so a threshold on captured bytes would need slack — and slack is exactly what this gate
  must not have. This is a *visibility* check, so `getImageData` is the right instrument. `frameHash` still
  comes from captured bytes for the reason ADR 0007 gives; the two are different questions.
- **The threshold is 0.0001, about 200 pixels at 1080p.** The first draft used 0.0002, and the template's
  own title card was close enough to it that a legitimate frame could have failed. A gate that fails a
  correct frame is worse than no gate, because people learn to pass `--force` and then it protects nothing.
  Frames between 0.0001 and 0.004 are reported as **thin** and never failed.

`docs/QA.md` now defines the check, including why it is not redundant with `scene.emptyFrames` (which counts
times with no active shot) or `render.noDeadFrames` (which compares consecutive frames of the master):
neither asks whether a frame contains anything, and a shot drawing its subject in its own background colour
satisfies both while being completely black.

### 6. `cvpw render` produces an MP4, and `--workers` does not change it

**Both halves of the framework's central claim now hold, verified by hash.**

| Claim | Measurement |
|---|---|
| A render is reproducible | two sequential renders: identical MP4 SHA-256, 24/24 frame hashes equal |
| `--workers` is output-neutral | `--workers 1` and `--workers 4`: **byte-identical MP4** (1,354,902 bytes, same SHA-256), 24/24 frame hashes equal |

A 240-frame film renders to a valid MP4 — `h264`, 1920×1080, `yuv420p`, exactly 240 frames, exactly 8.000 s,
1.3 MiB, 64–90 ms/frame through the hardware rasteriser. The encoder probe correctly rejects `h264_nvenc`,
which ffmpeg *lists* and which fails with exit `-22 Invalid argument`: the case ADR 0006 exists for.

**Getting there meant finding the worst bug in the project — a two-line fix behind a false trail.** An earlier
revision of this file recorded the opposite conclusion: that `--workers 4` produced a different film and that
the cause was an unresolved order-dependence in the scenes. Both halves of that were wrong.

The trail, in the order it was walked:

1. `--workers 4` differed from `--workers 1` at frames 200/210/220/230 → looked like a chunking problem.
2. Frame 180 matched from every start, frame 200 from none → looked like a bug in the `hold` scene.
3. `hold` rendered **three different images** from three walk histories, while its scene arithmetic — printed
   into the frame as text — was **identical to nine decimal places** in all three. That ruled out arithmetic.
4. JPEG captures of one fixed frame were perfectly stable (1 distinct hash in 6), while the *pixel digest*
   changed once and then stabilised. That pointed at GPU readback timing.
5. Two *identical* walks in two sessions gave 0/6 differing hashes, proving the harness was sound and the
   divergence real rather than noise.
6. Rendering with an explicit synchronisation after every draw: **0/3 differing**. Without it: **3/3**.

The cause: **canvas drawing is queued and returns immediately, so a screenshot can rasterise a frame whose
draw calls have not all executed.** Nothing errored, nothing warned, and the result depended on how much work
was queued — a function of how far a worker had walked and how often it had captured. A one-pixel
`getImageData` read forces the queue to drain and cannot itself change a pixel.

Two changes, both measured:

- **`Browser.flush()`** after every draw and before every capture. This removed the *drift*: the differences
  moved from frames scattered through `hold` to exactly the chunk-boundary frames 60, 120 and 180.
- **Warm-up walks from the film's start**, not a couple of frames back. This removed the boundary difference,
  because a chunk's first frame is drawn with a different amount of queued work behind it than the same frame
  drawn mid-walk. The cost is real: a 4-way split walks 0+60+120+180 = 360 frames of warm-up for a 240-frame
  film, roughly 2.5× the drawing. `--workers 1` pays nothing and is byte-identical to any other count, which
  is what makes the knob safe to raise.

`workers` in `templates/project/project.json` is back to 2, and the renderer warns only in the one case that
genuinely is not reproducible: parallelism with `warmupFrames: 0`.

**The lesson worth keeping.** Every one of the first five observations was consistent with "the scenes are
order-dependent", and that explanation would have been accepted by anyone reading the report. It was wrong.
What broke it open was printing the scene's own arithmetic *into the frame as text* and finding it identical
in all three sessions — at which point the arithmetic could not be the cause, and the only thing left was the
instrument. When a measurement says something surprising, suspect the measurement before rewriting the code
it accuses.
### 7. The determinism guarantee is now a regression test, not a claim

`cvpw gold` takes a baseline at `qa/gold.json`; `cvpw check --only determinism.gold` compares the current
render against it. Both are verified in **all three** directions, which is the only way to trust a gate:

| Run | Result |
|---|---|
| No baseline yet | **exit 0, SKIP** with the command that creates one. A gate that fails until a baseline exists is a gate people disable on day one. |
| Baseline taken, nothing changed | **exit 0**, 13 frames compared, 0 differing |
| The `hold` scene given a visible magenta rectangle | **exit 1**, `frame 200 expected 0ab9fa93… observed a1cb2056…` — and exactly the three frames in that shot, no others |

Three design decisions in it are deliberate:

- **Frames are captured the way a render captures them** — render, `flush`, encoded screenshot — rather than
  by reading canvas pixels. The witness has to be the artefact that ships, and this is why the gate would
  have caught the queued-canvas bug: a pixel read does not go through the same path.
- **A run walks from the film's start**, even when it only compares late frames. A frame's pixels depend on
  how much work was queued before it, so a gate that jumped straight to frame 200 would witness a frame
  nobody ships. This makes the gate slow, and that is the correct trade.
- **The verdict is on a 6-bit-quantised hash**, with the byte-exact hash of the captured frame recorded
  alongside. Quantising keeps GPU float noise from failing the gate while a scene that changes colour still
  does; recording both means a report can always say which view disagreed.

Writing it also found and fixed a second, unrelated contract break: `render/report.json` was writing a
`probe` key that `schemas/render-report.schema.json` rejects, so **every render produced an artifact that
failed `cvpw validate`** — including the renders whose hashes this session's conclusions rest on. The
ffprobe result now lives in `run.verified`, inside the schema, and the distinction it records is the useful
one: `frames` is what the sink wrote, `run.verified.frames` is what the file contains, and those two
disagreeing is precisely the failure `render.frameCount` exists to catch.

`docs/PROGRESS.md`'s "not started" list is down to `@cvpw/runtime` and the phase-2 features. The framework
now scaffolds a project, validates it, storyboards it, checks it, renders it reproducibly, and can prove the
render has not changed.
### 8. `@cvpw/runtime` is implemented — and it found a module-instance trap

The last contract-only package now loads a project without a browser: it imports the scene and style modules
with a **tripwire `document`**, resolves every `at`/`to` through the timebase, validates each shot's args the
way the engine would, and collects every problem instead of throwing on the first — so three broken times
report three, not one per round trip.

Verified against the real demo project, headlessly:

```
registered scenes: burst, grid, hold, open
shots: 4   problems: 0   warnings: 0
  s01_open   open    0.000–2.496  frames 0-75    args={pulse:0.4, rings:3, hue:0.08, label:"01"}
  s02_grid   grid    2.496–4.000  frames 75-120  args={density:7, hue:0.55, snap:0.14, travel:0.9}
  s03_burst  burst   4.000–6.500  frames 120-195 args={count:90, hue:0.08, …}
  s04_hold   hold    6.500–8.000  frames 195-240 args={title:"EXAMPLE", sub:"replace me", …}
```

**The trap worth recording.** The first version imported the manifest successfully and then reported *every
scene as unknown*. The cause: a project **vendors its kernel** into `vendor/kernel/`, and its scene modules
import that copy, so `scene({...})` registers into the vendored kernel's registry — while the loader imported
its own `@cvpw/kernel`, a different module instance with a different registry. Two libraries, one name, and
`scenes.names()` returning `[]` while the import succeeded.

The fix is that the loader takes its registries from **the project's** kernel (`kernelEntry`, defaulting to
`vendor/kernel/dist/index.js`), which is also the honest model: the browser runs the vendored kernel, so a
loader that disagreed with it would be validating a film nobody renders.

`cvpw storyboard` now runs the loader as an **independent cross-check** on its own resolution. Two resolvers
agreeing is a check; one agreeing with itself is not — and a disagreement is reported as a warning naming both
times, which is far cheaper than a render that cuts at the wrong instant.

**Nine new tests** cover the resolution paths that matter: bar/half-beat/cue expressions, three broken
expressions reported as three problems with the right shot ids, an unknown scene named against what *is*
registered, a missing timeline naming the command that writes it, a coverage gap as a warning rather than an
error (a gap is still renderable), args rejected per shot, and style defaults filled the way the browser fills
them.

### 9. The engine draws, but nothing unit-tests it

`packages/kernel/src/engine.ts` now draws every frame of a real film — four shots, 240 frames, three stills
reviewed by eye, a contact sheet, a determinism baseline over eleven witnesses. **What it still has no unit
tests**, which is the remaining gap: the evidence that it works is end-to-end, so a regression would be caught
only by re-rendering a whole film.

The *renderer's* riskiest assumption, however, is settled. An earlier revision of this file named "is a
browser frame byte-reproducible?" as the highest-risk unproven claim. Four scripts under `scripts/` now
answer it, and the answer changed a design. Full measurement and reasoning:
[ADR 0007](./adr/0007-warmup-frames-and-first-frame-instability.md). In short:

| Measured | Result |
|---|---|
| Two sessions, identical sequence | 7/7 byte-identical |
| Three sessions, 24 frames | 24/24 identical, byte histograms equal |
| Five sessions, 25 frames each | 25/25 identical |
| Two identical walks in **one** session | 2 frames differ: 0 and 1 |
| Chunk boundaries at frames 14 and 28 | stable — chunking is safe |
| Warm-up before capture | tried three ways, including drawing the exact frames to be captured: **no effect** |

What this bought: the `FrameSink` ordering invariant is confirmed *sufficient* rather than assumed;
`--workers` does not change the film; and three requirements fall out that would otherwise have been
discovered late —

1. `qa/gold.json` MUST exclude the first `warmupFrames` frames. A check that fails on a coin flip is a
   check people learn to ignore.
2. `frameHash` MUST be computed from captured frame bytes, not an in-page pixel read. Readback proved
   stable, so in-page hashing would *work* — but it witnesses the canvas, not the deliverable, and the
   two can diverge once encoding settings are involved.
3. `project.json::render.warmupFrames` (default 2) discards those frames at the head of a render, so a
   re-render reproduces the previous render rather than a session's first attempt.

What it cost: an honest admission that the cause is not understood, only measured. That is why the spike
scripts stay in the repository as a regression check to re-run after a browser or driver update, and why
`warmupFrames` is a project knob rather than a constant in the renderer.

Also verified about the render path: the browser is discoverable, its WebGL renderer is real hardware
(`ANGLE (NVIDIA … D3D11)`, not SwiftShader), and the encoder probe correctly rejects `h264_nvenc`. The CDP
client and the static server that `@cvpw/render` exports are implemented and exercised by these spikes;
what remains unimplemented is the frame sink, the worker loop and the ffmpeg driver.

### 10. Not started, as planned for phase 2

Asset generation and chroma-key; lyric forced alignment (only the LRC path and the timing-table design
exist); the WebGL2 post chain; the Blender bridge; the style registry's first real styles; the streaming
frame transport. Their contracts are reserved so that adding them cannot break a v0.1 artifact.

---

## Departures from the spec, with reasons

**D1. `analysis/overview.png`, `handoff.report.json` and the other reports are derived artifacts that
carry a run record.** `docs/SPEC.md` A6 was amended (not violated) to permit exactly three report
artifacts to carry a timestamp, and to forbid every other derived artifact from doing so.
`analysis/audio.json` still carries `generatedAt: null`. This departure is now codified in A6.

**D2. `handoff.json` no longer contains a `measured` block.** The original contract put measurement
results inside the authored contract file, which made it non-reproducible and therefore a violation of
A6. Measurements moved to `handoff.report.json`. This is a **breaking change to the design**, made before
any implementation depended on it, and it is recorded in `docs/CONTRACTS.md` §9.

**D3. `project.json` gained `style` and `lyricsText`.** Both were required by CONTRACTS §7 and by the
style registry while §2's schema rejected unknown keys — an unsatisfiable requirement, caught by a
review pass. See ADR 0003 for why unknown keys stay rejected rather than being tolerated.

**D4. The tempo estimator's scoring is documented at length in code comments.** Four successive
implementations were each falsified by the framework's own fixture (40 BPM, then 60, then 120, then
240 for an exactly-120-BPM signal). The reasoning for each term is in `python/src/cvpw_py/tempo.py`
rather than in a separate design note, because the terms are not independently justified — each exists
to close a hole the previous one left, and a reader who removes one needs to see the failure it caused.

**D5. A weak tempo prior was added, which is a musical preference encoded in an algorithm.** It corrects
a genuine measurement bias — the doubled grid fits a click track better than the true grid — but it is
still a prior, its exponent is a judgement, and it is cross-checked against the fixture. Recorded here
because a prior that is not written down is indistinguishable from a bug.

**D6. The first ~2 analysis frames of a file are under-detected.** A 1024-sample window at a 24 kHz
analysis rate spans 43 ms, so an onset at 20 ms sits inside a partly zero-padded window and measures at a
fraction of its true energy. On the fixture this lost the declared first downbeat and put the reported
grid origin at 0.491 s instead of 0.02 s. The grid is internally consistent to 5.3 ms, so the film is
unaffected — but `verify-ground-truth` therefore checks phase against the *grid*, with the declared first
beat accepted at any whole number of periods, and the limitation is asserted rather than hidden.

**D7. `python/src/cvpw_py/wav.py` writes the fixture with the standard library, not `soundfile`.**
`cvpw doctor` is supposed to be able to prove the toolchain works before anything is installed, which
means the self-test signal must not depend on a package that might be absent.

---

## Handover

To continue, in this order:

1. **Unit tests for the engine** — `renderFrame(t)` is proven end-to-end and by hash, but `engine.ts` has no
   focused tests, so a change to the layer pool or the transition maths is caught only by re-rendering.
2. **The gate ids `docs/QA.md` still lists** — `render.frameCount`, `av.sync`, `flash.rate`, `text.safeArea`,
   `text.legibility`, `timeline.pacing`, `render.noDeadFrames`. The suite runs five of twenty-four.
3. Then phase 2: the WebGL post chain, asset generation and chroma-key, lyric forced alignment, the Blender
   bridge.

**What is proven now, end to end and by hash:** a project scaffolds itself from the template, analyses real
audio into a measured timebase, settles its cues onto that timebase, storyboards to a covered timeline,
renders stills that a human reviews, gates itself, takes a determinism baseline, measures its seams, and
delivers — fourteen steps, no failures. Rendering is reproducible and `--workers` does not change the film.
Every artifact validates against its schema, including four whose producer and contract had disagreed for
weeks because nothing consumed them.