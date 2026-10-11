# ENVIRONMENT — the machine, its tools, and how `doctor` finds them

**Status:** normative (authority level 4 — [SPEC](./SPEC.md) §1).
**Companions:** [WORKFLOW](./WORKFLOW.md) stage 0 (Setup), [CONTRACTS](./CONTRACTS.md) §2,
[QA](./QA.md) (the thresholds that consume these measurements).
**Keywords** MUST, MUST NOT, SHOULD, MAY are RFC 2119.

## 1. Purpose

1. Make the **machine state explicit**. A render that works on one machine and fails on another is
   almost never a rendering bug; it is an unstated environment assumption. Every assumption is written
   down here and probeable.
2. Make every **external tool discoverable and overridable** ([SPEC](./SPEC.md) P5, P7): `ffmpeg`,
   `ffprobe`, `python` and the browser are found at run time, redirected by environment variable, and
   reported by `cvpw doctor` / `cvpw env`.
3. **No absolute tool path may be hard-coded** in this repository — not in code, not in a schema
   default, not in a template, not in a skill script. A path in this document is evidence from one
   machine, never a default to copy. §3 reports measurements; §5 states what every machine MUST answer.
4. Environment facts enter the pipeline in exactly one place, the stage 0 report: if a later stage
   behaves strangely, re-run `cvpw doctor` before re-reading any code.

## 2. REQUIRED vs OPTIONAL

`cvpw doctor` MUST print this split and MUST state the cost of every missing OPTIONAL item
([SPEC](./SPEC.md) P7). A missing REQUIRED item is a hard stop; a missing OPTIONAL item is a number in
a report.

| Item | Class | Minimum | Used for | Cost if missing |
|---|---|---|---|---|
| Node | **REQUIRED** | ≥ 20 | `@cvpw/kernel`, `@cvpw/render`, `@cvpw/cli`, the TS build | Nothing runs. |
| Python | **REQUIRED** | ≥ 3.10 | `python/` analysis, timing, QA scripts | `cvpw analyze`, `cvpw lyrics`, parts of `cvpw check` cannot run. |
| `ffmpeg` | **REQUIRED** | a build with libx264 + aac | frame sequence → MP4, muxing, preview encodes | No deliverable. |
| `ffprobe` | **REQUIRED** | same build as `ffmpeg` | frame count, stream and duration verification | `render.frameCount` and `av.sync` cannot be measured. |
| Chromium-family browser | **REQUIRED** | any recent Edge / Chrome / Chromium | the renderer itself | No frames. |
| `git` | **REQUIRED** | any | stage-boundary commits ([SPEC](./SPEC.md) S4), gold history | Reviews cannot be tied to a revision. |
| GPU with a working driver | OPTIONAL | any | hardware WebGL rasterisation | Software rendering (SwiftShader / WARP / llvmpipe): working figure **~10× slower**; measure per machine (§5.3). |
| Hardware encoder | OPTIONAL | passes a probe | faster H.264/HEVC encode | Software `libx264`; at 1080p the cost is minutes, not hours. |
| `librosa` | OPTIONAL | 0.10+ | tempo/beat tracking, vocal-band onsets, alignment | `cvpw analyze` falls back to the numpy onset-envelope path: cruder beats, more by-ear cue curation. |
| `librosa`-class alignment models | OPTIONAL | any | forced alignment of known lyrics | Lyric timing rests on LRC timestamps plus vocal onsets, and stage 2's ±150 ms tolerance is harder to hold. ASR word timings MUST NOT be substituted (they run 40 ms–2 s early). |
| Playwright | OPTIONAL | any | convenience driver, tracing, browser download | The CLI drives the browser over raw CDP with zero dependencies: implementation surface, not capability. |
| Blender | OPTIONAL | any | 3D asset generation (stage 4, phase 2) | Code-only and 2D films are unaffected; `assets: null` skips stage 4 without a warning. |
| Image generator | OPTIONAL | any | asset generation (stage 4, phase 2) | Stage 4 cannot generate; procedural films are unaffected. |

