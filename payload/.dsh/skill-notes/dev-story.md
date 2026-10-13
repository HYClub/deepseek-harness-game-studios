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
