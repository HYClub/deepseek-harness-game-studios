---
name: perf-profile
description: "Performance profiling — find bottlenecks, measure against budgets, produce ranked optimization recommendations."
argument-hint: "[system-name or 'full']"
user-invocable: true
allowed-tools: read, glob, grep, write, pwsh, pwsh(node tools/yaml-helper.mjs resolve_config *)
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
> - `argument-hint`, `allowed-tools`, `model` are upstream fields kept as written but not read here: tool availability is decided by session permissions, a skill cannot pin a model, and a subagent model is chosen at the `subagent` / `workflow` call site.
<!-- DSGS-GENERATED:END -->

**前置命令（DSH 不会预执行技能里的 `!` 命令，需要你自己运行它）**

```pwsh
node tools/yaml-helper.mjs resolve_config --keys performance.enforce,automation
```

把输出当作已解析的项目配置使用；没有输出块时按 `.dsh/docs/config-resolution.md` 的默认值处理。

Resolved above — use as-is. No block → defaults in
`.dsh/docs/config-resolution.md`.

Every `ask_user_question` call follows `.dsh/docs/automation-modes.md`
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

## Phase 0: Resolve Budget Enforcement

`performance.enforce` decides what a budget violation *means* in this run. It
does not change which budgets are measured — `performance.target_framerate`,
`frame_budget_ms`, `draw_call_limit` and `memory_ceiling_mb` are profiled the
same way at every level:

| Value | Effect on this profile's findings |
|-------|-----------------------------------|
| `warn` (default) | Violations are reported as findings. They do not block; CI logs them without failing. |
| `block` | Violations are **blockers**. Say so explicitly in the report — a `block` project treats an over-budget system as release-stopping, and `/gate-check` will FAIL the Polish gate on it. |
| `off` | Budgets are informational only. Still report measured values, but do not raise violations as findings or recommendations to fix. |

Only `warn`, `block` and `off` are recognized. Surface any other value to the
user and fall back to `warn` rather than guessing.

> The value is locally overridable (`/settings --local performance.enforce=block`),
> so use the resolved block above rather than reading `project.yaml` — a
> teammate's stricter local setting is meant to bite on their machine only.

## Phase 1: Determine Scope

Read the argument:

- System name → focus profiling on that specific system
- `full` → run a comprehensive profile across all systems

---

## Phase 2: Load Performance Budgets

**Read the committed budgets from config first** — they are the project's
record of what it agreed to, and design docs are the fallback, not the source:

```pwsh
# DSH 没有 bash 可以 source：下面每个函数调用都改用 node tools/yaml-helper.mjs __call <函数> <参数>
node tools/yaml-helper.mjs __call get_effective_yaml_key performance.target_framerate
node tools/yaml-helper.mjs __call get_effective_yaml_key performance.frame_budget_ms
node tools/yaml-helper.mjs __call get_effective_yaml_key performance.draw_call_limit
node tools/yaml-helper.mjs __call get_effective_yaml_key performance.memory_ceiling_mb
```

> Written as four literal keys rather than a loop over leaf names, deliberately.
> The dead-settings audit matches the **full dotted key**, so a loop building
> `performance.$k` leaves three of the four spelled nowhere and the audit
> reports them DEAD while this skill reads them. Spell each key out in full.

> **Resolve these budgets from `project.yaml`, not from prose.** Phase 0 above
> states these four budgets "are profiled the same way at every level". Sending
> the reader to *"design docs or AGENTS.md"* instead means a user who set
> `performance.target_framerate: 60` in `project.yaml` has it ignored by the one
> skill that profiles against budgets. The keys resolve correctly — this phase
> has to actually ask for them.

Then fall back to design docs or AGENTS.md for anything config does not carry:

- Target FPS (e.g., 60fps = 16.67ms frame budget)
- Memory budget (total and per-system)
- Load time targets
- Draw call budgets
- Network bandwidth limits (if multiplayer)

**A metric with no committed budget is `NOT ASSESSED`, not a pass.** Do not
measure against the template's `[16.67ms]` placeholder — an unset budget is not
a budget that was met, and reporting headroom against a number nobody chose is
the exact fabrication this skill's own header warns about.

---

## Phase 3: Analyze Codebase

