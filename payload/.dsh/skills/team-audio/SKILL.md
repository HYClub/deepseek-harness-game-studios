---
name: team-audio
description: "Orchestrate the audio team — audio-director, sound-designer, technical-artist, gameplay-programmer — direction through implementation."
argument-hint: "[feature or area to design audio for] [--review full|lean|solo]"
user-invocable: true
allowed-tools: read, glob, grep, write, edit, pwsh, subagent, ask_user_question, TaskCreate, TaskGet, TaskList, TaskUpdate, pwsh(node tools/yaml-helper.mjs resolve_config *)
model: sonnet
---
<!-- DSGS-GENERATED:BEGIN — do not edit by hand -->
> **生成物，勿手改**：改动会在下次生成时被覆盖。
>
> - 重新生成：`node tools/build-dsh.mjs`（内容源与 `dsh-src/` → `.dsh/`）。
> - 工具名是 DSH 的：`pwsh` / `read` / `write` / `edit` / `grep` / `glob` / `subagent` / `ask_user_question` / `todo_write` / `web_search`。
> - 委派子代理：读角色卡 `.dsh/agents/<name>.md`，把卡片正文连同任务作为 `subagent`（一次性/可续）或 `workflow`（批量编排）的 prompt。约定见 `.dsh/agents/README.md`。
> - 本技能的基础目录见会话注入的 `Base directory for this skill`；相对路径都相对它解析。
> - 正文里的「前置命令」块需要你亲自运行（原文的预执行行在 DSH 不生效）。
> - `argument-hint`, `allowed-tools`, `model` are upstream fields kept as written but not read here: tool availability is decided by session permissions, a skill cannot pin a model, and a subagent model is chosen at the `subagent` / `workflow` call site.
<!-- DSGS-GENERATED:END -->

If no argument is provided, output usage guidance and exit without spawning any agents:
> Usage: `/team-audio [feature or area to design audio for] [--review full|lean|solo]` — specify the feature or area to design audio for (e.g., `combat`, `main menu`, `forest biome`, `boss encounter`). Do not use `ask_user_question` here; output the guidance directly.

When this skill is invoked with an argument, orchestrate the audio team through a structured pipeline.

**Decision Points:** At each step transition, use `ask_user_question` to present
the user with the subagent's proposals as selectable options. Write the agent's
full analysis in conversation, then capture the decision with concise labels.
In `collaborative` mode, the user must approve before moving to the next step.
In `guided` mode the pipeline advances automatically unless a step is BLOCKED;
in `autonomous` mode it runs end to end, recording each step outcome via
`log_decision`. Decisions in `automation_always_ask` categories
(`is_always_ask_category` helper) always prompt regardless of mode. See
`.dsh/docs/automation-modes.md`.

## Phase 0: Resolve Config

**前置命令（DSH 不会预执行技能里的 `!` 命令，需要你自己运行它）**

```pwsh
node tools/yaml-helper.mjs resolve_config --keys review_mode,automation,team.size
```

把输出当作已解析的项目配置使用；没有输出块时按 `.dsh/docs/config-resolution.md` 的默认值处理。

Resolved above — use as-is; `--review` overrides `review_mode`. No block →
defaults in `.dsh/docs/config-resolution.md`.

`review_mode` sets director-gate depth, and this pipeline has no director gate:
no phase below spawns CD-, TD-, PR- or AD-PHASE-GATE, at any `review_mode`. Its
phase gates are the pipeline's own decision points (defined under `team.size`
below), and the agents that work at them are team members, not director gates.

`automation` drives the Decision Points note above. See the Decision Points note above and
`.dsh/docs/automation-modes.md` for how each mode changes pipeline behavior.

**`team.size`**: which agents are active (orthogonal to review_mode gate-depth and workflow docs).
- **`individual`** (default): `sound-designer` only. Other agents consulted via the sound-designer, not spawned separately.
- **`small`**: + `audio-director` + `technical-artist` + `gameplay-programmer`.
- **`studio`**: + `accessibility-specialist` + the primary engine specialist (the full pipeline as documented).
A non-core agent needed at `individual` routes through the nearest active core agent with an informational note. **"Phase gate" means any phase that ends in an `ask_user_question` decision point this pipeline itself lists** — a transition under Decision Points above, or a **Gate** step written into the pipeline below — **whatever the `automation` mode.** `guided` and `autonomous` change how a gate is passed (it auto-advances, or is recorded with `log_decision`), not whether it is one, so bounded-exception condition (3) below holds at it in every mode. An agent restricted to "phase gates only" is spawned at those points and no others. This active-set scoping applies throughout the pipeline below: any phase that names an agent outside the active set routes through the nearest core agent rather than spawning it.

