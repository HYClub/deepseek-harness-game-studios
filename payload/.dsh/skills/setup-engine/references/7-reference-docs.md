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

# /setup-engine — Section 7: Populate Engine Reference Docs

> Part of `/setup-engine`. `SKILL.md` names when to read this file; the settings it
> resolved and the rules under its later headings still apply here.

## 7. Populate Engine Reference Docs

**In this file:**

- First: does a reference set already exist for this engine?
- Sourcing rule for everything written in this section
- If WITHIN training data (LOW RISK):
- If BEYOND training data (MEDIUM or HIGH RISK):

**Web:** the reference ships complete; compare it with the scaffold and write
nothing (`references/web.md`, W4).

### First: does a reference set already exist for this engine?

**Check before doing anything else.** The template ships
`docs/engine-reference/godot/`, `unity/` and `unreal/` **already populated**, so
"the directory exists and pins a version" is the state of *every* fresh project,
not an edge case. Both branches below say "create", and following either one
literally on a pre-populated directory either overwrites curated content or
leaves `project.yaml` and the AGENTS.md-imported reference disagreeing.

Read `docs/engine-reference/<engine>/VERSION.md` and compare its
**Engine Version** to the version chosen in Section 3:

- **No directory, or no `VERSION.md`** → create, using the risk branch below.
- **Same version** → nothing to regenerate. Refresh `Last Docs Verified` only if you
  actually re-verified against the docs this run. Do not restamp a date you did
  not check. The one row still written is `Installed at pin time`, from
  Section 3 — its probe result is recorded whatever the outcome, after asking
  "May I record `Installed at pin time: [result]` in
  `docs/engine-reference/<engine>/VERSION.md`?" (it is a tracked file).
- **Directory pins an OLDER version than the one chosen** → **update, do not
  replace.** This is the common case. Show the changes below, then ask "May I
  update the `docs/engine-reference/<engine>/` files for [version]?" before editing.
  1. Edit `VERSION.md` in place: new **Engine Version**, new **Project Pinned**
     and **Last Docs Verified**, the `Installed at pin time` row from Section 3,
     and a new row in the post-cutoff timeline for each version added.
  2. **Append** to `breaking-changes.md`, `deprecated-apis.md` and
     `current-best-practices.md` under a heading naming the version span
     (`## 4.6 → 4.7`). Never truncate the older spans — a project migrating
     across two versions still needs the earlier one.
  3. Re-grade the older timeline rows if the cutoff moved past them.
- **Directory pins a NEWER version than the one chosen** → stop and ask. Someone
  pinned forward deliberately, or the version choice is wrong. Do not silently
  downgrade a curated reference.

### Sourcing rule for everything written in this section

**Never fill a gap from training data. Write the gap down instead.**

The whole purpose of these files is to be the thing agents consult *instead of*
their training data. A confidently wrong entry here is worse than no entry: it
produces work that looks verified and is not.

- Every claim must come from a page you fetched this run. Record the URL.
- If the official docs do not state something the template asks for — a release
  date, a subsystem's behaviour, web-export specifics — write
  **`NOT SOURCEABLE — <what>, not stated at <url>`** and move on.
- A `NOT SOURCEABLE` line is a successful outcome, not a failure to finish.
- Do not infer one fact from an adjacent one. "The migration guide lists no
  physics change" is not "the physics default is unchanged"; if you record the
  inference, label it as an inference and name what it rests on.

### If WITHIN training data (LOW RISK):

Ask: "May I create `docs/engine-reference/<engine>/VERSION.md`?" Wait for
confirmation, then create this minimal file:

```markdown
# [Engine] — Version Reference

| Field | Value |
|-------|-------|
| **Engine Version** | [version] |
| **Project Pinned** | [today's date] |
| **Installed at pin time** | [Section 3 result — the installed version, or NOT DETERMINED] |
| **LLM Knowledge Cutoff** | [the cutoff from the Section 6 coverage table] |
| **Risk Level** | LOW — version is within LLM training data |

## Note

This engine version is within the LLM's training data. Engine reference
docs are optional but can be added later if agents suggest incorrect APIs.

Run `/setup-engine refresh` to populate full reference docs at any time.
```

Do not create breaking-changes.md, deprecated-apis.md, etc. — they would
add context cost with minimal value.

### If BEYOND training data (MEDIUM or HIGH RISK):

Create the full reference doc set by searching the web:

1. **Search for the official migration/upgrade guide**:
   - `"[engine] [old version] to [new version] migration guide"`
   - `"[engine] [version] breaking changes"`
   - `"[engine] [version] changelog"`
   - `"[engine] [version] deprecated API"`

2. **Fetch and extract** from official documentation:
   - Breaking changes between each version from the training cutoff to current
   - Deprecated APIs with replacements
   - New features and best practices

Ask: "May I create the engine reference docs under `docs/engine-reference/<engine>/`?"

Wait for confirmation before writing any files.

3. **Create the full reference directory**:
   ```
   docs/engine-reference/<engine>/
   ├── VERSION.md              # Version pin + knowledge gap analysis
   ├── breaking-changes.md     # Version-by-version breaking changes
   ├── deprecated-apis.md      # "Don't use X → Use Y" tables
   ├── current-best-practices.md  # New practices since training cutoff
   └── modules/                # Per-subsystem references (create as needed)
   ```

4. **Populate each file** using real data from the web searches, following
   the format established in existing reference docs. Every file must have
   a "Last verified: [date]" header.

5. **For module files**: Only create modules for subsystems where significant
   changes occurred. Don't create empty or minimal module files.

---
