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

## What this audit does NOT cover

Being explicit about the boundary is the point of this file, so:

- **Schema keys that are read but only partly honoured.** `project.schema.json` has 21 top-level keys; this audit
  proves presence or absence of reads, not that a read uses every declared sub-field.
- **Time-expression vocabulary.** `docs/CONTRACTS.md` defines `b()`, `cue()`, `h()`, `L()`, `VOX()`, `HIT()`,
  `S()`, `STOP()`, `p()`. All were exercised by unit tests earlier, but this audit did not re-derive that list
  from the document and diff it against the parser.
- **`docs/WORKFLOW.md`'s file promises.** Stage 5 and 6 name files a project should have; only `docs/BLOCKS.md` and
  `docs/STORYBOARD.md` were checked in this session.
- **Command flags.** 64 `name:` occurrences were extracted, but most are flags rather than commands, so that count
  says nothing yet. A real command audit needs to read the top-level `register()` calls specifically.

---

## The order to fix these in

1. **`docs/QA.md`: add the five rows.** Cheapest, and it is a normative document missing normative content.
2. **`seeds.global`.** Highest value, highest blast radius. One change, one re-baseline, one paragraph.
3. **`artist` / `titleSub`.** Either draw them in an end card — the example has an `outro` shot with room — or
   remove them from the schema. Leaving a declared empty string that nothing reads is the worst of the three
   options.
4. **`vectors`.** Decide what it was for. If the answer is nothing, delete it from the schema; a key that cannot
   work must not be declarable.
