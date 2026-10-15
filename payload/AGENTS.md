# AGENTS.md — 本项目的 AI 使用说明

> 这份文件由 **DeepSeek Game Studios (DSGS)** 初始化时写入，是本项目里每一个 AI 会话
> **每次启动都会自动读取**的指令文件。它只讲"这个项目怎么用"，不讲任何与框架维护有关的事。
> 你（AI）应当把它当作本项目的最高优先说明；与用户当轮的直接要求冲突时，以用户为准。

## 1. 这是什么项目

一个用 DSGS 工作室流程开发的游戏项目。仓库里有两类东西，**不要混淆**：

| 目录 | 是什么 | 你该怎么做 |
|---|---|---|
| `.claude/` | **内容源**：技能、代理、规则、钩子的原始定义（英文原文） | 可以读、可以改；改完要重新生成 |
| `.dsh/` | **生成物**：由 `tools/build-dsh.mjs` 从 `.claude/` 生成，DSH 实际加载的就是这里 | **不要手改**，改了下次生成会被覆盖 |
| `dsh-src/` | 手写的 DSH 专有叠加层，生成时并入 `.dsh/` | 这里是 DSH 专有内容的正确落点 |
| `tools/` | 脚本：生成器、校验器、各类 Node 端口 | 直接 `node tools/<name>.mjs` 调用 |
| `design/` `production/` `docs/` `src/` `assets/` `tests/` `prototypes/` | 项目资产：设计文档、制作计划、源码、资产、测试、原型 | 你日常真正要读要写的地方 |

改完内容后的固定动作：

```pwsh
node tools/build-dsh.mjs     # 重新生成 .dsh/
node tools/check-dsh.mjs     # 结构校验，0 error 才算健康
```

## 2. 引擎锚点（`/setup-engine` 写这里）

技能里凡说"把引擎配置写进 `AGENTS.md`"，指的就是下面这块。**引擎、语言、构建系统的当前值以这里为准**：

