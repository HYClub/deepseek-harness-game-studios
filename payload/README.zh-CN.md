# DeepSeek Harness Game Studios

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.3.6-orange.svg)
![Agents](https://img.shields.io/badge/agents-49-purple.svg)
![Skills](https://img.shields.io/badge/skills-83-green.svg)
![Hooks](https://img.shields.io/badge/hooks-19-orange.svg)
![Rules](https://img.shields.io/badge/rules-14-blue.svg)
![Port of CCGS](https://img.shields.io/badge/port%20of-CCGS%20v1.1.2-lightgrey.svg)

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[安装](#安装) · [实现状态](#实现状态) · [项目结构](#项目结构) · [测试你的定制](#测试你自己的定制) · [验证](#验证) · [许可证](#许可证)

把一次 DeepSeek Harness 会话变成一间完整的游戏工作室。
**49 个代理。83 个技能。一支协调好的 AI 团队。**

本仓库是 [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)（CCGS）
到 DeepSeek Harness（DSH）的**移植**，不是从零自研：技能、代理、规则、文档都来自上游（MIT）；
DSGS 提供 DSH 原生运行时（Node 钩子、技能生成、机器级安装、插件桥）。

## 你会得到什么

下面的数字都由框架自带的校验命令打印，你可以在任意工作区自己跑一遍：
`node tools/check-dsh.mjs`、`node tools/verify-fidelity.mjs`。

| | |
|---|---|
| **83 个技能** | 上游 78 个全部，加上只在 DSGS 有的 5 个（`/statusline`、`/today`、`/dashboard`、`/update`、`/dsgs-install`）。每个都是斜杠命令。 |
| **49 个代理** | 工作室的角色 —— 设计、美术、音频、叙事、工程、QA、发布、Live Ops —— 每张角色卡带委派约定。 |
| **14 条规则** | 编码与内容标准，上游按路径作用域生效；这里由钩子在每次写入后注入命中的规则原文。 |
| **19 个钩子** | 上游每个钩子（18 个脚本）都有 Node 实现，且全部注册：**0 个待移植**。读、写、两张注册表、提交、推送都有检查。 |
| **引擎** | Godot 4.7、Unity、Unreal 与 **Web** 参考文档（53 份）—— 项目钉的版本就是技能读到的版本。 |
| **工具** | 配置解析、项目状态、状态行、看板、版本提示，以及整套 one-shot 流水线。 |

### 一条命令一件事

| 你说 | 它做 |
|---|---|
| `/start` | 把这个目录初始化成工作室项目，再带你走引导 |
| `/brainstorm` `/map-systems` `/design-system` | 把想法变成系统图与逐节设计文档 |
| `/create-architecture` `/create-epics` `/create-stories` | 架构、epic、以及程序员能直接上手的 story |
| `/team-combat` `/team-level` `/team-narrative` … | 让一个部门围着同一个功能干活 |
| `/playtest-report` `/balance-check` `/qa-plan` | 把反馈与数据变成决定 |
| `/cut` | 提出「该砍什么」让游戏能做完 —— 每一刀由你选 —— 外加打磨清单与日期 |
| `/today` `/statusline` `/dashboard` | 现在该做什么：一行、以及一个离线看板 |
| `/update` | 对比已安装版本与最新版本，你同意后才更新 |

## 一次完整的玩法

one-shot 流水线是「一个想法 → 一个别人能玩的游戏」最短的一条路，也是最值得看它真的跑起来的一段：

```
/prototype          → one-shot-new    prototypes/<name>/ ：页面、配置、来源记录、brief 副本
                      [/run]          → one-shot-run     用 headless Chrome 从新开局玩一次，
                                                         在该停的地方停下并截图
/check              → one-shot-check  Keep 钉子对 config、brief 清单、证据、检查记录
/tune               → one-shot-tune   调好的数值写回 config.js，并记一行 feel log
/share              → one-shot-share  去掉调试面板的 dist/；任何文件里还留着 tune.js 就失败
/grow               → one-shot-grow   guard → copy → replay：在根目录长成 Web 工程，
                                      并与原始版本逐帧对比
```

一次 grow（从装依赖到最后的比对）看起来是这样：

```
npm ci                     → added 47 packages
npm run build:single       → dist-single/index.html 4.14 kB
replay --as reference      → errors 0 · exact yes
replay --as copy           → errors 0 · match yes
replay --as story          → against reference · match yes
accept                     → accepted.tsv + accepted.png
```

`page-shot` 会找 Chrome、Edge、Chromium 或 Playwright 的 headless shell，给独立 profile，
用 Node 内置 WebSocket 走 DevTools 协议（不需要装任何东西），然后写截图。
机器上没有浏览器时它直接说 `not_assessed` 并退出 3 —— 绝不编一个 pass。

## 来源与版本

| | |
|---|---|
| 上游项目 | [`Donchitos/Claude-Code-Game-Studios`](https://github.com/Donchitos/Claude-Code-Game-Studios) |
| 本移植锁定的上游版本 | **v1.1.2**（commit `b21fa0f`，2026-09-29） |
| 上游许可证 | **MIT**（Copyright © 2026 Donchitos），本仓库沿用 |
| 本仓库 | `deepseek-harness-game-studios`（DSGS）**v0.3.6** |
| 移植方式 | 双栈同源：`.claude/` 是内容源（上游原文，逐字保留）；`.dsh/**` 由 `tools/build-dsh.mjs` 生成 |

上游面向 Claude Code（`.claude/`、`.sh` 钩子、`bash` 一行流、`@path` 导入）。这些在 DSH 下**无法直接运行**
（没有 `bash` 工具、管道捕获子进程被沙箱拒绝、不展开 `@path`）。本项目**不改上游内容**，而是生成
DSH 可运行的等价物，并验证**内容零丢失**。

> 插件包把框架打包在 `payload/` 下 —— 使用插件时你不需要看它。

## 安装

### ① 网页版

`插件` → `添加插件` → 填 `https://github.com/HYClub/deepseek-harness-game-studios` → **安装** → 重启 `dsh web`。

```pwsh
dsh plugin --profile web add https://github.com/HYClub/deepseek-harness-game-studios
```

### ② 桌面版

打开桌面客户端，`插件` → `添加插件` → 填同一个 URL → **安装** → 重启客户端。

插件首次加载时会自动把框架装到机器级（`~/.dsh/dsgs` 与用户级引导技能）。之后：

```
新建工作区 → 新会话 → 打 /start
```

`/start` 会自己判断该工作区有没有初始化：没有就先初始化，然后带你走引导。

## 升级

在**初始化过的工作区**里输入（0.2.1 及以上版本才有 `/update`）：

```
/update
```

它会读出已安装版本与最新版本，把要执行的命令先给你看，**你同意之后**才执行。装完重启客户端，新技能在**新会话**里出现。

**这个工作区初始化了吗？** 项目根目录下有 `.dsh/skills/start/SKILL.md` 或 `.dsgs-installed.json` 就算初始化过。
两个都没有的话：在 DSH 里打开这个项目，新开一个会话打 `/start` —— 初始化一次即可，以后在这个项目里随时可以 `/update`。

**从 0.2.0 或更早版本过来？** `/update` 从 0.2.1 才有，所以第一次升级要手动：

```pwsh
dsh plugin --profile web remove deepseek-harness-game-studios
dsh plugin --profile web add https://github.com/HYClub/deepseek-harness-game-studios
```

桌面版用户走 `插件` 面板（见下）。之后每次升级都是一条 `/update`。

**桌面版**：插件 profile 由应用独占，命令行改不了它。打开 `插件` → 卸载 `deepseek-harness-game-studios` →
`添加插件` 粘贴 `https://github.com/HYClub/deepseek-harness-game-studios` → 安装 → 重启。
`/update` 照样会帮你查版本，并告诉什么时候需要这么做。

## 插件会往你机器上写什么（与撤销）

| 路径 | 内容 |
|---|---|
| `~/.dsh/dsgs/**` | 框架载荷（技能、代理、规则、钩子、脚本、引擎、文档、指令文件） |
| `~/.dsh/skills/dsgs-init/SKILL.md`、`~/.dsh/skills/start/SKILL.md` | 用户级引导技能 |

它**绝不触碰任何项目目录**，也**绝不覆盖项目里的文件**。撤销：

```pwsh
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsgs"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsgs-init","$env:USERPROFILE\.dsh\skills\start"
# 再卸载插件并重启 dsh web
```

## 实现状态

### ✅ 已实现（可用命令复核）

| 项 | 状态 | 说明 |
|---|---|---|
| 技能 | ✅ | 上游 78 个全部移植（另有 5 个 DSGS 专有），逐个可 `/调用` |
| 代理角色卡 | ✅ | 49 个，`.dsh/agents/<name>.md` + 委派约定 |
| 规则 | ✅ | 14 条，含上游"路径作用域规则引擎"的等价替代：PostToolUse 钩子在每次写入/编辑后注入命中的规则原文 |
| 钩子 | ✅ | 上游 18 个脚本 → 19 个 Node 重写版，**0 个待移植**：读、写、两张注册表、提交与推送都有检查 |
| 钩子真实执行 | ✅ | 装好官方 bridge 包后：挂载 10/10 · 协议 12/12（`npm install` 在仓库根装 devDependencies 即可复现）；事件活体在能连到模型的会话里跑，否则报 SKIP —— 框架本身不需要任何 API key |
| 配置解析 | ✅ | `project.yaml` 单一来源；`resolve_config` / `__call resolve_setting` 的 Node 端口 |
| 辅助脚本 | ✅ | 上游每个 `.sh` 都有 Node 端口（`.dsh/scripts/*.mjs`），沙箱内可运行，含 `page-shot`、`write-guard`、`registry`、`cut-read`/`cut-apply`、`web-scaffold` 与整套 one-shot |
| 内容保真 | ✅ | 377 文件 / 53,459 行：96.2% 逐字、3.0% 已记录改写、0.4% 结构性、0.4% 换写法、**0 行无法解释的丢失** |
| 机器级安装 | ✅ | 插件自带载荷（1471 个文件）并在首次加载时安装；空工作区打 `/start` 即可用它初始化 |
| `/statusline` | ✅ | 工作室状态行 `阶段 · 姿态 · epic > story · Sprint n/m · 引擎`（+13 单测） |
| 嵌套委派 | ✅ | `subagent.maxDepth: 2` 已验证「父 → 子 → 孙」（DSH 默认 1） |
| 共享规则真正到达项目 | ✅ | `CLAUDE.md` 里的 `@path` 导入被改写成「需要时读某个文件」——本运行时**不展开** `@`，不这么做的话那些标准文档只是被引用、从未被读 |
| 角色工具边界 | ✅ | 每张代理角色卡写明"本角色应只用哪些工具"，并统一成本运行时的工具名。**属软约束**：运行时无法按代理限定工具集 |
| 一键式插件 | ✅ | 一个包 = 钩子桥 + 状态行投影 + 载荷自装 |
| `/today` | ✅ | 三到五行：下一个 story、被什么卡住、下一条命令 |
| `/dashboard` | ✅ | 一个离线 HTML 看板 —— 概览 · 缺口 · 应有目录 · 名册 · 图表 · 命令 —— 三张图覆盖 7 / 30 / 90 天与全部时间；左侧导航无脚本也能用，亮/暗主题跟随系统或记住你的选择，打印出来也能读 |
| `/update` | ✅ | 对比已安装版本与最新版本，**你确认之后**才执行那两条命令；会话开始时也会有一行提示新版本 |
| 脚本逐字节对照 | ✅ | 每个移植脚本都与 bash 原版逐字节比对：7 对全部一致，0 跳过 |
| 可玩性检查 | ✅ | headless Chrome 真的跑一次 one-shot，记录 scene/state/计时，在停下处截图，并把两次运行逐行对比 —— 这条往返由测试套件覆盖 |
| DSGS 专有技能 | ✅ | `statusline`、`dsgs-install`、`today`、`dashboard`、`update`（上游没有） |

### ⚠️ 部分等价 —— 能用，但有一处明确的限制

| 项 | 能用的部分 | 限制与原因 |
|---|---|---|
| 3 个钩子事件 | 映射已实现并单测 | `Notification`、`PreCompact`、`PostCompact` 在 DSH 没有事件源，只能到挂载级验证（活体部分需要模型凭据） |
| 逐代理工具白名单 | **每张角色卡正文写明边界**（`工具边界 …：read, glob, grep, …`），委派时模型读得到 | DSH 的 `subagent` 不接受按代理限定工具集，也没有代理注册中心，运行时无法强制 |

### ❌ 无法等价 —— 原因与替代

| 项 | 原因 | 替代 |
|---|---|---|
| 输入框上方的停靠状态条 | DSH 的前端插件清单只收 `@deepseek-ai/*`（清单里 60+ 条都是官方包，本包即使补上 `dsh.client` 声明也不在其中） | `/statusline` 技能 + `node .dsh/statusline.mjs`；运行时字段（轮次/token/缓存/上下文%）由 DSH 自带状态条覆盖 |
| PreToolUse 的事前提醒 | `tools/pre-execute` 只携带 `allow/deny/cancel/ask`；`additionalContexts` 只从工具最终结果读取；执行中 `agent.inject()` 无效 | `validate-commit` / `validate-push` 同时注册在 **PostToolUse**（提醒在动作之后到达）；要事前阻断可把插件行设为 `advisory: deny` |
| `!`cmd`` 预执行行 | DSH 没有预执行 | 改写为「前置命令」块，由模型自己运行 |

## 项目结构

```
.claude/                     # 上游内容源（MIT，逐字保留）
  settings.json              # 钩子、权限、安全规则
  agents/                    # 49 个代理定义
  skills/                    # 78 个技能（每技能一个目录）
  hooks/                     # 18 个脚本 —— 17 个事件钩子 + yaml-helper.sh
  rules/                     # 14 条路径作用域编码标准
  statusline.sh              # 上游状态行脚本（作参考保留）
  docs/                      # 工作流目录、39 个模板与写作指南
.dsh/                        # 由 tools/build-dsh.mjs 生成 —— 不要手改
  agents/  skills/  rules/  hooks/  scripts/  docs/  engines/
tools/                       # 生成器、校验器、Node 端口、插件、安装器
dsh-src/                     # DSH 专有手写叠加层（生成时并入 .dsh/）
DSGS Skill Testing Framework/  # 技能与代理自身的 QA
design/ src/ assets/ tests/ prototypes/ production/   # 你的项目
```

## 测试你自己的定制

DSGS 是给你改的模板。`DSGS Skill Testing Framework/` 用来验证改过或新写的技能是否还站得住：
全部技能与代理的目录、按类别的质量评分表、行为规格，以及写规格用的模板。

```
/skill-test static [name]     # 结构 linter
/skill-test category [name]   # 按类别的质量评分
/skill-test spec [name]       # 行为规格断言
/skill-test audit             # 技能与代理的覆盖报告
/skill-improve [name]         # 测试-修复-复测循环；分数下降就回退
```

它测的是**框架**，永远不是你的游戏 —— 游戏的测试放在 `tests/`。

## 验证

```pwsh
pwsh -File tools/verify-port.ps1        # 7 步：生成 → 结构 → 引用 → 保真 → 钩子 → 挂载 → 套件
node tools/check-dsh.mjs                # skills=83 agents=49 rules=14 hooks=19 errors=0 warnings=0
node tools/verify-fidelity.mjs          # unexplained 0 / 内容零丢失（377 文件，53,459 行）
node tools/verify-hooks-mount.mjs       # 10/10 挂载用例（先 npm install）
node tools/verify-hooks-bridge.mjs      # 12/12
node tools/tests/parity/bash-vs-node.test.mjs  # 7/7 对一致，0 跳过
```

## 支持本项目（以及上游）

DSGS 是移植：原始工作 —— 78 个技能、49 个代理、14 条规则与全部文档 —— 由**上游作者**完成，
他本人的支持渠道在[上游仓库](https://github.com/Donchitos/Claude-Code-Game-Studios)。
如果这个项目帮你省了时间，请**优先支持上游作者**。与 DSH 移植本身相关的 issue 与贡献请提到本仓库。

## 许可证

MIT License —— 见 [LICENSE](LICENSE)。上游版权 © 2026 Donchitos；移植层（生成器、Node 钩子、插件、
安装器、DSGS 专有技能）以同一许可证发布。




























