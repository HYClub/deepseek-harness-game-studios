#!/usr/bin/env node
/**
 * rotate-session-state.mjs — Node port of `.claude/scripts/rotate-session-state.sh`.
 *
 * move active.md's narrative into the session log, leaving the checkpoint behind.
 *
 * WHY THIS EXISTS
 * active.md is two things at once: a small machine-read CHECKPOINT that hooks
 * inject, and a free-form narrative for humans. Only the first is bounded by the
 * schema. Left alone the second grows without limit -- it reached 712 lines /
 * 44 KB before this script existed -- and every session paid to preview a file
 * that was mostly history the commit log already records.
 *
 * Rotation keeps the checkpoint, appends the narrative to a dated file under
 * production/session-logs/, and starts the Notes section fresh. Nothing is
 * deleted.
 *
 * EXPLICIT INVOCATION ONLY. No hook calls this. session-start.sh observes that
 * the file is large and names this script; the user decides whether to run it.
 * Helpers here emit observations, never verdicts (project instructions) -- and silently
 * moving a user's working notes would be a verdict.
 *
 * Usage:
 *   node .dsh/scripts/rotate-session-state.mjs            # rotate
 *   node .dsh/scripts/rotate-session-state.mjs --dry-run  # show, change nothing
 *   node .dsh/scripts/rotate-session-state.mjs --help
 *
 * PORT NOTES — behaviour that had to be reproduced exactly, not approximated:
 *   - `wc -l` counts NEWLINES, so a state file whose last line has no newline
 *     reports one line less than a reader sees. `TOTAL` and therefore
 *     `NARRATIVE` are computed that way here too (`wcLines`), and the archived
 *     slice is then taken with `head`/`tail` line semantics, which is why the
 *     -1/+1 relationship between them is preserved rather than "fixed".
 *   - The archive is opened in APPEND mode, so two rotations on the same day land
 *     in one file, and it is written before active.md is replaced — the failure
 *     message after a failed temp-file write says so in as many words.
 *   - The temp file is created in the state directory (`.DSGS-rotate-XXXXXX`), so
 *     the replacement stays on one filesystem and is atomic. A system temp dir is
 *     NOT used: where it is missing or unwritable the redirect failed, the `mv`
 *     was skipped, and the script then reported a rotation that had not happened
 *     while the narrative it had already archived was still in active.md.
 *     `writeFileSync(..., { flag: 'wx' })` gives the same "a fresh name or
 *     nothing" guarantee `mktemp` gave.
 *   - ONE deliberate behavioural change: a second run whose narrative is nothing
 *     but this script's own boilerplate does NOT rotate again. The shell original
 *     counted lines only, so it re-rotated its own seven-line header on every
 *     subsequent run and grew the archive with empty sections. See the comment at
 *     the gate for why tightening it cannot mask a real rotation.
 *   - `date +%Y-%m-%d` is the local date, and it comes from the clock exactly
 *     once so a dry run and the real run agree.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isFile, readTextOr, splitLines, wcLines } from './_fsutil.mjs';

/**
 * `sed -n '2,30p' "$0" | sed 's/^# \?//'` — the script's own comment block,
 * lines 2-30, with the `# ` prefix stripped. Kept as one literal so the help text
 * cannot drift from what the shell version printed; the one intentional change is
 * the invocation shown in the Usage lines (`.dsh/scripts/…​.mjs`), which the
 * generator would rewrite in any case.
 */
const HELP = `rotate-session-state.sh — move active.md's narrative into the session log,
leaving the checkpoint behind.

WHY THIS EXISTS
active.md is two things at once: a small machine-read CHECKPOINT that hooks
inject, and a free-form narrative for humans. Only the first is bounded by the
schema. Left alone the second grows without limit -- it reached 712 lines /
44 KB before this script existed -- and every session paid to preview a file
that was mostly history the commit log already records.

Rotation keeps the checkpoint, appends the narrative to a dated file under
production/session-logs/, and starts the Notes section fresh. Nothing is
deleted.

EXPLICIT INVOCATION ONLY. No hook calls this. session-start.sh observes that
the file is large and names this script; the user decides whether to run it.
Helpers here emit observations, never verdicts (project instructions) -- and silently
moving a user's working notes would be a verdict.

Usage:
  node .dsh/scripts/rotate-session-state.mjs            # rotate
  node .dsh/scripts/rotate-session-state.mjs --dry-run  # show, change nothing
  node .dsh/scripts/rotate-session-state.mjs --help
`;

const STATE = 'production/session-state/active.md';
const LOGDIR = 'production/session-logs';
const CHECKPOINT_END = '<!-- /CHECKPOINT -->';

