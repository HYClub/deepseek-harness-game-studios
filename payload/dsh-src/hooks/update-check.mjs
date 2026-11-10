#!/usr/bin/env node
// update-check.mjs — one line at session start when a newer DSGS release is out.
//
// Node port of upstream `.claude/hooks/update-check.sh`. It reads a cache, never the network: when the
// cache is missing or a day old it starts a background refresh, which is the only part that talks to
// GitHub. The notice is silent in CI and when `updates.check: false` says so in project.yaml or
// project.local.yaml.
//
// CLI: update-check.mjs notice|refresh [--root DIR]
// The `notice` line is what session-start prints; `refresh` writes the cache and is safe to run by hand.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getYamlKey } from '../../tools/yaml-helper.mjs';

const REPO = 'HYClub/deepseek-harness-game-studios';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const DAY_SECONDS = 86_400;

function cachePath() {
  if (process.env.DSGS_CACHE_DIR) return join(process.env.DSGS_CACHE_DIR, 'latest-release');
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'deepseek-game-studios', 'latest-release');
}

/** The version this installation is: env override, the machine payload, then this checkout. */
export function installedVersion() {
  if (process.env.DSGS_VERSION) return process.env.DSGS_VERSION.trim();
  for (const candidate of [
    join(homedir(), '.dsh', 'dsgs', 'package.json'),
    join(import.meta.dirname, '..', '..', 'package.json'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf8')).version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch { /* a broken file is not a version */ }
  }
  return '';
}

/** Three numeric fields, ignoring a prerelease suffix, as the shell compares them. */
function newer(a, b) {
  const left = a.split('-')[0].split('.');
  const right = b.split('-')[0].split('.');
  for (let i = 0; i < 3; i += 1) {
    const x = Number.parseInt(left[i] ?? '0', 10);
    const y = Number.parseInt(right[i] ?? '0', 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function enabled(root) {
  if (process.env.CI) return false;
  for (const file of ['project.local.yaml', 'project.yaml']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const value = getYamlKey(path, 'updates.check');
    if (value === 'false') return false;
    if (value === 'true') return true;
  }
  return true;
}

function readCache() {
  const path = cachePath();
  const state = { latest: '', checked: 0 };
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('latest=')) state.latest = line.slice(7).trim();
    if (line.startsWith('checked=')) {
      const value = Number.parseInt(line.slice(8), 10);
      state.checked = Number.isFinite(value) ? value : 0;
    }
  }
  return state;
}

/** Ask GitHub for the newest release tag and write the cache; never throws, never waits long. */
export async function refresh() {
  const path = cachePath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  let latest = '';
  let error = '';
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) error = `HTTP ${response.status}`;
    else {
      const body = await response.json();
      const tag = String(body.tag_name ?? '').replace(/^v/, '');
      if (/^\d+\.\d+\.\d+/.test(tag) && !/[^0-9.]/.test(tag)) latest = tag;
      else error = `unexpected tag: ${tag}`;
    }
  } catch (caught) {
    error = `request failed: ${caught.message}`;
  }
  if (latest.length === 0) latest = readCache().latest;
  const temp = `${path}.${process.pid}`;
  const lines = [`checked=${Math.floor(Date.now() / 1000)}`, `latest=${latest}`];
  if (error.length > 0) lines.push(`error=${error}`);
  writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8');
  renameSync(temp, path);
}

/** The line session-start prints, or '' when there is nothing to say. */
export function updateNotice(root) {
  if (!enabled(root)) return '';
  const state = readCache();
  const now = Math.floor(Date.now() / 1000);
  if (now - state.checked >= DAY_SECONDS || state.checked > now) {
    // Fire and forget: the notice never waits for the network.
    try {
      const child = spawn(process.execPath, [import.meta.filename, 'refresh', '--root', root], {
        detached: true, stdio: 'ignore', cwd: root,
      });
      child.unref();
    } catch { /* no refresh this time; the cached line still prints */ }
  }
  const current = installedVersion();
  if (current.length === 0 || state.latest.length === 0) return '';
  if (!newer(state.latest, current)) return '';
  return `Update: DeepSeek Game Studios ${state.latest} is out (this project has ${current}). What changed: ${RELEASES}`;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  const command = argv.find((arg) => !arg.startsWith('--'));
  const rootArg = argv[argv.indexOf('--root') + 1];
  if (argv.includes('--root') && rootArg) root = resolve(rootArg);
  if (command === 'refresh') await refresh();
  else if (command === 'notice') {
    const line = updateNotice(root);
    if (line.length > 0) process.stdout.write(`${line}\n`);
  } else {
    process.stdout.write('update-check: usage: update-check.mjs notice|refresh [--root DIR]\n');
  }
}
