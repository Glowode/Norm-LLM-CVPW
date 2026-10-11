# ARCHITECTURE — layers, contracts and accumulation points

**Status:** descriptive, binding on structure. **Authority:** [SPEC](./SPEC.md) §1.
ARCHITECTURE.md is deliberately absent from the authority ladder in [SPEC](./SPEC.md) §1, so it holds
no new rules: where it disagrees with [SPEC](./SPEC.md), [CONTRACTS](./CONTRACTS.md) or
`schemas/*.schema.json`, they win and this file is the bug. Where it disagrees with code, the
code-vs-doc rule in [SPEC](./SPEC.md) §1 decides, and the loser is fixed in the same change.

**What this document is for.** Norm-LLM-CVPW turns a song plus a `timeline.json` into an MP4 by drawing
every frame as a pure function of time inside a browser page and encoding the resulting frames with
ffmpeg. This file names the layers, states the one dependency invariant, fixes the exact interface the
page exposes to the capture backend, and lists the accumulation points where new capability is
*registered* rather than patched in. Procedure lives in [WORKFLOW](./WORKFLOW.md); artifact definitions
live in [CONTRACTS](./CONTRACTS.md); recipes for adding things live in [EXTENDING](./EXTENDING.md).

---

## 1. Layers

```
(g)  skills/cvpw · cvpw-timing · cvpw-qa        templates/project/          agent surface
     ─────────────────────────────────────────────────────────────────────────────────
(e)  @cvpw/cli        cvpw <cmd>    packages/cli/src/cmd/*.ts              orchestration
     ─────────────────────────────────────────────────────────────────────────────────
(d)  @cvpw/render     @cvpw/runtime    @cvpw/audit    |  (f) python/src/cvpw_py/   tooling
     cdp·chrome·sink  proxy-timeline   acorn rules    |      numpy + soundfile
     ─────────────────────────────────────────────────────────────────────────────────
(c)  engine/index.html · engine/timeline.js · scenes/ · lib/ · styles/     authoring surface
     ─────────────────────────────────────────────────────────────────────────────────
(b)  @cvpw/kernel  engine · time · timebase · rng · util · ease · layer ·  pure render core
                   camera · font · overlay · plugin
     ─────────────────────────────────────────────────────────────────────────────────
(a)  schemas/*.schema.json   ← defined by   docs/CONTRACTS.md               contracts
```

Imports point **downward only**. Tier (f) is a side tier, not a rung: the CLI invokes `cvpw_py` as a
subprocess over JSON artifacts, so (f) never imports (e) and never joins the frame-drawing path.

| # | Layer | Lives in | Purpose | MAY import | MUST NOT import |
|---|---|---|---|---|---|
| a | Contracts | `docs/CONTRACTS.md`, `schemas/*.schema.json` | Define every artifact, the time-expression grammar and the handoff vocabulary once, in prose and in machine-checkable form. | nothing — data only | anything executable; a schema MUST NOT admit a key that [CONTRACTS](./CONTRACTS.md) §1 does not catalogue |
| b | Pure render core | `packages/kernel/src/` (`engine`, `time`, `timebase`, `rng`, `util`, `ease`, `layer`, `camera`, `font`, `overlay`, `plugin`) | Turn `(timeline, timebase, t)` into pixels: time resolution, seeded randomness, layer order, the plugin registry. | browser platform globals (`document`, `CanvasRenderingContext2D`, `FontFace`, `fetch` for project-local files) and its own modules | `node:*`, `process`, `Buffer`; `@cvpw/render`, `@cvpw/runtime`, `@cvpw/audit`, `@cvpw/cli`; `cvpw_py`; ffmpeg; any network host |
| c | Authoring surface | a project's `engine/` (`index.html`, `timeline.js`, `scenes/`, `lib/`, `styles/`); scaffolded from `templates/project/` | Hold one project's scenes, styles, layout helpers and page shell. The only layer an author edits. | `@cvpw/kernel` public entry, `engine/lib/*`, sibling scenes and styles, project artifacts (`project.json`, `timeline.json`, `handoff.json`) read as data | `@cvpw/render`, `@cvpw/cli`, `@cvpw/audit`, `cvpw_py`, `node:*`; another project's directory |
| d | Tooling | `packages/render/src/` (`server`, `cdp`, `chrome`, `sink`, `ffmpeg`, `probe`, `keep`), `packages/runtime/src/` (`proxy-timeline`, `validate`, `storyboard-data`), `packages/audit/src/` (acorn rules) | Drive the page over raw CDP, capture frames, encode them; validate and lint artifacts without a DOM. | `@cvpw/kernel` (time resolution and types), Node stdlib, `acorn` in `audit` | each other's internals — import the package entry, never a deep path; `@cvpw/cli`; browser APIs in `audit`/`runtime` |
| e | Orchestration | `packages/cli/src/cmd/*.ts` | Sequence a stage, resolve thresholds, own exit codes and the `--json` envelope. | everything below | — top of the code stack |
| f | Analysis toolchain | `python/src/cvpw_py/` | Audio measurement: tempo, beats, bars, sections, onsets, stops, envelope, lyric alignment. | numpy, soundfile, the Python stdlib, optional `librosa` | Node/TS packages; browser APIs; any threshold not declared in [QA](./QA.md) or `project.json::budgets` |
| g | Agent surface | `skills/cvpw/`, `skills/cvpw-timing/`, `skills/cvpw-qa/`, `templates/project/` | Teach an agent with no memory of this repo the commands, the order and the refusals; scaffold a project that already satisfies the contracts. | markdown, and `cvpw` invoked as a subprocess | framework internals: a skill MUST NOT import a package, restate a rule with different numbers, or hold logic that is not a documented shim over `cvpw` |

