> **来源与状态**：这份报告由一次隔离副本最小闭环实测（2026-10-08，执行者是 DSH 子代理）原样保留，
> 用于记录移植的真实行为与当时发现的缺陷。**报告写于修复之前**，其中的问题按下面的处置表逐条跟踪；
> 引用时请以本页顶部的处置结论为准。副本本身在 `.smoke/`（已 gitignore）。
# DSGS (DSH port) minimal-loop smoke test — Stack Drop

**Run**: in the isolated copy `D:\Work\dsh\.smoke\studio` only.
**Engine**: Godot 4.6.2-stable (mono), `4.6.2.stable.mono.official.71f334935`.
**Result**: the 6-step loop **completed**. All 3 stories are `Complete`.
No commit was made (no user instruction to commit).

---

## 1. Step-by-step

| Step | Status | Skill file loaded | Produced | Stuck / notes |
|---|---|---|---|---|
| 1 `/start` | Completed | `.dsh/skills/start/SKILL.md` (422 lines) | `project.yaml` (`project.stage: Concept`, `modes.rigor: minimal`, `modes.automation: guided`), `production/stage.txt` | Ran autonomously: Phase 2/3d/3e questions were answered as the stated persona instead of live prompts. Precommand `resolve_config --keys review_mode,workflow,qa.level` → correct. |
| 2 `/setup-engine` | Completed | `.dsh/skills/setup-engine/SKILL.md` (1433 lines) + `references/godot-language-config.md` (147 lines) | `project.yaml` (+`engine`/`specialists`/`naming`/`commands`), `.dsh/docs/technical-preferences.md`, `docs/engine-reference/godot/VERSION.md` (`Installed at pin time`), `CLAUDE.md` | Version probe returned empty (wrong exe variant, H4). Installed = 4.6.2 vs pin 4.6 → `MATCH` on major.minor, so no mismatch prompt. |
| 3 `/brainstorm` | Completed | `.dsh/skills/brainstorm/SKILL.md` (488 lines) | `design/game-brief.md` | Lean Brief flow selected correctly by `workflow: minimal`. Clean. |
| 4 `/create-stories` | Completed | `.dsh/skills/create-stories/SKILL.md` (516 lines) | `production/epics/stack-drop/{EPIC.md,story-001,story-002,story-003}.md`, `production/epics/index.md` | `minimal` branch taken; `index.md` did not exist, so it was created (the skill only *updates* it). Clean. |
| 5 `/dev-story` | Completed | `.dsh/skills/dev-story/SKILL.md` (693 lines) + `.dsh/docs/run-and-observe.md` | `config/stack_drop.cfg`, `src/gameplay/{landing_resolution,game_state,stack_config}.gd`, `src/ui/{main.gd,main.tscn}`, `project.godot`, `tests/unit/gameplay/landing_resolution_scenarios.gd`, `production/qa/evidence/stack-drop/**` | **Phase 4's designated route is unusable**: DSH caps subagent nesting at depth 1, so no primary programmer + engine specialist could be spawned. Implemented directly instead. |
| 6 `/story-done` | Completed | `.dsh/skills/story-done/SKILL.md` (810 lines) | 3 × `Status: Complete` + `## Completion Notes`, `tests/playtest/stack-drop/story-002-….md`, `production/qa/evidence/stack-drop-evidence.md`, `production/session-state/active.md` | `story-status.mjs` → `COMPLETE 3 of 3`. |

Verification actually run:

- Parse check `.dsh/scripts/godot-parse-check.gd` on all 5 `.gd` → `ok:` ×5, exit 0.
- AC scenarios headless → **18 checks, 0 failed**, exit 0.
- Run-and-observe via `--write-movie` → **201/200 real PNG frames**, opened and inspected.
- `check-dsh.mjs` → `errors=0 warnings=0`.
- `project-coherence.mjs` → 2 remaining real diffs (M3, M4).

## 2. Produced files