## 3. The reference machine (measured)

Probed 2026-01 on the machine the framework was developed against. Reported as evidence: adopt the
method, not the numbers.

| Probe | Result |
|---|---|
| OS / console | Windows; console output encoding reports `utf-8`, **active code page 936 (GBK)**; ANSI code page 936 |
| CPU / RAM / GPU | Intel i3-10105F, 4C/8T · 16 GB · NVIDIA GTX 1050, 2 GB VRAM, driver 32.0.15.6094 |
| Disk free on `F:` | 29.2 GB |
| Node / pnpm / npm | v24.14.1 · 11.22.0 · 11.11.0 |
| Python | 3.13.5 (a 3.13t build is also present); `python -m venv` works; pip 25.1.1 |
| ffmpeg | 8.0.1 full build at `D:\Program Files\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe`; `ffprobe` present |
| Encoders **listed** | `libx264`, `prores_ks`, `libvpx-vp9`, `mjpeg`, `aac`, `libopus`, `pcm_s16le`, `h264_nvenc`, `hevc_nvenc` |
| `h264_nvenc` **working?** | **NO** — a 5-frame encode exits with code **-40** (§5.2). Listed but broken. |
| Hardware-accel methods reported | `cuda vaapi dxva2 qsv d3d11va opencl vulkan d3d12va amf` |
| Browser | Edge 155.0.4283.45 at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. **No Google Chrome installed.** |
| Headless Edge | `--headless=new --screenshot=<png> file:///…` produced a valid PNG (~6 s cold, ~3 s warm); `--remote-debugging-port=0` writes `DevToolsActivePort`, so raw CDP is a dependency-free capture transport |
| Real WebGL renderer | `ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 (0x00001C81) Direct3D11 vs_5_0 ps_5_0, D3D11)` — hardware, not software |
| Not installed | `uv`, `deno`, `bun`, Playwright (no browser cache); Rust / Go / MSVC present but unused by v1 |
| Python wheels | `pip install numpy soundfile` succeeded in 14 s (numpy 2.5.4, soundfile 0.14.0); `librosa` 1.0.0 available |
| MSVC | Visual Studio 2026 at `D:\Program Files\Microsoft Visual Studio\2026` (2022 also present) |

### 3.1 Three findings that changed the design

1. **NVENC is listed and does not work.** `ffmpeg -encoders` advertises `h264_nvenc`; a real encode
   dies with exit `-40`, because the driver exposes NVENC API 12.2 while ffmpeg 8.0.1 requires 13.0
   (stderr: *"The minimum required Nvidia driver for nvenc is 570.0 or newer"*). **Forced:** encoders
   are chosen only after a passing probe judged by exit code, with a software fallback and deletion of
   any output written before the failure ([SPEC](./SPEC.md) P6,
   [ADR 0006](./adr/0006-probe-hardware-encoders-never-assume.md)).
2. **The console lies about its own encoding.** `chcp` answers `936`, `[Console]::OutputEncoding`
   answers `utf-8`, and the ANSI code page is 936. Two answers to "what encoding is this console" is
   the whole hazard: a process that trusts the second writes text the first mangles. **Forced:** UTF-8
   on every handle, never inherited ([SPEC](./SPEC.md) P4,
   [ADR 0005](./adr/0005-utf8-discipline-on-a-cp936-host.md), §6).
3. **Edge only, no Chrome.** Any script assuming a `chrome` binary or a fixed channel finds nothing
   here. **Forced:** discovery across names and install locations, `CVPW_BROWSER` /
   `CVPW_BROWSER_CHANNEL` overrides, and a capture path (raw CDP over a loopback socket) that needs no
   driver package.

## 4. Environment variable overrides

