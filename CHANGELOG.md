# Changelog

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












