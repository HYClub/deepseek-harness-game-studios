/**
 * Tests for `dsh-src/hooks/post-compact.mjs` (port of `.claude/hooks/post-compact.sh`).
 * Run: node tools/tests/hooks/post-compact.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cleanupRoot, makeFixture, runHook, write, stubYamlHelperOff, copyRealYamlHelper } from './_helpers.mjs';

const HOOK = 'post-compact.mjs';
const ACTIVE = join('production', 'session-state', 'active.md');

const results = [];
function test(name, fn) {
  let skipped = false;
  try {
    fn({ skip: (reason) => { skipped = true; results.push(['skip', `${name} — ${reason}`]); } });
    if (!skipped) results.push(['pass', name]);
  } catch (error) {
    results.push(['FAIL', `${name} — ${error.message}`]);
  }
}

// 1. Normal path.
test('active.md present: reports the path and the line count, tells the model to read it', () => {
  const fx = makeFixture();
  try {
    write(join(fx, ACTIVE), ['line one', 'line two', 'line three'].join('\n') + '\n');
    const r = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^=== Context Restored After Compaction ===/);
    assert.match(r.stdout, /Session state file exists: production[\\/]session-state[\\/]active\.md \(3 lines\)/);
    assert.match(r.stdout, /IMPORTANT: Read this file now to restore your working context\./);
    assert.match(r.stdout, /It contains: current task, decisions made, files in progress, open questions\./);
    assert.match(r.stdout, /=========================================\s*$/);
    assert.ok(!r.stdout.includes('line one'), 'the file body must not be dumped into the output');
  } finally {
    cleanup(fx);
  }
});

// 2. The line count reproduces `wc -l` (newline characters, not lines).
test('line count matches wc -l semantics: an unterminated final line is not counted', () => {
  const fx = makeFixture();
  try {
    write(join(fx, ACTIVE), 'no trailing newline');
    const r = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(0 lines\)/);

    write(join(fx, ACTIVE), 'a\nb\n');
    const r2 = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.match(r2.stdout, /\(2 lines\)/);
  } finally {
    cleanup(fx);
  }
});

// 3. Missing file.
test('missing active.md: says so and points at production/session-logs/', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No session state file found at production[\\/]session-state[\\/]active\.md/);
    assert.match(r.stdout, /If you were mid-task, check production\/session-logs\/ for the last session audit\./);
    assert.match(r.stdout, /=========================================/);
  } finally {
    cleanup(fx);
  }
});

// 4. Malformed / empty stdin.
test('malformed and empty stdin: exit 0 and a complete report', () => {
  const fx = makeFixture();
  try {
    write(join(fx, ACTIVE), 'x\n');
    for (const raw of ['', '  ', 'not json', '[[', 'null']) {
      const r = runHook(HOOK, raw, { cwd: fx });
      assert.equal(r.status, 0, `stdin ${JSON.stringify(raw)} produced exit ${r.status}`);
      assert.ok(!r.stderr.includes('hook error'), `uncaught throw for ${JSON.stringify(raw)}: ${r.stderr}`);
      assert.match(r.stdout, /=== Context Restored After Compaction ===/);
      assert.match(r.stdout, /\(1 lines\)/);
    }
  } finally {
    cleanup(fx);
  }
});

// 5. features.session_state: off is a no-op.
test('features.session_state off: silent exit 0', () => {
  const fx = makeFixture();
  try {
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    write(join(fx, ACTIVE), 'x\n');
    stubYamlHelperOff(fx);
    const r = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'a disabled hook must stay silent');
  } finally {
    cleanup(fx);
  }
});

// 6. Missing resolver defaults to ON, like the bash original, and reports the skip.
test('missing tools/yaml-helper.mjs: defaults to on and says the check did not run', () => {
  const fx = makeFixture();
  try {
    write(join(fx, ACTIVE), 'x\n');
    const r = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(fx, ACTIVE)));
    assert.match(r.stdout, /Session state file exists:/);
    assert.match(r.stderr, /features\.session_state NOT checked/);
  } finally {
    cleanup(fx);
  }
});

// 7. End-to-end with the REAL resolver.
test('real resolver: features.session_state off is honored end to end', (ctx) => {
  const fx = makeFixture();
  try {
    if (!copyRealYamlHelper(fx)) return ctx.skip('tools/yaml-helper.mjs missing from the repo');
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    write(join(fx, ACTIVE), 'x\n');
    const off = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, '', 'the real resolver must silence the hook when disabled');

    write(join(fx, 'project.yaml'), 'engine:\n  name: godot\n');
    const on = runHook(HOOK, { hook_event_name: 'PostCompact' }, { cwd: fx });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Session state file exists:/);
  } finally {
    cleanup(fx);
  }
});

cleanupRoot();

let failed = 0;
for (const [state, name] of results) {
  if (state === 'FAIL') failed += 1;
  process.stdout.write(`${state === 'pass' ? 'ok  ' : state === 'skip' ? 'skip' : 'FAIL'} ${name}\n`);
}
const skipped = results.filter(([state]) => state === 'skip').length;
process.stdout.write(`\n${results.length - failed - skipped}/${results.length} passed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`);
process.exit(failed === 0 ? 0 : 1);