**CPU Profiling Targets:**
- `_process()` / `Update()` / `Tick()` functions — list all and estimate cost
- Nested loops over large collections
- String operations in hot paths
- Allocation patterns in per-frame code
- Unoptimized search/sort over game entities
- Expensive physics queries (raycasts, overlaps) every frame

**Memory Profiling Targets:**
- Large data structures and their growth patterns
- Texture/asset memory footprint estimates
- Object pool vs instantiate/destroy patterns
- Leaked references (objects that should be freed but aren't)
- Cache sizes and eviction policies

**Rendering Targets (if applicable):**
- Draw call estimates
- Overdraw from overlapping transparent objects
- Shader complexity
- Unoptimized particle systems
- Missing LODs or occlusion culling

**I/O Targets:**
- Save/load performance
- Asset loading patterns (sync vs async)
- Network message frequency and size

---

## Phase 4: Generate Profiling Report

**Write the report to `production/polish/[scope]-report-[date].md`**, asking first
per the Collaboration Protocol: *"May I write this profiling report to
`production/polish/[scope]-report-[date].md`?"* Create the directory if absent.

> **Name the destination — do not just render the template into the
> conversation.** A profile that lives only in the transcript is gone the moment
> the session ends, and no two runs can be compared. `production/polish/`
> is the same location `/team-polish` writes, deliberately: a profile taken by
> either route belongs in one place, or the comparison this skill exists to enable
> cannot be made.
>
> If a `NOT ASSESSED` section survives into the report, keep it in the written
> file. A profile whose gaps are edited out on the way to disk reads, later, as a
> complete measurement.


```markdown
## Performance Profile: [System or Full]
Generated: [Date]

### Performance Budgets
| Metric | Budget | Estimated Current | Status |
|--------|--------|-------------------|--------|
| Frame time | [16.67ms] | [estimate] | [OK/WARNING/OVER/NOT ASSESSED] |
| Memory | [target] | [estimate] | [OK/WARNING/OVER/NOT ASSESSED] |
| Load time | [target] | [estimate] | [OK/WARNING/OVER/NOT ASSESSED] |
| Draw calls | [target] | [estimate] | [OK/WARNING/OVER/NOT ASSESSED] |

### Hotspots Identified
| # | Location | Issue | Estimated Impact | Fix Effort |
|---|----------|-------|------------------|------------|

### Optimization Recommendations (Priority Order)
1. **[Title]** — [Description]
   - Location: [file:line]
   - Expected gain: [estimate]
   - Risk: [Low/Med/High]
   - Approach: [How to implement]

### Quick Wins (< 1 hour each)
- [Simple optimization 1]

### Requires Investigation
- [Area that needs actual runtime profiling to confirm impact]
```

Output the report with a summary: top 3 hotspots, estimated headroom against
each budget that is set — for a metric with none, `no budget set — headroom not
assessed` — and recommended next action.

---

## Phase 5: Scope and Timeline Decision

Activate this phase only if any hotspot has Fix Effort rated M or L.

Present significant-effort items and ask the user to choose for each:

- **A) Implement the optimization** (proceed with fix now or schedule it)
- **B) Reduce feature scope** (run `/scope-check [feature]` to analyze trade-offs)
- **C) Accept the performance hit and defer to Polish phase** (log as known issue)
- **D) Escalate to technical-director for an architectural decision** (run `/architecture-decision`)

If multiple items are deferred to Polish (choice C), record them under `### Deferred to Polish`.

---

## Verdict

Close every run that produced a report — whether or not Phase 5 ran — with:
Verdict: **COMPLETE** — performance profile generated (saved to
`production/polish/[scope]-report-[date].md` if the write was approved). The only
other outcome is the `NOT ASSESSED — NO DATA` path above.

---

## Phase 6: Next Steps

- If bottlenecks require architectural change: run `/architecture-decision`.
- If scope reduction is needed: run `/scope-check [feature]`.
- To schedule optimizations: run `/sprint-plan update`.

### Rules
- Never optimize without measuring first — gut feelings about performance are unreliable
- Recommendations must include estimated impact — "make it faster" is not actionable
- Profile on target hardware, not just development machines
- Static analysis (this skill) identifies candidates; runtime profiling confirms
