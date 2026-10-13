/**
 * DSH port of `.claude/hooks/log-instructions.sh` — InstructionsLoaded diagnostic.
 *
 * Source lines 1-137. This hook is NOT registered in `.claude/settings.json`
 * ("optional diagnostic"): it is wired up by hand when someone needs to measure
 * WHICH instruction file loaded and WHY. `tools/build-dsh.mjs` only enables hooks
 * that settings.json names, so this port stays dormant too — same as upstream.
 *
 * Preserved:
 *   - no project-root `cd` in the original (it logs whatever cwd it is invoked
 *     with); the port resolves the root with `projectRoot()` and strips it from
 *     the displayed path, which is the same split the bash did with $PWD /
 *     `pwd -W`;
 *   - `pick()` over confirmed key first, alternates behind it, `grep -oE
 *     '"key"\s*:\s*"value"' | head -1` semantics;
 *   - empty stdin -> no log line at all (the original's unbounded-read guard);
 *   - one record per load = a readable line plus a `RAW <payload>` line, both
 *     prefixed with the same `%Y%m%d_%H%M%S` timestamp, appended to
 *     `production/session-logs/instructions-loaded.log`;
 *   - deliberately NOT gated on `features.session_state`;
 *   - exit code ignored, cannot block a load, fail silent.
 *
 * DSH-only difference: InstructionsLoaded is not one of the events
 * `dsh-src/hooks/runtime.mjs` lists, so no structured stdout is emitted at all.
 * The original's exit code is ignored for this event, so emitting nothing is the
 * faithful equivalent.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, readInput, run } from './runtime.mjs';

const LOG_DIR = 'production/session-logs';
const LOG_FILE = 'instructions-loaded.log';

const FILE_KEYS = ['file_path', 'path', 'file', 'source_path', 'instruction_path', 'filePath'];
const REASON_KEYS = ['load_reason', 'reason', 'loadReason', 'matcher', 'trigger', 'source'];
const PARENT_KEYS = ['parent_file_path', 'parentFilePath', 'parent'];

/** `date +%Y%m%d_%H%M%S`, in local time like the shell original. */
function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * `pick <json> <key>...`: the confirmed key first, alternates behind it, so a
 * schema change degrades to a fallback rather than to a blank column. The raw
 * payload is on the next line regardless, which is how `load_reason` was found.
 */
function pick(payload, keys, raw) {
  const record = payload !== null && typeof payload === 'object' ? payload : {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = stringify(record[key]);
      if (value !== '') return value;
    }
    // Textual fallback for a payload whose JSON did not parse (the bash picked
    // straight out of the raw stream in that situation).
    const m = new RegExp(`"${key}"[ \\t]*:[ \\t]*"([^"]*)"`).exec(raw);
    if (m !== null && m[1] !== '') return m[1];
  }
  return '';
}

/**
 * Unescape, normalise to forward slashes and strip the repo prefix, so the
 * column reads `.claude/rules/gameplay-code.md`. Two forms of the root are
 * tried because the payload and the shell disagreed about Windows paths.
 */
function shorten(value, root, rootWindows) {
  if (value === '') return '';
  let out = value.replace(/\\\\/g, '/').replace(/\\/g, '/');
  if (root !== '') {
    const prefix = root.split('\\').join('/');
    if (out.startsWith(`${prefix}/`)) out = out.slice(prefix.length + 1);
  }
  if (rootWindows !== '') {
    const prefix = rootWindows.split('\\').join('/');
    if (out.startsWith(`${prefix}/`)) out = out.slice(prefix.length + 1);
  }
  return out;
}

run(async () => {
  // stdin may be absent; the original refused to start an unbounded read on a tty.
  // A hook payload always arrives on a pipe, so `isTTY` is the honest analogue.
  if (process.stdin.isTTY === true) return;

  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (raw.trim().length === 0) return;

  let payload = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') payload = parsed;
  } catch {
    payload = {};
  }
  if (Object.keys(payload).length === 0) {
    const viaRuntime = readInput();
    if (viaRuntime !== null && typeof viaRuntime === 'object') payload = viaRuntime;
  }

  const root = projectRoot(payload);
  const rootWindows = root.replace(/\//g, '\\');

  const file = shorten(pick(payload, FILE_KEYS, raw), root, rootWindows);
  const reason = pick(payload, REASON_KEYS, raw);
  const parent = shorten(pick(payload, PARENT_KEYS, raw), root, rootWindows);

  const extra = parent === '' ? '' : `  (via ${parent})`;
  const stamp = timestamp();
  const text = `${stamp} | ${(reason === '' ? '?' : reason).padEnd(16)} | `
    + `${file === '' ? '?' : file}${extra}\n`
    + `${stamp}   RAW ${raw.replace(/\r?\n/g, ' ')}\n`;

  try {
    mkdirSync(join(root, LOG_DIR), { recursive: true });
    appendFileSync(join(root, LOG_DIR, LOG_FILE), text, 'utf8');
  } catch {
    // `mkdir -p … || exit 0` / `>> LOG 2>/dev/null`: fail silent, stay cheap.
  }

  // Leave immediately rather than waiting on a stdin that may never close.
  process.exit(0);
});
