/**
 * Session-state feature flag for the ported DSGS hooks — shared internal helper.
 *
 * Source of truth is `session_state_enabled()` in `tools/yaml-helper.mjs`, which
 * ports the `awk` state machine from `yaml-helper.sh`. In that state machine only
 * a `session_state:` key INSIDE a `features:` block counts, `project.local.yaml`
 * wins over `project.yaml`, and "unset anywhere" means ON:
 *
 *     node tools/yaml-helper.mjs __call session_state_enabled   → exit 0 = on, 1 = off
 *
 * We call that predicate rather than re-implementing the regex, so the hooks and
 * the rest of the framework cannot drift apart.
 *
 * `runtime.resolveConfig()` is NOT usable for this. It delegates to
 * `runtime.capture()`, which is dead on Windows: capture() wraps the command in
 * the POSIX form `{ <cmd> ; } > out 2>&1` and runs it with `shell: true`, i.e.
 * through cmd.exe, which rejects the wrapper outright —
 *
 *     '{' is not recognized as an internal or external command
 *
 * measured for every command, so the resolver never returns a value. `runtime.mjs`
 * is a protected file (see `dsh-src/hooks/PORTING.md` §边界), so these hooks call
 * the Node helper directly through `_capture.mjs`, which spawns the program and
 * redirects its output to a temp file through a file descriptor — never a pipe.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './_capture.mjs';

/**
 * Make a hook payload safe to pass to `runtime.projectRoot()`.
 *
 * `runtime.readInput()` returns whatever `JSON.parse` produced, so a stdin payload
 * of literal `null` yields `null` — and `projectRoot(null)` walks `input.cwd` and
 * throws `TypeError: Cannot read properties of null`, which `run()` then swallows
 * into a stderr trace and a silently skipped hook. Non-object payloads (`null`,
 * `[]`, a bare number) carry no `cwd`, so they are normalised to `{}`. The runtime
 * module is a protected file (PORTING.md §边界), so the guard lives here and every
 * ported hook passes its payload through it.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
export function normaliseInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  return input;
}

/**
 * @param {string} root project root (the helper reads project.yaml from cwd)
 * @returns {boolean} true when session state is enabled (the framework default)
 */
export function sessionStateEnabled(root) {
  const helper = join(root, 'tools', 'yaml-helper.mjs');
  // No resolver in the project root. The bash original sourced
  // `.claude/hooks/yaml-helper.sh` under the same guard and then ran the body, so
  // "helper absent" meant "enabled" there too — but silence is not acceptable for a
  // feature gate, so say out loud that the check did not run (PORTING.md: a check
  // that cannot run must be reported, never silently weakened) and keep the default.
  if (!existsSync(helper)) {
    const hook = process.argv[1] === undefined ? 'hook' : process.argv[1].split(/[\\/]/).pop();
    process.stderr.write(
      `${hook}: tools/yaml-helper.mjs not found in the project root — `
      + 'features.session_state NOT checked, treating session state as ON.\n',
    );
    return true;
  }
  const result = runCommand(process.execPath, ['tools/yaml-helper.mjs', '__call', 'session_state_enabled'], {
    cwd: root,
    timeoutMs: 15_000,
  });
  // Exit 1 is the documented "off"; anything else (including a crash) stays ON,
  // which is the bash default in the same situation.
  return result.status !== 1;
}

