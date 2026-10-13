/**
 * session-stop.mjs — DSH port of `.claude/hooks/session-stop.sh` (Stop event).
 *
 * Logs what the session did, so the audit trail and the sprint report survive:
 *
 *   production/session-logs/session-log.md    archived active.md + git activity
 *   production/session-logs/.active-state.hash dedup marker for the archive
 *   production/session-logs/.session-end.hash  dedup marker for git activity
 *   production/session-logs/session-cost.md    subagent spawn tally for this session
 *
 * ── PRESERVED SEMANTICS (see PORTING.md §"移植行为准则") ──────────────────────
 *  - Stop fires once per RESPONSE, not once per session, so both blocks are
 *    appended ONLY WHEN THE CONTENT CHANGED. The bash original appended
 *    unconditionally and reached 3,187 firings → 665 copies → a 17.5 MB log.
 *    Content hash, not mtime. A hash that cannot be computed archives ANYWAY:
 *    for an audit trail a duplicate entry beats a lost one.
 *  - `active.md` is ARCHIVED, never deleted. It is the session checkpoint and
 *    must survive a clean exit.
 *  - The git-activity block hashes the CONTENT, never the rendered block, because
 *    the block carries a timestamp that differs on every firing.
 *  - Subagent tally reads stdin LAST (a Stop hook is piped JSON; if stdin were
 *    absent an early read would block until the hook timeout and the archive
 *    above would be lost), and reports nothing when there is no session id —
 *    rather than a total silently spanning every session in the audit log.
 *  - `features.session_state: off` makes the whole hook a no-op (default on).
 *
 * ── CONTRACT SUBSTITUTION (reported, not hidden) ─────────────────────────────
 *  1. `runtime.capture()` is unusable on Windows: it wraps commands in POSIX
 *     `{ ... ; }` syntax and runs them through cmd.exe, so EVERY call fails with
 *     `'{' is not recognized ...`. It is used nowhere in this file or its peers.
 *     `_capture.mjs` spawns programs directly with stdout/stderr redirected
 *     through a file descriptor to a temp file — never a pipe, which the sandbox
 *     denies. See `_capture.mjs` for the measurements.
 *  2. `resolveConfig()` inside `runtime.mjs` is therefore also dead (it delegates
 *     to that same capture), and `runtime.mjs` is a protected file. Config is
 *     resolved here by running `node tools/yaml-helper.mjs resolve_config` with
 *     the same fd-redirect helper and reading the same `key: value` lines. When
 *     `tools/yaml-helper.mjs` is absent (or the key is absent) the default is
 *     `on`, exactly as the bash `session_state_enabled()` did.
 *  3. `git hash-object` cannot be fed through the `capture()` shape at all on
 *     Windows (no stdin through it), so content hashes are computed by asking git
 *     first and falling back to the identical Node SHA-1 blob hash for the
 *     `--stdin` case. A hash that cannot be computed still archives, per above.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { git } from './_capture.mjs';
import { sessionStateEnabled, normaliseInput } from './_session-state.mjs';
import { readInput, projectRoot, run } from './runtime.mjs';

const SESSION_LOG_DIR = join('production', 'session-logs');
const STATE_FILE = join('production', 'session-state', 'active.md');
const SESSION_LOG = join(SESSION_LOG_DIR, 'session-log.md');
const AGENT_AUDIT_LOG = join(SESSION_LOG_DIR, 'agent-audit.log');
const SESSION_COST = join(SESSION_LOG_DIR, 'session-cost.md');

/** `date +%Y%m%d_%H%M%S` — local time, zero-padded. */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function joinLines(lines) {
  return lines.join(EOL);
}

