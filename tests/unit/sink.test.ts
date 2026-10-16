import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSink, frameName, planChunks, FrameSinkError, type CapturedFrame } from "../../packages/render/src/sink.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cvpw-sink-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A frame whose bytes encode its own index, so a mis-ordered write is detectable in the output. */
function frame(index: number, tag = ""): CapturedFrame {
  return {
    index,
    data: Buffer.from(`${tag}frame-${index}`, "utf8"),
    encoding: "rgb24",
    width: 2,
    height: 2,
    ms: 1,
  };
}

/**
 * The ordering invariant is the whole reason this class exists, so it is tested by handing frames over in
 * every awkward order a pool of workers could produce them, and asserting the bytes on disk are ascending.
 */
describe("FrameSink — the ordering invariant", () => {
  it("writes frames in ascending order regardless of arrival order", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 4, lookahead: 8 });
    // Reverse arrival: the worst case a set of workers can produce.
    for (const index of [3, 2, 1, 0]) await sink.write(frame(index));
    const closed = await sink.close();
    expect(closed.frames).toBe(4);

    const files = (await readdir(dir)).sort();
    expect(files).toEqual([0, 1, 2, 3].map((i) => frameName(i, "rgb")));
    for (const i of [0, 1, 2, 3]) {
      expect(await readFile(join(dir, frameName(i, "rgb")), "utf8")).toBe(`frame-${i}`);
    }
  });

  it("produces identical bytes for a sequential arrival and a shuffled one", async () => {
    const a = await makeDir();
    const b = await makeDir();

    const sequential = createSink({ dir: a, from: 0, to: 6, lookahead: 16 });
    for (let i = 0; i < 6; i++) await sequential.write(frame(i));
    await sequential.close();

    const shuffled = createSink({ dir: b, from: 0, to: 6, lookahead: 16 });
    for (const i of [4, 0, 5, 2, 1, 3]) await shuffled.write(frame(i));
    await shuffled.close();

    const read = async (dir: string): Promise<string[]> =>
      Promise.all([0, 1, 2, 3, 4, 5].map((i) => readFile(join(dir, frameName(i, "rgb")), "utf8")));
    expect(await read(b)).toEqual(await read(a));
  });

  it("commits immediately when frames arrive in order", async () => {
    const dir = await makeDir();
    const committed: number[] = [];
    const sink = createSink({ dir, from: 0, to: 3, lookahead: 8, onCommit: (i) => committed.push(i) });
    for (const i of [0, 1, 2]) await sink.write(frame(i));
    await sink.close();
    expect(committed).toEqual([0, 1, 2]);
  });

  it("holds later frames until the gap is filled, then commits them in one run", async () => {
    const dir = await makeDir();
    const committed: number[] = [];
    const sink = createSink({ dir, from: 0, to: 4, lookahead: 8, onCommit: (i) => committed.push(i) });

    await sink.write(frame(2));
    await sink.write(frame(3));
    // Nothing can be written yet: frame 0 is missing, and writing 2 first would put the film in the
    // wrong order.
    expect(committed).toEqual([]);
    expect(sink.stats().buffered).toBe(2);

    await sink.write(frame(1));
    expect(committed).toEqual([]);

    await sink.write(frame(0));
    // Now the run unblocks: 0, 1, 2, 3 in order.
    expect(committed).toEqual([0, 1, 2, 3]);
    expect(sink.stats().buffered).toBe(0);
    await sink.close();
  });

  it("starts at `from`, so a render of a sub-range needs no frames before it", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 40, to: 43, lookahead: 4 });
    for (const i of [42, 41, 40]) await sink.write(frame(i));
    const closed = await sink.close();
    expect(closed.frames).toBe(3);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual([40, 41, 42].map((i) => frameName(i, "rgb")));
  });
});

/**
 * Correctness when every producer writes at once.
 *
 * These assert an outcome, not the absence of a race — and that distinction is worth stating, because the
 * first version of this comment claimed the latter. `drain()` was changed to close a race in which two
 * callers read `next` before either advanced it. The racy version was then restored deliberately to check
 * these tests caught it: **they did not**, because the window turns out to be unreachable in Node — the
 * interval between reading `next` and advancing it contains an `await`, but by the time control returns to
 * the event loop `next` has already moved. So there was no race to catch, and claiming otherwise would have
 * been a story rather than a measurement.
 *
 * `drain()` is still serialised on a promise chain. Not because a race was proven, but because a chain makes
 * the ordering property local instead of an argument about the event loop, and because it stops thousands of
 * concurrent `writeFile` calls from being in flight on a long render.
 *
 * What these tests genuinely cover: that concurrent producers preserve both the *presence* and the *content*
 * of every frame. A frame written under the wrong index is the failure mode worth fearing here, so the
 * content check is the one doing the work.
 */
