/**
 * pre-compact.mjs — DSH port of `.claude/hooks/pre-compact.sh` (PreCompact event).
 *
 * ── WHAT THIS OUTPUT IS FOR (do not "improve" this) ──────────────────────────
 *  THE OUTPUT DOES NOT REACH THE MODEL. The upstream runtime writes PreCompact stdout to
 *  the debug log and discards its systemMessage; the DSH bridge behaves the same
 *  way for this event. What actually survives a compaction is the FILE ON DISK:
 *  SessionStart fires again with source `compact`, and session-start restores the
 *  CHECKPOINT then. So this hook deliberately emits the checkpoint BY REFERENCE
 *  (the bounded CHECKPOINT region plus a pointer to active.md), never a dump of
 *  the file, and never a context injection — injecting here would buy nothing and
 *  would be wrong twice over (the `head -n 100` this replaced was 12.7 KB at the
 *  exact moment context is scarcest, and it grew with the file).
 *
 *  The one effect here that LANDS is the compaction-log line. Everything else is
 *  debug-log text and is kept bounded and capped for that reason.
 *
 * ── PRESERVED SEMANTICS ──────────────────────────────────────────────────────
 *  - CHECKPOINT region between the markers, markers stripped; when no markers
 *    exist, fall back to the first 20 lines AND SAY SO (a missing checkpoint is
 *    a real problem to fix, not to absorb silently).
 *  - STATUS region reduced to `Epic:`/`Feature:`/`Task:` lines with a value.
 *  - Files-modified lists are BOUNDED: a count, up to 20 paths, then
 *    `... and N more (run: git status)`. Unbounded, this section emitted 181 KB
 *    (~45k tokens) on a tree with ~5k untracked files.
 *  - WIP design-doc scan is BATCHED and capped at the same 20. One `grep -n` per
 *    document cost ~85 ms each and blew the hook budget at ~90 GDDs; the marker
 *    test is the same pattern set (`TODO|WIP|PLACEHOLDER|[TO BE|[TBD]`) applied
 *    per file instead of per line.
 *  - `features.session_state: off` makes the whole hook a no-op (default on).
 *
 * ── CONTRACT SUBSTITUTIONS (same as the other ported hooks) ──────────────────
 *  - `runtime.capture()` is unusable on Windows (POSIX `{ ... ; }` wrapper run by
 *    cmd.exe: `'{' is not recognized ...`, measured on every command). Git access
 *    goes through `_capture.mjs` instead: direct spawn, stdout/stderr redirected
 *    to a temp file through a file descriptor, never a pipe. `resolveConfig()` is
 *    dead for the same reason, so config is resolved via
 *    `node tools/yaml-helper.mjs resolve_config` with that same helper.
 *  - The `sed`/`grep`/`xargs -0` pipeline becomes Node string work.
 *  - Timestamps use Node's `Date`, which renders like the shell's `date`
 *    (`Thu Jul 17 2026 14:30:05 GMT+0800 (…)` vs `Thu Jul 17 14:30:05 …`); the
 *    compaction log line therefore differs cosmetically from the bash original.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './_capture.mjs';
import { sessionStateEnabled, normaliseInput } from './_session-state.mjs';
import { readInput, projectRoot, run } from './runtime.mjs';

const STATE_FILE = join('production', 'session-state', 'active.md');

/** Output cap for the modified-file lists and the WIP doc list. */
export const CAP = 20;

const WIP_MARKER = /TODO|WIP|PLACEHOLDER|\[TO BE|\[TBD\]/;
const STATUS_LINE = /^(Epic|Feature|Task):[ \t]*\S/;

function normalise(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Lines strictly between `<!-- MARKER -->` and `<!-- /MARKER -->`, markers out. */
export function region(text, marker) {
  const lines = normalise(text).split('\n');
  const open = `<!-- ${marker} -->`;
  const close = `<!-- /${marker} -->`;
  const out = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inside) {
      if (trimmed === open) inside = true;
      continue;
    }
    if (trimmed === close) break;
    out.push(line);
  }
  return out;
}

/** `sed -n '/<!-- STATUS -->/,…/p' | grep -E '^(Epic|Feature|Task):\s*\S'`. */
export function statusBlock(text) {
  return region(text, 'STATUS').filter((line) => STATUS_LINE.test(line.replace(/\r$/, '')));
}

