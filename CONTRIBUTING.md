# Contributing

This repository is a **build artifact**. It is generated from the framework source and republished on every
release, so a commit made here is replaced by the next build — which is why **pull requests are disabled on
this repository**.

That changes what is useful to send:

| You want to | Do this |
|---|---|
| Report a bug | [Open an issue](https://github.com/HYClub/deepseek-harness-game-studios/issues/new?template=bug_report.md) — this is the most useful thing you can do |
| Ask for a feature | [Open an issue](https://github.com/HYClub/deepseek-harness-game-studios/issues/new?template=feature_request.md) |
| Report a security problem | Use [SECURITY.md](SECURITY.md); do not open a public issue |
| Send a fix | Open an issue describing it. Changes are made in the framework source and appear here with the next release |

## Want to contribute code?

Pull requests are disabled here because this repository is regenerated, but the intent is not to keep you
out. **Leave a note in [Discussions](https://github.com/HYClub/deepseek-harness-game-studios/discussions)
saying what you want to work on.** When there is real interest, the framework source repository will be
opened so that changes can be reviewed as pull requests in the place where they actually belong.

## What helps most in an issue

- The command you ran and its **full output**, not a summary.
- DSH version (`dsh --version`), operating system, and shell.
- How the plugin was installed (the GUI dialog, or `dsh plugin --profile <name> add <url>`).
- Whether the problem survives a harness restart — plugins are mounted at start-up, so "restart fixed it" is
  itself a useful data point.

## Version you are running

The published version is in [CHANGELOG.md](CHANGELOG.md); the installed copy records the payload version in
`~/.dsh/dsgs/package-version.txt`. If those differ, restart the harness before reporting — the plugin installs
its payload on load.
