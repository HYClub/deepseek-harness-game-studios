# 当前项目怎么测（验收手册）

一句话：**大部分现在就能验，不用重启；只有一项（委派深度）需要重启一次。**

所有命令的工作目录都是 `D:\Work\dsh`。

---

## 0. 30 秒版（复制粘贴即可）

```pwsh
cd D:\Work\dsh

# 结构 + 内容保真 + 钩子桥 + 行为套件（7 步，全绿才算过）
pwsh -File tools/verify-port.ps1

# 结构账目：期望 skills=75 agents=49 rules=13 hooks=14 errors=0 warnings=0
node tools/check-dsh.mjs

# 内容不缺件：期望 unexplained 0 / "No content loss"
node tools/verify-fidelity.mjs

# 钩子真的能跑（不是"行挂上了"）：期望 10/10
node tools/verify-hooks-mount.mjs
```

会话里（任意会话，**不用重启**）：

```
/statusline          # 打一行工作室状态；没有来源的字段自动省略
```

---

## 1. 按"你想验什么"分组

| 你想验的 | 命令 / 动作 | 期望输出 | 要重启吗 |
|---|---|---|---|
| 内容有没有缺件 | `node tools/verify-fidelity.mjs` | `unexplained 0` + `No content loss`（258 文件 / 42895 行） | 否 |
| 生成物是否与生成器一致 | `pwsh -File tools/verify-port.ps1` | 7/7 步 ok + 28 套件 | 否 |
| 账目（技能/代理/规则/钩子） | `node tools/check-dsh.mjs` | `skills=75 agents=49 rules=13 hooks=14 errors=0 warnings=0` | 否 |
| 上游技能的结构合规 | `node tools/skill-test-static.mjs` | `0 NON-COMPLIANT`，74 份全查 | 否 |
| 覆盖率（技能/代理规范） | `node tools/skill-test-audit.mjs` | 技能规范 73/74、代理 49/49、未登记 0 | 否 |
| 钩子桥协议 | `node tools/verify-hooks-bridge.mjs` | 12/12 | 否 |
| 钩子真实执行 | `node tools/verify-hooks-mount.mjs` | 10/10 | 否 |
| 钩子事件活体触发 | `node tools/verify-hooks-events.mjs` | 6/9 LIVE + 3 mount-only（compaction/notification 无法从 prompt 触发） | 否 |
| **状态行（工作室那半）** | 会话里 `/statusline` | 一行；字段有来源才出现 | 否 |
| 状态行（运行时那半） | 见 §2 | `ctx: 37% \| DeepSeek-V41-Flash \| Production · standard` | 否 |
| **委派深度（嵌套编排）** | 见 §3 | 子代理能再派子代理并回传结果 | **是** |
| 可分发：装插件（钩子） | 见 §4 | 装进**已有** profile，重启后钩子生效 | **是** |
| 可分发：打包脚本 | `pwsh -File tools/publish.ps1` | dry run：只打印命令，不改任何东西 | 否 |

---

## 2. 状态行怎么测（两个半）

**工作室那半**（阶段/姿态/epic>story/sprint/引擎）——会话里 `/statusline`，或现场读来源：

```pwsh
node tools/yaml-helper.mjs __call resolve_setting project.stage
node tools/yaml-helper.mjs __call resolve_setting engine.name
Get-ChildItem production/epics -Directory | ForEach-Object {
  $s = Get-ChildItem $_.FullName -Filter 'story-*.md'
  $_.Name + ' done=' + ($s | Select-String '^> \*\*Status\*\*: Complete').Count + '/' + ($s|Measure-Object).Count }
Get-Content production/sprint-status.yaml
```

**运行时那半**（上下文%/模型/阶段/姿态）——渲染器**从 stdin 读 harness 的 payload**，所以交互式直接跑会**没有输出**（这是它的接口，不是坏了）：

```pwsh
# ① 空输入
'' | node .dsh/statusline.mjs
# → ctx: -- | Unknown | Production · standard

# ② 模拟 harness payload（真会话里就是这个形态）
'{"model":{"display_name":"DeepSeek-V41-Flash"},"context_window":{"used_percentage":37},"workspace":{"project_dir":"D:\\Work\\dsh\\.smoke\\statusline-demo"}}' | node .dsh\statusline.mjs
# → ctx: 37% | DeepSeek-V41-Flash | Production · standard
```

> 注意：**DSH 自带状态条**（GUI 输入框下方：轮次/步数/tok-s/token/缓存/上下文%）已经覆盖运行时那半，
> 比上游 `statusline.sh` 更多。所以平时不需要跑渲染器。

**完整那行长什么样**——已备好一个"字段齐全"的演示工程（在 `.smoke/`，**不动本仓库**）：

