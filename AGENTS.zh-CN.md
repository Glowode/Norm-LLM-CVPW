# AGENTS.md —— 从这里开始

**面向任何平台的任何编码 Agent。** 人类入口：[`README.zh-CN.md`](./README.zh-CN.md)。
英文正文（规范版本）：[`AGENTS.md`](./AGENTS.md)。

本仓库是一个**框架**，不是一部片子。你来这里通常是为了下面三件事之一：

| 你的任务 | 起点 | 然后 |
|---|---|---|
| **A. 用这个框架做一部视频** | §3 快速开始 | [`skills/cvpw/SKILL.md`](./skills/cvpw/SKILL.md) |
| **B. 扩展框架**（新场景、风格、产物契约、检查项、工具） | [`docs/EXTENDING.md`](./docs/EXTENDING.md) | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| **C. 在别人已经搭好的项目里工作** | 该项目的 `docs/BRIEF.md` | 该项目的 `docs/PROGRESS.md`，然后看 §4 |

如果你不确定自己在做哪件 —— 那你就是在做 **A** 或 **C**。扩展框架是一个**决定**，永远不是默认行为，
也**永远不是**解决项目问题的办法。

---

## 1. 优先级顺序（自上而下消解冲突；消解不了就停下）

```
1. docs/SPEC.md                 宪法 —— 高于一切
2. docs/CONTRACTS.md            产物契约 + 时间词汇表的定义
3. schemas/*.schema.json        (2) 的机器可读形式
4. docs/WORKFLOW.md  docs/QA.md  docs/EXTENDING.md   流程
5. project.json                 你所在项目的旋钮
6. 生成的产物                     analysis/  cues/  timeline.json  报告
7. 代码                          engine/  scenes/  tools/
8. 散文式文档                     README  BRIEF  STORYBOARD  笔记
```

**代码与文档冲突规则。** 第 1–4 层是**规范性**的：代码若与它们冲突，错的是代码。
第 7–8 层是**描述性**的：散文文档若与代码冲突，错的是**文档** —— 在同一次改动里把文档改对。
永远不要单方面相信其中一边。如果你判断不出该套用哪一层，**停下来问**。

---

## 2. 最重要的十二条规则

动手前先读。每一条之所以存在，都是因为一种具体的失败被真实观察到过 —— 括号里是推理出处。

1. **一帧是 `t` 的纯函数。** 禁止 `Math.random`、`Date.now`、`new Date`、`performance.now`、
   `crypto.getRandomValues`、`requestAnimationFrame`、`setTimeout`，也禁止在帧之间保存状态。
   所有随机性来自 `@cvpw/kernel` 的种子生成器。（`docs/SPEC.md` D1–D3）
2. **永远不要手写秒数。** 用时间表达式 —— `"b(32,0)"`、`"cue('chorus')"`、`"VOX('sudden')"`、
   `"L(12)"`。时间基准支撑不了的引用就是**错误**，而这正是重点。它若抛错，
   去修音乐分析或分镜 —— **绝不**去改那个表达式。（`docs/SPEC.md` T2–T3）
3. **`bpm` 是标签，不是网格。** 剪辑点只能来自实测的 `beats[]`/`bars[]`，
   绝不能来自 `n * 60 / bpm`。速度是会漂的。（`docs/SPEC.md` T4–T5）
4. **既不在网格上、也不是 cue id 的时间，不属于代码。** 把它注册成 cue，并标注 `source`。
   （`docs/SPEC.md` T8）
5. **未知产物键会被拒绝，解析不了的时间会抛错。** 这是刻意的。
   不要加回落，不要 catch 后给默认值，不要「先让它跑起来」。如果你很想那么做，回去重读第 2 条：
   参考项目里每一个静默回落，都让人付出了一天的代价。
6. **每一个结果都要亲眼看。** 出静帧、读 PNG、像艺术指导那样挑毛病、修、再来一遍。
   不要相信「代码应该是对的」。`review/report.json` 里没有清单的「审阅」不算审阅。（`docs/SPEC.md` V1–V3）
7. **一个块只有一个负责人，文件互不重叠。** 共享文件 —— `engine/core`、`engine/lib`、
   `timeline.json`、`handoff.json`、风格、`project.json` —— 属于集成负责人。
   你需要改共享文件时，写进 `docs/INTEGRATION_NOTES.md` 提出需求，**不要**自己动手。（`docs/SPEC.md` S1–S2）
8. **尽早写盘，并记进度日志。** 长任务会被打断。接手时：先看盘上有什么，
   先跑对应检查，**再**决定要不要重跑。（`docs/SPEC.md` S3）
9. **每一处偏离都要连理由写进** `docs/PROGRESS.md`。**没被写下来的偏离与 bug 无法区分**，
   下一个 Agent 要么重犯，要么把你刻意的决定当作错误「修掉」。（`docs/SPEC.md` §10）
