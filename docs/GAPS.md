# GAPS — declared but not read

Produced by a mechanical audit, not by memory: every gate id, every command name and every `project.json` key was
extracted from the schema and `docs/`, then searched for in the source. Each entry below carries **where it is
declared** and **what reads it**, or the absence of the latter.

The audit exists because this project had six declared-but-inert features found one at a time by accident —
`bloom`, `chromatic`, `saturate`, `brightness`, `contrast`, `generator` — plus an entire post-processing chain that
never ran. Finding them individually was expensive; finding them as a class is cheap. That lesson is the whole
justification for this file.

---

## 1. Gates: nothing missing, five undocumented

| | |
|---|---|
| gate ids in `docs/QA.md` | 24 |
| ids in `check.ts::IMPLEMENTED_CHECKS` | **29** |
| in `QA.md` but not implemented | **none** |
| implemented but not in `QA.md` | 5 |

The five undocumented ones:

| id | why it exists | why it matters that it is undocumented |
|---|---|---|
| `render.postApplied` | caught the post chain that never ran | the gate that found the worst bug in the project is not in the gate table |
| `render.registry` | the master was rendered with the current scenes | a stale master is invisible otherwise |
| `blender.version` | the bridge requires 5.0+ | an older build renders subtly differently |
| `scenes.registry` | every shot names a scene that exists | — |
| `timeline.time` | every time expression resolves | — |

`docs/QA.md` is authority level 4 and therefore **normative**. A gate that exists in code and not there is a gate
an agent cannot know to run. This is a documentation defect, not a code defect, and it is the cheap kind: add five
rows.

---

## 2. FIXED: `project.json::seeds` was declared, required, and read by nothing

```json
"seeds": { "type": "object", "additionalProperties": false, "required": ["global"], ... }
```

The example project sets `"seeds": { "global": 20261011 }`. **No source file mentions `seeds` at all** — not in
`packages/*/src`, not in `templates/project/engine/**/*.js`.

What the engine actually seeds from, from reading the scenes:

```js
// outro.js
paperFill(g, {...}, { strength: 0.055, alpha: 0.5, seed: "hold" });
// burst.js   per-particle life seeded on the particle index
// intro.js   per-ring wobble seeded on the ring index and its beat
```

Every one of those is a **string or index literal in the scene**, not the project's seed. So `seeds.global` is the
single most consequential inert value in the project: the framework's central promise is that a frame is a pure
function of `t`, and the *project-level* seed a film declares has never influenced a single pixel.

This is the same defect class as `bloom`, and it is worse, because the schema marks `global` as **required** —
which means validation actively vouches for a value nothing consumes.

**FIXED, in its own change with its own re-baseline.** The seed is folded into `hash32` — the single funnel every
seeded value in every scene passes through — rather than into each scene, because a per-scene rule is a rule every
future scene author has to remember. `EngineOptions.seed` carries it; `engine/main.js` reads
`project.seeds?.global`.

Verified four ways:

| check | result |
|---|---|
| a baseline taken before the change | **10 of 11 frames differ** |
| changing `seeds.global` 20261011 -> 20261012 | **FAIL**, the film changes |
| restored seed against a fresh baseline | **ok, compared 11, differing 0** |
| every scene with no declared seed | unchanged: an empty seed leaves `hash32` byte-identical to before |

That last row is the compatibility guarantee: a project that declares no seed renders exactly as it did before this
existed, so the change is only visible where a project asked for it.

---

## 3. FIXED: `project.json::vectors` was a declared feature, not a dead key

```json
"vectors": { "grid": "beats" }
```

The audit called this dead by reading the **schema**. `docs/CONTRACTS.md:77` documents the intent the schema
omits:

```
"vectors": { "grid": "none" }     // none | beats | bars -- planning drawing aid
```

So it was never dead — it was **unimplemented**, and that distinction decides whether to build it or delete it.
Reading only one of the two documents would have got it wrong, which is the same shape as every other finding in
this file.

**Implemented:** `Timebase.beatTimes` and `Timebase.barList` are public read-only accessors; `EngineOptions.grid`
draws beat lines (thin), bar lines (thick) and a playhead inside `drawOverlay`. Only the overlay draws them, so a
master is unaffected by construction. `?grid=beats|bars|none` overrides the project value, so a reviewer can turn
the guides on without editing `project.json`.

Verified by hashing one frame under both settings, because the `grid` scene draws its own lattice and a screenshot
cannot tell the two apart:

| `?grid=` | frame hash |
|---|---|
| `none` | `42c09b1c` |
| `beats` | `b4604ef0` |

