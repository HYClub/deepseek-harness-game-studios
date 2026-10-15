#!/usr/bin/env node
/**
 * adr-dep-graph.mjs — port of `.claude/scripts/adr-dep-graph.sh`.
 *
 * The contract is stdout text plus an exit code, so every case runs the real entry
 * point as a child process and asserts on bytes. The fixture is a temporary
 * mini-project containing a copy of the script, so its root rule is exercised and
 * the repository is never touched.
 *
 * Sandbox rule: piped child stdio is denied, so stdout/stderr travel through real
 * files handed to the child by file descriptor.
 *
 * Run: node tools/tests/scripts/adr-dep-graph.test.mjs
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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-adr-dep-'));
  const scripts = join(root, 'dsh-src', 'scripts');
  const hooks = join(root, 'dsh-src', 'hooks');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  cpSync(join(SCRIPTS_SRC, 'adr-dep-graph.mjs'), join(scripts, 'adr-dep-graph.mjs'));
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

/** An ADR body with a `## ADR Dependencies` table. */
function adr(dependsOn) {
  return [
    '# ADR',
    '',
    '## ADR Dependencies',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Depends On** | ${dependsOn} |`,
    '| **Enables** | None |',
    '| **Blocks** | None |',
    '',
    '## Context',
    '',
  ].join('\n');
}

function run(root, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-adr-run-'));
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [join(root, 'dsh-src', 'scripts', 'adr-dep-graph.mjs'), ...args], {
      cwd: root,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
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
check('a missing ADR directory reports ADRS: 0 and (none …) and exits 0', () => {
  const root = makeFixture();
  try {
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 0',
      'EDGES:',
      '  (none — no ADRs in docs/architecture)',
      '',
    ].join('\n'));
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('no Depends-On row lands in NO_DEPS_SECTION; "None" is a real leaf and is not reported', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0001-first.md', '# no dependency section at all\n');
    writeFile(root, 'docs/architecture/adr-0002-second.md', adr('None'));
    writeFile(root, 'docs/architecture/notes.md', 'not an adr\n');
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 2',
      'EDGES:',
      '  (none)',
      'NO_DEPS_SECTION: adr-0001',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('edges are lowercased, de-duplicated, self-references dropped, upper-case ADR refs resolved', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0003-third.md', adr('ADR-0001, adr-0001, ADR-0002, ADR-0003'));
    writeFile(root, 'docs/architecture/adr-0002-second.md', adr('ADR-0001'));
    writeFile(root, 'docs/architecture/adr-0001-first.md', adr('None'));
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 3',
      'EDGES:',
      '  adr-0002 -> adr-0001',
      '  adr-0003 -> adr-0001',
      '  adr-0003 -> adr-0002',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('a cycle is reported as one CYCLE line per stuck node, with its out-edges', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0001-a.md', adr('ADR-0002'));
    writeFile(root, 'docs/architecture/adr-0002-b.md', adr('ADR-0003'));
    writeFile(root, 'docs/architecture/adr-0003-c.md', adr('ADR-0001'));
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 3',
      'EDGES:',
      '  adr-0001 -> adr-0002',
      '  adr-0002 -> adr-0003',
      '  adr-0003 -> adr-0001',
      'CYCLE: adr-0001 -> adr-0002',
      'CYCLE: adr-0002 -> adr-0003',
      'CYCLE: adr-0003 -> adr-0001',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('an acyclic diamond prints no CYCLE line', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0003-top.md', adr('ADR-0001, ADR-0002'));
    writeFile(root, 'docs/architecture/adr-0002-mid.md', adr('ADR-0001'));
    writeFile(root, 'docs/architecture/adr-0001-leaf.md', adr('None'));
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /CYCLE:/);
    assert.match(r.stdout, /^  adr-0003 -> adr-0001$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('a Depends-On row outside the ADR Dependencies section is ignored', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0001-a.md', [
      '# ADR',
      '',
      '## ADR Dependencies',
      '',
      '| **Depends On** | None |',
      '',
      '## Enables',
      '',
      'This **Depends On** ADR-0002 in prose, but the section has ended.',
      '',
    ].join('\n'));
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 1',
      'EDGES:',
      '  (none)',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('only the nodes that cannot be peeled are reported, and paths with spaces survive', () => {
  const root = makeFixture();
  try {
    // adr-0001 <-> adr-0002 is a cycle; adr-0003 depends on the cycle, so it can
    // never be peeled either (out-degree never reaches 0) and is reported too —
    // that is the original awk's behaviour, not a bug. The unrelated graph
    // (adr-0004 has no edges, adr-0009 -> adr-0008) is never reported.
    writeFile(root, 'docs/architecture/adr-0001-a.md', adr('ADR-0002'));
    writeFile(root, 'docs/architecture/adr-0002-b.md', adr('ADR-0001'));
    writeFile(root, 'docs/architecture/adr-0003-c.md', adr('ADR-0001'));
    writeFile(root, 'docs/architecture/adr-0004-d.md', adr('None'));
    writeFile(root, 'my adrs/adr-0009-spaced.md', adr('ADR-0008'));
    const r = run(root, ['docs/architecture']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n').filter((line) => line.startsWith('CYCLE:')).sort(), [
      'CYCLE: adr-0001 -> adr-0002',
      'CYCLE: adr-0002 -> adr-0001',
      'CYCLE: adr-0003 -> adr-0001',
    ]);

    const spaced = run(root, ['my adrs']);
    assert.equal(spaced.status, 0);
    assert.equal(spaced.stdout, [
      'ADRS: 1',
      'EDGES:',
      '  adr-0009 -> adr-0008',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('the default directory is docs/architecture relative to the project root', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'docs/architecture/adr-0002-b.md', adr('ADR-0001'));
    writeFile(root, 'docs/architecture/adr-0001-a.md', adr('None'));
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'ADRS: 2',
      'EDGES:',
      '  adr-0002 -> adr-0001',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nadr-dep-graph: ${passed} passed, ${failed} failed`);
