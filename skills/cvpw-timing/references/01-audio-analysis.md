# 01 — `cvpw analyze` in practice

Everything about turning an audio file into the timebase: the input rules, what the pipeline does, how to
read the overview plot, the tempo octave error, sections, snapping, the envelope contract, and the
acceptance list. Read [`../SKILL.md`](../SKILL.md) first for the stance.

```bash
cvpw analyze [--audio <file>] [--bpm-range LO,HI] [--json]
```

Reads `project.json`, `audio/<file>`, and `analysis/sections.json` when it exists.
Writes `analysis/audio.json`, `analysis/envelope.json`, `analysis/envelope.f32`, `analysis/overview.png`.

---

## 1. Input requirements

| Requirement | Why |
|---|---|
| **48 kHz, lossless (WAV/FLAC) preferred** | The renderer muxes this same file, so it is both the analysis input and the master's audio. A lossy source is converted once, before analysis, never after. |
| The file stays **byte-identical** | `audio.offset` MUST be applied at mux time (`-itsoffset` / `adelay`), never by editing the source ([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §2). |
| **No added silence, fades or offsets** | Extra tail for an end card is added at mux time. `t` is always *song* time; if you pad the file, every measured time shifts and the gold hashes of the whole film move. |
| The true duration is written down | `ffprobe -v error -show_entries format=duration -of csv=p=0 audio/song.wav`. Compare it against `analysis/audio.json::duration`. |

If the user hands you an MP3, convert once and keep both:

```bash
ffmpeg -i input.mp3 -ar 48000 -ac 2 -c:a pcm_s16le audio/song.wav
```

Record the conversion in `docs/PROGRESS.md`. A source that was resampled twice is a source whose transients
have moved.

**MUST NOT**: trim a leading silence out of the file to make bar 1 start at 0. If the song starts at 0.43 s,
bar 0 starts at 0.43 s, and the timeline's first shot covers `[0, 0.43)`. That silent head is real screen
time and it is one of the few places an MV may legitimately open on black.

---

## 2. What the pipeline does, at the level you need

Each step exists because a specific failure was observed. You are not expected to reimplement any of it;
you are expected to reason about which step is wrong when the output looks wrong.

| # | Step | Output in `analysis/audio.json` | What breaks when it is wrong |
|---|---|---|---|
| 1 | **Probe** the source | `duration`, `sampleRate`, `fps`, `frames` | Every count downstream is off; `render.frameCount` fails at Stage 7. |
| 2 | **Mono working buffer** at `analysisRate` (24 kHz) | `analysisRate` | A high `analysisRate` costs time, not accuracy; a low one blurs onsets into each other. |
| 3 | **Onset envelope** (spectral flux) | feeding `onsets[]` | The envelope is the substrate for tempo, beats and snapping. A bad envelope produces a confident wrong grid. |
| 4 | **Tempo and phase search** (autocorrelation over the onset envelope + phase search) | `tempo.bpm`, `tempo.confidence`, `tempo.beatPeriod`, `tempo.firstBeat`, `tempo.octaveCheck`, `tempo.method` | Phase errors put every beat a fraction of a beat off; octave errors double or halve the grid. |
| 5 | **Beat tracking** with a time-varying period | `beats[]`, `tempo.driftMsPerMin` | A constant-period tracker drifts late on anything with rubato or a live drummer. |
| 6 | **Snap to onsets** | `beats[]` (snapped), `beatsSmooth[]` (unsnapped, spline) | Unsnapped beats sit where the *estimate* is, not where the transient is — so cuts land late. See §5. |
| 7 | **Bars** from the downbeat phase | `bars[{index, start, end, bpm, pickup, beats}]`, `meter` | A wrong phase turns every bar line into beat 2 or 3; `b(i,0)` then means the wrong moment. |
| 8 | **Sections** (energy + novelty grouping, or the manual override) | `sections[{index, name, start, end, energy, confidence, manual}]` | Unreliable on real masters. See §4. |
| 9 | **Events**: onsets, impacts, stops, vocal activity | `onsets[]`, `impacts[]`, `stops[]`, `vocalActivity[]` | These are the cue source material and the `HIT()`/`STOP()`/`VOX()` lookups. |
| 10 | **Per-frame envelope** at `fps` | `analysis/envelope.json` + `.f32` | Continuous motion, glows and HUD read this. See §6. |

Event vocabularies (closed sets — an unknown value MUST fail validation):

- `impacts[].kind` ∈ `first_sound | stop | gap | drop | breakdown | hit | section_start | final_cut | end_of_tail`
- `stops[].kind` ∈ `stop | gap`
- `onsets[].band` — the frequency band the onset was detected in.

`notes` carries the provenance prose for the whole artifact
([`../../../docs/SPEC.md`](../../../docs/SPEC.md) A7). Read it. If it says the numpy fallback path was used
instead of the optional beat-tracking library, the beats are cruder and you should expect to curate more
cues by hand ([`../../../docs/ENVIRONMENT.md`](../../../docs/ENVIRONMENT.md) §2).

`generatedAt` MUST be `null`. Analysis is reproducible or it is not a contract.

---

## 3. The octave error — the single most common failure

The tempo search can lock onto **half** or **double** the true pulse rate. Nothing downstream complains:
`beats[]` is self-consistent, `bpm` is a plausible number, and every cut is wrong by a factor of two.

**Why the JSON cannot tell you.** `bpm` is a label and `beats[]` is a list of times; a doubled grid is a
perfectly valid list of times. There is no internal contradiction to detect. That is exactly why the
overview plot is a checkpoint and not a nicety ([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md)
stage 2).

**How to spot it on the overview plot**, in this order:

1. Find a passage you can read the pulse off — a four-on-the-floor section, a hand-clap backbeat, a
   build-up with a kick you can see as a repeating low-frequency blob.
2. Count the ruler marks drawn across **one bar label** on the plot. A 4/4 bar divided by 4 is right;
   divided by 8 means the grid is **doubled**; divided by 2 means it is **halved**.
3. Check the ruler against the transients. On a correct grid, most rulers sit on a visible attack. On a
   doubled grid, half the rulers sit in the middle of a sustained note, where nothing happens.
4. Check the bar lines against the arrangement. Section boundaries and the first big downbeat should
   coincide with bar lines; if the plot's section bands start halfway between bars, the phase is wrong too.
5. Read `tempo.confidence` and `tempo.octaveCheck` **after** doing 1–4, never instead of them. `halved`
   and `doubled` are the field admitting the ambiguity; `uncertain` means the estimator could not decide
   and you must.

**The fix** is a tempo range around the truth, from [`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md)
stage 2's worked example:

```bash
cvpw analyze --bpm-range 55,70          # brackets a true tempo near 60 that came out at 120
cvpw analyze --bpm-range 115,145        # brackets a true tempo near 130 that came out at 65
```

Pick the range by tapping along to the section you trust and doubling/halving until it matches, then
bracket that number ±10 %. Re-run, re-open the plot, re-read the bar count. An octave fix changes `bars[]`
and therefore every `b(i,j)` in the timeline, so do it **before** Stage 3, not after.

Related, and worth checking at the same time: a `driftMsPerMin` that is large on a machine-locked
electronic track is usually an octave or phase symptom rather than real drift.

---

## 4. Sections: automatic grouping is a proposal, not a verdict

Automatic section grouping is unreliable on real masters — compressed, heavily produced, or
AI-generated material has few clean novelty boundaries, and arrangement-only boundaries score low.

`analysis/sections.json` is **authored** and is the intended manual override; `cvpw analyze` reads it when
it exists ([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §1). The procedure:

1. Run `cvpw analyze` once and read `analysis/sections_auto.json` (the automatic proposal).
2. Copy it to `analysis/sections.json`.
3. Fix the boundaries **by ear and by the plot**: whole bars, every bar covered exactly once, in order.
4. Re-run `cvpw analyze`. The manual file wins.
5. Check `sections[].confidence`. A low confidence on a boundary your ears agree with is fine; a high
   confidence on a boundary you disagree with is the estimator being fooled by a repeated loop.

MUST NOT overwrite `analysis/sections.json` from a tool without an explicit `--force`, and the write MUST
be announced (authored artifacts are the only place human judgement enters the pipeline).

Naming: keep the label vocabulary consistent across the film (`intro`, `verse`, `pre-chorus`, `chorus`,
`bridge`, `outro`, …) because `S('chorus')` resolves by name and the storyboard's pacing rules are written
in terms of verses and choruses. Two sections with the same name is legal; `S(2)` by index is how you
disambiguate.

---

## 5. Snap to onsets, and why an unsnapped grid cuts a frame late

Beat tracking estimates a *period* and a *phase*; the estimated beat instant is the model's opinion, not
the sound. Snapping moves each tracked beat onto the nearest onset peak within a small window, which is
why the artifact carries two arrays:

| Array | What it is | Use it for |
|---|---|---|
| `beats[]` | snapped to onset peaks | **Hits**: cuts, flashes, slams, anything a viewer reads as landing *on* the sound. |
| `beatsSmooth[]` | spline-smoothed, jitter-free | Continuous motion: camera speed, loops, a rotation that must not stutter. |

**Why this matters at frame level.** A cut at time `t` appears in the first frame whose time is `>= t`.
If the grid is unsnapped and sits 15–30 ms late relative to the transient, the frame that contains the
transient is skipped and the cut reads one frame late — visible on every hit in the film, and invisible in
every list of numbers. Snapping removes the systematic part of that error; the residual is what the
`beatsSmooth`/`beats` split is for.

Using a `beatsSmooth[]` value as a hit time has the mirror-image defect: a smoothed grid can sit up to
~20 ms off the transient, and worse, it does not jitter the way the music does, so a run of hits reads
mechanically.

**Open question, check it rather than assume it**: [`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md)
§3 defines `b(i,j)` and `h(n)` but does not say which array the timebase builds the grid from. Confirm
empirically by reading the seconds a `b(...)` resolved to in `render/report.json::resolvedTimes` and
comparing it with `beats[]` and `beatsSmooth[]`. If the two disagree and the cut looks late, this is why.

---

## 6. The envelope contract

`analysis/envelope.json` is small JSON metadata; `analysis/envelope.f32` is the data.

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

| Channel | Reads as |
|---|---|
| `rms` | broadband loudness — the general "how big is this moment" driver |
| `low` | 20–150 Hz — kick and bass; breakdowns show as near zero, drops as a step |
| `mid` | 150–2500 Hz — the body of the voice and the instruments |
| `high` | 2500–16000 Hz — cymbals and air; use it for sparkle, never for a hit |
| `onset` | spectral-flux onset strength, unsmoothed; the transient driver |
| `beat` | index of the current beat within the bar (0 = downbeat) |
| `bar` | index of the current bar |
| `vocal` | 1 inside a `vocalActivity` span |

**Loader rules — both are normative and both are surprising on purpose**
([`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §5):

1. The loader **MUST** validate `blob.byteLength === frames * channels.length * 4`. A mismatch means the
   JSON and the blob are from different runs; trusting either one silently mis-scales every feature.
2. On a mismatch **or a missing file**, the loader **MUST degrade to zeros** and push a **named warning**
   into `cvpw.meta.warnings`. It MUST NOT throw. Preview must survive a missing analysis — a render that
   dies because an optional feature file is absent is worse than a render without the feature.

If you see the warning, do not ignore it: every envelope-driven element in the film is now driven by
zeroes and the result will look "flat but working", which is the hardest class of defect to spot.

Values are **normalised per channel to [0,1] with no temporal smoothing**. Two consequences:

- A channel's 0.5 means "halfway between this track's 1st and 99th percentile", not "half loud". Compare
  a value against the same channel elsewhere in the same song, never against a number from another project.
- Nothing is smoothed, so reading a single frame's `onset` gives you a spiky value. Smooth it in the
  scene if you want a shape, and seed anything jittery from `frameIndex(t)` rather than `t`
  ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) D4–D5).

---

## 7. Read the overview plot — a literal checklist

Open `analysis/overview.png` and go through this in order. Write down what you saw; the Stage 2 checkpoint
is a human looking at this list, not a summary of the JSON.

1. **Where does the audio actually start and end?** Is there a silent head, a count-in, a reverb tail? Does
   `duration` match what `ffprobe` reported? A tail that ends mid-decay will truncate the end card.
2. **Do the section bands land where the arrangement changes?** Bass entering, drums dropping out, the
   vocal starting. Misplaced bands are the most common manual-override trigger.
3. **Are the section names plausible in order?** An `intro` after a `chorus` usually means the automatic
   grouping aliased, not that the song is unusual.
4. **Octave check (§3): count rulers per bar label.** 4 in 4/4. Anything else is the bug.
5. **Downbeat phase.** Do the heavy bar lines land on the kick / the obvious "one"? A phase error shows as
   every bar line landing one beat early or late, consistently.
6. **Grid stability.** Do ruler spacings stay constant through a tempo change, a rubato passage, or a
   ritardando? A grid that stays rigid through a real slowdown is drifting late by the end of it.
7. **Impacts.** Are the marked impacts on real transients? A plot covered in `hit` marks during a quiet
   verse means the threshold is too low; an empty chorus means it is too high.
8. **Stops.** Do the marked silences match the visible dips? A `stop` on a quiet-but-not-silent passage is
   a full-band dropout, which is a *different* visual opportunity from a true stop.
9. **Vocal activity.** Do the vocal bands cover the sung parts and leave the instrumental breaks clear?
   If a separated vocal stem was available and not used, the spans are estimates.
10. **Then open `analysis/audio.json` and spot-check three or four events** against the plot: a downbeat, a
    stop, an impact, the final cut. If the numbers and the picture disagree, the picture is what a viewer
    will see.

If any of 4, 5 or 6 fails, **stop**. Do not proceed to Stage 3 and "work around it in the timeline" — every
time expression in the film resolves against this grid.

---

## 8. Acceptance

Stage 2's acceptance list is normative
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 2). Restated for this file:

- [ ] `analysis/overview.png` exists and an agent has opened it and worked §7 top to bottom.
- [ ] `tempo.confidence` is reported; `tempo.octaveCheck` is `ok`. If it is not, either fix it with
      `--bpm-range` or write down why the ambiguity is unrecoverable for this track.
- [ ] `analysis/sections.json` exists if the automatic grouping was wrong, and `sections[]` reads correctly.
- [ ] Every cue in `cues/cues.json` carries a `source`; anything still `initial` is listed for the operator.
- [ ] `analysis/audio.json::generatedAt` is `null`; `notes` states the method and the known error.
- [ ] Two runs of `cvpw analyze` on the same input produce byte-identical artifacts. If they do not, that
      is a determinism bug, not a rendering curiosity
      ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) A6).

**Escalate rather than guess.** If the meter is not 4/4, if the track is through-composed with no stable
pulse, or if the tempo changes so much that no single grid holds, say so. A report that the grid is a
compromise is worth more than a timeline built on a grid that is quietly wrong
([`../../../docs/SPEC.md`](../../../docs/SPEC.md) §1, "stop and report, not guess").

Next: [`./02-lyric-timing.md`](./02-lyric-timing.md) for lyrics, or
[`./03-cue-curation.md`](./03-cue-curation.md) for everything that is not on the grid.