function readTextOrNull(file) {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read a dedup marker, trimmed. `git hash-object` output ends in a newline. */
function readMarker(file) {
  const raw = readTextOrNull(file);
  return raw === null ? '' : raw.trim();
}

function writeMarker(file, value) {
  try {
    writeFileSync(file, `${value}\n`, 'utf8');
  } catch {
    /* a marker we cannot write only costs a duplicate archive entry */
  }
}

/** git's blob hash: sha1("blob <bytelen>\0" + content). */
export function gitBlobHash(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return createHash('sha1')
    .update(Buffer.from(`blob ${body.length}\0`, 'utf8'))
    .update(body)
    .digest('hex');
}

/** `git hash-object -- <file>`; '' when git cannot answer (the bash fallback). */
function hashFile(root, file) {
  const result = git(['hash-object', '--', file], { cwd: root });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** `git hash-object --stdin` for the git-activity block, computed in Node. */
function hashContent(content) {
  return gitBlobHash(content);
}

/**
 * Tally subagent spawns for THIS session out of agent-audit.log.
 * `log-agent.sh` writes `… | <session_id> | Agent invoked: <agent>` lines.
 */
export function tallySpawns(auditText, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || ['unknown', 'null'].includes(sessionId)) {
    return null;
  }
  const needle = ` | ${sessionId} | Agent invoked: `;
  const counts = new Map();
  let total = 0;
  for (const line of auditText.split('\n')) {
    const at = line.indexOf(needle);
    if (at === -1) continue;
    const agent = line.slice(at + needle.length).trim();
    if (agent.length === 0) continue;
    total += 1;
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
  }
  if (total === 0) return null;
  const breakdown = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { total, breakdown };
}

/** Render `session-cost.md`; mirrors the bash heredoc byte for byte. */
export function renderSessionCost(sessionId, timestamp, tally) {
  const lines = [
    '# Session Subagent Cost',
    '',
    `**Session:** \`${sessionId}\`  `,
    `**Updated:** ${timestamp}`,
    '',
    `Subagent spawns this session: **${tally.total}**`,
    '',
    '| Agent | Spawns |',
    '|-------|--------|',
  ];
  for (const [agent, count] of tally.breakdown) lines.push(`| ${agent} | ${count} |`);
  lines.push(
    '',
    'Each spawn is a fresh context window that re-reads its own inputs.',
    'To reduce this: lower `modes.review_mode` (`/settings modes.review_mode=solo`)',
    'or `modes.rigor` (`/settings modes.rigor=minimal`).',
  );
  return joinLines(lines);
}

/** Append the active.md archive block when its content hash changed. */
export function archiveSessionState(root, timestamp) {
  const statePath = join(root, STATE_FILE);
  if (!existsSync(statePath)) return false;
  const markerPath = join(root, SESSION_LOG_DIR, '.active-state.hash');
  const hash = hashFile(root, STATE_FILE);
  if (hash.length > 0 && hash === readMarker(markerPath)) return false;
  const content = readFileSync(statePath, 'utf8').replace(/\r\n/g, '\n');
  const block = joinLines([`## Archived Session State: ${timestamp}`, ...content.split('\n'), '---', '']);
  appendLog(root, block);
  if (hash.length > 0) writeMarker(markerPath, hash);
  return true;
}

/** Append the git-activity block when the hashed content changed. */
export function archiveSessionEnd(root, timestamp, recentCommits, modifiedFiles) {
  if (recentCommits.length === 0 && modifiedFiles.length === 0) return false;
  const markerPath = join(root, SESSION_LOG_DIR, '.session-end.hash');
  const hash = hashContent(`${recentCommits}\n---\n${modifiedFiles}`);
  if (hash === readMarker(markerPath)) return false;
  const lines = [`## Session End: ${timestamp}`];
  if (recentCommits.length > 0) lines.push('### Commits', recentCommits);
  if (modifiedFiles.length > 0) lines.push('### Uncommitted Changes', modifiedFiles);
  lines.push('---', '');
  appendLog(root, joinLines(lines));
  writeMarker(markerPath, hash);
  return true;
}

function appendLog(root, block) {
  try {
    const file = join(root, SESSION_LOG);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}${EOL}`;
    writeFileSync(file, `${prefix}${block}${EOL}`, 'utf8');
  } catch {
    /* session-logs/ unwritable: the hook still allows the stop */
  }
}

run(async () => {
  const input = normaliseInput(readInput());
  const root = projectRoot(input);

  if (!sessionStateEnabled(root)) return;

  const timestamp = stamp();
  try {
    mkdirSync(join(root, SESSION_LOG_DIR), { recursive: true });
  } catch {
    /* keep going; each write below degrades on its own */
  }

  // The session-state archive runs BEFORE stdin is touched (see the header).
  archiveSessionState(root, timestamp);

  const commits = git(['log', '--oneline', '--since=8 hours ago'], { cwd: root });
  const changed = git(['diff', '--name-only'], { cwd: root });
  const recentCommits = commits.status === 0 ? commits.stdout.trim() : '';
  const modifiedFiles = changed.status === 0 ? changed.stdout.trim() : '';

  archiveSessionEnd(root, timestamp, recentCommits, modifiedFiles);

  // --- Subagent spawn tally (cost visibility) ---
  const auditPath = join(root, AGENT_AUDIT_LOG);
  if (existsSync(auditPath)) {
    let auditText = '';
    try {
      auditText = readFileSync(auditPath, 'utf8');
    } catch {
      return;
    }
    const sessionId = typeof input.session_id === 'string' || typeof input.session_id === 'number'
      ? String(input.session_id)
      : '';
    const tally = tallySpawns(auditText, sessionId);
    if (tally !== null) {
      try {
        writeFileSync(join(root, SESSION_COST), `${renderSessionCost(sessionId, timestamp, tally)}${EOL}`, 'utf8');
      } catch {
        /* cost report is best-effort */
      }
      process.stderr.write(
        `Subagent spawns this session: ${tally.total} (see production/session-logs/session-cost.md)\n`,
      );
    }
  }
});
