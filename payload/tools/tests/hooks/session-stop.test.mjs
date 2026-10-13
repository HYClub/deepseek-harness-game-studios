/**
 * Tests for `dsh-src/hooks/session-stop.mjs` (port of `.claude/hooks/session-stop.sh`).
 * Run: node tools/tests/hooks/session-stop.test.mjs
 *
 * What is covered: the normal allow path, the archive-once de-duplication guard
 * (the load-bearing fix for a 17.5 MB session log), the subagent spawn tally and
 * its no-session-id refusal, malformed/empty stdin, a non-git tree, and
 * `features.session_state: off`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup, cleanupRoot, makeFixture, readOrNull, runHook, initGitFixture, write, stubYamlHelperOff, copyRealYamlHelper,
} from './_helpers.mjs';

const HOOK = 'session-stop.mjs';
const LOG = join('production', 'session-logs', 'session-log.md');
const STATE = join('production', 'session-state', 'active.md');
const AUDIT = join('production', 'session-logs', 'agent-audit.log');
const COST = join('production', 'session-logs', 'session-cost.md');

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

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

// 1. Normal allow path: exit 0, archive written, nothing on stdout.
test('normal path: exit 0, active.md archived once, no stdout decision', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), '# Session\n\nTask: port hooks\n<!-- CHECKPOINT -->\nstep 1\n<!-- /CHECKPOINT -->\n');
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-a' }, { cwd: fx });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout, '', 'Stop must allow silently (no structured decision)');
    const log = readOrNull(join(fx, LOG));
    assert.ok(log !== null, 'session-log.md was not created');
    assert.match(log, /## Archived Session State: \d{8}_\d{6}/);
    assert.match(log, /Task: port hooks/);
    assert.match(log, /## Session End: \d{8}_\d{6}/);
    assert.match(log, /### Commits[\s\S]*fixture: initial commit/);
  } finally {
    cleanup(fx);
  }
});

// 2. The de-duplication guard: Stop fires per response, not per session.
test('archive guard: unchanged active.md and git activity are not re-appended', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), '# Session\n\nTask: dedup\n');
    const input = { hook_event_name: 'Stop', session_id: 'sess-b' };

    const first = runHook(HOOK, input, { cwd: fx });
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = readFileSync(join(fx, LOG), 'utf8');
    assert.equal(countOccurrences(afterFirst, '## Archived Session State:'), 1);
    assert.equal(countOccurrences(afterFirst, '## Session End:'), 1);

    const second = runHook(HOOK, input, { cwd: fx });
    assert.equal(second.status, 0, second.stderr);
    const afterSecond = readFileSync(join(fx, LOG), 'utf8');
    assert.equal(countOccurrences(afterSecond, '## Archived Session State:'), 1, 'unchanged state re-archived');
    assert.equal(countOccurrences(afterSecond, '## Session End:'), 1, 'unchanged git activity re-appended');

    // A real content change archives exactly one more copy.
    write(join(fx, STATE), '# Session\n\nTask: dedup, revised\n');
    runHook(HOOK, input, { cwd: fx });
    const afterThird = readFileSync(join(fx, LOG), 'utf8');
    assert.equal(countOccurrences(afterThird, '## Archived Session State:'), 2, 'changed state was not archived');
    assert.match(afterThird, /Task: dedup, revised/);
  } finally {
    cleanup(fx);
  }
});

// 3. active.md is archived, never deleted.
test('active.md survives the Stop hook', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), 'checkpoint body\n');
    runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-c' }, { cwd: fx });
    assert.ok(existsSync(join(fx, STATE)), 'active.md must persist across a clean exit');
  } finally {
    cleanup(fx);
  }
});

// 4. Subagent spawn tally.
test('spawn tally: counts only this session and writes session-cost.md', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(
      join(fx, AUDIT),
      [
        '20260701_090000 | sess-old | Agent invoked: qa-tester',
        '20260717_100000 | sess-d | Agent invoked: gameplay-programmer',
        '20260717_100100 | sess-d | Agent invoked: gameplay-programmer',
        '20260717_100200 | sess-d | Agent invoked: art-director',
      ].join('\n'),
    );
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-d' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    const cost = readOrNull(join(fx, COST));
    assert.ok(cost !== null, 'session-cost.md was not written');
    assert.match(cost, /Subagent spawns this session: \*\*3\*\*/);
    assert.match(cost, /\| gameplay-programmer \| 2 \|/);
    assert.match(cost, /\| art-director \| 1 \|/);
    assert.ok(!cost.includes('qa-tester'), 'another session leaked into the tally');
    assert.match(r.stderr, /Subagent spawns this session: 3/);
  } finally {
    cleanup(fx);
  }
});

