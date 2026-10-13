/**
 * Tests for `dsh-src/hooks/notify.mjs` (port of `.claude/hooks/notify.sh`).
 * Run: node tools/tests/hooks/notify.test.mjs
 *
 * The toast is NOT delivered — see the file header of `notify.mjs` for why the
 * PowerShell path cannot run in the DSH sandbox and what replaces it. These tests
 * pin the part that is preserved: message extraction, the generic fallback, the
 * 200-unit truncation, and the fact that the notice goes out as a structured
 * `systemMessage` (the channel the bridge actually honours) plus stderr.
 */
import assert from 'node:assert/strict';
import { cleanup, cleanupRoot, makeFixture, runHook } from './_helpers.mjs';

const HOOK = 'notify.mjs';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['pass', name]);
  } catch (error) {
    results.push(['FAIL', `${name} — ${error.message}`]);
  }
}

function parseStdout(stdout) {
  const text = stdout.trim();
  assert.ok(text.startsWith('{'), `stdout is not a structured decision: ${JSON.stringify(text)}`);
  return JSON.parse(text);
}

// 1. Normal path.
test('message: emitted as a systemMessage and mirrored to stderr', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { hook_event_name: 'Notification', message: 'Waiting for input' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    const payload = parseStdout(r.stdout);
    assert.deepEqual(payload, { systemMessage: 'Notification: Waiting for input' });
    assert.match(r.stderr, /^Notification: Waiting for input\n$/);
  } finally {
    cleanup(fx);
  }
});

// 2. The bug the bash fallback had: whitespace around the colon.
test('whitespace around the colon in the raw payload is tolerated', () => {
  const fx = makeFixture();
  try {
    // Pretty-printed JSON, which the old `grep -oE "\"message\":\""` fallback missed.
    const raw = '{\n  "hook_event_name": "Notification",\n  "message" : "Pretty payload"\n}';
    const r = runHook(HOOK, raw, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseStdout(r.stdout).systemMessage, 'Notification: Pretty payload');
  } finally {
    cleanup(fx);
  }
});

// 3. Absent / empty message.
test('absent or empty message falls back to the generic text', () => {
  const fx = makeFixture();
  try {
    for (const input of [{ hook_event_name: 'Notification' }, { hook_event_name: 'Notification', message: '' }]) {
      const r = runHook(HOOK, input, { cwd: fx });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(parseStdout(r.stdout).systemMessage, 'Notification: DSGS needs your attention');
    }
  } finally {
    cleanup(fx);
  }
});

// 4. Truncation at 200 units, and no splitting of a surrogate pair.
test('long messages are truncated at 200 units and emoji are not split', () => {
  const fx = makeFixture();
  try {
    const exactly = 'a'.repeat(200);
    const r1 = runHook(HOOK, { message: exactly }, { cwd: fx });
    assert.equal(parseStdout(r1.stdout).systemMessage, `Notification: ${exactly}`, '200 units must pass through unchanged');

    const tooLong = 'b'.repeat(250);
    const r2 = runHook(HOOK, { message: tooLong }, { cwd: fx });
    assert.equal(parseStdout(r2.stdout).systemMessage, `Notification: ${'b'.repeat(200)}`);

    // 199 ASCII chars + a surrogate pair straddling the boundary: the pair is dropped.
    const straddle = `${'c'.repeat(199)}😀tail`;
    const r3 = runHook(HOOK, { message: straddle }, { cwd: fx });
    const delivered = parseStdout(r3.stdout).systemMessage.replace('Notification: ', '');
    assert.equal(delivered, 'c'.repeat(199), 'the surrogate pair must be dropped rather than halved');
  } finally {
    cleanup(fx);
  }
});

// 5. Malformed / empty stdin.
test('malformed and empty stdin: exit 0 with the generic notice', () => {
  const fx = makeFixture();
  try {
    for (const raw of ['', '   ', 'not json', '{"message": ', 'null', '[]']) {
      const r = runHook(HOOK, raw, { cwd: fx });
      assert.equal(r.status, 0, `stdin ${JSON.stringify(raw)} produced exit ${r.status}`);
      assert.ok(!r.stderr.includes('hook error'), `uncaught throw for ${JSON.stringify(raw)}: ${r.stderr}`);
      assert.equal(parseStdout(r.stdout).systemMessage, 'Notification: DSGS needs your attention');
    }
  } finally {
    cleanup(fx);
  }
});

// 6. No fixture configuration at all: the hook is config-independent.
test('non-project cwd: still notifies and never blocks', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { message: 'no project here' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseStdout(r.stdout).systemMessage, 'Notification: no project here');
  } finally {
    cleanup(fx);
  }
});

cleanupRoot();

let failed = 0;
for (const [state, name] of results) {
  if (state !== 'pass') failed += 1;
  process.stdout.write(`${state === 'pass' ? 'ok  ' : 'FAIL'} ${name}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed === 0 ? 0 : 1);

