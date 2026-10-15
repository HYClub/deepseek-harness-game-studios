---
name: statusline
description: "Print the DSGS studio status line — stage, posture, active epic > story, sprint progress, engine — as one line. DSGS-only: DSH has no slot a third-party plugin can render into, so this is where the studio state lives."
argument-hint: "[--full]"
user-invocable: true
---

<!-- DSGS-ONLY: upstream has a runtime status line (context %, model, stage, breadcrumb) rendered by
     its own runtime. DSH has no such surface *and* no third-party slot to add one:
       - DSH's built-in status bar already shows the runtime half (turns, steps, tok/s, tokens,
         cache hit rate, context %), so that half is an equivalent substitution, not a gap;
       - the docked-bar slot (`conversation.input.dock`) is filled from a client roster that lists
         only `@deepseek-ai/*` packages — measured: our package is absent from it even with a
         `dsh.client` declaration;
       - the GUI's Plan panel is fed by the `todos` projection, which belongs to `todo_write`
         (writing there would clobber the model's own plan), and the Jobs panel is for background
         work.
     So the *studio* half is printed h（见仓库 README 的 Known limits 一节）

# Statusline

Print **one line** describing where this game project stands.

**示例（字段齐全的工程才会这样）**：

```
Production · Standard | combat-core > story-003 | Sprint 3/7 | Godot 4.6.2
└ 阶段 · 姿态          └ 活跃 epic > story        └ Sprint  └ 引擎
```

**框架仓库本身（没跑过 `/start`）只会输出姿态那一项**，例如：

```
Minimal            # 或渲染器那一行：ctx: -- | Unknown | Minimal · brief
```

这不是错误，是这条技能的定义：**任何取不到来源的字段一律省略，绝不猜**。判断"输出是否正常"的标准是
**字段与来源是否一致**（下面第 1–4 步各自能取到什么），不是"是不是那行长的示例"。

## Assemble it

1. **Stage and posture** — the faithful renderer (context %, model, stage, posture, breadcrumb):

   ```pwsh
   node .dsh/statusline.mjs
   ```

2. **Stage / posture / engine**, when the renderer's line is not enough:

   ```pwsh
   node tools/yaml-helper.mjs __call resolve_setting project.stage
   node tools/yaml-helper.mjs __call resolve_setting engine.name
   node tools/yaml-helper.mjs __call resolve_setting engine.version
   ```

   (`__call resolve_setting` accepts both bare and namespaced keys — see `AGENTS.md`.)

3. **Active epic > story** — the epic whose stories are not all Complete, then its in-progress story:

   ```pwsh
   Get-ChildItem production/epics -Directory |
     ForEach-Object { $s = Get-ChildItem $_.FullName -Filter 'story-*.md'
       [pscustomobject]@{ Epic = $_.Name; Stories = $s.Count
         Done = ($s | Select-String -Pattern '^> \*\*Status\*\*: Complete').Count } } |
     Where-Object { $_.Done -lt $_.Stories } | Select-Object -First 1
   ```

   Then the first story in that epic whose `> **Status**:` is not `Complete` gives the story name.

4. **Sprint progress** — from the sprint file, when the project has one:

   ```pwsh
   if (Test-Path production/sprint-status.yaml) { Get-Content production/sprint-status.yaml }
   ```

   Report `Sprint <done>/<total>`; at `modes.rigor: minimal` this file often does not exist — omit the
   field rather than inventing it.

## Print it

Show the line as one plain sentence, then **stop**. This skill produces no artifacts and writes no
files: it is a read-only view of `project.yaml`, `production/epics/**` and
`production/sprint-status.yaml`.

## Where the runtime half lives instead

DSH's own status bar (below the composer) already shows turns, steps, tok/s, total tokens, cache hit
rate and context usage — more than upstream's `statusline.sh` prints. Nothing needs to be built for
that half.


