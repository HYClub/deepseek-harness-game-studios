> **来源**：第三次隔离实测的报告（在 smoke 副本里跑了 `help` / `project-stage-detect` / `gate-check`
> 三个高流量技能）。保留它，因为里面的 HIGH 级发现**是上游 DSGS 自身的矛盾**，不是移植缺陷：
> `help` 说 minimal 档没有阶段门禁，而 gate 的 reference 又为 minimal 定义了一套缩减门禁。
> 本移植**没有改动上游内容**，而是用 `dsh-src/skill-notes/gate-check.md` 记录处置原则。
> 副本在 `.smoke/`（已 gitignore）。
# Skill smoke: help · project-stage-detect · gate-check

Project: `.smoke/studio` (Godot 4.6, stack-drop) · All commands run from the project root.
No framework file was modified. No skill was allowed to write anything; the only file written is this report.

## 1. Results

| Skill | Status | Key output | Verdict produced |
|---|---|---|---|
| `help` | **Complete** | prereq `workflow: minimal (rigor:minimal)` / `project.stage: Concept (project.yaml)`; `artifact-check --path minimal` = engine-setup/game-brief/create-stories PRESENT, implement/story-done NO_CHECK; `story-status.mjs` = `COMPLETE 3 of 3` | Route terminal: all 3 stories complete → play build / `/create-stories` / `/settings`. **COMPLETE**. Read-only, wrote nothing. |
| `project-stage-detect` | **Partial** | prereq `automation: guided` / `workflow: minimal`; bare `artifact-check` = 7 phases / 49 steps / 25 NO_CHECK; src = 7 real `.gd`/`.tscn` (+2 `.uid`) | Configured **Concept** vs observed **Pre-Production** → at `minimal` this is the expected lag, so Stage Confidence **PASS**. Report file not written (needs approval). |
| `gate-check` | **Partial** | prereq: `review_mode: solo`, `qa.level: minimal`, `team.size: individual`, `testing.strict: logic=unset…`, `performance.enforce: warn (default)`, `system_overrides: none`; gate file `references/gate-systems-design.md`; `gdd-structure-check.mjs` = `No system GDDs found in design/gdd/.` | Drafted **CONCERNS** for Concept → Systems Design: required artifact `design/game-brief.md` (2691 B, 5 sections) PRESENT; blockers = none; concerns = target audience never stated, core loop written but unplayed. Panel skipped (`solo`). No stage write (CONCERNS ≠ PASS). |

## 2. Raw helper output

`node ".dsh/scripts/artifact-check.mjs" --path minimal` → exit **0**
```
CATALOG: .dsh/docs/workflow-catalog.yaml
ROOT: D:/Work/dsh/.smoke/studio
PATHS: 1
STEPS: 5
NO_CHECK: 2
PATH: minimal
  STEP: engine-setup required=true repeatable=false check=any_of status=PRESENT alt=1 match=project.yaml
  STEP: game-brief required=true repeatable=false check=glob status=PRESENT count=1
  STEP: create-stories required=true repeatable=false check=glob status=PRESENT count=3
  STEP: implement required=true repeatable=true check=none status=NO_CHECK note=Each story's Status line (Ready / In Progress / Complete) is the record — story files are numbered in build order
  STEP: story-done required=true repeatable=true check=none status=NO_CHECK
```

`node ".dsh/scripts/story-status.mjs"` → exit **0**
```
COMPLETE     3 of 3
```

`node ".dsh/scripts/artifact-check.mjs"` (bare) → exit **0** — header only, first/last rows:
```
PHASES: 7
STEPS: 49
NO_CHECK: 25
PHASE: concept
  STEP: engine-setup required=true repeatable=false check=any_of status=PRESENT alt=1 match=project.yaml
  STEP: game-concept required=true repeatable=false check=glob status=ABSENT glob=design/gdd/game-concept.md
PHASE: release
  STEP: launch-checklist required=true repeatable=false check=none status=NO_CHECK
```

