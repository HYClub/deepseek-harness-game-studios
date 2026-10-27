# DSGS 下一阶段功能方案（三批 · 一批一版本）

> 依据：从 `.dsh/` 实测出的三个缺口（Office 产出 0 次、`present` 0 次、无每日入口），
> 以及仓库真实数据源（`project.yaml` / `production/sprint-status.yaml` / `production/epics/*/story-*.md` /
> `production/session-state/active.md`）。
> **本文件是内部计划，不进载荷。** 每项都写清：用户看到什么、动哪些文件、怎么验、怎么退。

---

## 0. 总原则

| 原则 | 做法 |
|---|---|
| 数据只读现有文件 | 不新增"必须手填"的配置；读不到就**降级**并说明，不编造 |
| 计算交给脚本 | 计数、进度、状态判定用 `.mjs`；模型只负责措辞与建议 |
| 新增能力都是 **DSGS 专有技能** | 放 `dsh-src/skills/<name>/`，不碰上游 74 个技能（保真不受影响） |
| 一批一版本 | 每批：实现 → 重建 → 门禁全绿 → 一次发版 |
| 每项必须有"空项目也能跑"的行为 | 缺 `sprint-status.yaml` 时给出明确提示，不崩 |

---

## 第一批：`/today` + `/dashboard`（同源，先做）

### 共用底座：`project-state.mjs`（新脚本）

- 路径：`dsh-src/scripts/project-state.mjs` → 生成到 `.dsh/scripts/`
- 输出：**一行 JSON**（稳定 schema，供两个技能消费）
- 读取顺序与降级规则：

| 字段 | 来源 | 读不到时 |
|---|---|---|
| `engine` / `language` | `project.yaml` → `engine.*`（经 `tools/yaml-helper.mjs __call resolve_config`） | `null` + `warnings[]` |
| `stage` | `production/session-state/active.md` 里的阶段标记，否则 `project.yaml` | `unknown` |
| `sprint` | `production/sprint-status.yaml`（`sprint.number`、`goal`） | `null` |
| `stories` | `production/epics/*/story-*.md` 的 `> **Status**` 行（复用 `story-status.mjs` 的判定规则）；每条另带 `date`（git 最后提交日期，无 git 时退回 mtime） | `[]` |
| `blockers` | 状态含 `blocked` 的 story + `active.md` 的阻塞段 | `[]` |
| `gates` | 最近一次 `/gate-check` 结论（若 `production/gates/` 有记录） | `null` |

> 复用现有规则：状态枚举与 `story-status.mjs` 完全一致（`review/progress/todo/blocked/other`），
> 避免"两个地方数出不同结果"——这正是过去踩过的坑。

### ① `/today`

- 用户看到：**3–5 行**——今天做哪个 story、卡在哪、下一条该跑什么命令。
- 文件：`dsh-src/skills/today/SKILL.md`（约 70 行，参考 `statusline` 的 91 行）
- 不做：不写文件、不改状态、不派代理。
- 验收：
  - 有 sprint 数据 → 输出含 story 编号、状态、下一个命令；
  - **空项目**（无 epics、无 sprint）→ 输出"还没有故事，先跑 `/map-systems`"，**退出码 0**。

### ② `/dashboard`

- 用户看到：**单文件 HTML**（阶段 / 姿态 / Sprint / story 进度 / 饼·柱·折线三图 / 阻塞 / 警告），用 `present` 打开；范围 7/30/90/全部对三张图同时生效。
- 文件：`dsh-src/skills/dashboard/SKILL.md` + `dsh-src/scripts/render-dashboard.mjs`
- HTML 约束：**无外链、无 CDN、无 JS 依赖**（离线可看）；样式内联。
- 输出位置：`.dsh/dashboard.html`？→ **改为** `production/dashboard.html`（用户项目里可见、可提交），并加入 `.gitignore` 建议？——**决定**：写到 `production/dashboard.html`，因为它是项目产物；不自动改 `.gitignore`，在技能里提示。
- 验收：
  - 生成的文件在浏览器打开无空白页；`grep '<script src'` 为空；
  - 空项目 → 生成"未初始化"页而不是报错。

**第一批工作量**：2 技能 + 2 脚本 ≈ 5 个文件，约 300 行；预计 1 个会话内完成 + 发版。

---

## 第二批：Office 交付物四件套

> 依赖 DSH 自带技能：`office-docx` / `office-xlsx` / `office-export-pdf`（技能目录里已存在，实测可用）。

| 技能 | 输入 | 输出 | 复用模板 |
|---|---|---|---|
| `/gdd-export` | `docs/gdd/<system>.md`（或指名的 GDD） | `production/exports/<system>-gdd.docx` | `.dsh/docs/templates/gdd*` |
| `/playtest-sheet` | `production/playtests/*.md`（试玩记录） | `production/exports/playtest-<date>.xlsx`（通过率、问题分类、按关卡） | 无 → 新建模板 |
| `/balance-sheet` | `docs/gdd/*.md` 里的 `## Formulas` 表 + `production/tuning/*.csv` | `production/exports/balance-<date>.xlsx`（公式可算） | 无 → 新建模板 |
| `/release-pack` | `production/releases/<version>/` + `CHANGELOG` | `production/exports/release-<version>.pdf`（清单 + 补丁说明） | 发布清单模板 |