---

## 2. The dependency-direction rule (invariant)

```
MUST NOT   @cvpw/kernel  →  @cvpw/render | @cvpw/runtime | @cvpw/audit | @cvpw/cli | cvpw_py
MUST NOT   @cvpw/kernel  →  any Node builtin (node:fs, node:child_process, node:path), process, Buffer
MUST NOT   any package   →  a deep path inside another package (`@cvpw/kernel/src/timebase.js`)
MAY        @cvpw/render | @cvpw/runtime | @cvpw/audit  →  @cvpw/kernel
MAY        @cvpw/cli     →  everything
```

**Why.** The kernel MUST run in a plain browser page with no Node globals, because preview and export
then share one code path. That equivalence is what makes the frame a pure function of time
([SPEC](./SPEC.md) §4): if the exported frame came from a different code path than the previewed one,
"deterministic" would only mean "deterministic per backend", and every gate in
[WORKFLOW](./WORKFLOW.md) stage 6 would be measuring a picture nobody ships. A Node import inside the
kernel does not just add a dependency; it forks the renderer into two implementations that will drift.

**Enforcement.** `tests/unit/architecture.test.ts` walks `packages/*/src/**/*.ts`, parses import
specifiers and fails on any forbidden edge above — in `pnpm test` and in CI. `@cvpw/audit` exposes the
same edge list as lint rule `import.direction`, so a project's `engine/scenes/*.js` cannot reach for
`node:fs` either. Relaxing the rule is an architecture change: it MUST go through an ADR in `docs/adr/`
([SPEC](./SPEC.md) §11) and MUST say which gate stops being trustworthy.

---

## 3. The render contract

The page exposes exactly five members. This is the whole interface between `packages/render/src/cdp.ts` and a project's engine.

```js
window.cvpw = {
  ready,               // Promise<void>
  renderFrame(t) {},   // (t: seconds) => void      synchronous, pure
  meta,                // { duration, fps, width, height, renderer, software, warnings[] }
  probe(t, drawFn),    // (t, (ctx, t) => void) => { hash: string, ms: number }
  frameHash(t) {}      // (t: seconds) => string     hex
};
```