```pwsh
cd D:\Work\dsh\.smoke\statusline-demo
# 该工程：stage=Production、rigor=standard、epic=combat-core(1/3 done)、sprint 1/3、engine=Godot 4.6.2
```

⇒ 一行应为：

```
Production · Standard | combat-core > story-002-combo-window | Sprint 1/3 | Godot 4.6.2
```

三种工作区的**正确输出各不相同**（字段有来源才出现）：

| 工作区 | `/statusline` 应输出 |
|---|---|
| `D:\Work\dsh`（框架仓库，未跑 `/start`） | `ctx: -- \| Unknown \| Minimal · brief`（只有姿态） |
| `.smoke/verify-current`（有 stage+engine，故事全 Complete、无 sprint） | `Concept · Minimal \| Godot 4.6.2` |
| `.smoke/statusline-demo`（字段齐全） | 上面那行完整版 |

---

## 3. 委派深度（唯一必须重启的一项）

已把设置写进你在用的 profile：`~/.dsh/profiles/web/settings.yaml` →

```yaml
subagent:
  maxDepth: 2
```

**重启 `dsh web` 后**，新会话里说：

> 派一个子代理，并让它自己再派一个子代理去回一个词

- 之前：`subagent depth 2 exceeds maxDepth 1`
- 现在：**父 → 子 → 孙** 一路返回（已实测，孙回的 `deep` 原样传回主代理）

改回默认：把该文件里的 `maxDepth` 改成 `1`（或删掉该文件）。

---

## 4. 可分发怎么测

**装钩子桥（会改 profile，需重启）**：

```pwsh
# 先确认 profile 已存在（不要让 dsh plugin add 去新建 profile —— 那样会得到一个没有 app 的 profile 而静默挂死）
dsh plugin --profile web add "D:\Work\dsh\dist/deepseek-harness-game-studios"      # 合并包：钩子 + 状态行投影
# 或者用脚本（dry run 先行）：
pwsh -File tools/setup.ps1            # 只打印将追加的 file:// 行
pwsh -File tools/setup.ps1 -Confirm   # 真的写进 web profile 的 cordis.patch.yml
```

重启后验**它真的在干活**（看证据，不看行）：

```pwsh
node tools/verify-hooks-mount.mjs
# 或跑一次 headless 看调用审计：.verify-logs/hook-invocations.log 里应有 resolve / exit= 行
```

**发布（不推送）**：`pwsh -File tools/publish.ps1` 默认 dry run，只打印命令；不加 `-Confirm` 不会提交/推送任何东西。

---

## 5. 已知限制（**不算失败**，已登记）

