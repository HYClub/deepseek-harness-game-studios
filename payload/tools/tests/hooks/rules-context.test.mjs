// Test for dsh-src/hooks/rules-context.mjs
// Run: node tools/tests/hooks/rules-context.test.mjs
//
// The hook is exercised through its real CLI (stdin payload → stdout JSON), with the
// repository's own generated rules copied into a temp fixture, so the real `paths:`
// globs are what gets matched. Redirects, never pipes (the sandbox denies piped stdio).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const HOOK = join(ROOT, 'dsh-src', 'hooks', 'rules-context.mjs');

let fixture;
function makeFixture() {
  fixture = mkdtempSync(join(tmpdir(), 'rules-ctx-'));
  writeFileSync(join(fixture, 'project.yaml'), 'schema_version: 1\n', 'utf8');
  cpSync(join(ROOT, '.dsh', 'rules'), join(fixture, '.dsh', 'rules'), { recursive: true });
}

function invoke(payload, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-ctx-io-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.txt');
  writeFileSync(inFile, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  try {
    const result = spawnSync(`node "${HOOK}" < "${inFile}" > "${outFile}" 2>&1`, {
      cwd: options.cwd ?? fixture,
      shell: true,
      stdio: 'ignore',
      timeout: 30_000,
    });
    return {
      status: result.status,
      stdout: existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (filePath, root = fixture) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'rules-test',
  cwd: root,
  tool_name: 'edit',
  tool_input: { file_path: filePath },
});

let passed = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

makeFixture();

check('src/gameplay/** pulls in the gameplay rule', () => {
  const r = invoke(post(join(fixture, 'src', 'gameplay', 'combat.gd')));
  assert.equal(r.status, 0, r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /gameplay-code\.md/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /gameplay values MUST come from external/i);
});

check('src/ui/** pulls in the UI rule', () => {
  const r = invoke(post(join(fixture, 'src', 'ui', 'main.gd')));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ui-code\.md/);
});

check('a nested path still matches `**`', () => {
  const r = invoke(post(join(fixture, 'src', 'gameplay', 'combat', 'deep', 'x.gd')));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gameplay-code\.md/);
});

check('an unrelated file injects nothing', () => {
  const r = invoke(post(join(fixture, 'README.md')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('a path outside the project injects nothing', () => {
  const r = invoke(post('C:/Other/project/src/gameplay/x.gd'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('a relative payload path resolves against the project root', () => {
  const r = invoke(post('src/gameplay/combat.gd'));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gameplay-code\.md/);
});

check('survives empty and malformed stdin', () => {
  assert.equal(invoke('').status, 0);
  assert.equal(invoke('{ not json').status, 0);
  assert.equal(invoke('{}').status, 0);
});

check('a project without .dsh/rules injects nothing', () => {
  const bare = mkdtempSync(join(tmpdir(), 'rules-ctx-bare-'));
  writeFileSync(join(bare, 'project.yaml'), 'schema_version: 1\n', 'utf8');
  mkdirSync(join(bare, 'src', 'gameplay'), { recursive: true });
  const r = invoke(post(join(bare, 'src', 'gameplay', 'x.gd'), bare), { cwd: bare });
  rmSync(bare, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

rmSync(fixture, { recursive: true, force: true });
console.log(`\nrules-context: ${passed}/${total} passed`);
