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

## 3. `project.json::vectors` is declared and read by nothing

```json
"vectors": { "grid": "beats" }
```

Declared in the schema, present in the example, mentioned nowhere in code. Two candidates: it is a leftover from a
design that moved on, or a feature nobody built. Either way it is currently a key that validates and does nothing.

## 4. `project.json::artist` and `::titleSub` are declared, read by nothing

Both are `"type": "string"`, both empty in the example, both read by nothing. A title and a subtitle are the two
strings a film most obviously needs on screen, and nothing draws them. `credit` — the adjacent key — *is* gated
(`deliver.credit`), so the omission is visible by contrast: the framework checks that a credit appears and never
checks that a title does.

---

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
