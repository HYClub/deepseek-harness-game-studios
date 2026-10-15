#!/usr/bin/env node
/**
 * review-receipts.mjs — Node port of `.dsh/scripts/review-receipts.sh`.
 *
 * WHY THIS IS A PORT AND NOT A REWRITE
 *   The bash original is the review skills' change detector: `/design-review`,
 *   `/architecture-review` and `/review-all-gdds` run it and parse its stdout,
 *   so the TEXT is the contract. Every mode, message, exit code and ordering rule
 *   below is copied from the shell source; the comments that explain WHY each
 *   rule exists are kept next to the rule they explain.
 *
 * WHAT CHANGED, AND WHY IT IS SAFE
 *   - `git` is invoked directly through `runCommand()` (no shell, no pipe): the
 *     DSH sandbox denies piped child stdio and cannot start Git Bash at all.
 *     `git hash-object` is still the preferred hasher for whole files, so stamps
 *     written here and stamps written by the shell original stay byte-identical.
 *   - The POSIX `hash_file` fallback chain (`sha1sum`, then `shasum -a 1`) is
 *     replaced by Node's own SHA-1 over the file's bytes. That is exactly what
 *     `sha1sum < file` produced, so it is not a weakening: it removes the
 *     "no hash tool" branch that made every path read CHANGED. Reaching it is
 *     still reported on stderr, in the original's words.
 *   - Section hashing no longer needs an executable at all. `section_hash` piped
 *     the section through `git hash-object --stdin`, and `runCommand()` has no
 *     stdin channel (pipes are denied here; only inherited file descriptors
 *     work), so the git blob hash is computed directly:
 *     `sha1("blob " + byteLength + "\0" + bytes)`. That IS git's blob format, and
 *     returns the empty-input SHA-1 (`da39a3ee…`) for an empty section — which is
 *     what `printf '' | git hash-object --stdin` returns. The test suite pins
 *     this equality against real `git hash-object`. Consequence: the
 *     `NO-HASH-TOOL` placeholder is now defensive only (Node's sha1 cannot
 *     fail), and the "no hash tool" warning can only come from whole-file
 *     hashing, where a readable file still always wins.
 *   - `grep -F`, `tail -1`, `awk '{print $NF}'`, `sed 's|\\|/|g'`, `sort -u` and
 *     the `awk` section scanner are reimplemented with the same field and line
 *     semantics. The awk scanner is quoted in full at `sectionSpans()` because
 *     its `#N` duplicate-heading suffix is what makes stored and current section
 *     keys agree.
 *
 * THE ORIGINAL'S HEADER, KEPT AS THE SPECIFICATION:
 *
 * review-receipts.sh — content-hash change detection for review skills.
 *
 * WHY HASHES, NOT GIT OR MTIME
 * A review baseline must not depend on the user's commit habits. `git diff`
 * needs a committed baseline; `git status` catches uncommitted edits but only
 * relative to git's own view; file mtimes lie under backup restores and cloud
 * sync (an old-mtime restore with new content silently escapes review — a
 * false NEGATIVE, the dangerous direction). Hashing the bytes has neither
 * problem: content changed <=> hash changed. The residual failure directions
 * are false POSITIVES (re-review something unchanged — wasted tokens, never a
 * missed review): a hash tool changing between stamp and check, a receipt
 * file that was never written, or no hash tool at all (git, sha1sum, shasum),
 * which makes everything read CHANGED and says so on stderr.
 *
 * ONE EXCEPTION, and it is deliberate. `check` stays silent on an absent
 * LITERAL path, because a caller may name an optional input on every run
 * (/design-review does exactly this with the entity registry) and reporting it
 * would block a legitimate skip. That silence is a false negative only if a
 * caller passes a literal path it believes must exist — so callers name
 * optional inputs and nothing else.
 *
 * An unexpanded GLOB is the case the same code path can swallow, and is NOT
 * covered by the above: it means a whole document class was
 * requested and none examined, which a caller could not distinguish from
 * "nothing to do". It is now reported as UNRESOLVED.
 *
 * Observation-only per the load-bearing convention in the project instructions: this script
 * emits facts (UNCHANGED / CHANGED / NEW / RECEIPT: NONE), never verdicts.
 *
 * Usage:
 *   node .dsh/scripts/review-receipts.mjs hash <file> [<file>...]
 *   node .dsh/scripts/review-receipts.mjs check <receipt-file> <file> [<file>...]
 *   node .dsh/scripts/review-receipts.mjs sections-hash <file>
 *   node .dsh/scripts/review-receipts.mjs sections-check <receipt-file> <file>
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { runCommand } from '../hooks/_capture.mjs';
import { normPath, readTextOr, splitLines } from './_fsutil.mjs';

/** Printed at most once per run, on stderr: with no hash tool nothing can be verified unchanged. */
const NO_HASH_WARNING =
  'review-receipts: no hash tool (git, sha1sum or shasum) -- nothing can read UNCHANGED';

