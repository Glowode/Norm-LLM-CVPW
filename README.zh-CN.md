# Norm-LLM-CVPW

**规范化、平台无关的「代码化视频制作」框架。**

> Normalized, agent-agnostic framework for producing video from code.

Agent 读一份任务书、一首歌和一组契约，就能把一个空目录推进到经过验证的成品交付 —— 只依靠本仓库里的
文件和一条命令行。每个阶段的边界都是一个带版本的产物；每一帧都是时间的可复现函数；每一个审美选择都是
**注册**进去的，而不是硬编码的，因此框架是**积累**能力，而不是堆积补丁。

**文档语言：** 本文件是 [`README.md`](./README.md) 的中文镜像；[`AGENTS.md`](./AGENTS.md) 的镜像见
[`AGENTS.zh-CN.md`](./AGENTS.zh-CN.md)。**英文是规范语言**（见 [`docs/SPEC.md`](./docs/SPEC.md) §8 P3）。
按 [SPEC](./docs/SPEC.md) 的说法：**镜像一旦与正文漂移，那就是镜像的 bug**。除入口文档外，其余文档均为英文。

---

## 为什么要有这个框架

用代码做视频这件事，已经被人和 Agent 反复做得很好了 —— 但每一次，最有价值的部分都被丢掉了。
[`reference/`](./reference) 里有六个很强的参考项目（署名见下方表格）。每个都解决了问题的一部分，
也每个都撞上了同一批墙：

| 墙 | 实际表现 | 本框架的处理 |
|---|---|---|
| **契约静默漂移** | JSON 字段改名后消费者无声失败；键名拼错会悄悄回落到默认值；文件缺失只打一行警告就渲染出一部没有相关图层的片子。六个项目**都没有**正式的 schema。 | `schemas/` 是规范性的。每个产物都带 `$schema` + `schemaVersion`，未知键直接拒绝，任何阶段都不允许在非法输入上运行。 |
| **时间会漂** | 一个不在网格上的时间被手写死，之后重新分析音频、音乐位置变了，这一刀就不再落在拍上。有项目为此专门写了一个工具去测量自己的提示点漂了多远；还有项目因为没测出拍相位，干脆禁止了逐拍卡点。 | 时间是**表达式**而不是数字（`"b(32,0)"`、`"cue('chorus')"`、`"VOX('sudden')"`），对时间基准求值，**音乐支撑不了的引用直接报错**。 |
| **确定性只是口号** | 「画面是 `t` 的纯函数」被写成规则，执行手段最多是一个能被别名绕过的正则扫描，写在只有作者那台系统能跑的 shell 脚本里。 | 三层：基于 AST 的静态分析器、内核里的种子化随机数、外加带日期豁免清单的帧哈希门禁。 |
| **假设硬件一定可用** | 编码器选择直接信任 `ffmpeg -encoders`。而在本参考机上 `h264_nvenc` **被列出但实际失败**（退出码 `-40`）。 | 编码器**靠真的编码一次来探测**，失败就回落；渲染失败会删掉输出文件，因此被截断的文件**不可能**看起来像是成品。 |
| **没有可看的东西** | 验证方式确实是「每一帧结果都要亲眼看」—— 这是对的，但没有任何产物告诉 Agent **该看哪几帧**、**那一帧里什么在活动**。 | `cvpw review` 产出逐提示点缩略图、逐镜头条带（把活动镜头 id 烧进画面）、以及一份机器可读的「该看哪些图」清单。 |
| **扩展等于动手术** | 一个新的视觉想法需要修改共享的 timeline 或引擎文件 —— 而那正是并行作者相撞的地方。 | 场景、风格、传输、检查项都是**注册**进去的。新增一个 = 一个文件 + 一行清单。 |

这个框架不是渲染器，也不是一门语言。它是**能活下来的那部分**：契约、门禁，和一套会大声失败的词汇表。

---

## 安装

```bash
git clone <本仓库> Norm-LLM-CVPW
cd Norm-LLM-CVPW
pnpm install
pnpm build
node packages/cli/bin/cvpw.mjs doctor
```

