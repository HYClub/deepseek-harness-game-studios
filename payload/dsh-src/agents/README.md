# DSH 代理委派约定（手写源文件，不被生成覆盖）

DSGS 的 49 个代理以**角色卡**形式存在（`.dsh/agents/*.md`）：每张卡带职责边界、升级路径与产出规范。
上游把它们写成带 `name` / `description` / `model` / `tools` frontmatter 的代理定义，由支持该机制的运行时
按名字自动发现；**DSH 没有这种"按名字自动加载的代理目录"**——卡片是给调用方读的文本，不是注册项。

| 方式 | 工具 | 适用 |
|---|---|---|
| 一次性子代理 | `subagent`（`run_in_background: false`） | 单角色任务，结果要立刻用 |
| 可续子代理 | `subagent`（后台）→ 之后 `send_message` | 需要多轮追问同一角色的任务 |
| 批量编排 | `workflow` 里的 `agent(prompt, opts)` / `pipeline` / `parallel` | 同一套流程跑很多对象（审 20 个 GDD、转换 74 个技能） |

因此：**`.dsh/agents/<name>.md` 是"角色卡"，不是可自动加载的代理定义。** 要"召唤"某个角色时，
调用方自己读卡片，把卡片正文连同任务一起作为 prompt 传进去。

## 委派模板

两种传法，推荐**第二种**（调用方不必为卡片正文付费两次）：

**A. 调用方读卡、把正文粘进 prompt**（原 DSGS 语义，卡片内容 100% 确定）

**B. 子代理自己按路径读卡**（推荐默认）：

```
你是被委派的子代理。第一步（必须）：读 <绝对或项目相对路径>/.dsh/agents/<agent-name>.md 全文，
按卡片里的职责、协作协议与产出规范工作。卡片是生成物，只读不改。

# 本次任务
目标：<一句话>
输入：<要读的文件/目录清单>
产出：<要写的文件路径，或"只返回结论，不写文件">
验收标准：<可判定的条件>
边界：只改 <路径范围>；不要动 <其他部门文件>；遇到越界需求先返回，不要自行决定。

# 返回格式
1. 结论 / 产出物  2. 依据（读了哪些文件、哪几条规则）  3. 待决问题  4. 风险与不确定项
```

采用 A 时的完整模板：

```
你是 <agent-name>。<把 .dsh/agents/<agent-name>.md 的正文粘在这里>

# 本次任务
目标：<一句话>
输入：<要读的文件/目录清单>
产出：<要写的文件路径，或"只返回结论，不写文件">
验收标准：<可判定的条件>
边界：只改 <路径范围>；不要动 <其他部门文件>；遇到越界需求先返回，不要自行决定。
上下文来源：<如果需要本会话的上下文，调用方用 subagent_fork 或把摘要贴进来>

# 返回格式
1. 结论 / 产出物
2. 依据（读了哪些文件、哪几条规则）
3. 待决问题（需要用户拍板的）
4. 风险与不确定项
```

要点：

- **读卡片，不要凭名字想象角色。** 卡片里有该角色的职责边界、升级路径和协作协议。
- **需要本会话上下文时用 `subagent_fork`**（子代理继承已完成轮次），否则用 `subagent` 并自带全部输入。
- **互相独立的委派要在同一条消息里一起发起**，不要串行等待。
- **领域边界仍然生效**（见 `.dsh/docs/coordination-rules.md`）：子代理不得跨部门改文件；越界时返回给调用方，
  由 `producer` 角色协调，或升级到 `creative-director`（设计）/ `technical-director`（技术）。
- **模型层级**：卡片里的 `model: opus|sonnet` 只是层级提示。DSH 技能不能固定模型；若后端支持，
  在 `subagent` / `workflow` 的调用参数里指定 provider / model / reasoning effort，否则沿用会话模型。
- **`BLOCKED` 必须上报**：编排时任何一个子代理阻塞都要立刻浮出，不要静默跳过；部分完成也要出报告。

## 委派产出与升级（DSH 现实约束）

一次委派实测（用 `qa-tester` 角色卡审一个真实产出）暴露了角色卡在 DSH 里"交付侧规格不足"，因此补三条约定：

1. **产出路径由调用方在 prompt 里点名**，不要指望角色卡自己规定路径 —— 多数卡片只规定了测试用例、bug 报告、
   回归清单，**没有"评审报告"模板与位置**。约定：

   ```
   评审/审计类产出 → production/qa/reviews/<agent>-<YYYY-MM-DD>-<subject>.md
   设计/架构类产出 → design/ 或 docs/ 下调用方在 prompt 里给出的路径
   代码/测试产出   → 由路径规则（.dsh/rules/INDEX.md）决定
   ```

   调用方没点名路径时，子代理应向调用方要，而不是自己发明一个散落在外的文件。

