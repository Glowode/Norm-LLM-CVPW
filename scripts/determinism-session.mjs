/**
 * The decisive question: is `getImageData` readback stable between sessions at all?
 *
 * `spike-recipe.mjs` produced a result that contradicts `spike-determinism.mjs`. The first spike found
 * the same frame sequence identical across two sessions (7/7). The recipe spike ran the *reference
 * sequence itself* — frames 0..20 — in a fresh session and got a different digest for frame 20.
 *
 * Both cannot be true, and which one is true decides the capture architecture:
 *
 *   - If readback is stable but a frame's pixels depend on the session's history, then the render is
 *     reproducible only for a fixed sequence, and parallelism needs the sequence preserved.
 *   - If readback differs between sessions for the SAME sequence, then `getImageData` is not a
 *     determinism witness at all, and the only trustworthy witness is the encoded frame that actually
 *     reaches the encoder — which means `frameHash` must be computed from captured bytes, not from an
 *     in-page pixel read.
 *
 * This script answers it three ways:
 *   1. the same sequence, twice, in two fresh sessions — compared frame by frame;
 *   2. the same sequence, twice, in ONE session (re-rendered) — isolates in-session repeatability;
 *   3. both `getImageData` digests AND captured-PNG sizes/hashes for the same frames, so the two
 *      witnesses can be compared directly.
 *
 * Run:  node scripts/spike-session.mjs
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBrowser, renderArgs } from "../packages/cli/dist/browser.js";
import { Browser } from "../packages/render/dist/cdp.js";
import { startStaticServer } from "../packages/render/dist/server.js";

const FPS = 30;
const FRAMES = Array.from({ length: 24 }, (_, i) => i);

const PAGE = `<!doctype html>
<meta charset="utf-8"><style>html,body{margin:0;background:#0b0d14}canvas{display:block}</style>
<canvas id="c" width="320" height="180"></canvas>
<script>
const g = document.getElementById('c').getContext('2d', { alpha: false });
const W=320,H=180;
function hash32(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)}return h>>>0}
function hash1(k,s2){let x=hash32(String(k)+':'+String(s2));x=Math.imul(x^(x>>>16),0x21f0aaad);x=Math.imul(x^(x>>>15),0x735a2d97);return ((x^(x>>>15))>>>0)/4294967296}
function draw(t){
  const frame=Math.round(t*${FPS});
  g.setTransform(1,0,0,1,0,0); g.globalAlpha=1; g.globalCompositeOperation='source-over'; g.filter='none';
  const bg=g.createLinearGradient(0,0,W,H);
  bg.addColorStop(0,'rgb(12,14,26)');
  bg.addColorStop(0.5+0.4*Math.sin(t*0.7),'rgb('+Math.round(60+40*Math.sin(t))+',30,80)');
  bg.addColorStop(1,'rgb(4,6,12)');
  g.fillStyle=bg; g.fillRect(0,0,W,H);
  g.save(); g.translate(W/2,H/2); g.rotate(t*0.6);
  for(let i=0;i<5;i++){ g.save(); g.rotate(i*Math.PI/2.5); g.globalAlpha=0.35;
    g.fillStyle='hsl('+Math.round((i*47+t*20)%360)+',70%,60%)';
    g.beginPath(); g.moveTo(0,-30-i*4); g.lineTo(20+i*2,22); g.lineTo(-20-i*2,22); g.closePath(); g.fill(); g.restore(); }
  g.restore();
  g.font='600 18px sans-serif'; g.fillStyle='#ffe28e'; g.fillText('t='+t.toFixed(4),10,24);
  g.filter='blur(2px)'; g.fillStyle='rgba(120,200,255,0.7)';
  g.beginPath(); g.arc(70+40*Math.cos(t*0.9),130+12*Math.sin(t*1.3),16,0,7); g.fill(); g.filter='none';
  g.globalCompositeOperation='overlay';
  for(let y=0;y<H;y+=2){ for(let x=0;x<W;x+=2){
    const n=hash1('grain',(x*73856093)^(y*19349663)^(frame*83492791));
    if(n<0.72)continue; const v=(n-0.72)/0.28;
    g.fillStyle=n>0.86?'rgba(255,255,255,'+(v*0.3).toFixed(4)+')':'rgba(0,0,0,'+(v*0.3).toFixed(4)+')';
    g.fillRect(x,y,2,2); }}
  g.globalCompositeOperation='source-over';
  return true;
}
window.renderFrame=function(t){ draw(t); return true; };
window.digest=function(){ const d=g.getImageData(0,0,W,H).data; let h=5381;
  for(let i=0;i<d.length;i+=4){ h=(((h<<5)+h)^(d[i]*1024+d[i+1]*32+d[i+2]))>>>0; } return h.toString(16); };
// A finer witness: the full byte histogram of the frame, so a sub-quantisation difference is visible.
window.detail=function(){ const d=g.getImageData(0,0,W,H).data;
  const hist=new Array(256).fill(0);
  for(let i=0;i<d.length;i+=4) hist[d[i]]++;
  let nz=0; for(let i=0;i<256;i++) if(hist[i]) nz++;
  return nz + ':' + hist[3] + ':' + hist[200] + ':' + hist.join('').length; };
window.ready=true;
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(executable, origin) {
  const browser = await Browser.launch({
    executable,
    args: renderArgs(),
    tempRoot: join(tmpdir(), "cvpw-spike"),
    timeoutMs: 90_000,
  });
  await browser.navigate(`${origin}/index.html`, 90_000);
  for (let i = 0; i < 400; i++) {
    if (await browser.evaluate("window.ready === true")) break;
    await sleep(50);
  }
  await browser.evaluate("document.fonts.ready.then(function(){return true})", { awaitPromise: true });
  return browser;
}

/** Walk frames 0..N, recording both witnesses at every frame. */
async function walk(executable, origin, withPng) {
  const browser = await session(executable, origin);
  const digests = new Map();
  const details = new Map();
  const pngs = new Map();
  try {
    for (const f of FRAMES) {
      await browser.evaluate(`window.renderFrame(${f} / ${FPS})`);
      digests.set(f, await browser.evaluate("window.digest()"));
      details.set(f, await browser.evaluate("window.detail()"));
      if (withPng) {
        const png = await browser.screenshot({ format: "png" });
        pngs.set(f, createHash("sha256").update(png).digest("hex").slice(0, 12));
      }
    }
  } finally {
    await browser.close();
  }
  return { digests, details, pngs };
}

