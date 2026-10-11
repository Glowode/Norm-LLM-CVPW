# 04 — Artifacts: the field guide

**Read when:** you need the exact shape of an artifact, you are about to write one, or something is
reading a file that is not what you thought it was.

Every artifact is a single JSON object carrying `$schema` and `schemaVersion`, UTF-8 without BOM, LF
endings, and paths relative to the project root with forward slashes (`docs/SPEC.md` A1–A5). Unknown
top-level keys are **rejected**, not ignored (A4) — that is deliberate, and it is the rule that catches
the misspelled field which would otherwise fall back to a default and quietly restyle a film.

---

## Which artifacts you edit, and which you must not

The most important table in this document.

| Artifact | Author | You edit it by hand? |
|---|---|---|
| `project.json` | human / `cvpw new` | **Yes** — it is the knobs file |
| `audio/<file>` | human | **Never** — no tool rewrites it, ever |
| `analysis/audio.json` | `cvpw analyze` | **No.** Curate `analysis/sections.json` and `cues/cues.json` instead |
| `analysis/sections.json` | human | **Yes** — this is the intended override |
| `cues/cues.json` | `cvpw cues` + human | **Yes**, and mark a hand-set time `manual` |
| `cues/lyrics.json` | `cvpw lyrics` / human | Yes, but see the licence rule |
| `cues/lyrics.timing.json` | `cvpw lyrics` | **No** — regenerate it |
| `timeline.json` | `cvpw storyboard` / human | **Yes.** This is the edit |
| `handoff.json` | human / integrator | **Yes.** It is the contract |
| `handoff.report.json` | `cvpw handoff` | **No** |
| `assets/manifest.json` | `cvpw assets` | Only for `licence`/`source`, which a tool cannot know |
| `docs/*.md` | human / agent | **Yes** |
| `review/report.json`, `render/report.json`, `qa/report.json` | tools | **No** |
| `qa/gold.json` | `cvpw check --update-gold` | Only via the flag, with a stated reason |
| `qa/exemptions.json` | human | **Yes.** Every entry needs a date, a reason and an owner |

A tool MUST NOT overwrite an *authored* artifact without an explicit `--force`, and MUST announce the
write when it does.

---

## `project.json`

The only place project knobs live. Full schema in `schemas/project.schema.json`.

```jsonc
{
  "$schema": "schemas/project.schema.json",
  "schemaVersion": 1,
  "id": "my-film",
  "title": "…", "titleSub": "…", "artist": "…",
  "credit": "Music / Lyrics / Movie：…",        // ask the user; never invent a credit line
  "output": { "width": 1920, "height": 1080, "fps": 30, "color": "bt709", "safe": 96, "subtitleBand": 920 },
  "variants": { "master": { "aspect": "16:9" }, "vertical": { "aspect": "9:16", "width": 1080, "height": 1920 } },
  "audio": { "file": "audio/song.wav", "sampleRate": 48000, "offset": 0 },
  "timebase": { "mode": "measured", "meter": "4/4" },
  "style": "minimal-paper",
  "render": { "workers": 2, "frameCodec": "jpeg", "frameQuality": 0.94, "motionBlur": { "samples": 1 } },
  "budgets": { "msPerFrame": 40, "peakDiskGb": 5 },
  "textWhitelist": ["…"],
  "lyricsText": "local-only",
  "seeds": { "global": 20161011 },
  "vectors": { "grid": "none" }
}
```

**Three things that catch people:**

1. `width` and `height` must be **even**. yuv420p requires it, and an odd dimension fails inside ffmpeg
   with a message about chroma subsampling that does not mention your canvas.
2. `audio.offset` is applied **at mux time**. Editing the source file to add a lead-in is forbidden
   (SPEC P6), because it destroys the reference every measurement was made against.
3. `seeds.global` is the root of every seeded generator. Changing it restyles every noise-driven element
   in the film at once. If you are debugging one scene, do not touch it.

---

## `analysis/audio.json` — the time authority

Written by `cvpw analyze`; see `schemas/audio.schema.json` and `docs/CONTRACTS.md` §4.

