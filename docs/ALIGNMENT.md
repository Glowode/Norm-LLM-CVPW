# ALIGNMENT — how lyric timings are obtained, and who decides

Normative for provenance. Sits with `docs/CONTRACTS.md` in authority: if an implementation disagrees with this
page about *which* path produced a timing, the implementation is wrong.

---

## 1. The order, and why it is this order

| # | Situation | What happens |
|---|---|---|
| 1 | lyrics **with** timing (`lrc`, `manual`) | used as-is. Recognition never runs. |
| 2 | lyrics **without** timing | align the words to the audio. Prefer energy/onset alignment; recognition only if asked. |
| 3 | **no** lyrics at all | **ask a human.** Recognition, hand-correction, or skip. The framework does not choose. |
| 4 | no decision recorded | **ask.** Every timing carries a `source`, and "nobody decided" is not a source. |

A lyrics file always wins over recognition. Recognising words you already have is strictly worse: it is slower, it
is lossy, and it can disagree with the text the film will actually display — at which point the subtitles and the
audio are quoting different lyrics and nobody knows which is authoritative.

`decideAlignment()` in `@cvpw/kernel` implements exactly this table and returns either an action or the question
to ask. It is a pure function, so the policy is unit-tested rather than trusted.

---

## 2. The policy is recorded, not remembered

`project.json`:

```json
"alignment": {
  "mode": "lyrics | asr | manual | estimated",
  "provider": "only when mode is asr",
  "reason": "why — without this the choice is indistinguishable from an accident"
}
```

`estimated` is a legitimate recorded choice: a project may decide that spreading lines across detected vocal
activity is good enough. What it may not do is *arrive* there silently, because `estimated` timings are
indistinguishable from real ones once written to `cues/lyrics.timing.json` — only the `source` field tells you.

Nothing in `cues/lyrics.timing.json` ever says `lrc` unless it came from a file that said so.

### The five `source` values, and the two that are easy to confuse

`schemas/lyrics-timing.schema.json` already enumerates them — the contract anticipated this page:

| `source` | Words from | Times from |
|---|---|---|
| `lrc` | the lyric file | the lyric file's own timestamps |
| `aligned` | **the lyric file** | signal alignment (onsets, energy, a forced aligner) |
| `transcribed` | **recognition** | recognition |
| `manual` | either | a human, typing |
| `estimated` | the lyric file | spread across detected vocal activity |

`aligned` and `transcribed` are not interchangeable, and conflating them is the mistake this table exists to stop:
`aligned` means *we had the words and only had to place them*, which is a much stronger claim than `transcribed`,
where the words themselves are a machine's guess. A project whose lyrics came from a file must never record
`transcribed`, because the next agent will then distrust text that was authoritative.

---

## 3. Recognition is an interface, not an integration

`@cvpw/kernel` exports `AsrProvider`:

```ts
interface AsrProvider {
  readonly name: string;      // recorded in the artifact — "aligned by something" is not provenance
  readonly version: string;
  readonly requires: string;  // shown to the human before they choose
  isAvailable(): Promise<boolean>;
  recognise(request: AsrRequest): Promise<AlignedLine[]>;
}
```

**The framework ships no adapter.** Every recognition stack is connected differently — a local Python service, a
CLI binary, a keyed HTTP API, a WebSocket stream — and writing adapters for all of them is unbounded work that
ages badly. A framework that shipped twenty would ship nineteen that do not work on your machine.

So the adapter is written by the agent or the human, for the machine in front of them, in their own project. That
is not an omission; it is the design. See `docs/EXTENDING.md` for where an adapter lives.

### What an adapter must guarantee

Determinism is **not** required: recognition output is a fact about an audio file, and the fact does not change
between runs. What is required is that the result is **frozen into an artifact with its provenance**, so a later
render never re-asks and never drifts. `source: "aligned"` plus the provider name and version is that record.

---

## 4. A worked example of the *shape* — GPT-SoVITS on the reference machine

On this machine there is a full GPT-SoVITS installation at
`F:\AI\GPT-SoVITS-v2pro-20250604`, including its ASR tooling. It is documented here as an example of what a
concrete connection *looks like*, not as anything this framework calls.

**A full recognition pass on this machine is slow** — measured previously, not assumed. That is exactly why rule 3
above asks before spending it, and why `mode: "estimated"` is a respectable answer for a first cut.

The shape an adapter for it would take:

1. `isAvailable()` — check the installation directory exists and the ASR entry point is present. A directory
   check, not a model load: the whole point of the probe is to be cheap enough to run before asking a human.
2. `recognise()` — invoke the project's ASR entry point with the audio path, wait, and translate its output into
   `AlignedLine[]`. Use the framework's Python conventions from `docs/ENVIRONMENT.md`: `PYTHONUTF8=1`,
   `PYTHONIOENCODING=utf-8`, and **ASCII-only temp paths** — the console code page on this machine is 936 and will
   otherwise mangle a path.
3. Record `name: "gpt-sovits"` and a `version` that identifies the model, not just the wrapper.

Two notes that save time:

- The `qt_ui` folder inside that installation is a prior Qt-desktop project, including analysis of the API's
  interface. It is **not** part of CVPW and nothing here depends on it. Read it only if the adapter's call shape is
  unclear.
- Its readiness matters more than its accuracy for a first pass. If the adapter reports `requires: "…"` honestly,
  a human can decide whether to wait. If it hangs silently, they cannot.

---

## 5. Measured against a real corpus, because a parser that passes unit tests proves little

The reference machine has a test corpus of 25 songs at `F:\Downloads\Music`, each `.flac` with a same-named
`.lrc`. Running `parseLrc` over all of them:

| | |
|---|---|
| files | 25 |
| timed lines in the files | 2536 |
| lines `parseLrc` returned | **2536** |
| match | yes |
| files with XML markup | **0** |
| files with multiple timestamps on one line | 0 |
| blank-text timed lines | 0 |
| throws | 0 |

Two conclusions, both of which change the plan:

**Every song already has timed lyrics**, so rule 1 applies to all 25 and neither recognition nor signal alignment
is needed for any of them. The `aligned` and `transcribed` paths exist for material this corpus does not contain —
a lyric file without timestamps. Building an onset aligner now would be building for a case that has not occurred,
which is the mirror image of the `bloom` mistake: implementing something before knowing it is needed.

**The parser is correct on real data**, not just on fixtures. That is worth stating because 2536 lines across 25
files — Japanese, Chinese and English, with translations inline — is the kind of input a hand-written regex fails
on in ways unit tests never find.

Not present in this corpus, and therefore still unexercised: a `.lrc` with XML markup, a `.lrc` whose lines carry
several timestamps, and a translation stored as separate timed lines rather than inline. If one of those appears,
these numbers are the baseline to compare against.

## 5. Failure modes this page exists to prevent

| Symptom | Cause | Fix |
|---|---|---|
| Subtitles drift a beat late, uniformly | timings estimated by spreading over `vocalActivity` and then treated as exact | set `mode: "estimated"` and accept it, or align to onsets |
| Subtitles quote different words than the audio | recognition text used when a lyric file existed | rule 1 — the file wins |
| A render takes 40 minutes "sometimes" | recognition ran on a project that had timed lyrics | rule 1, enforced by `decideAlignment` |
| Nobody can say where a timing came from | `source` overwritten or never set | every timing needs a `source`; `lyrics.alignment` only judges `lrc` and `manual` |
| An adapter works on one machine and not another | the adapter was never meant to be portable | that is the design — adapters are per-machine |
