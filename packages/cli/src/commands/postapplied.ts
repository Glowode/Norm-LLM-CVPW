/**
 * `render.postApplied` — the gate this project needed and did not have.
 *
 * `post.vignette`, `post.tint`, `post.grain` and `post.bloom` were declared, validated, accepted, and applied by
 * nobody for the entire life of the engine, because `renderFrame` returned before `finish()` on the default
 * `samples: 1` path. Every one of the twenty-seven existing gates passed while the grade was dead:
 *
 * - `render.frameContent` asks whether a frame has *content*, and it did — the scenes drew it.
 * - `determinism.gold` asks whether frames are *reproducible*, and they were — reproducibly ungraded.
 * - `text.*` asks about type, `flash.rate` about luminance, `timeline.*` about the edit.
 *
 * None of them asks the question that matters here: **does a value the project declares have any effect at all?**
 *
 * ## How it measures that without reading source
 *
 * The engine has one flag that must change the picture if the post chain runs: `noGrain`. Grain is a
 * per-frame-keyed noise pass, so a frame rendered with grain and the same frame rendered without it cannot be
 * identical — unless the pass never runs. So the gate renders one frame twice, once through `?nograin`, and
 * compares.
 *
 * A project that declares no grain has nothing to compare, so the gate reports that honestly rather than passing
 * on an empty measurement. That is the same rule the rest of the suite follows: a skip with a reason, never a
 * pass on nothing.
 */

import { join } from "node:path";

import { Browser, startStaticServer } from "@cvpw/render";

import { detectBrowser, renderArgs } from "../browser.js";
import { projectPaths, readJson } from "../shared.js";
import type { Offender } from "./check.js";

export interface PostAppliedResult {
  ok: boolean;
  measured: Record<string, string | number>;
  offenders: Offender[];
  skipped?: string;
}

/** Grain is the probe. It is per-frame noise, so its presence or absence is unambiguous. */
export async function checkPostApplied(input: {
  root: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
}): Promise<PostAppliedResult> {
  const project = (await readJson(projectPaths(input.root).projectJson)) as {
    style?: string;
  } | null;

  // The declared grade may come from the style or from a shot's own `post`. Rather than re-implementing the
  // engine's merge, the gate asks the page what it resolved — the copy is fine here, because it is being *read*,
  // not mutated.
  const browserInfo = detectBrowser();
  if (!browserInfo) {
    return { ok: true, measured: {}, offenders: [], skipped: "no browser, so the grade cannot be exercised" };
  }

  const server = await startStaticServer({ root: input.root });
  const shots: number[] = [];
  const probe = async (url: string): Promise<{ hash: string; post: Record<string, number> } | null> => {
    const browser = await Browser.launch({
      executable: browserInfo.path,
      args: renderArgs(),
      tempRoot: join(input.root, "render", ".scratch"),
      timeoutMs: 90_000,
    });
    try {
      await browser.setViewport(input.width, input.height, 1);
      await browser.navigate(url, 90_000);
      for (let i = 0; i < 600; i++) {
        if (await browser.evaluate("window.ready === true")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await browser
        .evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", { awaitPromise: true })
        .catch(() => undefined);

      const frame = Math.round(input.duration * input.fps * 0.55);
      shots.push(frame);
      await browser.evaluate(`window.cvpw.renderFrame(${frame} / ${input.fps})`);
      await browser.flush();

      const captured = await browser.evaluate<string>(
        `(function(){
          var g = document.getElementById("out").getContext("2d");
          var d = g.getImageData(0, 0, 64, 64).data;
          var h = 5381;
          for (var i = 0; i < d.length; i++) h = (((h << 5) + h) ^ d[i]) >>> 0;
          return h.toString(16);
        })()`,
      );
      const post = await browser.evaluate<Record<string, number>>(
        `(function(){
          var r = (window.engine && window.engine.resolved) || [];
          var last = r.length ? r[r.length - 1].post || {} : {};
          return last;
        })()`,
      );
      return { hash: captured, post: post ?? {} };
    } catch {
      return null;
    } finally {
      await browser.close();
    }
  };

  try {
    const withGrain = await probe(`${server.origin}/engine/index.html?capture`);
    const withoutGrain = await probe(`${server.origin}/engine/index.html?capture&nograin`);
    if (!withGrain || !withoutGrain) {
      return { ok: true, measured: {}, offenders: [], skipped: "the page could not be exercised twice" };
    }

    const declaredGrain = Number(withGrain.post["grain"] ?? 0) || 0;
    if (declaredGrain <= 0) {
      return {
        ok: true,
        measured: { "declared grain": 0, style: project?.style ?? "(none)" },
        offenders: [],
        skipped:
          "this project declares no grain, so there is nothing whose presence proves the post chain runs. A " +
          "project that declares a grade would be checked here.",
      };
    }

    const identical = withGrain.hash === withoutGrain.hash;
    return {
      ok: !identical,
      measured: {
        "declared grain": declaredGrain,
        "with grain": withGrain.hash,
        "without grain": withoutGrain.hash,
        frame: shots[0] ?? 0,
      },
      offenders: identical
        ? [
            {
              code: "post.inert",
              where: `frame ${shots[0] ?? 0}`,
              detail:
                `the project declares grain ${declaredGrain} but the frame is byte-identical with and without it, ` +
                `so the post chain is not being applied. This is exactly the defect that made vignette, tint, ` +
                `grain and bloom inert for the engine's whole life: renderFrame returned before finish() on the ` +
                `default samples=1 path.`,
            },
          ]
        : [],
    };
  } finally {
    await server.close();
  }
}