```
project.godot
project.yaml
CLAUDE.md
config/stack_drop.cfg
design/game-brief.md
src/gameplay/landing_resolution.gd
src/gameplay/game_state.gd
src/gameplay/stack_config.gd
src/ui/main.gd
src/ui/main.tscn
tests/unit/gameplay/landing_resolution_scenarios.gd
tests/playtest/stack-drop/story-002-sliding-block-and-drop.md
production/stage.txt
production/session-state/active.md
production/epics/index.md
production/epics/stack-drop/EPIC.md
production/epics/stack-drop/story-001-landing-resolution.md
production/epics/stack-drop/story-002-sliding-block-and-drop.md
production/epics/stack-drop/story-003-camera-score-gameover.md
production/qa/evidence/stack-drop-evidence.md
production/qa/evidence/stack-drop/01-block-sliding.png
production/qa/evidence/stack-drop/02-tower-tapering.png
production/qa/evidence/stack-drop/03-game-over.png
production/qa/evidence/stack-drop/_raw/f00000000..199.png   (full capture)
prototypes/render-probe/project.godot
prototypes/render-probe/probe.tscn
prototypes/render-probe/PROOF-render-works.png
.dsh/docs/technical-preferences.md      (modified)
docs/engine-reference/godot/VERSION.md  (modified)
```

## 3. Porting defects, by severity

### CRITICAL — the "isolated copy" is not isolated

`.smoke/studio/.dsh/hooks.json` hardcodes the **real repo** in all 13 places:
`"projectDir": "D:/Work/dsh"` (line 8) plus 12 absolute
`node "D:/Work/dsh/.dsh/hooks/<hook>.mjs"` commands (lines 16-127).

Repro: `Select-String -Path .dsh/hooks.json -Pattern 'D:/Work/dsh'` → 13 hits.

Cause: the generator emits absolute paths for the path it was run from, so any copy
of `.dsh/` keeps pointing at its origin. Consequence: a smoke test cannot exercise
the hooks of the copy — it drives the hooks of the live repo. Evidence this bit here:
`node .dsh/hooks/session-start.mjs` with `cwd` set to the studio copy emitted
`"Review mode: solo"` — read from the **framework** repo, not the copy, because the
hook resolves its root from its own location. Also note `D:\Work\dsh\production\session-logs\compaction-log.txt`
was last written `2026/10/8 15:37`, i.e. **before** this session (15:57), so the
hooks did not fire here; the wiring is latent, not proven live.

### CRITICAL — no skill can spawn the agents it routes to

`/dev-story` Phase 3/4 mandatorily spawns `engine-programmer` **plus** the engine
specialist; `/brainstorm` spawns `creative-director` + `art-director`. All 12 role
cards I checked exist in `.dsh/agents/`, but the DSH session refuses the spawn:

```
Error: subagent depth 2 exceeds maxDepth 1
```

Cause: `maxDepth 1` for this session. Consequence: every orchestrator skill
(`/dev-story`, `/team-*`, and `/brainstorm` at `standard`/`full`) cannot run its
documented flow — the single largest structural gap in the port. `review_mode: solo`
masked it here (director gates are skipped at `solo`), but Phase 4's programmer route
has no `solo` exemption and fired anyway.

### CRITICAL — `resolve_config --keys` silently drops unknown keys

```
node tools/yaml-helper.mjs resolve_config --keys modes.rigor,modes.automation,project.stage
→ === DSGS Config … ===
  project.stage: Concept (project.yaml)
  === end ===            exit 0
```
`modes.rigor` → empty; `modes.automation` → empty; `modes.workflow` → empty.
The canonical key is the **bare** `rigor` / `automation`; `modes.*` is a no-op.

Cause: the alias table has no `modes.` prefix arm, and unmatched keys are dropped
without a warning and without a non-zero exit. Consequence: a skill writing
`--keys modes.rigor` reads a *correct-looking empty block* and falls back to defaults
— the port already documents `resolve_config --keys engine`-style reads, so the
namespaced spelling is an easy mistake that fails silently and wrongly.

### HIGH — `__call` output has no trailing separator

```
node tools/yaml-helper.mjs __call get_yaml_key project.yaml commands.run
node tools/yaml-helper.mjs __call get_yaml_key project.yaml commands.build
→ ...--resolution 1280x720"C:/Users/.../Godot_v4.6.2-..._console.exe" --headless --export-debug "..."
```
Two invocations in one shell concatenate into one malformed line. Any caller reading
two keys this way gets a corrupted value. (Repro: both commands on one line.)

### MEDIUM — Godot's documented version probe returns empty on Windows

`/setup-engine` §3's table says probe `godot --version`, else find `Godot_v*`. The
`Godot_v4.6.2-stable_mono_win64.exe` prints **nothing** under captured stdout:

```
& <main>.exe --headless --version   → captured stdout: []
& <main>_console.exe --headless --version → 4.6.2.stable.mono.official.71f334935
```
Cause: the plain `.exe` detaches from the console; only the `_console.exe` twin
writes to the inherited stdout. Consequence: following the skill literally yields
`installed version NOT DETERMINED` on a machine where the engine is installed and
works — the exact false negative §3 warns about.