10. **一律严格优于宽容。** 偶数分辨率、无 BOM 的合法 UTF-8、LF 换行、字幕在安全区内、
    文本只能来自白名单、每个镜头都要有 `moment`。这些现在很便宜，以后很贵。（`docs/SPEC.md` A1、C3、C6–C8）
11. **测量，不要猜。** 单帧耗时、闪光频率、音视频偏移、接缝差值 —— 报出数字和它的来源。
    阈值只存在于 `docs/QA.md` 或 `project.json::budgets`；**永远不要**在代码里临时发明一个。（`docs/SPEC.md` V5）
12. **宁可有记录的豁免，也不要静默的容忍。** 豁免需要日期、理由和责任人，并且会出现在交付报告里。
    永远不要「重试到它过为止」。（`docs/SPEC.md` V6）

---

## 3. 快速开始 —— 做一部视频

```bash
cvpw doctor                                   # 这台机器能做什么、不能做什么。读它。
cvpw new ../my-film --song song.wav --lyrics lyrics.txt
cd ../my-film
```

然后按八个阶段走。**每个检查点都要停下来给人看东西。**

```
阶段 0  环境      cvpw doctor ; cvpw validate
阶段 1  任务书    写 docs/BRIEF.md、docs/CONCEPT.md、project.json::textWhitelist
                                                               ◆检查点：用六行字讲清任务书
阶段 2  时间基准  cvpw analyze  →  去看 analysis/overview.png
                  cvpw cues ; cvpw lyrics                       ◆检查点：总览图 + 段落标注
阶段 3  分镜      cvpw storyboard  →  timeline.json + docs/STORYBOARD.md
                  在开始写块之前，先把接缝注册进 handoff.json
                                                               ◆检查点：分镜表
阶段 4  素材      cvpw assets（校验清单；生成属于第二阶段）
阶段 5  构建      写场景 → cvpw lint ; cvpw check --scenes
阶段 6  审阅      cvpw stills --overlay ; cvpw sheet --cues ; 每一张图都看
                                                               ◆检查点：第一批静帧
阶段 7  交付      cvpw handoff ; cvpw render ; cvpw check ; cvpw deliver
```

每个阶段的细节、验收标准与失败模式见 [`docs/WORKFLOW.md`](./docs/WORKFLOW.md)。

**阶段 2 决定成败。** 打开 `analysis/overview.png` 认真读它 —— 波形、能量、拍线、段落边界。
速度的八度错误（拍率算成两倍或一半）是最常见的分析失败：在图上非常明显，在 JSON 里完全看不见。

---

## 4. 在项目里工作

按这个顺序读：`docs/BRIEF.md` → `docs/CONCEPT.md` → `docs/BLOCKS.md` → `docs/PROGRESS.md` →
`docs/INTEGRATION_NOTES.md`。这一串告诉你意图、分块、已经做完了什么、以及已经争论过什么。
跳过它，就是两个 Agent 把同一件事做两遍的方式。

**动手前：**

- `cvpw validate` —— 拒绝在非法产物上继续构建。
- `cvpw lint` —— 先知道基线状态，再往上加。
- 在 `docs/BLOCKS.md` 里找到你的块。**你的文件就是它列出的那些，别的都不是。**

**写的时候：**

- 从第一次提交起就维护这块的进度日志。
- 只渲染你自己的范围：`cvpw render --only <block>`、`cvpw stills --times ... --shot <id>`。
- 给你创建的每个镜头写 `moment`：一句话，这个镜头是**为了什么**。

**声称完成之前：**

- `cvpw lint` 干净，`cvpw validate --all` 通过。
- `cvpw check --scenes` 报告零错误、零空帧。
- 你**看过**静帧 —— 每刀切进后的第一帧、主要事件那一帧、结束前的最后一帧 ——
  至少两轮，并写下你看到了什么、改了什么。
- 未触碰的范围在数值上仍然一致（`cvpw check --gold`）。你的改动**不能**给别人那段的画面重新定调。

---

## 5. Skills

框架面向 Agent 的能力以可移植的 Skill 包形式提供：一个目录，含 `SKILL.md`
（YAML frontmatter，只有 `name` + `description`）、`references/`，以及作为 `cvpw` 薄封装的 `scripts/`。
它们在没有 Node 工程的环境下也能用 —— 一个封装脚本可以**打印**命令而不是执行它。

| Skill | 何时用 |
|---|---|
| [`skills/cvpw`](./skills/cvpw/SKILL.md) | 任何视频制作工作。八个阶段、原则、检查点纪律、并行与归属规则。 |
| [`skills/cvpw-timing`](./skills/cvpw-timing/SKILL.md) | 从音频得到时间基准；歌词定时；带来源的提示点维护；一切「什么时候」的问题。 |
| [`skills/cvpw-qa`](./skills/cvpw-qa/SKILL.md) | 门禁、阈值、审阅循环、失败模式目录、交付清单。 |

**装进你的平台：**

