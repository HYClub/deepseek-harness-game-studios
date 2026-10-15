#!/usr/bin/env node
/**
 * godot-parse-check — Node entry point for the upstream Godot parse check.
 *
 * The upstream check is a GDScript SceneTree program
 * (`.claude/scripts/godot-parse-check.gd`, mirrored to `.dsh/scripts/godot-parse-check.gd`).
 * It loads each script the way the game loads it and prints `ok: <path>` / `PARSE FAIL: <path>`.
 * Running it needs a shell command of the form
 *
 *   godot --headless --path . -s res://<...>/godot-parse-check.gd -- res://src/a.gd res://src/b.gd
 *
 * which is exactly what this wrapper builds — so the check is reachable from DSH, where the
 * bash original cannot run (Git Bash does not start under the sandbox).
 *
 * Usage:
 *   node .dsh/scripts/godot-parse-check.mjs res://src/a.gd [res://src/b.gd ...]
 *   node .dsh/scripts/godot-parse-check.mjs --root <dir> --godot <exe> [--no-import] <paths...>
 *
 * Exit codes match the upstream check: 0 all scripts load, 1 any fails, 2 no script given.
 * This wrapper adds 3 for "could not run Godot at all" so a missing engine is never mistaken
 * for a passing check.
 *
 * @module .dsh/scripts/godot-parse-check
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getYamlKey } from '../../tools/yaml-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The Godot argument lists this wrapper builds. Exported so a test can assert the exact
 * command without needing an engine installed.
 * @param {'import' | 'warmup' | 'check'} phase - which invocation
 * @param {string[]} paths - `res://` script paths (only for `check`)
 * @param {string} [script] - script path inside the project (only for `check`)
 * @returns {string[]} argv for the engine
 */
export function buildGodotArgs(phase, paths = [], script = '.dsh/scripts/godot-parse-check.gd') {
  if (phase === 'import') return ['--headless', '--path', '.', '--import'];
  if (phase === 'warmup') return ['--headless', '--path', '.', '--quit'];
  return ['--headless', '--path', '.', '-s', `res://${script}`, '--', ...paths];
}

/** Walk up from `start` to the project root (the directory holding `.dsh/`). */
function projectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.dsh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `engine.path` / `commands.test` from project.yaml, in the precedence `/dev-story` Phase 6
 * documents: the executable `commands.test` names first, then the editor path `engine.path`
 * records, then PATH. Reading them here is what keeps this script consistent with the skill and
 * with `project-coherence.mjs`'s `probeGodot`, which already implements that order — before this,
 * a correctly configured project still reported "no Godot executable found".
 * @param {string} root - project root
 * @returns {string | undefined} the configured executable, when it exists on disk
 */