**A detour worth recording:** making the guides appear first failed to boot the page. The error named
`main.js`, which parsed cleanly; the real fault was `timeline.js`, damaged by an earlier string-replacement in this
session and invisible until a module import failed. The template is the source of truth for engine files, so all
three projects were re-synced and every `engine/**/*.js` now passes `node --check`. A broken engine file fails at
import, and the message points at the importer — a bad clue in a good place.


## 4. PARTLY FIXED: `project.json::artist` and `::titleSub`

**Wired through four layers, and it still does not reach the canvas.**

| layer | change |
|---|---|
| `SceneFrame` | gained `title` and `titleSub`; a scene had no way to reach a project string before |
| `EngineOptions` | carries both; the synthetic frame literal updated |
| `engine/main.js` | passes `project.artist` / `project.titleSub` |
| `outro.js` | uses them as DEFAULTS when the shot leaves `title` at its `"TITLE"` default |
| `deliver.credit` | now fails if a declared title is not whitelisted, so it cannot silently go undrawn |

**And the value still does not appear**, because the timeline passes `title: "EXAMPLE"` explicitly, which shadows
the project default. Removing that literal from `templates/project/engine/timeline.js` — the obvious fix — produced
a **page exception** inside `checkTextLayout` that was not diagnosed, so the literals were restored rather than
shipped broken. The example is green (29/29) with the wiring in place and inert.

**Next attempt, in this order:** remove the literal title from `examples/minimal/engine/timeline.js` only (not the
template), run `cvpw stills --times 7.5` first and read the exception from the page rather than from the gate
stack. Then decide the precedence question the exception will force: when the timeline names a title AND the
project declares an artist, both are authored and the authority order puts `project.json` (level 5) above code
(level 7), so the project should win — but a scene arg is a direct instruction and silently overriding it is its
own kind of surprise. That decision needs to be written down, not made in passing.

---

## 5. `text.*` gates sample too few instants to see a shot that exists only at the end

Chasing whether `artist` reaches the canvas produced a bigger finding than the answer.

With the timeline literal removed AND `artist` set to an unwhitelisted string, `text.whitelist` still **passed**
with `unlisted 0`. The reason is not that the value failed to reach the page — it is that the gate never looks at
the instant where it is drawn.

`checkTextLayout` samples **28 instants** across the film. The end card occupies 6.5–8.0 s, and the `legibility`
offender list from the same run names only `s01_open` — the samples cluster early because they are spread over
shot boundaries and the opening shot is short. So text that appears only in the last shot is **never measured**.

This invalidates the earlier conclusion in section 4 in the honest direction: it is not "wired but inert", it is
**"unknown, because the instrument does not reach it"** — the fifth time this session that a measurement problem
was mistaken for a code problem.

**Fix, in order:**

1. `sampleTimes` for the text gates must include **at least one instant inside every shot**, not merely enough
   instants overall. A gate that can skip a shot is a gate with a blind spot shaped exactly like the defect it
   would catch.
2. Then re-run the `artist` experiment. If the value appears, the four-layer wiring was correct all along; if it
   does not, the wiring is genuinely wrong and the exception seen once on `checkTextLayout` deserves another look.
3. Only then decide the precedence question: a timeline title and a project `artist` are both authored.

## 6. RESOLVED: the title chain works, and the whitelist gate was the thing that was blind

Section 5 concluded the `text.*` gates sampled too few instants. **That was wrong**, and the correction matters:
`sampleTimes` defaults to `perShot = 3`, so it already samples inside every shot, the end card included.

The real defect was one layer up. `checkText` reads **storyboard-resolved scene args**; `project.json::artist`
is composed **at runtime**, so it never appears in those args and the gate could not see it. Proven by
instrumenting `fillText` directly:

```
timeline literal removed, artist = "FROM PROJECT"
strings drawn at t=7.5:  ["FROM PROJECT","replace me"]
```

So the four-layer wiring from section 4 was correct all along. It was never inert — it was never *observed*.

**Fixes:**

1. `text.whitelist` now also compares **the strings the page actually drew**, collected by the same `fillText`
   instrumentation the layout gates use. Measured: `drawn 5, drawn unlisted 0` on the example, and a runtime-only
   string is now caught:
   ```
   FAIL  text.whitelist  drawn 5, drawn unlisted 1
         "FROM PROJECT" was drawn but is not in textWhitelist
   ```
2. `sampleTimes` was left alone, because it was never broken. Changing it would have been a fix for a symptom that
   did not exist.

**That new check immediately found a real, older bug:** the example's whitelist declared `7×5` while the `grid`
scene draws `7×4`. The storyboard's declared args agreed with the whitelist, so both were wrong together and the
gate passed. Now the pixels disagree with the declaration, and the gate fails — which is what it is for.

