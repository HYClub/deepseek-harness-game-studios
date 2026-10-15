# 工作室共享规则（DSH 合并版）

DSH 的 `dsh-agent-instructions` **不解释 `@path` 导入**（官方文档明确说明这一行为是有意的），
所以内容源里用 `@` 拉进来的共享规则在 DSH 会话里不会自动加载。
本文件由 `tools/build-dsh.mjs` 生成：把那些导入的原文按顺序合并，供 `AGENTS.md` 指引用。

来源：项目指令文件 → `Directory Structure`、`Godot Engine — Version Reference`、`Agent Coordination Rules`、`Coding Standards`

---

## Directory Structure

# Directory Structure

```text
/
├── AGENTS.md                    # Master configuration
├── project.yaml                 # Machine-readable project config — engine, modes, stage (source of truth)
├── .dsh/                     # Agent definitions, skills, hooks, rules, docs
├── <code root>/                 # Game source code — THE PATH IS ENGINE-SPECIFIC, see below
├── assets/                      # Game assets (art, audio, vfx, shaders, data)
├── design/                      # Game design documents (gdd, narrative, levels, balance)
├── docs/                        # Technical documentation (architecture, api, postmortems)
│   └── engine-reference/        # Curated engine API snapshots (version-pinned)
├── tests/                       # Game test suites (unit, integration, performance, playtest)
├── tools/                       # Build and pipeline tools (ci, build, asset-pipeline)
├── prototypes/                  # Throwaway prototypes (outside the code root)
├── production/                  # Production management (sprints, milestones, releases)
│   ├── session-state/           # Ephemeral session state (active.md — gitignored)
│   └── session-logs/            # Session audit trail (gitignored)
└── DSGS Skill Testing Framework/ # QA for the skills/agents themselves — /skill-test, /skill-improve
```

## The code root is engine-specific

**Two of the three supported engines will not build a project whose code sits in
`src/`.** This is not a style preference — it is a hard constraint of the engine's
own toolchain:

| `engine.name` | Code root | Why it cannot be `src/` |
|---|---|---|
| **Godot** | `src/` | No constraint — Godot loads from `res://` anywhere under the project root. |
| **Unity** | `Assets/` | Unity compiles **only** `Assets/` and `Packages/`. Code outside them is invisible to the compiler. |
| **Unreal** | `Source/<Module>/` | UnrealBuildTool discovers modules under `Source/`; content lives in `Content/`. A module elsewhere is not built. |

**Resolve the code root from `engine.name` before writing any source file.** A
path shown as `src/…` alone is a Godot example: read it as *"the code root"* and
substitute the row above. `src/` is the table's Godot row, not a universal path.

**Tests follow the same rule** — the same compilers decide what they see:

| `engine.name` | Test root | Anywhere else |
|---|---|---|
| **Godot** | `tests/unit/`, `tests/integration/` | — |
| **Unity** | `Assets/Tests/EditMode/`, `Assets/Tests/PlayMode/` | not compiled: "0 tests, Passed" |
| **Unreal** | `Source/<Module>/Private/Tests/` | not built: "No automation tests matched" |

Read `tests/unit/[system]/` (or `integration/`) anywhere as the test root plus `[System]/`.

---

## Godot Engine — Version Reference

# Godot Engine — Version Reference

| Field | Value |
|-------|-------|
| **Engine Version** | Godot 4.6 |
| **Installed at pin time** | NOT DETERMINED — `/setup-engine` §3 probes the installed editor and records the result here. |
| **Release Date** | January 2026 |
| **Project Pinned** | 2026-02-12 |
| **Last Docs Verified** | 2026-02-12 |
| **LLM Knowledge Cutoff** | May 2025 |

## Knowledge Gap Warning

The LLM's training data likely covers Godot up to ~4.3. Versions 4.4, 4.5,
and 4.6 introduced significant changes that the model does NOT know about.
Always cross-reference this directory before suggesting Godot API calls.

## Installed-Version Gap Warning

The warning above is one-directional — it covers the **model** knowing less than
this pin. The reverse gap is real and `/setup-engine` §3 creates it deliberately
("pin the newer one and upgrade later"): this reference can sit **ahead of the
installed editor**, and an agent citing it correctly then emits APIs that do not
compile locally. **Check `Installed at pin time` above before trusting a
version-qualified claim** — `NOT DETERMINED` means the gap is unknown, not absent.

## Post-Cutoff Version Timeline