| Member | Contract | Called by |
|---|---|---|
| `ready` | Resolves only after fonts (`document.fonts.ready`), project-local assets, the timebase and the compiled timeline are loaded. The container MUST NOT draw before it resolves. A rejection MUST fail the run with the error text on stderr and a non-zero exit — never a blank frame. | `cdp.ts`, before the first `renderFrame` / `frameHash` |
| `renderFrame(t)` | Draws the full composite for absolute time `t` (seconds) into the canvas backing store. MUST be synchronous, MUST be a pure function of `t` plus immutable time-invariant inputs ([SPEC](./SPEC.md) D1), and MUST NOT schedule deferred work (`requestAnimationFrame`, `setTimeout`, a promise callback that draws after return). | the frame loop |
| `meta` | `{ duration, fps, width, height, renderer, software, warnings[] }`. `renderer` is the unmasked GPU string; `software` is `true` for SwiftShader / WARP / llvmpipe / Microsoft Basic Render Driver; `warnings[]` carries named degradations such as `envelope.missing` ([CONTRACTS](./CONTRACTS.md) §5). | `doctor`, `render`, `check`, report writers |
| `probe(t, drawFn)` | Runs `drawFn(ctx, t)` against the live canvas at `t` and returns `{ hash, ms }` **without** writing to the sink. Called with the engine's own composite function, its hash MUST equal `frameHash(t)`. | `stills`, `sheet`, `check --scenes`, `handoff`, per-frame budget checks |
| `frameHash(t)` | Deterministic content hash of the composited frame at `t`, hex ([SPEC](./SPEC.md) D7). MUST be computed from the pixels that would be encoded — after the post chain — so the hash witnesses the whole draw path rather than the draw code alone. | `check --gold`, `render` (`render/report.json::frameHashes`) |

**Software rasterisation MUST be an explicit choice.** `meta.renderer` is inspected on every run, because
a headless browser silently falls back to a CPU rasteriser and that path is roughly **10× slower**.
`cvpw render` MUST refuse to start (exit 1) when `meta.software === true`; the operator opts in with
`--allow-software`, recorded in `render/report.json::software`. The capture backend passes GPU-enabling
flags to the browser, but flags are a *request* — `meta.renderer` is the *evidence*
([SPEC](./SPEC.md) P6, [WORKFLOW](./WORKFLOW.md) stage 0 acceptance 2).

---

## 4. Registration: the plugin registry

`packages/kernel/src/plugin.ts` is the accumulation point named in [SPEC](./SPEC.md) §0. It exports four
registration functions over plain `Map`s — no subclassing, no monkey-patching, no core edits.

```js
// a project's engine/scenes/beat.js
import { scene } from '../lib/registry.js';   // re-export of @cvpw/kernel/plugin

scene('beat', {
  argsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      hue:    { type: 'number',  minimum: 0, maximum: 1,  default: 0.1 },
      pulses: { type: 'integer', minimum: 1, maximum: 64, default: 8 }
    },
    required: []
  },
  preload: async (api) => { /* fonts, images; once per page, may await local files */ },
  init:    (api, args) => { /* per-shot setup; no clock, no entropy, no DOM writes */ },
  draw:    (ctx, args, t, api) => { /* pure function of t; layout helpers only (SPEC C7) */ }
});
```

```js
// the only other file a new scene touches — one line, no discovery magic
export const scenes = ['./beat.js', './titles.js', './chorus.js'];   // engine/scenes/manifest.js

// other registries, same mechanism, different consumer
transport('filesystem', { open, write, close, abort });   // packages/render/src/sink/filesystem.ts
check('flash.rate', { threshold: 'qa:flash.rate', run }); // packages/cli/src/check/flash.ts
style('night', { palette, defaults, post });              // engine/styles/night.js
```

| Registry | Registered by | Consumed by | Duplicate name |
|---|---|---|---|
| `scene` | project `engine/scenes/*.js` | kernel engine, `@cvpw/runtime` (args validation) | error; overridable only with `{ override: true }`, and the override is printed |
| `style` | project `engine/styles/*.js` | scenes via `api.style()` | error, same rule |
| `transport` | `@cvpw/render` | `cvpw render` | error, same rule |
| `check` | `packages/cli/src/check/` | `cvpw check` | error, same rule |

**Registration, not modification.** Adding capability MUST NOT edit `packages/kernel`, `packages/cli` or
any other shared file. A shared change is a *request* recorded in `docs/INTEGRATION_NOTES.md`
([SPEC](./SPEC.md) S2).

