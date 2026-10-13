#!/usr/bin/env node
/**
 * gdd-structure-check.mjs — port of `.claude/scripts/gdd-structure-check.sh`.
 *
 * The contract is stdout text plus an exit code, so every case runs the real entry
 * point as a child process and asserts on bytes. The fixture is a temporary
 * mini-project containing a copy of the script, so its root rule is exercised and
 * the repository is never touched.
 *
 * Sandbox rule: piped child stdio is denied, so stdout/stderr travel through real
 * files handed to the child by file descriptor.
 *
 * Run: node tools/tests/scripts/gdd-structure-check.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS_SRC = join(REPO_ROOT, 'dsh-src', 'scripts');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 10).join('\n     ')}`);
    process.exitCode = 1;
  }
};

/** Copy the script and its imports into a fixture that owns the project root. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gdd-structure-'));
  const scripts = join(root, 'dsh-src', 'scripts');
  const hooks = join(root, 'dsh-src', 'hooks');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  cpSync(join(SCRIPTS_SRC, 'gdd-structure-check.mjs'), join(scripts, 'gdd-structure-check.mjs'));
  cpSync(join(SCRIPTS_SRC, '_runner.mjs'), join(scripts, '_runner.mjs'));
  cpSync(join(REPO_ROOT, 'dsh-src', 'hooks', 'runtime.mjs'), join(hooks, 'runtime.mjs'));
  writeFileSync(join(root, 'project.yaml'), 'name: fixture\n', 'utf8');
  return root;
}

function writeFile(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/** Run the fixture's copy with cwd = its own root. */
function run(root, args = [], cwd = root) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gdd-run-'));
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [join(root, 'dsh-src', 'scripts', 'gdd-structure-check.mjs'), ...args],
      { cwd, stdio: ['ignore', outFd, errFd], windowsHide: true, timeout: 60_000 },
    );
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n');
  const stderr = readFileSync(errFile, 'utf8').replace(/\r\n/g, '\n');
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

// --- cases ----------------------------------------------------------------
check('a conforming GDD reports all eight sections PRESENT and no ABSENT line', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/combat.md', [
      '# Combat',
      '## Overview',
      '## Player Fantasy',
      '## Detailed Design', // the template's name for "Detailed Rules"
      '## Formulas',
      '## Edge Cases',
      '## Dependencies',
      '## Tuning Knobs',
      '## Acceptance Criteria',
      '',
    ].join('\n'));
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'combat.md PRESENT: Overview,Player Fantasy,Detailed Rules,Formulas,Edge Cases,Dependencies,Tuning Knobs,Acceptance Criteria\n');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('missing sections land on the ABSENT line with its two spaces, present ones stay in order', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/loot.md', '# Loot\n## Overview\n## Detailed Rules\n## Edge Cases\n');
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'loot.md PRESENT: Overview,Detailed Rules,Edge Cases',
      'loot.md ABSENT:  Player Fantasy,Formulas,Dependencies,Tuning Knobs,Acceptance Criteria',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('both heading spellings of Detailed Rules are accepted; numbering and deeper levels too', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/a.md', '### Detailed Rules\n');
    writeFile(root, 'design/gdd/b.md', '## 3. Detailed Design\n');
    writeFile(root, 'design/gdd/c.md', '#### 4) Overview\n');
    writeFile(root, 'design/gdd/d.md', '\t## Overview\n'); // leading tab: `^##` needs column 0
    const r = run(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^a\.md PRESENT: Detailed Rules$/m);
    assert.match(r.stdout, /^b\.md PRESENT: Detailed Rules$/m);
    assert.match(r.stdout, /^c\.md PRESENT: Overview$/m);
    assert.match(r.stdout, /^d\.md PRESENT: $/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('governance and registry docs are skipped; a bare directory yields the explicit message', () => {
  const root = makeFixture();
  try {
    const r0 = run(root);
    assert.equal(r0.status, 0);
    assert.equal(r0.stdout, 'No system GDDs found in design/gdd/.\n');

    writeFile(root, 'design/gdd/game-concept.md', '## Overview\n');
    writeFile(root, 'design/gdd/systems-index.md', '## Overview\n');
    writeFile(root, 'design/gdd/game-pillars.md', '## Overview\n');
    writeFile(root, 'design/gdd/gdd-cross-review-1.md', '## Overview\n');
    writeFile(root, 'design/gdd/gameplay-tags.md', '## Overview\n');
    writeFile(root, 'design/gdd/fixture-swap-ledger.md', '## Overview\n');
    writeFile(root, 'design/gdd/entity-registry.md', '## Overview\n');
    writeFile(root, 'design/gdd/sound-bible.md', '## Overview\n');
    writeFile(root, 'design/gdd/reviews/comment.md', '## Overview\n'); // nested: out of scope
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'No system GDDs found in design/gdd/.\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('one explicit file argument is checked and a missing path exits 1 with Not found', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/foo.md', '## Overview\n## Formulas\n');
    const r = run(root, ['design/gdd/foo.md']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'foo.md PRESENT: Overview,Formulas',
      'foo.md ABSENT:  Player Fantasy,Detailed Rules,Edge Cases,Dependencies,Tuning Knobs,Acceptance Criteria',
      '',
    ].join('\n'));

    const missing = run(root, ['design/gdd/nope.md']);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, 'Not found: design/gdd/nope.md\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('a GDD with no headings reports every section ABSENT', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/emptyish.md', '# Title only\n\nProse.\n');
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'emptyish.md PRESENT: ',
      'emptyish.md ABSENT:  Overview,Player Fantasy,Detailed Rules,Formulas,Edge Cases,Dependencies,Tuning Knobs,Acceptance Criteria',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\ngdd-structure-check: ${passed} passed, ${failed} failed`);
