---
name: dsgs-install
description: "Install DeepSeek Game Studios (DSGS) at the machine level, once per machine: lays down the framework payload (~/.dsh/dsgs) and the bootstrap skill (~/.dsh/skills/dsgs-init). After this, ANY folder — including a brand-new empty one — can be initialised by saying \"初始化 DSGS\". Idempotent; never touches project files."
argument-hint: "[-InstallPlugin]"
user-invocable: true
---

<!-- DSGS-ONLY: upstream has no machine-level installer (its model is "clone the template").
     DSH needs one because skills are discovered only from `<workspace>/.dsh/skills` or the user-level
     `~/.dsh/skills`: in a bare folder neither exists, so nothing there even knows what "初始化 DSGS"
     means. This skill is the one-time prerequisite; see docs（见仓库 README 的说明）

# DSGS machine-level install (机器级安装，一台机器一次)

Run this **once per machine**. It makes this workflow possible afterwards:

```
新建空文件夹 → 新会话 → 说「初始化 DSGS」→ 说「/start」
```

## What it installs (all user-level, no project is touched)

| Location | Purpose |
|---|---|
| `~/.dsh/dsgs/**` | **Payload** — the framework (skills, agents, rules, hooks, tools, docs, instruction files, config template). `dsgs-init` copies from here into each new project. |
| `~/.dsh/skills/dsgs-init/SKILL.md` | **Bootstrap skill** — teaches every session (in every workspace, including an empty folder) how to handle the phrase "初始化 DSGS". |
| *(optional)* the plugin in a profile | The hook bridge (`dist/deepseek-harness-game-studios`), so hooks actually run in projects. |

## How to run it

1. Show the user what will happen (dry run — **do not skip**):

   ```pwsh
   pwsh -NoProfile -File tools/install-global.ps1
   ```

2. Apply it (idempotent: existing files are re-copied from the framework, projects are never touched):

   ```pwsh
   pwsh -NoProfile -File tools/install-global.ps1 -Confirm
   ```

3. Optionally install the plugin into the current profile as well:

   ```pwsh
   pwsh -NoProfile -File tools/install-global.ps1 -Confirm -InstallPlugin
   ```

   (Requires a **restart** of `dsh web` afterwards — profile rows mount at startup.)

## Report back to the user

- payload path and bootstrap-skill path;
- that the workflow is now: **empty folder → 「初始化 DSGS」 → 「/start」**;
- that an empty folder only works **after** this install — a bare folder has no DSGS skills of its own;
- if the plugin was installed, that a restart is required.

## Notes

- Idempotent and additive: safe to re-run after the framework changes (it refreshes the payload).
- Nothing is published and no remote is configured — this is a purely local, machine-level install.
- To initialise an individual project afterwards, the user says **「初始化 DSGS」** (or runs
  `~/.dsh/dsgs/tools/dsgs-init.ps1 -Target . -Confirm`).



