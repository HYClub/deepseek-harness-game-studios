/**
 * DSH port of `.dsh/hooks/log-agent.sh` — SubagentStart audit trail.
 *
 * Source lines 1-89. Behaviour preserved:
 *   - project-root precedence (cwd holds project.yaml / .dsh / .dsh -> cwd;
 *     else the hook payload's cwd; else the script's own location);
 *   - the `features.session_state: off` opt-out;
 *   - internal upstream-runtime agents (agent_type === "") are skipped entirely;
 *   - a MISSING agent_type still logs as "unknown" (the bash `// "unknown"`
 *     jq quirk: `//` substitutes null/false but NOT an empty string);
 *   - record format `$TIMESTAMP | $SESSION_ID | Agent invoked: $AGENT_NAME`
 *     appended to `production/session-logs/agent-audit.log`, timestamp
 *     `date +%Y%m%d_%H%M%S`. session-stop.sh greps the fixed string
 *     `" | $SESSION_ID | Agent invoked: "` to tally spawns; do not change it.
 *
 * This hook is observation-only: it must never block a spawn, so the return is
 * always "allow" (no structured output at all) and every failure is swallowed.
 *
 * Substitutions forced by the platform (same as every other ported hook here):
 *   - `runtime.capture()` is unusable on Windows — it wraps commands in POSIX
 *     `{ ... ; }` syntax and runs them through cmd.exe, so every call dies with
 *     `'{' is not recognized ...`, which also makes `runtime.resolveConfig()`
 *     return nothing. `resolveConfig(['features.session_state'])` was measured
 *     returning `{}` even with `session_state: off` in project.yaml, so it alone
 *     would have silently disabled the opt-out. The flag is therefore read
 *     through `_session-state.mjs`, which asks
 *     `node tools/yaml-helper.mjs __call session_state_enabled` (exit 1 = off,
 *     measured) — the same predicate the bash helper used.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStateEnabled } from './_session-state.mjs';
import { projectRoot, readInput, run } from './runtime.mjs';

const LOG_DIR = 'production/session-logs';
const LOG_FILE = 'agent-audit.log';

/** `date +%Y%m%d_%H%M%S`, in local time like the shell original. */
function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * the upstream runtime's internal agents (prompt suggestions, /btw side questions)
 * arrive with `agent_type` set to an empty string. Matched as text, exactly like
 * the original `grep -qE`, so an empty string nested anywhere in a string value
 * is treated the same way. A MISSING agent_type is different and still logs.
 */
function isInternalAgent(raw) {
  return /"agent_type"\s*:\s*""/.test(raw);
}

/**
 * Raw stdin plus its parsed form; both are needed (textual skip + fields).
 * `readInput()` is the contract reader and would do on its own, but the
 * empty-`agent_type` skip is deliberately textual, so the raw bytes are read
 * once and parsed here; `readInput()` stays the fallback.
 */
function readStdin() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let json = {};
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') json = parsed;
    } catch {
      json = {};
    }
  }
  if (Object.keys(json).length === 0) {
    const viaRuntime = readInput();
    if (viaRuntime !== null && typeof viaRuntime === 'object') json = viaRuntime;
  }
  return { raw, json };
}

run(async () => {
  const { raw, json } = readStdin();
  const root = projectRoot(json);
  if (!sessionStateEnabled(root)) return;
  if (isInternalAgent(raw)) return;

  let agentName = json.agent_type;
  if (typeof agentName !== 'string' || agentName.length === 0) agentName = 'unknown';
  let sessionId = json.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) sessionId = 'unknown';

  const line = `${timestamp()} | ${sessionId} | Agent invoked: ${agentName}\n`;
  try {
    mkdirSync(join(root, LOG_DIR), { recursive: true });
    appendFileSync(join(root, LOG_DIR, LOG_FILE), line, 'utf8');
  } catch {
    // Best effort, exactly like the original's `2>/dev/null` on the append.
  }
});
