# Setup Requirements

> **上游机制说明**：本文描述的是上游运行时的做法；DSH 的等价做法见 [`dsh-differences.md`](dsh-differences.md)。

This template requires a few tools to be installed for full functionality.
Hooks carry on without an optional tool and lose only the check it powers. The
required ones are required: without Python 3 every setting falls back to its
default and a commit that stages data JSON is blocked, and without Bash no hook
runs at all.

## Required

| Tool | Purpose | Install |
| ---- | ---- | ---- |
| **Git** | Version control, branch management | [git-scm.com](https://git-scm.com/) |
| **上游运行时** | AI agent CLI | Native installer: `curl -fsSL https://claude.ai/install.sh \| bash` (macOS, Linux, WSL) or `irm https://claude.ai/install.ps1 \| iex` (Windows PowerShell). npm also works: `npm install -g @anthropic-ai/claude-code` (Node.js 22+). See [code.dsh.com/docs/en/setup](https://code.dsh.com/docs/en/setup) |
| **Python 3** | Reads `project.yaml` for every skill and hook | [python.org](https://www.python.org/). Without it every setting silently falls back to its default, and a commit that stages data JSON is blocked because it cannot be validated |
| **Bash** | Runs every hook | Built into macOS and Linux. On Windows, install [Git for Windows](https://git-scm.com/downloads/win) — 上游运行时 runs without it, but no DSGS hook does |

## Recommended

| Tool | Used By | Purpose | Install |
| ---- | ---- | ---- | ---- |
| **jq** | Hooks (8 of 12) | JSON parsing in commit/push/asset/agent hooks | See below |

### Installing jq

**Windows** (any of these):
```
winget install jqlang.jq
choco install jq
scoop install jq
```

**macOS**:
```
brew install jq
```

**Linux**:
```
sudo apt install jq     # Debian/Ubuntu
sudo dnf install jq     # Fedora
sudo pacman -S jq       # Arch
```

## Platform Notes

### Windows
- Git for Windows includes **Git Bash**, which provides the `bash` command
  used by all hooks in `settings.json`
- If 上游运行时 can't find Git Bash, set `CLAUDE_CODE_GIT_BASH_PATH` to its
  `bash.exe` in the `env` block of your settings (for example
  `C:\\Program Files\\Git\\bin\\bash.exe` in JSON)
- Hooks use `bash .dsh/hooks/[name].sh` — this works on Windows because
  上游运行时 invokes commands through a shell that can find `bash.exe`

### macOS / Linux
- Bash is available natively
- Install `jq` via your package manager for full hook support

## Verifying Your Setup

Run these commands to check prerequisites:

```bash
git --version          # Should show git version
bash --version         # Should show bash version
jq --version           # Should show jq version (optional)
python --version       # Required: Python 3 (python3 or py also work)
```

## What Happens Without Optional Tools

| Missing Tool | Effect |
| ---- | ---- |
| **jq** | Nothing is lost: every hook falls back to `grep` to read its JSON input. jq is only more robust with unusual input. |
| **Python 3** | Not optional (see Required). Every setting falls back to its default, because `project.yaml` is read through Python; the asset hook skips JSON validation and says so; a commit that stages data JSON is blocked. |
| **Both** | As without Python. |

## Optional Performance Settings

DSGS deliberately ships **no** values for the settings below. Each one's best
value depends on your machine, your the agent plan and how you work, so a value
committed here would be a guess every user inherits without noticing. Set the
ones you want in `.dsh/settings.local.json`, which is gitignored and yours
alone.

| Setting | What it does | When to change it |
| ---- | ---- | ---- |
| `promptCacheTtl` | How long the main conversation's prompt cache lives. | Raise it if you work in long sessions with gaps; the cache surviving a break avoids re-sending context. |
| `subagentPromptCacheTtl` | The same, for subagents and other off-conversation requests. | Worth raising on a 49-agent project like this one, where `team-*` skills spawn repeatedly. |
| `autoCompactWindow` | How full the context gets before 上游运行时 compacts it. | Lower it if compaction keeps surprising you mid-task; raise it if you would rather compact less often and keep more history. |
| `skillListingBudgetFraction` | How much context the skill listing may occupy. | DSGS ships 74 skills, so the listing is not small. Lower it if you want more room for work; `skillListingMaxDescChars` trims each description instead. |

`sandbox.enabled` isolates shell commands from your filesystem and network. It
is worth turning on, but it runs on **macOS, Linux and WSL2 only** — it is not
available on native Windows, which is DSGS's primary platform.

### One setting DSGS does ship

`permissions.defaultMode` is set to `default` in `.dsh/settings.json`, on
purpose. It makes 上游运行时 ask before acting, which is what every approval
gate in this framework depends on. Project settings outrank personal ones, so
this holds even if your own config sets `acceptEdits` or `auto` — otherwise
DSGS's collaboration protocol would be silently switched off for you and the
agents would write files you never approved.

If you genuinely want it off, override it in `.dsh/settings.local.json`,
which takes precedence. Understand what you are turning off first.

**The VS Code extension does not read it.** The extension never reads a
project's `.dsh/settings.json` for the permission mode a conversation starts
in. To get the same behaviour there, set `claudeCode.initialPermissionMode` to
`default` in your VS Code user settings.

## Recommended IDE

上游运行时 works with any editor, but the template is optimized for:
- **VS Code** with the 上游运行时 extension
- **Cursor** (上游运行时 compatible)
- Terminal-based 上游运行时 CLI
