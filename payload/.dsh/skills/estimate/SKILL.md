---
name: estimate
description: "Estimate task effort from complexity, dependencies, velocity, risk. Structured estimate with confidence levels."
argument-hint: "[task-description]"
user-invocable: true
allowed-tools: read, glob, grep
model: sonnet
---
<!-- DSGS-GENERATED:BEGIN — do not edit by hand -->
> **生成物，勿手改**：改动会在下次生成时被覆盖。
>
> - 重新生成：`node tools/build-dsh.mjs`（内容源与 `dsh-src/` → `.dsh/`）。
> - 工具名是 DSH 的：`pwsh` / `read` / `write` / `edit` / `grep` / `glob` / `subagent` / `ask_user_question` / `todo_write` / `web_search`。
> - 委派子代理：读角色卡 `.dsh/agents/<name>.md`，把卡片正文连同任务作为 `subagent`（一次性/可续）或 `workflow`（批量编排）的 prompt。约定见 `.dsh/agents/README.md`。
> - 本技能的基础目录见会话注入的 `Base directory for this skill`；相对路径都相对它解析。
> - 正文里的「前置命令」块需要你亲自运行（原文的预执行行在 DSH 不生效）。
> - frontmatter 里的 `argument-hint`、`allowed-tools`、`model` 是上游字段，DSH 原样保留但不读取：工具可用性由会话权限决定，技能不能固定模型，子代理的模型在 `subagent`/`workflow` 调用处指定。
<!-- DSGS-GENERATED:END -->

## Phase 1: Understand the Task

Read the task description from the argument. If the description is too vague to estimate meaningfully, ask for clarification before proceeding.

Read AGENTS.md for project context: tech stack, coding standards, architectural patterns, and any estimation guidelines.

Read relevant design documents from `design/gdd/` if the task relates to a documented feature or system.

---

## Phase 2: Scan Affected Code

Identify files and modules that would need to change:

- Assess complexity (size, dependency count, cyclomatic complexity)
- Identify integration points with other systems
- Check for existing test coverage in the affected areas
- Read past sprint data from `production/sprints/` for similar completed tasks and historical velocity.
  **If there is none**, say so under Notes and Assumptions — "No sprint history found;
  this estimate is not calibrated to the team's velocity" — and treat that as a risk
  in the confidence level, not as a silent padding of the figures.

---

## Phase 3: Analyze Complexity Factors

**Code Complexity:**
- Lines of code in affected files
- Number of dependencies and coupling level
- Whether this touches core/engine code vs leaf/feature code
- Whether existing patterns can be followed or new patterns are needed

**Scope:**
- Number of systems touched
- New code vs modification of existing code
- Amount of new test coverage required
- Data migration or configuration changes needed

**Risk:**
- New technology or unfamiliar libraries
- Unclear or ambiguous requirements
- Dependencies on unfinished work
- Cross-system integration complexity
- Performance sensitivity

---

## Phase 4: Generate the Estimate

```markdown
## Task Estimate: [Task Name]
Generated: [Date]

### Task Description
[Restate the task clearly in 1-2 sentences]

### Complexity Assessment

| Factor | Assessment | Notes |
|--------|-----------|-------|
| Systems affected | [List] | [Core, gameplay, UI, etc.] |
| Files likely modified | [Count] | [Key files listed below] |
| New code vs modification | [Ratio] | |
| Integration points | [Count] | [Which systems interact] |
| Test coverage needed | [Low / Medium / High] | |
| Existing patterns available | [Yes / Partial / No] | |

**Key files likely affected:**
- `[path/to/file1]` -- [what changes here]

### Effort Estimate

| Scenario | Days | Assumption |
|----------|------|------------|
| Optimistic | [X] | Everything goes right, no surprises |
| Expected | [Y] | Normal pace, minor issues, one round of review |
| Pessimistic | [Z] | Significant unknowns surface, blocked for a day |

**Recommended budget: [Y days]**

### Confidence: [High / Medium / Low]

[Explain which factors drive the confidence level for this specific task.]

### Risk Factors

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|

### Dependencies

| Dependency | Status | Impact if Delayed |
|-----------|--------|-------------------|

### Suggested Breakdown

| # | Sub-task | Estimate | Notes |
|---|----------|----------|-------|
| 1 | [Research / spike] | [X days] | |
| 2 | [Core implementation] | [X days] | |
| 3 | [Testing and validation] | [X days] | |
| | **Total** | **[Y days]** | |

### Notes and Assumptions
- [Key assumption that affects the estimate]
- [Any caveats about scope boundaries]
```

Output the estimate with a brief summary: recommended budget, confidence level, and the single biggest risk factor.

This skill is read-only — no files are written. Verdict: **COMPLETE** — estimate generated.

---

## Phase 5: Next Steps

- If confidence is Low: recommend a time-boxed spike (`/prototype`) before committing.
- If the task is > 10 days: recommend breaking it into smaller stories via `/create-stories`.
- To schedule the task: run `/sprint-plan update` to add it to the next sprint.

### Guidelines

- Always give a range (optimistic / expected / pessimistic), never a single number
- The recommended budget should be the expected estimate, not the optimistic one
- Round to half-day increments — estimating in hours implies false precision for tasks longer than a day
- Do not pad estimates silently — call out risk explicitly so the team can decide
- Confidence is Low whenever the approach is undecided or the core requirements are still TBD — a range built on an unmade decision is a guess