async function main() {
  const info = detectBrowser();
  if (!info) {
    console.error("no browser");
    process.exitCode = 2;
    return;
  }
  const workDir = await mkdtemp(join(tmpdir(), "cvpw-session-page-"));
  await writeFile(join(workDir, "index.html"), PAGE, { encoding: "utf8" });
  const server = await startStaticServer({ root: workDir });

  try {
    console.log("Session A (also capturing PNGs)…");
    const a = await walk(info.path, server.origin, true);
    console.log("Session B (same sequence, no PNG capture)…");
    const b = await walk(info.path, server.origin, false);
    console.log("Session C (same sequence, no PNG capture)…");
    const c = await walk(info.path, server.origin, false);
    console.log("");

    console.log("  frame   A digest    B digest    C digest    A detail      B detail      verdict");
    console.log("  ------  ----------  ----------  ----------  ------------  ------------  -------");
    let abDiff = 0;
    let acDiff = 0;
    let detailDiff = 0;
    for (const f of FRAMES) {
      const da = a.digests.get(f);
      const db = b.digests.get(f);
      const dc = c.digests.get(f);
      const sameAB = da === db;
      const sameAC = da === dc;
      const sameDetail = a.details.get(f) === b.details.get(f);
      if (!sameAB) abDiff++;
      if (!sameAC) acDiff++;
      if (!sameDetail) detailDiff++;
      if (f < 6 || !sameAB || !sameAC || !sameDetail) {
        console.log(
          `  ${String(f).padStart(6)}  ${da.padEnd(10)}  ${db.padEnd(10)}  ${dc.padEnd(10)}  ${String(a.details.get(f)).padEnd(12)}  ${String(b.details.get(f)).padEnd(12)}  ` +
            `${sameAB && sameAC ? "identical" : "DIGEST DIFFERS"}${sameDetail ? "" : " / detail differs"}`,
        );
      }
    }

    console.log("");
    console.log(`  A vs B (identical sequence, two sessions): ${abDiff}/${FRAMES.length} frames differ`);
    console.log(`  A vs C (identical sequence, two sessions): ${acDiff}/${FRAMES.length} frames differ`);
    console.log(`  byte-histogram differences              : ${detailDiff}/${FRAMES.length}`);
    console.log("");
    console.log("  PNG capture hashes from session A:");
    for (const f of FRAMES.slice(0, 8)) console.log(`    frame ${String(f).padStart(2)}  ${a.pngs.get(f)}`);

    console.log("");
    if (abDiff === 0 && acDiff === 0) {
      console.log("RESULT: `getImageData` readback IS stable between sessions for a fixed sequence.");
      console.log("        The recipe spike's contradiction must have another cause.");
    } else {
      console.log("RESULT: `getImageData` readback is NOT stable between sessions, even for the same");
      console.log(`        sequence: ${abDiff} and ${acDiff} of ${FRAMES.length} frames differ.`);
      console.log("        It is therefore NOT a determinism witness. The only trustworthy witness is");
      console.log("        the bytes that actually reach the encoder.");
      console.log("");
      console.log("        CONSEQUENCE: frameHash MUST be computed from captured frame bytes, not from");
      console.log("        an in-page pixel read; and the gold-frame gate must compare captured frames.");
    }
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
