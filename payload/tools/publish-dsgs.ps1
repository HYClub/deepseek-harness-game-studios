# Publish the plugin package.
# Guarantees that a release is recorded as a new commit on top of the published history:
# it works from a clone of the remote repository, asserts that the history grew, and only then pushes.
#
#   pwsh -File tools/publish-dsgs.ps1            # publish
#   pwsh -File tools/publish-dsgs.ps1 -DryRun    # build + assert, do not push
param(
  [string]$Remote = 'https://github.com/HYClub/deepseek-harness-game-studios.git',
  [string]$Work   = (Join-Path $PSScriptRoot '..\dist\deepseek-harness-game-studios'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 1. Fresh clone when the working copy is missing or is not a repository.
if (-not (Test-Path (Join-Path $Work '.git'))) {
  if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
  git clone -q $Remote $Work
  if ($LASTEXITCODE -ne 0) { throw "clone failed: $Remote" }
}
$before = [int](git -C $Work rev-list --count HEAD)
Write-Host "  history before: $before commit(s)"

# 2. Build. The builder keeps .git and appends exactly one commit.
$env:DSGS_COMMIT = '1'
try { & node (Join-Path $root 'tools\build-dsgs-package.mjs') | Out-Host }
finally { Remove-Item Env:\DSGS_COMMIT -ErrorAction SilentlyContinue }

# 3. Assert the history grew and the tag exists.
$after = [int](git -C $Work rev-list --count HEAD)
$version = (git -C $Work show HEAD:package.json | ConvertFrom-Json).version
$tag = "v$version"
if ($after -le $before) { throw "history did not grow ($before -> $after): refusing to publish a rewritten snapshot" }
if (-not (git -C $Work tag -l $tag)) { throw "tag $tag is missing" }
Write-Host "  history after:  $after commit(s) | tag $tag | version $version"

# 3b. Surface gate: the same 12 assertions that guard every published artefact.
& node (Join-Path $root 'tools\verify-surfaces.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'surface gate failed: refusing to publish' }

# 4. Publish: fast-forward only. A rejection here means someone rewrote history; stop instead of forcing.
if ($DryRun) { Write-Host '  dry run: not pushing'; exit 0 }
git -C $Work push
if ($LASTEXITCODE -ne 0) { throw 'push rejected: the remote history is not an ancestor of this release (do not force; investigate)' }
git -C $Work push origin $tag
if ($LASTEXITCODE -ne 0) { throw "failed to push $tag" }
Write-Host "  published $version"

