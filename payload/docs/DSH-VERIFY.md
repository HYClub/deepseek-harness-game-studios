# DSH 移植验证手册（可独立复跑）

这份文档是给**你自己**跑的：每一节都是「做什么 → 命令 → 期望输出 → 失败怎么读 → 它**不能**证明什么」。
不需要依赖任何人的口头结论；所有判断都来自你屏幕上看到的输出。

工作根：`D:\Work\dsh`。命令在**普通 PowerShell** 里跑最省事（在 DSH 会话里跑也等价，
只是涉及写 profile 的那几条会弹一次授权）。

```
目录
0. 五分钟快速通道
1. 分步验证（A–H）
2. 负向验证：证明这些检查不是空转
3. 独立复现最小闭环
4. 这套验证**不能**证明什么
5. 验证代码清单（哪个脚本证明什么）
```

---

## 0. 五分钟快速通道

```pwsh
cd D:\Work\dsh

# ① 仓库健康：生成 → 结构 → 引用 → 钩子协议 → 钩子挂载 → 24 个行为测试
pwsh -NoProfile -File tools\verify-port.ps1

# ② 部署状态（需要 profile 已重启才可能 LIVE）
node tools\preflight-hooks.mjs
pwsh -NoProfile -File tools\check-hooks-live.ps1

# ③ 配置解析抽查
node tools\yaml-helper.mjs resolve_config --keys review_mode,workflow,qa.level,team.size
```

期望：① 六步全 `ok`，最后一行 `6/6 behaviour tests (24 passed, 0 failed)`；
② `PREFLIGHT OK` 与 `hook bridge is LIVE`；③ 四行 `键: 值 (来源)`。

任何一步不符，跳到下面第 1 节对应小节看"失败怎么读"。

---

## 1. 分步验证

### A. 生成链：`.dsh/` 是否与源一致、frontmatter 是否合法

```pwsh
node tools\build-dsh.mjs
node tools\check-dsh.mjs
```

**期望**（数字会随文件增删浮动，但这四项必须一致）：

```
skills=74 agents=49 rules=13 hooks=14
hooks.json: 13 enabled (1 DSH-only: rules-context), 0 pending port (9 events)
studio-rules.md: merged 4 @ import(s) from CLAUDE.md
SUMMARY skills=74 agents=49 rules=13 hooks=14 errors=0 warnings=0
```

**失败怎么读**：`parity: missing/unexpected …` = 生成物与 `.claude/` 不同步（重跑生成器）；
`skill X: frontmatter …` = 技能 frontmatter 不合法；
`residual …` = 生成物里残留了 Claude 专有写法（`.claude/`、`AskUserQuestion`、`TodoWrite` 等）。

**它不能证明**：技能内容对不对、能不能跑通——只证明结构与源一致。

### B. 技能引用审计：74 个技能让模型读的东西是否真的存在

```pwsh
node tools\audit-skill-refs.mjs
```

**期望**：

```
scanned 91 skill files, ~1060 path references
framework references missing: 0
shell invocations without a Node port: 0
asset paths referenced: …
```

（`stale .sh mentions …` 只有 >0 时才打印，所以看不到这行 = 好事。）

**失败怎么读**：`MISSING <path>` = 某个技能引用了不存在的框架文件；
`SHELL <x>.sh` = 有 `.sh` 调用没有 Node 端口（在 DSH 里跑不了）；
`STALE` = 正文还在提旧的 `.sh` 文件名（有 `.mjs` 端口却没改写）。

**它不能证明**：技能被调用时的语义正确性——只证明引用的路径/脚本存在且可执行形式正确。

### C. 钩子协议：生成的 `hooks.json` 能否被 DSH 真实的钩子运行时执行

```pwsh
node tools\verify-hooks-bridge.mjs
```

**期望**：`11/11 bridge cases passed`，并且能看到这几条：
SessionStart 两个钩子都跑、无关工具调用放行、**matcher 只认 DSH 工具名**（`pwsh` 匹配、`Bash` 不匹配）、
保护分支推送只警告不阻断、暂存坏 JSON 被提交门禁 deny、技能改动提醒、非法数据写入被 block、
子代理 start/stop 审计、Stop 不阻断、Pre/PostCompact 不决策。

