---
name: update
description: "Check whether the installed DSGS plugin is older than the newest release, and — only after you confirm — remove and re-add it in this profile. Reads first, acts second. DSGS-only."
argument-hint: ""
user-invocable: true
---

# Update

Bring the plugin in this profile up to the newest release: check, show the commands, run them after the user
agrees, then ask for a restart.

Restarting alone changes nothing — the profile keeps what the package manager resolved when the plugin was added,
so an update means removing and adding it again. Say that once, plainly, and move on to the steps.

## Step 1 — read the state

```pwsh
node .dsh/scripts/plugin-update.mjs
```

One JSON line:

| Field | Meaning |
|---|---|
| `profile` | the profile this session runs under (`DSH_PROFILE`) |
| `managedByApp` | `true` for the desktop profile — the Electron app owns it, the CLI refuses to touch it |
| `installed` / `latest` | versions, e.g. `x.y.z` installed and `vx.y.z` newest tag |
| `status` | `up-to-date` · `update-available` · `unknown` |
| `commands` | the exact commands for a CLI profile, or a hint for the desktop app |
| `otherProfiles` | where else the plugin is installed, with versions |
| `warnings` | network failure, not installed, and similar |

## Step 2 — answer

- **`up-to-date`** — one line: installed version = latest, nothing to do.
- **`unknown`** — say what could not be read (usually no network for `git ls-remote`) and stop. Do not guess a
  version.
- **`update-available` + `managedByApp`** — the CLI cannot install into the desktop profile. Say: open `Plugins`,
  uninstall `deepseek-harness-game-studios`, `Add plugin`, paste the URL, install, restart; after the restart,
  read `node .dsh/scripts/plugin-update.mjs` once more and confirm `installed` changed. Offer the paste for them:

  ```pwsh
  Set-Clipboard -Value 'https://github.com/HYClub/deepseek-harness-game-studios'
  ```
- **`update-available` + CLI profile** — go to Step 3.

## Step 3 — ask before removing anything

Print the two commands verbatim, then ask. **Do not run them before the user agrees** — the first one removes the
plugin from their profile:

```pwsh
dsh plugin --profile <profile> remove deepseek-harness-game-studios
dsh plugin --profile <profile> add https://github.com/HYClub/deepseek-harness-game-studios
```

Only after an explicit yes:

1. run `remove`, then `add` (a failed `add` leaves the profile without the plugin — say so plainly if it happens);
2. re-run `node .dsh/scripts/plugin-update.mjs` and confirm `installed` changed;
3. tell the user to **restart the client** — the framework payload (`~/.dsh/dsgs`) is refreshed at plugin load,
   and the running session keeps the old skills until then.

## Boundaries

- **Never** run `dsh plugin --profile desktop …`: it is refused by design, and pretending otherwise wastes the
  user's time.
- **Never** upgrade a profile this session is not running under (the other entries in `otherProfiles`) unless the
  user names that profile.
- No version guessing: if `latest` is `null`, say the check failed.