Every override is read once at startup and echoed by `cvpw env --json`, so a report can be traced back
to the tools that produced it.

| Variable | What it changes | Default | Why it exists |
|---|---|---|---|
| `CVPW_FFMPEG` | ffmpeg executable path | `ffmpeg` on `PATH`, then well-known locations | Machines carry several builds (one with `prores_ks`, one without); choose deliberately, not by `PATH` order. |
| `CVPW_FFPROBE` | ffprobe executable path | same directory as ffmpeg, else `PATH` | ffprobe MUST come from the same build; mismatched builds report frame counts that disagree with the encoder. |
| `CVPW_PYTHON` | interpreter for `python/` scripts | `python`, else `python3` on `PATH` | Projects pin a venv; a machine with 3.13 and 3.13t installed MUST be able to say which. |
| `CVPW_BROWSER` | browser executable path | discovered across `msedge`/`chrome`/`chromium` and well-known install directories | The reference machine has Edge and no Chrome ([SPEC](./SPEC.md) P5). |
| `CVPW_BROWSER_CHANNEL` | browser family / flag set (`msedge`, `chrome`, `chromium`) | inferred from the resolved executable name | Flag sets differ (`--headless=new` is Chromium-family), and a wrong channel yields a black frame rather than an error. |
| `CVPW_TMP` | temp root for browser profiles, ffmpeg intermediates, frame sequences. **MUST be ASCII-only** | OS temp if ASCII, else `<project>/.cvpw-tmp` | A non-ASCII temp path can break browser profile creation or reach ffmpeg as a mangled argument ([SPEC](./SPEC.md) P4, §6). |
| `CVPW_WORKERS` | default worker count when `--workers` is absent | `project.json::render.workers` (2 in the template) | Caps a render on a weak machine without editing the project. Ceiling `min(16, logicalCPUs − 2)`. |
| `PYTHONUTF8=1` | Python UTF-8 mode: file handles, stdio, filesystem encoding | unset (platform default, i.e. the code page) | Set by the CLI when spawning Python; removes the code-page default from every path at once. |
| `PYTHONIOENCODING=utf-8` | Python stdio encoding | unset | Belt and braces: a child that re-execs or reads a config still cannot print GBK. |

An override naming a missing file, or an executable that fails its version probe, MUST make `doctor`
exit non-zero rather than fall back silently. A silently ignored override makes the report a lie.

## 5. How `doctor` probes

### 5.1 Tool discovery order

`CVPW_*` override → `PATH` → well-known install locations (Windows: `C:\Program Files\…`,
`C:\Program Files (x86)\…`, `%LOCALAPPDATA%\Programs\…`; POSIX: `/usr/local/bin`, `/opt/…`). The
resolved absolute path and version MUST be printed by `cvpw env` ([SPEC](./SPEC.md) P5).

```bash
cvpw doctor [--json]     # machine state; REQUIRED vs OPTIONAL, with the cost of each gap
cvpw env    [--json]     # resolved tool paths, versions, active overrides
```

### 5.2 Hardware encoder probe — judge by EXIT CODE

`ffmpeg -encoders` is **not** evidence: it reports what the build was compiled with, not what the
driver can initialise. The probe MUST attempt a real encode and judge the process exit code:

```bash
ffmpeg -hide_banner -f lavfi -i testsrc2=size=320x240:rate=30 -frames:v 5 -c:v h264_nvenc -f null -
```

On the reference machine this exits **`-40`** (`Function not implemented`), with stderr naming the
cause: *"Driver does not support the required nvenc API version. Required: 13.0 Found: 12.2"*. A POSIX
shell reports the same failure as `216` (exit codes are truncated modulo 256), which is why the rule is
"any non-zero exit fails the probe", never "look for `-40`".

1. At most 5 frames, `320×240`, `-f null -` so the probe writes nothing.
2. Non-zero exit → the encoder is **unavailable**; record the exit code and the first stderr line.
3. If the probe wrote a real file, delete it on failure — a half-written file that looks plausible is
   exactly what [SPEC](./SPEC.md) P6 forbids.
