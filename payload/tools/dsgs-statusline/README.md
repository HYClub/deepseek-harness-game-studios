# dsgs-statusline

The upstream template renders a status line on every session:

```
ctx: 37% | DeepSeek V3 | Minimal · brief
```

DSH has **no status-line surface** — verified by searching the whole harness installation, where the
only `statusline` hits are unrelated UI code. This package is the DSGS-side answer: a **client UI
plugin** that docks the line above the composer, the same way the harness's own GoalBar does.

**This is an addition, not a replication of anything upstream.**

## How it works

| Half | What it does | Verified |
|---|---|---|
| `index.js` (server) | registers a **session projection** (`dgsStatusline` → `{ line }`) with `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` — the shape taken from `dsh-agent-loop`'s `turnBoundaryProjectionDefinition` | ✅ loads: a profile with the plugin boots and returns; `apply` is synchronous and does **no** I/O |
| `client.js` (client) | loaded through `window.__ModuleLoader__.load({ id, factory })` (the shape `dsh-client-ui-goal` uses) and contributes a bar to the **`conversation.input.dock`** slot — the dock above the composer | ✅ `test/client.test.mjs` **5/5**: registers under the right id, exposes `apply`/`inject`, contributes with the verified payload (`{ name, id, order, inject }, Component`), renders the projection's line, renders nothing (and throws nothing) without a projection |

## What is still unverified

**That the GUI actually mounts the bar.** Everything up to that point is tested; no one has loaded
this into a running web app yet.

## Why the server half looks deliberately small

An earlier revision ran the ported renderer (`node .dsh/statusline.mjs`) from a polling interval with
an async `apply` that awaited a dynamic import. That revision made `dsh --profile <p> --help` **never
return**. `timer.unref()` did not fix it. A plugin that can hang the harness is worse than no plugin,
so the revision was replaced with one that does no I/O at all: the projection carries whatever the
caller sets on it (`setLine`), and the line itself is produced by the verified renderer.

## The line itself

```pwsh
node .dsh/statusline.mjs      # the faithful port, 13 unit cases
/statusline                   # the DSGS-only skill that prints it
```

## Install

```pwsh
# into a profile （见仓库 README）by
# `dsh plugin add` with no app bundle hangs on boot)
dsh plugin --profile web add <path-or-github-address>
```

Restart the harness afterwards: profile rows mount at startup.


