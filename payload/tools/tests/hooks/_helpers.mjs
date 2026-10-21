/**
 * Shared fixture/runner helpers for the ported-hook tests.
 *
 * These tests execute the real hook entry points as child processes, because the
 * contract under test is a process contract: the JSON payload arrives on stdin and
 * the verdict is the exit code (0 allow, 2 block) plus stdout/stderr.
 *
 * Two sandbox rules shape the harness:
 *   - Piped stdio is denied, so stdin/stdout/stderr travel through real files and
 *     are handed to the child by file descriptor. Nothing here uses `stdio: 'pipe'`.
 *   - Writing under the OS temp directory is not guaranteed, so fixtures are built
 *     inside the repository (`.hook-tests/`) and removed in a `finally` block.
 *
 * Fixtures work because `projectRoot()` gives a cwd holding `project.yaml` or
 * `.dsh/` priority over everything else, so a hook invoked with cwd = fixture root
 * reads and writes entirely inside the fixture. Hooks are always executed from
 * their real location in `dsh-src/hooks/`, never copied into the fixture, so
 * relative imports keep resolving.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const HOOKS_DIR = join(REPO_ROOT, 'dsh-src', 'hooks');
export const FIXTURE_ROOT = join(REPO_ROOT, '.hook-tests');

/**
 * Create a unique fixture directory inside the repo.
 *
 * A `project.yaml` is written by default, because that is what makes the fixture a
 * PROJECT ROOT: `projectRoot()` gives a cwd holding `project.yaml` (or `.dsh/`)
 * priority, and without one a hook legitimately falls back to the repository that
 * contains the hook script. Pass `{ project: false }` to exercise that fallback.
 */
export function makeFixture(options = {}) {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'fx-'));
  if (options.project !== false) writeFileSync(join(dir, 'project.yaml'), '# fixture project root\n', 'utf8');
  return dir;
}

/** Remove a fixture tree; safe to call twice. */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Remove the shared fixture root when it is empty. */
export function cleanupRoot() {
  try {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {
    /* leave it behind rather than fail a test over cleanup */
  }
}

/** Write a file, creating parent directories. */
export function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Read a file, or null when it does not exist. */
export function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Run a hook entry point with `stdinText` on stdin.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function runHook(hookFile, stdinText, options = {}) {
  const cwd = options.cwd ?? REPO_ROOT;
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'run-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const source = typeof stdinText === 'string' ? stdinText : JSON.stringify(stdinText ?? {});
  writeFileSync(inFile, source, 'utf8');
  const inFd = openSync(inFile, 'r');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [join(HOOKS_DIR, hookFile)], {
    // Fixtures must look like non-git directories even when the enclosing repo has commits.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: FIXTURE_ROOT },
      cwd,
      stdio: [inFd, outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
  } finally {
    closeSync(inFd);
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout, stderr };
}

/** Run a git command inside a fixture; the environment is pinned so commits work. */
export function gitIn(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Hook Test',
      GIT_AUTHOR_EMAIL: 'hook-test@example.invalid',
      GIT_COMMITTER_NAME: 'Hook Test',
      GIT_COMMITTER_EMAIL: 'hook-test@example.invalid',
      GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig-none'),
      GIT_CONFIG_SYSTEM: join(cwd, '.gitconfig-none'),
    },
  });
}

/**
 * Initialise a git repo in a fixture and make one commit.
 *
 * The fixture's `project.yaml` (when present) is committed too, so a fixture with
 * no deliberate changes really does have a clean working tree — otherwise every
 * list-bounding assertion would be off by the one untracked config file.
 */
export function initGitFixture(cwd) {
  gitIn(cwd, ['init', '-q', '-b', 'main']);
  gitIn(cwd, ['config', 'commit.gpgsign', 'false']);
  write(join(cwd, 'README.md'), '# fixture\n');
  gitIn(cwd, ['add', '-A']);
  gitIn(cwd, ['commit', '-q', '-m', 'fixture: initial commit']);
}

/** A minimal `tools/yaml-helper.mjs` stub: `__call session_state_enabled` → exit 1. */
export function stubYamlHelperOff(cwd) {
  write(
    join(cwd, 'tools', 'yaml-helper.mjs'),
    "process.exit(process.argv[2] === '__call' && process.argv[3] === 'session_state_enabled' ? 1 : 0);\n",
  );
}

/**
 * Copy the repository's real `tools/yaml-helper.mjs` into a fixture.
 *
 * This is the honest end-to-end exercise of `features.session_state: off`: the
 * resolver decides from `project.yaml` in its cwd, so the fixture needs the real
 * file to be the real check rather than the stub. Returns false if the helper is
 * absent from the repository (then the caller should skip that case).
 */
export function copyRealYamlHelper(cwd) {
  const source = join(REPO_ROOT, 'tools', 'yaml-helper.mjs');
  if (!existsSync(source)) return false;
  write(join(cwd, 'tools', 'yaml-helper.mjs'), readFileSync(source, 'utf8'));
  return true;
}