**Announce the active set before Step 1 — never let the collapse be silent.**
Before spawning anything, state in one line which agents this run will actually
spawn, and which the pipeline below names but will **not** spawn at the resolved
`team.size`. For example:

> `Active set (team.size: <resolved>): <the agents listed for that size above>.`
> `Not spawned this run: <every other agent this pipeline names> — consulted`
> `through <nearest active core agent>. Raise team.size (or modes.rigor) to widen.`

Fill it from the `team.size` list directly above and the agents this file's own
pipeline names — not from an example. Both sets differ per orchestrator.

The pipeline below reads as a multi-agent fan-out and at the shipped default it
is one or two agents — `team-release` names ten and runs one, `team-narrative`
names six across five phases and runs `writer` alone. **The collapse is correct**:
`team.size` is rigor-fronted and the narrow default is the token lever.
Without saying so, a reader cannot
distinguish a correctly-collapsed run from a broken pipeline, and the per-agent
"routes through the nearest core agent with an informational note" rule above
fires at routing time and never states the shape of the run as a whole.

This is the same rule as the skipped-check reporting elsewhere in this file: **a constraint that is enforced but never surfaced is
indistinguishable, to the person reading the output, from one that was never
enforced.**

1. **Read the argument** for the target feature or area (e.g., `combat`,
   `main menu`, `forest biome`, `boss encounter`).

2. **Gather context**:
   - Read relevant design docs in `design/gdd/` for the feature
   - Read the sound bible at `design/audio/sound-bible.md` if it exists. If only
     `design/gdd/sound-bible.md` exists (where earlier versions put it), read that
     and recommend moving it to `design/audio/` — in `design/gdd/` the GDD checks
     count every file as a system GDD. If neither exists,
     say so in one line — "No sound bible at `design/audio/sound-bible.md`; audio
     direction starts from the GDDs alone" — so the gap is visible in the output.
     Carry the gap forward: say so in the audio-director's Step 1 brief, and
     recommend creating a sound bible in Next Steps.
   - Read existing audio asset lists in `assets/audio/`
   - Read any existing sound design docs for this area

## How to Delegate

Use the `subagent` tool to spawn each team member as a subagent:
- `audio-director`（角色卡 `.dsh/agents/audio-director.md`） — Sonic identity, emotional tone, audio palette
- `sound-designer`（角色卡 `.dsh/agents/sound-designer.md`） — SFX specifications, audio events, mixing groups
- `accessibility-specialist`（角色卡 `.dsh/agents/accessibility-specialist.md`） — Visual fallbacks and subtitles for critical audio, auditory sensitivity
- `technical-artist`（角色卡 `.dsh/agents/technical-artist.md`） — Audio middleware, bus structure, memory budgets
- `[primary engine specialist]`（对应角色卡，见 `.dsh/agents/`） — Validate audio integration patterns for the engine
- `gameplay-programmer`（角色卡 `.dsh/agents/gameplay-programmer.md`） — Audio manager, gameplay triggers, adaptive music

**Brief each agent — do not dump context.** Read the shared inputs **once** and pass a distilled brief inline: the lines each agent actually needs, never a file path for a document you have already read (an agent handed a path re-reads the whole file). Pass a path only for a document you have not read and only that agent needs.

**End every agent prompt with a return contract:** "Write your full output to `[path]` — that named path is your write authorisation under the bounded exception below, so write it without a separate approval prompt. Return **only** (1) the path written, (2) a ≤5-bullet summary of decisions, (3) any BLOCKED/CONCERNS items, one line each. Do not restate the documents you read." Without it, an agent returns everything it read back into this session. **Implementation files are the exception:** an agent writing code or assets first returns the files it will create or change, and its return contract names them only after you have asked once for the set and the user said yes (File Write Protocol) — that answer, not the bounded exception, authorises those writes.