A note on the fix itself: passing `×` through a PowerShell command line on this machine (code page 936) corrupted it
twice. The value was finally written by a Node script using `\u00d7`, and verified by code point (`37,d7,34`).
Console encoding is not a place to be brave.

## 7. `budgets.flashPerSecond` was unread, and the gate that ignored it was mine

Auditing every schema leaf path against the source (41 leaves) found five never mentioned: `$schema` (meta),
`audio.sampleRate`, `render.frameCodec`, `budgets.peakDiskGb`, `budgets.flashPerSecond`.

The last one was the interesting one, because `AGENTS.md` rule 11 is explicit: **thresholds live in `docs/QA.md` or
`project.json::budgets`; never invent one inside code.** And `flash.ts` hard-coded `ROUND_TRIPS_PER_SECOND = 3`.

**Fixed.** The gate reads `budgets.flashPerSecond` first and falls back to the `docs/QA.md` default, and it reports
which one it used:

```
budget 3, budget from project.json::budgets.flashPerSecond
```

Verified in both directions: with the project at its declared 3 it passes, and tightening it to **0** makes the same
film fail — so the project's number is genuinely in force:

```
FAIL  flash.rate   peak round-trips/s 1, budget 0
```

## 8. A LATENT BUG my own fix activated: two different `quality` meanings

Wiring `render.frameQuality` into the render call produced:

```
libx264: Task finished with error code: -22 (Invalid argument)
```

`RenderRequest.quality` is the **frame quality, 0..1**. `probeEncoders({ quality })` passes it as the encoder's
**CRF**. Those are different scales, and the conflation had never fired because nothing ever set `quality` from the
project. My change set it to `0.94` and asked libx264 for `-crf 0.94`.

**The wiring was reverted, not fixed.** A verified-working render is worth more than a half-corrected unit
conversion, and the conflation deserves its own change with its own test — the frame quality belongs to the capture
sink, the CRF belongs to the encoder, and they should never have shared a parameter name.

`render.frameCodec` remains unread, and `audio.sampleRate` and `budgets.peakDiskGb` likewise. None is a mystery:
each is a declared knob whose consumer does not exist yet.

## 9. FIXED: `quality` meant two things, and that is why `render.frameQuality` could never be honoured

`RenderRequest.quality` was documented as "quality target passed to the encoder" and used for two different
quantities: at one call site it became the JPEG quality of the captured frames (0..1), at another it went straight
to `probeEncoders` as the encoder CRF (0..51). Passing the project's `0.94` produced:

```
libx264: Task finished with error code: -22 (Invalid argument)
```

**Split into `frameQuality` (capture sink, 0..1) and `encoderQuality` (encoder CRF).** `render.frameQuality` is now
read from the project and reaches the capture:

| project `frameQuality` | master size | master hash |
|---|---|---|
| 0.94 (declared) | 0.5 MiB | `2F2BA154...` |
| 0.50 | 0.3 MiB | `5EB1FBB9...` |

Different sizes, different hashes, no encoder error. `--quality` is now explicitly the CRF.

## 10. NEW, and it is a 15x regression the post-chain fix exposed: grain costs 1.4 s per frame

`scene.perf` failed at **p95 1519 ms** against a 160 ms budget on a full render of the example — where the same
render measured ~88 ms earlier in this project.

Isolating the cause, in order:

| measurement | result |
|---|---|
| with the WebGL2 chain | 1506.7 ms/frame |
| with the chain removed | 1492.8 ms/frame |
| **with grain disabled in the style** | **97.9 ms/frame** |

So the post chain is not the cost. **`drawGrain` is**, and it always was: it issues one `fillRect` per cell, which
at 1080p with `step = dpr * 2` is roughly **518,000 draw calls per frame**.

That cost had never appeared because grain never ran — `finish()` was not called on the default path until this
session fixed it. The fix did not create the problem; it revealed one that was hidden behind a dead code path.

**The fix is known and bounded:** build the grain once per frame as an `ImageData` and `putImageData` it, instead
of per-cell fills. That keeps determinism (it is already keyed on the frame index, never on `t`) and turns half a
million calls into one buffer write. Until then, a project that declares grain pays 15x per frame, and a 240-frame
film takes ten minutes instead of forty seconds.

This is the most valuable thing this audit found, and it was found by a gate that already existed.

### 10a. The batched-grain rewrite: 10.7x faster, and reverted because it broke determinism

Attempted the fix section 10 describes — one `ImageData` per frame, `putImageData`, then a single upscaled
`drawImage` under the same `overlay` composite.

