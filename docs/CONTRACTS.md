# CONTRACTS — artifacts, time vocabulary, handoffs

**Status:** normative (authority level 2 — see `docs/SPEC.md` §1).
**Machine-readable form:** `schemas/*.schema.json`. Where this document and a schema disagree, this
document wins and the schema is a bug.

Every artifact in this document is a single JSON object carrying `$schema` and `schemaVersion`
(`docs/SPEC.md` §3). Paths are relative to the project root.

---

## 1. Artifact catalogue

| Artifact | Written by | Read by | Kind |
|---|---|---|---|
| `project.json` | human / `cvpw new` | everything | **authored** |
| `audio/<file>` | human | `cvpw analyze` | **authored** (never modified by tools) |
| `analysis/audio.json` | `cvpw analyze` | timebase, `storyboard`, `check` | derived |
| `analysis/envelope.json` + `.f32` | `cvpw analyze` | engine (features) | derived |
| `analysis/sections.json` | human (override) | `cvpw analyze` | **authored** |
| `analysis/overview.png` | `cvpw analyze` | a human/agent eye | derived |
| `cues/cues.json` | `cvpw cues` + human | timebase, engine | mixed |
| `cues/lyrics.json` | `cvpw lyrics` | engine (text layer) | derived-or-authored |
| `cues/lyrics.timing.json` | `cvpw lyrics` | engine | derived |
| `timeline.json` | `cvpw storyboard` / human | engine, all QA | **authored** |
| `handoff.json` | human / integrator | blocks, `cvpw handoff` | **authored** — the contract only |
| `handoff.report.json` | `cvpw handoff` | a human/agent eye, `check` | derived, carries a run record |
| `assets/**` + `assets/manifest.json` | `cvpw assets` | engine | derived |
| `docs/BRIEF.md`, `CONCEPT.md`, `STORYBOARD.md` | human / agent | authors | **authored** |
| `docs/BLOCKS.md` | `cvpw storyboard` | block authors | derived |
| `docs/PROGRESS.md`, `INTEGRATION_NOTES.md` | agents | everyone | **authored**, append-only |
| `review/report.json` + images | `cvpw stills/sheet/review` | agent, human | derived |
| `render/report.json` + `<name>.mp4` | `cvpw render` | `check`, `deliver` | derived, carries a run record |
| `qa/report.json` | `cvpw check` | gate | derived, carries a run record |
| `qa/gold.json`, `qa/exemptions.json` | `cvpw check` / human | gate | derived / **authored** |

"**authored**" means a tool MUST NOT overwrite it without an explicit `--force`, and the write MUST be
announced. Authored artifacts are the only place human judgement enters the pipeline; derived artifacts
must always be regenerable.

---

## 2. `project.json`

The only place project knobs live. `docs/SPEC.md` §3 applies.

```jsonc
{
  "$schema": "schemas/project.schema.json",
  "schemaVersion": 1,

  "id": "my-mv",
  "title": "…",
  "titleSub": "…",
  "artist": "…",
  "credit": "Music / Lyrics / Movie：…",   // exact on-screen credit line; ask the user, never invent

  "output": { "width": 1920, "height": 1080, "fps": 30, "color": "bt709", "safe": 96, "subtitleBand": 920 },

  "variants": {
    "master":   { "aspect": "16:9", "container": "mp4", "codec": "auto", "crf": 16 },
    "vertical": { "aspect": "9:16", "width": 1080, "height": 1920 }
  },

  "audio":   { "file": "audio/song.wav", "sampleRate": 48000, "offset": 0 },
  "timebase":{ "mode": "measured", "meter": "4/4" },
  "paths":   { "analysis": "analysis", "assets": "assets", "review": "review", "render": "render" },

  "style": "minimal-paper",          // the default style for shots that do not name one; MUST be registered
  "render":  { "workers": 2, "frameCodec": "jpeg", "frameQuality": 0.94, "motionBlur": { "samples": 1 } },
  "budgets": { "msPerFrame": 40, "peakDiskGb": 5 },

  "textWhitelist": ["…"],            // every string that may appear on screen (SPEC C6)
  "lyricsText": "local-only",        // "local-only" | "licensed" — REQUIRED when cues/lyrics.json is committed
  "lyricsLicence": null,             // required when lyricsText is "licensed": who granted it and for what
  "seeds":    { "global": 20161011 },
  "vectors":  { "grid": "none" }     // "none" | "beats" | "bars" — planning drawing aid
}
```

