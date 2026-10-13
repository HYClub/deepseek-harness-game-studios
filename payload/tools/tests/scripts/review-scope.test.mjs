// Test for dsh-src/scripts/review-scope.mjs (port of .claude/scripts/review-scope.sh)
// Run: node tools/tests/scripts/review-scope.test.mjs
//
// /review-all-gdds reads PRIOR_REVIEW / CHANGED / DEPS from this stdout, so the
// layout (two-space indent, `basename -> dep`, the em dash in the "none" line)
// is asserted literally. Git is exercised for real, against committed
// repositories: two of the three silent-data-loss bugs the shell version fixed
// only reproduce against git's own path handling.
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitAll, installScripts, makeChecker, makeFixture, run, runScript } from './_harness.mjs';

const SCRIPT = 'review-scope.mjs';
const check = makeChecker('review-scope');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Scripts Test',
  GIT_AUTHOR_EMAIL: 'scripts-test@example.invalid',
  GIT_COMMITTER_NAME: 'Scripts Test',
  GIT_COMMITTER_EMAIL: 'scripts-test@example.invalid',
};

/** The environment the script itself must inherit, so no user config leaks in. */
const ISOLATED_GIT = {
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'dsh-no-such-gitconfig'),
  GIT_CONFIG_SYSTEM: join(tmpdir(), 'dsh-no-such-gitconfig'),
};
const ENV = { ...process.env, ...GIT_ENV, ...ISOLATED_GIT };

const write = (root, relative, content) => {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
};

const gdd = (title, deps) => `# ${title}\n\n## Overview\nSomething.\n\n## Dependencies\n${deps}\n`;
const REVIEW = 'design/gdd/gdd-cross-review-2026-01-01.md';

/** A committed repository: one prior cross-review, two system GDDs, and decoys. */
function makeBaseline({ review = REVIEW } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-scope-base-'));
  write(base, 'project.yaml', 'schema_version: 1\n');
  if (review !== '') write(base, review, '# Prior review\n');
  // Deliberately NOT system GDDs: the filter must exclude them everywhere.
  write(base, 'design/gdd/game-concept.md', '# Concept\n');
  write(base, 'design/gdd/systems-index.md', '# Index\n');
  write(base, 'design/gdd/entity-registry.md', '# Registry\n');
  write(base, 'design/gdd/sound-bible.md', '# Sound\n');
  write(base, 'design/gdd/combat-system.md', gdd('Combat', 'See damage-model.md and entity-registry.md.\n'));
  write(base, 'design/gdd/damage-model.md', gdd('Damage', 'Uses combat-system.md.\n'));
  write(base, 'design/notes/scratch.md', '# not a GDD\n');
  commitAll(base, 'baseline');
  return base;
}

/**
 * A worktree with its own baseline commit.
 *
 * `git clone` is NOT used: on Windows, cloning a local path makes git spawn
 * `sh.exe` to copy the working tree, and this sandbox refuses to start MSYS
 * binaries ("couldn't create signal pipe, Win32 error 5") — the same wall that
 * makes the POSIX scripts unrunnable here. A fresh `git init` + commit gives the
 * same thing this test needs (a committed baseline that `git diff` and
 * `git status` compare against); the object hashes do not have to match the
 * source repository.
 *
 * Every copied file is backdated well before the test's own writes, so the mtime
 * fallback cases can assert exactly which files count as "newer".
 */
function makeWorktree(base) {
  const work = mkdtempSync(join(tmpdir(), 'dsh-scope-work-'));
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    cpSync(join(base, entry.name), join(work, entry.name), { recursive: true });
  }
  backdate(work, Date.now() / 1000 - 7200);
  commitAll(work, 'baseline');
  installScripts(work);
  return work;
}

/** Set every file's mtime to `seconds`, recursively, skipping the object store. */
function backdate(dir, seconds) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) backdate(full, seconds);
    else if (statSync(full).isFile()) utimesSync(full, seconds, seconds);
  }
}

