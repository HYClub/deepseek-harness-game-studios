# Changelog

## 0.3.2 — the hook bridge is declared, and found

The plugin's hooks.js loads the official `@deepseek-ai/dsh-hooks-claude-code` package and calls its
`apply()` — that made the bridge a runtime dependency, but the package declared none. It does now:

- `dependencies: { "@deepseek-ai/dsh-hooks-claude-code": "0.2.1-rc.2" }`, the version this port is
  tested against. Installing the plugin installs a bridge the plugin can use even when the dsh
  installation keeps its own copy out of reach (a desktop build packs it inside `app.asar`).
- The loader still prefers the copy the running dsh provides, so a newer dsh keeps its own bridge; the
  declared one is the fallback. If neither is reachable the error names both attempts.

The hook checks say which of the two failed and what to do — point `DSH_HOOK_BRIDGE_DIR` at a copy,
install it at the version your dsh expects, or read it from a dsh checkout — and a skipped check can no
longer pass by accident.

## 0.3.1 — the files the skills read

0.3.0 shipped the skills but not everything they read. This release adds the rest, so a skill that
says "read the step file" or "use the genre chipset" finds it:

- **The step files behind the workflow skills.** 210 files under `skills/*/references/` — the numbered
  steps a skill walks (adopt, architecture-decision, create-architecture, design-system, review-all-gdds,
  smoke-check, test-setup and the rest), plus the one-shot references `/prototype` and `/cut` read.
- **The genre library.** 73 files under `genres/` — the genre chipsets, the art-direction and
  online-and-device notes, and the index that names them; `/prototype`'s card step reads them.
- **The scripts those pages call.** `set-stage`, `door-in`, `game-read`, `test-run`, `test-scaffold`,
  `md-section`, `registry`, `references-save`, `vendor-three` and `web-detect` now ship beside the
  framework. Those without a Node port are listed by the reference audit rather than hidden.
- **`migrate-v1-config` works again.** A damaged comment had left the script unable to load, so every
  migration test failed; the file is repaired and its 20 behaviour tests pass.

Every reference a skill file points at now resolves (`framework references missing: 0`), the content
fidelity check reports no unexplained lines, and the full verification is seven steps green with 28
behaviour suites passing.

## 0.3.0 — everything upstream, and a game you can actually play

This release closes the gap: every upstream skill, rule and hook now runs in DSH, and the studio can
play the game it makes.

**Upstream parity, finished.** Five skills arrived (`/next-step`, `/write-changelog`, `/project-settings`,
`/cut`, plus the scene-file rule), each with the helper it needs — `config-set` writes one setting with its
enum, whitelist and dry-run checks; `cut-read` and `cut-apply` propose cuts and write the ones you pick,
moving a feature to "Out of scope" and blocking the story traced to it. All 19 upstream hooks now have a
Node implementation and are registered: a read that would swallow a 40 KB design doc is refused with the
document's headings; a write is checked against the never-overwrite list, the config enums, the local
whitelist, the localization freeze, the prototype boundary and the subagent write exception; a registry
write that would drop an entry says so. Session start ends with one line when a newer release is out.

**Four engine references, including the web.** Godot moves to 4.7 and the Web target arrives with its
Vite/TypeScript scaffold and three starters, so a grown game has somewhere to grow into.

