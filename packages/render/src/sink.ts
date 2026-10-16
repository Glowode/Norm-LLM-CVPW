/**
 * The frame sink: a serialising, ordering-preserving writer.
 *
 * **The ordering invariant, and why it is load-bearing rather than tidy.**
 *
 * Frames may be rendered concurrently by any number of workers, taking whatever frame each is ready
 * with, in whatever order. They MUST reach the encoder strictly in ascending frame index. When that
 * holds, a render with eight workers is byte-identical to a render with one, which is what makes three
 * otherwise-impossible things possible:
 *
 *   1. `qa/gold.json` can hold frame hashes at all. If worker count changed the pixels, the gold file
 *      would only describe the run that produced it.
 *   2. A re-render of one shot can be compared against the previous master.
 *   3. `--workers` becomes a pure throughput knob, so it is safe to raise on a faster machine.
 *
 * `docs/adr/0007` measured the neighbouring question — whether the pixels themselves are stable — and
 * found the film deterministic from frame 2 onward. This module is the other half: making sure the
 * *arrival order* cannot leak into the output even though the pixels are stable.
 *
 * The sink is deliberately strict. A frame arriving twice, an index outside the reserved range, or a
 * close with a hole in the sequence is a failure rather than something to paper over, because every one
 * of those conditions would otherwise produce a plausible-looking film with one wrong frame in it.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One captured frame on its way to the encoder. */
export interface CapturedFrame {
  /** Ascending output frame index. The ordering contract is expressed in terms of this. */
  index: number;
  /** Encoded bytes (JPEG/PNG) or raw RGB. `encoding` says which. */
  data: Uint8Array;
  encoding: "jpeg" | "png" | "rgb24";
  width: number;
  height: number;
  /** How long the page took to draw and read back this frame. Diagnostics only. */
  ms: number;
}

export interface FrameSinkOptions {
  /** Directory to write frames into. MUST be ASCII-only (docs/SPEC.md P4). */
  dir: string;
  /** Inclusive first index. */
  from: number;
  /** Exclusive last index. */
  to: number;
  /**
   * How far ahead of `next` a frame may be held before the sink refuses more work.
   *
   * This is the bound that makes the invariant implementable: without it, one fast worker could race
   * arbitrarily far ahead of a slow one and the buffer would grow without limit. It surfaces as
   * back-pressure on {@link FrameSink.reserve} rather than as memory exhaustion, because a render that
   * dies of memory at frame 4000 has wasted everything before it.
   */
  lookahead: number;
  /** File extension for written frames, matching `encoding`. */
  extension?: "jpg" | "png" | "rgb";
  /** Called as frames are committed, in order. For progress reporting only. */
  onCommit?: (index: number, remaining: number) => void;
}

export interface SinkStats {
  /** Frames committed, in order. */
  written: number;
  /** Frames currently held waiting for an earlier index. */
  buffered: number;
  /** The highest index handed over so far. */
  highestSeen: number;
  /** Times a producer was made to wait by the lookahead bound. */
  backPressureEvents: number;
  /** Total milliseconds producers spent waiting on back-pressure. */
  backPressureMs: number;
}

export interface FrameSink {
  readonly name: "filesystem";
  readonly dir: string;
  /** Reserve and hand over a frame. Resolves once the sink has accepted it. */
  write(frame: CapturedFrame): Promise<void>;
  /** Wait until `count` frames have been committed. Used to throttle ahead-runners. */
  waitFor(count: number): Promise<void>;
  /** The path of a written frame, for the encoder. Throws if it was never written. */
  pathFor(index: number): string;
  stats(): SinkStats;
  /**
   * Finish: assert the range is complete and return the frame directory.
   *
   * Rejects when any index in `[from, to)` was never written. That is the check that turns "the render
   * finished" into "the render produced every frame", and it is the difference between a one-frame gap
   * and a silent hole in the film.
   */
  close(): Promise<{ dir: string; frames: number }>;
  /** Delete everything written. A failed render must not leave a plausible-looking artefact. */
  abort(): Promise<void>;
}

export class FrameSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkError";
  }
}

/** The file extension implied by a frame encoding, for callers that do not set one explicitly. */
export const EXTENSIONS: Record<CapturedFrame["encoding"], "jpg" | "png" | "rgb"> = {
  jpeg: "jpg",
  png: "png",
  rgb24: "rgb",
};

