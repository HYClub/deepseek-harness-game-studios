# DeepSeek Harness Game Studios

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.3.8-orange.svg)
![Agents](https://img.shields.io/badge/agents-49-purple.svg)
![Skills](https://img.shields.io/badge/skills-83-green.svg)
![Hooks](https://img.shields.io/badge/hooks-19-orange.svg)
![Rules](https://img.shields.io/badge/rules-14-blue.svg)
![Port of CCGS](https://img.shields.io/badge/port%20of-CCGS-lightgrey.svg)

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[安装](#安装) · [实现状态](#实现状态) · [项目结构](#项目结构) · [测试你的定制](#测试你自己的定制) · [验证](#验证) · [许可证](#许可证)

把一次 DeepSeek Harness 会话变成一间完整的游戏工作室。
**49 张角色卡。83 个技能。一间协调好的工作室。**

本仓库是 [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)（CCGS）
到 DeepSeek Harness（DSH）的**移植**，不是从零自研：技能、代理、规则、文档都来自上游（MIT）；
DSGS 提供 DSH 原生运行时（Node 钩子、技能生成、机器级安装、插件桥）。

## 你会得到什么

下表中的核心计数由框架自带的校验命令打印，你可以在任意工作区自己跑一遍；其余（注册数、引擎文档数、载荷数）见"验证"一节与 S20 门禁：
`node tools/check-dsh.mjs`、`node tools/verify-fidelity.mjs`。

| | |
|---|---|
| **83 个技能** | 从最初想法到发布的完整工作室流程，全部是斜杠命令。 |
| **49 张角色卡** | 工作室的角色 —— 设计、美术、音频、叙事、工程、QA、发布、Live Ops —— 是提示词卡加委派约定。卡由委派方读取，不会自动加载成代理。 |
| **14 条规则** | 编码与内容标准，通过钩子桥作用到你写的文件。 |
| **19 个钩子** | 检查读、写、注册表、提交、推送、会话/子代理事件。三个事件仅挂载级，见「值得知道的限制」。 |
| **引擎** | Godot、Unity、Unreal 与 Web 参考；项目钉的版本就是每个引擎技能读到的版本。 |
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
| 上游基线 | **v1.1.2**（commit `b21fa0f`，2026-09-29） |
| 内容源已同步到的上游线 | **v1.3.0**：+4 个技能（`/cut`、`/next-step`、`/project-settings`、`/write-changelog`）、+1 条规则（`scene-files`）、+5 个钩子脚本 |
| 上游许可证 | **MIT**（Copyright © 2026 Donchitos），本仓库沿用 |
| 本仓库 | `deepseek-harness-game-studios`（DSGS）**v0.3.8** |
| 移植方式 | 双栈同源：`.claude/` 是内容源（上游原文，逐字保留）；`.dsh/**` 由 `tools/build-dsh.mjs` 生成 |

内容源是上游 **74** 个（v1.1.2 基线）技能，加上从 v1.3.0 线同步的 **4** 个，再加这里独有的 **5** 个；上游 **18 个钩子脚本 → 19 个 Node 实现** 是 DSH 侧能跑起来的原因。

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

安装过程**不写项目目录**、**不覆盖项目里的文件**。另外，钩子在工作区激活之后会留下自己的日志
（`production/session-logs/`、`.verify-logs/`），`/start` 会建工作室需要的项目目录。撤销安装：

```pwsh
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsgs"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsgs-init","$env:USERPROFILE\.dsh\skills\start"
# 再卸载插件并重启 dsh web
```

## 作用域与信任模型

在这个目录里启用之前，有两点值得知道：

- **钩子是按 profile 装、不是按工作区装。** 装好后，这个 profile 下任何目录的会话都会跑它们。
  插件会从会话的工作目录解析出项目（如果 DSH 本身就是在项目目录里启动的，也可从启动目录解析），
  把每个钩子的工作目录钉到该项目，日志和检查也落在那里 —— 但钩子集合本身是共享的。
- **仓库里的 `.dsh/hooks.json` 是可执行内容。** 插件用你的用户身份直接跑其中的命令
  （与 Claude Code 对钩子的信任模型一致），而不是走沙箱化 shell——因为那条路在 Windows 上会把每个
  钩子静默变成 no-op。**只在信任的仓库里启用**，打开别人的项目前先读一眼 `hooks.json`。

桥不映射的三个钩子事件，写明而不是藏着：`Notification` 保持休眠（它的通知没有展示通道），
`PreCompact` 走 `session/event`（`compaction/start`），`PostCompact` 上游也没注册。

## 值得知道的限制

- 事前提醒会在动作**之后**到达；要在动作之前阻断，把对应钩子行的 `advisory` 设为 `deny`。
- 角色卡写了工具边界，但 DSH 无法按代理强制工具集。
- 三个钩子事件只有挂载级：`Notification`、`PreCompact`、`PostCompact`（见上）。
- 浏览器试玩需要 Chrome、Edge、Chromium 或 Playwright 的 headless shell；没有时命令 exit 3，不会假装通过。

## 支持本项目（以及上游）

DSGS 是移植：原始工作 —— v1.1.2 基线的 74 个技能、49 个代理、13 条规则与全部文档 —— 由**上游作者**完成，
他本人的支持渠道在[上游仓库](https://github.com/Donchitos/Claude-Code-Game-Studios)。
如果这个项目帮你省了时间，请**优先支持上游作者**。与 DSH 移植本身相关的 issue 与贡献请提到本仓库。

## 许可证

MIT License —— 见 [LICENSE](LICENSE)。上游版权 © 2026 Donchitos；移植层（生成器、Node 钩子、插件、
安装器、DSGS 专有技能）以同一许可证发布。




