describe("FrameSink — concurrent producers", () => {
  it("keeps every frame when all writes are issued at the same moment, in order", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 60, lookahead: 64 });
    await Promise.all(Array.from({ length: 60 }, (_, i) => sink.write(frame(i))));
    expect((await sink.close()).frames).toBe(60);
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(60);
    expect(files).toEqual(Array.from({ length: 60 }, (_, i) => frameName(i, "rgb")));
    for (const i of [0, 17, 59]) {
      expect(await readFile(join(dir, frameName(i, "rgb")), "utf8")).toBe(`frame-${i}`);
    }
  });

  it("keeps every frame when all writes are issued at once, shuffled", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 60, lookahead: 64 });
    // A deterministic shuffle, so a failure is reproducible rather than a one-in-twenty mystery.
    const order = Array.from({ length: 60 }, (_, i) => i).sort(
      (a, b) => ((a * 7919) % 61) - ((b * 7919) % 61),
    );
    await Promise.all(order.map((i) => sink.write(frame(i))));
    expect((await sink.close()).frames).toBe(60);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(Array.from({ length: 60 }, (_, i) => frameName(i, "rgb")));
    // Content matters as much as presence: the race's signature is a frame written under the wrong index.
    for (const i of [0, 30, 59]) {
      expect(await readFile(join(dir, frameName(i, "rgb")), "utf8")).toBe(`frame-${i}`);
    }
  });

  it("survives concurrency across several chunks, which is what --workers does", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 120, lookahead: 16 });
    // Four contiguous chunks, each produced concurrently — the shape `planChunks` gives the renderer.
    const chunks = [
      [0, 30],
      [30, 60],
      [60, 90],
      [90, 120],
    ];
    await Promise.all(
      chunks.map(async ([from, to]) => {
        for (let i = from as number; i < (to as number); i++) await sink.write(frame(i));
      }),
    );
    expect((await sink.close()).frames).toBe(120);
    const files = await readdir(dir);
    expect(files).toHaveLength(120);
    for (const i of [0, 29, 30, 89, 90, 119]) {
      expect(await readFile(join(dir, frameName(i, "rgb")), "utf8")).toBe(`frame-${i}`);
    }
  });
});

describe("FrameSink — refusals", () => {
  it("refuses a duplicate index, because it means a frame was never rendered", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 3, lookahead: 8 });
    await sink.write(frame(0));
    await expect(sink.write(frame(0))).rejects.toThrow(/handed over twice/);
    await sink.abort();
  });

  it("refuses an index below the reserved range", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 10, to: 12, lookahead: 4 });
    await expect(sink.write(frame(9))).rejects.toThrow(/outside the reserved range/);
    await sink.abort();
  });

  it("refuses an index at or above `to`", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 10, to: 12, lookahead: 4 });
    await expect(sink.write(frame(12))).rejects.toThrow(/outside the reserved range/);
    await sink.abort();
  });

  it("refuses to close with a hole, and names the missing indices", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 4, lookahead: 8 });
    await sink.write(frame(0));
    await sink.write(frame(3));
    await sink.write(frame(2));
    // Frame 1 never arrives. Closing must fail rather than produce a three-frame film.
    await expect(sink.close()).rejects.toThrow(/never written/);
    await sink.abort();
  });

  it("refuses to close when fewer frames than reserved were written", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 4, lookahead: 8 });
    for (const i of [0, 1, 2]) await sink.write(frame(i));
    // 3 was never written; `held` is empty, so the hole is at the tail.
    await expect(sink.close()).rejects.toThrow(/reserved/);
    await sink.abort();
  });

  it("rejects an empty range at construction rather than at close", async () => {
    const dir = await makeDir();
    expect(() => createSink({ dir, from: 5, to: 5, lookahead: 4 })).toThrow(FrameSinkError);
    expect(() => createSink({ dir, from: 5, to: 4, lookahead: 4 })).toThrow(/empty/);
  });

  it("rejects a lookahead below one", async () => {
    const dir = await makeDir();
    expect(() => createSink({ dir, from: 0, to: 2, lookahead: 0 })).toThrow(/lookahead/);
  });
});

describe("FrameSink — abort and paths", () => {
  it("deletes everything on abort, so a failed render leaves nothing plausible", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 3, lookahead: 8 });
    await sink.write(frame(0));
    await sink.write(frame(1));
    await sink.abort();
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("refuses a path for a frame that was never written", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 3, lookahead: 8 });
    expect(() => sink.pathFor(0)).toThrow(/has not been written/);
    await sink.write(frame(0));
    expect(sink.pathFor(0)).toContain(frameName(0, "rgb"));
    await sink.abort();
  });
});

