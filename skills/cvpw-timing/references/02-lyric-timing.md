# 02 — Lyric timing, safely

Turning lyrics into timings without publishing someone else's words and without inventing a time you
cannot defend. Read [`../SKILL.md`](../SKILL.md) first for the stance: you cannot hear the audio.

```bash
cvpw lyrics [--join <file>] [--json]      # LRC or plain text → timing (and text, if it is being kept)
cvpw lyrics --check [--json]              # the lyrics.alignment measurement
```

The normative artifact shapes are [`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §7; the
threshold is `lyrics.alignment` in [`../../../docs/QA.md`](../../../docs/QA.md) §2.

---

## 1. Official text is authoritative; transcription is the last resort

The order of preference is not a style preference, it is an accuracy ranking:

| Rank | Source | Trust it for | Its failure |
|---|---|---|---|
| 1 | **Official lyrics from the artist / publisher / user** | The words, the spelling, the kanji/kana or diacritic choices, the line breaks the artist intended | It has no timings at all — which is the normal case, and is what this file is about. |
| 2 | **A timing file the user already has** (LRC, an SRT, a karaoke sheet) | Line starts and ends | Line breaking may not be yours; the file may have been made from a different edit of the song. |
| 3 | **Forced alignment** of known text against the audio | Line and word onsets, when the vocals can be isolated | Needs the text *and* a reasonably clean vocal; degrades badly on a dense mix. |
| 4 | **Automatic transcription** (speech recognition) | Nothing you would put on screen | Mishears homophones, drops soft words, invents text in silence, and its timestamps are wrong by a lot. See §2. |

**MUST**: ask for the official text before doing anything clever. A transcription that disagrees with an
official sheet is not a reconciliation problem, it is a wrong answer.

**MUST NOT**: ship transcribed text as if it were the lyrics. If transcription was the only option, the
lines it produced are *uncertain* and the delivery report must say so, per line.

Note the asymmetry that saves work: **timing does not need the text to be right.** If the official text
exists but has no timings, you align; if neither exists, you are in §2 and the project's licence position
is a separate question.

---

## 2. Why automatic word timestamps must never be treated as onsets

Speech-recognition word timestamps are emitted by a language model that is decoding *what was said*, not
measuring *when the sound started*. In practice they run **40 ms to 2 s early**, and the error is worst
exactly where a lyric video is most exposed:

- after a long held note, where the model places the next word at the end of the sustain;
- through reverb or a dense arrangement, where the model's boundary is smeared earlier;
- on a repeated hook, where the model's segmentation collapses several phrases into one span.

40 ms is one frame at 24 fps. Two seconds is a whole bar. Yet the numbers *look* precise — they come with
three decimal places — which is exactly why they get used.

**MUST NOT**: register an ASR word timestamp as a lyric onset, a `VOX()` target, or a cue with
`source: "measured"`. `source: "initial"` is the honest label for one, and it MUST then be settled or
promoted before the project leaves Stage 2.

**The correct derivation** is to take the *word's approximate neighbourhood* from the transcript — it is
good enough to say "this word is somewhere in this half-second" — and then find the actual onset in the
**vocal-band onset envelope** near it. That is a measurement, and it can be cited.

```text
candidate = nearest onset in envelope.vocal / onset band within ±400 ms of the approximate time
if none:  keep the ASR time, mark the line `manual: true` with a note, and list it as uncertain
```

If a separated vocal stem exists, derive the envelope from the stem; the whole point of a stem is that the
vocal's transients stop competing with a snare drum. Vocal separation is OPTIONAL in this framework
([`../../../docs/ENVIRONMENT.md`](../../../docs/ENVIRONMENT.md) §2) and is not part of the v1 pipeline — if
it is unavailable, expect the degraded path and say so.

---

## 3. The copyright-safe split: text-free timing plus a local join

**The problem.** An MV project needs the lyric *timing* in version control — it is what the timeline
resolves against — and the lyric *text* is somebody else's property. Committing both makes the repository
a redistribution of the song's lyrics.

**The mechanism** ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T7,
[`../../../docs/CONTRACTS.md`](../../../docs/CONTRACTS.md) §7):

| Artifact | Contains | Committable? |
|---|---|---|
| `cues/lyrics.timing.json` | Line index, `start`, `end`, word and character **counts**, and two hashes. **No lyric text.** | Yes, always. |
| `cues/lyrics.json` | The actual lines: `{ i, text, section, emphasis }`. | Only when the project declares the text licensed; otherwise absent or git-ignored. |

The two hashes are the join key:

- `h` — `sha256(text words, lowercased, punctuation stripped)[0:8]` — the *normalised* line. Robust to
  punctuation and casing differences.
- `x` — `sha256(exact line text)[0:8]` — the exact line. Catches a spelling change.

```jsonc
{ "$schema": "schemas/lyrics-timing.schema.json", "schemaVersion": 1,
  "count": 1,
  "sections": [{ "index": 0, "start": 0.0, "end": 4.0, "firstLine": 0, "lastLine": 0 }],
  "lines": [{ "i": 0, "start": 0.5, "end": 2.5, "words": 3, "chars": 12,
              "h": "9f2a1c04", "x": "1b77e0aa", "manual": false }] }
```

**The join is local.** A user with the text runs `cvpw lyrics --join <file>`. The tool recomputes the
hashes for the supplied lines, matches them against the timing table, and writes `cues/lyrics.json`. A
mismatch MUST fail loudly, naming the line index — a silent mis-join attaches one line's timing to
another line's words, and the film then shows the wrong sentence at the wrong moment in a way no gate can
see.

**Why the delivery scanner exists.** `project.json::lyricsText` is `"local-only"` or `"licensed"`; when it
is `"licensed"`, `lyricsLicence` must say who granted it and for what. `cvpw deliver` MUST refuse to publish
a project containing `local-only` text, and the failure is the check id `publish.lyricText`, which **is not
waivable** ([`../../../docs/QA.md`](../../../docs/QA.md) §2). The mechanism is not a formality: it is the
difference between a project that can legally ship and one that cannot, and it must fail *before* the
master is uploaded, not after.

**Practical consequence for you**: write the timing table, never the text, into anything you commit. When
you need to reason about a line, refer to it by index (`L(12)`) or by paraphrase, and keep the text in the
local-only file.

---

## 4. Path A — the user has timings (LRC)

The cheapest correct answer. If the user has an LRC, use it.

```bash
cvpw lyrics                       # picks up the supplied timing file
cvpw lyrics --check --json        # lyrics.alignment against detected vocal onsets
```

What to check immediately:

1. **Line count.** Does the number of timed lines equal the number of lyric lines in the text? A missing
   line in a timing file is invisible unless you count.
2. **First and last line.** Do they land where the singing starts and stops? An LRC offset by a constant
   (a `[offset:]` tag, or a file timed against a different master) shows up here first.
3. **Line breaking.** If the LRC breaks a sung phrase differently from your display lines, you are in §6.
4. **Instrumental markers.** `[間奏]`-style rows are structural, not lyric lines. They must not become
   `L(n)` indices.
5. **Run `--check`.** LRC timings are hand-made and can be systematically early by 100–300 ms because a
   human reacts to the sound. The gate is ±150 ms; a file that fails it evenly across all lines is an
   offset problem, not a per-line problem.

An LRC is `source: measured` in spirit — but the *artifact* is `cues/lyrics.timing.json`, which has no
`source` field, so record where it came from in `docs/PROGRESS.md` and in the tool's own `notes`. If you
promote a line's time into `cues/cues.json` as a named cue, give that cue `source: "measured"` only if it
came from the envelope; a time copied from a supplied file is `source: "audit"` or `"analysis"` with the
file named in `note`.

---

## 5. Path B — plain text only (forced alignment)

Alignment means: you have the correct text, and you ask the machine where in the audio each word is. It is
strictly better than transcription because the words are already known; the search space is *when*, not
*what*.

**Alignment needs separated vocals to work well.** In a dense mix the aligner must match phonemes against
a signal where the vocal is one component among many, and it responds by sliding a whole phrase to the
nearest loud thing. The failure signature is a line whose start lands in the middle of the previous
phrase's tail, or in an instrumental break.

```text
1. If a vocal stem is available, align against it. If not, align against the full mix and expect
   more manual correction — record which one you did.
2. Align in groups of consecutive lines from the same section (a handful at a time), not the whole song
   at once. A wrong boundary inside a group is local; a wrong boundary in a full-song pass moves
   everything after it.
3. Give each group a generous window cut from the approximate line start. Too tight a window clips the
   first syllable and biases the onset early.
4. Check every resulting onset against the vocal-activity spans. An onset that lands inside a
   `stops[]` silence is wrong by construction — override it.
5. Where the aligner grabbed the previous phrase's tail, correct by hand and mark the line `manual: true`.
```

**Then refine the last 100 ms.** Alignment gives you a phoneme boundary, which is close to but not the
same as the perceptual onset of the sung word. A useful independent check is that lyric onsets tend to sit
a small, roughly constant distance *after* a grid subdivision — if your corrected onsets cluster around
a consistent offset from the nearest sixteenth, your correction is working; if they are uniformly
distributed, the aligner is guessing and you should say so.

**MUST NOT** invent a correction that you cannot describe. "I nudged it 80 ms later because it felt right"
is a guess; write `source: "manual"` with the note "audited by ear, +80 ms", and it becomes a recorded
human decision, which is allowed.

---

## 6. Reconciling against a different line breaking

The timing table is keyed to **lines**, and its `h` hash is over a line's normalised words. If the user
supplies text with different line breaks — a long line split in two, two short lines merged — every hash
after the change mismatches, and a naive join fails.

**Do not re-break the timings by eye.** Do a **dynamic-programming alignment over normalised words,
ignoring line breaks entirely**:

```text
1. Normalise both sides exactly as `h` does: lowercase, strip punctuation, collapse whitespace,
   then split to a word sequence. Keep a map from each normalised word back to (line index, char offset).
2. Align the two word sequences with an edit-distance DP: match = 0, substitution = 1,
   insertion/deletion = 1. Backtrack to get a monotone word-to-word correspondence.
3. For each NEW line, its start is the time of the OLD word matched to the new line's first word;
   its end is the time of the OLD word matched to the new line's last word.
4. Recompute `h` and `x` from the new line breaking. The old hashes are now stale by definition —
   a hash that matches after a re-break is a coincidence.
5. Re-run the join, then `cvpw lyrics --check` and the alignment measurement again. Re-breaking can move
   a line by most of a bar if the DP matched across a repeat.
6. Sanity-check monotonicity: line starts MUST be strictly increasing. A crossing means the DP matched
   into a repeated chorus and took the wrong instance of it — a repeated hook is the single most likely
   place for this to happen.
```

Repeated sections are the trap: the same words appear twice, and the DP can match the second occurrence
of a chorus to the first. Constrain the DP with the section boundaries from `analysis/audio.json` when you
can — a word in the second chorus cannot match a word in the first.

---

## 7. What "good" looks like

The gate is `lyrics.alignment`: **every lyric line within ±150 ms of a detected vocal onset where vocal
activity exists** ([`../../../docs/QA.md`](../../../docs/QA.md) §2). Its offenders are named
`lyric-early <line> <ms>` and `lyric-late <line> <ms>`, and a waiver is allowed — but a waiver on a lyric
line means the film shows the wrong thing at the wrong time, so it needs a reason a human would accept.

A pass is not the same as "good". Report, every time:

| Report item | Why |
|---|---|
| **Median offset** (signed) | Distinguishes a systematic offset (fix the whole file by that constant) from noise. |
| **IQR** (25th–75th percentile) | The spread is what a viewer feels. A median of +5 ms with an IQR of ±400 ms is a worse film than a median of +40 ms with an IQR of ±30 ms. |
| **Count and list of lines outside ±150 ms** | The offenders. Each one is either fixed or explicitly accepted, with the reason. |
| **Count of lines with no vocal onset nearby** | Lines in a section with no vocal activity cannot be measured. Say so; do not let them silently count as passes. |
| **The method** | "LRC supplied by the user, checked against the envelope", "forced alignment on the full mix", "ASR neighbourhood + envelope refinement". Different methods have different error shapes. |

Put the summary sentence in the `observed` field of the `lyrics.alignment` row in `qa/report.json` and in
`docs/PROGRESS.md`. A number with no spread is not honest reporting.

**Tolerance is not negotiable per line.** The one legitimate adjustment is a single constant offset applied
to every line, and only when the *evidence* is a constant: every line early by the same amount means the
timing source was offset, not that a hundred lines were each mistimed.

---

## 8. A manual-fix record

When a human corrects a line, the correction must survive the next tool run and explain itself. Two shapes,
in order of preference:

**In the cue registry** (when the corrected moment deserves a name the storyboard can use):

```jsonc
// cues/cues.json
{ "id": "vox.line12.in", "t": 62.18, "source": "manual",
  "label": "line 12 (chorus hook) enters",
  "note": "auditioned by ear against the isolated vocal; alignment put it at 61.90 (in the previous phrase's tail)" }
```

**In the timing table** (when it is a line start and nothing else):

```jsonc
// cues/lyrics.timing.json
{ "i": 12, "start": 62.18, "end": 64.05, "words": 4, "chars": 9,
  "h": "…", "x": "…", "manual": true }
```

Rules for both:

- `manual: true` / `source: "manual"` MUST NOT be overwritten by any tool
  ([`../../../docs/SPEC.md`](../../../docs/SPEC.md) T6). `cvpw cues` reports it as skipped, and that is the
  correct behaviour, not a bug to work around.
- A correction without a `note` is a future argument. Say what it was before, what it is now, and what
  evidence moved it.
- Corrections are listed in `docs/PROGRESS.md` — an undocumented deviation is indistinguishable from a bug.

---

## 9. Syllable-level timing is Phase 2, and you must not fake it

Syllable-level (mora-level, per-character) timing needs a **language-specific pronunciation step**: the
display token must be converted into pronunciation units before anything can be aligned to the audio.

```text
display token  ──pronunciation mapping──▶  pronunciation units  ──align──▶  per-unit times
"ひび割れた"       mora                        hi-bi-wa-re-ta
"唱歌"            pinyin syllables             chang-ge
"singing"        (as-is; English is stress-timed, not syllable-timed)
```

That mapping is language-specific, needs a correct reading of each token, and needs a verified mapping
table. It is **Phase 2 in this framework** — the v1 pipeline is official lyrics plus line-level alignment,
and a full transcription/alignment pipeline is explicitly out of scope for step 1
([`../../../docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) stage 2, "Analysis takes minutes").

