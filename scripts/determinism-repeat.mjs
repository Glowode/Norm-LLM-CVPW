/**
 * Settle the contradiction by running the exact same walk twice, in the same script, with the same code.
 *
 * `spike-session.mjs` found 24/24 frames identical across three sessions. `spike-recipe.mjs` found the
 * *reference walk itself* differing between two sessions at frame 20. Those cannot both be right, and
 * every difference between the two scripts has been eliminated except one: the recipe spike's walk is
 * nested inside a longer script that ran other things first.
 *
 * So this runs the identical walk N times and prints a per-frame comparison across all of them. If some
 * sessions match and others do not, the variance is real and bounded. If all match, the recipe spike had
 * a bug and the finding is withdrawn rather than explained away.
 *
 * Run:  node scripts/spike-repeat.mjs
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBrowser, renderArgs } from "../packages/cli/dist/browser.js";
import { Browser } from "../packages/render/dist/cdp.js";
import { startStaticServer } from "../packages/render/dist/server.js";

const FPS = 30;
const UP_TO = 24;
const SESSIONS = 5;

/** Byte-for-byte the same page as spike-recipe.mjs, so the two are comparable. */
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

async function walk(executable, origin) {
  const browser = await Browser.launch({
    executable,
    args: renderArgs(),
    tempRoot: join(tmpdir(), "cvpw-spike"),
    timeoutMs: 90_000,
  });
  const out = [];
  try {
    await browser.navigate(`${origin}/index.html`, 90_000);
    for (let i = 0; i < 400; i++) {
      if (await browser.evaluate("window.ready === true")) break;
      await sleep(50);
    }
    await browser.evaluate("document.fonts.ready.then(function(){return true})", { awaitPromise: true });
    for (let f = 0; f <= UP_TO; f++) {
      await browser.evaluate(`window.renderFrame(${f} / ${FPS})`);
      out.push(await browser.evaluate("window.digest()"));
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function main() {
  const info = detectBrowser();
  if (!info) {
    console.error("no browser");
    process.exitCode = 2;
    return;
  }
  const workDir = await mkdtemp(join(tmpdir(), "cvpw-repeat-page-"));
  await writeFile(join(workDir, "index.html"), PAGE, { encoding: "utf8" });
  const server = await startStaticServer({ root: workDir });

  try {
    // Two back-to-back walks, deliberately identical, to see whether the act of running a longer
    // script before a walk changes the walk.
    const runs = [];
    for (let i = 0; i < SESSIONS; i++) {
      process.stdout.write(`  walk ${i + 1}/${SESSIONS}…\r`);
      runs.push(await walk(info.path, server.origin));
    }
    console.log("");

    console.log("  frame   " + runs.map((_, i) => `walk ${i + 1}`.padEnd(11)).join("") + "verdict");
    console.log("  ------  " + runs.map(() => "-----------").join("  ") + "-------");
    let differing = 0;
    for (let f = 0; f <= UP_TO; f++) {
      const values = runs.map((r) => r[f]);
      const allSame = values.every((v) => v === values[0]);
      if (!allSame) differing++;
      if (f < 4 || !allSame) {
        console.log(
          `  ${String(f).padStart(6)}  ` + values.map((v) => v.padEnd(11)).join("  ") + `  ${allSame ? "identical" : "DIFFERS"}`,
        );
      }
    }

    console.log("");
    console.log(`  frames differing across ${SESSIONS} identical walks: ${differing}/${UP_TO + 1}`);
    console.log("");
    if (differing === 0) {
      console.log("RESULT: identical walks are identical across sessions, reproducibly.");
      console.log("        The recipe spike's contradiction is therefore a bug in that script, not a");
      console.log("        property of the renderer. That finding is WITHDRAWN.");
    } else {
      console.log("RESULT: identical walks differ across sessions. This is real nondeterminism that no");
      console.log("        amount of ordering discipline fixes, and it must be measured properly before");
      console.log("        the render architecture is settled.");
    }
  } finally {
    await server.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