/**
 * The line terminator the file already uses, so a rewrite preserves it — `head`
 * and `tail` copy bytes, and a Windows project's checkpoint should not silently
 * become LF-only. Mixed endings resolve to the first one seen.
 * @param {string} text
 * @returns {string} '\r\n' or '\n'
 */
function dominantEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Write to stdout as UTF-8 regardless of the console code page. */
function out(text) {
  process.stdout.write(text, 'utf8');
}

/** Write to stderr as UTF-8 regardless of the console code page. */
function err(text) {
  process.stderr.write(text, 'utf8');
}

/** `date +%Y-%m-%d` — the local calendar date. */
function localDateStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `head -n N file` — the file's first N lines, each with `eol`.
 * @param {string[]} lines
 * @param {number} count
 * @param {string} eol
 * @returns {string}
 */
function headLines(lines, count, eol) {
  const taken = lines.slice(0, Math.max(0, count));
  if (taken.length === 0) return '';
  return `${taken.join(eol)}${eol}`;
}

/**
 * `tail -n "+N" file` — the file's lines N..end, each with `eol`.
 *
 * POSIX `tail -n +N` prints from line N to the end; because `wc -l` can
 * undercount by one (a final line with no newline), the *caller* passes a start
 * derived from that count rather than from `SPLIT+1`. That difference is
 * intentional and is what keeps the `wc -l`-based arithmetic self-consistent.
 * @param {string[]} lines
 * @param {number} start 1-based line number
 * @param {string} eol
 * @returns {string}
 */
function tailLines(lines, start, eol) {
  const taken = lines.slice(Math.max(0, start - 1));
  if (taken.length === 0) return '';
  return `${taken.join(eol)}${eol}`;
}

/** `mktemp "$(dirname "$STATE")/.DSGS-rotate-XXXXXX"`, as a `wx` create or nothing. */
function createTempBeside(stateDir) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let suffix = '';
    for (let i = 0; i < 6; i += 1) {
      suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const candidate = join(stateDir, `.DSGS-rotate-${suffix}`);
    try {
      const fd = openSync(candidate, 'wx');
      closeSync(fd);
      return candidate;
    } catch {
      // Name taken (or the directory is unwritable): try another, then give up
      // so the caller can report the same failure the shell version reported.
    }
  }
  return '';
}

