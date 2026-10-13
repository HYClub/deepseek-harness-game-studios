# 上游机制 → DSH 等价物（差异对照）

上游那份框架为**另一个运行时**写的。这个移植把内容全量搬了过来，但有几个机制在那个运行时里是
"内建"的，在 DSH 里必须换一种做法。**这份文档就是那张对照表**——凡是上游文档里提到、而你在 DSH
里找不到的东西，这里说明它对应什么。

| 上游机制 | 在上游怎么用 | DSH 怎么做 | 能不能做到一样 |
|---|---|---|---|
| **statusline**（状态行） | 运行时把会话状态渲染成一行：`ctx% \| model \| 阶段 [\| Epic > Feature > Task]` | DSH **没有状态行展示面**（已核实）。等价物：`node .dsh/statusline.mjs`（忠实复刻输出行）+ 会话开始时钩子注入的项目状态 | ⚠️ 输出一样的行，但没有内建展示位 |
| **代理的工具白名单**（每个代理声明 `tools:`，只能用这些工具） | 运行时按 frontmatter 限制该代理可用工具 | DSH 没有 per-agent 工具权限，工具可用性由**会话权限**决定。等价物：角色卡正文的边界约定 + `.dsh/agents/README.md` 的委派规则（"子代理不得跨部门改文件"） | ❌ 机制不同，靠约定而非强制 |
| **PreToolUse 的告警**（`systemMessage` 提醒模型"别硬编码"等） | 运行时把告警文本回传给模型 | **实测结论（两次活体实验，2026-10-10）**：DSH 的 `tools/pre-execute` 契约**只有 deny/ask**——从 pre-execute 结果返回 `additionalContexts` 时，`dsh-agent-loop` **只从"工具最终结果"读这个字段**（harness 自带的 `repeat-tool-reminder` 也绑在 `tools/post-execute`），所以 pre 阶段的上下文**进不了对话**；在工具执行中调 `agent.inject()` 同样无可观测效果。**已实现**：`validate-commit` / `validate-push` 这两个告警型钩子**同时注册在 PostToolUse 上**，告警以 `additionalContext` 到达模型（该通道实测可达，`verify-hooks-bridge` 有专门用例）；**阻断**行为仍在 PreToolUse（deny/ask 照常生效）。复现方法见插件 README 的 "Known platform limits" | ⚠️ 提醒的时机从"事前"变成"事后"，**DSH 无法复刻"事前"**；语义保留 |
| **子代理模型环境变量** | `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)` 控制所有子代理的模型 | DSH 在 `subagent` / `workflow` 的**调用处**指定模型（每个角色可以不同档位） | ✅ 更细粒度 |
| **agent teams**（多会话协作，靠环境变量开关） | 多个独立会话共享任务列表协作 | DSH 用 **`workflow` 工具**做 fan-out（`pipeline` 优于 `parallel`，`filter(Boolean)` 兜住失败项）。见 `.dsh/docs/agent-teams.md` 的 DSH 说明 | ✅ 同类能力 |
| **`CLAUDE.local.md`**（个人覆盖，gitignored） | 放在仓库根，覆盖团队配置 | DSH 用 **`project.local.yaml`**（仅白名单键生效，gitignored）+ `AGENTS.md` | ✅ 同类能力，键受限 |
| **代理按名字自动发现** | 运行时扫代理目录，按 `name` 直接调用 | DSH **不自动加载代理定义**：调用方读角色卡，把卡片正文作为 `subagent`/`workflow` 的 prompt（约定见 `.dsh/agents/README.md`） | ❌ 机制不同 |
| **钩子经沙箱 shell 执行** | 运行时用自己的 shell 跑钩子命令 | DSH 上这条链会**静默失败**（Windows ACL 沙箱拒绝派生时，协议把它咽成 allow）→ 本移植改用**直连执行插件**（`tools/dsh-plugin/`），并固定钩子工作目录为项目根 | ⚠️ 平台差异，已修 |
| **子代理深度/提问** | 子代理可再派子代理、可向用户提问 | **多层委派在 DSH 是可开启的，不是限制**：设置项 `maxDepth`（UI 文案 "Maximum recursion depth"，0=禁用 / 1=只有主代理能派 / N 层），**默认 1**。存储位置已实测：**`$DSH_HOME/settings.yaml` 的 `subagent:` 段**，例如 `subagent:\n  maxDepth: 2`（写在 profile 目录里的同名文件**不生效**——踩过）。设成 2 后实测：父 → 子 → 孙三层链路成功，孙代回的词原样传回主代理。**子代理仍不能用 `ask_user_question`**，需要人工裁决的问题必须回到主代理（或由子代理 `send_message` 给父代理） | ✅ 机制可开（默认 1，需显式设置）；提问仍需回主代理 |
| **`@path` 导入** | 指令文件里的 `@file` 会被展开 | DSH **不解释** `@path` 导入 → 合并版在 `.dsh/docs/studio-rules.md`（`AGENTS.md` 指明要读它） | ⚠️ 内容不丢，加载方式不同 |

## 三条不变的约定

1. **内容源是唯一的**：`.claude/` 是原始内容，`.dsh/` 由 `node tools/build-dsh.mjs` 生成。改内容改上游那份，
   重新生成；不要手改 `.dsh/`。
2. **上游文档原文保留**：`.dsh/docs/` 里的文档是上游原文的移植（只做路径与品牌改写）。上面这些差异
   不会从文档里删掉——它们在这里统一登记。
3. **机制有差异，验收标准不变**：技能产出物、阶段门、验收证据这些要求在上游与 DSH 完全相同。