**失败怎么读**：它会逐条打印实际值与期望值。最常见的是 matcher 写成了 Claude 拼写
（`Write|Edit`）——那样对应钩子**永远不会被选中**。

**它不能证明**：插件有没有被加载、事件有没有被接上。

### D. 钩子挂载：用插件真实的 `apply()` 挂上并触发

```pwsh
node tools\verify-hooks-mount.mjs
```

**期望**：`10/10 mount cases passed`，并带一条**预期内的警告**：

```
bridge warnings (1):
  hooks-claude-code: PreToolUse hook emitted a systemMessage, which is not yet surfaced (ignored)
```

这条警告不是失败，而是桥的真实限制（见第 4 节）。

**失败怎么读**：`apply() threw` = 插件本体起不来；某条 `expected … got …` = 事件→命令→决策链断了。

**它不能证明**：profile 加载器会不会把这个插件挂上（那是 E 与 H 的事）。

### E. 行为测试：13 个钩子 + 9 个辅助脚本 + 配置解析器

```pwsh
Get-ChildItem tools\tests -Recurse -Filter *.test.mjs | ForEach-Object { node $_.FullName }
node tools\yaml-helper.test.mjs --node-only
```

**期望**：24 个套件全绿；配置解析器 `cases=4398 pass=4398 fail=0`。

**注意**：`yaml-helper.test.mjs` **不带** `--node-only` 时会与 bash 原版逐字节对照——
这一步在本机跑不了（沙箱里 Git Bash 起不来，见第 4 节），请在**普通终端**试一次。

### F. 配置解析：真的按 `project.yaml` 展开吗

```pwsh
node tools\yaml-helper.mjs resolve_config --keys rigor,review_mode,workflow,qa.level,team.size
node tools\yaml-helper.mjs __call resolve_setting modes.rigor
node tools\yaml-helper.mjs __call resolve_code_root
node tools\yaml-helper.mjs __call session_state_enabled; "exit=$LASTEXITCODE"
```

然后自己做一个**对照实验**（最能说明问题的一步）：

```pwsh
Copy-Item project.yaml project.yaml.bak
# 在 project.yaml 末尾加两行：modes: /   rigor: full
node tools\yaml-helper.mjs resolve_config --keys rigor,review_mode,workflow,qa.level,team.size
Move-Item project.yaml.bak project.yaml -Force     # 还原
```

**期望**：`minimal` 时六项是 `solo / minimal / minimal / individual`；改成 `full` 后同时变成
`full / full / full / studio`（一个开关展开六个旋钮），且每行标注来源（`rigor:minimal` / `project.yaml`）。

**两个已知陷阱**（会静默给错答案，务必知道）：
1. `--keys` 只认**裸标签**。写 `modes.rigor` 这种带命名空间的键会**返回空块且 exit 0**；
   要读任意路径用 `__call resolve_setting <dotted.path>`。
2. `__call` 的输出**没有结尾换行**，不要把两次调用拼成一行读。

### G. 部署状态：插件是否会/已经挂上

```pwsh
node tools\preflight-hooks.mjs         # 重启前：静态条件
pwsh -NoProfile -File tools\check-hooks-live.ps1   # 重启后：活体判定
```

**期望**：`PREFLIGHT OK — nothing static blocks the bridge from mounting.`
与 `hook bridge is LIVE`。

**失败怎么读**：
- `PREFLIGHT PROBLEMS: the profile resolves X, whose peers reject the runtime` = profile 里的桥版本不对
  （本次真实踩到：第三方插件包把桥钉在旧版）——输出里会直接给你修复命令。
- `no subagent has been logged yet`（退出码 2）= 要么桥没挂载，要么重启后还没派过子代理——
  **先派一次子代理再跑**。`退出码 3` = 日志过旧。

**它不能证明**：钩子在其他项目里也表现良好（见仓库 README 的说明）。

