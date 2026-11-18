# What this plugin writes to your machine

On first load (and whenever the bundled payload version changes), this plugin installs **DeepSeek
Game Studios** at the machine level so that any folder — including a brand-new empty one — can be
initialised by saying "初始化 DSGS".

It writes three things, all inside your DSH home (`$DSH_HOME`, default `~/.dsh`):

| Path | What |
|---|---|
| `<home>/dsgs/**` | the framework payload (skills, agents, rules, hooks, scripts, engines, docs, instruction files) |
| `<home>/skills/dsgs-init/SKILL.md` | the bootstrap skill that handles the phrase "初始化 DSGS" |
| `<home>/skills/start/SKILL.md` | the `/start` shell that initialises a workspace, then hands over to the project's own start skill |

It never writes to a project while installing: the three paths above are all under your DSH home,
and no file inside a project is overwritten. Separately, once this project's hooks are active in a
workspace they do leave their own logs there (`production/session-logs/` and `.verify-logs/`), and
`/start` creates the project folders the studio needs — that is the framework working, not this
installer touching your files.

## Undo

    Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsgs"
    Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsgs-init","$env:USERPROFILE\.dsh\skills\start"

Then uninstall this plugin (GUI → 插件 → 卸载, or `dsh plugin --profile <p> remove deepseek-harness-game-studios`)
and restart `dsh web`. Projects that were already initialised keep working; only new initialisations stop.
