/**
 * notify.mjs — DSH port of `.dsh/hooks/notify.sh` (Notification event).
 *
 * ── DEGRADED, DELIBERATELY ───────────────────────────────────────────────────
 *  The bash original pops a Windows toast by starting
 *  `powershell.exe -NonInteractive -WindowStyle Hidden -Command "…NotifyIcon…"`
 *  in the background. THIS PORT DOES NOT START PowerShell, and the toast is not
 *  shown. That is a degradation, not an oversight:
 *
 *    - `PORTING.md` states the sandbox boundary plainly: Git Bash / WSL cannot
 *      start at all here, and spawning a shell to capture output is denied. The
 *      toast path is exactly that shape — a shelled-out `powershell.exe` — so it
 *      cannot be delivered from a DSH hook, and a silently failing spawn would be
 *      worse than none: the user would see no toast and no explanation.
 *    - The DSH bridge has a native channel for the same intent. `notifyUser()`
 *      emits `{ "systemMessage": … }`, which the protocol honours as a
 *      user-visible notice. `notice()` below uses that as the primary channel and
 *      mirrors the text to stderr for the debug log.
 *
 *  If a real toast is ever required, the right layer is a DSH client feature (a
 *  notification surface), not a hook spawning PowerShell.
 *
 * ── PRESERVED SEMANTICS ──────────────────────────────────────────────────────
 *  - The payload key is `message`, and the parser tolerates whitespace around the
 *    colon. The bash version's fallback required the exact bytes `"message":"`, so
 *    a pretty-printed payload silently degraded to the generic text; that bug is
 *    NOT reproduced here — reading the JSON directly makes both spellings work.
 *  - Empty/absent message → `DSGS needs your attention`.
 *  - TRUNCATE FIRST, THEN HANDLE QUOTING. The bash comment records why: escaping
 *    doubles quotes, so cutting at a fixed byte count afterwards can split a pair
 *    and hand the consumer an unbalanced quote. Truncation is at 200 units (200
 *    bytes in bash; 200 UTF-16 code units here, see the degradation note below)
 *    and only ever cuts between complete units.
 *  - Exit 0 with output; the hook never blocks and never denies.
 *
 * ── CONTRACT SUBSTITUTIONS ───────────────────────────────────────────────────
 *  - `runtime.capture()` is unused (it is dead on Windows anyway: its POSIX
 *    `{ … ; }` wrapper runs under cmd.exe and fails with `'{' is not recognized`).
 *  - Truncation counts UTF-16 code units rather than bytes (`head -c 200`), so a
 *    message of CJK/emoji text is cut slightly later than the bash original.
 */
import { notifyUser } from './runtime.mjs';
import { normaliseInput } from './_session-state.mjs';
import { readInput, run } from './runtime.mjs';

/** Max message length, matching `head -c 200` in the bash original. */
export const MAX_LENGTH = 200;

/** `message` from the payload, or the generic fallback text. */
export function extractMessage(input) {
  const raw = input?.message;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return 'DSGS needs your attention';
}

/** Truncate at a fixed length, never splitting a surrogate pair. */
export function truncate(message, limit = MAX_LENGTH) {
  if (message.length <= limit) return message;
  let cut = message.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  // A lone high surrogate at the boundary would be half of an emoji: drop it.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Deliver the notice: structured `systemMessage` for the user, plus the same text
 * on stderr for the debug log (which is where the bash `echo` ended up anyway).
 */
export function notice(message) {
  notifyUser(`Notification: ${message}`);
  process.stderr.write(`Notification: ${message}\n`);
}

run(async () => {
  // No toast on non-Windows, exactly like the bash original (it only ever spawned
  // PowerShell on Windows; elsewhere the `echo` below was the whole hook).
  notice(truncate(extractMessage(normaliseInput(readInput()))));
});