**Discovery is a manifest, not a glob.** The page cannot enumerate a directory, and a bundler-supplied
glob would make the set of registered scenes depend on the build tool — a nondeterministic input
([SPEC](./SPEC.md) D1). So `engine/scenes/manifest.js` lists module paths, each imported for its
registration side effect: adding a scene is one new file and one manifest line.

**`argsSchema` turns a scene's arguments into a validated contract.** `cvpw validate` compiles the schema
and validates every `timeline.json` shot's `args` against it; `additionalProperties: false` makes an
unknown key a hard failure naming the key and the shot id ([CONTRACTS](./CONTRACTS.md) §8). This closes
the typos-become-defaults failure ([SPEC](./SPEC.md) A4): a misspelled `huee` MUST NOT render a plausible
frame with the default hue. Defaults are applied once, at load, and the *effective* args are written to
`render/report.json`, so a reviewer sees what actually ran.

---

## 5. Determinism architecture

Determinism ([SPEC](./SPEC.md) §4) is enforced at three layers, because no single layer sees the whole
problem.

| Layer | Mechanism | Where | Catches |
|---|---|---|---|
| **Static** | AST rules via `acorn` | `@cvpw/audit`, run by `cvpw lint` | banned APIs, aliasing, absolute times, raw-resolution arithmetic, off-whitelist text, mojibake, forbidden imports |
| **Runtime** | seeded generators; `reset()` / `step(dt, t)` replay; `frameIndex(t)` | `packages/kernel/src/rng.ts`, `engine.ts` | state carried between frames, per-frame flicker, sub-frame inconsistency |
| **Empirical** | frame hashes against a committed `gold.json` | `cvpw check --gold`, `qa/gold.json`, `qa/exemptions.json` | everything the first two layers cannot express: unseeded entropy reaching the picture, GPU float paths, driver differences |

**Why AST and not regex.** A regex sees characters; determinism is a property of *bindings*. Two failure
directions both matter. Aliasing defeats it: `const clock = performance.now; clock();` and
`globalThis['Ma' + 'th'].random()` contain no banned substring a regex can trust, and widening the regex
until it matches them also matches strings and comments. And false positives poison the gate: the text
`Math.random` inside a comment, or quoted in a doc, is not a violation, but a regex cannot tell — so the
gate cries wolf, gets an allowlist, and the allowlist becomes the real policy, silently. `@cvpw/audit`
parses the file, resolves each callee to its binding, and reports the *definition site* of a banned
alias. Rule ids are stable and quoted in gate output: `determinism.bannedApi`, `timeline.absoluteTimes`
([SPEC](./SPEC.md) T2), `layout.raw-resolution` (C7), `text.whitelist` (C6), `encoding.utf8` (P4),
`import.direction` (§2).

**Runtime layer.** All randomness comes from `hash1`, `hash2`, `mulberry32`, `noise1`, `fbm1` in
`packages/kernel/src/rng.ts`, seeded from `project.json::seeds` and `frameIndex(t)`. A scene that needs
simulation declares `stateful: true` **on the shot** and exposes `reset()` + `step(dt, t)`; the engine
replays it from the shot start on every seek with a fixed sub-frame count, and adaptive sampling refuses
it ([SPEC](./SPEC.md) D3).

**Empirical layer.** `cvpw check --gold` compares `frameHash(t)` at the times committed in
`qa/gold.json` and fails with the offending times and the observed delta. A known, unavoidable
nondeterminism MUST be recorded in `qa/exemptions.json` with a date, a reason, an observed delta and an
owner ([SPEC](./SPEC.md) D8). An exemption is a reviewed decision; a silent tolerance is a bug.

---

## 6. Frame transport

```ts
// packages/render/src/sink/types.ts
export interface FrameSink {
  readonly kind: 'filesystem' | 'stream';
  open(meta: { width: number; height: number; frames: number }): Promise<void>;
  write(index: number, bytes: Uint8Array): Promise<void>;  // MUST be called in ascending index order
  close(): Promise<void>;
  abort(reason: string): Promise<void>;                    // MUST leave no output that looks complete
}
```

**`filesystem` — the v1 default.** Frames land as `render/.frames/<name>/000123.jpg` plus an index
recording `{ index, t, hash, bytes }` per frame. It is:

- **resumable** — a frame whose file exists and whose recorded hash matches is not re-rendered, so an
  interrupted render restarts at the first missing index;
- **debuggable** — the exact bytes that will be encoded open in an image viewer, which is how
  [WORKFLOW](./WORKFLOW.md) stage 6 defects are localised to a shot id;
- **ASCII-only in its temp paths** — the reference machine's console code page is 936 with a UTF-8
  console encoding, a real mojibake hazard ([SPEC](./SPEC.md) P4), so a non-ASCII path handed to ffmpeg
  or the browser is a defect even when it works locally.

**`stream` — reserved.** Page → WebSocket → ffmpeg stdin, with ack back-pressure: the page holds at most
N unacknowledged frames (default 2) and the transport acknowledges a frame only when ffmpeg's stdin has
accepted its bytes. The interface exists in v1 so call sites do not change in phase 2; the
implementation does not. Its purpose is peak disk: 29.2 GB free on the reference machine is a real
budget, and a stream sink reduces steady-state frame storage to a few frames.

**The ordering invariant.** Frames MAY be rendered concurrently by any number of workers, but they **MUST** be written to the encoder
**strictly in ascending frame index with a bounded look-ahead** (default `workers * 2` frames). The sink owns
an ordered ring: a worker that finishes frame `i` awaits until `i - 1` has been written.

This is what makes `--workers` safe to change. Encoders consume a *sequence*; if writes were issued in completion
order, the emitted stream would depend on machine speed, cache warmth and thread scheduling: two runs of the
same project would produce different files, and the frame hashes in `render/report.json` would stop being
evidence about the output. With the invariant, worker count cannot change the bytes: one worker and eight MUST agree.

---

## 7. Encoder selection

**Probe before use; never trust a listing.** `ffmpeg -encoders` reports what a build was compiled with,
not what the machine can run.

```bash
# the probe cvpw doctor and cvpw render both run, per candidate
ffmpeg -hide_banner -f lavfi -i testsrc2=size=320x240:rate=30 -frames:v 5 -c:v h264_nvenc -f null -
#   exit 0        → candidate usable, use it
#   non-zero      → next candidate; on the reference machine this exits -40 (see §9)
```

Fallback chain for H.264: `h264_nvenc → libx264`. Other families: `prores_ks` for ProRes,
`libvpx-vp9` for VP9, `mjpeg` for `render.frameCodec: "jpeg"`. `libx264` is REQUIRED to exist — a
machine without it fails `cvpw doctor`, because there would be no floor left to fall back to
([SPEC](./SPEC.md) P6). `project.json::variants.master.codec: "auto"` means "probe and pick"; the choice
is recorded as `render/report.json::codec` next to `codecRequested`, so a report never hides which
encoder produced the file. Tool paths are discovered, reported by `cvpw env --json`, and overridable by
environment variable (`CVPW_FFMPEG`, `CVPW_FFPROBE`, `CVPW_BROWSER`, `CVPW_PYTHON`); an absolute tool
path MUST NOT be hard-coded ([SPEC](./SPEC.md) P5) — the paths in §9 are observations, not constants.

Four mux rules, each a consequence of a failure that produces a plausible-looking file:

1. **Explicit BT.709 tagging.** `-colorspace bt709 -color_primaries bt709 -color_trc bt709
   -color_range tv`. The canvas is sRGB; the conversion MUST be stated rather than inherited from
   encoder defaults, or a variant rendered by a different encoder lands in a different colour space and
   nobody notices until delivery.
2. **Even width and height.** yuv420p requires it. Odd dimensions MUST fail `cvpw validate` against
   `project.json::output` ([CONTRACTS](./CONTRACTS.md) §2) — the error belongs at validation time, not
   in an ffmpeg stack trace halfway through a render.
3. **The audio offset is applied at mux time only** (`-itsoffset` / `adelay`), never by editing the
   audio file, which stays byte-identical ([CONTRACTS](./CONTRACTS.md) §2). A/V lag is then *measured*
   by `cvpw check --av-sync` instead of being assumed to be zero.