### H. 独立复现"钩子活体触发"（不动你的主 profile）

用一次性 headless 会话 + overlay：

```pwsh
Remove-Item production\session-logs\agent-audit.log -ErrorAction SilentlyContinue

dsh hookcheck --from-default-profile headless `
    --patch "D:/Work/dsh/tools/dsh-hooks-overlay.yml" `
    "Reply with exactly: hookcheck-ok. Then call the subagent tool once to delegate the single word 'ping' to one child, then stop."

Get-Content production\session-logs\agent-audit.log
Remove-Item 'C:\Users\user\.dsh\profiles\hookcheck' -Recurse -Force
```

**期望**：日志里出现两行（`agent-audit.log` 由移植后的 `log-agent.mjs` / `log-agent-stop.mjs` 写出）：

```
20261008_230857 | <session-id> | Agent invoked: general-purpose
20261008_230859 | <session-id> | Agent completed: general-purpose
```

**失败怎么读**：日志不存在 = 桥没挂上（回到 G 的 preflight 看版本/条目）；日志有内容但只有一行 =
只有一个事件被接上。

---

## 2. 负向验证：证明这些检查不是空转

一个只会说 `ok` 的检查等于没有检查。下面三条都是**故意破坏 → 观察报错 → 还原**，
每条都在本会话里被验证过语义（破坏后确实会红）：

### 2.1 结构校验能抓到残留写法

