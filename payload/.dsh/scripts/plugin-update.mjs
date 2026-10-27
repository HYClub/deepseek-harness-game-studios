#!/usr/bin/env node
// plugin-update.mjs — report whether the DSGS plugin in this profile is older than the latest release.
//
// WHY A SCRIPT. "Is there an update" has three inputs that must agree: which profile the session runs
// under, what version is installed in it, and what the repository's newest tag is. A model reading three
// files can miss one; this prints one JSON line the skill can branch on.
//
// READS ONLY. It never installs, removes or writes anything — the skill decides, and asks the user first.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/HYClub/deepseek-harness-game-studios.git';
const PACKAGE = 'deepseek-harness-game-studios';

const semver = (value) => String(value || '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
const compare = (a, b) => {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};

/** The profile this session runs under, from the environment DSH sets. */
function currentProfile() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const name = process.env.DSH_PROFILE || '';
  const dir = process.env.DSH_PROFILE_DIR || (name ? join(home, 'profiles', name) : '');
  return { home, name, dir };
}

/** Version of the installed package inside a profile, or null. */
function installedVersion(profileDir) {
  if (!profileDir) return null;
  const file = join(profileDir, 'node_modules', PACKAGE, 'package.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null; } catch { return null; }
}

/** Profiles that have the plugin installed, for when the environment is silent. */
function profilesWithPlugin(home) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(join(home, 'profiles'), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = installedVersion(join(home, 'profiles', entry.name));
    if (version) out.push({ profile: entry.name, version });
  }
  return out;
}

/** Newest release tag, or a reason it could not be read. */
function latestRelease() {
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', '--refs', REPO], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tags = out.split('\n')
      .map((line) => (line.match(/refs\/tags\/(v[0-9][0-9.]*)$/) || [])[1])
      .filter(Boolean);
    if (!tags.length) return { error: 'no release tags found' };
    tags.sort(compare);
    return { tag: tags[tags.length - 1] };
  } catch (error) {
    const timedOut = error && (error.code === 'ETIMEDOUT' || /timed out/i.test(String(error.message)));
    return { error: timedOut ? 'timeout' : 'git or network unavailable' };
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { home, name, dir } = currentProfile();
  const warnings = [];
  const installed = installedVersion(dir);
  const profiles = profilesWithPlugin(home);
  if (!installed && profiles.length) {
    warnings.push('plugin is not installed in the running profile' + (name ? ' (' + name + ')' : '') + '; found in: ' + profiles.map((p) => p.profile + '@' + p.version).join(', '));
  }
  if (!installed && !profiles.length) warnings.push('plugin is not installed in any profile under ' + home);

  const latest = latestRelease();
  if (latest.error) warnings.push('latest release unknown: ' + latest.error);

  let status = 'unknown';
  if (installed && latest.tag && compare(installed, latest.tag) < 0) status = 'update-available';
  else if (installed && latest.tag) status = 'up-to-date';

  const managedByApp = name === 'desktop';
  const commands = !installed || status !== 'update-available' ? null : managedByApp ? {
    hint: 'Desktop profile is owned by the app, so the CLI cannot change it: Plugins → uninstall deepseek-harness-game-studios → Add plugin → ' + REPO.replace(/\.git$/, '') + ' → install → restart the app.',
  } : {
    remove: 'dsh plugin --profile ' + name + ' remove ' + PACKAGE,
    add: 'dsh plugin --profile ' + name + ' add ' + REPO.replace(/\.git$/, ''),
    then: 'restart the client',
  };

  process.stdout.write(JSON.stringify({
    repo: REPO,
    package: PACKAGE,
    profile: name || null,
    profileDir: dir || null,
    managedByApp,
    installed: installed ?? null,
    latest: latest.tag ?? null,
    status,
    commands,
    otherProfiles: profiles,
    warnings,
  }) + '\n');
}