4. **Delete the output on failure.** A non-zero ffmpeg exit, a dropped frame, or an aborted sink MUST
   delete the partial MP4 (after confirming the resolved path is inside `project.json::paths.render`)
   and record the error in `render/report.json::errors`. A truncated render MUST never masquerade as a
   finished one ([WORKFLOW](./WORKFLOW.md) stage 7 failure modes).

---

## 8. Data flow for one frame

```
project.json ────┐
timeline.json ───┤
cues/cues.json ──┼─▶ cvpw validate ──▶ validated timeline   (an invalid artifact MUST refuse to run)
analysis/*.json ─┘         │
                           ▼
                 timebase (SPEC §5 T1)
                           │
                           ├─▶ resolve "at" / "to"  (packages/kernel/src/time.ts)
                           │        strict: throws with the failing token + nearest alternatives (T3)
                           │        cache ──▶ render/report.json::resolvedTimes  (CONTRACTS §3 rule 4)
                           ▼
                 active shot list at t   (later shot owns any declared transition, C1)
                           ▼
                 scene draw via the registry (kernel/src/plugin.ts)
                           ▼
                 layers: environment · actor/foreground · text · post   (C5, text stays crisp)
                           ▼
                 post chain: style post params + shot post
                           ▼
                 canvas backing store at output.width × output.height  (layout helpers, C7)
                           │
                           ├─▶ cvpw.frameHash(t) ──▶ qa/gold.json comparison (cvpw check --gold)
                           ▼
                 FrameSink.write(frameIndex)   ← ascending index, bounded look-ahead (§6)
                           ▼
                 ffmpeg: probed encoder · BT.709 · image input (§7)
                           ▼
                 render/<name>.mp4 · render/report.json · qa/report.json · <name>_stats.json
```

**Validation hooks in before the first frame.** Every stage runs `cvpw validate` before and after and
MUST refuse to run on an invalid artifact ([WORKFLOW](./WORKFLOW.md), rules that apply to every stage) —
the alternative is a render that succeeds and ships a wrong edit.

**Hashing hooks in after post, before the sink.** The hash therefore describes the bytes that are
actually encoded: a `frameHash` taken before post would stay identical while the visible picture
changed, which would make `qa/gold.json` a witness of the draw code instead of the film.

---

## 9. The reference machine (measured)

Every figure below was measured once on the machine this framework was developed against; each one changed
a design decision. No code may branch on these values; they are probed at run time ([SPEC](./SPEC.md) P6, P7;
the measured report is [ENVIRONMENT](./ENVIRONMENT.md)).

| Item | Measured | Architectural consequence |
|---|---|---|
| OS / CPU / RAM / GPU | Windows 10/11, Intel i3-10105F (4C/8T), 16 GB RAM, NVIDIA GTX 1050 2 GB, driver 32.0.15.6094 | Concurrency cap `min(16, logicalCPUs - 2)` ([WORKFLOW](./WORKFLOW.md)); beyond that GPU contention makes everything slower |
| Toolchain | Node v24.14.1, pnpm 11.22.0, npm 11.11.0, Python 3.13.5 (+ 3.13t), git 2.53.0, cargo/rustc 1.98, go 1.26, MSVC 2026 (2022 also present) | Node ≥ 20 and Python ≥ 3.10 are the REQUIRED floor ([WORKFLOW](./WORKFLOW.md) stage 0); native addons are possible but MUST NOT be required |
| ffmpeg | 8.0.1 full build at `D:\Program Files\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe` | Discovered and overridable, never hard-coded (P5). Encoders listed: `libx264`, `prores_ks`, `libvpx-vp9`, `mjpeg`, `aac`, `libopus`, `h264_nvenc`, `hevc_nvenc` |
| `h264_nvenc` | Listed, but the 5-frame probe exits **-40** | Hardware encoding MUST be probe-tested, never assumed. A listing is not evidence (§7, P6) |
| Browser | Microsoft Edge 155.0.4283.45 at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`; **no Google Chrome installed** | Browser discovery MUST tolerate an Edge-only machine; the capture path MUST NOT be Chrome-specific |
| Headless capability | `msedge --headless=new --screenshot=… file:///…` produced a valid PNG; `--remote-debugging-port=0` wrote a `DevToolsActivePort` file | Raw CDP is a viable, dependency-free frame-capture transport (§3); `packages/render/src/cdp.ts` needs no Playwright |
| Absent tooling | `uv`, `deno`, `bun`, Playwright (no browser cache) | The toolchain MUST NOT assume them; Node + pnpm + Python + ffmpeg + a Chromium-family browser is the whole REQUIRED set (P7) |
| Console encoding | Code page **936 (GBK)** with a UTF-8 console encoding; one file under `reference/` is already mojibake in this checkout | P4 is not theoretical: force UTF-8 in every child process, keep temp paths ASCII-only (§6), and let `cvpw lint` scan for U+FFFD |
| Python environment | `python -m venv` + `pip install numpy soundfile` took 14 s from wheels (numpy 2.5.4, soundfile 0.14.0); `librosa 1.0.0` on PyPI | v1 analysis is numpy + soundfile only; `librosa` is OPTIONAL, and `doctor` reports what its absence costs (P7) |
| Capacity | 29.2 GB free on `F:`; 16 GB RAM | Peak disk is a real gate: `project.json::budgets.peakDiskGb`, and the reserved `stream` sink (§6) exists to remove that cost |

