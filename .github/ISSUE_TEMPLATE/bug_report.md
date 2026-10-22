---
name: Bug report
about: Something in the framework, the hooks or the plugin does not work
labels: bug
---

**What happened**

<!-- What you ran, and what came back. Paste the output. -->

**What you expected**

**Steps to reproduce**

1.
2.

**Environment**

- DSH version: <!-- run: dsh --version -->
- Operating system and shell: <!-- e.g. Windows 11 + PowerShell 7.6 -->
- How DSGS is installed: <!-- GUI plugin dialog, or: dsh plugin --profile web add <url> -->
- Engine configured in this project (if any): <!-- Godot 4 / Unity / Unreal / none -->

**Diagnostics**

```
# paste the output of:
node tools/check-dsh.mjs
```

- `verify-hooks-mount` result (if hooks are involved): <!-- node tools/verify-hooks-mount.mjs -->
- Does the problem survive a harness restart? <!-- the plugin is mounted at start-up -->
