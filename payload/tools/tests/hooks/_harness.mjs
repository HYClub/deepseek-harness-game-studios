/**
 * Shared test harness for the ported DSH hooks.
 *
 * Sandbox constraint (see `dsh-src/hooks/PORTING.md`): the harness denies PIPED
 * child stdio, so a child is spawned through a shell with stdin/stdout/stderr
 * REDIRECTED TO FILES and `stdio: 'ignore'` — no pipe is ever created. That is
 * the same trick `runtime.mjs`'s `capture()` uses for its own subprocesses.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root, derived from this file's location (`tools/tests/hooks/`). */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const HOOK_SRC = join(REPO_ROOT, 'dsh-src', 'hooks');

/**
 * Run a hook script the way `.dsh/hooks.json` does: `node <script>`.
 * @param {string} script absolute path to the .mjs hook
 * @param {object} options { input, inputText, cwd, timeoutMs }
 * @returns {{ status: number, stdout: string, stderr: string, error?: Error }}
 */
export function runHook(script, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-test-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const text = options.inputText
    ?? (options.input === undefined ? '' : JSON.stringify(options.input));
  writeFileSync(inFile, text, 'utf8');
  const line = `"${process.execPath}" "${script}"`
    + ` < "${inFile}" > "${outFile}" 2> "${errFile}"`;
  const result = spawnSync(line, {
    cwd: options.cwd ?? REPO_ROOT,
    shell: true,
    stdio: 'ignore',
    timeout: options.timeoutMs ?? 20_000,
    windowsHide: true,
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const out = { status: result.status, stdout: read(outFile), stderr: read(errFile) };
  if (result.error !== undefined && result.error !== null) out.error = result.error;
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * Build an isolated fixture project in the OS temp directory.
 * `layout: 'deployed'` mirrors the generated tree (`<tmp>/.dsh/hooks/…`), which
 * makes the temp dir the resolved project root and keeps the repository clean.
 *
 * A file value of `{ copy: 'tools/yaml-helper.mjs' }` copies that repo file into
 * the fixture instead of writing literal content — needed by the
 * `features.session_state` cases, which exercise the real resolver predicate.
 * @returns {{ root: string, hook: (name: string) => string, cleanup: () => void }}
 */
export function makeFixture({ files = {}, layout = 'deployed' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hook-fixture-'));
  mkdirSync(join(root, '.dsh', 'hooks'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    if (content !== null && typeof content === 'object' && typeof content.copy === 'string') {
      cpSync(join(REPO_ROOT, content.copy), target);
    } else {
      writeFileSync(target, content, 'utf8');
    }
  }
  const hookPath = (name) => {
    if (layout === 'deployed') {
      // Mirror `.dsh/hooks/`: the entry point plus the shared modules it imports.
      for (const file of [name, 'runtime.mjs', '_session-state.mjs', '_capture.mjs']) {
        const from = join(HOOK_SRC, file);
        if (existsSync(from)) cpSync(from, join(root, '.dsh', 'hooks', file));
      }
      return join(root, '.dsh', 'hooks', name);
    }
    return join(HOOK_SRC, name);
  };
  return { root, hook: hookPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Read a file, or '' when it does not exist. */
export function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Assert the audit-record shape: `%Y%m%d_%H%M%S | <session> | <verb>: <name>`. */
export function parseAuditLine(line) {
  const m = /^(\d{8}_\d{6}) \| ([^|]*) \| (.*)$/.exec(line);
  if (m === null) return null;
  return { timestamp: m[1], sessionId: m[2], message: m[3] };
}

/** A timestamp string must decode to a real local date (guards `%Y%m%d_%H%M%S`). */
export function timestampIsReal(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (m === null) return false;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    && date.getHours() === h && date.getMinutes() === mi && date.getSeconds() === s;
}