// 5. No honest per-session number => report nothing.
test('spawn tally: absent session id reports nothing', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, AUDIT), '20260717_100000 | sess-d | Agent invoked: gameplay-programmer\n');
    for (const input of [{ hook_event_name: 'Stop' }, { hook_event_name: 'Stop', session_id: 'unknown' }, {}]) {
      const r = runHook(HOOK, input, { cwd: fx });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(join(fx, COST)), 'a total spanning sessions must not be reported');
    }
  } finally {
    cleanup(fx);
  }
});

// 6. Malformed or empty stdin must not crash the hook.
test('malformed and empty stdin: exit 0, no crash trace on stdout', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), 'state body\n');
    for (const raw of ['', '   ', 'not json at all', '{"session_id": ', '[]', 'null']) {
      const r = runHook(HOOK, raw, { cwd: fx });
      assert.equal(r.status, 0, `stdin ${JSON.stringify(raw)} produced exit ${r.status}`);
      assert.ok(!r.stderr.includes('hook error'), `uncaught throw for stdin ${JSON.stringify(raw)}: ${r.stderr}`);
    }
    assert.match(readFileSync(join(fx, LOG), 'utf8'), /state body/);
  } finally {
    cleanup(fx);
  }
});

// 7. No git repository: degrade, do not throw.
test('non-git fixture: still exits 0 and records no git activity', () => {
  const fx = makeFixture();
  try {
    write(join(fx, STATE), 'no git here\n');
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-e' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(fx, LOG), 'utf8');
    assert.match(log, /## Archived Session State:/, 'state archive must not depend on git');
    assert.ok(!log.includes('## Session End:'), 'no git activity should have been recorded');
  } finally {
    cleanup(fx);
  }
});

// 8. features.session_state: off is a no-op.
test('features.session_state off: no log directory is created', () => {
  const fx = makeFixture();
  try {
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    write(join(fx, STATE), 'should not be archived\n');
    stubYamlHelperOff(fx);
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-f' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(fx, 'production', 'session-logs')), 'hook ran while disabled');
  } finally {
    cleanup(fx);
  }
});

// 9. A helper that cannot be found at all defaults to ON, like the bash original,
//    and says so on stderr instead of skipping the gate silently.
test('missing tools/yaml-helper.mjs: defaults to on and reports the skipped check', () => {
  const fx = makeFixture();
  try {
    write(join(fx, STATE), 'default on\n');
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-g' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(fx, LOG)), 'absent helper must not disable the hook');
    assert.match(r.stderr, /tools\/yaml-helper\.mjs not found in the project root/);
    assert.match(r.stderr, /features\.session_state NOT checked/);
  } finally {
    cleanup(fx);
  }
});

// 10. End-to-end with the REAL resolver: `features.session_state: off` in the
//     fixture's project.yaml must silence the hook. (Case 8 uses a stub, so this
//     one exercises the actual `session_state_enabled` state machine.)
test('real resolver: features.session_state off is honored end to end', (ctx) => {
  const fx = makeFixture();
  try {
    if (!copyRealYamlHelper(fx)) return ctx.skip('tools/yaml-helper.mjs missing from the repo');
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    write(join(fx, STATE), 'should not be archived\n');
    const r = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-h' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(fx, 'production', 'session-logs')), 'hook ran while disabled');

    // …and the same fixture with the flag on writes the archive.
    write(join(fx, 'project.yaml'), 'engine:\n  name: godot\n');
    const r2 = runHook(HOOK, { hook_event_name: 'Stop', session_id: 'sess-h' }, { cwd: fx });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(readFileSync(join(fx, LOG), 'utf8'), /should not be archived/);
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