/** Run the script with cwd = the worktree, asserting the shell original's exit 0. */
function scope(root) {
  const fixture = { root, script: (name) => join(root, 'dsh-src', 'scripts', name) };
  const r = runScript(fixture, SCRIPT, [], { env: ISOLATED_GIT });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

const git = (root, args) => {
  const result = run('git', args, root, ENV);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed`);
};

const cleanup = (...dirs) => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));

try {
  check('a committed review: latest report, uncommitted + committed changes, DEPS', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      // Committed edit (git diff), untracked addition (git status), a NON-system
      // GDD edit and an out-of-scope edit (both filtered). The committed edit must
      // really change the bytes — an identical rewrite is not a change, which is
      // the whole point of the script.
      write(work, 'design/gdd/combat-system.md', gdd('Combat', 'See entity-registry.md.\n'));
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'edit combat']);
      write(work, 'design/gdd/new-system.md', gdd('New', 'Placeholder, see audio-system.md.\n'));
      write(work, 'design/gdd/entity-registry.md', '# Registry edited\n');
      write(work, 'design/notes/scratch.md', '# edited\n');

      const out = scope(work);
      assert.equal(out, [
        `PRIOR_REVIEW: ${REVIEW}`,
        'CHANGED:',
        '  design/gdd/combat-system.md',
        '  design/gdd/new-system.md',
        'DEPS (declared in changed GDDs — include these in review scope too):',
        '  combat-system.md -> entity-registry.md',
        '  new-system.md -> audio-system.md',
        '',
      ].join('\n'));
    } finally {
      cleanup(work, base);
    }
  });

  check('the review report itself never enters scope (the :(glob) fix)', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      // A report written in the same edit as a GDD: a `*` crossing `/` would list
      // design/gdd/reviews/*.md if the report lived in a subdirectory.
      write(work, 'design/gdd/reviews/2026-03-03-combat.md', '# report\n');
      write(work, 'design/gdd/combat-system.md', gdd('Combat', 'nothing.\n'));
      const out = scope(work);
      assert.match(out, /^CHANGED:\n {2}design\/gdd\/combat-system\.md\n/m);
      assert.ok(!out.includes('design/gdd/reviews/'), out);
      // The report is named on the PRIOR_REVIEW line and must appear nowhere else
      // — in particular not in the CHANGED list.
      const changedBlock = out.slice(out.indexOf('CHANGED:'));
      assert.ok(!changedBlock.includes('gdd-cross-review-'), changedBlock);
    } finally {
      cleanup(work, base);
    }
  });

  check('a GDD with no declared dependencies contributes no DEPS line', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      write(work, 'design/gdd/quiet-system.md', '# Quiet\n\n## Overview\nNo deps section.\n');
      const out = scope(work);
      // The DEPS header is printed whenever the CHANGED list is non-empty (the
      // shell printed it before deciding there was nothing to add); the file with
      // no dependencies simply contributes no line under it.
      assert.equal(out, [
        `PRIOR_REVIEW: ${REVIEW}`,
        'CHANGED:',
        '  design/gdd/quiet-system.md',
        'DEPS (declared in changed GDDs — include these in review scope too):',
        '',
      ].join('\n'));
    } finally {
      cleanup(work, base);
    }
  });

  check('nothing changed reports the em-dashed "none" line and no DEPS block', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      assert.equal(scope(work), [
        `PRIOR_REVIEW: ${REVIEW}`,
        'CHANGED:',
        '  (none — no GDDs modified since last review)',
        '',
      ].join('\n'));
    } finally {
      cleanup(work, base);
    }
  });

  check('no prior review: full review, every system GDD listed, no DEPS block', () => {
    const base = makeBaseline({ review: '' });
    const work = makeWorktree(base);
    try {
      assert.equal(scope(work), [
        'PRIOR_REVIEW: NONE (full review required)',
        'CHANGED:',
        '  design/gdd/combat-system.md',
        '  design/gdd/damage-model.md',
        '',
      ].join('\n'));
    } finally {
      cleanup(work, base);
    }
  });

  check('no design/gdd directory at all: "(no system GDDs found)"', () => {
    const bare = makeFixture({ files: { 'project.yaml': 'schema_version: 1\n' } });
    try {
      assert.equal(scope(bare.root), [
        'PRIOR_REVIEW: NONE (full review required)',
        'CHANGED:',
        '  (no system GDDs found)',
        '',
      ].join('\n'));
    } finally {
      bare.cleanup();
    }
  });

  check('only excluded files present: the report is still found, nothing else is scope', () => {
    // A prior report plus a non-system GDD. The report IS the baseline (it is
    // `gdd-cross-review-*.md`), so PRIOR_REVIEW names it and CHANGED is empty —
    // "no system GDDs found" belongs to the no-report path, tested above.
    const fixture = makeFixture({
      files: {
        'project.yaml': 'schema_version: 1\n',
        'design/gdd/game-pillars.md': '# Pillars\n',
        'design/gdd/gdd-cross-review-2026-01-01.md': '# prior\n',
      },
    });
    try {
      assert.equal(scope(fixture.root), [
        'PRIOR_REVIEW: design/gdd/gdd-cross-review-2026-01-01.md',
        'CHANGED:',
        '  (none — no GDDs modified since last review)',
        '',
      ].join('\n'));
    } finally {
      fixture.cleanup();
    }
  });

  check('only review reports present: the prior report is found, nothing changed', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': 'schema_version: 1\n',
        [REVIEW]: '# prior\n',
        'design/gdd/sound-bible.md': '# Sound\n',
      },
    });
    try {
      assert.equal(scope(fixture.root), [
        `PRIOR_REVIEW: ${REVIEW}`,
        'CHANGED:',
        '  (none — no GDDs modified since last review)',
        '',
      ].join('\n'));
    } finally {
      fixture.cleanup();
    }
  });

  check('the LATEST report by FILENAME wins, even when an older one is newer on disk', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      const older = write(work, 'design/gdd/gdd-cross-review-2025-06-01.md', '# older\n');
      const future = Date.now() / 1000 + 3600;
      utimesSync(older, future, future);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'older report']);
      assert.match(scope(work), /^PRIOR_REVIEW: design\/gdd\/gdd-cross-review-2026-01-01\.md\n/);
    } finally {
      cleanup(work, base);
    }
  });

  check('an uncommitted report falls back to mtime, listing exactly the newer GDDs', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      // Two hours older than everything the worktree already has: not committed,
      // so `git log -1 -- <path>` finds nothing and the mtime branch runs.
      const pending = write(work, 'design/gdd/gdd-cross-review-2026-02-02.md', '# pending\n');
      const fourHoursAgo = Date.now() / 1000 - 4 * 3600;
      utimesSync(pending, fourHoursAgo, fourHoursAgo);
      // One GDD edited now, one poked back to before the report.
      write(work, 'design/gdd/damage-model.md', gdd('Damage', 'Uses combat-system.md.\n'));
      const sixHoursAgo = Date.now() / 1000 - 6 * 3600;
      utimesSync(join(work, 'design', 'gdd', 'combat-system.md'), sixHoursAgo, sixHoursAgo);

      const out = scope(work);
      assert.match(out, /^PRIOR_REVIEW: design\/gdd\/gdd-cross-review-2026-02-02\.md\n/);
      // Only the edited GDD is newer than the report; the other one was poked back
      // behind it. The CHANGED block is asserted on its own, because combat-system
      // is still named on the DEPS line (damage-model declares it).
      const changedBlock = out.slice(out.indexOf('CHANGED:'), out.indexOf('DEPS ('));
      assert.equal(changedBlock, 'CHANGED:\n  design/gdd/damage-model.md\n');
      assert.equal(
        out.slice(out.indexOf('DEPS (')),
        'DEPS (declared in changed GDDs — include these in review scope too):\n'
          + '  damage-model.md -> combat-system.md\n',
      );
    } finally {
      cleanup(work, base);
    }
  });

  check('an uncommitted report newer than every GDD reports none', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      const pending = write(work, 'design/gdd/gdd-cross-review-2026-02-02.md', '# pending\n');
      const now = Date.now() / 1000;
      utimesSync(pending, now, now);
      assert.equal(scope(work), [
        'PRIOR_REVIEW: design/gdd/gdd-cross-review-2026-02-02.md',
        'CHANGED:',
        '  (none — no GDDs modified since last review)',
        '',
      ].join('\n'));
    } finally {
      cleanup(work, base);
    }
  });

  check('a filename with a SPACE survives git status and the DEPS line', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      // The awk-field bug (2) and the word-splitting bug (3) both mangle this.
      write(work, 'design/gdd/status effects.md', gdd('Status Effects', 'See combat-system.md.\n'));
      const out = scope(work);
      assert.match(out, /^ {2}design\/gdd\/status effects\.md$/m);
      assert.match(out, /^ {2}status effects\.md -> combat-system\.md$/m);
    } finally {
      cleanup(work, base);
    }
  });

  check('a GDD containing a backslash path is normalised to forward slashes', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      write(work, 'design/gdd/combat-system.md', gdd('Combat', 'See design\\gdd\\damage-model.md.\n'));
      const out = scope(work);
      assert.match(out, /^ {2}combat-system\.md -> damage-model\.md$/m);
    } finally {
      cleanup(work, base);
    }
  });

  check('a deleted GDD is not listed ([ -f ] filter)', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      rmSync(join(work, 'design', 'gdd', 'damage-model.md'), { force: true });
      const out = scope(work);
      assert.ok(!out.includes('design/gdd/damage-model.md\n  '), out);
      assert.match(out, /^PRIOR_REVIEW: /);
    } finally {
      cleanup(work, base);
    }
  });

  check('arguments are ignored: the scope never changes', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      const plain = scope(work);
      const fixture = { root: work, script: (name) => join(work, 'dsh-src', 'scripts', name) };
      const withArgs = runScript(fixture, SCRIPT, ['--since', 'HEAD~1', 'design/gdd/*.md'], {
        env: ISOLATED_GIT,
      });
      assert.equal(withArgs.status, 0, withArgs.stderr);
      assert.equal(withArgs.stdout, plain);
    } finally {
      cleanup(work, base);
    }
  });

  check('the script derives the FIXTURE root, not this repository', () => {
    const base = makeBaseline();
    const work = makeWorktree(base);
    try {
      const out = scope(work);
      assert.ok(!out.includes('D:/Work/dsh/design'), out);
      assert.ok(existsSync(join(work, 'dsh-src', 'scripts', SCRIPT)));
      assert.match(readFileSync(join(work, 'dsh-src', 'scripts', SCRIPT), 'utf8'), /review-scope/);
    } finally {
      cleanup(work, base);
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