/** The `_pc_list` helper: label, count, capped sample, "and N more". */
export function renderList(label, paths) {
  const list = paths.filter((p) => p.length > 0);
  if (list.length === 0) return [];
  const lines = [`${label} (${list.length}):`];
  for (const file of list.slice(0, CAP)) lines.push(`  - ${file}`);
  if (list.length > CAP) lines.push(`  ... and ${list.length - CAP} more (run: git status)`);
  return lines;
}

function splitPaths(stdout) {
  return normalise(stdout).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Recursive *.md walk — replaces `xargs -0 grep -lE`. */
function markdownFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/** Design docs carrying a WIP marker, relative, `/`-separated, sorted. */
export function wipDocs(root) {
  const dir = join(root, 'design', 'gdd');
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const file of markdownFiles(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (WIP_MARKER.test(text)) hits.push(file.slice(root.length + 1).split('\\').join('/'));
  }
  return hits.sort();
}

/** Build the whole stdout report. Exported so the test can assert on it directly. */
export function buildReport(root, now = new Date()) {
  const out = [];
  out.push('=== SESSION STATE BEFORE COMPACTION ===');
  out.push(`Timestamp: ${now.toString()}`);

  const statePath = join(root, STATE_FILE);
  if (existsSync(statePath)) {
    const text = normalise(readFileSync(statePath, 'utf8'));
    out.push('', `## Active Session State — checkpoint from ${STATE_FILE}`);
    const status = statusBlock(text);
    if (status.length > 0) out.push(...status);
    const checkpoint = region(text, 'CHECKPOINT');
    if (checkpoint.length > 0) {
      out.push(...checkpoint);
    } else {
      out.push(
        '(no CHECKPOINT block — showing the first 20 lines instead;',
        ' re-create this file from .claude/docs/templates/session-state.md)',
      );
      out.push(...text.split('\n').slice(0, 20));
    }
    out.push('', `Full detail (NOT reproduced here — read the file if you need it): ${STATE_FILE}`);
  } else {
    out.push(
      '',
      '## No active session state file found',
      'Consider maintaining production/session-state/active.md for better recovery.',
      'Template: .claude/docs/templates/session-state.md',
    );
  }

  out.push('', '## Files Modified (git working tree)');
  const changed = git(['diff', '--name-only'], { cwd: root });
  const staged = git(['diff', '--staged', '--name-only'], { cwd: root });
  const untracked = git(['ls-files', '--others', '--exclude-standard'], { cwd: root });
  const changedList = changed.status === 0 ? splitPaths(changed.stdout) : [];
  const stagedList = staged.status === 0 ? splitPaths(staged.stdout) : [];
  const untrackedList = untracked.status === 0 ? splitPaths(untracked.stdout) : [];
  out.push(...renderList('Unstaged changes', changedList));
  out.push(...renderList('Staged changes', stagedList));
  out.push(...renderList('New untracked files', untrackedList));
  if (changedList.length + stagedList.length + untrackedList.length === 0) {
    out.push('  (no uncommitted changes)');
  }

  out.push('', '## Design Docs — Work In Progress');
  const wip = wipDocs(root);
  if (wip.length > 0) {
    out.push(`${wip.length} design doc(s) contain TODO/WIP/PLACEHOLDER markers:`);
    for (const file of wip.slice(0, CAP)) out.push(`  - ${file}`);
    if (wip.length > CAP) out.push(`  ... and ${wip.length - CAP} more`);
  } else {
    out.push('  (no WIP markers found in design docs)');
  }

  try {
    mkdirSync(join(root, 'production', 'session-logs'), { recursive: true });
    appendFileSync(join(root, 'production', 'session-logs', 'compaction-log.txt'), `Context compaction occurred at ${now.toString()}.\n`, 'utf8');
  } catch {
    /* the log is best-effort; the report above still goes to the debug log */
  }

  out.push(
    '',
    '## Recovery Instructions',
    `After compaction, read ${STATE_FILE} to recover full working context.`,
    'Then read any files listed above that are being actively worked on.',
    '=== END SESSION STATE ===',
  );
  return out.join('\n');
}

run(async () => {
  const input = normaliseInput(readInput());
  const root = projectRoot(input);
  if (!sessionStateEnabled(root)) return;
  process.stdout.write(`${buildReport(root)}\n`);
});
