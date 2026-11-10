> **DSH 运行注意（由 `dsh-src/skill-notes/dev-story.md` 注入）**
>
> - **委派深度**：DSH 的 `subagent` 默认 `maxDepth: 1` —— 主代理可以委派子代理，子代理不能再往下委派。
>   本技能的 Phase 3/4 由**主代理**委派 `engine-programmer` / 引擎专家，正常可用。
>   但如果执行本技能的人**自己已经是子代理**（被 `/team-*` 或 `workflow` 启动），它的委派会是第 2 层并被拒绝
>   （`subagent depth 2 exceeds maxDepth 1`）。此时按下面的降级路径自己实现，并在报告里写清
>   "多代理编排未评估"，不要把降级说成走通了。
>   确实需要两层以上时，在 profile 里给 `tool-subagent` 这一条加 `maxDepth: 2`（`dsh-base` 未设该字段，默认 1）。
> - **在受限会话里跑引擎**：文件沙箱拒绝 Godot 写 `%APPDATA%\Godot`，表现为
>   `Could not create directory: 'user://logs'`，甚至 `CrashHandlerException … signal 11` 退出。
>   启动前把用户数据目录挪进工作区（`--user-data-dir`、`HOME`、`XDG_DATA_HOME` 都无效，只有 `APPDATA` 有效）：
>
>   ```pwsh
>   $env:APPDATA = "$PWD\.godot-appdata"
>   & $godot --headless --path . --quit-after 2
>   ```
>
> - **"跑起来并看一眼"是真要求，不是形式**：本移植的实测里，run-and-observe 抓到了一个只有看帧才能发现的
>   玩法 bug（同一个节点既当已落方块又当下一个滑块，塔永远不会变窄、游戏不可能输）。解析通过、测试全绿都不能替代看帧。
> - 观测证据写 `production/qa/evidence/<story>/`，不要写进 `.dsh/`（生成物）或 `.dsh/`（内容源）。

# Phase 2: When the ADR or the manifest changed after the story was written

Read only when Phase 2 found a version mismatch.

## The ADR

The ADR's `version` (from `adr-status.sh`: its Last Verified date, else its Date,
else `unversioned`) differs from the story's `ADR Version`, or the ADR is
`unversioned` while the story names a date. Its decision may have changed.

Ask: "Story was written against ADR v[story date]. The ADR is now v[current].
How do you want to go on?" Options:

- **Re-read the changed ADR and refresh the story (Recommended).** Read the ADR's
  Decision, Engine Compatibility and ADR Dependencies sections with
  `"C:/Program Files/Git/bin/bash.exe" ".dsh/scripts/md-section.sh" extract <adr> "Decision"` and the same for
  the other two. Then edit the story: `ADR Version` becomes the ADR's `version`
  (never today's date, or the next run mismatches again), and the ADR Decision
  Summary and `## Implementation Notes` are replaced with the guidance you read.
  The programmer's brief carries the new guidance, never the old summary.
- **Implement from the story's summary — I accept the drift.** The brief carries the
  summary and tells the agent it predates the current ADR. Note it under Deviations.
- **Stop — I want to review the ADR first.** No agent runs.

## The control manifest

The story's `Manifest Version` differs from the manifest's. New rules may apply.

Ask: "Story was written against manifest v[story date]. The current manifest is
v[current]. How do you want to go on?" Options:

- **Update the story's manifest version and use the current rules (Recommended).**
  Set the story's `Manifest Version` to the current date, then read the layer's
  rules for the brief.
- **Use the old rules — I accept the risk.** Set `Manifest Version` to the current
  date and add `Manifest-Note: Proceeded with old manifest rules on [date] —
  non-compliance risk accepted.` to the story header. Note it under Deviations;
  `/story-done` carries the note into its deviations.
- **Stop — I want to review the manifest first.** No agent runs.

Each option names the story edit it makes, so choosing it is the ask.