- 有 skills 目录的平台（如 `~/.claude/skills/`）：复制或软链该 bundle 目录。
- 不支持 skill 的平台：直接读 `SKILL.md` —— 它就是普通 Markdown 加脚本。
  本文件加上 skill 的 `references/` 已经足够。
- `cvpw skill install --target <claude|dsh|generic>` 会执行复制并打印目标路径。

如果某个 `SKILL.md` 的 `description` 看起来跟你的任务不匹配，**也先读它的 `references/`** 再下结论 ——
skill 知道自己的哪些参考文档有用，而你现在还不知道。

---

## 6. 命令

每个命令：`--json` 在 stdout 打印**一个** JSON 信封；日志走 stderr；
退出码为 **0** 通过、**1** 检查失败、**2** 用法错误、**3** 契约违规。

| 命令 | 作用 |
|---|---|
| `cvpw doctor` | 机器就绪度。区分必需/可选，并说明每项缺失的代价。会探测浏览器**真实的** WebGL 渲染器，并**通过真的编码一次**来探测硬件编码器。 |
| `cvpw env` | 解析后的外部工具路径与版本。 |
| `cvpw new <dir>` | 从 `templates/project` 生成项目。目标非空则拒绝（除非 `--force`）。 |
| `cvpw validate [--all]` | 对所有产物做 JSON Schema 校验。 |
| `cvpw analyze` | 音频 → `analysis/audio.json` + `envelope.json`/`.f32` + `overview.png`。 |
| `cvpw cues` | 把提示点猜测归位到实测起音上。**永不**覆盖 `source: manual` 的 cue。 |
| `cvpw lyrics` | LRC 或纯文本 → 歌词定时（以及文本，如果决定保留）。 |
| `cvpw storyboard` | 生成 `timeline.json` + `docs/STORYBOARD.md`；解析每个时间表达式；检查覆盖度。 |
| `cvpw assets` | 校验 `assets/manifest.json`（生成属于第二阶段）。 |
| `cvpw stills` / `sheet` / `review` | 审阅产物。`--overlay` 把时间、帧号和活动镜头 id 烧进画面，让缺陷能直接对应到镜头。 |
| `cvpw render` | 逐帧 → MP4 + `render/report.json`。支持 `--workers`、`--only`、`--preview`。 |
| `cvpw check` | 门禁套件：`--frames`、`--av-sync`、`--gold`、`--flash`、`--scenes`。 |
| `cvpw lint` | 静态审计：禁用 API（基于 AST）、编码、绝对时间、坐标字面量、文本白名单。 |
| `cvpw handoff` | 接缝 `A\|REF\|B` 对照条与数值评级，写入 `handoff.json::measured`。 |
| `cvpw deliver` | 最终检查、多版本、交付清单。 |
| `cvpw skill install` | 把 Skill 包安装到某个平台。 |

---

## 7. 出问题时怎么办

| 情况 | 这么做 |
|---|---|
| 某个时间表达式抛错 | 时间基准里**确实**没有那个时刻。去修分析、cue 表或分镜。**绝不**把它换成一个字面秒数。 |
| 门禁失败 | 读 `--json` 输出里的 offenders。查根因。不要重试，也不要在代码里放宽阈值。 |
| 你确实需要改阈值 | 改 `project.json::budgets` 或 `docs/QA.md`，并在 `docs/PROGRESS.md` 里说明理由。 |
| 你想动共享文件 | 你多半不需要。把需求记进 `docs/INTEGRATION_NOTES.md`；如果你是集成负责人，就动手并写清楚。 |
| 画面很闷但检查全过 | 这不是渲染 bug。回到阶段 1 或 3 —— 看那些 hold、那股递进、那些 `moment` 句子。 |
| 渲染没出东西 / 文件小得可疑 | 渲染器失败时必须删掉自己的输出。相信任何文件之前，先看 `render/report.json` 里的 `errors`。 |
| 你接手了一个被中断的块 | 读这块的进度日志，先跑 `cvpw check --only <block>`，**然后**再继续。 |

---

## 8. 语言与编码

- **英文是规范语言**，适用于 `docs/SPEC.md`、`docs/CONTRACTS.md`、schema、代码与提交信息。
  面向人的入口文档提供中文镜像；**镜像漂移就是镜像的 bug**。
- **UTF-8、无 BOM、LF 换行，处处如此。** 本参考机的控制台活动代码页是 **936**，
  它会很乐意地把你的输出搞成乱码。Python 的文件句柄显式写 `encoding="utf-8"`；
  CLI 在启动 Python 时设置 `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8`；
  生成的 Windows 辅助脚本会 `chcp 65001`；交给外部进程的临时路径**只含 ASCII**。
  `cvpw lint` 会扫描 U+FFFD 以及一切非法 UTF-8 字节。
  （[`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md)，ADR 0005）
- **默认不要提交媒体与歌词文本。** 音频和歌词输入属于用户。歌词**定时**可以提交，
  歌词**文本**不可以 —— 除非项目明确声明其具备分发许可。（`docs/SPEC.md` T7）
