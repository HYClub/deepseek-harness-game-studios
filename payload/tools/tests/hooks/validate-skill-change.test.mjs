// Test for dsh-src/hooks/validate-skill-change.mjs
// Run: node tools/tests/hooks/validate-skill-change.test.mjs
//
// The hook is exercised through its real CLI (stdin payload → stdout JSON), because
// the DSH sandbox denies piped child stdio: both streams are redirected to files by a
// shell instead, the same shape runtime.capture() uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const HOOK = join(ROOT, 'dsh-src', 'hooks', 'validate-skill-change.mjs');

/** Run the hook with `payload` on stdin; return { status, stdout }. */
function invoke(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'vsc-test-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.txt');
  writeFileSync(inFile, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  try {
    const result = spawnSync(
      `node "${HOOK}" < "${inFile}" > "${outFile}" 2>&1`,
      { cwd: ROOT, shell: true, stdio: 'ignore', timeout: 30_000 },
    );
    return {
      status: result.status,
      stdout: existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (filePath) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'test',
  cwd: ROOT,
  tool_name: 'edit',
  tool_input: { file_path: filePath },
});

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

check('advises on a source skill edit', () => {
  const r = invoke(post(join(ROOT, '.claude', 'skills', 'dev-story', 'SKILL.md')));
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(parsed.systemMessage, /dev-story/);
  assert.match(parsed.systemMessage, /build-dsh/);
});

check('flags an edit in the generated tree', () => {
  const r = invoke(post(join(ROOT, '.dsh', 'skills', 'dev-story', 'SKILL.md')));
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /generated/i);
});

check('stays silent for a non-skill file', () => {
  const r = invoke(post(join(ROOT, 'src', 'gameplay', 'combat.gd')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('handles a Windows-escaped path (the \\\\ rule)', () => {
  const escaped = `${ROOT.replaceAll('/', '\\')}\\.claude\\skills\\help\\SKILL.md`;
  const r = invoke({
    hook_event_name: 'PostToolUse',
    cwd: ROOT,
    tool_input: { file_path: escaped },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /help/);
});

check('ignores a skill file from another project', () => {
  const r = invoke(post('C:/Other/project/.claude/skills/help/SKILL.md'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('survives empty and malformed input', () => {
  assert.equal(invoke('').status, 0);
  assert.equal(invoke('{ not json').status, 0);
  assert.equal(invoke('{}').status, 0);
});

console.log(`\n${passed}/6 checks passed`);