---

## 10. Where to put a new thing

| You are adding… | Put it in | and you MUST also update |
|---|---|---|
| A new visual idea | a scene: `engine/scenes/<name>.js` + one line in `engine/scenes/manifest.js` | the scene's `argsSchema`; a shot in `timeline.json` with a `moment`; the `docs/STORYBOARD.md` row; `tests/fixtures/` if a fixture references the scene; a still the agent has actually looked at ([SPEC](./SPEC.md) V3). Recipe: [EXTENDING](./EXTENDING.md) §1 |
| A new palette or look | a style: `engine/styles/<name>.js` + the styles manifest | `project.json` selection — a new first-class key needs a row in [CONTRACTS](./CONTRACTS.md) §2 and `schemas/project.schema.json` first, otherwise A4 rejects it and it lives under `extensions`; `docs/CONCEPT.md`; the variant note. Recipe: [EXTENDING](./EXTENDING.md) §2 |
| A new artifact contract | `schemas/<name>.schema.json` (`$id`-anchored, `additionalProperties: false`) | a catalogue row in [CONTRACTS](./CONTRACTS.md) §1; a **failure-mode** entry in the same document; writer/reader registration in `packages/cli/src/cmd/validate.ts`; a fixture in `tests/fixtures/`; a conformance test. Recipe: [EXTENDING](./EXTENDING.md) §4 |
| A new QA gate | `packages/cli/src/cmd/check.ts` plus a check module in `packages/cli/src/check/<id>.ts` | its threshold in [QA](./QA.md) or `project.json::budgets` — never in code ([SPEC](./SPEC.md) V5); a row shape in `schemas/qa-report.schema.json`; an offenders-bearing `--json` result. Recipe: [EXTENDING](./EXTENDING.md) §6 |
| A new analysis pass | `python/src/cvpw_py/<pass>.py` plus its CLI entry | a `notes` provenance string ([SPEC](./SPEC.md) A7); a synthetic ground-truth fixture under `python/tests/`; a `doctor` line if it needs an optional dependency. Recipe: [EXTENDING](./EXTENDING.md) §7 |
| A new agent capability | a skill reference: `skills/<bundle>/references/<topic>.md` | a row in that bundle's references table with a "read when" condition, and a shim script under `scripts/`. Recipe: [EXTENDING](./EXTENDING.md) §8 |
| A new CLI command | `packages/cli/src/cmd/<name>.ts` | registration in the command table; the `--json` envelope; exit codes 0/1/2/3; a stage section in [WORKFLOW](./WORKFLOW.md). Recipe: [EXTENDING](./EXTENDING.md) §5 |
| A new stage | append it to [WORKFLOW](./WORKFLOW.md) | never insert or renumber (stage numbers are stable); a matching `cvpw` command inside it; a checkpoint if a human must look |

One rule covers the table: **if the change cannot be expressed as a new file plus one registration line
in an existing manifest, the design is wrong** — write an ADR in `docs/adr/` ([SPEC](./SPEC.md) §11)
before writing code.

---

## 11. Known architectural limits of v1

Stated because an undocumented limit is indistinguishable from a bug, and because each one has a designed exit.

