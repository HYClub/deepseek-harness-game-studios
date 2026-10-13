# 当前版本的最小闭环实测（`.smoke/verify-current`）

**结论：最小闭环可用。** 6/6 技能按其正文执行完毕，**3/3 story Complete**、**24/24 验收标准通过**、
**5 张真实引擎截图**、**6 次真实引擎运行全部 exit 0**。框架本体未被改动（已核对：根目录没有 `.godot`、
`project.godot`、`src/board.gd`）。

运行方式：把当前树（品牌/文档/钩子都已是最新）复制成隔离副本 → 由**一个子代理**以
`modes.automation: autonomous` 跑完整闭环（它不能问人，每个"问用户"的门都改成"决策 + 记录理由"，
见副本的 `production/session-logs/decisions.md`，25 条决策）。

## 六步与产出

| 步骤 | 做了什么 | 产出 |
|---|---|---|
| `/start` | 全新模板 → 路径 C；写 `project.stage: Concept` + `production/stage.txt`、`modes.rigor: minimal`、`modes.automation: autonomous` | `project.yaml`、`production/stage.txt` |
| `/setup-engine` | 用 **console twin** 探测版本（4.6.2 mono），填 `AGENTS.md` 引擎锚点，写 `project.yaml` 四个块，建并导入工程 | `AGENTS.md`、`project.yaml`、`docs/engine-reference/godot/VERSION.md`、`project.godot` |
| `/brainstorm` | `workflow: minimal` → Lean Brief；产品 **Stackfall**（单井落块），MVP 砍到 3 项 | `design/game-brief.md` |
| `/create-stories` | 合成隐式 epic + 3 条 coarse story（各 8 AC） | `production/epics/stackfall-core/EPIC.md` + 3 个 story |
| `/dev-story` | 按 build order 实现；真实输入经 `Input` 单例；**2 次引擎运行**定位并修掉渲染 bug | `src/board.gd`、`piece.gd`、`main.gd`、`main.tscn` |
| `/story-done` | 逐条核对 AC、写证据、置 `Status: Complete`、更新会话检查点 | 3 × `production/qa/evidence/*-evidence.md`、`active.md` |

## 引擎真的跑了：6 次，全部 exit 0

`4.6.2.stable.mono.official.71f334935` · Vulkan 1.4.325 / Forward+ / RTX 3060 Ti。

- `--headless --import` → exit 0
- `node .dsh/scripts/godot-parse-check.mjs res://src/{board,piece,main}.gd` → `ok:` ×3，exit 0
- 文档里的 `--write-movie` 捕获路径 → “120 frames at 60 FPS”，exit 0
- 场景 `fall` → `LOCK 1 … frame=77`、`LOCK 2 … frame=143`、200 帧捕获，exit 0
- 场景 `stack`（`Input.action_press` 真实按键）→ `frames=135 locks=3 moves=43 refused=51`，exit 0
- 场景 `clear` → `CLEAR rows=1 score=100 frame=138`，exit 0
- 场景 `fall --capture-on-over` → `GAME_OVER … locks=11 frame=440`，exit 0
- 700 帧无人值守运行（AC-8），exit 0

唯一 stderr 噪音是 `Failed to read the root certificate store.`（重定向 APPDATA 导致，每次运行都有，属环境）。

**"必须看图"这条规则再次立功**：第一次捕获里棋盘停在 frame 1，而 stdout 明明报了两次 `LOCK`——
原因是 `_draw()` 只在没有 `queue_redraw()` 时跑一次。语法检查干净、逻辑正确、日志健康，**只有打开 PNG 才发现**。

## 截图（5 张，互不重复，均来自真实运行）

| 字节 | 路径 |
|---|---|
| 8849 | `production/qa/evidence/story-001-the-well-and-the-fall/01-well-and-fall.png` |
| 8559 | `…/story-001…/02-write-movie-frame-119.png` |
| 8997 | `…/story-002-the-players-hands/01-stack-after-moves.png` |
| 15671 | `…/story-003-line-clear-score-and-game-over/01-line-clear-score.png` |
| 25431 | `…/story-003…/02-game-over.png` |

## 验收：24/24

story 001 8/8 · 002 8/8 · 003 8/8。`story-status.mjs` → `COMPLETE 3 of 3`。
一条诚实的保留：002 的 AC-8 依据的是 `active == null or game_over` 守卫 + `GAME_OVER` 后 440 帧无状态变化，
**不是**脚本化的"结束后按键"用例——已按此写进 story 的 Completion Notes 与证据记录。

## 子代理未能做到 / 绕过的（如实）

1. **多代理编排 NOT ASSESSED**：`/dev-story` Phase 3–4 要求派 `engine-programmer` + `godot-gdscript-specialist`，
   但 `subagent depth 2 exceeds maxDepth 1`（探针确认），它自己写了代码。DSH 技能注记已记录这一退化，但
   **`/dev-story` 的"专家评审"那一半从未被执行**。
