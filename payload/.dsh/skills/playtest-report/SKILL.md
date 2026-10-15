---
name: playtest-report
description: "Structured playtest report template, or turn existing playtest notes into structured feedback."
argument-hint: "[new|analyze path-to-notes] [--review full|lean|solo]"
user-invocable: true
allowed-tools: read, glob, grep, write, subagent, ask_user_question, pwsh(node tools/yaml-helper.mjs resolve_config *)
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

**前置命令（DSH 不会预执行技能里的 `!` 命令，需要你自己运行它）**

```pwsh
node tools/yaml-helper.mjs resolve_config --keys review_mode,automation
```

把输出当作已解析的项目配置使用；没有输出块时按 `.dsh/docs/config-resolution.md` 的默认值处理。

Resolved above — use as-is; `--review` overrides `review_mode` for this run. No
block → defaults in `.dsh/docs/config-resolution.md`.



## Phase 1: Parse Arguments


See `.dsh/docs/director-gates.md` for the full check pattern. Individual gate definitions live in `.dsh/docs/director-gates/[gate-id].md` — the spawned agent reads its own gate file; do not read it in the parent session.


Every `ask_user_question` call follows `.dsh/docs/automation-modes.md`
(collaborative asks always · guided major-only · autonomous logs and proceeds;
`automation_always_ask` categories always prompt).

Determine the mode:

- `new` → generate a blank playtest report template. This mode ends after
  Phase 2A: a blank template has nothing to route, review or save.
- `analyze [path]` → read raw notes and fill in the template with structured findings
- No argument → ask via `ask_user_question`: `[A] New blank template` /
  `[B] Analyze notes — I'll give you the path`

---

## Phase 2A: New Template Mode

Generate this template and output it to the user:

```markdown
# Playtest Report

## Session Info
- **Date**: [Date]
- **Build**: [Version/Commit]
- **Duration**: [Time played]
- **Tester**: [Name/ID]
- **Platform**: [PC/Console/Mobile]
- **Input Method**: [KB+M / Gamepad / Touch]
- **Session Type**: [First time / Returning / Targeted test]

## Test Focus
[What specific features or flows were being tested]

## First Impressions (First 5 minutes)
- **Understood the goal?** [Yes/No/Partially]
- **Understood the controls?** [Yes/No/Partially]
- **Emotional response**: [Engaged/Confused/Bored/Frustrated/Excited]
- **Notes**: [Observations]

## Gameplay Flow
### What worked well
- [Observation 1]

### Pain points
- [Issue 1 -- Severity: High/Medium/Low]

### Confusion points
- [Where the player was confused and why]

### Moments of delight
- [What surprised or pleased the player]

## Bugs Encountered
| # | Description | Severity | Reproducible |
|---|-------------|----------|-------------|

## Feature-Specific Feedback
### [Feature 1]
- **Understood purpose?** [Yes/No]
- **Found engaging?** [Yes/No]
- **Suggestions**: [Tester suggestions]

## Quantitative Data (if available)
- **Deaths**: [Count and locations]
- **Time per area**: [Breakdown]
- **Items used**: [What and when]
- **Features discovered vs missed**: [List]

## Overall Assessment
- **Would play again?** [Yes/No/Maybe]
- **Difficulty**: [Too Easy / Just Right / Too Hard]
- **Pacing**: [Too Slow / Good / Too Fast]
- **Session length preference**: [Shorter / Good / Longer]

## Top 3 Priorities from this session
1. [Most important finding]
2. [Second priority]
3. [Third priority]
```

In `new` mode, stop here with: Verdict: **COMPLETE** — blank template output; nothing saved.

---

## Phase 2B: Analyze Mode

Read the raw notes at the provided path. Cross-reference with existing design documents. Fill in the template above with structured findings. Flag any playtest observations that conflict with design intent.

An observation that describes a defect — a crash, a framerate drop, a softlock,
something that plainly breaks rather than plays badly — goes in the **Bugs
Encountered** table, not under Gameplay Flow → Pain points, and is routed as a
bug in Phase 3. Pain points are for how the game feels to play.

---

## Phase 3: Action Routing

Categorize all findings into four buckets:

- **Design changes needed** — fun issues, player confusion, broken mechanics, observations that conflict with the GDD's intended experience
- **Balance adjustments** — numbers feel wrong, difficulty too spiked or too flat
- **Bug reports** — clear implementation defects that are reproducible
- **Polish items** — not blocking progress, but friction or feel issues for later

Present the categorized list, then route:

- **Design changes:** "Run `/propagate-design-change [path]` on the affected design document to find downstream impacts before making changes."
- **Balance adjustments:** "Run `/balance-check [system]` to verify the full balance picture before tuning values."
- **Bugs:** "Use `/bug-report` to formally track these."
- **Polish items:** "Add to the polish backlog in `production/` when the team reaches that phase."

---

## Phase 3b: Creative Director Player Experience Review

**Review mode check** — apply before spawning CD-PLAYTEST:
- `solo` → skip. Note: "CD-PLAYTEST skipped — Solo mode." Proceed to Phase 4 (save the report).
- `lean` → skip (not a PHASE-GATE). Note: "CD-PLAYTEST skipped — Lean mode." Proceed to Phase 4 (save the report).
- `full` → spawn as normal.

After categorising findings, spawn `creative-director` via `subagent` using gate **CD-PLAYTEST** (`.dsh/docs/director-gates/cd-playtest.md`).

Pass: the structured report content, game pillars and core fantasy (from
`design/gdd/game-concept.md`), the specific hypothesis being tested. **If
`game-concept.md` does not exist** — expected at `minimal`, where
`design/game-brief.md` replaces it — the brief has no pillars: pass its
one-sentence pitch and its "Who it's for / what they feel" line instead, and say
they stand in for pillars. If neither document exists, say so in the prompt:
*"No pillars available — assess against the hypothesis alone."* A director gate
handed silence about pillars will invent them.

Present the creative director's assessment before saving the report. If CONCERNS or REJECT, add a `## Creative Director Assessment` section to the report capturing the verdict and feedback. If APPROVE, note the approval in the report. If NOT ASSESSED (the director lacked an input — `.dsh/docs/director-gates.md`), add the same section naming what was missing; it is not an approval.

---

## Phase 4: Save Report

Ask: "May I write this playtest report to `production/qa/playtests/playtest-[date]-[tester].md`?"

If yes, write the file, creating the directory if needed.

---

## Phase 5: Next Steps

Verdict: **COMPLETE** — playtest report generated.

- Act on the highest-priority finding category first.
- After addressing design changes: re-run `/design-review` on the updated GDD.
- After fixing bugs: re-run `/bug-triage` to update priorities.
