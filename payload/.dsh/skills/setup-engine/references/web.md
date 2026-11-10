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

# /setup-engine — Web (a browser game: Vite and TypeScript)

> Part of `/setup-engine`. `SKILL.md` names when to read this file; the settings it
> resolved and the rules under its later headings still apply here.

Read when the engine is **Web** (`/setup-engine web`). For Web it replaces
Sections 3, 6, 7 and 7.5 and gives the values Sections 4, 5 and 5.5 write;
Sections 8 and 12 still apply. Never load `godot-language-config.md`.

**In this file:** W1 An existing web project · W2 Node, the starter and the versions · W3 The
values to write · W4 The reference docs · W5 The scaffold · W6 Build, test and look ·
W7 No engine specialist agent

Web is a toolchain, not one engine (`docs/engine-reference/web/VERSION.md`): Vite,
TypeScript, Vitest and Playwright, with plain Canvas 2D and Web Audio by default.
The versions are the ones the scaffold pins, with its lockfile: never look up
"latest" and never change one here.

## W1. An existing web project

A `package.json` at the project root means an existing web project: record it
as it is and **change no file of the game**. Nothing is converted: its bundler,
language and tests stay its own. W1 replaces W2 to W6 for it (W7, and Sections
8 and 12, still apply); the scaffold is for a project with no web code yet.

1. **Read it:** `"C:/Program Files/Git/bin/bash.exe" ".dsh/scripts/web-detect.sh"`. It reads files only.
2. **`workspaces yes`:** stop, writing nothing: "This is a monorepo (<where>).
   上游运行时 Game Studios does not cover workspaces yet: open one game's own folder as the project
   and run `/setup-engine web` there."
3. **Node:** `node --version`. W2's range is the scaffold's tools', not this
   project's: do not apply it. No Node: record anyway, and say the build and
   the tests wait until Node is installed.
4. **`package_manager ?`** (lockfiles of two managers): ask which one the
   project uses, naming both lockfiles, then run the helper again with
   `--pm <name>`.
5. **Show the record and confirm it** before writing, in one block: the package
   manager and why; each `command` row (a `-` is not written, with its reason);
   the code root, test root, language, bundler and version, test runner,
   library and hook. Then:
   - **`code_root -`** (no `src/`): ask where the game's code is, offering each
     `code_root_candidate` (`.` is a flat game) — it becomes `engine.code_root`.
   - **`test_root … write`**: `engine.test_root` is that folder. `table`:
     nothing to write.
   - **`test_runner other`**: say its results are read by exit code only, so a
     run of zero tests looks like a pass. **`none`**: say the checks that run
     tests will be NOT ASSESSED until the project has a `test` script.
6. **Write** (Sections 4, 5 and 5.5), on a yes, only these three files:
   - **AGENTS.md**, with the import line `@docs/engine-reference/web/VERSION.md`:
     ```markdown
     - **Engine**: Web (<bundler> <engine_version>; <library> <range>, when there is one)
     - **Language**: <language>
     - **Build System**: <bundler> — `<build command>` (the project's own scripts; no single-file build)
     - **Asset Pipeline**: the project's own, as it is
     ```
     With no bundler: `Web (no bundler: the files as they are)`.
   - **technical-preferences.md**: Engine Web and the language; W3's naming
     defaults, unless the project's own files plainly use another style (record
     what they use). No specialist rows (W7).
   - **`project.yaml`**: W3's blocks, with the project's values: `engine.name:
     "Web"`, `engine.version` (the `engine_version` row; left out when `-`),
     `engine.language`, `engine.code_root` / `engine.test_root` only when asked
     above, and `commands` from the `command` rows that are not `-` (never
     `install`). No `rendering` or `physics`: `package.json` is the record of
     what the game uses.
7. **The reference** (`docs/engine-reference/web/`) describes the template's
   versions (Vite 8, TypeScript 7). When the project's bundler or versions
   differ, say so in one line: API answers are checked against the project's
   own versions, not the pinned table. W4's comparison is skipped.
