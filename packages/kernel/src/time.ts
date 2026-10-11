/**
 * The timebase runtime and the strict resolver behind `@cvpw/kernel`'s time expressions.
 *
 * Normative grammar: `docs/CONTRACTS.md` §3. Rules: `docs/SPEC.md` T1–T8.
 *
 * The one behaviour that matters: **resolution throws.** A reference the timebase cannot
 * substantiate is an error, never a default. Every throw carries the nearest valid alternatives so
 * that the operator can fix the storyboard or the analysis — but never the expression.
 */

import {
  TOLERANCE,
  type Bar,
  type Cue,
  type Impact,
  type LyricLineTiming,
  type Onset,
  type Section,
  type Stop,
  type Tempo,
  type TimebaseData,
} from "./timebase.js";

/** A near-miss suggestion attached to a resolution failure. */
export interface Alternative {
  /** What the token would have matched, e.g. a cue id or an index. */
  id: string;
  /** Its resolved time. */
  t: number;
  /** Signed distance in seconds from the requested time, when a time was requested. */
  delta?: number;
}

/** Why a time expression could not be resolved. */
export type TimeExpressionReason =
  | "syntax"
  | "unknown-id"
  | "not-found"
  | "out-of-tolerance"
  | "no-data"
  | "out-of-order"
  | "negative";

/** Thrown when a time expression cannot be resolved. Carries everything needed to fix it. */
export class TimeExpressionError extends Error {
  readonly expression: string;
  readonly token: string;
  readonly reason: TimeExpressionReason;
  readonly detail: string;
  readonly alternatives: readonly Alternative[];

  constructor(
    expression: string,
    token: string,
    reason: TimeExpressionReason,
    detail: string,
    alternatives: readonly Alternative[] = [],
  ) {
    const hint = alternatives.length
      ? ` nearest: ${alternatives.map((a) => `${a.id}@${a.t.toFixed(3)}s`).join(", ")}`
      : "";
    super(`cannot resolve time ${JSON.stringify(expression)}: [${token}] ${detail}.${hint}`);
    this.name = "TimeExpressionError";
    this.expression = expression;
    this.token = token;
    this.reason = reason;
    this.detail = detail;
    this.alternatives = alternatives;
  }
}

/** The result of resolving an expression. Reported into `render/report.json::resolvedTimes`. */
export interface Resolution {
  /** The original expression verbatim. */
  expression: string;
  /** Resolved seconds. */
  t: number;
  /** Normalised form of the base token, e.g. `b(32,0)`, `cue(chorus)`, `s(12.5)`. */
  token: string;
  /** True when the base was an absolute second value, which `cvpw lint` warns about (SPEC T2). */
  absolute: boolean;
}

const IDENT_START = /[A-Za-z_]/;

/** A tiny recursive-descent parser over the grammar in `docs/CONTRACTS.md` §3. */
class ExprScanner {
  private pos = 0;
  constructor(private readonly src: string) {}

