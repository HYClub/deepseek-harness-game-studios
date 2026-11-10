> **DSH 运行注意（由 `dsh-src/skill-notes/setup-engine.md` 注入）**
>
> - **Windows 上探测 Godot 版本要用 `*_console.exe`**：主程序 `Godot_*.exe --headless --version`
>   在 Windows 上 stdout 是空的（GUI 子系统不带控制台），会得到 `installed version NOT DETERMINED`。
>   同目录的 `Godot_*_console.exe` 才会打印 `4.6.2.stable.mono.official.<hash>`。
>   本机实测：`..._console.exe --version` → `4.6.2.stable.mono.official.71f334935`。
> - **引擎配置写 `project.yaml`，别手改 `.dsh/docs/technical-preferences.md`**：后者是生成物
>   （`tools/build-dsh.mjs` 从 `.dsh/docs/technical-preferences.md` 复制），手改会在下次生成时被覆盖。
>   DSH 侧 `project.yaml` 是唯一来源，`/settings` 与 `node tools/yaml-helper.mjs` 都读它；
>   `technical-preferences.md` 只作为读不到键时的 legacy 回退。
> - **本注记压过正文第 5 节的"双写"要求**（实测冲突记录见框架仓库的验收台账（F1））。
>   正文第 5 节让你"创建或更新 `.dsh/docs/technical-preferences.md`"、§5.5.3 又要求读回 `project.yaml`
>   并核对"四个块与写进 `technical-preferences.md` 的值一致，不一致就报给用户并停止"——**这两句在 DSH 侧
>   无法同时满足**，因为那个文件是生成物。本移植的等价做法是：
>   1. **只写 `project.yaml` 的四个块**（`engine` / `specialists` / `naming` / `commands`）；
>   2. 读回核对改用 `node .dsh/scripts/project-coherence.mjs`，它以 `project.yaml` 为唯一基准，
>      `[DIFFERS]` 行以 `project.yaml` 为准，不要为此去改 `technical-preferences.md`；
>   3. 若 `[DIFFERS]` 指向的值在本 `minimal` 路径下**没有可执行来源**（例如 `commands.test` 指向未安装的
>      测试框架），按 §8.5 报告给用户并说明原因，**不要**换成未经技能授权的命令来"消除"它。
>   正文里凡出现"写 `technical-preferences.md`"的句子，按本节理解。
> - 沙箱限制下 Godot 需要把 `APPDATA` 指到工作区内才能启动，见 `dev-story` 技能里的同一段说明。


> - **本运行时对 §4/§8 的解释**：上游要求把 `AGENTS.md` 里 `ENGINE-REFERENCE-IMPORT` 标记下那一行改写成
>   `@docs/engine-reference/<engine>/VERSION.md`。DSH **不展开 `@` 导入**，所以本项目 `AGENTS.md` 里那一行是
>   **普通路径**（形如 `- **Engine reference**: \`docs/engine-reference/godot/VERSION.md\``）。
>   **改动与校验都按普通路径进行**：把 `<engine>` 换成所选引擎即可，不要去加 `@`。

# /setup-engine — Section 11: Upgrade Subcommand

> Part of `/setup-engine`. `SKILL.md` names when to read this file; the settings it
> resolved and the rules under its later headings still apply here.

## 11. Upgrade Subcommand

**In this file:**

- Step 1 — Read Current Version State
- Step 2 — Fetch Migration Guide
- Step 3 — Pre-Upgrade Audit
- Step 4 — Confirm Before Updating
- Step 5 — Update VERSION.md
- Step 6 — Post-Upgrade Reminder

If invoked as `/setup-engine upgrade [old-version] [new-version]`:

### Step 1 — Read Current Version State

Read `docs/engine-reference/<engine>/VERSION.md` to confirm the current pinned
version, risk level, and any migration note URLs already recorded. If
`old-version` was not provided as an argument, use the pinned version from this
file.

### Step 2 — Fetch Migration Guide

Search the web for the official migration guide between
`old-version` and `new-version`:

- Search: `"[engine] [old-version] to [new-version] migration guide"`
- Search: `"[engine] [new-version] breaking changes changelog"`
- Fetch the migration guide URL from VERSION.md if one is already recorded,
  or use the URL found via search.

Extract: renamed APIs, removed APIs, changed defaults, behavior changes, and
any "must migrate" items.

### Step 3 — Pre-Upgrade Audit

Scan the **code root** (resolve per `.dsh/docs/code-root-resolution.md`) for code that uses APIs known to be deprecated or changed in the
target version:

- Search it for deprecated API names extracted from the migration
  guide (e.g., old function names, removed node types, changed property names)
- List each file that matches, with the specific API reference found

Present the audit results as a table:

```
Pre-Upgrade Audit: [engine] [old-version] → [new-version]
==========================================================

Files requiring changes:
  File                              | Deprecated API Found       | Effort
  --------------------------------- | -------------------------- | ------
  src/gameplay/player_movement.gd   | old_api_name               | Low
  src/ui/hud.gd                     | removed_node_type          | Medium

Breaking changes to watch for:
  - [change description from migration guide]
  - [change description from migration guide]

Recommended migration order (dependency-sorted):
  1. [system/layer with fewest dependencies first]
  2. [next system]
  ...
```

If no deprecated APIs are found in the code root, report: "No deprecated API usage
found in the code root — upgrade may be low-risk."

### Step 4 — Confirm Before Updating

Ask the user before making any changes:

> "Pre-upgrade audit complete. Found [N] files using deprecated APIs.
> Proceed with upgrading VERSION.md to [new-version]?
> (This will update the pinned version and add migration notes — it does NOT
> change any source files. Source migration is done manually or via stories.)"

Wait for explicit confirmation before continuing.

### Step 5 — Update VERSION.md

After confirmation:

1. Update `docs/engine-reference/<engine>/VERSION.md`:
   - `Engine Version` → `[new-version]`
   - `Project Pinned` → today's date
   - `Last Docs Verified` → today's date
   - Re-evaluate and update the `Risk Level` and `Post-Cutoff Version Timeline`
     table if the new version falls beyond the LLM knowledge cutoff
   - Add a `## Migration Notes — [old-version] → [new-version]` section
     containing: migration guide URL, key breaking changes, deprecated APIs
     found in this project, and recommended migration order from the audit

2. If `breaking-changes.md` or `deprecated-apis.md` exist in the engine
   reference directory, append the new version's changes to those files.

3. If `project.yaml` exists at the repo root and has an `engine` block, Read it
   first, then update `engine.version` to `[new-version]` so the primary config
   store stays in sync with VERSION.md.

### Step 6 — Post-Upgrade Reminder

After updating VERSION.md, output:

```
VERSION.md updated: [engine] [old-version] → [new-version]

Next steps:
1. Migrate deprecated API usages in the [N] files listed above
2. Run /setup-engine refresh after upgrading the actual engine binary to
   verify no new deprecations were missed
3. Run /architecture-review — the engine upgrade may invalidate ADRs that
   reference specific APIs or engine capabilities
4. If any ADRs are invalidated, run /propagate-design-change to update
   downstream stories
```

---