### MEDIUM — Godot cannot start at all under the file sandbox

With the session's real `APPDATA`:
```
ERROR: Could not create directory: 'user://logs'.
CrashHandlerException: Program crashed with signal 11   (exit -1073741819)
```
`%APPDATA%\Godot` exists but is sandbox-denied for writes.

**Fixes nothing**: `--user-data-dir <path>`, `HOME`, `XDG_DATA_HOME`.
**Fixes it**: `$env:APPDATA='<workspace>\.godot-user'` → same command renders, exit 0.

Consequence: `.dsh/docs/run-and-observe.md` (Godot row) and `/dev-story` Phase 6
step 4 will crash on the first attempt in any DSH session on Windows, and the crash
reads as a broken build rather than an environment problem.

### MEDIUM — `commands.build` written unusable

`/setup-engine` §5.5.1 says to write `[TO BE CONFIGURED]` when no export preset
exists. It then leaves the literal in a command:
`... --export-debug "[TO BE CONFIGURED]"`. `project-coherence.mjs`:
> `commands.build is '…' but there is no export_presets.cfg. Godot cannot resolve the preset, so this command fails the first time CI or /smoke-check runs it.`

Cause: a placeholder written into an executable field.

### MEDIUM — `commands.test` written unusable

`/setup-engine` writes gdUnit4's runner unconditionally, before `/test-setup` has
installed it. `project-coherence.mjs`:
> `'addons/gdUnit4/bin/GdUnitCmdTool.gd' does not exist, so this command cannot run as written. gdUnit4 is not installed at addons/gdUnit4/ — see /test-setup.`

### MEDIUM — the copy is stale, and the running session uses the framework, not the copy

`.dsh/docs/studio-rules.md` exists in `D:\Work\dsh\.dsh\docs\` but **not** in the
studio copy; the copy's `AGENTS.md` is 5277 bytes vs 5661 in the framework (the
framework version gained the "DSH 不展开 `@` 导入" section). The `skill` tool also
resolved the base directory to the **framework**, not the copy:

```
Base directory for this skill: D:\Work\dsh\.dsh\skills\start      ← framework
                                 .smoke\studio\.dsh\skills\start  ← the copy
```
(Contents were byte-identical — SHA256 `319F76D5…` — so no wrong content reached me.)

Cause: the copy was taken before the latest `node tools/build-dsh.mjs` run, and skill
discovery is rooted at the session workspace (`D:\Work\dsh`), not the `.smoke` copy.
Consequence: a stale-copy smoke test silently exercises the live repo's skills.

### LOW — the ported skill contradicts the tree contract

`/setup-engine` §5 says to write `.dsh/docs/technical-preferences.md`, but
`.smoke/studio/AGENTS.md` says `.dsh/` is *generated* — "**不要手改**，改了下次生成就被覆盖".
Following the skill mutates generated output. Repro: `AGENTS.md` directory-contract
table vs `setup-engine/SKILL.md` line 269.

### LOW — minimal-tier story template names an unusable test path

`/create-stories` writes `tests/unit/[system]/[story-slug]_test.[ext]` with range
syntax that `glob`/`path exists` cannot resolve, and no gdUnit4 exists to satisfy it —
while `story-done` Phase 3 §"For Logic stories" globs that exact path. Only harmless
because `qa.level: minimal` waives test evidence.

### LOW — one real game defect, found only by looking

`src/ui/main.gd`'s `_on_landed` initially reused the *same* node as both the placed
block and the next slider, so after the first drop every landing had zero overhang and
the tower could never narrow — the game could not be lost by width. Found by inspecting
captured frames; fixed so the placed block is fixed into the tower and the slider keeps
its own x. This is the run-and-observe step paying for itself.

## 4. Did the loop finish?

Yes — all 6 steps, including `/story-done`. Nothing was left unverified except:

- **`/dev-story` Phase 4 verification could not run as designed** (nesting cap), so
  I implemented the code directly rather than through `engine-programmer` +
  `godot-gdscript-specialist`. The port's multi-agent orchestration is therefore
  **NOT ASSESSED** — I did not test it, I worked around it.
- **The hooks are NOT ASSESSED in this copy**: `log-agent.mjs` / `log-agent-stop.mjs`
  were never exercised (no subagent could spawn), and `hooks.json` points at the
  framework repo, so any hook evidence would have been about the wrong tree.
- The Visual/Feel *feel* half (timing, weight) is not assessable from a still and was
  left to `/team-qa`, per `.dsh/docs/run-and-observe.md`.


