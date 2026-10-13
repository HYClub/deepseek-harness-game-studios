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
> - **本注记压过正文第 5 节的"双写"要求**（实测冲突记录：`docs/DSH-SMOKE-CURRENT.md` F1）。
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

# Godot Language Configuration — setup-engine reference

Lookup tables for `/setup-engine`, split out of the skill body so they cost
nothing on invocations that are not Godot. Read this file only when the
chosen engine is Godot, and then only the subsection for the chosen language.

Referenced from Sections 4, 5 and 5.5 of
`.dsh/skills/setup-engine/SKILL.md` by the names A1, A2 and A3.

---

### A1. AGENTS.md Technology Stack Templates

**GDScript:**
```markdown
- **Engine**: Godot [version]
- **Language**: GDScript
- **Build System**: SCons (engine), Godot Export Templates
- **Asset Pipeline**: Godot Import System + custom resource pipeline
```

> **Guardrail**: When using this GDScript template, write the Language field as exactly "`GDScript`" — no additions. Do NOT append "C++ via GDExtension" or any other language. The C# template below includes GDExtension because C# projects commonly wrap native code; GDScript projects do not.

**C#:**
```markdown
- **Engine**: Godot [version]
- **Language**: C# (.NET 8+, primary), C++ via GDExtension (native plugins only)
- **Build System**: .NET SDK + Godot Export Templates
- **Asset Pipeline**: Godot Import System + custom resource pipeline
```

**Both — GDScript + C#:**
```markdown
- **Engine**: Godot [version]
- **Language**: GDScript (gameplay/UI scripting), C# (performance-critical systems), C++ via GDExtension (native only)
- **Build System**: .NET SDK + Godot Export Templates
- **Asset Pipeline**: Godot Import System + custom resource pipeline
```

---

### A2. Naming Conventions