describe("FrameSink — back-pressure", () => {
  it("makes a producer wait when it is ahead of `next` by more than the lookahead", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 4, lookahead: 3 });

    // Produce ahead of `next`, which is what a fast worker does. Frames 1 and 2 are within the bound and
    // are accepted; frame 3 is not, because accepting it would leave four frames held.
    await sink.write(frame(1));
    await sink.write(frame(2));
    expect(sink.stats().buffered).toBe(2);

    let settled = false;
    // Deliberately NOT awaited: this write must block, and awaiting it here would deadlock the test
    // against the very behaviour it asserts. Real producers are separate async contexts, which is this.
    const pending = sink.write(frame(3)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(sink.stats().backPressureEvents).toBeGreaterThan(0);

    // Filling the hole at 0 drains 1 and 2, which advances `next` far enough to accept frame 3.
    await sink.write(frame(0));
    await pending;
    expect(settled).toBe(true);
    expect(sink.stats().written).toBe(4);
    await sink.close();

    const files = (await readdir(dir)).sort();
    expect(files).toEqual([0, 1, 2, 3].map((i) => frameName(i, "rgb")));
  });

  it("never blocks in-order production, however far the producer runs", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 40, lookahead: 2 });
    // In-order production advances `next` on every write, so the bound never binds. That is why the
    // lookahead costs nothing in the common case and only throttles a worker that has raced ahead.
    for (let i = 0; i < 40; i++) await sink.write(frame(i));
    expect(sink.stats().backPressureEvents).toBe(0);
    expect((await sink.close()).frames).toBe(40);
  });

  it("waitFor resolves once enough frames have committed, and immediately when already satisfied", async () => {
    const dir = await makeDir();
    const sink = createSink({ dir, from: 0, to: 3, lookahead: 8 });
    await expect(sink.waitFor(0)).resolves.toBeUndefined();
    for (const i of [0, 1, 2]) await sink.write(frame(i));
    await expect(sink.waitFor(3)).resolves.toBeUndefined();
    await sink.close();
  });

  it("releases a blocked writer on abort, so a failed render cannot hang", async () => {
    const dir = await makeDir();
    // `next` is 0 and nothing will ever fill it, so a write of frame 2 must block on the lookahead bound.
    const sink = createSink({ dir, from: 0, to: 10, lookahead: 2 });
    await sink.write(frame(1));
    let settled = false;
    const pending = sink.write(frame(2)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(sink.stats().backPressureEvents).toBeGreaterThan(0);

    // A render that dies must not leave a producer waiting forever for a frame that will never arrive.
    await sink.abort();
    await pending;
    expect(settled).toBe(true);
  });
});

describe("frameName", () => {
  it("zero-pads to six digits so ffmpeg's %06d globbing stays in order", () => {
    expect(frameName(0, "jpg")).toBe("f000000.jpg");
    expect(frameName(7, "jpg")).toBe("f000007.jpg");
    expect(frameName(123456, "png")).toBe("f123456.png");
    // Past a million the padding grows rather than wrapping, which keeps sorting correct.
    expect(frameName(1234567, "jpg")).toBe("f1234567.jpg");
  });

  it("sorts lexicographically in numeric order, which is what the encoder relies on", () => {
    const names = [10, 2, 100, 1].map((i) => frameName(i, "jpg"));
    expect([...names].sort()).toEqual([1, 2, 10, 100].map((i) => frameName(i, "jpg")));
  });
});

describe("planChunks", () => {
  it("covers the range exactly, with no gap and no overlap", () => {
    for (const workers of [1, 2, 3, 5, 7, 16]) {
      const chunks = planChunks(0, 100, workers);
      expect(chunks[0]?.from).toBe(0);
      expect(chunks[chunks.length - 1]?.to).toBe(100);
      const total = chunks.reduce((sum, c) => sum + c.frames, 0);
      expect(total).toBe(100);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]?.from).toBe(chunks[i - 1]?.to);
      }
    }
  });

  it("never creates more chunks than there are frames", () => {
    const chunks = planChunks(0, 3, 16);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.frames === 1)).toBe(true);
  });

  it("handles a sub-range, which is how --only renders one block", () => {
    const chunks = planChunks(40, 60, 2);
    expect(chunks).toEqual([
      { worker: 0, from: 40, to: 50, frames: 10 },
      { worker: 1, from: 50, to: 60, frames: 10 },
    ]);
  });

  it("returns nothing for an empty range rather than one empty chunk", () => {
    expect(planChunks(5, 5, 4)).toEqual([]);
  });

  it("ignores a worker count above the frame count instead of producing empty chunks", () => {
    const chunks = planChunks(0, 2, 8);
    expect(chunks).toHaveLength(2);
    expect(chunks.some((c) => c.frames === 0)).toBe(false);
  });
});