2. 用 `GODOT_BIN` 绕过 F3（**现已修复**，见下）。
3. `commands.test` 仍指向不存在的 gdUnit4（见 F2），未擅自换成未授权的命令。
4. `commands.build` 是 `[TO BE CONFIGURED]`（无 `export_presets.cfg`，§5.5.1 禁止硬编码预设名），未跑构建。
5. 无 `--headless` 游戏运行：`--headless` 不渲染，产不出要求的截图。
6. 沙箱里没有可呈现桌面，窗口化运行只有 ~8.6 fps——对增量驱动的逻辑无害，但长捕获很贵。
7. 任务里给的 Godot 路径**少一层目录**（安装实际嵌在更深一层）。不是框架缺陷，但会让照抄的人失败。
8. 未 git commit（副本没有可用仓库状态，也没要求提交）。
9. **`production/epics/index.md` 不存在** → 报告而非静默跳过（符合 `/create-stories` 要求）；
   `production/sprint-status.yaml` 不存在 → 进度只存在于 story 文件，这是 `minimal` 档的既定行为。

## 框架缺陷（7 条，含技能原文引用）

| # | 缺陷 | 性质 | 状态 |
|---|---|---|---|
| **F1** | `/setup-engine` §5 命令"创建或更新 `.dsh/docs/technical-preferences.md`"，而**同一技能注入的 DSH 注记**说"那是生成物、别手改"；§5.5.3 又把这次双写当作门禁要求读回核对——**两者无法同时满足** | 移植侧（注记与正文冲突） | 待修（下一轮：把注记改成"DSH 侧只写 `project.yaml`，双写核对在本移植改由 `project-coherence.mjs` 承担"） |
| **F2** | `minimal` 路径必然留下 `commands.test` 指向**从未安装**的 gdUnit4（`/test-setup` 不在该路径），而 §8.5 又要求"报告并解决每个 `[DIFFERS]`"——每个新建 minimal 项目都会在自己的门禁上失败 | 上游框架 | 报给上游 |
| **F3** | `.dsh/scripts/godot-parse-check.mjs` **忽略 `engine.path`**，与 `/dev-story` Phase 6 明写的顺序（`commands.test` → `engine.path` → PATH）矛盾；`project-coherence.mjs::probeGodot` 却是对的，两个脚本互相矛盾 | **我们移植侧** | ✅ **已修并复现验证**：改用已测试的 YAML 解析器读 `commands.test`/`engine.path`；副本上现在 `ok: res://src/board.gd`、exit 0 |
| **F4** | `/create-stories` 的 minimal 分支要求写 `EPIC.md`，但 `.dsh/docs/templates/` 38 个模板里**没有 epic 模板**——两个下游消费者读的容器每次靠临场发明 | 上游框架 | 报给上游（与 category 模式里 `create-epics`/`create-stories` 的 P1 WARN 同源） |
| **F5** | AGENTS.md 声称"`--keys` 只认裸标签、命名空间键静默返回空"——**两个方向都错**：实测 `docs.density`、`testing.strict` 有效，而裸 `density` 返回空；且它推荐的 `node tools/yaml-helper.mjs --keys 全部` **不是有效调用**（打印 usage 却 exit 0） | **我们移植侧** | ✅ **已按实测改正 AGENTS.md**（两处过时说法一并修，并给出 `__call resolve_setting` 这条可靠路径） |
| **F6** | `src/CLAUDE.md` 规定"玩法数值必须 data-driven（外部配置）"，但 minimal 闭环里**没有任何地方**说明那个文件叫什么、放哪、什么格式 | 上游框架 | 报给上游 |
| **F7** | brief 模板说"每个 MVP 条目变成一条 story，超过 ~7 条就不是 MVP"，而 `minimal` 同时宣传"4 步出第一行代码"、`story_granularity: coarse` 又要每 story 5–10 个 AC——作者被迫在"诚实的 MVP 列表"和"story 条数"之间选 | 上游框架 | 报给上游 |

**确认与既有记录一致（非新缺陷）**：`__call` 输出无尾随换行；子代理不可用 `ask_user_question`；
`glob` 同时给带 `/` 的模式与 `path` 返回空（子代理按 AGENTS.md 的写法用 `path` + 基名，全程正常）。

## 框架表现好的地方（子代理自己点名）

- `/start` 的 rigor 展开：**一次 `modes.rigor` 写入正确驱动了 6 个旋钮**，并拒绝被显式钉住；
- `project-coherence.mjs` 作为读回步骤（没抓到错正是它的价值），其 `engine.path` 探测正确解析了 console twin；
- `run-and-observe.md` 的两条 Godot 捕获路径都可用，且**"语法检查不是运行"**这条规则抓到了真 bug；
- `minimal` 档确实跳过了 GDD/ADR/清单/TR 注册表，且每个技能都**自报跳过**而不是静默省略。
