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

# /setup-engine — Sections 8 and 8.5: Verify and Read Back

> Part of `/setup-engine`. `SKILL.md` names when to read this file; the settings it
> resolved and the rules under its later headings still apply here.

## 8. Verify the AGENTS.md Import

**This import was already written in Section 4 — do not edit it again and do not
ask again.** Section 4 sets it as part of the same AGENTS.md write, anchored to
the `ENGINE-REFERENCE-IMPORT` marker. This step only confirms the result.

Read `AGENTS.md` and confirm the line under the marker reads:

```markdown
@docs/engine-reference/<engine>/VERSION.md
```

with `<engine>` the engine just configured. If there is no such line, or it still
points at a different engine, Section 4 did not complete — go back and finish it rather than patching
the line here.

> **Why this is a check and not a second write.** Repeating the edit here with
> its own approval prompt would ask the user twice for one change, and the second
> ask would be for work already done. Locate the line by its marker, never by the
> `## Engine Version Reference` heading — the marker exists precisely so the line
> can still be found when the heading moves or is reworded.

---

## 8.5 Read Back What You Just Wrote

Section 5.5.1's rendering/physics table warns against the two mistakes most
often made here, and it is still easy to make **both** of them, writing
`Forward+` and `Jolt` for a 2D browser game. Section 3's `Installed at pin time`
row is just as easy to drop silently, because a missing row leaves no trace.
Catch both by verifying the files after writing them:

```pwsh
node ".dsh/scripts/project-coherence.mjs"
```

It compares `project.yaml` against `docs/engine-reference/<engine>/VERSION.md`,
against `project.godot`, and against the engine binary actually on PATH, and it
checks that the files `commands.build` and `commands.test` name exist.

**Report every `[DIFFERS]` line to the user and resolve it before finishing.**
Each one means two files this skill just wrote disagree, or describe something
that is not there.

One is expected on a new Godot project: `commands.test` names the gdUnit4
runner under `addons/gdUnit4/`, which `/test-setup` installs later. Report that
line as expected, name `/test-setup` as the step that clears it, and never edit
`commands.test` to make it go away. Every other `[DIFFERS]` line is resolved here.

**`[NOT CHECKED]` is not a pass.** Each such line names why a comparison could
not be made -- an absent binary, a missing `project.godot`. Say which ones
applied. A comparison that could not run has not established agreement.

The script emits observations and never a verdict, per the convention in
AGENTS.md. The judgement is yours and the user's.

---