**A game you can play.** The one-shot pipeline runs end to end: make the folder, play it in a headless
Chrome (Chrome, Edge, Chromium or Playwright's shell; the driver ships as browser JavaScript), record the
check with its evidence rules, put a tuned number back, share a build without its debug panel, then grow
it into a web project and compare the grown game with the original row by row. Verified here: `npm ci`,
`npm run build:single`, `replay --as reference` exact, `--as copy` match, `accept`, `--as story` against
the accepted run.

**Fixes found while proving it.** The parity harness asked bash for `python3` only — on Windows that is
often the Store stub, which exists, exits 0 and prints nothing — so it skipped the two pairs that read
YAML on a machine where `python` works. It now asks for the interpreters the helper asks for, and all
seven pairs match with no skips. Running them found two real bugs: a project with no `project.yaml` was
reported as on the minimal workflow, and the status line resolved `.` against the framework instead of the
directory it runs in.

**Everything a reader sees is consistent.** The README was rewritten around what the plugin does; the
plugin description, the repository About and CONTRIBUTING now state the same counts (83 skills, 49 agents,
14 rules, 19 hooks); SELF-INSTALL names what the installer really writes and how to undo it.


- `/dashboard` now opens on a board: a left navigation (概览 · 缺口 · 目录 · 名册 · 图表 · 命令) with plain anchors, so the navigation works with JavaScript disabled.
- 缺口 lists every warning verbatim; 目录 marks the eight paths a project is expected to have as present or missing; 名册 shows the agents grouped by role suffix plus the skills and rules counts — all read from disk, so the page cannot claim a directory exists when it does not.
- The three charts are unchanged and sit below the board; narrow screens still get tables.
- Commands are printed as text, not buttons, and the page says so: a static file cannot run a skill.
- The page now has a light theme alongside the dark one. The system preference decides until you press the `◐` button in the header, which flips it and remembers the choice; with JavaScript off the button is hidden and the system preference still applies. Chart colours follow the theme, not just the page chrome. Printing uses the light palette and hides the sidebar and the button, so Ctrl+P gives readable ink on white paper.

## 0.2.3 — a board you can scan, not a page you scroll

- `/dashboard` now opens on a board: a left navigation (概览 · 缺口 · 目录 · 名册 · 图表 · 命令) with plain anchors, so the navigation works with JavaScript disabled.
- 缺口 lists every warning verbatim; 目录 marks the eight paths a project is expected to have as present or missing; 名册 shows the agents grouped by role suffix plus the skills and rules counts — all read from disk, so the page cannot claim a directory exists when it does not.
- The three charts are unchanged and sit below the board; narrow screens still get tables.
- Commands are printed as text, not buttons, and the page says so: a static file cannot run a skill.
- The page now has a light theme alongside the dark one. The system preference decides until you press the `◐` button in the header, which flips it and remembers the choice; with JavaScript off the button is hidden and the system preference still applies. Chart colours follow the theme, not just the page chrome. Printing uses the light palette and hides the sidebar and the button, so Ctrl+P gives readable ink on white paper.

## 0.2.2 — the first update is a manual one

- The upgrade notes now say that `/update` arrives with 0.2.1: anyone on an older release reinstalls once, with the two commands or through the desktop `Plugins` panel, and every update after that is `/update`.
- The same section marks the version where `/update` exists, so a reader on 0.2.0 is not sent to a command they do not have.
## 0.2.1 — an update command, and how to use it

- `/update` compares the installed plugin with the newest release from inside an initialised workspace, shows the commands it will run, and runs them only after you confirm.
- The README now starts with how to update — `/update` in an initialised workspace, how to tell whether a workspace is initialised, and the Plugins-panel route for the desktop app, where the command line cannot install.

## 0.2.0 — a daily entry point and a studio dashboard

- `/today` answers "what do I do now" in a few lines: the story to pick up, what is blocked, and the next command.
- `/dashboard` writes one HTML file with three charts — status pie, stories per epic, lines added and deleted per day — for 7 / 30 / 90 days and all time.
- The charts are rendered when the file is written, not drawn by the browser, so they open without a network and stay readable with JavaScript disabled; switching charts works in a sandboxed preview too.
- Story dates come from commit instants in your own time zone; uncommitted work is dated by each file's modification time and marked as pending.
- A single status draws a full circle and a single day draws a bar, because neither is a pie slice or a line.
- A story file written with a UTF-8 BOM now parses, a `--root` that points at a file is rejected, and an output that cannot be written says which path failed.
## 0.1.11 — install instructions that match the client you use

- The README now spells out two install paths and nothing else: the web client through its plugin dialog or the CLI, and the desktop client through the app's own plugin panel.
- The payload a project receives no longer carries this repository's own acceptance runbook or the author's drive paths, and the changelog that travels with a project is this project's changelog.
- A plugin-authoring guide ships in the repository — what a DSH plugin has to declare, what it cannot do, and the mistakes worth avoiding before publishing — while staying out of the payload a game project gets.
## 0.1.10 — the repository answers the questions a visitor has

- The published repository now carries a security policy, issue templates and a contributing guide, so GitHub's community checks are satisfied and someone with a problem knows where to report it.
- Both the README and the contributing guide state that pull requests are disabled on the published repository — it is a build artifact — and that anyone who wants to contribute code can say so in Discussions, where the framework source will be opened for pull requests once there is interest.
- The package now names the project it belongs to: repository, issue tracker, homepage, keywords and author. The release gate fails if any of those fields go missing.
## 0.1.9 — the rules a project inherits are actually read

- A project's `CLAUDE.md` now spells out the `@path` imports it used to carry. This runtime does not expand them, so until now those four documents were referenced but never read; they are now written out as "read this file" instructions, and the release gate fails if an unexpanded import would ship.
- Every agent role card states the tools its role should stay within, using the same tool names as the frontmatter directly above it, so a delegated role reads one vocabulary rather than two. The boundary is advisory: the runtime cannot enforce a per-agent tool set.
- The notes the generator adds to skill and role cards are written in Chinese, like the rest of what a project receives. Contributor documentation and release text stay in English.
- The bash ↔ Node comparison now counts its skips and fails when the count is unexpected, instead of skipping the two YAML-dependent pairs quietly.
## 0.1.8 — the framework changelog travels with the project

- A project seeded from the framework now carries the changelog its upgrade guide refers to, so the two documents stay together.

## 0.1.7 — upgrades remove files that are no longer shipped

- An installed copy is rebuilt when the version changes, so a project no longer picks up documents or tools that a later version has removed.

## 0.1.6 — releases now add to the repository history

- Publishing a version records a new commit in the plugin repository instead of replacing its history, so earlier releases and their notes stay reachable.

## 0.1.5 — machine installs refresh correctly after an update

- The framework payload on an existing machine is now refreshed when the version changes, so a user who upgrades the plugin receives the current skills, documents and instructions.

## 0.1.4 — project-ready AGENTS.md; maintainer material stays out of the installed payload

- The framework now ships its own user-facing `AGENTS.md` (engine anchor, project layout, skills/hooks usage, output language) instead of the maintainer copy; the maintainer copy and the internal port/publishing documents stay out of the payload.
- The build fails if any maintainer-only marker is found anywhere in the payload.

## 0.1.3 — 2026-10-13

- Keep maintainer-only files out of the bundled framework payload (preview HTMLs, the upstream README copy, the submission YAML, the sidebar diagram and the changelog source).

## 0.1.2 — 2026-10-13

- Added this changelog so the package's history is visible from the repository.

## 0.1.1 — 2026-10-11

- Ship `LICENSE` at the package root (MIT) — fixes the broken `[LICENSE](LICENSE)` link and lets GitHub detect the license.
- Mark the bundled framework (`payload/`) as vendored in `.gitattributes`.
- README: state that `payload/` is an internal detail; align the version badge with `package.json`.
- Payload: drop dev-only docs (the preserved upstream README copy and the local preview HTMLs).

## 0.1.0 — 2026-10-11

- First release: hook bridge for all nine upstream hook events, studio status line projection, and a self-installing framework payload (76 skills, 49 agents, 13 rules, 14 Node hooks).
- Installing the plugin bootstraps the machine (`~/.dsh/dsgs` plus user-level `dsgs-init` / `start` skills) so an empty workspace can be initialised with `/start`.

