| 限制 | 说明 | 登记处 |
|---|---|---|
| GUI 输入框上方做不出状态条 | DSH 前端 roster 只收 `@deepseek-ai/*` 官方包（实测清单 60+ 条、`DSGS` 命中 0）；补 `（见仓库 README 的 Known limits 一节）
| Plan / Jobs 面板不适合放它 | Plan 由 `todos` 投影驱动（写它会覆盖模型自己的待办）；Jobs 是后台任务语义（借位） | 同上 |
| 3 个钩子事件无法从 prompt 触发 | `Notification` / `PreCompact` / `PostCompact`：DSH 无对应事件源 → 只做挂载级验证（6/9 活体） | 框架仓库的验收手册、插件 README |
| 交互式跑渲染器无输出 | 它按上游约定从 stdin 读 payload（给 EOF 或 payload 就有输出） | 本文件 §2 |
| bash↔Node 对照 | 本机 Git Bash 缺真 `python3` → 2 对 SKIP（具名原因），1 对真·逐字节一致 | 框架仓库里 parity 测试的输出 |
| `dsh plugin add` 新建 profile 会静默挂死 | 因为它建的 profile **没有 app bundle*（见仓库 README 的 Known limits 一节）


---

## 6. 从纯空文件夹开始的用户流程（机器级安装 + 一句话初始化）

**目标体验**：新建空文件夹 → 新会话 → 说「初始化 DSGS」→ 说「/start」。全程不碰命令行、不记路径。

### 6.1 机器上装一次（`install-global.ps1`）

```pwsh
pwsh -File tools/install-global.ps1                 # dry run，看会写什么
pwsh -File tools/install-global.ps1 -Confirm        # 真装
pwsh -File tools/install-global.ps1 -Confirm -InstallPlugin   # 顺带装插件
```

装三样（都在**用户级**，与任何项目无关）：

| 位置 | 作用 |
|---|---|
| `~/.dsh/dsgs/**` | **载荷**：框架本体（技能/代理/规则/钩子/工具/文档/指令/配置模板） |
| `~/.dsh/skills/dsgs-init/SKILL.md` | **引导技能**：让"初始化 DSGS"这句话在**任何**工作区（包括纯空目录）都能被理解并执行 |
| 可选：插件进 profile | 钩子桥（需重启 `dsh web`） |

> 实测：`~/.dsh/skills` 是 DSH 会扫描的用户级技能根——装上 `dsgs-init` 后，**纯空文件夹的会话里也能看到它**。

### 6.2 每个新项目：一句话初始化

在**纯空文件夹**里开新会话，说：

> 初始化 DSGS

agent 会跑（`dsgs-init` 技能里的命令）：

```pwsh
pwsh -NoProfile -File "$env:USERPROFILE.dsh\dsgs\tools\dsgs-init.ps1" -Target .          # dry run
pwsh -NoProfile -File "$env:USERPROFILE.dsh\dsgs\tools\dsgs-init.ps1" -Target . -Confirm  # 真初始化
```

特性：**幂等**（重复运行安全）、**绝不覆盖**已有文件、写**标记** `.dsgs-installed.json`（项目根，含它写过的每一项）、
可撤销 `-Undo`（只删标记里记过的项）。

**实测结果**（空文件夹 0 项 → 初始化后）：

```
✔ 写入 925 项（已存在的一律未覆盖）
.dsh/skills 技能数: 75
node tools/check-dsh.mjs → skills=75 agents=49 rules=13 hooks=14 errors=0 warnings=0
engine.name → unset（项目状态为空，正是"空工程"）
```

### 6.3 然后

```
/start          → 引导（会检测到引擎未配置并询问）
/setup-engine   → 选引擎，写 AGENTS.md 锚点 + project.yaml
/statusline     → 工作室状态行
```

**注意**：初始化后如果同一会话里看不到新技能，**新开一个会话**即可（技能目录按会话装载）。

### 6.4 为什么必须有"初始化"这一步

DSH 的技能只来自**项目里的 `.dsh/skills`** 或**用户级 `~/.dsh/skills`**；一个纯空文件夹两处都没有 → DSGS 在那里
等于不存在（没有技能、没有钩子配置、没有指令）。**插件安装也带不来技能。** 所以"初始化"= 把载荷铺进项目，
这与上游 Claude Code 的"clone 模板当项目"是同一件事，只是自动化成了一句话。

### 6.5 更简单：插件自带载荷（自装，2026-10-11 实测）

从这一版起，**装插件这一步就完成机器级安装**——插件包内带框架载荷，宿主加载插件时幂等地写入：

| 写入 | 内容 |
|---|---|
| `~/.dsh/dsgs/**` | 框架载荷（技能/代理/规则/钩子/工具/文档/指令） |
| `~/.dsh/skills/dsgs-init/SKILL.md` | 引导技能（让"初始化 DSGS"在任何工作区可执行） |

**实测证据**：以临时 HOME 直接调用构建产物 → 首次 `payloadInstalled/skillInstalled = true`（载荷 76 技能、9.8 MB）、
**第二次全部 false（幂等）**、`errors = []`；用假 ctx 加载插件 → `apply()` 未抛异常且自装成功。
包内附 `SELF-INSTALL.md` 写清"写了哪些路径、怎么撤销"。

⇒ 新人流程因此变成：**装插件 → 重启 → 空目录说"初始化 DSGS" → /start**（不需要 `/dsgs-install`）。

### 6.6 最终一步流程（2026-10-11 实测通过）

```
① 装插件 → 重启 dsh web           （插件自装：~/.dsh/dsgs 载荷 + 用户级 dsgs-init 与 start 引导壳）
② 新建任意空文件夹 → 新会话 → 打 /start
③ 壳自检"未初始化" → dry run → dsgs-init -Confirm（实测 928 项）→ 按文件转交项目里的真 /start
④ 真 /start 跑 Phase 1 检测 → 用中文弹出"你的起点"四选项
```

**实测证据**：`D:\dsgs-demo`（0 项）→ 打 `/start` → 会话日志依次为
"Per the /start **shell**…" → "Workspace is empty and not initialized" → dry run → `-Confirm` →
"初始化完成（928 项，标记 `.dsgs-installed.json`）" → "read the project's own /start SKILL.md and follow it" →
Phase 1 报告"引擎未配置/无概念/无代码/非 git 仓库" → **中文四选项问答框**。

**踩过的两个坑（都已修）**：

1. **版本门控导致技能永不补写**：刷新判断只比对版本号，而新增技能时忘了推进版本号 → `start` 壳永远写不出来。
   现在判断条件改为"载荷 + `dsgs-init` + `start` 两个技能都在，且版本一致"，版本推进到 `0.1.1`。
2. **技能目录按会话装载**：插件在某次启动里写出的技能，**那个会话看不到**（`/start` 曾被当成普通文字丢给模型）。
   所以：装插件/补写技能后**必须重启并新开会话**；壳本身也写明"以后同一会话继续用按文件读的方式转交"。




