---
name: cvpw-timing
description: >-
  Establish "when" for a Norm-LLM-CVPW video: turn audio into a measured timebase (beat grid, bars,
  sections, onsets, impacts, stops, vocal activity, per-frame envelope), time lyrics against the vocal
  without publishing the words, and curate the cue registry that carries provenance for every off-grid
  moment. Use it whenever the question is a time — beat detection, a tempo that looks doubled or halved,
  lyric timing, LRC, forced alignment, "which beat does this cut land on", cue ids, "the cut looks late",
  "the lyric line is early", or a time expression that will not resolve. Triggers: "audio analysis",
  "beat grid", "tempo is wrong", "timing", "lyric timing", "align the lyrics", "LRC", "cue list",
  "timebase", 节奏, 打拍, 节拍, 卡点, 对轴, 时间轴, 歌词时间轴, 音声解析, ビート, 拍, 歌詞のタイミング.
  Not for writing scenes, choosing a palette or designing a storyboard — use cvpw for that. Not for
  running gates, reviewing stills or shipping a master — use cvpw-qa. Not for editing or transcoding
  the song (the source file is never modified), not a DAW, not a stem separator, and not a
  speech-to-text service: transcription is a last resort here, never a goal.
---

# cvpw-timing — everything about "when"

This skill covers Stage 2 of the eight-stage pipeline and everything downstream that depends on it:
audio into a timebase, lyrics into timings, and off-grid moments into a cue registry that survives
re-analysis. Read [`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stage 2 for the normative procedure;
this file is the working stance and the routing.

## The one rule this whole skill exists for

> **You cannot hear the audio.** Every time you produce is either *measured* by a tool, *cited* from a
> file someone else measured, or *marked as a guess* that a human must confirm. There is no fourth case.

An agent that "listens" and writes `4.2` is not measuring, it is inventing, and an invented time is
indistinguishable from a measured one once it is in `timeline.json`. The framework's answer is that an
invented time cannot get in: resolution is strict, and a time the timebase cannot substantiate **throws**
([`../../docs/SPEC.md`](../../docs/SPEC.md) T3).

## The three sources of a time

| Source | What it is | Where it lives | Who writes it |
|---|---|---|---|
| **Measured from audio** | A tool detected the event: a beat, a bar, an onset, an impact, a stop, a vocal span. | `analysis/audio.json` — `beats[]`, `beatsSmooth[]`, `bars[]`, `sections[]`, `onsets[]`, `impacts[]`, `stops[]`, `vocalActivity[]` | `cvpw analyze`. Never typed by hand. |
| **Measured from a supplied file** | Someone else already timed it: an LRC, an artist-supplied timing sheet. You are citing, not measuring. | `cues/lyrics.timing.json` (lyric line starts/ends) | `cvpw lyrics` parses the file; the file is the provenance. |
| **Stated by a human** | A person listened and decided "the chorus lands *here*". | `cues/cues.json`, `source: "manual"` | The human, through the authored cue file. |

Every cue MUST carry `source` ∈ `measured | analysis | audit | initial | manual`
([`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §6, [`../../docs/SPEC.md`](../../docs/SPEC.md) T6).

**A time with no provenance is a bug, not a convenience.** The only place a bare number may appear is
`"12.5"` / `"12.5s"` in a timeline, and that raises `lint:absolute-time`
([`../../docs/SPEC.md`](../../docs/SPEC.md) T2); in `timebase.mode == "manual"` it is legal, and everywhere
else it is a signal that a cue is missing.

## Strictness — and the fix that is not a fix