**共同规则**：

1. **只读源文件，不重写源**；导出物放 `production/exports/`（新建目录，技能里提示加入 `.gitignore` 与否由用户决定）。
2. 缺源文件 → 明确指出"缺什么、该跑哪个技能生成"，不生成空文档。
3. 数值表必须**由表格承载**，正文里不重复贴表（否则两处数字会不一致）。
4. 验收：
   - 生成的文件能被 `office-xlsx`/`office-docx` 重新打开并读回单元格/段落数；
   - `/balance-sheet` 的工作表里公式是**真公式**（`=SUM(...)`），不是算好的常量。

**第二批工作量**：4 技能 + 2 模板 + 1 校验脚本 ≈ 8 个文件，约 600 行；1–2 个会话。

---

## 第三批：`/studio-review`（并行评审）

- 用户看到：一份**带裁决**的评审报告——五个视角（设计 / 代码 / QA / 安全 / 数值）并行跑，合并后给
  `PASS` / `CONCERNS` / `FAIL` / `NOT ASSESSED` + 每条发现的位置与修法。
- 实现：`dsh-src/skills/studio-review/SKILL.md` + `dsh-src/scripts/studio-review.workflow.mjs`
  - 脚本用 `workflow` 工具（并行 fan-out）：每个视角一个 subagent，输入同一份变更范围；
  - 合并规则：任一 `FAIL` → 总结论 `FAIL`；有 `CONCERNS` 无 `FAIL` → `CONCERNS`；视角跑不动 → `NOT ASSESSED` 并说明原因（**不得静默降级**）。
- 验收：
  - 故意留一个安全问题（例如硬编码密钥）→ 报告必须 `FAIL` 且指出文件行；
  - 视角数少于 5 时，报告必须写明哪几个没跑、为什么。

**第三批工作量**：1 技能 + 1 workflow 脚本 ≈ 2 个文件，约 250 行；但要**真跑一次**（花模型额度），
所以放在前两批之后。

---

## 门禁要补的三条

| 编号 | 检查 | 为什么 |
|---|---|---|
| S28 | 新技能在 `.dsh/skills` 与载荷里都存在，且 frontmatter `name` == 目录名 | 过去出现过名字不匹配 |
| S30 | `/dashboard` 产物：12 个静态视图、默认视图唯一、每个视图自带范围说明、锚点与 `:target`、无外链 | 离线可看 + 无 JS 可切换是承诺 |
| S31 | 技能点名的 `.dsh/scripts/*.mjs` 在载荷里存在 | 文档指向不存在的工具 |
| S32 | 技能引用的 state 字段在脚本输出里存在 | 文案与实现漂移 |
| S33 | 单状态项目：饼图必须是整圆（弧起点=终点会画空） | 真实空白 bug |
| S34 | 范围内只有一天：折线视图必须是柱 + 说明（git 缺失时 SKIP） | 单点线画不出来 |
| S35 | 随包技能/代理/规则文本无行尾反斜杠（围栏内豁免） | 替换脚本转义泄漏 |
| S36 | UTF-8 BOM 文件仍能解析状态与引擎 | Windows 编辑器默认写 BOM |
| S29（第二批） | 技能里引用的 `office-*` 技能名在可用目录内 | 尚未实现，随第二批加 |

---

## 版本节奏与回滚

| 批次 | 版本 | 回滚方式 |
|---|---|---|
| 第一 | 0.2.0 | 新技能是独立目录，删目录即回滚；`project-state.mjs` 不影响既有技能 |
| 第二 | 0.3.0 | 同上；导出物在 `production/exports/`，不影响源文档 |
| 第三 | 0.4.0 | 删 `studio-review` 目录即可，无钩子改动 |

**不新增钩子**——三批都不改 `.dsh/hooks.json`，把风险限制在"新增技能"范围内。

---

## 总工作量估计

| 批 | 文件 | 行数 | 会话数 |
|---|---|---|---|
| 一 | 5 | ~300 | 1 |
| 二 | 8 | ~600 | 1–2 |
| 三 | 2 | ~250 | 1（含真跑） |

---

## 待你确认的三点

1. `/dashboard` 输出放 **`production/dashboard.html`**（项目可见）还是放临时目录（看完即弃）？
2. `/balance-sheet` 的数值源：用 `docs/gdd/*.md` 的 `## Formulas` 表，还是新增 `production/tuning/*.csv` 作为权威源？
3. `/studio-review` 默认跑**全部五个视角**，还是按项目规模裁（小项目只跑 3 个）？


