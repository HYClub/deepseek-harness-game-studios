---
name: onboard
description: "Onboarding doc for a new contributor or agent — project state, conventions, priorities relevant to the specified role."
argument-hint: "[role|area]"
user-invocable: true
allowed-tools: read, glob, grep, write, pwsh(node tools/yaml-helper.mjs resolve_config *)
model: haiku
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
node tools/yaml-helper.mjs resolve_config --keys automation
```

把输出当作已解析的项目配置使用；没有输出块时按 `.dsh/docs/config-resolution.md` 的默认值处理。

**Automation mode**: Resolve `modes.automation` (`project.local.yaml` →
`project.yaml` → default `collaborative`). Every `ask_user_question` call and
every file write follows `.dsh/docs/automation-modes.md`
(collaborative asks always · guided major-only · autonomous logs and proceeds;
`automation_always_ask` categories always prompt).

## Insufficient input — check this before producing any report

**If the inputs this skill needs do not exist, the answer is "could not run" —
not a filled-in report.** Check first, and stop if the check fails.

1. List the inputs this skill reads (data files, prior reports, profiler output,
   test results, registries, source code).
2. For each, record `FOUND` or `ABSENT` — not "assumed present".
3. If any input required for a section is ABSENT, that section is
   **`NOT ASSESSED — NO DATA`**. Do not estimate it, do not infer it from an
   adjacent artifact, and do not leave a mandated cell to be filled by whoever
   reads the template next.
4. If **every** required input is ABSENT, stop and report
   **`NOT ASSESSED — NO DATA`** as the whole verdict, naming what was missing and
   which skill produces it.

**A verdict of `NOT ASSESSED` is a success.** It is the correct, useful answer to
"what does the data say?" when there is no data. The failure mode this prevents is
specific and has been observed in practice: report templates whose verdict
enum had no "could not run" state produced **false clean passes** — an asset audit
returning COMPLIANT on a project with no assets and no standards, and a
performance profile reporting ">99% headroom against a 16.67ms budget" with zero
profiler data and no budget ever set.

**Absence of evidence is never evidence of absence.** A scan that finds no
matches because there are no files to scan has not verified anything. Say which of
the two happened — a reader cannot tell from a green result.

---

## Phase 1: Load Project Context

Read AGENTS.md for project overview and standards.

Read the relevant agent definition from `.dsh/agents/` if a specific role is specified.

`AGENTS.md` and `.dsh/agents/` ship with the framework — no skill creates them. If either is missing, report it as missing from the install.

---

## Phase 2: Scan Relevant Area

- For programmers: scan the code root (resolve per `.dsh/docs/code-root-resolution.md`) for architecture, patterns, key files. An unresolved root means the scan did not run: the sections it feeds read `NOT ASSESSED — code root unresolved`, never a guess at `src/`
- For designers: scan `design/` for existing design documents
- For narrative: scan `design/narrative/` for world-building and story docs
- For QA: scan `tests/` for existing test coverage (`/test-setup` creates it)
- For production: scan `production/` for current sprint and milestone
- **No role or area given**: a general orientation — list the top level of `design/`,
  `docs/architecture/`, `production/` and the code root, read
  `production/session-state/active.md` if it exists, and say that a role would
  focus the next pass (e.g. `/onboard programmer`)

Read recent changes (git log if available) to understand current momentum.

---

## Phase 3: Generate Onboarding Document

```markdown
# Onboarding: [Role/Area]

## Project Summary
[2-3 sentence summary of what this game is and its current state]

## Your Role
[What this role does on this project, key responsibilities, who you report to]

## Project Architecture
[Relevant architectural overview for this role]

### Key Directories
| Directory | Contents | Your Interaction |
|-----------|----------|-----------------|

### Key Files
| File | Purpose | Read Priority |
|------|---------|--------------|

## Current Standards and Conventions
[Summary of conventions relevant to this role from AGENTS.md and agent definition]

## Current State of Your Area
[What has been built, what is in progress, what is planned next. Name what
Phase 2 found by path — for a designer, each existing GDD and design doc — or
say it found none]

## Current Sprint Context
[What the team is working on now and what is expected of this role]

## Key Dependencies
[What other roles/systems this role interacts with most]

## Common Pitfalls
[Things that trip up new contributors in this area]

## First Tasks
[Suggested first tasks to get oriented and productive]

1. [Read these documents first]
2. [Review this code/content]
3. [Start with this small task]

## Questions to Ask
[Questions the new contributor should ask to get fully oriented]
```

---

## Phase 4: Save Document

Present the onboarding document to the user.

Ask: "May I write this to `production/onboarding/onboard-[role]-[date].md`?"

If yes, write the file, creating the directory if needed.

---

## Phase 5: Next Steps

Verdict: **COMPLETE** — onboarding document generated.

- Share the onboarding doc with the new contributor before their first session.
- Run `/sprint-status` to show the new contributor current progress.
- Run `/help` if the contributor needs guidance on what to work on next.
