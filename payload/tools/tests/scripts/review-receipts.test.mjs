// Test for dsh-src/scripts/review-receipts.mjs (port of .claude/scripts/review-receipts.sh)
// Run: node tools/tests/scripts/review-receipts.test.mjs
//
// The script's stdout is parsed by /design-review, /architecture-review and
// /review-all-gdds, so every case asserts on exact output text and exit codes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChecker, makeFixture, readFixture, runScript } from './_harness.mjs';

const SCRIPT = 'review-receipts.mjs';
const check = makeChecker('review-receipts');

/** `git hash-object --stdin`'s value for `text`, computed the way git computes it. */
function blobHash(text) {
  const header = Buffer.from(`blob ${Buffer.byteLength(text, 'utf8')}\0`, 'utf8');
  return createHash('sha1').update(header).update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * The raw bytes of lines `a`..`b` inclusive, terminators included — what
 * `sed -n "$a,$b p"` would hand git. Kept as the test's own reader (it does not
 * import the script's internals) so a change in the port shows up as a failure.
 */
function rawLineRange(text, a, b) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  if (a > starts.length) return '';
  const first = starts[a - 1];
  const lastIndex = Math.min(b, starts.length) - 1;
  const next = starts[lastIndex + 1];
  return next === undefined ? text.slice(first) : text.slice(first, next);
}

/**
 * The real thing: `git -c core.autocrlf=false hash-object -- <file>`, with git's
 * output redirected to a file (piped stdio is denied in this sandbox).
 *
 * `core.autocrlf=false` is forced because this repository sets it to `true`, and
 * `git hash-object <file>` honours it by CRLF→LF normalising the blob — a file
 * hashed by git then differs from the same bytes hashed by Node. The script's
 * whole-file path deliberately uses git (so a user's normalisation stays
 * self-consistent between stamp and check); this helper wants the RAW bytes, to
 * pin the section path, which never consults git.
 * Returns null when git is absent.
 */
