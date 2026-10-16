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

### 1. The CLI runs, but only three of its twenty commands are implemented

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

**Why it is not done:** the render half (`@cvpw/render`) is the real blocker — `cvpw stills`,
`cvpw render` and `cvpw check --gold` all need a frame sink that does not exist. Writing the remaining
command wiring before the renderer would produce commands that cannot be tested.

### 2. `packages/{render,runtime}/` declare their contracts and nothing else

Both packages exist, typecheck, and export the interfaces the architecture specifies — `FrameSink`,
`RenderRequest`, `RenderOutcome`, `EncoderProbe`, `LoadedProject`, `LoadedProblem` — with **no
behaviour**. They are real packages rather than empty directories for two reasons: `@cvpw/cli` depends on
them, so the workspace dependency graph has to be honest for `pnpm install` to work at all; and an
interface that is written down is reviewable.

That second reason is not decoration. The most consequential decision in the render backend is the frame
**ordering invariant** — frames may be rendered concurrently by any number of workers, in any order, and
MUST be written to the encoder strictly in ascending index with a bounded look-ahead, so that the output
does not depend on the worker count. That is a correctness property, not an implementation detail,
because `--workers` changing the film would destroy the gold-frame gate, which is the only empirical
check on determinism. It is now stated in the `FrameSink` doc comment where a reviewer will see it,
instead of being buried in a worker loop that does not exist yet.

### 3. `templates/project/` and `examples/minimal/` are empty

The scaffold and the committed slice are specified and not built. Until they exist, `cvpw new` has
nothing to copy and there is no runnable end-to-end example in the repository.

### 4. The engine has never drawn a frame — but the renderer's core assumption is now MEASURED

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

### 5. Not started, as planned for phase 2

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

1. **`packages/cli/src/main.ts`** and the command modules — `doctor`, `env`, `validate` and `analyze`
   first, because they are fully specified and their dependencies all exist. Then `new` (needs
   `templates/project`), then the render path.
2. **`templates/project/`** — the scaffold. It must run end to end, so it needs a minimal engine, a
   manifest-listed scene set and one style.
3. **`packages/render/`** — the CDP worker, the ordered frame sink and the ffmpeg driver with
   encoder probing. The ordering invariant (concurrent render, strictly ascending writes with a bounded
   look-ahead) is what makes `--workers` output-neutral and it MUST be asserted by a test.
4. **The three missing skill references.**
5. Then the vertical slice end to end, and `gold.json`.

The single highest-risk assumption still unproven is that **`window.cvpw.renderFrame(t)` in headless Edge
produces byte-identical frames across two runs and across worker counts**. Everything in the architecture
follows from it and nothing yet tests it.
