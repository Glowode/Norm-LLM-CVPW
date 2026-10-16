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

### 1. The CLI runs, but only a third of its commands are implemented

`cvpw doctor`, `cvpw env` and `cvpw renderer` are implemented and work on this machine. The other
seventeen are **registered with their full flag surface and their help text**, and exit with code 3 and
an explicit "specified but not implemented" message rather than pretending to run. `cvpw --help` lists
which is which.

Verified on the reference machine:

```
$ cvpw renderer
browser   Microsoft Edge   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
renderer  ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 (0x00001C81) Direct3D11 vs_5_0 ps_5_0, D3D11)
          [hardware]

$ cvpw doctor --quick
0 REQUIRED missing, 1 degraded
encoder: libx264 (software)   # h264_nvenc probed and REJECTED: "Task finished with error code: -22"
```

The hardware renderer is real, which is the one piece of the render path that can be confirmed without
`@cvpw/render`. The encoder probe correctly refuses `h264_nvenc` — a different error text than the
earlier `-40` (this one is `-22`, an invalid-argument failure inside the encoder) but the same verdict,
reached the same way: by attempting an encode.

**Consequence:** `cvpw validate`, `cvpw analyze`, `cvpw render` and the rest do not run. The analysis
half of the slice is exercised directly through `python -m cvpw_py`, which is a real module with a real
`main()` precisely so that this is possible. `packages/cli/src/{shared,args,validate,doctor,browser}.ts`
are complete; what is missing is the command wiring, which is mechanical.

**Why it is not done:** the remaining commands need `templates/project/` to exist before `new` and
`render` can be exercised end to end. `validate`, `analyze`, `lint` and `check` are not blocked by
anything and are mechanical wiring over implementations that already work.

### 2. `@cvpw/render` is implemented except the CLI wiring; `@cvpw/runtime` is still contract-only

`@cvpw/render` now has real implementations — `cdp.ts`, `server.ts`, `sink.ts`, `ffmpeg.ts`,
`render.ts`, `exec.ts` — with **25 tests** covering the sink's ordering invariant, its refusals, its
back-pressure and its chunk planner. What is missing is the `cvpw render` / `cvpw stills` command wiring.

`@cvpw/runtime` still exports its interfaces with no behaviour. Nothing depends on it yet except the
`validate` and `storyboard` commands that are not written.

**Three real bugs were found by testing this, and each is worth recording because all three looked right:**

1. **The sink's default extension was `"jpg"`.** `pathFor()` therefore reported a path that did not exist
   for any non-JPEG capture. The extension is now derived from the first frame's encoding when the caller
   does not name one — deciding it at construction cannot know what the frames will be.
2. **Back-pressure deadlocked.** The first version waited for "the next commit", which is a different
   event from the one that makes room: if the frame at `next` is never produced, no commit happens and the
   producer blocks forever holding a frame it already rendered. The second version waited on `next`
   advancing and was *worse*: every blocked writer wakes on the same advance, re-checks a buffer size that
   has not shrunk, and `write(3)` into a sink with `lookahead: 3` never returned at all. The correct
   condition is about the frame in hand — accept it when it is within `lookahead` of `next`, otherwise
   wait until `next` reaches a value the producer computes up front, which cannot deadlock.
3. **A blocked writer was not released on abort**, so a failed render could hang a worker forever waiting
   for a frame that would never arrive.

All three were caught by the sink tests rather than by a render, which is the point of testing the
ordering invariant directly: it is a correctness property, and the failure it prevents — a film with one
frame in the wrong place — is invisible without it.

### 3. The blank-frame bug is FOUND AND FIXED — and it was a template bug, not a framework one

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

### 4. `cvpw check` exists, with the gate that was missing

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

### 5. `cvpw render` produces an MP4, and `--workers` does not change it

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
### 6. The determinism guarantee is now a regression test, not a claim

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
### 7. `@cvpw/runtime` is still contract-only

### 8. The engine has never drawn a frame — but the renderer's core assumption is now MEASURED

`packages/kernel/src/engine.ts` typechecks and its contract is specified, but no test renders through it.
**The engine half of the vertical slice is unproven.**

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

### 9. Not started, as planned for phase 2

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

1. **`qa/gold.json` and `cvpw check --determinism`.** This is now unblocked and is the highest-value next
   step: `--workers` is output-neutral and a render is reproducible, so a gold baseline is finally meaningful.
   It is the gate that turns "reproducible" from a claim into a regression test.
2. **The remaining CLI commands** — `analyze`, `cues`, `lyrics`, `lint`, `sheet`, `review`, `handoff`,
   `deliver`, `skill` — over implementations that already exist or are specified.
3. **Then `cvpw analyze` for a scaffolded project**, so the template's `cue(...)` expressions can become
   `b()`, `h()` and `HIT(...)` and the framework's central claim — that a cut lands on a measured beat —
   becomes demonstrable rather than merely implemented.
4. **`@cvpw/runtime`** — the DOM-free loader, needed by `cvpw check`'s cross-artifact gates.
5. Then `examples/minimal/`, and `gold.json` with its first baseline.

What is proven now: a project scaffolds itself, validates, storyboards, and renders four visually correct
1920×1080 shots through headless Edge — amber core and rings, lit grid, particle burst, title card — with
the kernel vendored so the project is self-contained and movable.