The three fields that matter most:

| Field | What it is | What people get wrong |
|---|---|---|
| `tempo.bpm` | **A LABEL.** | Deriving a grid from it. Tempo drifts; a cut at `n * 60/bpm` lands late by the end of the song. Use `beats[]`/`bars[]`. |
| `bars[].index` | The authoritative bar number | Assuming `bars[i].index === i`. A pickup bar makes bar 0 sit where you do not expect. |
| `tempo.octaveCheck` | `ok`, or the *relationship* that is ambiguous | Ignoring a value other than `ok`. It means the answer might be a third, a half, two-thirds or double the truth. Look at the plot. |

`generatedAt` is `null`, always. A timestamp would make the artifact irreproducible (SPEC A6). The *run*
is dated in `render/report.json`, which is never an input to a stage.

---

## `analysis/sections.json` — the override you are supposed to write

Automatic section grouping is unreliable on a real master: a compressed mix has a nearly flat energy
curve. So the analysis proposes and a human decides.

```jsonc
// either the readable form
{ "sections": [ { "name": "verse1", "start": 12.0, "end": 28.0 } ] }
// or the compact hand-editable form: [firstBar, lastBar, label]
{ "sections": [ [0, 7, "intro"], [8, 15, "verse1"], [16, 23, "chorus1"] ] }
```

Copy `analysis/sections_auto.json`, fix it, save as `analysis/sections.json`, re-run `cvpw analyze`. The
override wins outright, and every section it produces is marked `manual: true`.

---

## `cues/cues.json` — every off-grid time

The only permitted home for a moment that is not on the beat grid (SPEC T8).

```jsonc
{ "$schema": "schemas/cues.schema.json", "schemaVersion": 1, "duration": 208.1,
  "cues": [
    { "id": "first_sound", "t": 0.31,  "source": "measured", "label": "first audible note" },
    { "id": "chorus_in",   "t": 41.90, "source": "manual",   "label": "chorus", "note": "auditioned by ear" }
  ] }
```

`source` ∈ `measured | analysis | audit | initial | manual`. `cvpw cues` refines the first four and
**never** touches a `manual` entry — the whole point is that a human's ear correction survives every
subsequent re-analysis. If no onset is near a guess, keep the guess and mark it `manual` with a note;
do not leave it `initial` and hope.

---

## `timeline.json` — the edit

The heart of the design, and the file you spend the most time in. Four worked shots, using four
different kinds of time expression:

```jsonc
{
  "$schema": "schemas/timeline.schema.json",
  "schemaVersion": 1,
  "duration": 8.0,
  "edges": ["cue('chorus')"],
  "shots": [
    {
      "id": "s01_open", "scene": "open", "block": "b01",
      "at": "0.0s",
      "moment": "an empty frame with a pulse in it; the film has not started speaking yet",
      "args": { "pulse": 0.35 },
      "text": [{ "s": "TITLE", "role": "title" }]
    },
    {
      "id": "s02_grid", "scene": "grid", "block": "b01",
      "at": "b(0,2)",
      "moment": "the beat becomes visible: a grid snaps onto the pulse exactly on beat three",
      "args": { "density": 8 }
    },
    {
      "id": "s03_chorus", "scene": "burst", "block": "b02",
      "at": "cue('chorus') + 0.12",
      "moment": "the chorus lands; the grid is thrown outward and the frame goes bright",
      "transition": { "type": "flash", "overlap": 0.2 },
      "post": { "bloom": 0.4 }
    },
    {
      "id": "s04_hold", "scene": "hold", "block": "b02",
      "at": "h(17)",
      "to": "p(1.0)",
      "moment": "hold on one image long enough that the ending reads as a decision, not a fade",
      "args": { "text": "END" }
    }
  ]
}
```

**Reading it:**

| Expression | Means |
|---|---|
| `"0.0s"` | Second 0 — permitted, and raises a `lint` warning. Use it only where there is genuinely no grid. |
| `"b(0,2)"` | Bar index 0, beat 2. Note **`index`**, not array position. |
| `"cue('chorus') + 0.12"` | 120 ms after a named cue. This is what an off-grid accent looks like: a cue plus an offset, never a bare number. |
| `"h(17)"` | Half-beat 17 — the midpoint between beat 8 and beat 9. |
| `"p(1.0)"` | 100 % of the duration, i.e. the end. |

