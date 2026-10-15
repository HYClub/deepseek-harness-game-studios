# local overrides file Template

> **上游机制说明**：本文描述的是上游运行时的做法；DSH 的等价做法见 [`dsh-differences.md`](dsh-differences.md)。

Copy this file to the project root as `local overrides file` for personal overrides.
This file is gitignored and will not be committed.

```markdown
# Personal Preferences

## Model Preferences
- Prefer Opus for complex design tasks
- Use Haiku for quick lookups and simple edits

## Workflow Preferences
- Always run tests after code changes
- Compact context proactively at 60% usage
- Use /clear between unrelated tasks

## Local Environment
- Python command: python (or py / python3)
- Shell: Git Bash on Windows
- IDE: VS Code with 上游运行时 extension

## Communication Style
- Keep responses concise
- Show file paths in all code references
- Explain architectural decisions briefly

## Personal Shortcuts
- When I say "review", run /code-review on the last changed files
- When I say "status", show git status + sprint progress
```

## Setup

1. Copy this template to your project root: `cp .dsh/docs/local-instructions-template.md local overrides file`
2. Edit to match your preferences
3. Verify `local overrides file` is in `.gitignore` (上游运行时 reads it from the project root)