const USAGE = 'Usage: review-receipts.sh hash <file>... | check <receipt-file> <file>... '
  + '| sections-hash <file> | sections-check <receipt-file> <file>';

let warnedNoHash = false;

function warnNoHash() {
  if (warnedNoHash) return;
  process.stderr.write(`${NO_HASH_WARNING}\n`);
  warnedNoHash = true;
}

/** `[ -f "$1" ]` — a directory must never be hashed or read as a receipt. */
function fileExists(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `command -v git` — the original re-checked this per file. Probed once here
 * because a missing git is a property of the machine, not of the file. The probe
 * is the same one the POSIX chain used to qualify its tool (`git hash-object`
 * succeeding); when it fails, the fallback is Node's own SHA-1 instead of a
 * second executable.
 */
let gitProbe;
function gitAvailable() {
  if (gitProbe === undefined) {
    const result = runCommand('git', ['--version'], { timeoutMs: 10_000 });
    gitProbe = result.status === 0 && result.stdout.length > 0;
  }
  return gitProbe;
}

/**
 * The POSIX `sha1_stdin` fallback (`sha1sum < file`, or `shasum -a 1 < file`),
 * reproduced with Node's crypto over the same bytes. `sha1sum` prints
 * `"<hex>  -"` for stdin; every caller already took the first field, so the bare
 * hex digest is returned.
 * @param {string} text
 * @returns {string}
 */
function sha1OfText(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * `git hash-object --stdin`, computed without a subprocess.
 *
 * git hashes `"blob " + <byte length> + "\0" + <content>`; the length is BYTES,
 * not characters, so a section containing non-ASCII text must be hashed over its
 * UTF-8 encoding — which is what `update(text, 'utf8')` does.
 * @param {string} text
 * @returns {string} 40-character hex SHA-1
 */
function gitBlobHash(text) {
  const header = Buffer.from(`blob ${Buffer.byteLength(text, 'utf8')}\0`, 'utf8');
  return createHash('sha1').update(header).update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * `hash_file <file>` — `git hash-object -- <file>` when git runs, else the SHA-1
 * of the file's bytes. The git blob hash and the raw SHA-1 differ for the same
 * content (git prepends that header), which is why a stamp made with one tool and
 * checked with the other reads CHANGED — a false positive, the safe direction,
 * exactly as the original documents.
 * @param {string} file
 * @returns {string} hex hash, or '' when the file could not be read
 */
function hashFile(file) {
  if (gitAvailable()) {
    const result = runCommand('git', ['hash-object', '--', file], { timeoutMs: 20_000 });
    if (result.status === 0 && result.stdout.length > 0) return result.stdout;
  }
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * An argument that does not name a file is one of two very different things, and
 * `check` must NOT treat them alike:
 *
 *   a literal path that is absent   -> an optional input the caller named on
 *                                      purpose. /design-review passes
 *                                      design/registry/entities.yaml on every
 *                                      run and documents that an absent
 *                                      registry "doesn't appear in the output
 *                                      and doesn't block the skip". Reporting
 *                                      it would break that skip and force a
 *                                      full re-review (~46k tokens, measured)
 *                                      on every project without a registry.
 *                                      Staying silent here is DELIBERATE.
 *
 *   a pattern the shell never       -> the caller asked for a whole class of
 *   expanded                           documents and got none. bash passes an
 *                                      unmatched glob through verbatim, so the
 *                                      wildcard surviving into argv IS the
 *                                      evidence that nothing matched.
 *
 * Only the second is a coverage hole, and only the second is reported. The
 * discriminator is exact: a real filename cannot reach this script still
 * carrying an unexpanded wildcard, so this cannot fire on the registry case.
 *
 * NOTE the same argv shape reaches this port differently: the DSH caller writes
 * `node .dsh/scripts/review-receipts.mjs check <receipt> design/gdd/*.md`, and
 * the shell that runs it (pwsh on Windows) does not glob, so the literal
 * wildcard arrives here unexpanded and is reported UNRESOLVED — the same
 * conclusion the bash version reached when nothing matched.
 * @param {string} arg
 * @returns {boolean}
 */
function isUnexpandedGlob(arg) {
  return arg.includes('*') || arg.includes('?') || arg.includes('[');
}

/**
 * Emit `{ start, end, heading }` per `^## ` section of a file. Content before
 * the first `^##` (if any) is a `__preamble__` span; a file with no `^##` at all
 * is one `__preamble__` span. Duplicate headings get `" #N"` so keys stay
 * unique — the SAME function runs on stamp and check side, so suffixes always
 * agree.
 *
 * The shell original, kept verbatim because its line-number arithmetic is the
 * specification:
 *
 *   BEGIN { pre = 1 }
 *   /^## / {
 *     if (pre && NR > 1) print 1 "\t" NR-1 "\t__preamble__"
 *     pre = 0
 *     if (s) print s "\t" NR-1 "\t" h
 *     s = NR
 *     h = substr($0, 4)
 *     if (seen[h]++) h = h " #" seen[h]
 *   }
 *   END {
 *     if (pre && NR > 0) print 1 "\t" NR "\t__preamble__"
 *     if (s) print s "\t" NR "\t" h
 *   }
 *
 * `NR` counts the final line even when it carries no newline, while `wc -l` does
 * not — `splitLines()` reproduces the former, `wcLines()` the latter.
 * @param {string} text file content
 * @returns {Array<{start: number, end: number, heading: string}>}
 */
function sectionSpans(text) {
  // awk's `$0` for a CRLF line is the line content with its trailing `\r` still
  // attached; `^## ` still matches, and `substr($0, 4)` leaves a `\r` on the end
  // of the heading. Headings are compared against receipt keys, so the `\r` is
  // stripped here — a receipt key can never contain one. The BYTES fed to the
  // hash are a separate concern and keep their `\r`: see `sectionHash()`.
  const lines = splitLines(text).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const total = lines.length;
  const spans = [];
  const seen = new Map();
  let preamble = true;
  let start = 0;
  let heading = '';
  lines.forEach((line, index) => {
    const number = index + 1;
    if (!line.startsWith('## ')) return;
    if (preamble && number > 1) spans.push({ start: 1, end: number - 1, heading: '__preamble__' });
    preamble = false;
    if (start !== 0) spans.push({ start, end: number - 1, heading });
    start = number;
    heading = line.slice(3);
    const count = seen.get(heading) ?? 0;
    seen.set(heading, count + 1);
    if (count > 0) heading = `${heading} #${count + 1}`;
  });
  if (preamble && total > 0) spans.push({ start: 1, end: total, heading: '__preamble__' });
  if (start !== 0) spans.push({ start, end: total, heading });
  return spans;
}

/**
 * `section_hash <file> <start> <end>` — the hash of that line range exactly as
 * `sed -n "$2,$3p" "$1" | git hash-object --stdin` would compute it (see
 * `gitBlobHash`). Never empty: an unhashable section must be visible in the
 * receipt rather than silently equal to the next unhashable one — and
 * sections-check never reads `NO-HASH-TOOL` as UNCHANGED, since it matches every
 * section.
 * @param {string} text file content
 * @param {number} start 1-based first line
 * @param {number} end 1-based last line
 * @returns {string}
 */
/**
 * The raw bytes of lines `start`..`end` inclusive, terminators included — what
 * `sed -n "$2,$3p"` writes. A CRLF file keeps its CRLF (the shell original never
 * normalised it either), an empty range yields `printf ''`, and a final line
 * without a newline is emitted as-is, which is what `sed` does.
 * @param {string} text
 * @param {number} start 1-based
 * @param {number} end 1-based inclusive
 * @returns {string}
 */
function rawLineRange(text, start, end) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  if (start > starts.length) return '';
  const first = starts[start - 1];
  const lastIndex = Math.min(end, starts.length) - 1;
  const last = starts[lastIndex];
  const next = starts[lastIndex + 1];
  return next === undefined ? text.slice(first) : text.slice(first, next);
}

function sectionHash(text, start, end) {
  // `sed -n "$2,$3p"` emits the RAW bytes of those lines, terminators included:
  // a CRLF file hashes with its CRLF, and an empty range yields `printf ''`. The
  // line numbers come from awk's `NR`, which counts `\n` and also counts a final
  // line that has no newline.
  try {
    return gitBlobHash(rawLineRange(text, start, end));
  } catch {
    // Unreachable in practice — Node's sha1 has no way to fail — but the
    // placeholder is kept because every downstream comparison treats an empty
    // hash as "unchanged", which is the false-NEGATIVE direction this script
    // exists to avoid. If hashing ever did fail, the section must read CHANGED.
    return 'NO-HASH-TOOL';
  }
}

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */

function modeHash(files) {
  if (files.length < 1) {
    process.stderr.write('review-receipts: hash mode needs at least one file\n');
    return 2;
  }
  let rc = 0;
  for (const file of files) {
    if (!fileExists(file)) {
      process.stderr.write(`review-receipts: no such file: ${file}\n`);
      rc = 2;
      continue;
    }
    const hash = hashFile(file);
    if (hash === '') {
      process.stderr.write(`review-receipts: could not hash: ${file}\n`);
      rc = 2;
      continue;
    }
    process.stdout.write(`Reviewed-Content-Hash: ${normPath(file)} ${hash}\n`);
  }
  return rc;
}

/**
 * The LATEST stamp for a path wins: receipt files are append-only logs, so the
 * last occurrence of a path is the most recent review of it. `grep -F` on the
 * literal path avoids regex surprises from dots and dashes in filenames.
 * @param {string} receiptText
 * @param {string} path normalised path
 * @returns {string} the last field of the last matching line, or ''
 */
function latestStampFor(receiptText, path) {
  const prefix = `Reviewed-Content-Hash: ${path} `;
  let found = '';
  for (const line of splitLines(receiptText)) {
    if (!line.startsWith(prefix)) continue;
    found = line;
  }
  if (found === '') return '';
  // awk '{print $NF}' — the last whitespace-separated field of the last match.
  const fields = found.trim().split(/\s+/);
  return fields[fields.length - 1] ?? '';
}

function modeCheck(receipt, files) {
  if (files.length < 1) {
    process.stderr.write('review-receipts: check mode needs a receipt file and at least one file\n');
    return 2;
  }
  const receiptText = receipt === '' ? '' : readTextOr(receipt);

  // `[ ! -s "$receipt" ]` — missing AND empty receipts both read NONE, and then
  // every file is NEW (nothing to compare).
  if (receiptText.length === 0) {
    process.stdout.write('RECEIPT: NONE\n');
    for (const file of files) {
      if (!fileExists(file)) {
        if (isUnexpandedGlob(file)) process.stdout.write(`UNRESOLVED: ${normPath(file)}\n`);
        continue;
      }
      process.stdout.write(`NEW: ${normPath(file)}\n`);
    }
    return 0;
  }

  process.stdout.write(`RECEIPT: ${normPath(receipt)}\n`);
  for (const file of files) {
    if (!fileExists(file)) {
      if (isUnexpandedGlob(file)) process.stdout.write(`UNRESOLVED: ${normPath(file)}\n`);
      continue;
    }
    const path = normPath(file);
    const stored = latestStampFor(receiptText, path);
    if (stored === '') {
      process.stdout.write(`NEW: ${path}\n`);
      continue;
    }
    const current = hashFile(file);
    if (current === '') warnNoHash();
    if (current === stored) process.stdout.write(`UNCHANGED: ${path}\n`);
    else process.stdout.write(`CHANGED: ${path}\n`);
  }
  return 0;
}

function modeSectionsHash(file) {
  if (!fileExists(file)) {
    process.stderr.write('review-receipts: sections-hash needs an existing file\n');
    return 2;
  }
  const text = readTextOr(file);
  const path = normPath(file);
  for (const { start, end, heading } of sectionSpans(text)) {
    if (heading === '') continue;
    const hash = sectionHash(text, start, end);
    if (hash === 'NO-HASH-TOOL') warnNoHash();
    process.stdout.write(`Reviewed-Section-Hash: ${path}#${heading} ${hash}\n`);
  }
  return 0;
}

function modeSectionsCheck(receipt, file) {
  if (!fileExists(file)) {
    process.stderr.write('review-receipts: sections-check needs a receipt file and an existing file\n');
    return 2;
  }
  const path = normPath(file);
  const text = readTextOr(file);

  // Latest stamp per section key for this path (append-only log: last wins).
  //
  // The shell original accumulated these in a TAB-delimited string rather than
  // `declare -A`, because macOS ships bash 3.2: there `declare -A` fails but
  // execution CONTINUES, a string subscript is then evaluated as ARITHMETIC, and
  // every heading collapses to index 0 — so every verdict came out garbage with
  // nothing reported. A Map has neither problem; the tab-delimited round trip is
  // not reproduced because it was only ever a workaround for bash 3.
  const stored = new Map();
  const receiptText = receipt === '' ? '' : readTextOr(receipt);
  if (receiptText.length > 0) {
    const prefix = `Reviewed-Section-Hash: ${path}#`;
    for (const line of splitLines(receiptText)) {
      if (!line.startsWith(prefix)) continue;
      // `rest="${line#prefix}"; key="${rest% *}"` — split on the LAST space,
      // because a heading may itself contain spaces.
      const rest = line.slice(prefix.length);
      const lastSpace = rest.lastIndexOf(' ');
      if (lastSpace <= 0) continue;
      stored.set(rest.slice(0, lastSpace), rest.slice(lastSpace + 1));
    }
  }
  if (stored.size === 0) process.stdout.write('SECTIONS: NONE\n');

  const current = [];
  for (const { start, end, heading } of sectionSpans(text)) {
    if (heading === '') continue;
    current.push(heading);
    const cur = sectionHash(text, start, end);
    const sv = stored.get(heading) ?? '';
    // `-z` is not a key-existence test, exactly as the original did: a stamp
    // recorded with an empty hash reads NEW, not UNCHANGED.
    if (sv === '') {
      process.stdout.write(`SECTION-NEW: ${heading}\n`);
    } else if (cur === 'NO-HASH-TOOL') {
      // Nothing could hash this section, so nothing can call it unchanged --
      // least of all a stored placeholder, which equals every other one. A
      // wasted re-review is safe; a changed section skipped is not.
      warnNoHash();
      process.stdout.write(`SECTION-CHANGED: ${heading}\n`);
    } else if (cur === sv) {
      process.stdout.write(`SECTION-UNCHANGED: ${heading}\n`);
    } else {
      process.stdout.write(`SECTION-CHANGED: ${heading}\n`);
    }
  }

  // `sort -u` over the stored keys, then report the ones with no current span.
  for (const key of [...new Set(stored.keys())].sort()) {
    if (key === '') continue;
    if (!current.includes(key)) process.stdout.write(`SECTION-REMOVED: ${key}\n`);
  }
  return 0;
}

function main(argv) {
  const mode = argv[0] ?? '';
  const rest = argv.slice(1);
  switch (mode) {
    case 'hash':
      return modeHash(rest);
    case 'check':
      // `receipt="${1:-}"; shift` — everything after the receipt is a file.
      return modeCheck(rest[0] ?? '', rest.slice(1));
    case 'sections-hash':
      return modeSectionsHash(rest[0] ?? '');
    case 'sections-check':
      return modeSectionsCheck(rest[0] ?? '', rest[1] ?? '');
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