**Substitute a real path for `[path]`.** Working artifacts go under
`production/audio/[feature]/`, where `[feature]` is the argument as a slug —
lowercase, spaces → hyphens (`boss encounter` → `boss-encounter`), the same slug
the "Save to" step uses. One file per agent, so parallel steps never share one:

| Step / agent | Writes to |
|---|---|
| 1 audio-director | `production/audio/[feature]/direction.md` |
| 2 sound-designer | `production/audio/[feature]/sfx-spec.md` |
| 2 accessibility-specialist | `production/audio/[feature]/accessibility.md` |
| 3 technical-artist | `production/audio/[feature]/integration-plan.md` |
| 3 engine specialist | `production/audio/[feature]/engine-notes.md` |
| 4 gameplay-programmer | the code root and the engine's test root — the files the one implementation ask lists (File Write Protocol), outside the bounded exception |

These are working drafts; the durable record is the audio design document you
compile from them.

> **Why this does not violate the Collaboration Protocol.** `AGENTS.md` requires an agent to ask "May I write this to [filepath]?" before write/edit. A subagent spawned here writes **without** asking, and that is a deliberate, bounded exception rather than an oversight — the same call already made for `consistency-check` appending to `active.md`. The exception holds only when all three are true: (1) the path is one **you** named in the prompt, so the user approved the destination when they approved the phase; (2) it is a new artifact under `production/`, `docs/` or `tests/`, never an edit to existing source or config; (3) the phase that produced it is itself gated by an `ask_user_question` before the pipeline advances. Outside those three, the agent must ask. **Do not "fix" this by asking per subagent** — a prompt per agent per phase makes an orchestrator unusable, which is why the exception exists.

3. **Orchestrate the audio team** in sequence:

### Step 1: Audio Direction (audio-director)
Spawn the `audio-director` agent to:
- Define the sonic identity for this feature/area
- Specify the emotional tone and audio palette
- Set music direction (adaptive layers, stems, transitions)
- Define audio priorities and mix targets
- Establish any adaptive audio rules (combat intensity, exploration, tension)

### Step 2: Sound Design and Audio Accessibility (parallel)
Spawn the `sound-designer` agent to:
- Create detailed SFX specifications for every audio event
- Define sound categories (ambient, UI, gameplay, music, dialogue)
- Specify per-sound parameters (volume range, pitch variation, attenuation)
- Plan audio event list with trigger conditions
- Define mixing groups and ducking rules

Spawn the `accessibility-specialist` agent in parallel to:
- Identify which audio events carry critical gameplay information (damage received, enemy nearby, objective complete) and require visual alternatives for hearing-impaired players
- Specify subtitle requirements: which audio events need captions, what text format, on-screen duration
- Check that no gameplay state is communicated by audio alone (all must have a visual fallback)
- Review the audio event list for any that could cause issues for players with auditory sensitivities (high-frequency alerts, sudden loud events)
- Output: audio accessibility requirements list integrated into the audio event spec

A gameplay-critical audio event with no visual cue or subtitle is labelled
**BLOCKING** in the report, not advisory. Step 3 does not start until the user
resolves it or explicitly accepts it at the Step 2 decision point, which offers
the fix (a visual cue, subtitle or haptic fallback) and a stop; an accepted gap
is listed among the open questions in the summary.

### Step 3: Technical Implementation (parallel)
Spawn the `technical-artist` agent to:
- Design the audio middleware integration (Wwise/FMOD/native)
- Define audio bus structure and routing
- Specify memory budgets for audio assets per platform
- Plan streaming vs preloaded asset strategy
- Design any audio-reactive visual effects