2. **子代理没有跨代理通道，也不能问人。** 角色卡里的"升级到 `qa-lead` / 找 `technical-director` 裁决"在 DSH 里
   无法直接执行；更硬的一条是 **`ask_user_question` 在子代理里不可用**
   （报错原文：`human interaction is unavailable while the calling agent is owned by another live agent`）。
   因此：子代理只能把**待决问题与阻塞项随报告返回给调用方**，由调用方（主代理）去问用户或升级。
   写 prompt 时把这条说明白，否则子代理会卡在"我该找谁/我该不该继续"上，或者擅自替你决定。
   被委派的技能若有"必须人工批准"的步骤（如 `/settings` 的写入批准），子代理应**停下来把批准请求交回**，
   而不是自己批准自己。

3. **卡片里的 `maxTurns`、`Reports to`、`model:` 都是惰性信息**：DSH 不读这些字段。预算由调用方的
   `subagent`/`workflow` 参数控制，汇报关系由调用方自己承担（它就是上级）。

## 卡片清单

`ls .dsh/agents/*.md` —— 49 张卡片，与 `.claude/agents/` 同名同序（生成物，勿手改）。

三层结构照抄 DSGS：

- **导演层**：`creative-director`、`technical-director`、`producer`（+ `art-director`）
- **主管层**：`game-designer`、`lead-programmer`、`narrative-director`、`audio-director`、`qa-lead`、
  `systems-designer`、`level-designer`
- **专家层**：各语言/职能程序员、`technical-artist`、`sound-designer`、`ux-designer`、`writer`、
  `world-builder`、`performance-analyst`、`prototyper`、`security-engineer`、`accessibility-specialist` 等
- **引擎组**：`godot-*`、`unity-*`、`ue-*` / `unreal-specialist`，按项目引擎取用
- **运营组**：`devops-engineer`、`release-manager`、`live-ops-designer`、`community-manager`、
  `analytics-engineer`、`economy-designer`、`localization-lead`

## 示例：为一个 story 召唤玩法程序员

```
先读 .dsh/agents/gameplay-programmer.md（角色卡）与 .dsh/rules/gameplay-code.md（该路径的规则），
然后调用 subagent：
  prompt = 角色卡正文 + "本次任务：实现 production/epics/<epic>/story-003.md 的验收标准；
           产出 src/gameplay/combat/... 与 tests/... 下的测试；边界：只改 src/gameplay/** 与 tests/**；
           返回格式见 .dsh/agents/README.md 模板"
```

批量场景（例如"把 8 个系统的 GDD 交给 8 个设计专家分别评审"）用 `workflow`：

```js
const results = await pipeline(systems, async (system) => {
  const card = await agent(`读取 .dsh/agents/systems-designer.md 与 design/gdd/${system}.md，做一次设计评审`);
  return card;
});
```

## 把上游卡片的三条"机制"落到 DSH（实测可用的三个旋钮）

上游给每张卡片声明了 `tools:`、`model:`，并且允许多层委派。DSH 里对应的是三个**真实存在的机制**（不是靠自觉）：

| 上游机制 | DSH 机制 | 怎么用 |
|---|---|---|
| **多层委派**（技能派专家、专家再派） | 设置项 `maxDepth`（"Maximum recursion depth"：0=禁用 / 1=只有主代理能派 / N 层） | **默认是 1**，所以上游那种"专家再派"会报 `subagent depth 2 exceeds maxDepth 1`。要在 DSH 复现上游编排，把它调到 **≥2**（GUI：Settings → Subagent；或 profile 里给 `dsh-tool-subagent` 行配 `maxDepth`）。**这是运行时设置，本项目不代改** |
| **每张卡的工具白名单**（`tools:`） | `dsh-tool-subagent` 的 `toolFilter: { allow[], deny[] }` | 委派时按卡片声明传 `toolFilter`。例：`ui-programmer` 卡只写代码 → 委派时 `allow: ['read','write','edit','grep','glob','pwsh']`。**强制生效**，比"靠约定"强 |
| **每张卡的模型档位**（`model:`） | `agentOptions: { provider, model, reasoningEffort, maxTokens }`（行级）+ 调用处 `model` + 设置项"允许代理为子代理选模型" | 卡片写着 `model: sonnet` 就按它传；卡片里的 `model:` 在 DSH 是**惰性元数据**（DSH 不读），所以**必须由调用方带上**，否则子代理用默认模型 |

另外 `persona` 可以把卡片正文作为子代理的人格设定一次性传入，省掉每轮重复贴卡片。

> 这三条都**不在** `.claude/` 里改——上游卡片原样保留（含 `tools:`/`model:` 字段），本文件负责说明它们在 DSH 里怎么生效。