export function configuredGodot(root) {
  const projectYaml = join(root, 'project.yaml');
  if (!existsSync(projectYaml)) return undefined;
  const candidates = [];
  // `commands.test` may be quoted and carry arguments; its first path-looking token is the runner.
  const runner = getYamlKey(projectYaml, 'commands.test').replace(/^["']|["']$/g, '');
  if (runner !== '') {
    const token = runner.split(/\s+/).find((part) => /[\\/]/.test(part.replace(/^["']|["']$/g, '')));
    if (token !== undefined) candidates.push(token.replace(/^["']|["']$/g, ''));
  }
  const path = getYamlKey(projectYaml, 'engine.path').replace(/^["']|["']$/g, '');
  if (path !== '') candidates.push(path);
  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    if (existsSync(full)) return full;
  }
  return undefined;
}

/**
 * Find a Godot executable: explicit flag, `GODOT_BIN`, the project's own configuration, PATH,
 * then the usual download layout.
 *
 * On Windows the *console* twin matters: `Godot_v4.x_mono_win64.exe` writes nothing to a
 * captured stdout, so a probe against it looks like a silent failure. The `*_console.exe`
 * sibling is the one that reports.
 * @param {string | undefined} explicit - `--godot` value, used as-is when present
 * @param {string} root - project root, for the configured executable
 * @returns {string | undefined} absolute executable path, or undefined
 */
export function findGodot(explicit, root) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  if (typeof process.env.GODOT_BIN === 'string' && process.env.GODOT_BIN.length > 0) {
    return process.env.GODOT_BIN;
  }
  if (typeof root === 'string' && root.length > 0) {
    const configured = configuredGodot(root);
    if (configured !== undefined) return configured;
  }
  const names = process.platform === 'win32'
    ? ['godot_console.exe', 'godot.exe', 'godot4.exe', 'Godot_v4.6.2-stable_mono_win64_console.exe']
    : ['godot', 'godot4'];
  for (const name of names) {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (which.status === 0) {
      const first = String(which.stdout).split(/\r?\n/).find((line) => line.trim().length > 0);
      if (first !== undefined) return first.trim();
    }
  }
  // Common download locations: a versioned folder holding the console twin.
  const downloads = join(process.env.USERPROFILE ?? '', 'Downloads');
  if (existsSync(downloads)) {
    for (const entry of readdirSync(downloads, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(downloads, entry.name);
      for (const file of readdirSync(dir)) {
        if (!file.toLowerCase().endsWith('_console.exe')) continue;
        try {
          if (statSync(join(dir, file)).isFile()) return join(dir, file);
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return undefined;
}

/** `engine.name` from project.yaml, through the same parser the rest of the port uses. */
function engineName(root) {
  const projectYaml = join(root, 'project.yaml');
  if (!existsSync(projectYaml)) return '';
  return getYamlKey(projectYaml, 'engine.name');
}

/**
 * CLI entry. Kept in a function with an entry-point guard so importing this module (for
 * `buildGodotArgs`/`findGodot` in tests) does not run a check and exit the importer.
 * @param {string[]} argv - arguments after the script name
 * @returns {number} process exit code
 */
export function main(argv = process.argv.slice(2)) {
  const options = { root: undefined, godot: undefined, import: true };
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg === '--godot') options.godot = argv[++i];
    else if (arg === '--no-import') options.import = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node .dsh/scripts/godot-parse-check.mjs [--root <dir>] [--godot <exe>] [--no-import] res://path.gd [...]');
      return 0;
    } else paths.push(arg);
  }

  const root = options.root === undefined ? projectRoot(HERE) ?? process.cwd() : resolve(options.root);
  if (paths.length === 0) {
    process.stderr.write('godot-parse-check: no scripts given. Pass res:// paths.\n');
    return 2;
  }

  const godot = findGodot(options.godot, root);
  if (godot === undefined) {
    process.stderr.write(
      'godot-parse-check: no Godot executable found. Pass --godot <exe>, set GODOT_BIN, record `engine.path`\n'
      + '  (or a runner in `commands.test`) in project.yaml, or put the engine on PATH.\n'
      + `  project engine.name is ${JSON.stringify(engineName(root))}\n`,
    );
    return 3;
  }

  // Under a confined session Godot needs a writable user dir that is not the ambient profile;
  // pointing APPDATA at the project keeps logs and the class cache inside the workspace.
  const env = { ...process.env, APPDATA: process.env.GODOT_APPDATA ?? join(root, '.godot-appdata') };

  /** Run Godot and inherit its stdio so its own error lines reach the caller unchanged. */
  const runGodot = (args, failureNote) => {
    const result = spawnSync(godot, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error !== undefined) {
      process.stderr.write(`godot-parse-check: ${failureNote}: ${String(result.error)}\n`);
      return undefined;
    }
    return result.status ?? 3;
  };

  if (options.import) {
    // Builds the class cache that `class_name` lookups need; a failure here is not fatal,
    // because an already-imported project imports nothing and still exits non-zero.
    if (runGodot(buildGodotArgs('import'), 'import step failed to start') === undefined) return 3;
  } else if (runGodot(buildGodotArgs('warmup'), 'warm-up step failed to start') === undefined) {
    return 3;
  }

  const code = runGodot(buildGodotArgs('check', paths), 'parse check failed to start');
  return code === undefined ? 3 : code;
}

// Only run when this file is the entry point (`node .dsh/scripts/godot-parse-check.mjs …`).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