`node ".dsh/scripts/project-coherence.mjs"` → exit **0** (observations only)
```
[MATCH]  engine.version (4.6) agrees with docs/engine-reference/godot/VERSION.md (Godot 4.6)
[NOT CHECKED] rendering — engine.rendering 'gl_compatibility' is not one this script maps to a Godot rendering_method
[DIFFERS] commands.build … has no export_presets.cfg
[DIFFERS] commands.test … 'addons/gdUnit4/bin/GdUnitCmdTool.gd' does not exist
checked 6 · differs 2 · not checked 1
Observations only — no verdict. 'not checked' is not agreement: each line above names why that comparison could not be made.
```

`node tools/yaml-helper.mjs resolve_config --keys …` — three invocations, all exit **0**, all keys resolved:
```
workflow: minimal (rigor:minimal)          project.stage: Concept (project.yaml)      automation: guided (project.yaml)
review_mode: solo (rigor:minimal)          qa.level: minimal (rigor:minimal)         team.size: individual (rigor:minimal)
testing.strict: logic=unset integration=unset visual=unset ui=unset config=unset (unset = each skill applies its own default)
performance.enforce: warn (default)        system_overrides: none
```

No sandbox denial, no bash/WSL call, no Claude-Code-only syntax encountered; every helper the three skills name exists
(`.dsh/scripts/*.mjs`, `.dsh/docs/workflow-catalog.yaml`, `templates/session-state.md`, `templates/project-stage-report.md`,
`director-gates/*-phase-gate.md`, `.dsh/agents/README.md`) — all `Test-Path` True.

## 3. Defects (by severity)

**1 — HIGH: the three skills contradict each other on whether the Concept gate exists at `workflow: minimal`.**
`help` Step 4m forbids exactly this: *"At `minimal`, never present any of these as required or as a blocker: … `/gate-check`"*,
and Step 8: *"the minimal path has no phase gates"*. But `gate-check/references/gate-systems-design.md:33` says
*"**`minimal`** — gate target is **`design/game-brief.md`** … a brief with content = PASS"*, and `SKILL.md` §7 says
*"At `workflow: minimal`, skip the menus below"* — i.e. it expects to run and advance the stage at `minimal`.
A PASS here writes `project.stage: Systems Design`, which `help` Step 2 then refuses to map (*"do not map `project.stage`"*).
Repro: `node tools/yaml-helper.mjs resolve_config --keys workflow` → `minimal`; then compare the two skill files.
Judgement: one of the two must own this tier. As far as I tested, `help` is the faithful reading of `workflow-modes.md`
and the gate file's `minimal` row is the outlier — but the contradiction is not documented anywhere.

**2 — HIGH (fidelity): `gate-check` at `minimal` is constructed to reach PASS on evidence it never verifies.**
`qa.level: minimal` + `review_mode: solo` + `workflow: minimal` leaves exactly one required artifact — a non-empty
`design/game-brief.md` — with no director panel and no test check. So "PASS" would mean "one file is non-empty and
someone clicked a button". The skill's own rules fight this (`§2b` zero-required-artifact rule, `§4` *"Never assume PASS
for unverifiable items"*, `§3` *"**`NO_CHECK` is not `PRESENT`**"*), but the gate file's one-line `minimal` reduction
never names those obligations. Note the balance: the zero-required rule does **not** fire here (1 artifact remains), so
`NOT ASSESSED` is not mechanically reachable — the guardrail misses the case that actually occurs. I resolved it to
CONCERNS via `§4`; a laxer reading trivially yields PASS. Judgement: real, latent over-permissiveness.

**3 — MEDIUM: `help` Step 1b's `Glob` returns nothing in DSH.**
The skill's footer block depends on `Glob .dsh/skills/*/SKILL.md`. With `path=D:\Work\dsh\.smoke\studio` the result was
**"No files found"**, although `.dsh/skills/` holds **74** skill directories. The same pattern with `path=D:\Work\dsh`
returns all 74 from the *other* copy, and `.smoke/studio/.dsh/skills/help/SKILL.md` resolves fine with the
`.smoke/studio/` prefix from the workspace root. Repro:
`glob(pattern=".dsh/skills/*/SKILL.md", path="D:\Work\dsh\.smoke\studio")` → 0 files, vs `(Get-ChildItem "$r\.dsh\skills" -Directory).Count` → 74.
Judgement: the `path` argument appears not to rebase the pattern, so the skill's own discovery step is dead as written;
I substituted a PowerShell listing. (I verified catalog coverage only this way: 74 installed vs 42 distinct catalog
`command:` values → 32 uncataloged, including `help`, `gate-check` and `project-stage-detect` themselves.)