**Invariants a tool MUST enforce**

- `output.width` and `output.height` MUST be even (yuv420p requires it).
- `output.fps` MUST be one of 24, 25, 30, 50, 60.
- `timebase.mode == "measured"` MUST require `analysis/audio.json` to exist before `storyboard` or
  `render` run. `mode == "manual"` MUST require every timeline time to be a cue or absolute seconds.
- `audio.offset` MUST NOT be applied by editing the audio file. It is applied at mux time
  (`-itsoffset` / `adelay`) so the source stays byte-identical (`docs/SPEC.md` P6).
- `credit`, when non-empty, MUST appear verbatim in the end card and in `README.md`.
- `style` MUST name a registered style. Every shot's `style` (or this default) MUST resolve; an
  unregistered name MUST fail `cvpw validate` rather than fall back, because a silent fallback would
  restyle a film without anyone noticing.
- `textWhitelist` MUST be present. An empty array is legal and means "this film puts no text on
  screen", which MUST then be enforced — that is a stronger statement than an absent key.
- When `cues/lyrics.json` exists (that is, lyric text is being kept in the project), `lyricsText` MUST
  be present. `"local-only"` makes `cvpw deliver` refuse to include lyric text in a delivered
  artifact; `"licensed"` additionally requires `lyricsLicence`. This is the mechanism behind
  `docs/SPEC.md` T7, and without it a lyric-video project cannot legally be delivered at all.
- `seeds.global` MUST be an integer. It is the root of every seeded generator; changing it restyles
  every noise-driven element in the film at once, which is why it is a project knob and not an
  engine constant.

---

## 3. Time expressions — normative grammar

**Version 1.** Implemented in `packages/kernel/src/time.ts`; conformance tests in
`tests/unit/time.test.ts`.

A time expression is a **string**. It resolves against the *timebase* (built from
`analysis/audio.json`, `cues/cues.json`, `cues/lyrics.json`, `analysis/envelope.json`).

```
expr        := base [ offset ]
offset      := ("+" | "-") number "s"?          // e.g. "-0.2s", "+0.12"
base        := seconds | bar | half | cue | lyric | word | impact | section | stop | quantile
seconds     := number "s"?                       // "12.5" | "12.5s"
bar         := "b(" int "," number ")"           // bar index, beat within bar (0-based, fractional ok)
half        := "h(" number ")"                   // half-beat grid index: h(2n) is beat n, h(2n+1) is the
                                                 // midpoint to beat n+1; fractional values interpolate
cue         := "cue(" quoted ")"                 // named cue id
lyric       := "L(" int ")"                      // start of lyric line n
word        := "VOX(" quoted [ "," number ] ")"  // onset of a sung word; optional tolerance (default 80 ms)
impact      := "HIT(" quoted [ "," number [ "," number ] ] ")"
                                                 // kind (or band); nearest to a time; tolerance in seconds
section     := "S(" (int | quoted) ")"           // section by index or by name; resolves to its start
stop        := "STOP(" int ")"                   // start of the n-th silence gap
quantile    := "p(" number ")"                   // fraction of the total duration, 0..1
quoted      := "'" [^']* "'" | '"' [^"]* '"'
identifier  := bare cue id, e.g. "chorus" — shorthand for cue('chorus')
```

**Resolution rules (all MUST hold)**

1. **Strict.** Unresolvable → throw `TimeExpressionError` with: the original string, the failing
   token, the reason, and up to three nearest valid alternatives (`{id, t, delta}`).
   There is no fallback and no default.
2. **Absolute is second-class.** A bare number or `…s` resolves to seconds and emits a
   `lint:absolute-time` warning (`docs/SPEC.md` T2). It is permitted so that a stub project works
   before audio exists, and in `timebase.mode == "manual"`.
3. **Tolerance.** `word`, `impact` and `hit`-style lookups take a tolerance (defaults: word 80 ms,
   impact 60 ms). A candidate farther than the tolerance is **not** a match; resolution throws.
