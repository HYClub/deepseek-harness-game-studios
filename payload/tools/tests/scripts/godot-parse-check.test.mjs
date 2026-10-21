#!/usr/bin/env node
/**
 * godot-parse-check.mjs — Node entry point for the upstream Godot parse check
 * (`.claude/scripts/godot-parse-check.gd`).
 *
 * Two layers are tested, and neither needs a real engine:
 *   1. `buildGodotArgs()` — the exact argv the wrapper hands to Godot, asserted directly.
 *   2. the process contract — exit 2 with no paths, exit 3 with an unusable engine, and
 *      `--help`. A missing engine must never look like a passing check, which is why the
 *      wrapper uses a distinct code 3.
 *
 * Sandbox rule: piped child stdio is denied, so stdout/stderr travel through real files
 * handed to the child, never through pipes.
 *
 * Set DSGS_TEST_GODOT=1 to additionally run the check against a real engine on PATH.
 *
 * Run: node tools/tests/scripts/godot-parse-check.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'dsh-src', 'scripts', 'godot-parse-check.mjs');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n').join('\n        ')}`);
  }
};

/** Run the wrapper with stdio redirected to files (pipes are denied by the sandbox). */
function runWrapper(args) {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-godot-'));
  const out = join(dir, 'out.txt');
  const err = join(dir, 'err.txt');
  const outFd = openSync(out, 'w');
  const errFd = openSync(err, 'w');
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  const text = { stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, ...text };
}

const mod = await import(pathToFileURL(SCRIPT).href);
const { buildGodotArgs } = mod;

check('import phase builds the class-cache invocation', () => {
  assert.deepEqual(buildGodotArgs('import'), ['--headless', '--path', '.', '--import']);
});

check('check phase passes the script and the paths after --', () => {
  assert.deepEqual(
    buildGodotArgs('check', ['res://src/a.gd', 'res://src/b.gd']),
    ['--headless', '--path', '.', '-s', 'res://.dsh/scripts/godot-parse-check.gd', '--', 'res://src/a.gd', 'res://src/b.gd'],
  );
});

check('no paths is exit 2, never a silent pass', () => {
  const r = runWrapper([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no scripts given/);
});

check('an unusable engine is exit 3 and says how to fix it', () => {
  const r = runWrapper(['--godot', join(tmpdir(), 'definitely-not-godot.exe'), 'res://src/a.gd']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /failed to start|no Godot executable/);
});

check('--help prints usage and exits 0', () => {
  const r = runWrapper(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: node \.dsh\/scripts\/godot-parse-check\.mjs/);
});

if (process.env.DSGS_TEST_GODOT === '1') {
  check('real engine run reports ok: per script', () => {
    const r = runWrapper(['--no-import', 'res://.dsh/scripts/godot-parse-check.gd']);
    assert.ok(r.status !== 3, `engine was not found:\n${r.stderr}`);
    assert.match(r.stdout, /ok: res:\/\/\.dsh\/scripts\/godot-parse-check\.gd/);
  });
} else {
  console.log('  skip  real engine run (set DSGS_TEST_GODOT=1 to enable)');
}

console.log(`\ngodot-parse-check.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


