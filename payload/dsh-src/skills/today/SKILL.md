---
name: today
description: "Answer 'what do I do now' in three to five lines — the story to pick up, what is blocked, and the next command to run. Reads project-state.mjs; writes nothing. DSGS-only."
argument-hint: ""
user-invocable: true
---

# Today

One question, one short answer: **今天该做什么**. Not a status report, not a plan — the shortest
honest answer the project's own files can support.

## Step 1 — read the state

Run this and treat its output as parsed context:

```pwsh
node .dsh/scripts/project-state.mjs
```

It prints one line of JSON: `engine`, `stage`, `sprint`, `stories` (counts, `next`, `blockedList`),
`warnings`. **Nothing here is invented** — a missing file becomes a warning, not a guess.

## Step 2 — answer in three to five lines

Write the answer in the user's language. Order matters:

1. **The story to pick up** — `stories.next.file` with its status as written. Say what "pick up" means for
   that status:
   - `In Review` → the work is written; run `/story-done` to close it.
   - `In Progress` → continue it; `/dev-story` to resume.
   - `Ready` / `Not Started` → run `/dev-story` for it.
   - no status line → say the file has no `Status:` line and offer to add one.
2. **Blocked** — if `stories.blocked` > 0, name the files (at most two) and say who/what unblocks them.
3. **Next command** — exactly one: the one that moves the first item. Do not list three options; the whole
   point of this skill is that the user does not have to choose.

If `warnings` is non-empty, end with one line naming the most important warning (e.g. no
`production/sprint-status.yaml`). Do not enumerate them all.

## Empty project

When `stories.total` is 0 the answer is one line plus one command:

```
还没有故事文件。先跑 /map-systems → /create-epics → /create-stories。
```

Do not pad it. Exit cleanly.

## Boundaries

- **No writes** to any file, no status changes, no agent dispatch. This skill only reports.
- Do not restate the whole project; the user asked what to do **now**.
- Do not use `/sprint-status` output here — if the user wants the full picture, point at that skill.



