/**
 * Automatic speech recognition, as an abstract seam — and the policy that decides when it is even asked.
 *
 * ## The policy, in order, and it is not negotiable
 *
 * 1. **A lyrics file wins.** If the project has lyrics with timing (`lrc` or `manual`), nothing here runs. A
 *    human wrote those times or a player emitted them; both are facts, and no amount of signal processing improves
 *    on a fact.
 * 2. **With lyrics but no timing, alignment is the job** — and it prefers the words over recognition, because
 *    recognising words you already have is strictly worse: slower, lossy, and it can disagree with the text the
 *    film will actually display.
 * 3. **With no lyrics at all, the agent must ASK a human** whether to run recognition or to hand-correct. This
 *    framework does not silently choose. Both paths cost human time, and only the human knows which cost is
 *    affordable today.
 * 4. **Recognition is never mandatory.** A film can ship with `estimated` timings and say so. `docs/SPEC.md` T7
 *    already separates timing from text; this is the same principle applied to provenance.
 *
 * ## Why this module is an interface and nothing more
 *
 * Every ASR stack is connected differently: a local Python service, a CLI binary, a cloud HTTP API with a key, a
 * WebSocket stream. Writing an adapter for each is unbounded work that ages badly, and a framework that pretended
 * to know them all would ship twenty adapters and zero that work on the reader's machine.
 *
 * So this file defines the **shape** and nothing that implements it. The concrete adapter is written by the agent
 * or the human, for the machine in front of them, in their project — see `docs/EXTENDING.md`.
 *
 * A worked example lives outside this repository's runtime: on the reference machine there is a GPT-SoVITS
 * installation whose ASR tooling is a real, concrete connection. It is documented in
 * `docs/ALIGNMENT.md` as an example of the *shape* a connection takes, not as something this framework calls.
 * A full recognition pass on that machine is slow — measured, not assumed — which is precisely why the policy
 * above asks before spending it.
 *
 * ## What an adapter must guarantee
 *
 * Determinism is not required here, and that is deliberate: recognition output is a *fact about an audio file*,
 * and the fact does not change between runs. What is required is that its result is **frozen into an artifact**
 * with its provenance recorded, so a later render never re-asks and never drifts. `source: "aligned"` plus the
 * provider name and version is that record.
 */

/** What a line of recognised or aligned text looks like, independent of who produced it. */
export interface AlignedLine {
  /** Seconds from the start of the audio. */
  start: number;
  /** Seconds. Omitted when the provider only reports starts. */
  end?: number;
  text: string;
  /**
   * How strongly the provider believes this line begins at `start`, 0–1. Not required, because most stacks do not
   * expose one and inventing a number would be worse than its absence.
   */
  confidence?: number;
}

/** What a provider is told. Deliberately small: a provider that needs more should take it from its own config. */
export interface AsrRequest {
  /** Absolute path to the audio file. ASCII-only on Windows, which the caller is responsible for. */
  audioPath: string;
  /** Absolute path to a plain-text lyric file, when one exists. Recognition may use it as a hint; it must not ignore it silently. */
  lyricsPath?: string;
  /** BCP-47-ish language tag, e.g. `en`, `zh`. Providers may ignore it. */
  language?: string;
  /** Abort signal, so a slow local model does not hold a render forever. */
  signal?: AbortSignal;
}

/**
 * The seam.
 *
 * `name` and `version` are recorded in the artifact because "aligned by something" is not provenance. A line
 * aligned by `whisper-large-v3` and one aligned by a hand-tuned local model are not the same claim, and the next
 * agent needs to know which one it is looking at.
 */
export interface AsrProvider {
  readonly name: string;
  readonly version: string;
  /**
   * A one-line statement of what this provider needs to exist — a URL, an API key, a binary on PATH. Shown to the
   * human before they are asked to choose, because "use recognition" is not a choice if the answer requires a key
   * they do not have.
   */
  readonly requires: string;
  /** Whether `requires` looks satisfiable right now. A cheap probe, not a network call. */
  isAvailable(): Promise<boolean>;
  recognise(request: AsrRequest): Promise<AlignedLine[]>;
}