4. **Determinism.** Resolution MUST be deterministic and depends only on the timebase. A resolution
   result MUST be cacheable and is written into `render/report.json::resolvedTimes` for audit.
5. **Ordering.** Resolution MUST be monotonic w.r.t. authored order only where authored order is
   monotonic; a timeline whose shots are out of order MUST fail validation rather than be re-sorted
   silently (re-sorting hides the author's mistake).
6. **Grid exclusivity.** `b()` and `h()` MUST fail when the timebase has no beat grid.
   `b(i,j)` MUST look a bar up **by its `index` field**, never by array position — songs with a pickup
   bar have a bar 0 that is not at array position 0.
7. **Offset sign.** `+` moves later, `-` moves earlier. An offset MUST NOT be clamped; a negative
   resulting time MUST fail validation (nothing exists before 0).
8. **Numbers.** Numbers MUST be base-10, may be fractional, MUST NOT be `NaN`/`Infinity`.
   A number token MUST NOT carry more than 6 decimal places (time is seconds; more is noise).

**Examples**

| Expression | Meaning | Throws when |
|---|---|---|
| `"b(32,0)"` | bar index 32, beat 0 | no bar 32 |
| `"b(32,2.5)"` | two and a half beats into bar 32 | no bar 32 |
| `"h(64)"` | half-beat 64 — that is, beat 32 | no beat grid |
| `"h(65)"` | the midpoint between beat 32 and beat 33 | no beat grid |
| `"cue('chorus')"` | start of the `chorus` cue | unknown cue |
| `"cue('chorus') + 0.12"` | 120 ms after it | — |
| `"chorus + 0.12"` | the same, via the id shorthand | unknown cue |
| `"L(12)"` | lyric line 12 start | no lyric timing |
| `"VOX('sudden')"` | onset of the word "sudden", ±80 ms | word not found, or found more than once |
| `"VOX('sudden', 0.2)"` | the same, with a 200 ms tolerance | — |
| `"HIT('hit')"` | the strongest impact of kind `hit` | no such kind |
| `"HIT('hit', 4.0)"` | the nearest such impact to 4.0 s, ±60 ms | none within tolerance |
| `"S('bridge')"` | start of section named `bridge` | unknown section |
| `"S(2)"` | start of the section with index 2 | unknown section |
| `"STOP(0)"` | start of the first silence gap | fewer than 1 stop |
| `"p(0.85)"` | 85 % through the total duration | — |
| `"12.5s"` | second 12.5 (warns) | — |

**Shorthand.** In timeline positions, a bare identifier that is not a known keyword (`12.5`,
`cue(...)`, `b(...)`, …) is treated as `cue('<that>')`. This keeps the common case terse:
`"at": "chorus"` is `"at": "cue('chorus')"`.

---

## 4. `analysis/audio.json` — the time authority

Written by `cvpw analyze`; never hand-edited. Hand curation happens in `analysis/sections.json`
and `cues/cues.json`, both of which `cvpw analyze` reads as overrides.

```jsonc
{
  "$schema": "schemas/audio.schema.json",
  "schemaVersion": 1,

  "source": "audio/song.wav",
  "generator": "cvpw analyze@1",
  "generatedAt": null,                 // deliberately null: timestamps break reproducibility (SPEC D2)
  "duration": 8.0,
  "sampleRate": 48000,                 // of the source file
  "analysisRate": 24000,               // of the working buffer
  "fps": 30,
  "frames": 240,

  "tempo": {
    "bpm": 120.0,
    "confidence": 0.0,                 // 0..1
    "method": "autocorrelation over onset envelope + phase search",   // prose, honest
    "octaveCheck": "ok",               // "ok" | "halved" | "doubled" | "uncertain"
    "beatPeriod": 0.5,
    "firstBeat": 0.02,
    "driftMsPerMin": 0.0               // measured, not assumed
  },
  "meter": "4/4",

  "beats":       [0.02, 0.52, 1.02],
  "beatsSmooth": [0.02, 0.52, 1.02],   // spline-smoothed; for continuous motion
  "bars": [{ "index": 0, "start": 0.02, "end": 2.02, "bpm": 120.0, "pickup": false, "beats": 4 }],

  "sections": [{ "index": 0, "name": "intro", "start": 0.0, "end": 2.02,
                 "energy": 0.31, "confidence": 0.8, "manual": false }],

  "onsets":  [{ "t": 0.02, "strength": 1.0, "band": "low" }],
  "impacts": [{ "t": 4.02, "strength": 0.9, "kind": "hit" }],
  "stops":   [{ "start": 6.0, "end": 6.4, "depthDb": -42, "kind": "stop" }],
  "vocalActivity": [{ "start": 2.0, "end": 8.0 }],

  "notes": "provenance prose: what produced this, how, and its known error"
}
```

**Rules**

- `bpm` is a **label**. Consumers MUST use `beats[]`/`bars[]` (`docs/SPEC.md` T4).
- `bars[].index` is authoritative; do not assume `bars[i].index == i`.
- `generatedAt` MUST be `null`. Wall-clock timestamps make artifacts irreproducible; date the *run*
  in `render/report.json`, which is not a contract input.
- `kind` values for impacts: `first_sound | stop | gap | drop | breakdown | hit | section_start | final_cut | end_of_tail`.
- `kind` values for stops: `stop | gap`.
- `confidence` fields MUST be present and honest. A fabricated confidence is worse than `0`.

---

## 5. `analysis/envelope.json` + `analysis/envelope.f32`

Small JSON meta plus a flat binary blob — chosen over a large JSON array for size and load speed.

```jsonc
{
  "$schema": "schemas/envelope.schema.json",
  "schemaVersion": 1,
  "fps": 30, "frames": 240, "duration": 8.0,
  "channels": ["rms", "low", "mid", "high", "onset", "beat", "bar", "vocal"],
  "layout": "little-endian float32, row-major [frames][channels]; frame i is centred at t = i / fps",
  "normalization": "per channel (x - p01) / (p99 - p01), clipped to [0,1]; no temporal smoothing",
  "silentFrames": [],
  "units": { "rms": "normalized", "beat": "beat index within bar" },
  "features": { "low": [20, 150], "mid": [150, 2500], "high": [2500, 16000] }
}
```

**Loader rules**

- MUST validate `blob.byteLength === frames * channels.length * 4`.
- On mismatch or missing file, MUST **degrade to zeros** and push a named warning into
  `cvpw.meta.warnings` — MUST NOT throw, because preview must survive a missing analysis.

---

## 6. `cues/cues.json`

The only permitted home for an off-grid time (`docs/SPEC.md` T8).

```jsonc
{
  "$schema": "schemas/cues.schema.json",
  "schemaVersion": 1,
  "duration": 8.0,
  "cues": [
    { "id": "downbeat1", "t": 0.02,  "source": "measured", "label": "first downbeat", "note": "" },
    { "id": "chorus",    "t": 4.02,  "source": "manual",   "label": "chorus in",     "note": "auditioned by ear" }
  ]
}
```

- `id` MUST match `^[A-Za-z_][A-Za-z0-9_.-]*$` and MUST be unique.
- `source` ∈ `measured | analysis | audit | initial | manual` (`docs/SPEC.md` T6).
- `cvpw cues` MUST NOT modify a cue whose `source` is `manual`; it reports it as skipped.
- Removal of a cue that a timeline references MUST fail `cvpw validate` with the referencing shot ids.

---

## 7. `cues/lyrics.json` and `cues/lyrics.timing.json`

Text and timing are **separate artifacts** so a project can ship timing without text (`docs/SPEC.md` T7).

`cues/lyrics.json` (text; may be absent or git-ignored):

```jsonc
{ "$schema": "schemas/lyrics.schema.json", "schemaVersion": 1,
  "lines": [{ "i": 0, "text": "…", "section": "verse1", "emphasis": false }] }
```

`cues/lyrics.timing.json` (timing; always committable, contains **no lyric text**):

```jsonc
{ "$schema": "schemas/lyrics-timing.schema.json", "schemaVersion": 1,
  "count": 1,
  "sections": [{ "index": 0, "start": 0.0, "end": 4.0, "firstLine": 0, "lastLine": 0 }],
  "lines": [{ "i": 0, "start": 0.5, "end": 2.5, "words": 3, "chars": 12,
              "h": "9f2a1c04",     // sha256(text words, lowercased, punctuation stripped)[0:8]
              "x": "1b77e0aa",     // sha256(exact line text)[0:8]
              "manual": false }] }
```

- `h`/`x` are the copyright-safe join key: the timing table commits a hash, and the local join is
  performed at `cvpw lyrics --join <file>`. A mismatch MUST fail loudly, naming the line index.
- A project MUST set `lyricsText: "licensed" | "local-only"` in `project.json` when text is committed;
  `cvpw deliver` MUST refuse to publish `local-only` text.

---

## 8. `timeline.json` — the edit

```jsonc
{
  "$schema": "schemas/timeline.schema.json",
  "schemaVersion": 1,
  "duration": 8.0,
  "shots": [
    {
      "id": "s02_beat",
      "scene": "beat",
      "at": "b(1,0)",
      "to": "cue('chorus')",
      "moment": "the beat announces itself; the grid becomes visible",
      "block": "b02",
      "args": { "hue": 0.1 },
      "layout": { "safe": 96, "subtitleBand": 920 },
      "post": { "vignette": 0.3 },
      "transition": { "type": "cut", "overlap": 0.0 },
      "handoff": { "out": null }
    }
  ]
}
```

**Rules**

- `id` MUST be unique, MUST match `^[A-Za-z][A-Za-z0-9_]*$`, and SHOULD carry a block prefix so a
  reviewer can see ownership at a glance.
- `moment` is **required** (`docs/SPEC.md` C3).
- `at` MUST be a time expression. `to` is optional; absent means "until the next shot's `at`".
  The last shot's `to` defaults to `duration`.
- `scene` MUST be registered in the engine's scene registry, and `args` MUST validate against that
  scene's `argsSchema`. An unknown arg key MUST fail (this is the typos-become-defaults failure).
- `transition.overlap > 0` MUST be owned by the **later** shot (`docs/SPEC.md` C1).
- Coverage MUST be exactly `[0, duration)` with no gaps and no overlaps other than declared
  transitions (`docs/SPEC.md` C2).
- `block` MUST be present when the project uses more than one author.
- `stateful: true` MUST be declared on the shot (not the scene) when the scene carries simulation
  state, because the same scene may be used statefully in one shot and not another.

---

## 9. `handoff.json` — seams and transitions

`handoff.json` is a **contract, not a report**: it is authored, it is reproducible, and it MUST NOT
contain a timestamp. Seam *measurements* live in the derived `handoff.report.json` (see §10), which is
never an input to a stage (`docs/SPEC.md` A6).

```jsonc
{
  "$schema": "schemas/handoff.schema.json",
  "schemaVersion": 1,
  "seams": [
    {
      "id": "s02_beat|s03_outro",
      "t": "b(4,0)",
      "mode": "pixel",
      "lastFrameOf": "s02_beat",
      "firstFrameOf": "s03_outro",
      "contract": {
        "camera": { "drift": { "amp": 5, "speed": 0.35, "seed": 3 }, "zoom": 1.0, "rot": 0.0 },
        "env": "studio",
        "layers": ["bg", "fg"],
        "fx": { "shake": 0, "flash": 0, "grain": "engine" }
      },
      "note": "both sides import this and read the values; neither hard-codes them"
    }
  ]
}
```

**Rules**

- `mode: "pixel"` — A and B MUST NOT overlap and MUST NOT transition. Both sides MUST read the
  shared `contract`; neither may hard-code its values (`docs/SPEC.md` C4).
- `mode: "transition"` — the later shot owns the drawing (`docs/SPEC.md` C1).
- The seam MUST NOT be registered as a hard cut in any `cuts` list. A planned hard cut and an
  invisible seam are mutually exclusive, and QA classifies jumps differently for each.
- `handoff.json` MUST NOT be written by a tool. `cvpw handoff` writes `handoff.report.json`; the
  grades and thresholds there are governed by `docs/QA.md` (`handoff.pixel`) and are deliberately
  **not restated here**, so that the threshold has exactly one home (`docs/SPEC.md` V5).
- Pixel comparison MUST be run with grain **disabled**; grain makes two frames at different times
  differ across the whole screen and would make every seam fail. `cvpw handoff` MUST force
  `nograin`; a project whose seam check requires grain has mis-specified the contract.

---

## 10. Reports

All reports are derived and carry a run record; none is ever an input to a stage (`docs/SPEC.md` A6).
Check ids, thresholds and grading bands are defined **once**, in [`docs/QA.md`](./QA.md). The
examples below are illustrative of *shape only* — where this section and `docs/QA.md` disagree about a
check id or a threshold, `docs/QA.md` wins.

### `render/report.json`
```jsonc
{ "$schema": "schemas/render-report.schema.json", "schemaVersion": 1,
  "run": { "startedAt": "2026-01-01T00:00:00Z", "durationSec": 0, "host": "…", "workers": 2 },
  "name": "my-mv", "codec": "libx264", "codecRequested": "auto",
  "width": 1920, "height": 1080, "fps": 30, "frames": 240,
  "msPerFrame": { "avg": 0, "p50": 0, "p95": 0, "max": 0 },
  "renderer": "ANGLE (D3D11, NVIDIA GeForce GTX 1050…)",
  "software": false,
  "resolvedTimes": { "s02_beat": 2.02 },
  "frameHashes": { "0": "…", "30": "…" },
  "warnings": [], "errors": [] }
```

### `handoff.report.json`
```jsonc
{ "$schema": "schemas/handoff-report.schema.json", "schemaVersion": 1,
  "run": { "startedAt": "2026-01-01T00:00:00Z", "grain": "off" },
  "seams": [
    { "id": "s02_beat|s03_outro", "t": 6.02,
      "diffAB": 0.0008, "diffARef": 0.0004, "diffBRef": 0.0006,
      "grade": "ok",                                  // bands: docs/QA.md `handoff.pixel`
      "strip": "review/handoff/s02_beat_s03_outro.jpg",
      "activeBefore": "s02_beat", "activeAfter": "s03_outro" } ] }
```

### `qa/report.json`
Ids here are **illustrative**; the canonical list, thresholds and bands live in
[`docs/QA.md`](./QA.md) §2. A report row carries the id, the threshold *as read from its source*, the
observed value, the verdict, and the offenders that justify it.

```jsonc
{ "$schema": "schemas/qa-report.schema.json", "schemaVersion": 1,
  "run": { "startedAt": "2026-01-01T00:00:00Z", "profile": "deliver" },
  "checks": [
    { "id": "render.frameCount", "threshold": "== 240", "observed": "240", "ok": true, "offenders": [] },
    { "id": "av.sync", "threshold": "<= 1 frame (33.3 ms)", "observed": "2.1 ms", "ok": true, "offenders": [] },
    { "id": "flash.rate", "threshold": "<= 3 per 1 s window", "observed": "1 max", "ok": true, "offenders": [] },
    { "id": "handoff.pixel", "threshold": "< 0.03", "observed": "0.0008", "ok": true,
      "offenders": [], "waivedBy": null }
  ],
  "ok": true, "waived": [] }
```

### `qa/gold.json` and `qa/exemptions.json`
```jsonc
// gold.json — determinism witness. Regenerated only with --update-gold and a stated reason.
{ "$schema": "schemas/gold.schema.json", "schemaVersion": 1, "fixture": "templates/project",
  "width": 1920, "height": 1080, "fps": 30,
  "frames": { "0.0": "…", "1.0": "…", "4.0": "…" } }

// exemptions.json — authored. Every entry needs a date, a reason and an owner.
{ "$schema": "schemas/exemptions.schema.json", "schemaVersion": 1,
  "exemptions": [
    { "check": "handoff.pixel", "target": "s07|s08", "date": "2026-01-01",
      "reason": "GPU float rounding differs by 1/255 on 12 pixels", "observed": "0.031",
      "owner": "integrator", "expires": null } ] }
```

---

## 11. Extending the catalogue

Adding a new artifact is a supported, documented operation (`docs/EXTENDING.md`):

1. Add the schema to `schemas/`, `$id`-anchored, `additionalProperties: false`.
2. Add a row to the catalogue table in §1 of this document.
3. Add writer/reader commands in `cvpw` and register them in the validator.
4. Add a failure-mode section here: what breaks, what it looks like, how to detect it.
5. Add a fixture under `tests/fixtures/` and a conformance test.

An artifact added without (4) is incomplete: every contract in this framework exists because a
specific class of failure was observed in practice, and an undocumented failure mode will be
rediscovered the hard way.
