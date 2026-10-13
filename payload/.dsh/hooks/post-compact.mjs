/**
 * post-compact.mjs — DSH port of `.dsh/hooks/post-compact.sh` (PostCompact event).
 *
 * ── WHAT THIS OUTPUT IS FOR (do not "improve" this) ──────────────────────────
 *  THE OUTPUT DOES NOT REACH THE MODEL. The upstream runtime writes PostCompact stdout to
 *  the debug log and discards its systemMessage, and the DSH bridge treats this
 *  event the same way. Recovery after a compaction is SessionStart firing again
 *  with source `compact` (session-start restores the checkpoint); the reminder
 *  below is for the debug log only. Adding a context injection here would not
 *  work and would duplicate what session-start already does.
 *
 * ── PRESERVED SEMANTICS ──────────────────────────────────────────────────────
 *  - `production/session-state/active.md` is checked, and its LINE COUNT is
 *    reported. An unknown count prints `?` rather than a wrong number.
 *  - The file is NOT read into the output: the hook tells the model to read it.
 *  - When the file is missing, point at `production/session-logs/` for the last
 *    session audit.
 *  - `features.session_state: off` makes the whole hook a no-op (default on).
 *
 * ── CONTRACT SUBSTITUTIONS (same as the other ported hooks) ──────────────────
 *  - No subprocess is needed at all here, so `runtime.capture()` (unusable on
 *    Windows: its POSIX `{ ... ; }` wrapper is run by cmd.exe and fails with
 *    `'{' is not recognized ...`) is simply not called.
 *  - `wc -l | tr -d ' '` becomes a line count in Node. `wc -l` counts newline
 *    characters, so a file whose last line has no trailing newline counts one
 *    less; the Node count reproduces that (it counts `\n` bytes, not lines).
 *  - Config is read with the same `node tools/yaml-helper.mjs resolve_config`
 *    helper the other hooks use, because `resolveConfig()` delegates to the dead
 *    capture path. Absent helper or absent key means on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStateEnabled, normaliseInput } from './_session-state.mjs';
import { readInput, projectRoot, run } from './runtime.mjs';

const ACTIVE = join('production', 'session-state', 'active.md');

/** `wc -l`: newline characters, so a final unterminated line is not counted. */
export function countNewlines(content) {
  let count = 0;
  for (let i = 0; i < content.length; i += 1) if (content[i] === '\n') count += 1;
  return count;
}

/** Build the report; exported so the test can assert on it without a subprocess. */
export function buildReport(root) {
  const out = ['=== Context Restored After Compaction ==='];
  const path = join(root, ACTIVE);
  if (existsSync(path)) {
    let size;
    try {
      size = String(countNewlines(readFileSync(path, 'utf8')));
    } catch {
      size = '?';
    }
    out.push(
      `Session state file exists: ${ACTIVE} (${size} lines)`,
      'IMPORTANT: Read this file now to restore your working context.',
      'It contains: current task, decisions made, files in progress, open questions.',
    );
  } else {
    out.push(
      `No session state file found at ${ACTIVE}`,
      'If you were mid-task, check production/session-logs/ for the last session audit.',
    );
  }
  out.push('=========================================');
  return out.join('\n');
}

run(async () => {
  const input = normaliseInput(readInput());
  const root = projectRoot(input);
  if (!sessionStateEnabled(root)) return;
  process.stdout.write(`${buildReport(root)}\n`);
});