/**
 * How a project says which provider to use, if any.
 *
 * Written into `project.json` so the choice is recorded rather than remembered, and so a project that deliberately
 * ships without recognition says that too — which is different from forgetting to decide.
 */
export interface AlignmentPolicy {
  /**
   * `lyrics` — use the lyric file, never recognise.
   * `asr` — recognise, with the named provider.
   * `manual` — a human will correct the timings.
   * `estimated` — spread across detected vocal activity and label it as such.
   */
  mode: "lyrics" | "asr" | "manual" | "estimated";
  /** Required when `mode` is `asr`. Must match a provider's `name`. */
  provider?: string;
  /** Free text: why this mode was chosen. Without one the choice is indistinguishable from an accident. */
  reason?: string;
}

/**
 * Decide what to do, given what exists on disk. Returns a decision **and** the question to ask when there is one.
 *
 * This is a pure function so the policy is testable without a browser, an audio file, or a provider. The policy is
 * the part most likely to be got wrong, and the part whose getting-wrong is hardest to notice.
 */
export function decideAlignment(input: {
  hasLyricsFile: boolean;
  hasLyricTiming: boolean;
  policy?: AlignmentPolicy;
  availableProviders?: readonly string[];
}): {
  action: "use-lyrics" | "asr" | "manual" | "estimated" | "ask";
  reason: string;
  question?: string;
} {
  const { hasLyricsFile, hasLyricTiming, policy, availableProviders = [] } = input;

  // Rule 1: a fact beats a computation. Timed lyrics are a fact.
  if (hasLyricTiming) {
    return {
      action: "use-lyrics",
      reason: "the project already has timed lyrics; recognising words that are already placed can only make them worse",
    };
  }

  // A recorded decision is honoured, including the decision not to recognise.
  if (policy && policy.mode !== "asr") {
    if (policy.mode === "lyrics" && !hasLyricsFile) {
      return {
        action: "ask",
        reason: "project.json says `lyrics` but no lyric file exists, so the policy cannot be carried out",
        question: "There is no lyric file. Do you have lyrics to add, or should the timings be estimated and labelled as such?",
      };
    }
    return { action: policy.mode === "lyrics" ? "use-lyrics" : policy.mode, reason: policy.reason ?? "recorded in project.json" };
  }

  if (policy?.mode === "asr") {
    const provider = policy.provider;
    if (!provider) {
      return {
        action: "ask",
        reason: "project.json selects `asr` but names no provider, so there is nothing to call",
        question: "Which recognition provider should be used? A concrete adapter has to exist for this machine first.",
      };
    }
    if (!availableProviders.includes(provider)) {
      return {
        action: "ask",
        reason: `project.json selects provider ${JSON.stringify(provider)} but no adapter with that name is present`,
        question:
          `No adapter named ${JSON.stringify(provider)} was found. Write one for this machine, choose a different ` +
          `mode, or estimate and label it as such.`,
      };
    }
    return { action: "asr", reason: `project.json selects provider ${JSON.stringify(provider)}` };
  }

  // Rule 3: no decision recorded, no timed lyrics. Ask — and name the cost of each path, because that is what the
  // human is actually choosing between.
  if (hasLyricsFile) {
    return {
      action: "ask",
      reason: "lyrics exist but are untimed, and there is no recorded decision about how to time them",
      question:
        "Lyrics exist but have no timings. Options: (a) align them to the audio with recognition — needs an adapter " +
        "for this machine and can be slow; (b) align by energy peaks without recognition — fast, less precise, and " +
        "labelled `aligned`; (c) hand-correct the timings. Which?",
    };
  }
  return {
    action: "ask",
    reason: "no lyric file and no recorded decision, so the framework will not choose on the human's behalf",
    question:
      "There is no lyric file. Options: (a) supply lyrics and align them; (b) run speech recognition to produce " +
      "text and timings — needs an adapter for this machine and can be slow; (c) skip lyrics entirely. Which?",
  };
}