| | ms/frame |
|---|---|
| per-cell `fillRect` (current) | 1500 |
| batched `ImageData` | **140** |
| grain disabled entirely | 98 |

A 10.7x speedup, and **reverted anyway**:

```
same frame rendered three times:  8c06b5e5  2617b159  2617b159
stable: false
```

The first render differs from the second and third. The gold baseline failed 7 of 11 witnesses even after a fresh
baseline was taken — so the rewrite made the renderer non-deterministic, and a fast non-deterministic renderer
violates the framework's central promise more seriously than a slow deterministic one. 1500 ms with a proven
baseline beats 140 ms with an unproven one.

Two candidate causes, neither investigated because both need a change of their own:

1. **`ImageData` alpha is 8-bit; CSS `rgba()` alpha is float.** The rewrite quantises grain strength, so the pixels
   cannot match the baseline exactly — that alone explains the 7 differing witnesses, and it is a *deliberate*
   change that needs its own re-baseline with its own note.
2. **First-render instability**, which `docs/adr/0007` already names and `warmupFrames: 2` already compensates for
   in the render path. The three-render probe above does no warm-up, so its first-sample difference may be exactly
   that known effect rather than anything the rewrite introduced.

**The next attempt should separate those two questions before changing any code:** run the three-render probe on the
CURRENT per-cell implementation. If its first sample also differs, cause 2 is real and pre-existing, the rewrite is
not guilty of it, and the only remaining issue is the alpha quantisation — which is a documented re-baseline, not a
bug.


### 10b. That conclusion did not survive re-measurement, and the correction matters more than the optimisation

The batched grain was re-applied after the three-render probe showed the per-cell version has the same
first-sample difference. Re-measured:

| implementation | ms/frame | gold after a fresh baseline |
|---|---|---|
| per-cell | 1500 | 11/11, **twice** — and once **1 differing** |
| batched `ImageData` | **152.6** | **2 differing** |

The per-cell version does NOT reliably pass 11/11 either. Earlier in this session it did, on a quiet machine; with
several heavy renders running it reported one differing witness. So **the instrument cannot distinguish the two
implementations under these conditions**, and the earlier statement that the rewrite made the renderer
non-deterministic was never established — it was two unstable measurements being compared as if one were a
baseline.

**THE INSTRUMENT WAS CONTAMINATED**, and the honest result is: the batched version is 10x faster and its
determinism is UNKNOWN. The per-cell version is slow and its determinism is INTERMITTENTLY CONFIRMED.

What follows from that:

1. **`determinism.gold` needs a quiet run to mean anything.** A gate whose pass depends on what else the machine is
   doing is not a gate yet. It should either measure and report machine load, or render its witnesses twice in one
   run and compare them to each other rather than to a stored baseline — the second needs no baseline and is the
   stronger test of the property the framework actually promises.
2. Only after that is fixed can the batched grain be judged. It should be re-applied then, not before.
3. The performance finding stands regardless: grain costs ~1400 ms/frame at 1080p and that is 15x the rest of the
   frame.

The per-cell version is restored. `docs/adr/0007` already documents first-frame instability; **this is the same
problem one level up — an unstable MEASUREMENT, not an unstable renderer.**

## 11. FIXED: `determinism.gold` now tests the property, not the machine

The gate compared witnesses against `qa/gold.json`. That measures **the machine as much as the renderer**: a
baseline taken on an idle machine, checked on a busy one, reports differing frames that no code change explains.
It happened twice in this session with identical code — 11/11 once, 1 differing later.

`checkDeterminism` now captures every witness **twice inside one run** and compares the two to each other before
touching the baseline. Two captures of one frame in one session must agree; if they do not, the renderer is not a
function of `t` and no baseline can excuse it.

| renderer | result |
|---|---|
| the project as it stands | `ok=True, compared=11, differing=0, UNSTABLE=0` |
| a scene with `Date.now()` in the title x-offset | `ok=False, UNSTABLE=1`, naming frame 216 and both hashes |

The second row is the one that makes the first mean anything. The offender reads:

```
frame.unstable  frame 216  two captures of this frame in the SAME run hashed
                           33075e7c93de2977 then 8c4a77a226f1
```

Three properties follow, and each was a gap before:

1. **It needs no baseline.** A project with no `qa/gold.json` can still be told whether its renderer is a function
   of `t`.
2. **It is load-independent.** Both captures run in the same session under the same conditions.
3. **It is a direct test of D1**, not a proxy. A stored hash only ever proves "same as last time", which is what the
   per-cell grain confusion was actually measuring.

The stored baseline is still compared, and still catches a film that changed between renders — but it is now the
second question rather than the first.