`doctor` 是这台机器的验收测试。它区分 **必需** 与 **可选**，并说明每一项缺失的代价。
在本参考机上，它会报告：**NVENC 存在但不可用**、本机唯一的浏览器是 Microsoft Edge、
控制台活动代码页是 936 —— 这三个发现各自改变了设计（见
[`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md)）。

## 做点东西

```bash
cvpw new ../my-film --song song.wav --lyrics lyrics.txt
cd ../my-film
cvpw analyze                                   # → analysis/audio.json + analysis/overview.png
#   去看 analysis/overview.png。在你亲眼看过之前，不要相信那个拍网格。
cvpw cues                                      # 把提示点猜测吸附到实测起音上
cvpw storyboard                                # → timeline.json + docs/STORYBOARD.md
cvpw stills --times 1,3.5,8 --overlay          # → review/stills/*.png   （去看）
cvpw sheet --cues                              # → review/cues.jpg       （每个提示点一帧）
cvpw render --workers 2                        # → render/my-film.mp4
cvpw check; cvpw deliver
```

Agent 请从 [`AGENTS.zh-CN.md`](./AGENTS.zh-CN.md) 开始：那里有优先级顺序、检查点纪律，以及
「什么可以碰、什么不可以碰」的规则。

`cvpw check` 跑的是**门禁套件**：12 个开关、24 个检查 id，阈值只在 [`docs/QA.md`](./docs/QA.md) 里定义一次，
边界值在 `project.json::budgets`。`--profile all|render|deliver` 决定跑到哪一层；
`--only <block>` 把整套门禁限制在单个块的时间范围内，让块作者拿到又快又诚实的信号。
同样的门禁走 `cvpw lint` 这条快捷路径时，静态检查的结论必须完全一致。

---

## 八个阶段

```
0 环境 ─▶ 1 任务书 ─▶ 2 时间基准 ─▶ 3 分镜 ─▶ 4 素材 ─▶ 5 构建 ─▶ 6 审阅 ─▶ 7 交付
 setup     brief        timebase     storyboard  assets    build     review    deliver
```

每个阶段的输入、命令、验收标准、失败模式与退路见 [`docs/WORKFLOW.md`](./docs/WORKFLOW.md)。
最关键的三个检查点：**时间基准之后**（网格错了，后面全错）、**分镜之后**、**第一批静帧**。

---

## 仓库地图

```
docs/          SPEC（宪法）· CONTRACTS · WORKFLOW · ARCHITECTURE · EXTENDING · ENVIRONMENT · QA · adr/
schemas/       规范性的 JSON Schema 2020-12 —— 每个产物一个文件
packages/
  kernel/      @cvpw/kernel   浏览器端渲染内核：时间表达式、时间基准、种子随机数、图层、相机、插件注册表
  render/      @cvpw/render   无头抓帧后端：静态服务器、浏览器启动器、帧通道、ffmpeg、编码器探测
  cli/         @cvpw/cli      `cvpw` 可执行文件 —— 17 个命令，每个都有 JSON 信封和有意义的退出码
  runtime/     @cvpw/runtime  不依赖 DOM 的场景/timeline 加载器，让校验与分镜生成能在 Node 里跑
  audit/       @cvpw/audit    AST 确定性与编码分析器
python/        cvpw_py        音频分析、包络、提示点归位（numpy + soundfile；librosa 可选）
skills/        cvpw · cvpw-timing · cvpw-qa   可移植、平台无关的 Skill 包
templates/     project/       脚手架。开箱即可端到端跑通。
examples/      minimal/       已提交的最小竖切，含其产物
tests/         unit/ integration/ e2e/ fixtures/
reference/     六个参考项目，只读。署名见下。
```

新东西该放在哪里：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 里有决策表。
怎么加才不让框架自相矛盾：[`docs/EXTENDING.md`](./docs/EXTENDING.md)。

---

## 原则

以下引自 [`docs/SPEC.md`](./docs/SPEC.md)。这里刻意只做摘要并给出链接 —— 一份会漂移的复述比一个链接更糟。

1. **规范化。** 每个阶段一进一出。跨边界的产物必须有 schema、有版本、有**已记录的失败模式**。
2. **确定性。** 一帧是时间的纯函数（D1）。无墙钟、无未播种随机、帧间无状态（D2–D3）。靠哈希验证，而不是靠期望（D7）。
3. **时间是数据。** 代码里命名的是「哪个时刻」，秒数归时间基准所有；音乐支撑不了的引用是**错误**，不是默认值（T2–T3）。
4. **严格优于宽容。** 未知键拒绝、时间解析不了就抛错、文本缺失就检查失败。参考项目里每一个静默回落，都让人付出了代价。
5. **要证据，不要断言。** 一个阶段完成的标志是：门禁产出了数字，并且 Agent 看过了图（V1–V3）。没有清单的「审阅」不算审阅。
6. **积累靠注册。** 新的视觉想法、外观、传输方式、检查项都注册进既有骨架。骨架不长特例分支。
7. **写明你没做什么。** 每处偏离都连理由记进 `docs/PROGRESS.md`。**没被写下来的偏离，与 bug 无法区分**（SPEC §10）。

---

## 参考项目（Prior art）

这些项目正是本框架存在的原因。它们**只读、只引用、只署名，绝不 import**。

| 项目 | 许可 | 对本框架的贡献 |
|---|---|---|
| [`vocaloid-style-mv-pipeline`](./reference/vocaloid-style-mv-pipeline) | MIT | Skill 打包与渐进式披露；带每阶段交付物与验收标准的分阶段工作流；把 `check_env` 当成一等工具；分层合成器与调色/LUT 体系 |
| [`dalabengba-mv`](./reference/dalabengba-mv) | 见仓库 | 分块并行与两类交接（含共享接缝契约）；规范时间 + 分段线性 warp；lint/冒烟/接缝差分/跳帧检测这套 QA 四件套；面向大规模 Agent 编队的文档驱动契约 |
| [`pdoom-video`](./reference/pdoom-video) | MIT | CTC 强制对齐工具链，以及「发音折算」这一步所换来的音节级时间；自适应逐区块子帧采样；每个产物的来源 `notes` |
| [`world-execute-me-lyric-mv`](./reference/world-execute-me-lyric-mv) | MIT（素材 CC BY-NC-SA） | 帧通道（页面 → socket → 编码器，带 ack 背压）；带来源标注的 cue 注册表；在 Node 里跑真实场景模块生成分镜；瓦片级差分回归；规避版权的「无歌词文本」定时表 |
| [`world-execute-web`](./reference/world-execute-web) | AGPL-3.0 | 音乐支撑不了就抛错的时间词汇表；把「剪辑表」做成数据层；一等公民的 timeline 校验；二进制 float32 特征布局 |
| [`abstract-algebra-promo`](./reference/abstract-algebra-promo) | 见仓库 | 零依赖的 CDP 直连导出 + 严格有序写入，使输出与 worker 数无关；音效清单从画面里**抽取**而不是并行维护 |

`reference/` 下每棵树各自保留其许可证与历史。`packages/`、`schemas/`、`skills/`、`templates/`
中**没有**任何内容是抄来的。

---

## 状态

**v0.1 —— 骨架，还有四肢。** 种子随机数、时间表达式语法、插件注册表、CLI 命令面、schema，以及最小竖切
（合成节拍音轨 → 分析 → 确定性静帧 → MP4 → QA 报告）。阶段 2 在同一套契约上落地，没有破坏任何 v0.1 产物：
程序化资产生成并把哈希写回清单、作为纯函数的抠像、WebGL2 后期链、Blender 桥（发现、版本门禁、批量渲染、
帧采纳），以及"政策 + 抽象识别接缝、不附带任何适配器"的歌词对齐。

**31 道门禁全部实现**，示例可端到端渲染，而用这套框架制作的第一部影片就是它自己的宣传片——140 秒、
4200 帧、已交付，片中每一条主张都指向产出它的那条命令。

已完成、未完成、以及每一处对 SPEC 的偏离，见 [`docs/PROGRESS.md`](./docs/PROGRESS.md) —— 这正是本框架
对使用者的同一套标准。
这正是本框架对使用者的同一套标准。

---

## 许可

MIT，见 [`LICENSE`](./LICENSE)。

框架本身是 MIT 许可；**你用它做出来的片子归你**。整条流水线对你的音频、歌词和素材不主张任何权利——
而且默认情况下它连提交都不会替你提交。