**4 — MEDIUM: `project-stage-detect`'s Pre-Production boundary is decided by files the script never counts.**
The table's *"code root has <10 source files"* is hand-evaluated; `artifact-check.mjs` reports no source-file count at
all. The studio holds 7 real code files but **9** entries because Godot's `*.uid` siblings count too — one more paired
file and the same tree reports Production instead of Pre-Production. Repro:
`Get-ChildItem -Recurse -File src | Measure-Object` → 9 (7 excluding `.uid`). Judgement: a stage verdict resting on an
undocumented `.uid`-inclusive rule is a coin flip; the script should emit `code_root_files=` explicitly.

**5 — LOW: `help`'s story-status prerequisite is still labelled `bash`.**
The DSH port block above it rewrote the command to `node ".dsh/scripts/story-status.mjs"`, but the fence is tagged
```bash``` and the prose still reads *"Run it with Git Bash (Windows: `C:/Program Files/Git/bin/bash.exe`)"*.
Harmless here (`story-status.mjs` ran fine under pwsh), but it invites an agent to reach for the WSL `bash` the
DSH port notes say fails. Repro: `help/SKILL.md`, the Step 4m 前置命令 block.

**6 — LOW: `help` Step 4 asserts `artifact-check.mjs` (bare) "reports every phase", while `project-stage-detect`
relies on the same behaviour — but `gate-check` §3 passes `--phase <source-phase>` and then separately needs
`--path minimal` "at `workflow: minimal`".** Three different invocations of one script across two navigational skills
is undocumented coupling; a change to the bare-call default silently breaks `project-stage-detect` only.
Not a failure today (all three forms behave as their skill claims), logged as fragility.

## 4. Not verified

- **The gate verdict is a draft, not a ratified one.** `gate-check` §1 mandates an `ask_user_question` stage
  confirmation and §4/§7 mandate asking the user about unverifiable items (core loop "fun", would-be audience,
  next-step widget). I ran as a non-interactive delegate, so I asked nobody: those items stay `MANUAL CHECK NEEDED`
  by the skill's own definition and my CONCERNS verdict is provisional.
- **`/gate-check` was never invoked with an explicit argument** (e.g. `/gate-check production`), and the other five gate
  files were deliberately not loaded (the skill forbids it). Their `minimal` reductions are unchecked.
- **The stage write path (§6) is untested.** It never ran: CONCERNS without user acceptance writes nothing, and no
  `production/gate-checks/` directory exists (verified). I did not test the `project.yaml` → `production/stage.txt`
  dual-write, the drift check, or the §6.4 rigor-fit advisory.
- **The director panel (§4b) never executed** — `review_mode: solo` skips it, so panel width, director prompt
  construction and the NOT-READY/CONCERNS roll-up are unverified.
- **`performance.enforce: block` and `testing.strict: true` branches unexercised** — both resolve to their inert
  defaults here on a project with no profiling data and no test runner.
- **`project-stage-detect`'s report file was not written**, so its template
  (`.dsh/docs/templates/project-stage-report.md`) and completeness guarantees are untested.
- **Only the `minimal` tier was exercised end to end.** `standard`/`full` reductions, `system_overrides` validation,
  and the `docs/consistency-failures.md` scrutiny path (file absent) are all unverified.
- **The `.smoke/studio` copy's own framework integrity was not checked** — I did not run `tools/check-dsh.mjs` or
  compare this copy against `D:\Work\dsh\.dsh`; findings above are attributed to the copy under test, which appears
  byte-identical to the root in the files inspected.