/** A zero-padded frame filename. Zero padding is what keeps `%06d` in ffmpeg globbing in order. */
export function frameName(index: number, extension: string): string {
  return `f${String(index).padStart(6, "0")}.${extension}`;
}

class FilesystemSink implements FrameSink {
  readonly name = "filesystem" as const;
  readonly dir: string;

  private readonly from: number;
  private readonly to: number;
  private readonly lookahead: number;
  /** Undefined until the first frame fixes it, or set explicitly by the caller. */
  private extension: string | undefined;
  private readonly onCommit: ((index: number, remaining: number) => void) | undefined;

  /** Frames received but not yet committed, keyed by index. */
  private readonly held = new Map<number, CapturedFrame>();
  /** Producible slots, keyed by index, so a caller can reserve ahead of producing. */
  private readonly reserved = new Set<number>();
  private readonly committed = new Set<number>();
  private next: number;
  private highestSeen: number;
  private waiters: Array<{ target: number; nextAtLeast: number; resolve: () => void }> = [];
  private readonly counters: SinkStats = {
    written: 0,
    buffered: 0,
    highestSeen: -1,
    backPressureEvents: 0,
    backPressureMs: 0,
  };
  private closed = false;
  private aborted = false;
  private readonly expected: number;

  constructor(options: FrameSinkOptions) {
    if (options.to <= options.from) {
      throw new FrameSinkError(`the frame range [${options.from}, ${options.to}) is empty`);
    }
    if (options.lookahead < 1) {
      throw new FrameSinkError(`lookahead must be at least 1, got ${options.lookahead}`);
    }
    this.dir = options.dir;
    this.from = options.from;
    this.to = options.to;
    this.lookahead = options.lookahead;
    this.extension = options.extension;
    this.onCommit = options.onCommit;
    this.next = options.from;
    this.highestSeen = options.from - 1;
    this.counters.highestSeen = this.highestSeen;
    this.expected = options.to - options.from;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** The extension in use. Only valid once at least one frame has been accepted. */
  private get ext(): string {
    if (!this.extension) {
      throw new FrameSinkError("no extension is known yet: no frame has been accepted");
    }
    return this.extension;
  }

  pathFor(index: number): string {
    if (!this.committed.has(index)) {
      throw new FrameSinkError(`frame ${index} has not been written, so it has no path`);
    }
    return join(this.dir, frameName(index, this.ext));
  }

  stats(): SinkStats {
    return { ...this.counters, buffered: this.held.size, highestSeen: this.highestSeen };
  }

  async write(frame: CapturedFrame): Promise<void> {
    if (this.closed) throw new FrameSinkError("the sink is closed");
    if (this.aborted) throw new FrameSinkError("the sink was aborted");
    if (frame.index < this.from || frame.index >= this.to) {
      throw new FrameSinkError(
        `frame ${frame.index} is outside the reserved range [${this.from}, ${this.to})`,
      );
    }
    if (this.held.has(frame.index) || this.committed.has(frame.index)) {
      // A duplicate is not harmless: it means two workers were given the same frame, so some other
      // frame was never rendered. Failing here is far cheaper than discovering the gap at encode time.
      throw new FrameSinkError(`frame ${frame.index} was handed over twice`);
    }

    await this.ensureDir();
    this.held.set(frame.index, frame);
    // The extension comes from the first frame's encoding when the caller did not name one. Deciding it
    // here rather than defaulting to `"jpg"` at construction is what makes `pathFor()` truthful for any
    // capture format: a hard-coded default reported paths that did not exist.
    if (!this.extension && frame.index === this.from) this.extension = EXTENSIONS[frame.encoding];
    this.counters.highestSeen = Math.max(this.counters.highestSeen, frame.index);
    await this.drain();

    // Back-pressure, expressed as a condition on THIS frame rather than on the buffer's size.
    //
    // Two earlier versions were wrong in ways worth recording, because both look reasonable and both
    // deadlock:
    //
    //   1. Wait while `held.size >= lookahead` and release on "the next commit". The commit is a
    //      different event from the one that makes room: if the frame at `next` is never produced, no
    //      commit ever happens and the producer blocks forever while holding a frame it already rendered.
    //   2. Wait while `held.size >= lookahead` and release on `next` advancing. Worse, not better: every
    //      blocked writer wakes on the same advance, and a woken writer re-checks `held.size`, which has
    //      not shrunk — so `write(3)` into a sink with `lookahead: 3` never returned at all.
    //
    // The condition that is actually correct is about the frame in hand: accept it when it is within
    // `lookahead` of `next`, and otherwise wait until `next` has advanced enough to bring it in range. It
    // cannot deadlock, because the wait always ends as soon as `next` reaches a value this producer can
    // compute up front.
    const acceptWhenNextReaches = frame.index - this.lookahead + 1;
    while (!this.closed && !this.aborted && this.next < acceptWhenNextReaches) {
      const started = Date.now();
      this.counters.backPressureEvents++;
      await this.waitUntilNextReaches(acceptWhenNextReaches);
      this.counters.backPressureMs += Date.now() - started;
    }
  }

  /** Commit every frame that is now contiguous from `next`, writing them in ascending order. */
  private async drain(): Promise<void> {
    while (this.held.has(this.next)) {
      const frame = this.held.get(this.next) as CapturedFrame;
      this.held.delete(this.next);
      await writeFile(join(this.dir, frameName(frame.index, this.ext)), frame.data);
      this.committed.add(frame.index);
      this.counters.written++;
      const index = this.next;
      this.next++;
      this.onCommit?.(index, this.to - this.next);
      this.releaseWaiters();
    }
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    if (!this.waiters.length) return;
    const still: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (this.counters.written >= waiter.target || this.next > waiter.nextAtLeast) waiter.resolve();
      else still.push(waiter);
    }
    this.waiters = still;
  }