4. Fall back to software (`libx264`) and record `codecRequested` vs `codec` in `render/report.json`.
5. `doctor` MUST NOT report "NVENC available" where the probe failed.

### 5.3 Headless browser and the real WebGL renderer

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
  --headless=new --no-sandbox --disable-gpu-sandbox --dump-dom "file:///C:/cvpw-probe/webgl.html"
```

```html
<html><body><canvas id=c></canvas><script>
var g = document.getElementById('c').getContext('webgl');
var d = g && g.getExtension('WEBGL_debug_renderer_info');
document.title = document.body.textContent = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : (g ? 'no-debug-extension' : 'no-webgl');
</script></body></html>
```

Measured here: `ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 (0x00001C81) Direct3D11 vs_5_0 ps_5_0, D3D11)`.

`doctor` MUST report the renderer string from a **real headless probe**, not the GPU name from the OS.
A software renderer — `Google SwiftShader`, `ANGLE (Microsoft Basic Render Driver …)`, a `WARP`
string, or `llvmpipe` — MUST be reported as a **warning with its measured cost**, not hidden
([WORKFLOW](./WORKFLOW.md) stage 0). The working figure is **~10× slower**: measure it on the machine
in question by timing one still with and without the forced software path, and put both numbers in the
report. `render/report.json::software` MUST be `true` whenever a render ran on a software renderer.
Also measured here, and the reason capture is dependency-free:

```bash
msedge --headless=new --screenshot=<out.png> --window-size=1920,1080 "file:///…/index.html"  # valid PNG
msedge --headless=new --remote-debugging-port=0 "file:///…/index.html"                       # writes DevToolsActivePort
```

### 5.4 What `doctor` must always report

REQUIRED items with resolved path, version and comparison against the minimum; OPTIONAL items with the
cost of each gap; the real WebGL renderer and whether it is hardware or software; encoder verdicts by
probe with failure exit codes; free disk on the project drive against `budgets.peakDiskGb`; Python
wheels probed by **import**, not by `pip list`; whether the effective temp directory is ASCII-only.
Exit codes follow [SPEC](./SPEC.md) P1: `0` ok, `1` a check failed, `2` bad usage.

## 6. The CP936 hazard

**Measured.** `chcp` prints `936` while `[Console]::OutputEncoding` prints `utf-8`, and the ANSI code
page is 936. Text reaching a file, pipe or child process through a path that trusts the *second* answer
is written as GBK; UTF-8 text reaching a path that trusts the *first* is read as GBK.

**The hazard is present in this checkout, not theoretical.** A sample file shipped under `reference/`
demonstrates it now:

```text
file   : reference/dalabengba-mv/复现全流程.md      (valid UTF-8 on disk — bytes verified)
UTF-8  : # 《达拉崩吧》纸艺 RPG 代码 MV —— 完全复现手册
CP936  : # 銆婅揪鎷夊穿鍚с€嬬焊鑹?RPG 浠ｇ爜 MV 鈥斺€?瀹屽叏澶嶇幇鎵嬪唽
```

The file is not damaged; the **path through the console** is. Two further demonstrations from the same
session: `certutil`'s own localized success line arrives as mojibake in a console that believes it is
UTF-8, and `python -c "print(<the CP936 line above>)"` dies with
`UnicodeEncodeError: 'gbk' codec can't encode character '\u20ac'` unless `PYTHONUTF8=1` /
`PYTHONIOENCODING=utf-8` is set. Treat every console as hostile; say what you mean on every handle.

1. **Every Python file handle specifies UTF-8** — `open(p, encoding="utf-8")`,
   `Path.read_text(encoding="utf-8")`, `sys.stdout.reconfigure(encoding="utf-8")`. Never rely on the
   platform default and never pass `errors="replace"`: a replacement character destroys the evidence.