8. **Build and test**, installing nothing unasked. No `node_modules/`: show the
   `install` command and ask, as W5 step 3 does (it installs exactly what the
   lockfile pins and changes no file). An install that refuses (a lockfile out
   of step with `package.json`): report its error line and stop the build step;
   never fall back to `npm install`, which rewrites the lockfile. `install -`
   (no lockfile): an install would write one, so do not run it; say "install
   the dependencies your usual way, then run `/smoke-check`". Then run the
   `build` command and `"C:/Program Files/Git/bin/bash.exe" ".dsh/scripts/test-run.sh" web`, and report each:
   command, exit code, the `runner` and `rule` rows. `web:no-test-script` is
   `NOT ASSESSED — no tests`. A build writes only to the project's own output
   folder.
9. **Look:** shoot the build's own `index.html` from disk:
   `node ".dsh/scripts/page-shot.mjs" <build folder>/index.html
   production/qa/evidence/setup-engine-web/01-first-screen.png --software
   --file-access`. `--file-access` lets the page load its module scripts and
   its own images and data, as it does from a server. Read the image and say
   what is on screen, with any `uncaught` lines (the game's own errors, which
   上游运行时 Game Studios reports and does not fix here). A blank page whose console says a file
   from the root (`/assets/…`, Vite's default `base`) did not load is
   `NOT ASSESSED — the build asks for files from the server's root, which a
   page opened from disk cannot reach`; never start `commands.run` and never
   change the game's config to get round it.
10. **The game-state hook** (`hook absent`): say which checks read NOT ASSESSED
    without it (scripted runs, state reads, same-seed replays; screenshots and
    the console still run). Offer it as one question: `Not now` (recommended
    when the person only came to set up) / `Add it as its own change`. Never
    add it unasked. On yes, it is a checkpointed change: the game's files must
    be committed first (ask before committing them; with uncommitted changes
    and no yes, stop). Then add `window.game` (the scaffold's `src/hook.ts` API:
    `scene`, `state`, `press`, `hold`, `step`) in the game's own language beside
    its entry point, wired to its state and input; `step` only where the game's
    loop can be stepped (a library that keeps its own time, such as Phaser or
    PixiJS, leaves replays NOT ASSESSED). Build, run the tests, show the diff,
    and ask before committing it on its own
    (`feat: the game-state hook for 上游运行时 Game Studios' checks`).

## W2. Node, the starter and the versions (Section 3)

With no `package.json` (W1), probe Node before anything else: `node --version`.
The tools need `^22.12 || ^24 || >=26`.

- **Absent or too old:** say it plainly and stop: "A web project needs Node.js
  22.12 or later; 24 is the current long-term release (nodejs.org). Install it
  and run `/setup-engine web` again. `/prototype` makes browser games without
  Node." Found too old, name the version found.
- **In range:** say so in one line and go on.

**The starter: one question.** Ask it once, with "none" first and recommended
(the question tool where there is one, else a short numbered list in plain text):

> What should the game be built with? You can add a library later, like any
> other package.
> 1. **Nothing extra (recommended):** the browser's own drawing and sound. Enough
>    for most 2D games, and the least to learn.
> 2. **three.js:** for a game in 3D.
> 3. **Phaser:** a 2D game framework, with sprites, physics and scenes built in.
> 4. **PixiJS:** fast 2D drawing, for many moving pictures and effects.

When the person's own words already name one of the three, take it and say so
in one line instead of asking. The answer is the starter: `none`, `three`,
`phaser` or `pixi`. Each is the same small game (a title screen and a square
that moves) drawn with that library, with the game-state hook wired in, at the
version `VERSION.md`'s table pins.

`engine.version` is the Vite version the scaffold pins: read the `"vite"` line
of `.dsh/engines/web/scaffold/package.json`. The other pins are in the same
file and in `VERSION.md`'s table, which must match it. A starter's library is
pinned in `.dsh/engines/web/starters/<starter>/package.json`.

## W3. The values to write (Sections 4, 5 and 5.5)

Read every version below from the scaffold's `package.json`; the numbers shown
are its pins on the day this was written.

**AGENTS.md** (Section 4), with the import line set to
`@docs/engine-reference/web/VERSION.md`:

With a starter, the Engine line also names its library at its pin, for
example `Web (Vite 8.3.4, TypeScript 7.0.2, Phaser 4.2.1)`.

```markdown
- **Engine**: Web (Vite 8.3.4, TypeScript 7.0.2)
- **Language**: TypeScript
- **Build System**: Vite — `npm run build` for `dist/`, `npm run build:single` for one self-contained HTML file
- **Asset Pipeline**: plain files in `assets/`, imported in the code
```

**technical-preferences.md** (Section 5): Engine Web, language TypeScript, and
these naming defaults: classes, types and interfaces PascalCase (`GameHook`);
variables and functions camelCase (`newState()`); module-level constants
SCREAMING_SNAKE (`STEP`); files kebab-case (`rules.ts`); event handlers
`on<Event>`. No specialist rows (W7).

**`project.yaml`** (Section 5.5), the four blocks:

```yaml
engine:
  name: "Web"
  version: "8.3.4"
  language: "TypeScript"
  rendering: "Canvas 2D"
  physics: "none"

specialists:
  code: "lead-programmer"
  shader: "lead-programmer"
  ui: "lead-programmer"
  additional: []

naming:
  classes: PascalCase
  variables: camelCase
  constants: SCREAMING_SNAKE
  signals: on_event_name
  files: kebab-case
  scenes: snake_case

commands:
  build: "npm run build"
  test: "npm test"
  run: "npm run dev"
  smoke: "npm run smoke"
```

- `Web` with the capital: the check is case-sensitive, and `web` reads as unset.
- No `engine.code_root`: `src` comes from the engine table
  (`.dsh/engines/engines.tsv`), and so do the four commands.
- `rendering` follows the starter: `Canvas 2D` (none), `three.js (WebGL)`,
  `Phaser 4` or `PixiJS 8`. `physics` stays `none`. A game that adds a library
  later changes them with `/project-settings`; its `package.json` is the record of
  what it uses.
- `run` is the Vite dev server, for the person to play while they work. It never
  exits, so no check runs it.

## W4. The reference docs (Sections 6 and 7)

The knowledge gap is **HIGH**: every pinned version is newer than the model's
training (`VERSION.md`, "Post-Cutoff Version Timeline"). The reference ships
complete in `docs/engine-reference/web/`: no web search, nothing to write.
Compare its pinned table with the scaffold's `package.json`, and with the
starter's when there is one; when they differ, stop and name each package that
differs. Do not edit `VERSION.md`: its
"Installed at pin time" is per project, read from the lockfile.

## W5. The scaffold (Section 7.5)

1. Show what would be made:
   `node ".dsh/scripts/web-scaffold.mjs" --dry-run --title "<the game's name>" --starter <starter>`
   — the brief's working title, else the project folder's name; the starter from
   W2 (its `starter` row names the library and version). Each
   `WOULD_CREATE` row is a file; each `gitignore … missing` row is a line the
   project's `.gitignore` lacks (build output, test reports).
2. Ask: "May I create these files and add the missing lines to `.gitignore`?"
   On a yes, run it again without `--dry-run`, with `--gitignore` and the same
   `--starter`. It never overwrites a file. A `refused` row is W1's case.
3. Show `npm ci` and ask before running it: it installs exactly what
   `package-lock.json` pins (about 90 packages from the npm registry, more with a
   starter's library), runs their
   install scripts, and needs the network; npm's own proxy settings apply.
   Declined or offline: say what still works (`/prototype`, `page-shot.sh`), and
   that the build and the tests wait for `npm ci`.

## W6. Build, test and look

After `npm ci`, run each and report its command, exit code and result:

1. `npm run build`: the type check (`tsc --noEmit`), then `dist/`.
2. `"C:/Program Files/Git/bin/bash.exe" ".dsh/scripts/test-run.sh" web`: Vitest, then Playwright on the
   single-file build, each read apart (`rule` row).
   - **No browser** (`browser -` or `rule web:no-browser`): Playwright uses the
     browser `page-shot.sh --which` finds. Ask before
     `npx playwright install chromium-headless-shell` (a download of about
     100 MB to your home folder), then run the tests again. Declined: the
     browser tests are `NOT ASSESSED — no browser`, by name.
3. Keep one screenshot: `node ".dsh/scripts/page-shot.mjs" dist-single/index.html
   production/qa/evidence/setup-engine-web/01-title.png`. Read the image and say
   what is on screen; the title screen shows the game's name and its controls.
   This is the project's first retained evidence.

`/test-setup` then adds the CI workflow and the tests README.

## W7. No engine specialist agent (Section 9)

Web has no engine specialist agent: skip Section 9 and say so in one line.
Engine work and API checks go to `lead-programmer` against
`docs/engine-reference/web/`.
