# DeepSeek Harness Game Studios

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.1.8-orange.svg)
![Agents](https://img.shields.io/badge/agents-49-purple.svg)
![Skills](https://img.shields.io/badge/skills-76-green.svg)
![Hooks](https://img.shields.io/badge/hooks-14-orange.svg)
![Rules](https://img.shields.io/badge/rules-13-blue.svg)
![Port of CCGS](https://img.shields.io/badge/port%20of-CCGS%20v1.1.2-lightgrey.svg)

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[安装](#安装) · [实现状态](#实现状态) · [项目结构](#项目结构) · [测试你的定制](#测试你自己的定制) · [验证](#验证) · [许可证](#许可证)

把一次 DeepSeek Harness 会话变成一间完整的游戏工作室。
**49 个代理。76 个技能。一支协调好的 AI 团队。**

本仓库是 [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)（CCGS）
到 DeepSeek Harness（DSH）的**移植**，不是从零自研：技能、代理、规则、文档都来自上游（MIT）；
本仓库提供 DSH 原生运行时（Node 钩子、技能生成、机器级安装、插件桥）。

## 来源与版本

| | |
|---|---|
| 上游项目 | [`Donchitos/Claude-Code-Game-Studios`](https://github.com/Donchitos/Claude-Code-Game-Studios) |
| 本移植锁定的上游版本 | **v1.1.2**（commit `b21fa0f`，2026-09-29） |
| 上游许可证 | **MIT**（Copyright © 2026 Donchitos），本仓库沿用 |
| 本仓库 | `deepseek-harness-game-studios`（DSGS）**v0.1.8** |
| 移植方式 | 双栈同源：`.claude/` 是内容源（上游原文，逐字保留）；`.dsh/**` 由 `tools/build-dsh.mjs` 生成 |

上游面向 Claude Code（`.claude/`、`.sh` 钩子、`bash` 一行流、`@path` 导入）。这些在 DSH 下**无法直接运行**
（没有 `bash` 工具、管道捕获子进程被沙箱拒绝、不展开 `@path`）。本项目**不改上游内容**，而是生成
DSH 可运行的等价物，并验证**内容零丢失**。

> 本仓库根**就是插件包**。它要安装的框架打包在 `payload/` 下 —— 你不需要看它。

## 安装

### ① GUI

`插件` → `添加插件` → 填 `https://github.com/HYClub/deepseek-harness-game-studios` → **安装** → **重启 `dsh web`**。

### ② 命令行

```pwsh
dsh plugin --profile web add https://github.com/HYClub/deepseek-harness-game-studios
```

装完**重启 `dsh web`**。

插件首次加载时会自动把框架装到机器级（`~/.dsh/dsgs` 与用户级引导技能）。之后：

```
新建工作区 → 新会话 → 打 /start
```

`/start` 会自己判断该工作区有没有初始化：没有就先初始化，然后带你走引导。

## 插件会往你机器上写什么（与撤销）

| 路径 | 内容 |
|---|---|
| `~/.dsh/dsgs/**` | 框架载荷（技能、代理、规则、钩子、工具、文档、指令文件） |
| `~/.dsh/skills/dsgs-init/SKILL.md`、`~/.dsh/skills/start/SKILL.md` | 用户级引导技能 |

它**绝不触碰任何项目目录**，也**绝不覆盖项目里的文件**。撤销：

```pwsh
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsgs"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsgs-init","$env:USERPROFILE\.dsh\skills\start"
# 再卸载插件并重启 dsh web
```

## 实现状态

### ✅ 已实现（均有实测证据）

| 项 | 状态 | 说明 |
|---|---|---|
| 技能 | ✅ | 上游 74 个全部移植，逐个可 `/调用` |
| 代理角色卡 | ✅ | 49 个，`.dsh/agents/<name>.md` + 委派约定 |
| 规则 | ✅ | 13 条，含上游"路径作用域规则引擎"的等价替代：PostToolUse 钩子在每次写入/编辑后注入命中的规则原文 |
| 钩子 | ✅ | 上游 12 个脚本 → 14 个 Node 重写版，经 `dsh-hooks-claude-code` 桥接；9 个上游事件全覆盖 |
| 钩子真实执行 | ✅ | 挂载 10/10 · 协议 12/12 · 事件活体 6/9 |
| 配置解析 | ✅ | `project.yaml` 单一来源；`resolve_config` / `__call resolve_setting` 的 Node 端口 |
| 辅助脚本 | ✅ | 上游每个 `.sh` 都有 Node 端口（`.dsh/scripts/*.mjs`），沙箱内可运行 |
| 内容保真 | ✅ | 258 文件 / 42,895 行：96.0% 逐字、3.1% 已记录改写、0.5% 结构性、0.4% 换写法、**0 行无法解释的丢失** |
| 机器级安装 | ✅ | 插件自带载荷并在首次加载时安装；空工作区打 `/start` 即初始化（实测 928 项） |
| `/statusline` | ✅ | 工作室状态行 `阶段 · 姿态 · epic > story · Sprint n/m · 引擎`（+13 单测） |
| 嵌套委派 | ✅ | `subagent.maxDepth: 2` 实测「父 → 子 → 孙」（DSH 默认 1） |
| 一键式插件 | ✅ | 一个包 = 钩子桥 + 状态行投影 + 载荷自装 |
| DSGS 专有技能 | ✅ | `statusline`、`dsgs-install`（上游没有） |

### ❌ 未实现 / 无法等价（附原因与替代）

| 项 | 状态 | 原因 | 替代 |
|---|---|---|---|
| 输入框上方的停靠状态条 | ❌ | DSH 的前端插件清单只收 `@deepseek-ai/*`（实测 60+ 条全为官方包，本包即使补 `dsh.client` 声明仍不在其中） | `/statusline` 技能 + `node .dsh/statusline.mjs`；运行时字段（轮次/token/缓存/上下文%）由 DSH 自带状态条覆盖 |
| PreToolUse 的事前提醒 | ❌ | `tools/pre-execute` 只携带 `allow/deny/cancel/ask`；`additionalContexts` 只从工具最终结果读取；执行中 `agent.inject()` 无效 | `validate-commit` / `validate-push` 同时注册在 **PostToolUse**（提醒在动作之后到达）；要事前阻断可把插件行设为 `advisory: deny` |
| 3 个钩子事件无法从 prompt 触发 | ⚠️ | `Notification`、`PreCompact`、`PostCompact` 在 DSH 没有事件源 | 映射已实现并单测，仅到挂载级验证（活体 6/9） |
| 逐代理工具白名单 / 代理自动发现 | ❌ | DSH 的 `subagent` 不接受按代理限定工具集，也没有代理注册中心 | 角色卡 + `toolFilter` / `persona` 约定 |
| `@path` 导入 | ❌ | DSH 不展开导入 | `.dsh/docs/studio-rules.md`（合并版），按需读取 |
| `!`cmd`` 预执行行 | ❌ | DSH 没有预执行 | 改写为「前置命令」块，由模型自己运行 |
| bash ↔ Node 逐字节对照 | ⚠️ | 本机 Git Bash 的 `python3` 是 Store 占位程序 | 2 项具名 SKIP，1 项逐字节一致 |

## 项目结构

```
.claude/                     # 上游内容源（MIT，逐字保留）
  settings.json              # 钩子、权限、安全规则
  agents/                    # 49 个代理定义
  skills/                    # 74 个技能（每技能一个目录）
  hooks/                     # 14 个脚本 —— 12 个事件钩子 + yaml-helper.sh
  rules/                     # 13 条路径作用域编码标准
  statusline.sh              # 上游状态行脚本（作参考保留）
  docs/                      # 工作流目录、39 个模板与写作指南
.dsh/                        # 由 tools/build-dsh.mjs 生成 —— 不要手改
  agents/  skills/  rules/  hooks/  scripts/  docs/
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
node tools/check-dsh.mjs                # skills=76 agents=49 rules=13 hooks=14 errors=0 warnings=0
node tools/verify-fidelity.mjs          # unexplained 0 / 内容零丢失（258 文件，42,895 行）
node tools/verify-hooks-mount.mjs       # 10/10 挂载用例
node tools/verify-hooks-bridge.mjs      # 12/12
node tools/verify-hooks-events.mjs      # 6/9 活体 + 3 仅挂载
```

## 支持本项目（以及上游）

DSGS 是移植：原始工作 —— 74 个技能、49 个代理、13 条规则与全部文档 —— 由**上游作者**完成，
他本人的支持渠道在[上游仓库](https://github.com/Donchitos/Claude-Code-Game-Studios)。
如果这个项目帮你省了时间，请**优先支持上游作者**。与 DSH 移植本身相关的 issue 与贡献请提到本仓库。

## 许可证

MIT License —— 见 [LICENSE](LICENSE)。上游版权 © 2026 Donchitos；移植层（生成器、Node 钩子、插件、
安装器、DSGS 专有技能）以同一许可证发布。
















