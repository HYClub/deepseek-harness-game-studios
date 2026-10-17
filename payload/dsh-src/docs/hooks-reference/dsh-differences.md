# Upstream hooks on DSH — what differs

Ten of the hook reference documents link here. This page records the differences between the upstream
Claude Code hook contract and the way the same hook behaves on DSH, so a hook that "works upstream" is
not expected to behave identically here.

## Events

| Upstream event | On DSH | Note |
|---|---|---|
| `SessionStart` | fires | `detect-gaps` uses it to announce a fresh project |
| `PreToolUse` | fires | blocking only: `allow` / `deny` / `cancel` / `ask` |
| `PostToolUse` | fires | carries the tool result; rule text and advisories are delivered here |
| `Stop` / `SessionEnd` | fires | session bookkeeping and checkpoints |
| `SubagentStop` | fires | delegation bookkeeping |
| `PreCompact` / `PostCompact` | mapped, no source | unit-tested and verified at mount level only |
| `Notification` | mapped, no source | there is no DSH notification event to attach to |

## Payload shape

- DSH passes the tool name, its input and its result through the hook bridge in one JSON payload; the
  per-event fields are the ones documented next to each hook, not the upstream envelope.
- `additionalContexts` is read from the **final tool result**, which is why advisory hooks
  (`validate-commit`, `validate-push`) are registered on `PostToolUse`.

## Blocking versus advising

- **Blocking** is enforced at `PreToolUse` and returns a `permissionDecision`.
- **Advising** cannot be delivered before an action. A plugin row can set `advisory: deny` to turn the
  same text into a pre-action block.

## Scripts

- Upstream shell hooks became **Node scripts** (`hooks/*.mjs`). The sandbox used here cannot start Git
  Bash or WSL, and capturing a child process' output through a pipe is refused, so the shell form could
  not run at all.
- Helper scripts follow the same rule: every upstream `.sh` has a Node port under `scripts/`.

## Paths and timeouts

- Hooks receive POSIX-style paths and normalise them; a Windows path in a payload is converted before use.
- A hook that exceeds its timeout is killed and reported, never silently skipped.

## Where the rest lives

For the full ledger of what replaced what, and what is still missing, see the port ledger in the
repository that ships the framework.

