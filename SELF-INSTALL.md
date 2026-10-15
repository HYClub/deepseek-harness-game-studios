# What this plugin writes to your machine

On first load (and whenever the bundled payload version changes), this plugin installs **DeepSeek
Game Studios** at the machine level so that any folder — including a brand-new empty one — can be
initialised by saying "初始化 DSGS".

It writes exactly two things, both inside your DSH home (`$DSH_HOME`, default `~/.dsh`):

| Path | What |
|---|---|
| `<home>/DSGS/**` | the framework payload (skills, agents, rules, hooks, tools, docs, instruction files) |
| `<home>/skills/dsgs-init/SKILL.md` | the bootstrap skill that handles the phrase "初始化 DSGS" |

It never touches any project directory, and it never overwrites files in a project.

## Undo

    Remove-Item -Recurse -Force "$env:USERPROFILE.dshdsgs"
    Remove-Item -Recurse -Force "$env:USERPROFILE.dshskillsdsgs-init"

Then uninstall this plugin (GUI → 插件 → 卸载, or `dsh plugin --profile <p> remove deepseek-harness-game-studios`)
and restart `dsh web`. Projects that were already initialised keep working; only new initialisations stop.
