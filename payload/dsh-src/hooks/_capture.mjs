/**
 * Windows-safe command runner for the ported DSGS hooks — shared internal helper.
 *
 * WHY THIS EXISTS (read before "fixing" the hooks to call runtime.capture()):
 *
 *   `runtime.capture()` wraps a command line in POSIX shell syntax —
 *   `{ <cmd> ; } > out 2>&1` — and runs it with `spawnSync(..., { shell: true })`.
 *   On Windows `shell: true` means **cmd.exe**, which does not understand `{ ... ; }`.
 *   Every invocation therefore dies with:
 *
 *       '{' is not recognized as an internal or external command
 *
 *   before the real command runs. Measured in this repository on Windows/Node 24:
 *   `capture('git --version')` → `{ status: 1, stdout: "'{' is not recognized ..." }`
 *   for every command, including the `resolve_config` call the runtime makes on
 *   behalf of `resolveConfig()`. The wrapper only works where `/bin/sh` can parse
 *   it — i.e. on Linux/macOS, and on Windows under Git Bash/WSL, both of which the
 *   DSH sandbox refuses to start (`couldn't create signal pipe, Win32 error 5`).
 *
 *   So on the target platform the runtime helper is a no-op that silently reports
 *   failure, and `resolveConfig()` can never return values. These hooks call
 *   `runCommand()` below instead, and report the substitution in each hook header.
 *
 * WHAT IT DOES INSTEAD: spawns the program directly (PATH-resolved) and redirects
 * stdout+stderr into a private temp file through a file descriptor, so nothing
 * ever travels over a pipe. That is the sandbox-safe shape documented in
 * `dsh-src/hooks/PORTING.md`: pipes are denied (`spawnSync git EPERM`), inherited
 * file descriptors are not. Verified on Windows: `git --version`,
 * `git rev-parse`, `git log`, `git hash-object` all work this way.
 *
 * Returns the same shape as `runtime.capture()`: `{ status, stdout }`, where
 * `stdout` is the combined output, trimmed, with CRLF normalised to LF.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True when this process is running on Windows. */
export const IS_WINDOWS = process.platform === 'win32';

/** Wrap one command-line token for cmd.exe when it needs quoting. */
function quoteToken(token) {
  if (token.length > 0 && !/[\s"&|<>^%]/.test(token)) return token;
  return `"${token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Build a display/fallback command line that a POSIX shell or cmd.exe can both run. */
function toCommandLine(file, args) {
  return [file, ...args].map(quoteToken).join(' ');
}

/**
 * Run a program with its output redirected to a temp file (never a pipe).
 * @param {string} file executable name or path
 * @param {string[]} args arguments
 * @param {{cwd?: string, timeoutMs?: number}} [options]
 * @returns {{ status: number, stdout: string }} combined output, trimmed
 */
export function runCommand(file, args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeoutMs ?? 20_000;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-'));
  const outFile = join(dir, 'out.txt');
  let fd = -1;
  try {
    fd = openSync(outFile, 'w');
    const result = spawnSync(file, args, {
      cwd,
      stdio: ['ignore', fd, fd],
      timeout,
      windowsHide: true,
    });
    closeSync(fd);
    fd = -1;
    const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (result.error !== undefined && result.error !== null) {
      const failure = `spawn failed: ${result.error.code ?? result.error.message ?? String(result.error)}`;
      // ENOENT means the executable itself is missing; anything else is a real error.
      const status = result.error.code === 'ENOENT' ? 127 : 1;
      return { status, stdout: stdout.trim().length > 0 ? normalise(stdout) : failure };
    }
    return { status: result.status ?? 1, stdout: normalise(stdout) };
  } catch (error) {
    return { status: 1, stdout: `spawn failed: ${error?.message ?? String(error)}` };
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a `git` subcommand in `cwd`. Same shape as `runtime.capture()`. */
export function git(args, options = {}) {
  return runCommand(options.git ?? 'git', args, options);
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

export { toCommandLine };