  get rest(): string {
    return this.src.slice(this.pos);
  }
  get done(): boolean {
    return this.pos >= this.src.length;
  }
  peek(): string | undefined {
    return this.src[this.pos];
  }
  skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos++;
  }
  accept(ch: string): boolean {
    this.skipSpace();
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }
  /** Read a number with at most 6 decimal places (SPEC T3.8). Throws on malformed input. */
  number(what: string): number {
    this.skipSpace();
    const m = /^-?(?:\d+(?:\.\d{0,6})?|\.\d{1,6})/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected ${what} number at position ${this.pos}`);
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw new Error(`${what} number is not finite: ${m[0]}`);
    return n;
  }
  integer(what: string): number {
    const n = this.number(what);
    if (!Number.isInteger(n)) throw new Error(`${what} must be an integer, got ${n}`);
    return n;
  }
  quoted(what: string): string {
    this.skipSpace();
    const q = this.src[this.pos];
    if (q !== "'" && q !== '"') throw new Error(`expected quoted ${what} at position ${this.pos}`);
    const end = this.src.indexOf(q, this.pos + 1);
    if (end < 0) throw new Error(`unterminated quote for ${what}`);
    const value = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }
  /**
   * Look at an identifier at the cursor without consuming it.
   *
   * Peeking rather than consuming keeps each base form self-contained: `baseCue` reads `cue`, the
   * parenthesis, the quoted id and the closing parenthesis itself, so the grammar for one form lives
   * in exactly one place. Consuming the keyword here would split each form across two functions,
   * which is precisely the kind of coupling that produces "expected quoted cue id at position 3".
   */
  peekIdent(): string | undefined {
    this.skipSpace();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    return m?.[0];
  }

  /** Consume a specific identifier, which the caller has already seen via {@link peekIdent}. */
  expectKeyword(word: string): void {
    const found = this.peekIdent();
    if (found !== word) throw new Error(`expected ${word}, found ${found ?? "nothing"}`);
    this.pos += word.length;
  }

  /** Read a bare identifier (a cue-id shorthand), allowing dots and dashes. */
  rawIdent(): string | undefined {
    this.skipSpace();
    const m = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(this.src.slice(this.pos));
    if (!m || !IDENT_START.test(m[0][0] as string)) return undefined;
    this.pos += m[0].length;
    return m[0];
  }

  /** A signed offset such as `+0.12`, `- 0.2s`. Returns undefined when absent. */
  offset(): number | undefined {
    this.skipSpace();
    const sign = this.src[this.pos];
    if (sign !== "+" && sign !== "-") return undefined;
    this.pos++;
    const magnitude = this.number("offset");
    this.unitSeconds();
    return sign === "-" ? -magnitude : magnitude;
  }
  /** An optional trailing ASCII `s`, consumed only when it is not the start of an identifier. */
  unitSeconds(): void {
    if (this.src[this.pos] === "s" && !IDENT_START.test(this.src[this.pos + 1] ?? "")) this.pos++;
  }
}

interface Base {
  t: number;
  token: string;
  absolute: boolean;
}

/** Ceiling for "nearest" candidate lists, so an error message stays readable. */
const MAX_ALTERNATIVES = 3;
/** A beat position is only interpolated when it lies inside a bar with a sane beat count. */
const MAX_BEATS_PER_BAR = 16;

export class Timebase {
  readonly duration: number;
  readonly fps: number;
  readonly tempo: Tempo | undefined;
  readonly meter: string;

  private readonly beats: readonly number[];
  private readonly beatsSmooth: readonly number[];
  private readonly bars: readonly Bar[];
  private readonly barsByIndex: ReadonlyMap<number, Bar>;
  private readonly sections: readonly Section[];
  private readonly onsets: readonly Onset[];
  private readonly impacts: readonly Impact[];
  private readonly stops: readonly Stop[];
  private readonly cues: readonly Cue[];
  private readonly cueById: ReadonlyMap<string, Cue>;
  private readonly lyricLines: readonly LyricLineTiming[];
  private readonly words: readonly { word: string; start: number; end: number; line?: number }[];

  private readonly resolutionCache = new Map<string, Resolution>();

  constructor(data: TimebaseData) {
    if (!(data.duration > 0) || !Number.isFinite(data.duration)) {
      throw new TimeExpressionError("<timebase>", "duration", "syntax", "duration must be a positive finite number");
    }
    if (!(data.fps > 0) || !Number.isFinite(data.fps)) {
      throw new TimeExpressionError("<timebase>", "fps", "syntax", "fps must be a positive finite number");
    }
    this.duration = data.duration;
    this.fps = data.fps;
    this.tempo = data.tempo;
    this.meter = data.meter ?? "4/4";
    this.beats = data.beats ?? [];
    this.beatsSmooth = data.beatsSmooth ?? data.beats ?? [];
    this.bars = data.bars ?? [];
    this.barsByIndex = new Map(this.bars.map((b) => [b.index, b]));
    this.sections = data.sections ?? [];
    this.onsets = data.onsets ?? [];
    this.impacts = data.impacts ?? [];
    this.stops = data.stops ?? [];
    this.cues = data.cues ?? [];
    this.cueById = new Map(this.cues.map((c) => [c.id, c]));
    this.lyricLines = data.lyricLines ?? [];
    this.words = data.words ?? [];
  }

  /** Frame index for a time. The single definition, so `frameIndex` never drifts from the timebase. */
  frameIndex(t: number): number {
    return Math.round(t * this.fps);
  }

  /** Time of a frame index. */
  frameTime(frame: number): number {
    return frame / this.fps;
  }

  /** Total frames. `round`, matching `render.frameCount` in the gate table. */
  get frames(): number {
    return Math.round(this.duration * this.fps);
  }

  hasGrid(): boolean {
    return this.beats.length > 0 || this.bars.length > 0;
  }

  /**
   * Resolve a time expression to seconds.
   *
   * @throws {TimeExpressionError} always, when the expression cannot be substantiated (SPEC T3).
   */
  resolve(expression: string): Resolution {
    const cached = this.resolutionCache.get(expression);
    if (cached) return cached;

    const src = expression.trim();
    if (src === "") {
      throw new TimeExpressionError(expression, "", "syntax", "empty time expression");
    }

    // One pass: the base form, then an optional trailing offset, then end of input. Doing it in a
    // single scan is what lets a syntax error name the exact token that broke the expression.
    const scanner = new ExprScanner(src);
    let base: Base;
    try {
      base = this.parseBaseWith(scanner, src);
    } catch (err) {
      if (err instanceof TimeExpressionError) throw err;
      throw new TimeExpressionError(
        expression,
        src,
        "syntax",
        err instanceof Error ? err.message : String(err),
      );
    }
    const offset = scanner.offset();
    scanner.skipSpace();
    if (!scanner.done) {
      throw new TimeExpressionError(
        expression,
        scanner.rest,
        "syntax",
        "unexpected trailing input after the time expression",
      );
    }

    let t = base.t;
    if (offset !== undefined) t += offset;

    if (t < 0) {
      throw new TimeExpressionError(
        expression,
        base.token,
        "negative",
        `resolves to ${t.toFixed(3)}s, before the start of the timeline`,
      );
    }

    const resolution: Resolution = {
      expression,
      t,
      token: base.token,
      absolute: base.absolute,
    };
    this.resolutionCache.set(expression, resolution);
    return resolution;
  }

  private parseBase(src: string): Base {
    return this.parseBaseWith(new ExprScanner(src), src);
  }

  /**
   * Parse the base form of an expression using the caller's scanner, so a trailing offset can follow.
   *
   * Dispatch is by a *peeked* identifier, and every dispatched form consumes its own keyword — see
   * {@link ExprScanner.peekIdent} for why.
   */
  private parseBaseWith(s: ExprScanner, src: string): Base {
    s.skipSpace();
    const ident = s.peekIdent();

    // --- keyword forms -------------------------------------------------------------------------
    if (ident !== undefined) {
      switch (ident) {
        case "cue":
          return this.baseCue(s, src);
        case "b":
          return this.baseBar(s, src);
        case "h":
          return this.baseHalf(s, src);
        case "L":
          return this.baseLyricLine(s, src);
        case "VOX":
          return this.baseWord(s, src);
        case "HIT":
          return this.baseImpact(s, src);
        case "S":
          return this.baseSection(s, src);
        case "STOP":
          return this.baseStop(s, src);
        case "p":
          return this.baseQuantile(s, src);
        default:
          break; // fall through to the bare-identifier shorthand below
      }
    }

    // --- absolute seconds ----------------------------------------------------------------------
    const first = s.peek();
    if (first !== undefined && /[-\d.]/.test(first)) {
      const n = s.number("seconds");
      s.unitSeconds();
      if (n < 0) {
        throw new TimeExpressionError(src, `${n}`, "negative", "an absolute time cannot be negative");
      }
      return { t: n, token: `s(${n})`, absolute: true };
    }

    // --- bare identifier shorthand → cue id ------------------------------------------------------
    if (ident !== undefined) {
      s.rawIdent();
      const cue = this.cueById.get(ident);
      if (!cue) {
        throw new TimeExpressionError(
          src,
          ident,
          "unknown-id",
          `no cue named ${JSON.stringify(ident)} and no time form starts with ${JSON.stringify(ident)}`,
          this.nearestCues(ident),
        );
      }
      return { t: cue.t, token: `cue(${ident})`, absolute: false };
    }

    throw new TimeExpressionError(
      src,
      src,
      "syntax",
      "not a time expression; expected seconds, b(), h(), cue(), L(), VOX(), HIT(), S(), STOP() or p()",
    );
  }

  // --- base forms ------------------------------------------------------------------------------

  private baseCue(s: ExprScanner, src: string): Base {
    s.expectKeyword("cue");
    if (!s.accept("(")) throw new TimeExpressionError(src, "cue", "syntax", "expected ( after cue");
    const id = s.quoted("cue id");
    if (!s.accept(")")) throw new TimeExpressionError(src, "cue", "syntax", "expected ) to close cue(…)");
    const cue = this.cueById.get(id);
    if (!cue) {
      throw new TimeExpressionError(src, `cue('${id}')`, "unknown-id", `no cue named ${JSON.stringify(id)}`, this.nearestCues(id));
    }
    return { t: cue.t, token: `cue(${id})`, absolute: false };
  }

  private baseBar(s: ExprScanner, src: string): Base {
    if (!this.hasGrid()) {
      throw new TimeExpressionError(
        src,
        "b(…)",
        "no-data",
        "the timebase has no beat grid; use a cue or absolute seconds, or analyse the audio",
      );
    }
    s.expectKeyword("b");
    if (!s.accept("(")) throw new TimeExpressionError(src, "b", "syntax", "expected ( after b");
    const index = s.integer("bar index");
    if (!s.accept(",")) throw new TimeExpressionError(src, "b", "syntax", "expected , after the bar index");
    const beat = s.number("beat within bar");
    if (!s.accept(")")) throw new TimeExpressionError(src, "b", "syntax", "expected ) to close b(…)");
    if (beat < 0) throw new TimeExpressionError(src, `b(${index},${beat})`, "negative", "a beat within a bar cannot be negative");
    const bar = this.barsByIndex.get(index);
    if (!bar) {
      throw new TimeExpressionError(
        src,
        `b(${index},…)`,
        "unknown-id",
        `no bar with index ${index}`,
        this.nearestBars(index),
      );
    }
    return { t: this.timeInBar(bar, beat, src, index), token: `b(${index},${beat})`, absolute: false };
  }

  private timeInBar(bar: Bar, beat: number, src: string, index: number): number {
    const perBar = bar.beats ?? this.inferBeatsPerBar(bar);
    if (beat <= perBar) {
      const period = (bar.end - bar.start) / perBar;
      return bar.start + beat * period;
    }
    // Past the end of the bar: continue into the following bar only when the grid is contiguous,
    // so that a fractional overflow does not silently invent an unmeasured time.
    const next = this.barsByIndex.get(index + 1);
    if (next && Math.abs(next.start - bar.end) < 1e-6) {
      const period = (next.end - next.start) / (next.beats ?? perBar);
      const overflow = beat - perBar;
      if (overflow <= 1) return bar.end + overflow * period;
    }
    throw new TimeExpressionError(
      src,
      `b(${index},${beat})`,
      "out-of-tolerance",
      `bar ${index} has ${perBar} beats, so beat ${beat} lies beyond the measured grid`,
    );
  }

  private inferBeatsPerBar(bar: Bar): number {
    const byTempo = this.tempo?.beatPeriod
      ? Math.round((bar.end - bar.start) / this.tempo.beatPeriod)
      : NaN;
    const byMeter = Number.parseInt(this.meter.split("/")[1] ?? "4", 10);
    const candidate = Number.isFinite(byTempo) && byTempo > 0 && byTempo <= MAX_BEATS_PER_BAR ? byTempo : byMeter;
    return Number.isFinite(candidate) && candidate > 0 ? candidate : 4;
  }

  private baseHalf(s: ExprScanner, src: string): Base {
    const beats = this.beatsSmooth.length ? this.beatsSmooth : this.beats;
    if (beats.length < 2) {
      throw new TimeExpressionError(
        src,
        "h(…)",
        "no-data",
        "the timebase has no beat grid, so half-beats cannot be addressed",
      );
    }
    s.expectKeyword("h");
    if (!s.accept("(")) throw new TimeExpressionError(src, "h", "syntax", "expected ( after h");
    const index = s.number("half-beat index");
    if (!s.accept(")")) throw new TimeExpressionError(src, "h", "syntax", "expected ) to close h(…)");
    if (index < 0) throw new TimeExpressionError(src, `h(${index})`, "negative", "a half-beat index cannot be negative");
    // `h(n)` addresses a half-beat *grid*: even n is a whole beat, odd n is the midpoint to the next.
    // Fractional n interpolates further, which is how an off-beat eighth is expressed without a
    // second grid. `beats.length - 2` is the last index that has a following beat to interpolate to.
    const whole = Math.floor(index / 2);
    const frac = (index - whole * 2) / 2;
    if (whole > beats.length - 2) {
      // Allow addressing the half-beat immediately past the last whole beat, from the final period.
      if (whole === beats.length - 2 && frac <= 0.5) {
        const last = beats[beats.length - 1] as number;
        const prev = beats[beats.length - 2] as number;
        return { t: last + frac * (last - prev), token: `h(${index})`, absolute: false };
      }
      throw new TimeExpressionError(
        src,
        `h(${index})`,
        "out-of-tolerance",
        `the measured grid has ${beats.length} beats (half-beats 0..${2 * beats.length - 2}); half-beat ${index} lies past the end`,
      );
    }
    const a = beats[whole] as number;
    const b = beats[whole + 1] as number;
    return { t: a + frac * (b - a), token: `h(${index})`, absolute: false };
  }

  private baseLyricLine(s: ExprScanner, src: string): Base {
    if (!this.lyricLines.length) {
      throw new TimeExpressionError(
        src,
        "L(…)",
        "no-data",
        "no lyric timing is loaded; run `cvpw lyrics`, or use a cue",
      );
    }
    s.expectKeyword("L");
    if (!s.accept("(")) throw new TimeExpressionError(src, "L", "syntax", "expected ( after L");
    const index = s.integer("lyric line index");
    if (!s.accept(")")) throw new TimeExpressionError(src, "L", "syntax", "expected ) to close L(…)");
    const line = this.lyricLines.find((l) => l.i === index);
    if (!line) {
      const nearest = [...this.lyricLines]
        .sort((a, b) => Math.abs(a.i - index) - Math.abs(b.i - index))
        .slice(0, MAX_ALTERNATIVES)
        .map((l) => ({ id: `L(${l.i})`, t: l.start }));
      throw new TimeExpressionError(src, `L(${index})`, "unknown-id", `no lyric line ${index}`, nearest);
    }
    return { t: line.start, token: `L(${index})`, absolute: false };
  }

  private baseWord(s: ExprScanner, src: string): Base {
    if (!this.words.length) {
      throw new TimeExpressionError(
        src,
        "VOX(…)",
        "no-data",
        "no sung-word timing is loaded; VOX needs alignment data, not transcription",
      );
    }
    s.expectKeyword("VOX");
    if (!s.accept("(")) throw new TimeExpressionError(src, "VOX", "syntax", "expected ( after VOX");
    const word = s.quoted("word");
    let tolerance = TOLERANCE.word;
    if (s.accept(",")) tolerance = s.number("tolerance in seconds");
    if (!s.accept(")")) throw new TimeExpressionError(src, "VOX", "syntax", "expected ) to close VOX(…)");

    const needle = normaliseWord(word);
    const hits = this.words.filter((w) => normaliseWord(w.word) === needle);
    if (!hits.length) {
      throw new TimeExpressionError(
        src,
        `VOX('${word}')`,
        "unknown-id",
        `no sung word matches ${JSON.stringify(word)}`,
        this.nearestWords(needle),
      );
    }
    if (hits.length === 1) {
      const only = hits[0] as { start: number };
      return { t: only.start, token: `VOX(${word})`, absolute: false };
    }
    // Repeated word: ambiguous by design. Report every occurrence so the author picks a line.
    const alternatives = hits.slice(0, MAX_ALTERNATIVES).map((w) => ({
      id: w.line === undefined ? "VOX" : `L(${w.line})`,
      t: w.start,
    }));
    throw new TimeExpressionError(
      src,
      `VOX('${word}')`,
      "out-of-tolerance",
      `the word occurs ${hits.length} times; address the line with L(n) and add an offset`,
      alternatives,
    );
  }

  private baseImpact(s: ExprScanner, src: string): Base {
    s.expectKeyword("HIT");
    if (!s.accept("(")) throw new TimeExpressionError(src, "HIT", "syntax", "expected ( after HIT");
    const name = s.quoted("impact name");
    let target: number | undefined;
    if (s.accept(",")) target = s.number("reference time");
    let tolerance = TOLERANCE.impact;
    if (s.accept(",")) tolerance = s.number("tolerance in seconds");
    if (!s.accept(")")) throw new TimeExpressionError(src, "HIT", "syntax", "expected ) to close HIT(…)");

    if (!this.impacts.length && !this.onsets.length) {
      throw new TimeExpressionError(src, "HIT(…)", "no-data", "the timebase has no impacts or onsets");
    }
    const query = normaliseWord(name);
    const pool: Array<{ t: number; kind: string; strength: number }> = [
      ...this.impacts.map((i) => ({ t: i.t, kind: i.kind, strength: i.strength })),
      ...this.onsets.map((o) => ({ t: o.t, kind: o.band ?? "onset", strength: o.strength })),
    ];
    const matching = pool.filter((p) => {
      const k = normaliseWord(p.kind);
      return k === query || k.startsWith(query);
    });
    if (!matching.length) {
      const kinds = [...new Set(pool.map((p) => p.kind))].slice(0, MAX_ALTERNATIVES);
      throw new TimeExpressionError(
        src,
        `HIT('${name}')`,
        "unknown-id",
        `no impact or onset of kind ${JSON.stringify(name)}`,
        kinds.map((k) => ({ id: k, t: pool.find((p) => p.kind === k)?.t ?? 0 })),
      );
    }
    if (target === undefined) {
      const strongest = matching.reduce((a, b) => (b.strength > a.strength ? b : a));
      return { t: strongest.t, token: `HIT(${name})`, absolute: false };
    }
    const nearest = matching
      .map((m) => ({ m, d: Math.abs(m.t - target) }))
      .sort((a, b) => a.d - b.d)[0] as { m: { t: number; kind: string }; d: number };
    if (nearest.d > tolerance) {
      throw new TimeExpressionError(
        src,
        `HIT('${name}',${target})`,
        "out-of-tolerance",
        `the nearest ${name} is ${nearest.d.toFixed(3)}s away, beyond the ${tolerance}s tolerance`,
        matching.slice(0, MAX_ALTERNATIVES).map((m) => ({ id: m.kind, t: m.t, delta: m.t - target })),
      );
    }
    return { t: nearest.m.t, token: `HIT(${name},${target})`, absolute: false };
  }

  private baseSection(s: ExprScanner, src: string): Base {
    if (!this.sections.length) {
      throw new TimeExpressionError(src, "S(…)", "no-data", "the timebase has no sections");
    }
    s.expectKeyword("S");
    if (!s.accept("(")) throw new TimeExpressionError(src, "S", "syntax", "expected ( after S");
    let found: Section | undefined;
    let token = "S(?)";
    const ch = s.peek();
    if (ch === "'" || ch === '"') {
      const name = s.quoted("section name");
      token = `S('${name}')`;
      const needle = normaliseWord(name);
      const matches = this.sections.filter((x) => normaliseWord(x.name) === needle);
      if (!matches.length) {
        throw new TimeExpressionError(
          src,
          token,
          "unknown-id",
          `no section named ${JSON.stringify(name)}`,
          this.sections.slice(0, MAX_ALTERNATIVES).map((x) => ({ id: x.name, t: x.start })),
        );
      }
      if (matches.length > 1) {
        throw new TimeExpressionError(
          src,
          token,
          "out-of-tolerance",
          `the name occurs ${matches.length} times; address the section by index instead`,
          matches.slice(0, MAX_ALTERNATIVES).map((x) => ({ id: `S(${x.index})`, t: x.start })),
        );
      }
      found = matches[0];
    } else {
      const index = s.integer("section index");
      token = `S(${index})`;
      const byIndex = this.sections.find((x) => x.index === index);
      if (!byIndex) {
        throw new TimeExpressionError(
          src,
          token,
          "unknown-id",
          `no section with index ${index}`,
          [...this.sections]
            .sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index))
            .slice(0, MAX_ALTERNATIVES)
            .map((x) => ({ id: `S(${x.index})`, t: x.start })),
        );
      }
      found = byIndex;
    }
    if (!s.accept(")")) throw new TimeExpressionError(src, "S", "syntax", "expected ) to close S(…)");
    const section: Section = found as Section;
    return { t: section.start, token, absolute: false };
  }

  private baseStop(s: ExprScanner, src: string): Base {
    if (!this.stops.length) {
      throw new TimeExpressionError(src, "STOP(…)", "no-data", "the timebase has no detected silence gaps");
    }
    s.expectKeyword("STOP");
    if (!s.accept("(")) throw new TimeExpressionError(src, "STOP", "syntax", "expected ( after STOP");
    const index = s.integer("stop index");
    if (!s.accept(")")) throw new TimeExpressionError(src, "STOP", "syntax", "expected ) to close STOP(…)");
    if (index < 0 || index >= this.stops.length) {
      throw new TimeExpressionError(
        src,
        `STOP(${index})`,
        "unknown-id",
        `there are ${this.stops.length} stops, numbered 0..${this.stops.length - 1}`,
        this.stops.slice(0, MAX_ALTERNATIVES).map((x, i) => ({ id: `STOP(${i})`, t: x.start })),
      );
    }
    return { t: (this.stops[index] as Stop).start, token: `STOP(${index})`, absolute: false };
  }

  private baseQuantile(s: ExprScanner, src: string): Base {
    s.expectKeyword("p");
    if (!s.accept("(")) throw new TimeExpressionError(src, "p", "syntax", "expected ( after p");
    const fraction = s.number("fraction of duration");
    if (!s.accept(")")) throw new TimeExpressionError(src, "p", "syntax", "expected ) to close p(…)");
    if (fraction < 0 || fraction > 1) {
      throw new TimeExpressionError(src, `p(${fraction})`, "out-of-tolerance", "the fraction must be within 0..1");
    }
    return { t: fraction * this.duration, token: `p(${fraction})`, absolute: false };
  }

  // --- nearest-candidate helpers, used only to build error messages ----------------------------

  private nearestCues(id: string): Alternative[] {
    const needle = normaliseWord(id);
    return [...this.cues]
      .map((c) => ({ c, score: similarity(needle, normaliseWord(c.id)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ALTERNATIVES)
      .map((x) => ({ id: x.c.id, t: x.c.t }));
  }

  private nearestBars(index: number): Alternative[] {
    return [...this.bars]
      .sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index))
      .slice(0, MAX_ALTERNATIVES)
      .map((b) => ({ id: `b(${b.index},0)`, t: b.start }));
  }

  private nearestWords(needle: string): Alternative[] {
    const seen = new Set<string>();
    const out: Alternative[] = [];
    for (const w of [...this.words].sort((a, b) => similarity(needle, normaliseWord(b.word)) - similarity(needle, normaliseWord(a.word)))) {
      const key = normaliseWord(w.word);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: w.word, t: w.start });
      if (out.length >= MAX_ALTERNATIVES) break;
    }
    return out;
  }

  /** Every cue, for tooling that needs to enumerate them (e.g. `cvpw sheet --cues`). */
  listCues(): readonly Cue[] {
    return this.cues;
  }

  /** Beat index nearest to a time, or -1. */
  nearestBeatIndex(t: number): number {
    return nearestIndex(this.beats, t);
  }
}

function nearestIndex(sorted: readonly number[], t: number): number {
  if (!sorted.length) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  const a = sorted[lo] as number;
  const b = lo > 0 ? (sorted[lo - 1] as number) : a;
  return Math.abs(a - t) <= Math.abs(b - t) ? lo : lo - 1;
}

/** Case- and punctuation-insensitive comparison form, matching the lyric-timing hash convention. */
export function normaliseWord(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Cheap bigram-ish similarity, used only to order suggestions. Not a general-purpose metric. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  let hits = 0;
  for (let i = 0; i < shorter.length - 1; i++) {
    if (longer.includes(shorter.slice(i, i + 2))) hits++;
  }
  return hits / Math.max(1, shorter.length - 1);
}