function main(argv) {
  const root = join(import.meta.dirname, '..', '..');

  let dryRun = false;
  const arg = argv[0] ?? '';
  if (arg === '--help' || arg === '-h') {
    out(HELP);
    return 0;
  }
  if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg !== '') {
    err(`unknown argument: ${arg} (try --help)\n`);
    return 2;
  }

  const statePath = join(root, STATE);

  if (!isFile(statePath)) {
    out(`no session state at ${STATE} — nothing to rotate\n`);
    return 0;
  }

  const content = readTextOr(statePath);

  if (!content.includes(CHECKPOINT_END)) {
    out(`REFUSED: ${STATE} has no <!-- /CHECKPOINT --> marker.\n`);
    out('  Rotation splits the file at that marker, so without it this script\n');
    out('  cannot tell the checkpoint from the narrative and would move both.\n');
    out('  Re-create the file from .dsh/docs/templates/session-state.md first.\n');
    return 3;
  }

  // Everything through the marker is the checkpoint; everything after is
  // narrative. `grep -n '<!-- /CHECKPOINT -->' | head -1 | cut -d: -f1` is the
  // FIRST line that CONTAINS the marker — grep is a substring match, not an
  // anchored one, so a marker indented inside a block still counts.
  const lines = splitLines(content);
  let splitLine = 0;
  let narrativeStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(CHECKPOINT_END)) {
      splitLine = index + 1;
      narrativeStart = splitLine + 1;
      break;
    }
  }
  const total = wcLines(content);
  const narrative = Math.max(0, total - splitLine);

  if (narrative <= 5) {
    out(`narrative is ${narrative} lines — nothing worth rotating\n`);
    return 0;
  }

  // A DELIBERATE DEVIATION from the shell original, in the safe direction.
  //
  // The original's line count is the only gate, and the file it writes back
  // carries seven lines of its own boilerplate after the marker (blank, `---`,
  // `## Notes`, blank, the "rotated to" line, blank). Run twice in a row, the
  // SECOND run therefore sees "7 lines" of narrative — its own header, not the
  // user's notes — and rotates again, appending a second empty section to the
  // archive and rewriting the same file. Repeated runs grow the archive with pure
  // ceremony. This looks exactly like the failure the shell comments describe
  // ("reporting a rotation that did not happen ... got archived again on the next
  // run"), so the gate is tightened: a post-marker region that holds nothing but
  // the rotation's own boilerplate is not worth rotating, and says so with the
  // same wording the line-count gate uses.
  //
  // It cannot mask a real rotation: the template's fresh `## Notes` block always
  // carries its placeholder paragraph, and any user text at all clears this test.
  const boilerplate = new Set(['', '---', '## Notes']);
  const hasUserNarrative = lines
    .slice(narrativeStart - 1)
    .some((line) => !boilerplate.has(line) && !/^_Narrative through .*_$/.test(line));
  if (!hasUserNarrative) {
    out(`narrative is ${narrative} lines — nothing worth rotating\n`);
    return 0;
  }

  // Date comes from the filesystem, not `date`, so a dry run and the real run
  // agree and repeated runs on the same day append to one file.
  const stamp = localDateStamp();
  const archive = `${LOGDIR}/session-state-${stamp}.md`;
  const archivePath = join(root, archive);

  if (dryRun) {
    out('DRY RUN — no changes written\n');
    out(`  checkpoint kept : lines 1-${splitLine}\n`);
    out(`  narrative moved : lines ${splitLine + 1}-${total} (${narrative} lines)\n`);
    out(`  destination     : ${archive}\n`);
    return 0;
  }

  // `mkdir -p` is implicit here: the archive lives under production/session-logs/,
  // which does not exist on a first rotation. The shell original's `mkdir -p` was
  // allowed to fail silently and the archive redirect then created the file, so
  // the directory step has to exist even though its failure surfaces below as the
  // un-writable archive it is.
  const eol = dominantEol(content);
  const header = `${eol}---${eol}${eol}## Rotated from active.md on ${stamp} (${narrative} lines)${eol}${eol}`;
  let tempPath = '';
  try {
    mkdirSync(dirname(archivePath), { recursive: true });
    const existing = isFile(archivePath) ? readFileSync(archivePath, 'utf8') : '';
    writeFileSync(archivePath, existing + header + tailLines(lines, narrativeStart, eol), 'utf8');
  } catch (error) {
    // Let the state file stay untouched and say why. The original could not even
    // reach this branch (its `mkdir -p` failed silently and the archive redirect
    // created the file), so the message names the real cause instead of a
    // rotation that did not happen.
    err(`rotate-session-state: FAILED — cannot write ${archive}: ${error?.message ?? String(error)}\n`);
    err(`  ${STATE} is UNCHANGED.\n`);
    return 1;
  }

  // Write the truncated state beside the file it replaces, not in a system temp
  // dir. `${TMPDIR:-/tmp}` assumes /tmp exists and is writable; where it is not,
  // the redirect failed, `&&` skipped the mv, and the script then printed
  // "rotated N lines" and a line count it had not produced -- reporting a
  // rotation that did not happen, while the narrative it had ALREADY appended to
  // the archive stayed in active.md and got archived again on the next run.
  // mktemp in the state directory needs no external writable location and keeps
  // the mv on one filesystem, so it stays atomic.
  const stateDir = join(root, 'production', 'session-state');
  tempPath = createTempBeside(stateDir);
  if (tempPath === '') {
    err(`rotate-session-state: FAILED — cannot create a temporary file in production/session-state\n`);
    err(`  ${STATE} is UNCHANGED. The narrative was appended to ${archive} and is still\n`);
    err(`  in ${STATE}; remove one copy before rotating again.\n`);
    return 1;
  }

  // `headLines` emits each checkpoint line with its terminator, so the blank line
  // before the `---` comes from the template's own `echo ""`, not from the join.
  // The count matters: the rewritten file must stay under the rotation threshold,
  // or the very next run reports "narrative is N lines" instead of doing nothing.
  const replacement = `${headLines(lines, splitLine, eol)}${eol}---${eol}${eol}## Notes${eol}${eol}`
    + `_Narrative through ${stamp} rotated to \`${archive}\`._${eol}${eol}`;

  try {
    writeFileSync(tempPath, replacement, 'utf8');
  } catch {
    rmSync(tempPath, { force: true });
    err(`rotate-session-state: FAILED — could not write ${tempPath}\n`);
    err(`  ${STATE} is UNCHANGED (the narrative is now in BOTH ${archive} and ${STATE}).\n`);
    return 1;
  }

  try {
    renameSync(tempPath, statePath);
  } catch {
    rmSync(tempPath, { force: true });
    err(`rotate-session-state: FAILED — could not replace ${STATE}\n`);
    return 1;
  }

  out(`rotated ${narrative} lines -> ${archive}\n`);
  out(`${STATE} is now ${wcLines(readTextOr(statePath))} lines\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

