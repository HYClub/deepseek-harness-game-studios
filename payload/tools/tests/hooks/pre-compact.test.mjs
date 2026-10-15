/**
 * Tests for `dsh-src/hooks/pre-compact.mjs` (port of `.claude/hooks/pre-compact.sh`).
 * Run: node tools/tests/hooks/pre-compact.test.mjs
 *
 * The hook's output goes to the debug log (it does NOT reach the model), so the
 * assertions are about the report's exact shape and about the one effect that
 * lands: `production/session-logs/compaction-log.txt`. The bounding rules
 * (count + capped sample + "and N more") are asserted explicitly, because that is
 * the fix for the 181 KB / ~45k token dump the bash version used to emit.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup, cleanupRoot, makeFixture, readOrNull, runHook, initGitFixture, write, stubYamlHelperOff, copyRealYamlHelper,
} from './_helpers.mjs';

const HOOK = 'pre-compact.mjs';
const STATE = join('production', 'session-state', 'active.md');
const COMPACTION_LOG = join('production', 'session-logs', 'compaction-log.txt');

const ACTIVE = [
  '# Session State',
  '',
  '<!-- STATUS -->',
  'Epic: E-01 Hooks',
  'Feature: F-02 Porting',
  'Task:',
  '<!-- /STATUS -->',
  '',
  '<!-- CHECKPOINT -->',
  'Working on: session-stop.mjs',
  'Next: pre-compact.mjs',
  '<!-- /CHECKPOINT -->',
  '',
].join('\n');

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

// 1. Full report on a configured fixture.
test('full report: checkpoint region, status lines, recovery instructions, compaction log', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), ACTIVE);
    write(join(fx, 'design', 'gdd', 'combat.md'), '# Combat\n\nTODO: damage formula\n');
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^=== SESSION STATE BEFORE COMPACTION ===/);
    assert.match(r.stdout, /Timestamp: /);
    assert.match(r.stdout, /## Active Session State — checkpoint from production[\\/]session-state[\\/]active\.md/);
    // STATUS region: only Epic/Feature/Task lines carrying a value, marker lines gone.
    assert.match(r.stdout, /^Epic: E-01 Hooks$/m);
    assert.match(r.stdout, /^Feature: F-02 Porting$/m);
    assert.ok(!/^Task:$/m.test(r.stdout), 'an empty Task line must be filtered out');
    // CHECKPOINT region, markers stripped.
    assert.match(r.stdout, /Working on: session-stop\.mjs/);
    assert.match(r.stdout, /Next: pre-compact\.mjs/);
    assert.ok(!r.stdout.includes('<!-- CHECKPOINT -->'), 'marker lines must not be echoed');
    assert.ok(!r.stdout.includes('<!-- STATUS -->'), 'marker lines must not be echoed');
    assert.match(r.stdout, /Full detail \(NOT reproduced here — read the file if you need it\)/);
    assert.match(r.stdout, /## Files Modified \(git working tree\)/);
    assert.match(r.stdout, /1 design doc\(s\) contain TODO\/WIP\/PLACEHOLDER markers:/);
    assert.match(r.stdout, /  - design\/gdd\/combat\.md/);
    assert.match(r.stdout, /## Recovery Instructions/);
    assert.match(r.stdout, /=== END SESSION STATE ===\s*$/);
    // The one effect that lands.
    const log = readOrNull(join(fx, COMPACTION_LOG));
    assert.ok(log !== null, 'compaction-log.txt was not written');
    assert.match(log, /^Context compaction occurred at .+\.\n$/);
  } finally {
    cleanup(fx);
  }
});

// 2. The bounding rule for the modified-file lists.
test('modified lists are bounded: count, 20 paths, then "and N more"', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    for (let i = 0; i < 25; i += 1) write(join(fx, `notes-${String(i).padStart(2, '0')}.md`), `note ${i}\n`);
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /New untracked files \(25\):/);
    const section = r.stdout.split('New untracked files (25):')[1].split('## Design Docs')[0];
    assert.equal(section.split('\n').filter((l) => l.startsWith('  - ')).length, 20, 'sample must be capped at 20');
    assert.match(section, /\.\.\. and 5 more \(run: git status\)/);
  } finally {
    cleanup(fx);
  }
});

// 3. No CHECKPOINT block: fall back to 20 lines AND say so.
test('missing CHECKPOINT block: 20-line fallback with an explicit warning', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    const lines = ['# Session State', '', '<!-- STATUS -->', 'Epic: E-09', '<!-- /STATUS -->', ''];
    for (let i = 0; i < 40; i += 1) lines.push(`plain line ${i}`);
    write(join(fx, STATE), `${lines.join('\n')}\n`);
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(no CHECKPOINT block — showing the first 20 lines instead;/);
    assert.match(r.stdout, /re-create this file from \.claude\/docs\/templates\/session-state\.md\)/);
    // The file is 6 header lines + 40 numbered lines, so the first 20 lines end at
    // "plain line 13"; the fallback must not spill past that.
    assert.match(r.stdout, /^plain line 13$/m);
    assert.ok(!r.stdout.includes('plain line 14'), 'the fallback must stay at 20 lines');
  } finally {
    cleanup(fx);
  }
});

// 4. No active.md at all.
test('missing active.md: points at the template and reports no WIP', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /## No active session state file found/);
    assert.match(r.stdout, /Consider maintaining production\/session-state\/active\.md for better recovery\./);
    assert.match(r.stdout, /Template: \.claude\/docs\/templates\/session-state\.md/);
    assert.match(r.stdout, /\(no WIP markers found in design docs\)/);
    assert.match(r.stdout, /\(no uncommitted changes\)/);
  } finally {
    cleanup(fx);
  }
});

// 5. The WIP doc list is capped too.
test('WIP doc list is capped at 20 with an "and N more" tail', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    for (let i = 0; i < 23; i += 1) write(join(fx, 'design', 'gdd', `sys-${String(i).padStart(2, '0')}.md`), '# x\n\nWIP\n');
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /23 design doc\(s\) contain TODO\/WIP\/PLACEHOLDER markers:/);
    const section = r.stdout.split('23 design doc(s) contain TODO/WIP/PLACEHOLDER markers:')[1].split('## Recovery Instructions')[0];
    assert.equal(section.split('\n').filter((l) => l.startsWith('  - ')).length, 20);
    assert.match(section, /\.\.\. and 3 more/);
  } finally {
    cleanup(fx);
  }
});

// 6. Malformed / empty stdin never throws and never blocks.
test('malformed and empty stdin: exit 0, report still produced', () => {
  const fx = makeFixture();
  try {
    initGitFixture(fx);
    write(join(fx, STATE), ACTIVE);
    for (const raw of ['', '   ', 'not json', '{"hook_event_name": ', 'null']) {
      const r = runHook(HOOK, raw, { cwd: fx });
      assert.equal(r.status, 0, `stdin ${JSON.stringify(raw)} produced exit ${r.status}`);
      assert.ok(!r.stderr.includes('hook error'), `uncaught throw for ${JSON.stringify(raw)}: ${r.stderr}`);
      assert.match(r.stdout, /=== END SESSION STATE ===/);
    }
  } finally {
    cleanup(fx);
  }
});

// 7. features.session_state: off is a no-op.
test('features.session_state off: no output and no compaction log', () => {
  const fx = makeFixture();
  try {
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    write(join(fx, STATE), ACTIVE);
    stubYamlHelperOff(fx);
    const r = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'a disabled hook must stay silent');
    assert.ok(!existsSync(join(fx, COMPACTION_LOG)), 'compaction log written while disabled');
  } finally {
    cleanup(fx);
  }
});

// 8. End-to-end with the REAL resolver, so the actual `session_state_enabled`
//    state machine (features: block, project.local.yaml precedence) is exercised.
test('real resolver: features.session_state off suppresses the report', (ctx) => {
  const fx = makeFixture();
  try {
    if (!copyRealYamlHelper(fx)) return ctx.skip('tools/yaml-helper.mjs missing from the repo');
    write(join(fx, STATE), ACTIVE);
    write(join(fx, 'project.yaml'), 'features:\n  session_state: off\n');
    const off = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, '', 'the real resolver must silence the hook when disabled');
    assert.ok(!existsSync(join(fx, COMPACTION_LOG)), 'compaction log written while disabled');

    // project.local.yaml wins, and turning it back on restores the report.
    write(join(fx, 'project.local.yaml'), 'features:\n  session_state: on\n');
    const on = runHook(HOOK, { hook_event_name: 'PreCompact' }, { cwd: fx });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /=== SESSION STATE BEFORE COMPACTION ===/);
    assert.ok(existsSync(join(fx, COMPACTION_LOG)), 'compaction log missing while enabled');
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
