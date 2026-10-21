#!/usr/bin/env node
/**
 * story-status.mjs — port of `.claude/scripts/story-status.sh`.
 *
 * The contract is stdout text plus an exit code, so every case runs the real
 * entry point as a child process and asserts on bytes.
 *
 * The fixture is a temporary mini-project containing a copy of the script, so the
 * script's own "walk up two levels to the project root" rule is part of what is
 * exercised and the repository is never touched.
 *
 * Sandbox rule: piped child stdio is denied, so stdout/stderr travel through real
 * files handed to the child by file descriptor.
 *
 * Run: node tools/tests/scripts/story-status.test.mjs
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
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 8).join('\n     ')}`);
    process.exitCode = 1;
  }
};

/** Copy the script and its imports into a fixture that owns the project root. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-story-status-'));
  const scripts = join(root, 'dsh-src', 'scripts');
  const hooks = join(root, 'dsh-src', 'hooks');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  cpSync(join(SCRIPTS_SRC, 'story-status.mjs'), join(scripts, 'story-status.mjs'));
  cpSync(join(SCRIPTS_SRC, '_runner.mjs'), join(scripts, '_runner.mjs'));
  cpSync(join(REPO_ROOT, 'dsh-src', 'hooks', 'runtime.mjs'), join(hooks, 'runtime.mjs'));
  writeFileSync(join(root, 'project.yaml'), 'name: fixture\n', 'utf8');
  return root;
}

function writeStory(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/** Run the fixture's copy with cwd = its own root. */
function run(root) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-story-run-'));
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [join(root, 'dsh-src', 'scripts', 'story-status.mjs')], {
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
check('no story files prints STORIES      none and exits 0', () => {
  const root = makeFixture();
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'STORIES      none\n');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('missing production/epics prints STORIES      none and exits 0', () => {
  const root = makeFixture();
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'STORIES      none\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('every status form is classified and ordered, COMPLETE counts Complete/Done only', () => {
  const root = makeFixture();
  try {
    const stories = {
      'production/epics/epic-a/story-04-b.md': '# s\n\nStatus: In Review\n',
      'production/epics/epic-a/story-01-b.md': '# s\n\nStatus: Done.\n', // Done. counts
      'production/epics/epic-a/story-02-b.md': '# s\n\nStatus: Not Done\n', // not done → OTHER
      'production/epics/epic-a/story-03-b.md': '# s\n\nStatus: Completed\n', // not done → OTHER
      'production/epics/epic-b/story-01-b.md': '> **Status**: In Progress\n',
      'production/epics/epic-b/story-02-b.md': '- **Status**: Ready\n',
      'production/epics/epic-b/story-03-b.md': '**Status:** Not Started\n',
      'production/epics/epic-b/story-04-b.md': '**Status:** Blocked on ADR-0003\n',
      'production/epics/epic-c/story-01-b.md': '# no status line\n',
      'production/epics/epic-c/story-02-b.md': '\tStatus:   Draft  \n',
      'production/epics/epic-c/story-03-b.md': 'Status: Complete\n',
      'production/epics/epic-c/story-04-b.md': 'Status:\n',
      'production/epics/epic-c/notes.md': 'Status: Ready\n', // not a story file
    };
    for (const [relative, content] of Object.entries(stories)) writeStory(root, relative, content);
    // A directory named like a story must not be read as one.
    mkdirSync(join(root, 'production', 'epics', 'story-d.md'), { recursive: true });

    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'IN_REVIEW    production/epics/epic-a/story-04-b.md',
      'IN_PROGRESS  production/epics/epic-b/story-01-b.md',
      'TODO         production/epics/epic-b/story-02-b.md  (Ready)',
      'TODO         production/epics/epic-b/story-03-b.md  (Not Started)',
      'BLOCKED      production/epics/epic-b/story-04-b.md  (Blocked on ADR-0003)',
      'OTHER        production/epics/epic-a/story-02-b.md  (Not Done)',
      'OTHER        production/epics/epic-a/story-03-b.md  (Completed)',
      'NO_STATUS    production/epics/epic-c/story-01-b.md',
      'OTHER        production/epics/epic-c/story-02-b.md  (Draft)',
      'OTHER        production/epics/epic-c/story-04-b.md  ()',
      'COMPLETE     2 of 12',
      '',
    ].join('\n'));
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('status is taken from the first Status: line after awk normalisation', () => {
  const root = makeFixture();
  try {
    writeStory(root, 'production/epics/e1/story-1.md', 'Status: Ready\nStatus: In Review\n');
    writeStory(root, 'production/epics/e1/story-2.md', 'Status:\tReady\t\n');
    writeStory(root, 'production/epics/e1/story-3.md', 'Status:   \n');
    const r = run(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, [
      'TODO         production/epics/e1/story-1.md  (Ready)',
      'TODO         production/epics/e1/story-2.md  (Ready)',
      'OTHER        production/epics/e1/story-3.md  ()',
      'COMPLETE     0 of 3',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nstory-status: ${passed} passed, ${failed} failed`);