2. **Set `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` when the CLI spawns Python** (§4), and **run
   `chcp 65001`** in any generated Windows shell helper before it reads or writes text.
3. **Temp paths handed to external processes are ASCII-only** — browser profiles, ffmpeg
   intermediates, frame sequences (`CVPW_TMP`). A non-ASCII path can break profile creation outright
   and reach ffmpeg as a mangled argument; both failures look like something else.
4. **`cvpw lint` scans for U+FFFD and for bytes that are not valid UTF-8** ([SPEC](./SPEC.md) P4), plus
   BOM and CRLF at stage boundaries ([SPEC](./SPEC.md) A1).
5. **Verify with bytes, never by reading the text** — an editor shows the editor's guess, not the file:

```powershell
python -c "import sys,pathlib;b=pathlib.Path(sys.argv[1]).read_bytes();print('bom' if b[:3]==b'\xef\xbb\xbf' else 'no-bom','crlf' if b'\r\n' in b else 'lf','fffd' if b'\xef\xbf\xbd' in b else 'no-fffd');b.decode('utf-8');print('valid utf-8')" <file>
certutil -dump <file>          # hex dump: look for 'ef bf bd' (U+FFFD) or a leading 'ef bb bf' (BOM)
```

6. **Never repair mojibake by re-typing the text.** Two of three repair attempts produce valid UTF-8
   that says the wrong thing. Find the handle that wrote it, fix the handle, and regenerate the file
   from its declared inputs ([SPEC](./SPEC.md) A6).

## 7. Portable setup recipe

```bash
# 1. Node >= 20 and pnpm
node -v && corepack enable && corepack prepare pnpm@11 --activate
# 2. Python environment (numpy + soundfile are the analysis floor; librosa is optional)
python -m venv .venv && .venv/Scripts/python -m pip install -U pip numpy soundfile
set CVPW_PYTHON=%CD%\.venv\Scripts\python.exe      # export CVPW_PYTHON=… on POSIX
# 3. ffmpeg + ffprobe from the same build, on PATH or via override
ffmpeg -version && ffprobe -version
set CVPW_FFMPEG=D:\Program Files\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe
# 4. A Chromium-family browser (Edge counts); only needed if discovery fails
set CVPW_BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set CVPW_TMP=C:\cvpw-tmp                           # ASCII-only, and it must exist
# 5. Toolchain, and version control from the first commit
pnpm install && pnpm -C packages/cli build && pnpm link --global && git init
# 6. Acceptance test for the whole machine
cvpw doctor
```

Expected `doctor` output on a healthy machine (illustrative shape; the `--json` envelope is the
contract, and the REQUIRED/OPTIONAL split, the real renderer and the encoder verdict are the
load-bearing fields):

```text
REQUIRED   node 24.14.1 ok (>= 20)     pnpm 11.22.0 ok
           python 3.13.5 ok (>= 3.10)  C:\…\.venv\Scripts\python.exe
           ffmpeg 8.0.1 ok  D:\…\ffmpeg.exe   ffprobe 8.0.1 ok  D:\…\ffprobe.exe
           browser Edge 155.0.4283.45 ok  C:\…\msedge.exe   git present ok
OPTIONAL   gpu present  NVIDIA GeForce GTX 1050, 2 GB
           webgl renderer ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 …, D3D11)  hardware
           h264_nvenc UNAVAILABLE (probe exit -40) -> software libx264
           hevc_nvenc UNAVAILABLE (probe exit -40) -> software libx265
           librosa present 1.0.0   playwright absent -> raw CDP capture, no browser cache
           blender absent -> asset generation unavailable (code-only film unaffected)
DISK       project drive free 29.2 GB   budgets.peakDiskGb 5   ok
TMP        C:\cvpw-tmp   ASCII-only   ok
doctor: ok
```

