/**
 * Timebase — the single authority on *when* things happen.
 *
 * Built from `analysis/audio.json`, `cues/cues.json`, `cues/lyrics.timing.json` and
 * `analysis/envelope.json`. Every time in authored code is resolved against an instance of this
 * type; nothing else may invent a time.
 *
 * See `docs/CONTRACTS.md` §3 (grammar) and `docs/SPEC.md` T1–T8.
 */

/** One onset event. */
export interface Onset {
  t: number;
  strength: number;
  band?: string;
}

/** A non-musical or structural moment (impact, stop, drop, final cut…). */
export interface Impact {
  t: number;
  strength: number;
  kind: string;
}

/** A silence gap. */
export interface Stop {
  start: number;
  end: number;
  depthDb: number;
  kind: string;
}

/** A section of the piece. */
export interface Section {
  index: number;
  name: string;
  start: number;
  end: number;
  confidence?: number;
  manual?: boolean;
}

/** One bar. `index` is authoritative — never assume `bars[i].index === i` (a pickup bar exists). */
export interface Bar {
  index: number;
  start: number;
  end: number;
  bpm?: number;
  pickup?: boolean;
  beats?: number;
}

export interface Tempo {
  bpm: number;
  confidence?: number;
  method?: string;
  octaveCheck?: string;
  beatPeriod?: number;
  firstBeat?: number;
  driftMsPerMin?: number;
}

/** Provenance of a cue time. Tools may refine the first four; `manual` is never overwritten. */
export type CueSource = "measured" | "analysis" | "audit" | "initial" | "manual";

export interface Cue {
  id: string;
  t: number;
  /**
   * How the time was obtained. Optional in the type and required by the `cues.provenance` gate: the engine
   * should not refuse to draw a film because a cue file is incomplete, and the validator is the right place
   * to insist. Optional-here / required-there is deliberate, not an oversight.
   */
  source?: CueSource;
  label?: string;
  note?: string;
}

export interface LyricWordTiming {
  start: number;
  end: number;
}

export interface LyricLineTiming {
  i: number;
  start: number;
  end: number;
  words?: LyricWordTiming[];
}

/** Everything a time expression may resolve against. All members are optional except `duration`. */
export interface TimebaseData {
  duration: number;
  fps: number;
  tempo?: Tempo;
  meter?: string;
  beats?: number[];
  beatsSmooth?: number[];
  bars?: Bar[];
  sections?: Section[];
  onsets?: Onset[];
  impacts?: Impact[];
  stops?: Stop[];
  cues?: Cue[];
  lyricLines?: LyricLineTiming[];
  /**
   * Where a `VOX('word')` lookup may search. Derived from lyric text when it is available;
   * absent means `VOX` throws, which is correct — there is no sung-word data to honour.
   */
  words?: Array<{ word: string; start: number; end: number; line?: number }>;
}

/** Default tolerances, in seconds. A candidate farther than this is not a match (SPEC T3). */
export const TOLERANCE: { word: number; impact: number; cue: number } = {
  /** A sung word onset. ASR word timings run early; without alignment data be generous but honest. */
  word: 0.08,
  /** A drum/percussion impact. */
  impact: 0.06,
  /** A cue settle. */
  cue: 0.12,
};