- **Engine**: [CHOOSE: Godot 4 / Unity / Unreal Engine 5]
- **Language**: [CHOOSE: GDScript / C# / C++ / Blueprint]
- **Build System**: [SPECIFY after choosing engine]
- **Asset Pipeline**: [SPECIFY after choosing engine]

<!-- ENGINE-REFERENCE-IMPORT: 选定引擎后，这一行会被改写成该引擎的版本参考路径。
     DSH 不展开 `@` 导入，所以引擎版本参考的实际加载路径是 .dsh/docs/studio-rules.md（合并版），
     或按需直接读 docs/engine-reference/<engine>/VERSION.md。 -->

## 3. 工作室规则怎么加载（DSH 不展开 `@` 导入）

上游风格的项目会在 `CLAUDE.md` 里用 `@path` 拉进共享规则（目录结构、协作规则、编码标准、引擎版本参考）。
**DSH 不解释这种导入**，所以这些规则的实际加载路径是：

**`.dsh/docs/studio-rules.md`**（合并版）—— 做任何流程性工作前读一次。

按需还要读的：

| 需要什么 | 读哪里 |
|---|---|
| 配置项的含义与优先级 | `.dsh/docs/config-resolution.md`、`.dsh/docs/effects-map.md` |
| 编码标准 | `.dsh/docs/coding-standards.md` |
| 部门协作边界 | `.dsh/docs/coordination-rules.md` |
| 目录结构约定 | `.dsh/docs/directory-structure.md` |
| 引擎 API（选定引擎后） | `docs/engine-reference/<engine>/VERSION.md` |

## 4. 技能怎么用

- 技能在 `.dsh/skills/<name>/SKILL.md`，用户用 `/name` 调用，你用 `skill` 工具加载（技能目录里会自动出现）。
- frontmatter 里 **DSH 只读** `name`、`description`、`whenToUse`、`user-invocable`、`disable-model-invocation`、`metadata`。
  其它字段（`argument-hint`、`allowed-tools`、`model` 等）**原样保留但被忽略**，属于惰性存在，不要改动它们。
- 技能里以 `!`cmd`` 写的**预执行行在 DSH 不生效**，已被改写成「前置命令」块：
  **需要你自己运行那条命令**，并把输出当作下文已解析的上下文。
- 技能里若出现 `bash …`，注意 shell 只有 `pwsh`；框架自带的辅助脚本都有 Node 端口，
  直接 `node ".dsh/scripts/<name>.mjs" <参数>`。只有未移植的 `.sh` 才需要 Git Bash 绝对路径，
  而在受限会话里它同样会失败。

## 5. 工具使用陷阱（实测踩到过，别再踩）

1. **`glob` 不要同时给「带 `/` 的模式」和 `path`** —— 该组合实测返回空。可靠写法二选一：
   `glob(pattern="SKILL.md", path="<根>/.dsh/skills")`（纯基名 + 目录），
   或 `glob(pattern=".dsh/skills/*/SKILL.md")`（不给 `path`，从工作区根写完整相对模式）。
2. **没有 `bash` 工具**：shell 只有 `pwsh`。看到 ` ```bash ` 围栏时，里面的 POSIX 命令要自行改成 pwsh 等价形式。
3. **`ask_user_question` 在子代理里不可用**（会报 `human interaction is unavailable while the calling agent is
   owned by another live agent`）。被委派的技能若要人工批准，只能把问题**返回给调用方**，不要替用户决定。
4. **`resolve_config --keys` 的键名形式必须写对**：有的键是裸名（`rigor`、`review_mode`、`qa.level`），
   有的是命名空间形式（`docs.density`、`testing.strict`）；写错形式会**静默返回空块且 exit 0**（看着正常，其实什么都没有）。
   拿不准就用 `node tools/yaml-helper.mjs __call resolve_setting <dotted.path>`（两种形式都有效）。
5. **`__call <函数>` 的输出没有结尾换行**（与上游 `printf '%s'` 一致）：不要把两次 `__call` 的输出拼起来读。

## 6. 配置解析

- `project.yaml` 是**单一配置来源**；个人偏好写 `project.local.yaml`（gitignored，仅白名单键生效）。
- 解析命令（DSH 原生，不依赖 bash/python/jq）：

  ```pwsh
  node tools/yaml-helper.mjs resolve_config --keys review_mode,workflow,qa.level
  ```

- `modes.rigor`（默认 `minimal`）会展开 6 个旋钮；用户问"当前模式/严格度"时先读它。

## 7. 子代理委派

- `.dsh/agents/<name>.md` 是**角色卡**，不是可自动加载的代理定义——委派时把角色卡内容作为提示词给出。
- 先读 `.dsh/agents/README.md`：那里写了本项目的委派约定。
- 互相独立的委派在**同一条消息里一起发起**；需要本会话上下文时用 `subagent_fork`；批量同一流程用 `workflow`。
- 子代理不得跨部门改文件（见 `.dsh/docs/coordination-rules.md`）；越界要返回给调用方，而不是自行决定。

## 8. 路径规则（用钩子替代了上游的路径作用域引擎）

你在 `write` / `edit` 之后，钩子会把命中的 `.dsh/rules/*.md` **原文**作为上下文注入给你：

1. 按注入的原文**检查并修正**刚才的改动；不通过的项要在回复里说明；
2. `.dsh/rules/INDEX.md` 是"哪条规则管哪些路径"的索引，可人工核对；
3. 没收到注入时（路径不匹配任何规则，或钩子桥未挂载），按 `.dsh/docs/coding-standards.md` 的通用标准执行，
   必要时自己读 `.dsh/rules/` 下匹配的文件。

**没按规则改代码 = 违反标准**，`/code-review` 会按这个口径审。

## 9. 钩子

- 钩子跑的是 Node 版本（`.dsh/hooks/*.mjs`），配置在 `.dsh/hooks.json`，经 DSH 的钩子桥触发。
- 触发点：会话开始/结束、提交、推送、写资产、子代理 spawn/stop、压缩前后。
- **钩子拦下操作时（exit 2 / deny）**：按它给的理由修正后重试；不要绕过、不要改钩子来消音。
- **"事前提醒"在这个平台上做不到**：`tools/pre-execute` 只能 allow/deny/cancel/ask。所以告警类钩子
  （提交信息校验、推送保护）注册在**动作之后**送达；想"动作前必须面对"，就把该插件行设为 `advisory: deny`。
  阻断始终在动作前生效。
- 钩子没生效时，先确认 harness 已重启（profile 的插件行只在启动时挂载），再查 `.dsh/hooks.json` 是否被读到。

## 10. 协作协议（与上游一致）

**问 → 选项 → 用户决定 → 草稿 → 批准。** 任何写文件前先问
"May I write this to `<path>`?"；多文件改动要整批获批；**没有用户指令不要提交**。
被编排技能点名了目标路径的例外条款见 `.dsh/agents/creative-director.md`。

## 11. 会话检查点

`production/session-state/active.md` 是**记忆**，不是对话。
压缩、崩溃或 `/clear` 之后，**先读它**再干活；重要节点主动更新它。

## 12. 工具名映射（上游写法 → 本平台）

`Read`→`read`、`Write`→`write`、`Edit`→`edit`、`Grep`→`grep`、`Glob`→`glob`、`Bash`→`pwsh`、
`AskUserQuestion`→`ask_user_question`、`WebSearch`→`web_search`、`WebFetch`→`web_fetch`、
`TodoWrite`→`todo_write`、`Agent`/`Task`→`subagent`（一次性/可续）或 `workflow`（批量编排）。

## 13. 输出语言

- 面向用户的一切（提问、选项、报告标题与正文、解释、状态行）用**用户当前使用的语言**（默认中文）。
- 技能/规则正文里的英文是原文，**按语义执行**，不要照搬英文措辞。
- **绝不翻译**（其它技能与钩子会读取，改了就会坏）：
  裁决词与状态枚举（`PASS` / `FAIL` / `CONCERNS` / `NOT ASSESSED` / `READY` / `NEEDS WORK` / `BLOCKED` /
  `COMPLETE`、`> **Status**: Complete` 这类落盘状态）、YAML 键、frontmatter 字段、命令、路径、文件名、
  技能用于定位的章节标题（`## Formulas`、`## Acceptance Criteria` …）与模板占位符。
- 展示可以「原文 + 中文注释」（`PASS（通过）`），**落盘只写原文**。

## 14. 升级这个项目的框架

框架内容更新后（技能/规则/钩子的新版本），用以下任一方式把新版铺进本项目：

```pwsh
# 方式一：从机器级载荷重新初始化（幂等，只补缺失文件，不覆盖你已有的改动）
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\dsgs\tools\dsgs-init.ps1" -Target . -Confirm

# 方式二：只看会写什么，不实际写
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\dsgs\tools\dsgs-init.ps1" -Target .
```

撤销某次初始化：给同一个脚本加 `-Undo`（它只删除自己写过的、且记录在 `.dsgs-installed.json` 里的项）。
