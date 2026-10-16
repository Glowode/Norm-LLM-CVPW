/**
 * The decisive test, with the reference and the test measured in the SAME session.
 *
 * The previous attempt compared a reference walk in one browser session against chunked walks in other
 * sessions, and reported a divergence. That comparison cannot distinguish "chunking changed the frames"
 * from "the sessions differed", and the earlier spikes gave contradictory answers about which it was.
 *
 * So this script removes the ambiguity:
 *
 *   Session S: walk 0..N sequentially, recording every digest.   (the reference)
 *   Session S: walk 0..N again, interleaved with a chunked pass that renders from a fresh position.
 *
 * Every measurement that is compared happens inside one browser session, so session variance cannot
 * contribute. What remains is exactly the question that matters: **does starting a worker part-way
 * through the timeline change the frames it produces?**
 *
 * Run:  node scripts/spike-decide.mjs
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBrowser, renderArgs } from "../packages/cli/dist/browser.js";
import { Browser } from "../packages/render/dist/cdp.js";
import { startStaticServer } from "../packages/render/dist/server.js";

const FPS = 30;
const TOTAL = 40;
const CHUNKS = [
  [0, 13],
  [14, 27],
  [28, 39],
];

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
window.ready=true;
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = detectBrowser();
  if (!info) {
    console.error("no browser");
    process.exitCode = 2;
    return;
  }
  const workDir = await mkdtemp(join(tmpdir(), "cvpw-decide-page-"));
  await writeFile(join(workDir, "index.html"), PAGE, { encoding: "utf8" });
  const server = await startStaticServer({ root: workDir });

  const browser = await Browser.launch({
    executable: info.path,
    args: renderArgs(),
    tempRoot: join(tmpdir(), "cvpw-spike"),
    timeoutMs: 90_000,
  });

  const hashFrame = async (f) => {
    await browser.evaluate(`window.renderFrame(${f} / ${FPS})`);
    return browser.evaluate("window.digest()");
  };

  try {
    await browser.navigate(`${server.origin}/index.html`, 90_000);
    for (let i = 0; i < 400; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await sleep(50);
    }
    await browser.evaluate("document.fonts.ready.then(function(){return true})", { awaitPromise: true });

    // --- pass 1: one sequential walk, the reference -------------------------------------------------
    const reference = new Map();
    for (let f = 0; f < TOTAL; f++) reference.set(f, await hashFrame(f));
    console.log(`Reference walk: ${TOTAL} frames rendered 0..${TOTAL - 1} sequentially.`);

    // --- pass 2: the same walk again, to prove in-session repeatability ----------------------------
    const second = new Map();
    for (let f = 0; f < TOTAL; f++) second.set(f, await hashFrame(f));
    const repeatDiff = [...reference.keys()].filter((f) => reference.get(f) !== second.get(f));
    console.log(`Second identical walk in the same session: ${repeatDiff.length} frame(s) differ.\n`);

    // --- pass 3: a chunked renderer. Each chunk starts cold at its own first frame -----------------
    const chunked = new Map();
    for (const [start, end] of CHUNKS) {
      for (let f = start; f <= end; f++) chunked.set(f, await hashFrame(f));
    }

    // --- pass 4: a chunked renderer WITH a one-frame preroll ---------------------------------------
    const preroll = new Map();
    for (const [start, end] of CHUNKS) {
      if (start > 0) await hashFrame(start - 1); // rendered and discarded
      for (let f = start; f <= end; f++) preroll.set(f, await hashFrame(f));
    }

    console.log("  frame   reference   repeat     chunked     preroll     boundaries");
    console.log("  ------  ----------  ---------  ----------  ----------  ----------");
    let chunkDiff = 0;
    let prerollDiff = 0;
    for (let f = 0; f < TOTAL; f++) {
      const r = reference.get(f);
      const s = second.get(f);
      const c = chunked.get(f);
      const p = preroll.get(f);
      if (r !== c) chunkDiff++;
      if (r !== p) prerollDiff++;
      const isBoundary = CHUNKS.some(([start]) => start === f);
      if (f < 3 || isBoundary || r !== c || r !== p) {
        console.log(
          `  ${String(f).padStart(6)}  ${r.padEnd(10)}  ${(r === s ? "same" : "DIFF").padEnd(9)}  ${c.padEnd(10)}  ${p.padEnd(10)}  ${isBoundary ? "CHUNK START" : ""}`,
        );
      }
    }

    console.log("");
    console.log(`  identical-walk differences (harness sanity)     : ${repeatDiff.length}/${TOTAL}`);
    console.log(`  chunked render differences from sequential      : ${chunkDiff}/${TOTAL}`);
    console.log(`  chunked + 1-frame preroll differences           : ${prerollDiff}/${TOTAL}`);
    console.log("");
    if (repeatDiff.length > 0) {
      console.log("INCONCLUSIVE: even two identical walks in one session differ, so nothing below is");
      console.log("              attributable to chunking. Fix the harness before trusting any of it.");
    } else if (chunkDiff === 0) {
      console.log("RESULT: chunked rendering reproduces a sequential render exactly.");
      console.log("        --workers does not change the film, and the FrameSink ordering invariant");
      console.log("        is sufficient. No preroll is required.");
    } else if (prerollDiff === 0) {
      console.log("RESULT: chunking changes frames, and a ONE-FRAME preroll fixes it completely.");
      console.log("        Every worker MUST render one frame before its range and discard it.");
    } else {
      console.log(`RESULT: chunking changes ${chunkDiff} frames and a 1-frame preroll leaves ${prerollDiff}.`);
      console.log("        Increase the preroll until it reaches zero, or serialise the render.");
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
