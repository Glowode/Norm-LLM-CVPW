/**
 * A spike, not a test: does `renderFrame(t)` in headless Edge produce byte-identical frames?
 *
 * The whole render architecture follows from that one property — parallel workers, frame skipping,
 * pixel-level seam comparison, gold-frame regression. `docs/PROGRESS.md` names it as the highest-risk
 * unproven assumption, so it is answered before any of the architecture is built on top of it.
 *
 * The page is deliberately adversarial: gradients, antialiased paths, text, a canvas `filter` blur, and
 * a hash-keyed grain pass. If determinism survives that, it will survive a scene.
 *
 * Run:  pnpm spike
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBrowser, renderArgs } from "../packages/cli/dist/browser.js";
import { Browser } from "../packages/render/dist/cdp.js";
import { startStaticServer } from "../packages/render/dist/server.js";

const FPS = 30;
const TIMES = [0, 1, 2.5, 4.75, 7.999, 3.333, 5.5];

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>determinism spike</title>
<style>html,body{margin:0;background:#0b0d14}canvas{display:block}</style>
<canvas id="c" width="640" height="360"></canvas>
<script>
const g = document.getElementById('c').getContext('2d', { alpha: false });
const W = 640, H = 360;

function hash32(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)}return h>>>0}
function hash1(key,salt){let x=hash32(String(key)+':'+String(salt));x=Math.imul(x^(x>>>16),0x21f0aaad);x=Math.imul(x^(x>>>15),0x735a2d97);return ((x^(x>>>15))>>>0)/4294967296}

function draw(t){
  const frame = Math.round(t * ${FPS});
  g.setTransform(1,0,0,1,0,0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, 'rgb(12,14,26)');
  bg.addColorStop(0.5 + 0.4*Math.sin(t*0.7), 'rgb(' + Math.round(60+40*Math.sin(t)) + ',30,80)');
  bg.addColorStop(1, 'rgb(4,6,12)');
  g.fillStyle = bg;
  g.fillRect(0,0,W,H);

  g.save();
  g.translate(W/2, H/2);
  g.rotate(t * 0.6);
  for (let i = 0; i < 7; i++) {
    g.save();
    g.rotate(i * Math.PI / 3.5);
    g.globalAlpha = 0.35;
    g.fillStyle = 'hsl(' + Math.round((i*40 + t*20) % 360) + ',70%,60%)';
    g.beginPath();
    g.moveTo(0, -60 - i*6);
    g.lineTo(38 + i*3, 40);
    g.lineTo(-38 - i*3, 40);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.restore();

  g.save();
  g.font = '600 28px sans-serif';
  g.fillStyle = '#ffe28e';
  g.fillText('t=' + t.toFixed(4) + ' frame=' + frame, 16, 34);
  g.font = '500 18px monospace';
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillText('seed ' + hash1('spike','x').toFixed(8), 16, H - 18);
  g.restore();

  g.save();
  g.filter = 'blur(3px)';
  g.fillStyle = 'rgba(120,200,255,0.7)';
  g.beginPath();
  g.arc(120 + 80*Math.cos(t*0.9), 250 + 30*Math.sin(t*1.3), 34, 0, 7);
  g.fill();
  g.restore();

  const step = 2;
  g.globalCompositeOperation = 'overlay';
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const n = hash1('grain', (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791));
      if (n < 0.62) continue;
      const v = (n - 0.62) / 0.38;
      g.fillStyle = n > 0.81 ? 'rgba(255,255,255,' + (v*0.35).toFixed(4) + ')' : 'rgba(0,0,0,' + (v*0.35).toFixed(4) + ')';
      g.fillRect(x, y, step, step);
    }
  }
  g.globalCompositeOperation = 'source-over';
  return true;
}

window.renderFrame = function(t){ draw(t); return true; };
window.frameDigest = function(){
  const d = g.getImageData(0, 0, W, H).data;
  const out = [];
  for (let j = 0; j < 64; j++) {
    const y = Math.floor((j+0.5)/64*H);
    for (let i = 0; i < 64; i++) {
      const x = Math.floor((i+0.5)/64*W);
      const o = (y*W+x)*4;
      out.push(d[o], d[o+1], d[o+2]);
    }
  }
  return out.join(',');
};
window.rendererInfo = (function(){
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
})();
draw(0);
window.ready = true;
</script>`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(label, origin, executable, args) {
  const browser = await Browser.launch({
    executable,
    args,
    tempRoot: join(tmpdir(), "cvpw-spike"),
    timeoutMs: 90_000,
  });
  const hashes = new Map();
  const sizes = new Map();
  const order = new Map();
  try {
    await browser.navigate(`${origin}/index.html`, 90_000);
    for (let i = 0; i < 400; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await sleep(50);
    }
    // Fonts must settle BEFORE frame zero: a frame drawn with a fallback face is a different picture,
    // and the difference lands on the first frames of a render where nobody looks.
    await browser.evaluate("document.fonts ? document.fonts.ready.then(function(){return true}) : true", {
      awaitPromise: true,
    });
    const renderer = await browser.evaluate("window.rendererInfo");

    // Pass 1: ascending order.
    for (const t of TIMES) {
      await browser.evaluate(`window.renderFrame(${t})`);
      const digest = await browser.evaluate("window.frameDigest()");
      hashes.set(t, createHash("sha256").update(digest).digest("hex").slice(0, 16));
    }
    // Pass 2: REVERSED order, plus a PNG capture. Reversing is the point: it is what a parallel
    // renderer does, and it is the cheapest way to catch any dependence on the order frames arrive in.
    for (const t of [...TIMES].reverse()) {
      await browser.evaluate(`window.renderFrame(${t})`);
      const digest = await browser.evaluate("window.frameDigest()");
      order.set(t, createHash("sha256").update(digest).digest("hex").slice(0, 16));
      const png = await browser.screenshot({ format: "png" });
      sizes.set(t, png.length);
    }
    return { label, hashes, sizes, order, renderer };
  } finally {
    await browser.close();
  }
}

async function main() {
  const info = detectBrowser();
  if (!info) {
    console.error("spike: no chromium-family browser found; set CVPW_BROWSER");
    process.exitCode = 2;
    return;
  }
  const args = renderArgs();
  console.log(`spike: page determinism in headless ${info.name}`);
  console.log(`spike: ${info.path}`);
  console.log(`spike: ${args.join(" ")}\n`);

  const workDir = await mkdtemp(join(tmpdir(), "cvpw-spike-page-"));
  await writeFile(join(workDir, "index.html"), PAGE, { encoding: "utf8" });
  const server = await startStaticServer({ root: workDir });

  try {
    const runA = await capture("A", server.origin, info.path, args);
    const runB = await capture("B", server.origin, info.path, args);

    console.log(`renderer: ${runA.renderer}`);
    console.log(`renderer: ${runB.renderer}\n`);

    let crossSession = 0;
    let orderDependent = 0;
    console.log("  time       session A         session B         reversed   verdict");
    console.log("  ---------- ---------------   ---------------   ---------- -------");
    for (const t of TIMES) {
      const a = runA.hashes.get(t) ?? "(missing)";
      const b = runB.hashes.get(t) ?? "(missing)";
      const r = runA.order.get(t) ?? "(missing)";
      const sameSession = a === b && a !== "(missing)";
      const sameOrder = a === r && a !== "(missing)";
      if (!sameSession) crossSession++;
      if (!sameOrder) orderDependent++;
      console.log(
        `  ${t.toFixed(4).padStart(10)} ${a.padEnd(17)} ${b.padEnd(17)} ${(sameOrder ? "same" : "DIFFER").padEnd(10)} ${
          sameSession && sameOrder ? "identical" : sameSession ? "ORDER-DEP" : "DIFFER"
        }`,
      );
    }

    console.log("\n  capture PNG sizes (session B):");
    for (const t of TIMES) console.log(`    t=${t.toFixed(3).padStart(6)}  ${String(runB.sizes.get(t)).padStart(7)} bytes`);

    console.log("");
    const ok = crossSession === 0 && orderDependent === 0;
    if (ok) {
      console.log(`RESULT: ${TIMES.length}/${TIMES.length} frames identical across two browser sessions,`);
      console.log("        and identical when rendered in reverse order.");
      console.log("        Parallel rendering, frame skipping and gold-frame regression are sound.");
    } else {
      console.log(`RESULT: ${crossSession} cross-session mismatch(es), ${orderDependent} order-dependent frame(s).`);
      console.log("        The determinism claim does NOT hold as built. Find the source before proceeding.");
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