| Version | Release | Risk Level | Key Theme |
|---------|---------|------------|-----------|
| 4.4 | ~Mid 2025 | MEDIUM | Jolt physics option, FileAccess return types, shader texture type changes |
| 4.5 | ~Late 2025 | HIGH | Accessibility (AccessKit), variadic args, @abstract, shader baker, SMAA |
| 4.6 | Jan 2026 | HIGH | Jolt default, glow rework, D3D12 default on Windows, IK restored |

## Verified Sources

- Official docs: https://docs.godotengine.org/en/stable/
- 4.5→4.6 migration: https://docs.godotengine.org/en/stable/tutorials/migrating/upgrading_to_godot_4.6.html
- 4.4→4.5 migration: https://docs.godotengine.org/en/stable/tutorials/migrating/upgrading_to_godot_4.5.html
- Changelog: https://github.com/godotengine/godot/blob/master/CHANGELOG.md
- Release notes: https://godotengine.org/releases/4.6/

---

## Agent Coordination Rules

# Agent Coordination Rules

1. **Vertical Delegation**: Leadership agents delegate to department leads, who
   delegate to specialists. Never skip a tier for complex decisions.
2. **Horizontal Consultation**: Agents at the same tier may consult each other
   but must not make binding decisions outside their domain.
3. **Conflict Resolution**: When two agents disagree, escalate to the shared
   parent. If no shared parent, escalate to `creative-director` for design
   conflicts or `technical-director` for technical conflicts.
4. **Change Propagation**: When a design change affects multiple domains, the
   `producer` agent coordinates the propagation.
5. **No Unilateral Cross-Domain Changes**: An agent must never modify files
   outside its designated directories without explicit delegation.

## Model Tier Assignment

Read `.dsh/docs/model-tiers.md` on demand. It carries the tier table, the
per-skill assignments and the authoring rule.

**Load-bearing enough to restate here:** whether a skill's `model:` is used
depends on how the skill starts. Typed as `/skill-name`: yes, except a `haiku`
pin in auto mode. Started by the agent through the Skill tool: no. Never tell a
user a `haiku` skill saves money; an `opus` skill typed in a Sonnet session
costs more. The agent-side `model:` is a different mechanism, and is applied.

## Subagents vs Agent Teams

This project uses two distinct multi-agent patterns:

### Subagents (current, always active)
Spawned via the `Agent` tool within a single session (renamed from
`Task` in 上游运行时 2.1.63; `Task` still works as an alias). Used by all
`team-*` skills and orchestration skills. Subagents share the session's
permission context, run sequentially or in parallel within the session, and
return results to the parent.

**When to spawn in parallel**: If two subagents' inputs are independent (neither
needs the other's output to begin), spawn both `Agent` calls simultaneously
rather than waiting. Example: `/review-all-gdds` **Phase 2** (consistency) and
**Phase 3** (design theory) are independent — spawn both at the same time.
Phase 1 loads the GDDs and both depend on it, so it is the one phase here that
must NOT be parallelised.

### Agent Teams (experimental — opt-in)
Multiple independent 上游运行时 *sessions* coordinated via a shared task list.
Opt-in and never yet used here — read `.dsh/docs/agent-teams.md` on demand
before proposing one.

## Parallel Task Protocol

When an orchestration skill spawns multiple independent agents:

1. Issue all independent `Agent` calls before waiting for any result
2. Collect all results before proceeding to dependent phases
3. If any agent is BLOCKED, surface it immediately — do not silently skip
4. Always produce a partial report if some agents complete and others block

---

## Coding Standards

# Coding Standards

- All game code must include doc comments on public APIs
- Architecture decisions are recorded as ADRs in `docs/architecture/`. **How many is
  set by `modes.workflow`** — all ADRs at `full`, *critical* ADRs only at `standard`,
  and none required at `minimal`, where the decision log and `design/game-brief.md`
  carry the rationale instead. See `.dsh/docs/workflow-modes.md`.