A time expression is a string resolved against the timebase: `"b(32,0)"`, `"h(65)"`, `"cue('chorus')"`,
`"L(12)"`, `"VOX('sudden')"`, `"HIT('hit')"`, `"S('bridge')"`, `"STOP(0)"`, `"p(0.85)"`
(grammar: [`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §3).

**MUST**: resolution is strict. An unresolvable expression throws a `TimeExpressionError` naming the
failing token and up to three nearest valid alternatives. There is no fallback and no default.

**MUST NOT**: replace the expression with a literal second. The throw is telling you the timebase does not
contain that moment. The three legitimate fixes are:

1. Fix the analysis — the beat grid is wrong, or the section is mislabelled.
2. Fix the cue list — the moment exists but nobody registered it
   ([`./references/03-cue-curation.md`](./references/03-cue-curation.md)).
3. Fix the storyboard — the shot is asking for a moment the song does not have.

A literal "fixes" the error by deleting the information that the grid disagreed with you.

## `bpm` is a label; `beats[]`/`bars[]` is the grid

`analysis/audio.json::tempo.bpm` is a summary for humans and for the HUD. It is **not** a grid, because
tempo drifts: a track locked at 130 BPM at the first chorus can be at 132 by the last one, which is more
than a beat of accumulated error after thirty bars.

**MUST**: derive cuts from measured `beats[]` / `bars[]` / `sections[]`.
**MUST NOT**: compute `n * 60 / bpm`. ([`../../docs/SPEC.md`](../../docs/SPEC.md) T4–T5)

Look up a bar **by its `index` field**, never by array position: a song with a pickup has a bar 0 that is
not at array position 0 ([`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §4).

## Acceptance for Stage 2

Stage 2 ends when all five hold ([`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stage 2):

1. `analysis/overview.png` exists and **an agent has looked at it** — waveform, energy, beat rulers,
   section boundaries. Reading the JSON is not reviewing the grid.
2. Tempo confidence is reported and `octaveCheck` is `ok`.
3. **Every lyric line is within ±150 ms of a detected vocal onset** where vocal activity exists
   (`lyrics.alignment`, [`../../docs/QA.md`](../../docs/QA.md) §2). Report the median and the IQR, and
   name the lines that remain uncertain.
4. **Every cue carries a `source`.** Anything still `initial` is listed for the operator.
5. Sections are labelled — and on a real master that almost always means a human-edited
   `analysis/sections.json`, not the automatic grouping.

Checkpoint: show the overview plot and the section labels to a human before Stage 3. A wrong grid poisons
every downstream decision, and it is cheap to fix now.

## Where the time goes wrong (symptom → first move)

| Symptom | First move |
|---|---|
| Beats look doubled or halved on the plot | Octave error. Re-run `cvpw analyze --bpm-range LO,HI` bracketing the true tempo. See [`./references/01-audio-analysis.md`](./references/01-audio-analysis.md). |
| The grid drifts late across the song | Something is using a constant period. Confirm consumers read `beats[]`, not `n*60/bpm`. |
| A cut looks one frame late | The grid may be unsnapped, or a `beatsSmooth[]` value was used as a hit time. |
| Every lyric line reads early | Word timestamps came from ASR (they run 40 ms–2 s early). Re-derive onsets from the vocal band and re-time. See [`./references/02-lyric-timing.md`](./references/02-lyric-timing.md). |
| A re-analysis moved a cue a human fixed | A tool overwrote a `manual` cue — that MUST NOT happen. See [`./references/03-cue-curation.md`](./references/03-cue-curation.md). |
| Sections look arbitrary | Copy `analysis/sections_auto.json` → `analysis/sections.json`, fix the boundaries, re-run `cvpw analyze`. |

## References — read the one the moment needs

| file | read when |
|---|---|
| [`references/01-audio-analysis.md`](./references/01-audio-analysis.md) | You are running `cvpw analyze`, the tempo or the beat grid looks wrong, you need to read `analysis/overview.png` properly, or you are writing a scene that consumes the envelope. |
| [`references/02-lyric-timing.md`](./references/02-lyric-timing.md) | You have lyrics, in any form — official text, an LRC, or nothing but the audio — and need line or word timings that will hold up. |
| [`references/03-cue-curation.md`](./references/03-cue-curation.md) | You are about to register an off-grid moment, settle guesses onto onsets, name a cue, or the storyboard needs a time that is not on the grid. |

Framework-level and normative: [`../../docs/SPEC.md`](../../docs/SPEC.md) §5 (Time),
[`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §3–§7 (the time grammar and the analysis artifacts),
[`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md) stage 2, [`../../docs/QA.md`](../../docs/QA.md) §2.
Your platform may ship these alongside the skill; if not, they are in the framework repository the skill
came from. If a link here 404s, say so rather than guessing at the number it would have contained.