Spawn the **primary engine specialist** in parallel (`<engine>-specialist` derived from `engine.name` — Godot→`godot-specialist`, Unity→`unity-specialist`, Unreal→`unreal-specialist`; fall back to the Primary line of `## Engine Specialists` in `.dsh/docs/technical-preferences.md`) to validate the integration approach:
- Is the proposed audio middleware integration idiomatic for the engine? (e.g., Godot's built-in AudioStreamPlayer vs FMOD, Unity's Audio Mixer vs Wwise, Unreal's MetaSounds vs FMOD)
- Any engine-specific audio node/component patterns that should be used?
- Known audio system changes in the pinned engine version that affect the integration plan?
- Output: engine audio integration notes to merge with the technical-artist's plan

If no engine is configured, skip the specialist spawn. **Record ``Engine validation: NOT ASSESSED — no engine configured (`engine.name` unset in `project.yaml`)`` in this run's output.** A skipped check that says nothing is indistinguishable from a check that passed; the reader cannot tell engine guidance was never sought.

### Step 4: Code Integration (gameplay-programmer)
Spawn the `gameplay-programmer` agent to:
- Implement audio manager system or review existing
- Wire up audio events to gameplay triggers
- Implement adaptive music system (if specified)
- Set up audio occlusion/reverb zones
- Write unit tests for audio event triggers

4. **Compile the audio design document** combining all team outputs.

5. **Save to** `design/audio/audio-[feature].md` — **but ask first.** `design/` is
   NOT one of the three directories the bounded write exception covers
   (`production/`, `docs/`, `tests/`), so a sub-agent handed this path must
   prompt, and one has done exactly that. Do not
   resolve that by widening the exception. Instead, follow the same pattern
   `team-level` uses: **you** already hold every sub-agent's output, so compile
   the document yourself and ask directly via `ask_user_question` — "May I write the
   audio design to `design/audio/audio-[feature].md`?" — then write it on
   approval. Sub-agent working artifacts stay under `production/` where the
   exception does reach them.

   Note: If `design/audio/` does not exist, writing the file creates it.

6. **Output a summary** with: audio event count, estimated asset count,
   implementation tasks, and any open questions between team members.

Verdict: **COMPLETE** — audio design document produced and team pipeline finished.

If the engine validation was skipped (no engine configured), the verdict says
so — never a plain COMPLETE:

Verdict: **COMPLETE — engine validation NOT ASSESSED ([reason])** — audio design document produced; the engine specialist never reviewed the integration plan.

If the pipeline stops because a dependency is unresolved (e.g., critical accessibility gap or missing GDD not resolved by the user):

Verdict: **BLOCKED** — [reason]

## File Write Protocol

Per-agent artifacts (SFX specs, integration plans) are written by the sub-agent
that produced them, under the **bounded exception** documented above under "Why
this does not violate the Collaboration Protocol" — the path is one you named, the
artifact is new under `production/`, `docs/` or `tests/`, and the phase is gated by
an `ask_user_question`. A sub-agent does **not** prompt per write inside those bounds;
outside them it must ask. **Implementation files** — gameplay-programmer's audio
integration code, anything under the code root or `assets/` — are outside those
bounds: the agent returns the files it will create or change, you ask once for the
set, and it writes after a yes. The **one exception is the final compiled audio design
document**: the orchestrator already holds every input, so it compiles and writes
`design/audio/audio-[feature].md` itself after its own "May I write …?" prompt
(the "Save to" step above).

## Next Steps

- Review the audio design doc with the audio-director before implementation begins.
- Use `/dev-story` to implement the audio manager and event system once the design is approved.
- Run `/asset-audit` after audio assets are created to verify naming and format compliance.
- If there was no sound bible, create one before the next audio pass: ask the
  `audio-director` agent to draft `design/audio/sound-bible.md` from
  `.dsh/docs/templates/sound-bible.md`, starting from this run's Step 1
  direction (it asks before writing under `design/`).

## Error Recovery Protocol

**First, verify the artifact.** If the return contract named a path, check the
path exists before treating the phase as done — **a named artifact that is not
on disk is a failed phase, however fluent the response reads.** An agent can
burn a full phase and return a plausible preamble having written nothing, which
is neither BLOCKED nor an error nor "cannot complete", so the trigger below
never fires. Resume it naming the unmet contract; the context is
usually still there.

If any spawned agent returns BLOCKED, errors, or cannot complete: **surface it
immediately, don't proceed past a dependency it blocks, and always produce a
partial report.** A skipped agent's section stays a named gap — never fill it with content of your own. Full procedure: `.dsh/docs/error-recovery-protocol.md`.

Common blockers:
- Input file missing (story not found, GDD absent) → redirect to the skill that creates it
- ADR status is Proposed → do not implement; once it is decided, accept it with `/architecture-decision accept ADR-NNNN`
- Scope too large → split into two stories via `/create-stories`
- Conflicting instructions between ADR and story → surface the conflict, do not guess
