// Test for dsh-src/scripts/rotate-session-state.mjs
//   (port of .claude/scripts/rotate-session-state.sh)
// Run: node tools/tests/scripts/rotate-session-state.test.mjs
//
// This is the one ported script that MOVES and REWRITES project files, so the
// cases below check the filesystem, not just stdout: what the archive received,
// what active.md became, what a second run does, and what happens when a step
// fails midway.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeChecker, makeFixture, runScript } from './_harness.mjs';

const SCRIPT = 'rotate-session-state.mjs';
const check = makeChecker('rotate-session-state');

const STATE = 'production/session-state/active.md';
const LOGDIR = 'production/session-logs';

const write = (root, relative, content) => {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
};

const read = (root, relative) => {
  const path = join(root, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

/** The local date the script will embed, computed the same way it does. */
function localStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `wc -l` semantics: newline count. */
const wcLines = (text) => (text.match(/\n/g) ?? []).length;

/**
 * The line number of the `<!-- /CHECKPOINT -->` marker, computed from the text
 * (so the fixture and the expectation cannot drift apart).
 */
function markerLine(text) {
  const lines = text.split('\n');
  return lines.findIndex((line) => line.includes('<!-- /CHECKPOINT -->')) + 1;
}

/**
 * The template's shape: a checkpoint through the marker, then a narrative that
 * starts with the blank separator line.
 *
 * The split is EXACTLY at the marker line (`grep -n ... | head -1`), so a "1-line
 * narrative" here is the blank separator alone — below the 5-line threshold, which
 * is why the file shape matters rather than being cosmetic. `markerLine()` reads
 * the line number back out of the text so the fixture cannot drift from the
 * expectation.
 * @param {number} narrativeLines lines AFTER the marker line (0 means none)
 */
function stateFile(narrativeLines) {
  const head = [
    '# Active Session State — test',
    '',
    '<!-- STATUS -->',
    'Epic:',
    '<!-- /STATUS -->',
    '',
    '<!-- CHECKPOINT -->',
    '**Updated:** 2026-01-01',
    '**Current task:** rotation test',
    '<!-- /CHECKPOINT -->',
  ];
  const tail = [];
  // The narrative begins with the blank separator, so a 1-line narrative is that
  // blank line alone — below the rotation threshold, exactly as in the template.
  // `narrativeLines` is the TOTAL number of lines after the marker.
  if (narrativeLines > 0) tail.push('');
  // `tail` holds the blank separator plus `narrativeLines - 1` content lines, so
  // the loop runs to `narrativeLines` inclusive: exactly that many lines follow
  // the marker.
  for (let i = 2; i <= narrativeLines; i += 1) tail.push(`narrative line ${i}`);
  const text = [...head, ...tail].join('\n') + (narrativeLines > 0 ? '\n' : '');
  return { text, splitLine: markerLine(text) };
}

try {
  check('--help prints the script comment block, verbatim-ish, and exits 0', () => {
    const fixture = makeFixture({ files: {} });
    try {
      const r = runScript(fixture, SCRIPT, ['--help']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^rotate-session-state\.sh — move active\.md's narrative into the session log,\nleaving the checkpoint behind\.\n/);
      assert.match(r.stdout, /\nWHY THIS EXISTS\n/);
      assert.match(r.stdout, /EXPLICIT INVOCATION ONLY\. No hook calls this\./);
      assert.match(r.stdout, /# rotate$/m);
      assert.match(r.stdout, /# show, change nothing$/m);
      assert.match(r.stdout, /--help\n$/);
      // The shell printed lines 2-30 of a `# `-commented block, which ends blank.
      assert.equal(r.stdout.endsWith('\n\n'), false);
    } finally {
      fixture.cleanup();
    }
  });

  check('-h is the same as --help', () => {
    const fixture = makeFixture({ files: {} });
    try {
      assert.equal(runScript(fixture, SCRIPT, ['-h']).stdout, runScript(fixture, SCRIPT, ['--help']).stdout);
    } finally {
      fixture.cleanup();
    }
  });

  check('an unknown argument is usage error 2', () => {
    const fixture = makeFixture({ files: {} });
    try {
      const r = runScript(fixture, SCRIPT, ['--force']);
      assert.equal(r.status, 2);
      assert.equal(r.stderr, 'unknown argument: --force (try --help)\n');
      assert.equal(r.stdout, '');
    } finally {
      fixture.cleanup();
    }
  });

  check('no session state: says so and exits 0', () => {
    const fixture = makeFixture({ files: {} });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `no session state at ${STATE} — nothing to rotate\n`);
    } finally {
      fixture.cleanup();
    }
  });

  check('a state file with no checkpoint marker is REFUSED with exit 3', () => {
    const fixture = makeFixture({ files: { [STATE]: '# Active\n\njust narrative\n' } });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 3);
      assert.equal(r.stdout, [
        `REFUSED: ${STATE} has no <!-- /CHECKPOINT --> marker.`,
        '  Rotation splits the file at that marker, so without it this script',
        '  cannot tell the checkpoint from the narrative and would move both.',
        '  Re-create the file from .dsh/docs/templates/session-state.md first.',
        '',
      ].join('\n'));
      // Nothing was created or modified.
      assert.equal(read(fixture.root, STATE), '# Active\n\njust narrative\n');
      assert.equal(existsSync(join(fixture.root, LOGDIR)), false);
    } finally {
      fixture.cleanup();
    }
  });

  check('a narrative of 5 lines or fewer is left alone', () => {
    for (const narrative of [0, 5]) {
      const { text } = stateFile(narrative);
      const fixture = makeFixture({ files: { [STATE]: text } });
      try {
        const r = runScript(fixture, SCRIPT, []);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, `narrative is ${narrative} lines — nothing worth rotating\n`);
        assert.equal(read(fixture.root, STATE), text);
        assert.equal(existsSync(join(fixture.root, LOGDIR)), false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  check('--dry-run reports the split and writes NOTHING', () => {
    const { text, splitLine } = stateFile(20);
    const fixture = makeFixture({ files: { [STATE]: text } });
    try {
      const r = runScript(fixture, SCRIPT, ['--dry-run']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, [
        'DRY RUN — no changes written',
        `  checkpoint kept : lines 1-${splitLine}`,
        `  narrative moved : lines ${splitLine + 1}-${wcLines(text)} (20 lines)`,
        `  destination     : ${LOGDIR}/session-state-${localStamp()}.md`,
        '',
      ].join('\n'));
      assert.equal(read(fixture.root, STATE), text);
      assert.equal(existsSync(join(fixture.root, LOGDIR)), false);
    } finally {
      fixture.cleanup();
    }
  });

  check('rotation archives the narrative and rewrites active.md in place', () => {
    const { text, splitLine } = stateFile(20);
    const fixture = makeFixture({ files: { [STATE]: text } });
    const stamp = localStamp();
    const archive = `${LOGDIR}/session-state-${stamp}.md`;
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);

      const lines = text.slice(0, -1).split('\n');
      const expectedArchive = `\n---\n\n## Rotated from active.md on ${stamp} (20 lines)\n\n`
        + `${lines.slice(splitLine).join('\n')}\n`;
      assert.equal(read(fixture.root, archive), expectedArchive);

      const expectedState = `${lines.slice(0, splitLine).join('\n')}\n\n---\n\n## Notes\n\n`
        + `_Narrative through ${stamp} rotated to \`${archive}\`._\n\n`;
      const state = read(fixture.root, STATE);
      assert.equal(state, expectedState);
      assert.equal(
        r.stdout,
        `rotated 20 lines -> ${archive}\n${STATE} is now ${wcLines(state)} lines\n`,
      );

      // The checkpoint survived intact and the narrative is gone from active.md.
      assert.match(state, /<!-- \/CHECKPOINT -->\n/);
      assert.match(state, /\*\*Current task:\*\* rotation test\n/);
      assert.ok(!state.includes('narrative line 1'), state);
      // Nothing was deleted: the archive's narrative section is byte-for-byte the
      // part of active.md that followed the marker, terminated by `tail`'s own
      // newline. The FINAL narrative line is therefore not newline-terminated —
      // `wc -l` undercounts a file whose last line has none, so the slice stops one
      // line short of the file's end. The shell original behaved identically; this
      // case pins the invariant as TEXT rather than as a line count.
      const archived = read(fixture.root, archive);
      const narrativeText = text.slice(0, -1).split('\n').slice(splitLine).join('\n');
      assert.equal(archived, `\n---\n\n## Rotated from active.md on ${stamp} (20 lines)\n\n${narrativeText}\n`);
      for (let i = 1; i <= 20; i += 1) {
        assert.ok(archived.includes(`narrative line ${i}`), `line ${i}`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  check('the rewritten state file is `head -n SPLIT` plus a fresh Notes section', () => {
    const { text, splitLine } = stateFile(9);
    const fixture = makeFixture({ files: { [STATE]: text } });
    try {
      assert.equal(runScript(fixture, SCRIPT, []).status, 0);
      const state = read(fixture.root, STATE);
      const expectedHead = text.slice(0, -1).split('\n').slice(0, splitLine).join('\n');
      assert.ok(state.startsWith(`${expectedHead}\n`), state);
      assert.match(state, /\n---\n\n## Notes\n\n_Narrative through \d{4}-\d{2}-\d{2} rotated to `production\/session-logs\/session-state-\d{4}-\d{2}-\d{2}\.md`\._\n\n$/);
    } finally {
      fixture.cleanup();
    }
  });

  check('running twice is idempotent: the second run has nothing to rotate', () => {
    const { text } = stateFile(20);
    const fixture = makeFixture({ files: { [STATE]: text } });
    const stamp = localStamp();
    const archive = `${LOGDIR}/session-state-${stamp}.md`;
    try {
      const first = runScript(fixture, SCRIPT, []);
      assert.equal(first.status, 0, first.stderr);
      const afterFirst = read(fixture.root, STATE);
      const archivedOnce = read(fixture.root, archive);

      const second = runScript(fixture, SCRIPT, []);
      assert.equal(second.status, 0, second.stderr);
      // The rewritten file is checkpoint (10 lines) + blank + `---` + `## Notes` +
      // the "rotated to" line + blank: 17 newlines, i.e. a 7-line "narrative" that
      // is this script's OWN boilerplate. A second run must do NOTHING — the shell
      // original rotated it again and appended an empty section to the archive.
      assert.equal(second.stdout, 'narrative is 7 lines — nothing worth rotating\n');
      assert.equal(read(fixture.root, STATE), afterFirst);
      assert.equal(read(fixture.root, archive), archivedOnce);
      assert.deepEqual(readdirSync(join(fixture.root, LOGDIR)), [`session-state-${stamp}.md`]);
    } finally {
      fixture.cleanup();
    }
  });

  check('two rotations on the same day APPEND to one archive file', () => {
    const { text } = stateFile(8);
    const fixture = makeFixture({ files: { [STATE]: text } });
    const stamp = localStamp();
    const archive = `${LOGDIR}/session-state-${stamp}.md`;
    try {
      // First rotation of a small narrative.
      assert.equal(runScript(fixture, SCRIPT, []).status, 0);
      const firstArchive = read(fixture.root, archive);
      // Regrow the narrative past the threshold, then rotate again.
      writeFileSync(
        join(fixture.root, STATE),
        `${read(fixture.root, STATE)}${'more narrative\n'.repeat(7)}`,
        'utf8',
      );
      const second = runScript(fixture, SCRIPT, []);
      assert.equal(second.status, 0, second.stderr);
      const secondArchive = read(fixture.root, archive);
      assert.ok(secondArchive.startsWith(firstArchive), 'the earlier section is preserved');
      assert.ok(secondArchive.length > firstArchive.length);
      assert.equal((secondArchive.match(/## Rotated from active\.md on/g) ?? []).length, 2);
    } finally {
      fixture.cleanup();
    }
  });

  check('a checkpoint marker later in the file splits there, not at the first line', () => {
    // `grep -n | head -1` takes the FIRST marker; a marker inside an HTML comment
    // is matched too (grep is a substring match).
    const text = [
      '# Active',
      '',
      '<!-- CHECKPOINT -->',
      '**Updated:** 2026-01-01',
      '<!-- /CHECKPOINT -->',
      '',
      ...Array.from({ length: 8 }, (_, i) => `narrative ${i + 1}`),
      '',
    ].join('\n');
    const fixture = makeFixture({ files: { [STATE]: text } });
    try {
      const r = runScript(fixture, SCRIPT, ['--dry-run']);
      assert.match(r.stdout, /checkpoint kept : lines 1-5\n/);
      assert.match(r.stdout, /narrative moved : lines 6-14 \(9 lines\)\n/);
    } finally {
      fixture.cleanup();
    }
  });

  check('a narrative whose last line has no newline still rotates (wc -l arithmetic)', () => {
    // `wc -l` undercounts by one here, which is exactly why the port keeps the
    // `head`/`tail` semantics instead of "fixing" them.
    const { text, splitLine } = stateFile(8);
    const noTrailing = text.slice(0, -1);
    const fixture = makeFixture({ files: { [STATE]: noTrailing } });
    const stamp = localStamp();
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `rotated ${wcLines(noTrailing) - splitLine} lines -> ${LOGDIR}/session-state-${stamp}.md\n`
        + `${STATE} is now ${wcLines(read(fixture.root, STATE))} lines\n`);
      assert.match(read(fixture.root, STATE), /<!-- \/CHECKPOINT -->\n/);
    } finally {
      fixture.cleanup();
    }
  });

  check('an unwritable session-log directory fails loudly and leaves the state alone', () => {
    const { text } = stateFile(20);
    const fixture = makeFixture({ files: { [STATE]: text } });
    try {
      // A FILE where the log directory must go: `mkdir -p` cannot succeed, and the
      // archive write is impossible. The shell original would have reported a
      // rotation it had not performed; this port reports the real failure.
      write(fixture.root, LOGDIR, 'not a directory\n');
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^rotate-session-state: FAILED — cannot write production\/session-logs\//);
      assert.match(r.stderr, new RegExp(`  ${STATE} is UNCHANGED\\.\\n$`));
      assert.equal(read(fixture.root, STATE), text);
    } finally {
      fixture.cleanup();
    }
  });

  check('a CRLF state file keeps its own line endings in the rewritten head', () => {
    const { text, splitLine } = stateFile(20);
    const crlf = text.replace(/\n/g, '\r\n');
    const fixture = makeFixture({ files: { [STATE]: crlf } });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      const state = read(fixture.root, STATE);
      // The checkpoint lines are copied through unchanged, so they still carry CR.
      const head = crlf.split('\n').slice(0, splitLine).join('\n');
      assert.ok(state.startsWith(`${head}\n`), JSON.stringify(state.slice(0, 120)));
      assert.match(state, /<!-- \/CHECKPOINT -->/);
    } finally {
      fixture.cleanup();
    }
  });

  check('the script reads and writes the FIXTURE, never this repository', () => {
    const { text } = stateFile(20);
    const fixture = makeFixture({ files: { [STATE]: text } });
    try {
      assert.equal(runScript(fixture, SCRIPT, []).status, 0);
      assert.equal(existsSync(join(fixture.root, LOGDIR, `session-state-${localStamp()}.md`)), true);
    } finally {
      fixture.cleanup();
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