  /**
   * Wait until `next` reaches `target`.
   *
   * The caller computes `target` before waiting, so the condition cannot become unreachable and the wait
   * cannot deadlock — which two earlier formulations of this both did.
   */
  private waitUntilNextReaches(target: number): Promise<void> {
    if (this.next >= target) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ target: -1, nextAtLeast: target, resolve });
    });
  }

  async waitFor(count: number): Promise<void> {
    if (this.counters.written >= count) return;
    await new Promise<void>((resolve) => {
      this.waiters.push({ target: count, nextAtLeast: -1, resolve });
    });
  }

  async close(): Promise<{ dir: string; frames: number }> {
    if (this.aborted) throw new FrameSinkError("the sink was aborted");
    this.closed = true;

    if (this.held.size > 0) {
      const missing = [...this.held.keys()].sort((a, b) => a - b);
      const holes = missing.filter((i) => !this.committed.has(i - 1) && i !== this.from);
      throw new FrameSinkError(
        `the render ended with ${this.held.size} frame(s) held and never written: ` +
          `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}. ` +
          `This means an earlier index was never produced, so the sequence has a hole` +
          (holes.length ? ` before ${holes.slice(0, 4).join(", ")}` : "") +
          `. A render is not finished until every index in the range is present.`,
      );
    }
    if (this.counters.written !== this.expected) {
      throw new FrameSinkError(
        `the render wrote ${this.counters.written} frames but ${this.expected} were reserved ` +
          `(indices ${this.from}..${this.to - 1}); the sequence has a hole`,
      );
    }
    return { dir: this.dir, frames: this.counters.written };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.closed = true;
    this.held.clear();
    this.committed.clear();
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters = [];
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createSink(options: FrameSinkOptions): FrameSink {
  return new FilesystemSink(options);
}

/**
 * Split `[from, to)` into `workers` contiguous chunks.
 *
 * Contiguous rather than interleaved, and that is a measured decision, not a stylistic one. `docs/adr/0007`
 * tested both: chunk boundaries are stable, because a worker starting mid-film reproduces what a
 * sequential render produced. Interleaving would give every worker a cold start at every frame, which is
 * precisely the pattern the spikes could not make deterministic.
 *
 * The last chunk absorbs the remainder, so the union is exactly `[from, to)` with no gap and no overlap.
 */
export function planChunks(
  from: number,
  to: number,
  workers: number,
): Array<{ worker: number; from: number; to: number; frames: number }> {
  const total = to - from;
  if (total <= 0) return [];
  const count = Math.max(1, Math.min(Math.floor(workers), total));
  const per = Math.ceil(total / count);
  const chunks: Array<{ worker: number; from: number; to: number; frames: number }> = [];
  for (let w = 0; w < count; w++) {
    const start = from + w * per;
    const end = Math.min(to, start + per);
    if (start >= end) continue;
    chunks.push({ worker: w, from: start, to: end, frames: end - start });
  }
  return chunks;
}
