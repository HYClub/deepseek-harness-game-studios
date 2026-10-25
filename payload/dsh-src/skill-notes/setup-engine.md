> **DSH 运行注意（由 `dsh-src/skill-notes/setup-engine.md` 注入）**
>
> - **Windows 上探测 Godot 版本要用 `*_console.exe`**：主程序 `Godot_*.exe --headless --version`
>   在 Windows 上 stdout 是空的（GUI 子系统不带控制台），会得到 `installed version NOT DETERMINED`。
>   同目录的 `Godot_*_console.exe` 才会打印 `4.6.2.stable.mono.official.<hash>`。
>   本机实测：`..._console.exe --version` → `4.6.2.stable.mono.official.71f334935`。
> - **引擎配置写 `project.yaml`，别手改 `.dsh/docs/technical-preferences.md`**：后者是生成物
>   （`tools/build-dsh.mjs` 从 `.claude/docs/technical-preferences.md` 复制），手改会在下次生成时被覆盖。
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