**Inventing mora or syllable splits for a language you cannot verify is worse than reporting line-level
timing.** A plausible-looking split drives a karaoke wipe at the wrong instant on every character, and it
looks *deliberate* — which means nobody catches it. Line-level timing that a human has checked is a real
deliverable; syllable-level timing that nobody can read is a defect with a lot of detail.

**What to do instead**, in order:

1. Report line-level timing, with the median/IQR honesty of §7.
2. If word-level timing exists and was *measured* (envelope-refined, not ASR raw), use it, and label it.
3. If the language is one whose pronunciation mapping you genuinely cannot verify, say so in the delivery
   report and hold the karaoke-style effect at line level.
4. Raise it as a Phase 2 request rather than implementing a private version inside the project.

**A related gap worth knowing about**: the time expression `VOX('word')` looks up a sung word's onset, but
`cues/lyrics.timing.json` carries only a **count** of words per line, not per-word times. So word-level
lookups need a word-level source that v1 does not declare. If `VOX()` throws with "word not found" and the
words are clearly present, that is why — and the fix is `L(n)` plus a cue, not a hand-typed second.

---

## 10. Acceptance

- [ ] The text used is the official text, or the fact that it is not is written down and per-line uncertain
      lines are listed.
- [ ] No ASR word timestamp is registered as a measured onset.
- [ ] `cues/lyrics.timing.json` contains no lyric text; `project.json::lyricsText` is set correctly; if it
      is `"local-only"`, nothing under version control contains the words.
- [ ] The join has been run locally and a mismatch would have failed loudly (test it with a deliberately
      altered line if you are unsure).
- [ ] `cvpw lyrics --check` reports every line within ±150 ms of a detected vocal onset, or the offenders
      are listed with a reason.
- [ ] The median, the IQR and the method are written into `docs/PROGRESS.md`.
- [ ] Every manual correction carries `manual: true` (or `source: "manual"`) and a note.

Next: [`./03-cue-curation.md`](./03-cue-curation.md) — how a corrected time becomes a name the storyboard
can use.
