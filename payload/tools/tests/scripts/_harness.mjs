/**
 * Shared harness for the ported `.claude/scripts/*.sh` tests.
 *
 * Contract under test: each script is a PROCESS. Its stdout/stderr text and its
 * exit code are what the calling skills parse, so every test spawns the real
 * entry point and asserts on bytes.
 *
 * Two sandbox rules shape this file (see `dsh-src/hooks/PORTING.md`):
 *   - Piped stdio is denied, so stdin/stdout/stderr travel through real files
 *     handed to the child by file descriptor. Nothing here uses `stdio: 'pipe'`.
 *   - The scripts find their project root by walking two levels up from their own
 *     path (`scriptRoot()` / `import.meta.dirname`). A fixture therefore has to
 *     CONTAIN the script, so `makeFixture()` lays out
 *     `<fixture>/dsh-src/scripts/…` plus the two modules they import, and the
 *     fixture root is the project root. That keeps the repository itself
 *     untouched and makes "the script derives the right root" part of what is
 *     exercised.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root, derived from this file's location (`tools/tests/scripts/`). */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SCRIPTS_SRC = join(REPO_ROOT, 'dsh-src', 'scripts');
export const HOOKS_SRC = join(REPO_ROOT, 'dsh-src', 'hooks');

/** Modules the ported scripts import, relative to the fixture's `dsh-src/`. */
const SCRIPT_MODULES = ['_fsutil.mjs'];
const HOOK_MODULES = ['_capture.mjs'];

/** The four scripts this suite covers. */
export const SCRIPT_FILES = [
  'review-receipts.mjs',
  'project-coherence.mjs',
  'review-scope.mjs',
  'rotate-session-state.mjs',
];

/** Copy the shared modules an entry point imports into a fixture tree. */
function copyModules(root) {
  const scriptsDir = join(root, 'dsh-src', 'scripts');
  const hooksDir = join(root, 'dsh-src', 'hooks');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  for (const file of SCRIPT_MODULES) cpSync(join(SCRIPTS_SRC, file), join(scriptsDir, file));
  for (const file of HOOK_MODULES) cpSync(join(HOOKS_SRC, file), join(hooksDir, file));
}

/** Create a unique fixture directory. */
export function makeTmpRoot(prefix = 'dsh-scripts-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a file inside a fixture, creating parent directories. */
export function writeFixture(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

/**
 * `{ copy: 'tools/yaml-helper.mjs' }` copies a repository file into the fixture
 * instead of writing literal content.
 */
export function materialise(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    if (content !== null && typeof content === 'object' && typeof content.copy === 'string') {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(REPO_ROOT, content.copy), target);
    } else {
      writeFixture(root, relative, content);
    }
  }
}

/**
 * Build an isolated fixture project containing the script under test.
 * @param {{files?: Record<string, string|{copy: string}>, withRepo?: boolean}} [options]
 * @returns {{root: string, script: (name: string) => string, cleanup: () => void}}
 */
export function makeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-scripts-fixture-'));
  installScripts(root);
  materialise(root, options.files ?? {});
  return {
    root,
    script: (name) => join(root, 'dsh-src', 'scripts', name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Copy the ported scripts into a directory that already exists (used for git
 * worktrees, which must be cloned before the scripts are added).
 * @param {string} root
 */
export function installScripts(root) {
  copyModules(root);
  for (const file of SCRIPT_FILES) cpSync(join(SCRIPTS_SRC, file), join(root, 'dsh-src', 'scripts', file));
}

/**
 * Run one ported script the way its skill calls it:
 * `node <fixture>/dsh-src/scripts/<name> <args…>` with cwd = the fixture root.
 * @param {{root: string, script: (name: string) => string}} fixture
 * @param {string} name script file name, e.g. `review-receipts.mjs`
 * @param {string[]} args
 * @param {{env?: Record<string, string>, stdinText?: string, timeoutMs?: number}} [options]
 * @returns {{status: number, stdout: string, stderr: string, error?: Error}}
 */
export function runScript(fixture, name, args = [], options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scripts-run-'));
  const inFile = join(dir, 'in.txt');
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  writeFileSync(inFile, options.stdinText ?? '', 'utf8');
  const fds = [openSync(inFile, 'r'), openSync(outFile, 'w'), openSync(errFile, 'w')];
  let result;
  try {
    result = spawnSync(process.execPath, [fixture.script(name), ...args], {
      cwd: options.cwd ?? fixture.root,
      stdio: fds,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 60_000,
      windowsHide: true,
    });
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const out = { status: result.status ?? -1, stdout: read(outFile), stderr: read(errFile) };
  if (result.error !== undefined && result.error !== null) out.error = result.error;
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * Initialise a git repository in `dir` and commit everything staged so far.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point at a file that does not exist,
 * which is how the tests avoid inheriting user config (signing, hooks, safe
 * directory). Author identity is supplied per commit instead.
 * @param {string} dir
 * @param {string} message
 */
export function commitAll(dir, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Scripts Test',
    GIT_AUTHOR_EMAIL: 'scripts-test@example.invalid',
    GIT_COMMITTER_NAME: 'Scripts Test',
    GIT_COMMITTER_EMAIL: 'scripts-test@example.invalid',
    GIT_CONFIG_GLOBAL: join(dir, '.gitconfig-absent'),
    GIT_CONFIG_SYSTEM: join(dir, '.gitconfig-absent'),
  };
  run('git', ['init', '-q', '-b', 'main'], dir, env);
  run('git', ['config', 'commit.gpgsign', 'false'], dir, env);
  run('git', ['add', '-A'], dir, env);
  run('git', ['commit', '-q', '-m', message], dir, env);
  return env;
}

/** Run one command in `dir` with output discarded (never captured through a pipe). */
export function run(file, args, dir, env = process.env) {
  return spawnSync(file, args, { cwd: dir, stdio: 'ignore', windowsHide: true, env });
}

/**
 * A minimal assert-and-report runner: every script's test file prints one line
 * per case and sets a non-zero exit code when any case fails.
 * @param {string} suite
 * @returns {(name: string, fn: () => void) => void}
 */
export function makeChecker(suite) {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      passed += 1;
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      const detail = process.env.SCRIPTS_TEST_DEBUG === '1'
        ? String(error.stack ?? error.message)
        : String(error.message).split('\n').slice(0, 6).join('\n     ');
      console.log(`FAIL ${name}\n     ${detail}`);
      process.exitCode = 1;
    }
  };
  process.on('exit', () => {
    console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  });
  return check;
}

/** Read a fixture file, or '' when it does not exist. */
export function readFixture(root, relative) {
  const path = join(root, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