## 12. The grain optimisation, landed, now that the criterion is the right one

With `determinism.gold` testing stability within a run instead of against a stored baseline, the question that
cost this optimisation two reverts became answerable:

| implementation | ms/frame | stability within one run | baseline after re-taking |
|---|---|---|---|
| per-cell `fillRect` | 1500 | `UNSTABLE=0` | 11/11 |
| **batched `ImageData`** | **177.7** | **`UNSTABLE=0`** | **11/11** |

Both are stable. The batched version is **8.4x faster**. It is landed, with a re-baseline whose reason names the
only thing that changed:

> grain batched into an ImageData texture: 152 ms/frame vs 1500, UNSTABLE=0. Alpha is 8-bit rather than float, so
> strengths quantise; that is the whole reason these witnesses differ.

**What the two reverts cost and bought.** The first was justified at the time — the only instrument available said
the rewrite was non-deterministic, and a slow deterministic renderer beats a fast uncertain one. The second was the
one that paid: it established that the *instrument* was unstable, not the code, and produced a gate that now tests
D1 directly.

**The general form, now demonstrated end to end:** when a measurement says a change broke something, measure the
change and the thing it replaced **under the same conditions**. Twice in this session that comparison dissolved the
conclusion — here, and with `window.engine.resolved` being an inspection copy.

## 13. `budgets.peakDiskGb` — checked before the render instead of during it

The third of the three unread knobs, and the one with the worst failure mode: running out of disk fails a render
**after** the frames are drawn, during the encode, leaving a truncated master that only `render.frameCount` can
explain afterwards.

`render.diskSpace` reads `budgets.peakDiskGb` and compares it with the free space on the project's volume.

| budget | free | verdict |
|---|---|---|
| 5 GiB (the example's) | 28.7 GiB | **ok** |
| 100000 GiB | 28.7 GiB | **FAIL**, `disk.too-full` |

A project that declares no budget skips with that reason rather than passing on an assumption: a check that never
ran must never look like a check that passed.

Still unread after this: `render.frameCodec` and `audio.sampleRate` — both declared knobs whose consumer does not
exist yet.

## What this audit does NOT cover

Being explicit about the boundary is the point of this file, so:

- **Schema keys that are read but only partly honoured.** `project.schema.json` has 21 top-level keys; this audit
  proves presence or absence of reads, not that a read uses every declared sub-field.
- **Command flags.** 64 `name:` occurrences were extracted, but most are flags rather than commands, so that count
  says nothing yet. A real command audit needs to read the top-level `register()` calls specifically.

## Two of the four blind spots, now checked

**Time-expression vocabulary: consistent.** Re-derived from `docs/CONTRACTS.md` and diffed against the parser:

| | |
|---|---|
| declared in CONTRACTS.md | `b`, `cue`, `h`, `L`, `VOX`, `HIT`, `S`, `STOP`, `p` — 9 |
| recognised by `time.ts` | the same 9 |
| declared but not parsed | **none** |

**`docs/WORKFLOW.md` file promises: one real gap, fixed.** Auditing every project-relative path the workflow names
against `examples/minimal` found four authored documents missing, and the cause was worse than the symptom:
**`templates/project/` had no `docs/` directory at all**, so `cvpw new` never created them.

That matters because `docs/SPEC.md` section 10 requires a `docs/PROGRESS.md` deviation log in every project, and a
new project could not have one. Stage 1's deliverables — `BRIEF.md` and `CONCEPT.md` — had the same problem.

Added to `templates/project/docs/` and copied to the example:

| file | what it is for |
|---|---|
| `BRIEF.md` | the five Stage 1 answers, including "what this film will NOT do" — a brief with no refusal has not decided anything |
| `CONCEPT.md` | palette by role, master shapes, typography rules, texture, motion |
| `PROGRESS.md` | the deviation log, empty table ready |
| `INTEGRATION_NOTES.md` | shared-file requests, so a block author does not edit `project.json` |

Verified: `cvpw new <dir>` now scaffolds **18** template files, four of them in `docs/`, and the example still
passes 29/29 gates.


---

## The order to fix these in

1. **`docs/QA.md`: add the five rows.** Cheapest, and it is a normative document missing normative content.
2. **`seeds.global`.** Highest value, highest blast radius. One change, one re-baseline, one paragraph.
3. **`artist` / `titleSub`.** Either draw them in an end card — the example has an `outro` shot with room — or
   remove them from the schema. Leaving a declared empty string that nothing reads is the worst of the three
   options.
4. **`vectors`.** Decide what it was for. If the answer is nothing, delete it from the schema; a key that cannot
   work must not be declarable.