| Limit | What v1 does | Cost to lift |
|---|---|---|
| Canvas2D engine only | the frame is drawn with Canvas2D and the post chain | WebGL2 post is phase 2 **under the same `window.cvpw` contract** (§3), so scenes and gates do not change; only `meta.renderer` reporting gains a dimension |
| Two live shots per frame, maximum | a shot plus the one transition that overlaps it; a three-way overlap MUST fail validation | requires an explicit compositing order in `timeline.json`, i.e. a contract change, not an engine tweak |
| No NLE or interchange export | no EDL / FCPXML / OTIO writer; the edit lives in `timeline.json` | a new artifact contract plus an exporter ([EXTENDING](./EXTENDING.md) §4); downstream editing is currently a re-authoring |
| Single audio track | one `project.json::audio.file`, passed through bit-identically apart from the mux-time offset | multi-track mixing is a schema change plus a mix stage; it MUST NOT be smuggled into the mux step |
| No loudness normalisation | no EBU R128 / `loudnorm` measurement or gain | a `cvpw_py` pass plus a budget row in [QA](./QA.md); doing it in ffmpeg at mux time would make the render non-reproducible from its declared inputs |
| No responsive layout solver | fixed design space plus the `safe`/`subtitleBand` insets from `project.json::output`, read through `engine/lib/layout.js` | a constraint solver is a new module behind the same helpers, so scenes keep compiling — but the variants gate then needs per-variant coverage, not one crop |
| Constant-tempo assumptions in the v1 analysis | `beats[]`/`bars[]` are tracked and MAY drift ([SPEC](./SPEC.md) T5), but real rubato defeats the model | rubato is **reported as a limitation** in `analysis/audio.json::notes`, never silently mishandled: a wrong grid poisons every downstream time expression, so an honest "uncertain" beats a confident lie |

---

## 12. Reference prior art

The six projects under `reference/` are the evidence base this design was extracted from: each solved a real problem the hard way, and the lesson is what was ported, never the file.

| Project | What it contributed to this design | Where it landed |
|---|---|---|
| `reference/vocaloid-style-mv-pipeline` | skill packaging with progressive disclosure, `check_env` before any work, work split into explicit phases | `skills/` layout with a references table, `cvpw doctor`, the eight stages in [WORKFLOW](./WORKFLOW.md) |
| `reference/dalabengba-mv` | block partition with a seam contract, the lint pass, pops/jump detection, warp and canonical time | `docs/BLOCKS.md`, `handoff.json`, `@cvpw/audit`, `cvpw handoff`, timebase as canonical time |
| `reference/pdoom-video` | CTC alignment toolchain, adaptive sampling, provenance `notes` on derived data | `cvpw lyrics --join`, adaptive sub-frame sampling, [SPEC](./SPEC.md) A7 |
| `reference/world-execute-me-lyric-mv` | frame sink with ack back-pressure, cue registry with provenance, storyboard imported headlessly, tile-diff regression, text-free lyric timing | `FrameSink` (the reserved `stream` sink), `cues[].source`, headless `cvpw storyboard`, tile-diff in `cvpw check`, the `lyrics.json` / `lyrics.timing.json` split ([SPEC](./SPEC.md) T7) |
| `reference/world-execute-web` | a time vocabulary that throws instead of defaulting, the edit table, timeline validation, binary float32 feature layout | the time-expression grammar with strict resolution ([CONTRACTS](./CONTRACTS.md) §3), `timeline.json` validation, `analysis/envelope.f32` |
| `reference/abstract-algebra-promo` | CDP-direct export with an ordered writer, worker-count independence, a cue sheet extracted from the picture | `packages/render/src/cdp.ts`, the frame-ordering invariant (§6), `cvpw sheet --cues` and the handoff strips |

**Read-only prior art.** Nothing under `packages/`, `python/`, `skills/` or `templates/` MAY import,
copy, symlink or build from `reference/`; it is not a workspace package and no build step may read it. A
lesson is ported by re-implementing it against [CONTRACTS](./CONTRACTS.md), not by copying the file that
first learned it — each reference project carries its own unmanaged drift, and importing that drift
would defeat the point of normalising.
