#!/usr/bin/env node
/**
 * verify-hooks-events.mjs — the per-event verdict logic.
 *
 * The verifier itself needs a live session (and an LLM run) to produce its input, so the part
 * that can silently lie — "which events count as live, which as gaps" — is tested here with
 * synthetic audit logs. A mount-only event must never count as live, and a provokable event
 * that did not fire must never be excused.
 *
 * Run: node tools/tests/scripts/verify-hooks-events.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODULE = join(REPO_ROOT, 'tools', 'verify-hooks-events.mjs');
const { classifyInvocations } = await import(pathToFileURL(MODULE).href);

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

/** The shape of the real config: events → the commands they run. */
const events = new Map([
  ['SessionStart', ['node ".dsh/hooks/session-start.mjs"', 'node ".dsh/hooks/detect-gaps.mjs"']],
  ['PreToolUse', ['node ".dsh/hooks/validate-commit.mjs"']],
  ['PostToolUse', ['node ".dsh/hooks/rules-context.mjs"']],
  ['Notification', ['node ".dsh/hooks/notify.mjs"']],
  ['PreCompact', ['node ".dsh/hooks/pre-compact.mjs"']],
  ['Stop', ['node ".dsh/hooks/session-stop.mjs"']],
]);

check('an event whose hook ran is LIVE and counts toward the live total', () => {
  const { rows, live, gaps } = classifyInvocations(events, {
    resolved: ['node ".dsh/hooks/session-start.mjs"'],
    ran: [{ command: 'node ".dsh/hooks/session-start.mjs"', exit: '0' }],
  });
  const row = rows.find((r) => r.event === 'SessionStart');
  assert.equal(row.status, 'LIVE');
  assert.match(row.evidence, /exit=0/);
  assert.equal(live, 1);
  // PreToolUse / PostToolUse / Stop did not fire in this log, so they are gaps.
  assert.equal(gaps, 3);
});

check('a mount-only event is never reported as live or as a gap', () => {
  const { rows, live, gaps } = classifyInvocations(events, { resolved: [], ran: [] });
  for (const event of ['Notification', 'PreCompact']) {
    const row = rows.find((r) => r.event === event);
    assert.equal(row.status, 'mount-only');
    assert.match(row.evidence, /not provokable/);
  }
  assert.equal(live, 0);
  assert.equal(gaps, 4, 'SessionStart, PreToolUse, PostToolUse and Stop are provokable');
});

check('a resolved-but-never-executed command says so instead of looking wired', () => {
  const { rows } = classifyInvocations(events, {
    resolved: ['node ".dsh/hooks/validate-commit.mjs"'],
    ran: [],
  });
  const row = rows.find((r) => r.event === 'PreToolUse');
  assert.equal(row.status, 'NOT FIRED');
  assert.match(row.evidence, /resolved but never executed/);
});

check('a hook that ran with a non-zero exit still counts as live (it fired)', () => {
  const { rows } = classifyInvocations(events, {
    resolved: [],
    ran: [{ command: 'node ".dsh/hooks/validate-commit.mjs"', exit: '1' }],
  });
  const row = rows.find((r) => r.event === 'PreToolUse');
  assert.equal(row.status, 'LIVE');
  assert.match(row.evidence, /exit=1/);
});

check('one command serving two events credits both', () => {
  const shared = new Map([
    ['PreToolUse', ['node ".dsh/hooks/validate-push.mjs"']],
    ['PostToolUse', ['node ".dsh/hooks/validate-push.mjs"']],
  ]);
  const { live } = classifyInvocations(shared, {
    resolved: [],
    ran: [{ command: 'node ".dsh/hooks/validate-push.mjs"', exit: '0' }],
  });
  assert.equal(live, 2);
});

console.log(`\nverify-hooks-events.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