function realGitHash(file) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-hash-'));
  const outFile = join(dir, 'out.txt');
  const fd = openSync(outFile, 'w');
  let result;
  try {
    result = spawnSync('git', ['-c', 'core.autocrlf=false', 'hash-object', '--', file], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
  rmSync(dir, { recursive: true, force: true });
  if (result.error !== undefined && result.error !== null) return null;
  if (result.status !== 0 || text === '') return null;
  return text;
}

/** A GDD-shaped document: a preamble, two `##` sections, and a duplicate heading. */
const DOC = '---\ntitle: Combat\n---\n\n# Combat\n\n## Overview\nMelee first.\n\n## Dependencies\nSee damage-model.md.\n\n## Overview\nSecond one.\n';
const OTHER_DOC = '# Other\n\n## Overview\nDifferent text.\n';
const REVIEW_LOG = 'design/gdd/reviews/combat.md';

const fixture = makeFixture({
  files: { [REVIEW_LOG]: DOC, 'design/gdd/other.md': OTHER_DOC },
});

try {
  // The fixture files are read back as the SCRIPT sees them, because this
  // repository sets core.autocrlf=true: what `writeFileSync` called LF can be a
  // CRLF blob on disk, and hashing is over bytes. Deriving expectations from the
  // bytes on disk keeps every case a statement about behaviour, not about the
  // checkout.
  const bytesOf = (relative) => readFileSync(join(fixture.root, relative), 'utf8');
  const docBytes = bytesOf(REVIEW_LOG);
  const spanText = (a, b) => rawLineRange(docBytes, a, b).replace(/\r\n/g, '\n');

  /* ---------------------------------------------------------------- hash --- */

  check('hash prints one stamp line per file, with forward slashes', () => {
    const r = runScript(fixture, SCRIPT, ['hash', REVIEW_LOG, 'design/gdd/other.md']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Reviewed-Content-Hash: design\/gdd\/reviews\/combat\.md [0-9a-f]{40}$/);
    assert.match(lines[1], /^Reviewed-Content-Hash: design\/gdd\/other\.md [0-9a-f]{40}$/);
    assert.equal(r.stdout, `Reviewed-Content-Hash: ${REVIEW_LOG} ${blobHash(docBytes)}\n`
      + `Reviewed-Content-Hash: design/gdd/other.md ${blobHash(bytesOf('design/gdd/other.md'))}\n`);
  });

  check('hash refuses a missing file with exit 2 and keeps going', () => {
    const r = runScript(fixture, SCRIPT, ['hash', 'design/gdd/absent.md', REVIEW_LOG]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'review-receipts: no such file: design/gdd/absent.md\n');
    assert.match(r.stdout, /^Reviewed-Content-Hash: design\/gdd\/reviews\/combat\.md /);
  });

  check('hash with no file is a usage error (exit 2)', () => {
    const r = runScript(fixture, SCRIPT, ['hash']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'review-receipts: hash mode needs at least one file\n');
    assert.equal(r.stdout, '');
  });

  check('no mode prints usage and exits 2', () => {
    const r = runScript(fixture, SCRIPT, []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Usage: review-receipts\.sh hash <file>\.\.\./);
  });

  /* --------------------------------------------------------------- check --- */

  check('check with no receipt file reports RECEIPT: NONE and every file NEW', () => {
    const r = runScript(fixture, SCRIPT, ['check', 'design/gdd/reviews/absent-log.md', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RECEIPT: NONE\nNEW: ${REVIEW_LOG}\n`);
  });

  check('check with an EMPTY receipt file also reports NONE', () => {
    writeFileSync(join(fixture.root, 'empty-receipt.md'), '', 'utf8');
    const r = runScript(fixture, SCRIPT, ['check', 'empty-receipt.md', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RECEIPT: NONE\nNEW: ${REVIEW_LOG}\n`);
  });

  check('an absent LITERAL path stays silent; an unexpanded glob is UNRESOLVED', () => {
    const r = runScript(fixture, SCRIPT, [
      'check', 'no-such-receipt.md', 'design/registry/entities.yaml', 'design/gdd/*.md',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'RECEIPT: NONE\nUNRESOLVED: design/gdd/*.md\n');
  });

  check('check needs a receipt AND a file (exit 2)', () => {
    const r = runScript(fixture, SCRIPT, ['check', 'only-a-receipt.md']);
    assert.equal(r.status, 2);
    assert.equal(
      r.stderr,
      'review-receipts: check mode needs a receipt file and at least one file\n',
    );
  });

  check('the LATEST stamp wins, and NEW/UNCHANGED/CHANGED are exact', () => {
    const current = blobHash(docBytes);
    const stale = blobHash('stale bytes\n');
    const receipt = [
      `Reviewed-Content-Hash: ${REVIEW_LOG} ${stale}`,
      `Reviewed-Content-Hash: design/gdd/other.md ${stale}`,
      `Reviewed-Content-Hash: ${REVIEW_LOG} ${current}`,
      '',
    ].join('\n');
    writeFileSync(join(fixture.root, 'receipt.md'), receipt, 'utf8');
    const r = runScript(fixture, SCRIPT, [
      'check', 'receipt.md', REVIEW_LOG, 'design/gdd/other.md', 'design/gdd/never-hashed.md',
    ]);
    assert.equal(r.status, 0, r.stderr);
    // combat.md matches its LATEST stamp (the third line), not the stale first one.
    // `design/gdd/never-hashed.md` does not exist, so it is NOT reported: an absent
    // literal path is an optional input the caller named on purpose (the
    // /design-review entity-registry case) and stays silent by design.
    assert.equal(r.stdout, [
      'RECEIPT: receipt.md',
      `UNCHANGED: ${REVIEW_LOG}`,
      'CHANGED: design/gdd/other.md',
      '',
    ].join('\n'));
  });

  check('a nonexistent file is silent even though it was named explicitly', () => {
    const current = blobHash(docBytes);
    writeFileSync(
      join(fixture.root, 'named.md'),
      `Reviewed-Content-Hash: ${REVIEW_LOG} ${current}\n`,
      'utf8',
    );
    const r = runScript(fixture, SCRIPT, ['check', 'named.md', 'design/registry/entities.yaml']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'RECEIPT: named.md\n');
  });

  check('a receipt with only a stale stamp reads CHANGED', () => {
    writeFileSync(
      join(fixture.root, 'stale.md'),
      `Reviewed-Content-Hash: ${REVIEW_LOG} ${blobHash('older content\n')}\n`,
      'utf8',
    );
    const r = runScript(fixture, SCRIPT, ['check', 'stale.md', REVIEW_LOG]);
    assert.equal(r.stdout, `RECEIPT: stale.md\nCHANGED: ${REVIEW_LOG}\n`);
  });

  /* ------------------------------------------------------ sections-hash --- */

  check('sections-hash emits preamble + duplicate-heading keys, git-compatible hashes', () => {
    const r = runScript(fixture, SCRIPT, ['sections-hash', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    // awk's spans for DOC: the preamble runs to the line BEFORE the first `## `
    // (1-6), then 7-9 Overview, 10-12 Dependencies, 13-14 "Overview #2". A span is
    // contiguous from one `## ` line to the line before the next, and each is
    // hashed as a git blob of those raw lines.
    assert.equal(r.stdout, [
      `Reviewed-Section-Hash: ${REVIEW_LOG}#__preamble__ ${blobHash(spanText(1, 6))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Overview ${blobHash(spanText(7, 9))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Dependencies ${blobHash(spanText(10, 12))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Overview #2 ${blobHash(spanText(13, 14))}`,
      '',
    ].join('\n'));
  });

  check('sections-hash includes the content AFTER the last heading in its span', () => {
    // OTHER_DOC's heading is on line 3 and the file has 4 lines, so the span runs
    // 3-4 — the END-block rule (`if (s) print s, NR`), which is easy to get wrong.
    const otherBytes = bytesOf('design/gdd/other.md');
    const r = runScript(fixture, SCRIPT, ['sections-hash', 'design/gdd/other.md']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [
      `Reviewed-Section-Hash: design/gdd/other.md#__preamble__ ${blobHash(rawLineRange(otherBytes, 1, 2).replace(/\r\n/g, '\n'))}`,
      `Reviewed-Section-Hash: design/gdd/other.md#Overview ${blobHash(rawLineRange(otherBytes, 3, 4).replace(/\r\n/g, '\n'))}`,
      '',
    ].join('\n'));
  });

  check('sections-hash on a missing file is exit 2', () => {
    const r = runScript(fixture, SCRIPT, ['sections-hash', 'nope.md']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'review-receipts: sections-hash needs an existing file\n');
  });

  /* ----------------------------------------------------- sections-check --- */

  check('sections-check reports NONE + every section NEW when nothing is stored', () => {
    const r = runScript(fixture, SCRIPT, ['sections-check', 'absent-log.md', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [
      'SECTIONS: NONE',
      'SECTION-NEW: __preamble__',
      'SECTION-NEW: Overview',
      'SECTION-NEW: Dependencies',
      'SECTION-NEW: Overview #2',
      '',
    ].join('\n'));
  });

  check('sections-check compares per section and reports REMOVED', () => {
    const spanTextFor = (a, b) => rawLineRange(docBytes, a, b).replace(/\r\n/g, '\n');
    const log = [
      `Reviewed-Section-Hash: ${REVIEW_LOG}#__preamble__ ${blobHash(spanTextFor(1, 6))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Overview ${blobHash('stale overview bytes\n')}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Dependencies ${blobHash(spanTextFor(10, 12))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Overview #2 ${blobHash(spanTextFor(13, 14))}`,
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Removed Section ${blobHash('gone\n')}`,
      '',
    ].join('\n');
    writeFileSync(join(fixture.root, 'sections.md'), log, 'utf8');
    const r = runScript(fixture, SCRIPT, ['sections-check', 'sections.md', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, [
      'SECTION-UNCHANGED: __preamble__',
      // The one stamp that does not match the current bytes reads CHANGED.
      'SECTION-CHANGED: Overview',
      'SECTION-UNCHANGED: Dependencies',
      'SECTION-UNCHANGED: Overview #2',
      'SECTION-REMOVED: Removed Section',
      '',
    ].join('\n'));
  });

  check('a stored stamp with an EMPTY hash reads SECTION-NEW, not UNCHANGED', () => {
    writeFileSync(
      join(fixture.root, 'empty-hash.md'),
      `Reviewed-Section-Hash: ${REVIEW_LOG}#Overview \n`,
      'utf8',
    );
    const r = runScript(fixture, SCRIPT, ['sections-check', 'empty-hash.md', REVIEW_LOG]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SECTION-NEW: Overview\n/);
    assert.doesNotMatch(r.stdout, /SECTION-UNCHANGED: Overview\n/);
  });

  check('sections-check on a missing file is exit 2', () => {
    const r = runScript(fixture, SCRIPT, ['sections-check', 'sections.md', 'nope.md']);
    assert.equal(r.status, 2);
    assert.equal(
      r.stderr,
      'review-receipts: sections-check needs a receipt file and an existing file\n',
    );
  });

  /* --------------------------------------------- round trip and drift ----- */

  check('hash -> check round-trips as UNCHANGED, then CHANGED after an edit', () => {
    const target = join(fixture.root, 'design', 'gdd', 'roundtrip.md');
    writeFileSync(target, '# Round\n\n## Overview\none\n', 'utf8');
    const stamped = runScript(fixture, SCRIPT, ['hash', 'design/gdd/roundtrip.md']);
    assert.equal(stamped.status, 0, stamped.stderr);
    writeFileSync(join(fixture.root, 'log.md'), stamped.stdout, 'utf8');
    const again = runScript(fixture, SCRIPT, ['check', 'log.md', 'design/gdd/roundtrip.md']);
    assert.equal(again.stdout, 'RECEIPT: log.md\nUNCHANGED: design/gdd/roundtrip.md\n');
    writeFileSync(target, '# Round\n\n## Overview\ntwo\n', 'utf8');
    const edited = runScript(fixture, SCRIPT, ['check', 'log.md', 'design/gdd/roundtrip.md']);
    assert.equal(edited.stdout, 'RECEIPT: log.md\nCHANGED: design/gdd/roundtrip.md\n');
  });

  check('sections-hash -> sections-check round-trips as UNCHANGED', () => {
    const target = join(fixture.root, 'design', 'gdd', 'sections-doc.md');
    writeFileSync(target, '# Doc\n\n## Alpha\none\n\n## Beta\ntwo\n', 'utf8');
    const stamped = runScript(fixture, SCRIPT, ['sections-hash', 'design/gdd/sections-doc.md']);
    assert.equal(stamped.status, 0, stamped.stderr);
    writeFileSync(join(fixture.root, 'sections-log.md'), stamped.stdout, 'utf8');
    const again = runScript(fixture, SCRIPT, [
      'sections-check', 'sections-log.md', 'design/gdd/sections-doc.md',
    ]);
    assert.equal(again.stdout, [
      'SECTION-UNCHANGED: __preamble__',
      'SECTION-UNCHANGED: Alpha',
      'SECTION-UNCHANGED: Beta',
      '',
    ].join('\n'));
  });

  check('sections-hash needs no hash tool for the preamble (empty file)', () => {
    writeFileSync(join(fixture.root, 'blank.md'), '', 'utf8');
    const r = runScript(fixture, SCRIPT, ['sections-hash', 'blank.md']);
    assert.equal(r.status, 0, r.stderr);
    // A file with no lines has no span at all — awk's `NR > 0` guard.
    assert.equal(r.stdout, '');
  });

  check('section hashes match real `git hash-object` output', () => {
    const probe = runScript(fixture, SCRIPT, ['sections-hash', REVIEW_LOG]);
    const printed = probe.stdout.split('\n').filter((l) => l !== '')
      .map((line) => line.split(' ').pop());
    // For each span, hand git the exact bytes and compare: this is what pins the
    // git blob formula (the header length is BYTES, not characters).
    const spans = [[1, 6], [7, 9], [10, 12], [13, 14]];
    spans.forEach(([start, end], index) => {
      const candidate = join(fixture.root, `span-${index}.txt`);
      writeFileSync(candidate, rawLineRange(docBytes, start, end), 'utf8');
      const gitHash = realGitHash(candidate);
      if (gitHash !== null) assert.equal(printed[index], gitHash, `span ${start}-${end}`);
    });
    // The empty-section anchor, independent of this machine's git: a heading
    // immediately followed by another heading spans "## Alpha\n" + the blank line
    // that separates them, so the case is pinned with an explicitly empty span
    // instead — git's empty blob is da39a3ee…, which is what
    // `printf '' | git hash-object --stdin` and therefore an empty `sed -n` range
    // both hash to.
    writeFileSync(join(fixture.root, 'empty-section.md'), '# T\n\n## Alpha\n\n## Beta\nx\n', 'utf8');
    const empty = runScript(fixture, SCRIPT, ['sections-hash', 'empty-section.md']);
    assert.equal(empty.stdout, [
      'Reviewed-Section-Hash: empty-section.md#__preamble__ '
        + `${blobHash(rawLineRange('# T\n\n## Alpha\n\n## Beta\nx\n', 1, 2))}`,
      'Reviewed-Section-Hash: empty-section.md#Alpha '
        + `${blobHash(rawLineRange('# T\n\n## Alpha\n\n## Beta\nx\n', 3, 4))}`,
      'Reviewed-Section-Hash: empty-section.md#Beta '
        + `${blobHash(rawLineRange('# T\n\n## Alpha\n\n## Beta\nx\n', 5, 6))}`,
      '',
    ].join('\n'));
    // A file that is one empty line has ONE line (`NR` counts it), so its
    // preamble span is that line and hashes as git's blob of "\n" —
    // 8b137891…, NOT the empty blob. This is the case that separates
    // "one empty line" from "no lines at all".
    writeFileSync(join(fixture.root, 'one-empty-line.md'), '\n', 'utf8');
    assert.equal(
      runScript(fixture, SCRIPT, ['sections-hash', 'one-empty-line.md']).stdout,
      'Reviewed-Section-Hash: one-empty-line.md#__preamble__ '
        + '8b137891791fe96927ad78e64b0aad7bded08bdc\n',
    );
    // A truly empty file has no lines, so awk's `NR > 0` guard emits NO span at
    // all — and that is the case that produces git's empty blob if it ever did.
    writeFileSync(join(fixture.root, 'zero-lines.md'), '', 'utf8');
    assert.equal(runScript(fixture, SCRIPT, ['sections-hash', 'zero-lines.md']).stdout, '');
    assert.equal(blobHash(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  check('a directory argument is not a file ([ -f ] semantics)', () => {
    const r = runScript(fixture, SCRIPT, ['hash', 'design']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'review-receipts: no such file: design\n');
  });

  check('a CRLF document: section hashes stay self-consistent', () => {
    const crlf = '# Win\r\n\r\n## Alpha\r\none\r\n';
    writeFileSync(join(fixture.root, 'crlf.md'), crlf, 'utf8');
    // The whole-file path defers to git, which may normalise CRLF (this repo sets
    // core.autocrlf=true); what must hold is that stamp and check agree, which the
    // round trip below asserts. The section path never consults git, so its hashes
    // are over the raw bytes on every platform.
    const stamped = runScript(fixture, SCRIPT, ['hash', 'crlf.md']);
    assert.equal(stamped.status, 0, stamped.stderr);
    assert.match(stamped.stdout, /^Reviewed-Content-Hash: crlf\.md [0-9a-f]{40}\n$/);
    writeFileSync(join(fixture.root, 'crlf-log.md'), stamped.stdout, 'utf8');
    assert.equal(
      runScript(fixture, SCRIPT, ['check', 'crlf-log.md', 'crlf.md']).stdout,
      'RECEIPT: crlf-log.md\nUNCHANGED: crlf.md\n',
    );
    const sections = runScript(fixture, SCRIPT, ['sections-hash', 'crlf.md']);
    assert.equal(sections.stdout, [
      `Reviewed-Section-Hash: crlf.md#__preamble__ ${blobHash('# Win\r\n\r\n')}`,
      `Reviewed-Section-Hash: crlf.md#Alpha ${blobHash('## Alpha\r\none\r\n')}`,
      '',
    ].join('\n'));
  });

  check('stdin is ignored entirely (the skill passes no input)', () => {
    const r = runScript(fixture, SCRIPT, ['hash', 'crlf.md'], { stdinText: 'garbage' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Reviewed-Content-Hash: crlf\.md /);
  });

  check('the fixture itself is what the script read (no repo leakage)', () => {
    assert.equal(existsSync(join(fixture.root, 'dsh-src', 'scripts', SCRIPT)), true);
    assert.equal(readFixture(fixture.root, 'crlf.md').startsWith('# Win'), true);
  });
} finally {
  fixture.cleanup();
}
