---
name: dashboard
description: "Render the studio state as one offline HTML file (stage, sprint, story progress, blockers) and open it with present. Reads project files; writes only production/dashboard.html. DSGS-only."
argument-hint: ""
user-invocable: true
---

# Dashboard

The studio state as **one file you can open**. Built from the same JSON `/today` reads, so the two
cannot count stories differently.

## Step 1 — render

```pwsh
node .dsh/scripts/render-dashboard.mjs
```

It writes `production/dashboard.html` and prints one line:

```
wrote <root>/production/dashboard.html (3/12 stories, 1 warning(s))
```

## Step 2 — open it for the user

Call `present` with that path so the page opens in the GUI:

```
present({ files: [{ path: "production/dashboard.html", description: "Studio dashboard — stage, sprint, story progress, blockers" }] })
```

Then summarise in **three lines**: engine, sprint line, `done / total` (plus blocked count if non-zero).
Do not paste the HTML or restate every card.

## What the page contains

Every number on the page comes from `stories.items`, `stories.activity` and `stories.docs` — do not recount
anything yourself.

- **Charts are pre-rendered, not drawn at run time**: the script computes every chart for every range and
  writes static SVG into the file, so the gate can check the same markup a browser shows. The default view is
  marked in the markup; the controls are links to view anchors and CSS reveals the target, so switching type or
  range works with JavaScript disabled too — the script only refreshes the counter and the pressed state.
- **Three charts, switched in place**: a pie of story statuses, a bar per epic (all vs done), and a line of
  lines added and deleted per day from git history — with 7 / 30 / 90 day and all-time ranges that filter all
  three charts. Bars grow, wedges sweep in, the KPI bar animates, and each wedge carries a tooltip.
- **Uncommitted work** is counted too, and dated by each file's own modification time — an edit left from
  last week appears last week, not under today. Those days are marked pending in the JSON and drawn as hollow
  points.
- **Narrow screens** get tables instead of charts (范围汇总 / 每个 epic / 最近 10 天), so nothing is clipped.
- **Honest fallback**: when the directory has no git history (or every file landed on one day) the line chart
  says so and shows a status breakdown instead of inventing a trend.

- **Engine**, **Stage**, **Sprint**, **Stories done** (with a progress bar)
- **Next** — the story `project-state.mjs` ranked first, with its status as written
- **Blocked** — every story whose status starts with `blocked`
- **Warnings** — missing `project.yaml`, missing `production/sprint-status.yaml`, no story files

## Constraints the rendering holds

- **No external references**: no `<script src>`, no CDN, no remote font. The file must open offline.
- **Read-only**: the only write is `production/dashboard.html`. No source document is touched, no status
  is changed, no agent is dispatched.
- **Empty project is a valid result**: an uninitialised workspace gets a page that says so.

## If a warning matters

When the render prints `1 warning(s)` (or more), name the most important one after the summary — usually
"no `production/sprint-status.yaml`" (run `/sprint-plan update`) or "no story files" (run `/map-systems`).
One line, not a list.