- Gameplay values must be data-driven (external config), never hardcoded
- All public methods must be unit-testable (dependency injection over singletons)
- Commits must reference the relevant design document or task ID
- **Commit messages**: Use Conventional Commits format — `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Reference the story or task ID in the body (e.g., `Story: EPIC-001-S02`).
- **Verification-driven development**: Write tests first when adding gameplay systems.
  For UI changes, verify with screenshots. Compare expected output to actual output
  before marking work complete. Every implementation should have a way to prove it works.
- **A parse check is not a run.** Every story that changes something
  player-observable is launched and observed before it closes, and the
  observation is a retained screenshot in `production/qa/evidence/`. Procedure
  per engine: `.dsh/docs/run-and-observe.md`. Not waived at
  `qa.level: minimal` — tests are, the look is not.

# Design Document Standards

- All design docs use Markdown
- Each mechanic has a dedicated document in `design/gdd/`
- **How many of the 8 sections are required depends on `modes.workflow`** —
  all 8 at `full`, 5 (+ Formulas when the system defines numeric rules — rates,
  curves, thresholds, costs; the system's `Category` is a hint, not the test) at
  `standard`, and no
  GDD at all at `minimal`, where `design/game-brief.md` is the design record.
  See `.dsh/docs/workflow-modes.md`. The 8 sections:
  1. **Overview** -- one-paragraph summary
  2. **Player Fantasy** -- intended feeling and experience
  3. **Detailed Rules** -- unambiguous mechanics
  4. **Formulas** -- all math defined with variables
  5. **Edge Cases** -- unusual situations handled
  6. **Dependencies** -- other systems listed
  7. **Tuning Knobs** -- configurable values identified
  8. **Acceptance Criteria** -- testable success conditions
- Balance values must link to their source formula or rationale

# Testing Standards

## Test Evidence by Story Type

All stories must have appropriate test evidence before they can be marked Done:

| Story Type | Required Evidence | Location | Default Gate Level |
|---|---|---|---|
| **Logic** (formulas, AI, state machines) | Automated unit test — must pass | `tests/unit/[system]/` | BLOCKING |
| **Integration** (multi-system) | Integration test OR documented playtest | `tests/integration/[system]/` | BLOCKING |
| **Visual/Feel** (animation, VFX, feel) | Retained screenshot + lead sign-off | `production/qa/evidence/` | BLOCKING |
| **UI** (menus, HUD, screens) | Retained screenshot of each screen touched | `production/qa/evidence/` | BLOCKING |
| **Config/Data** (balance tuning) | Smoke check pass | `production/qa/smoke-[date].md` | ADVISORY |

The **Default Gate Level** applies when `testing.strict` is not set in
`project.yaml`. A project may override it per test type: `testing.strict.logic`,
`.integration`, `.visual`, `.ui`, and `.config` each take `true` (BLOCKING) or
`false` (ADVISORY). `/story-done`, `/story-readiness`, `/dev-story`,
`/gate-check`, and `/smoke-check` resolve the effective level from that setting,
falling back to the defaults above when it is absent.

> **Why Visual and UI block.** "Retained" is load-bearing — the screenshot must
> still be on disk in `production/qa/evidence/` when the story is closed. One
> that was captured and discarded is an assertion, not evidence. These two rows
> block because for a game the way it looks *is* the product: an advisory visual
> gate gets deferred in favour of whatever does block, and the result is a
> well-tested game that looks wrong.

> **Exception — `/smoke-check`.** The ADVISORY default for **Config/Data** above
> applies to *per-story evidence* gates. `/smoke-check` is a build-health gate,
> not a per-story evidence gate, so its own unset default for
> `testing.strict.config` is **BLOCKING**. This divergence is intentional and is
> documented at both sites; do not reconcile one to the other.

## Automated Test Rules

- **Naming**: per engine — `.dsh/rules/test-standards.md`
- **Determinism**: Tests must produce the same result every run — no random seeds, no time-dependent assertions
- **Isolation**: Each test sets up and tears down its own state; tests must not depend on execution order
- **No hardcoded data**: Test fixtures use constant files or factory functions, not inline magic numbers
  (exception: boundary value tests where the exact number IS the point)
- **Independence**: Unit tests do not call external APIs, databases, or file I/O — use dependency injection

## What NOT to Automate

- Visual fidelity (shader output, VFX appearance, animation curves)
- "Feel" qualities (input responsiveness, perceived weight, timing)
- Platform-specific rendering (test on target hardware, not headlessly)
- Full gameplay sessions (covered by playtesting, not automation)

## CI/CD Rules

- Automated test suite runs on every push to main and every PR
- No merge if tests fail — tests are a blocking gate in CI
- Never disable or skip failing tests to make CI pass — fix the underlying issue
- Engine-specific CI commands:
  - **Godot**: `godot --headless -s -d --remote-debug tcp://127.0.0.1:0 res://addons/gdUnit4/bin/GdUnitCmdTool.gd -a res://tests --ignoreHeadlessMode`
  - **Unity**: `game-ci/unity-test-runner@v4` (GitHub Actions)
  - **Unreal**: headless runner with `-nullrhi` flag