```pwsh
# 往生成物里塞一个 Claude 专有 token（不要重新生成）
Add-Content .dsh\skills\dev-story\SKILL.md "`nuse AskUserQuestion here"
node tools\check-dsh.mjs            # 期望：warnings=1，并指出 .dsh/skills/dev-story/SKILL.md 与行号
node tools\build-dsh.mjs             # 还原：重新生成会覆盖掉这行
node tools\check-dsh.mjs            # 期望：errors=0 warnings=0
```

实测输出（本会话跑过）：`"residual AskUserQuestion: 1 line(s) — .dsh/skills/dev-story/SKILL.md:705"`
配 `SUMMARY … errors=0 warnings=1`。
**注意这是 warning 不是 error**（残留检查按设计只告警，退出码仍 0）——看到那行就说明检查是活的。

### 2.2 引用审计能抓到缺失文件

**要藏一个真被技能引用的文件**（审计器只扫 `.dsh/skills/**`，所以 `AGENTS.md` 引用的文件藏了也不会被发现）：

```pwsh
Rename-Item .dsh\agents\README.md README.md.off
node tools\audit-skill-refs.mjs     # 期望：framework references missing: 1，MISSING .dsh/agents/README.md
Rename-Item .dsh\agents\README.md.off README.md
node tools\audit-skill-refs.mjs     # 期望：framework references missing: 0
```

实测：藏掉后会列出引用它的技能清单（`adopt`、`architecture-decision`、…），还原后归零。
同理可换 `.dsh/docs/effects-map.md`（被 `art-bible`、`gate-check` 等引用）。

### 2.3 matcher 写回 Claude 拼写就会被抓

```pwsh
# 把 PostToolUse 的 matcher 改回 Claude 拼写
(Get-Content .dsh\hooks.json -Raw) -replace '"write\|edit"','"Write|Edit"' | Set-Content .dsh\hooks.json
node tools\verify-hooks-bridge.mjs  # 期望：出现 FAIL（PostToolUse 的两条用例取不到钩子）
node tools\check-dsh.mjs            # 期望：提示 matcher 用了 Claude Code 拼写
node tools\build-dsh.mjs             # 还原
```

实测（本会话跑过）：桥协议报
`FAIL PostToolUse: an edited skill file yields the regeneration advice` 与
`FAIL PostToolUse: an invalid data file is blocked`；
`check-dsh` 报 `hooks.json PostToolUse: matcher "Write|Edit" uses Claude Code tool spelling; DSH tool names are lowercase`。
还原后恢复 `11/11` 与 `errors=0 warnings=0`。

---

## 3. 独立复现最小闭环（最花时间，但最值得）

第 1 节验的是**结构**；"技能真能用"只能靠跑。做法是**隔离副本**，不碰主仓库：

```pwsh
$s = 'D:\Work\dsh\.smoke\verify-run'
Remove-Item $s -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $s | Out-Null
foreach ($d in '.claude','dsh-src','tools','docs','DSGS Skill Testing Framework') {
  Copy-Item -Recurse -Force (Join-Path 'D:\Work\dsh' $d) (Join-Path $s $d)
}
foreach ($f in 'AGENTS.md','CLAUDE.md','project.yaml','README.md') {
  Copy-Item -Force (Join-Path 'D:\Work\dsh' $f) (Join-Path $s $f)
}
foreach ($d in 'design','production','src','tests','assets','prototypes') { New-Item -ItemType Directory -Force (Join-Path $s $d) | Out-Null }

Push-Location $s
node tools\build-dsh.mjs ; node tools\check-dsh.mjs     # 期望：与主仓库同样的 0 error
git init -b main ; git add -A ; git commit -m baseline
Pop-Location
```

然后在 DSH 里把会话开在 `D:\Work\dsh\.smoke\verify-run`，依次调用：
`/start` → `/setup-engine`（Godot）→ `/brainstorm` → `/create-stories` → `/dev-story` → `/story-done`。

**期望产出**（框架仓库的验收台账记录了第一次完整跑通的清单）：

```
design/game-brief.md
production/epics/<slug>/{EPIC.md,story-001….md,index.md}
config/<slug>.cfg、src/gameplay/*.gd、project.godot
production/qa/evidence/**（截图）
production/session-state/active.md
```

两条必须知道的运行注意（都写进了技能注记，跑的时候会出现在技能正文里）：
- Windows 上探测 Godot 版本要用 `*_console.exe`（主 exe 的 stdout 是空的）；
- 受限沙箱里跑引擎要先 `$env:APPDATA = "$PWD\.godot-appdata"`，否则 Godot 起不来（`user://logs` → signal 11）。

`.smoke/` 已在 `.gitignore` 里，跑完可以整个删掉。

---

## 4. 这套验证**不能**证明什么（诚实清单）

1. **bash 原版与 Node 端口的逐字节等价**：本机沙箱里 Git Bash / WSL 起不来
   （MSYS `couldn't create signal pipe` / WSL `E_ACCESSDENIED`），只能做 Node 侧用例。
   要拿这个结论，请在**普通终端**里跑 `node tools/yaml-helper.test.mjs`（默认即与 bash 对照）。
2. **74 个技能都行为可用**：本会话行为实测过约 15 个（闭环 6 + 评审 4 + 导航 3 + 零散），
   其余是**结构级**验证（引用存在、frontmatter 合法、脚本有 Node 端口）。
3. **你 web profile 里的钩子已挂载**：`check-hooks-live.ps1` 说 `LIVE` 才算数；
   headless 那次证明的是"同一份配置 + 同一版插件在真实会话里能触发"。
4. **PreToolUse 的提醒可达**：桥在 `tools/pre-execute` 上只映射 deny/ask，实测会打印
   `systemMessage … is not yet surfaced (ignored)`。所以 `validate-push` 的保护分支提醒、
   `validate-commit` 的硬编码值/TODO 警告到不了模型；它们的**阻断**仍然有效。
5. **子代理能问人 / 能再委派**：都不能（`ask_user_question` 在子代理里失败；默认 `maxDepth: 1`）。
6. **profile 级钩子对别的项目无副作用**：目前**有**——钩子是 profile 级的，
   在别的目录工作时会看到本工程的会话上下文（实测过）。（见仓库 README 的说明）。

---

## 5. 验证代码清单（哪个脚本证明什么）

| 脚本 | 证明 | 不能证明 |
|---|---|---|
| `tools/build-dsh.mjs` | 生成链可重复：`.claude/` + `dsh-src/` → `.dsh/`（含路径/工具名/`!` 预执行/matcher/`@` 导入合并） | 生成内容是否语义正确 |
| `tools/check-dsh.mjs` | 生成物与源一一对应、技能 frontmatter 合法、无残留 Claude 专有 token、matcher 用 DSH 工具名、hooks.json 引用的脚本存在 | 技能能不能跑 |
| `tools/audit-skill-refs.mjs` | 技能引用的框架路径都存在；`.sh` 调用都有 Node 端口；没有陈旧 `.sh` 文件名 | 引用内容的语义 |
| `tools/verify-hooks-bridge.mjs` | 用 DSH 真实协议（`runHook`/`parseHookOutput`/`mergeHookOutputs`）执行生成的配置：11 条用例覆盖 12 个移植钩子 | 插件是否被加载 |
| `tools/verify-hooks-mount.mjs` | 调用桥**真实 `apply()`**（只替换 Cordis 上下文表面）：7 个事件接上、10 条用例覆盖允许/警告/阻断/审计落盘 | profile 加载器是否挂载 |
| `tools/preflight-hooks.mjs` | 挂载前静态条件：patch 条目、`configPath`、命令与 matcher 合法、**桥版本与运行时兼容**、挂载期依赖可从 profile 解析 | 运行时行为 |
| `tools/check-hooks-live.ps1` | 钩子是否真的在会话里跑过（依据 `production/session-logs/agent-audit.log`） | 单个钩子的正确性 |
| `tools/verify-port.ps1` | 一条命令跑完上面 6 步并汇总 | 最小闭环（那要跑技能） |
| 框架仓库的测试套件（24 套） | 13 个钩子 + 9 个辅助脚本 + 配置解析器的行为 | 技能层 |
| `tools/yaml-helper.test.mjs` | 配置解析器与 bash 原版的逐字节等价（**需要能跑 bash 的机器**） | 其余部分 |

---

## 6. 记录表（建议你自己勾一遍）

| # | 检查 | 命令 | 期望 | 你的结果 |
|---|---|---|---|---|
| 1 | 全链路 | `pwsh -File tools\verify-port.ps1` | 6/6 ok，24 套件绿 | |
| 2 | 引用审计 | `node tools\audit-skill-refs.mjs` | missing 0 / shellWithoutPort 0 | |
| 3 | 钩子协议 | `node tools\verify-hooks-bridge.mjs` | 11/11 | |
| 4 | 钩子挂载 | `node tools\verify-hooks-mount.mjs` | 10/10 | |
| 5 | 配置解析 | 见 §1F（含 rigor 对照实验） | 六旋钮联动 | |
| 6 | 部署预检 | `node tools\preflight-hooks.mjs` | PREFLIGHT OK | |
| 7 | 活体触发 | §1H 的 headless 配方 | 审计日志两行 | |
| 8 | 主 profile | 重启 `dsh web` 后 `tools\check-hooks-live.ps1` | LIVE | |
| 9 | 负向验证 | §2 三条任选 | 都能报错并还原 | |
| 10 | 品牌残留 | `Get-ChildItem .dsh -Recurse -File -Include *.md,*.mjs,*.json,*.yml,*.yaml \| Select-String -Pattern 'CCGS\|Claude Code Game （见仓库 README 的说明）
| 11 | 钩子事件活体 | `node tools\verify-hooks-events.mjs`（创建一次性 profile，跑完自删） | 6/9 LIVE + 3 mount-only | |
| 12 | bash↔Node 对照 | `node tools\tests\parity\bash-vs-node.test.mjs` | 有 bash 则真对照；没有则显式 SKIP 并列出应比对项 | |
| 13 | statusline 端口 | `node tools\tests\scripts\statusline.test.mjs` | 13 passed | |
| 14 | 最小闭环 | §3 | 六步产出齐全 | |
| 15 | **内容保真（不缺件）** | `node tools\verify-fidelity.mjs` | `unexplained 0` + "No content loss"（258 文件 / 42895 行） | |
| 16 | **插件可分发** | `pwsh -File tools\publish.ps1`（默认 dry run） | 建出 `dist/dsgs-hooks`（1 commit + tag）+ bundle；包自测 3/3；打印推送命令 | |