**Three rules that will bite you:**

1. Every shot needs a `moment`. One sentence: what is this shot *for*. A shot without one is filler you
   have not admitted to yet. `cvpw storyboard` fails on a missing `moment`.
2. Coverage must be exactly `[0, duration)` — no gaps, no overlaps except those a declared transition
   owns. A gap fails `cvpw storyboard` rather than rendering black.
3. An `args` key that the scene's `argsSchema` does not declare is an **error**. That is the rule that
   turns "the effect did nothing" into "you misspelled `densite`".

---

## `handoff.json` vs `handoff.report.json`

**`handoff.json` is the contract. `handoff.report.json` is the measurement.** Keeping them apart is what
lets the contract stay reproducible — a measurement carries a timestamp and a renderer string, and a
contract that carries those cannot be regenerated byte-for-byte.

```jsonc
// handoff.json — authored, reproducible, no timestamp
{ "$schema": "schemas/handoff.schema.json", "schemaVersion": 1,
  "seams": [
    { "id": "b01|b02", "t": "b(2,0)", "mode": "pixel",
      "lastFrameOf": "s02_grid", "firstFrameOf": "s03_chorus",
      "contract": {
        "camera": { "drift": { "amp": 5, "speed": 0.35, "seed": 3 }, "zoom": 1.0, "rot": 0.0 },
        "env": "studio", "layers": ["bg", "fg"], "fx": { "shake": 0, "flash": 0 }
      },
      "note": "both sides import this; neither hard-codes it" } ] }
```

Both blocks import this and read the values. Neither may inline them. A seam must **not** also appear in
`timeline.json::edges` — an invisible seam and a hard cut are mutually exclusive, and QA classifies
jumps differently for each.

---

## `assets/manifest.json`

Provenance for everything the film loads. An asset with no `licence` or no `source` fails the gate: a
film whose provenance is unknown cannot be delivered.

```jsonc
{ "assets": [
  { "id": "hero_master", "path": "assets/char/hero_master.png", "kind": "image",
    "size": [2048, 2048], "transparent": true, "alphaMethod": "chroma",
    "landmarks": { "head": [1024, 340], "handR": [1420, 1180] },
    "source": "generated with <tool>, 2026-01-01", "licence": "CC-BY-4.0 (own work)",
    "sha256": "…", "reviewed": { "at": "2026-01-01", "by": "integrator", "note": "consistent with the master" } } ] }
```

`landmarks` is the "art spec as data" idea: a scene attaches a prop by *name* rather than by eyeballing a
coordinate, so re-exporting an image at a different size does not silently move everything attached to it.

---

## Reports

Three reports carry a run record and are the only artifacts permitted to do so (SPEC A6):

- **`render/report.json`** — codec actually used, the probe evidence, per-worker timings, the renderer
  string, resolved times and frame hashes. `errors` non-empty means the output file was deleted.
- **`handoff.report.json`** — per-seam diffs against the reference, graded, with the strip path.
- **`qa/report.json`** — one row per check: id, the threshold *as read from its source*, observed value,
  verdict, and the offenders that justify it.

A check whose status is `skipped` is **not** a pass. A project that has skipped its way to a green report
has not been verified, and the report says so if you read the `status` column rather than the `ok` flag.

---

## Authoring a new artifact

If you genuinely need one that does not exist (`docs/EXTENDING.md` has the full recipe):

1. Add the schema to `schemas/`, `$id`-anchored, `additionalProperties: false`.
2. Add a row to the catalogue in `docs/CONTRACTS.md` §1.
3. Add a **failure-mode entry**: what breaks, what it looks like, how to detect it.
4. Add a fixture under `tests/fixtures/` and a conformance test.

Step 3 is not optional. Every contract in this framework exists because a specific failure was observed,
and an artifact added without a documented failure mode is an artifact whose failures will be
rediscovered the hard way.
