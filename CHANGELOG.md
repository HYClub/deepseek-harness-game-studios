# Changelog

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