A machine that cannot produce this output has an environment problem, and every later failure will be
harder to read because of it.

## 8. Failure playbook

| Symptom | What it looks like | Measure | Fix |
|---|---|---|---|
| Missing ffmpeg | `ffmpeg not found`; `doctor` exits 1; render writes no MP4 | `cvpw env --json` → `ffmpeg.path` null | Install a full build, put it on `PATH`, or set `CVPW_FFMPEG`; re-run `doctor`. |
| NVENC reported available but failing | Encode dies after a few frames, exit `-40`; zero-byte or truncated MP4 may remain | The §5.2 probe by exit code; `codec` vs `codecRequested` in `render/report.json` | Never trust `-encoders`; delete the failed output; render with `libx264`; record the reason. |
| Software WebGL fallback | Correct but absurdly slow; frames differ from a GPU machine's | Renderer string; `render/report.json::software`; one still timed with and without the software path | Fix driver/flags before rendering at volume; accept only with the measured cost written down. |
| Playwright browsers not downloaded | `Executable doesn't exist at …ms-playwright…` | `npx playwright install --dry-run`; the Playwright cache directory | `playwright install chromium`, or use the built-in raw-CDP path — Playwright is OPTIONAL. |
| Non-ASCII path breaks a profile or an argument | Browser starts and writes nothing; ffmpeg reports a bogus filename; empty frame sequence | `cvpw env --json` → `tmp`; byte-inspect the failing argument | Set `CVPW_TMP` to an ASCII-only path; never "quote harder" — the argument is already mangled. |
| Disk exhaustion during a render | Write errors mid-sequence; `render/report.json::errors`; a plausible but short MP4 | Free space vs `budgets.peakDiskGb`; `frames × measured frame bytes` ([QA](./QA.md) §2.2) | Free space or lower the budget; render `--only <block>`. 29.2 GB free is enough for a 1080p image-sequence render, not for a careless one. |
| Stale headless browser holding a port | Next run hangs, or attaches to an old page and renders a stale frame | `Get-Process msedge` / `ps`; `DevToolsActivePort`; the listening port | Kill the orphan; give each run its own profile directory under `CVPW_TMP`. |
| Python wheel missing (offline machine) | `ModuleNotFoundError: numpy` from `cvpw analyze`, while `pip list` in another interpreter looks fine | Which interpreter `CVPW_PYTHON` resolves to; `python -c "import numpy, soundfile"` | Install from a local wheel cache; record the gap in `docs/PROGRESS.md`; expect the degraded analysis path. |

## 9. What this machine cannot do

- **No hardware encoding.** `h264_nvenc` and `hevc_nvenc` are listed and both fail their probe
  (exit `-40`; driver NVENC API 12.2 vs required 13.0). Every deliverable is encoded by `libx264`: at
  1080p minutes of CPU per pass, at 4K the bottleneck of the pipeline.
- **2 GB VRAM.** A 4K RGBA frame is 3840 × 2160 × 4 B ≈ **33 MB** before any render target or
  intermediate pass, so post-processing chains exhaust it quickly. This is also why frames go to disk
  rather than through a memory buffer ([ADR 0004](./adr/0004-filesystem-frame-transport-first.md)).
- **16 GB RAM, 4C/8T.** Each worker is a browser plus its own buffers: the ceiling here is
  `min(16, 8 − 2)` = **6**, and the template's `render.workers: 2` is the right default. More workers
  make a render slower, not faster.
- **29.2 GB free on `F:`** against a default `budgets.peakDiskGb` of 5: comfortable for a 1080p JPEG
  image sequence of a few thousand frames, not for 4K or PNG sequences. Measure frame bytes
  (`render/report.json`), then apply the peak-disk rule in [QA](./QA.md) §2.2.
- **Consequence.** 1080p30 is this machine's working resolution; 4K is a deliberate, measured decision
  with a disk and time budget attached, and large worker counts are a way to make a render slower.