**GDScript:**
- Classes: PascalCase (e.g., `PlayerController`)
- Variables/functions: snake_case (e.g., `move_speed`)
- Signals: snake_case past tense (e.g., `health_changed`)
- Files: snake_case matching class (e.g., `player_controller.gd`)
- Scenes: snake_case matching the file (e.g., `player_controller.tscn`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_HEALTH`)

> **This list and the `naming` enum table in Section 5.5.1 of the skill must
> agree, value for value.** They are written into two different files —
> `technical-preferences.md` from here, `project.yaml` from there — and Section
> 5.5.3 compares them and **stops the skill** on any mismatch. They disagreed on
> `scenes` (this list said PascalCase, the enum table said snake_case) for the
> GDScript column only, which halted `/setup-engine` on the most common Godot
> configuration there is. Changing a value in one place without the other
> reintroduces that halt.

**C#:**
- Classes: PascalCase (`PlayerController`) — must also be `partial`
- Public properties/fields: PascalCase (`MoveSpeed`, `JumpVelocity`)
- Private fields: `_camelCase` (`_currentHealth`, `_isGrounded`)
- Methods: PascalCase (`TakeDamage()`, `GetCurrentHealth()`)
- Signal delegates: PascalCase + `EventHandler` suffix (`HealthChangedEventHandler`)
- Files: PascalCase matching class (`PlayerController.cs`)
- Scenes: PascalCase matching root node (`PlayerController.tscn`)
- Constants: PascalCase (`MaxHealth`, `DefaultMoveSpeed`)

**Both — GDScript + C#:**
Use GDScript conventions for `.gd` files and C# conventions for `.cs` files. Mixed-language files do not exist — the boundary is per-file. When in doubt about which language a new system should use, ask the user and record the decision in `technical-preferences.md`.

---

### A3. Engine Specialists Routing

**GDScript:**
```markdown
## Engine Specialists
- **Primary**: godot-specialist
- **Language/Code Specialist**: godot-gdscript-specialist (all .gd files)
- **Shader Specialist**: godot-shader-specialist (.gdshader files, VisualShader resources)
- **UI Specialist**: godot-specialist (no dedicated UI specialist — primary covers all UI)
- **Additional Specialists**: godot-gdextension-specialist (GDExtension / native C++ bindings only)
- **Routing Notes**: Invoke primary for architecture decisions, ADR validation, and cross-cutting code review. Invoke GDScript specialist for code quality, signal architecture, static typing enforcement, and GDScript idioms. Invoke shader specialist for material design and shader code. Invoke GDExtension specialist only when native extensions are involved.

### File Extension Routing

| File Extension / Type | Specialist to Spawn |
|-----------------------|---------------------|
| Game code (.gd files) | godot-gdscript-specialist |
| Shader / material files (.gdshader, VisualShader) | godot-shader-specialist |
| UI / screen files (Control nodes, CanvasLayer) | godot-specialist |
| Scene / prefab / level files (.tscn, .tres) | godot-specialist |
| Native extension / plugin files (.gdextension, C++) | godot-gdextension-specialist |
| General architecture review | godot-specialist |
```

**C#:**
```markdown
## Engine Specialists
- **Primary**: godot-specialist
- **Language/Code Specialist**: godot-csharp-specialist (all .cs files)
- **Shader Specialist**: godot-shader-specialist (.gdshader files, VisualShader resources)
- **UI Specialist**: godot-specialist (no dedicated UI specialist — primary covers all UI)
- **Additional Specialists**: godot-gdextension-specialist (GDExtension / native C++ bindings only)
- **Routing Notes**: Invoke primary for architecture decisions, ADR validation, and cross-cutting code review. Invoke C# specialist for code quality, [Signal] delegate patterns, [Export] attributes, .csproj management, and C#-specific Godot idioms. Invoke shader specialist for material design and shader code. Invoke GDExtension specialist only when native C++ plugins are involved.

### File Extension Routing

| File Extension / Type | Specialist to Spawn |
|-----------------------|---------------------|
| Game code (.cs files) | godot-csharp-specialist |
| Shader / material files (.gdshader, VisualShader) | godot-shader-specialist |
| UI / screen files (Control nodes, CanvasLayer) | godot-specialist |
| Scene / prefab / level files (.tscn, .tres) | godot-specialist |
| Project config (.csproj, NuGet) | godot-csharp-specialist |
| Native extension / plugin files (.gdextension, C++) | godot-gdextension-specialist |
| General architecture review | godot-specialist |
```

**Both — GDScript + C#:**
```markdown
## Engine Specialists
- **Primary**: godot-specialist
- **GDScript Specialist**: godot-gdscript-specialist (.gd files — gameplay/UI scripts)
- **C# Specialist**: godot-csharp-specialist (.cs files — performance-critical systems)
- **Shader Specialist**: godot-shader-specialist (.gdshader files, VisualShader resources)
- **UI Specialist**: godot-specialist (no dedicated UI specialist — primary covers all UI)
- **Additional Specialists**: godot-gdextension-specialist (GDExtension / native C++ bindings only)
- **Routing Notes**: Invoke primary for cross-language architecture decisions and which systems belong in which language. Invoke GDScript specialist for .gd files. Invoke C# specialist for .cs files and .csproj management. Prefer signals over direct cross-language method calls at the boundary.

### File Extension Routing

| File Extension / Type | Specialist to Spawn |
|-----------------------|---------------------|
| Game code (.gd files) | godot-gdscript-specialist |
| Game code (.cs files) | godot-csharp-specialist |
| Cross-language boundary decisions | godot-specialist |
| Shader / material files (.gdshader, VisualShader) | godot-shader-specialist |
| UI / screen files (Control nodes, CanvasLayer) | godot-specialist |
| Scene / prefab / level files (.tscn, .tres) | godot-specialist |
| Project config (.csproj, NuGet) | godot-csharp-specialist |
| Native extension / plugin files (.gdextension, C++) | godot-gdextension-specialist |
| General architecture review | godot-specialist |
```
