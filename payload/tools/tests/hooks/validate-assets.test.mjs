#!/usr/bin/env node
/**
 * Tests for `dsh-src/hooks/validate-assets.mjs` (port of `.claude/hooks/validate-assets.sh`).
 *
 *   node tools/tests/hooks/validate-assets.test.mjs
 *
 * Same harness shape as validate-push.test.mjs: payloads in through a file
 * redirection, streams out through files, never pipes (this sandbox denies piped
 * child stdio — the reason the hook runtime's `capture()` exists).
 *
 * NOTE: this hook reads NO project configuration either. The bash original
 * hardcodes its asset roots (`assets/`, `Assets/`, `Content/`, bash 86) and its
 * data-file pattern (bash 109) — it never calls `resolve_config` or
 * `resolve_code_root`. The fixture `project.yaml` below only marks the project
 * root for `projectRoot()`. Adopting `resolve_code_root` here would NARROW the
 * check (a file under `assets/` in a Unity-configured project would stop being
 * validated), i.e. it would relax the gate — so it is not done.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dsh-src',
  'hooks',
  'validate-assets.mjs',
);

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

function runHook(payload, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-va-run-'));
  try {
    const inPath = join(dir, 'in.json');
    const outPath = join(dir, 'out.txt');
    const errPath = join(dir, 'err.txt');
    writeFileSync(inPath, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const line = `"${process.execPath}" "${HOOK}" < "${inPath}" > "${outPath}" 2> "${errPath}"`;
    const result = spawnSync(line, { cwd, shell: true, stdio: 'ignore', windowsHide: true });
    return {
      status: result.status,
      stdout: existsSync(outPath) ? readFileSync(outPath, 'utf8') : '',
      stderr: existsSync(errPath) ? readFileSync(errPath, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePayload(filePath, cwd) {
  return {
    session_id: 'test-session',
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: '…' },
  };
}

/** The hook JSON warning, or null when the hook stayed silent. */
function warningOf(result) {
  if (result.stdout.trim() === '') return null;
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(parsed.systemMessage, parsed.hookSpecificOutput.additionalContext);
  return parsed.systemMessage;
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-va-fixture-'));
const project = join(scratch, 'project');
const bare = join(scratch, 'bare');

try {
  mkdirSync(join(project, 'assets', 'data'), { recursive: true });
  mkdirSync(join(project, 'assets', 'Data'), { recursive: true });
  mkdirSync(join(project, 'assets', 'sprites'), { recursive: true });
  mkdirSync(join(project, 'Assets', 'Data'), { recursive: true });
  mkdirSync(join(bare), { recursive: true });
  writeFileSync(join(project, 'project.yaml'), 'engine:\n  name: Godot\n', 'utf8');
  writeFileSync(join(project, 'assets', 'data', 'good.json'), '{"a": 1}\n', 'utf8');
  writeFileSync(join(project, 'assets', 'data', 'bad.json'), '{"a": 1,}\n', 'utf8');
  writeFileSync(join(project, 'assets', 'Data', 'bad_upper.json'), '[1, 2\n', 'utf8');
  writeFileSync(join(project, 'assets', 'Data', 'Player_Stats.json'), '{"hp": }\n', 'utf8');
  writeFileSync(join(project, 'Assets', 'Data', 'bad2.json'), 'not json\n', 'utf8');
  writeFileSync(join(project, 'assets', 'config.json'), '{"a": 1,}\n', 'utf8');
  writeFileSync(join(project, 'assets', 'data', 'bom.json'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{ "b": 2 }\n', 'utf8'),
  ]));

  // ---- early exits on payloads that have nothing to do with this hook ------

  test('no file_path at all (a Bash call) -> allow, no output', () => {
    const result = runHook(
      { hook_event_name: 'PostToolUse', cwd: project, tool_name: 'Bash', tool_input: { command: 'ls' } },
      project,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('empty file_path -> allow, no output', () => {
    const result = runHook(writePayload('', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('malformed stdin -> allow, no output', () => {
    const result = runHook('{"tool_name": "Write", "tool_input":', project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('a file outside every asset root -> allow, no output', () => {
    for (const filePath of ['src/foo.gd', 'design/gdd/combat.md', 'assets_notes/x.json']) {
      const result = runHook(writePayload(filePath, project), project);
      assert.equal(result.status, 0, filePath);
      assert.equal(result.stdout, '', filePath);
      assert.equal(result.stderr, '', filePath);
    }
  });

  test('an absolute path outside the project -> allow, no output', () => {
    const result = runHook(writePayload('C:/other/assets/Data/bad.json', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  // ---- the blocking path: data JSON ---------------------------------------

  test('valid JSON in a data folder -> allow, no output', () => {
    const result = runHook(writePayload('assets/data/good.json', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('invalid JSON blocks with exit 2 and the bash wording on stderr', () => {
    const result = runHook(writePayload('assets/Data/bad_upper.json', project), project);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('=== Asset Validation: ERRORS ==='), result.stderr);
    assert.ok(
      result.stderr.includes(
        '  FORMAT: assets/Data/bad_upper.json is not valid JSON — fix syntax errors before continuing',
      ),
      result.stderr,
    );
    assert.ok(
      result.stderr.includes('The file was written but is broken. Fix it now, before continuing.'),
      result.stderr,
    );
  });

  test('invalid JSON under Unity\'s Assets/Data blocks too', () => {
    const result = runHook(writePayload('Assets/Data/bad2.json', project), project);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('  FORMAT: Assets/Data/bad2.json is not valid JSON'), result.stderr);
  });

  test('an absolute in-project path is made project-relative before matching', () => {
    for (const absolute of [
      join(project, 'assets', 'Data', 'bad_upper.json'),
      join(project, 'assets', 'Data', 'bad_upper.json').replace(/\\/g, '/'),
      `/${project.slice(0, 1).toLowerCase()}${project.slice(2).replace(/\\/g, '/')}/assets/Data/bad_upper.json`,
    ]) {
      const result = runHook(writePayload(absolute, project), project);
      assert.equal(result.status, 2, absolute);
      // The reported path is the project-relative one, exactly as bash prints it.
      assert.ok(result.stderr.includes('  FORMAT: assets/Data/bad_upper.json is not valid JSON'), result.stderr);
    }
  });

  test('a data JSON that does not exist -> allow, no output', () => {
    const result = runHook(writePayload('assets/data/missing.json', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('a UTF-8 BOM is accepted (utf-8-sig, bash 126)', () => {
    const result = runHook(writePayload('assets/data/bom.json', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('JSON outside a data folder is not checked (bash 109)', () => {
    const result = runHook(writePayload('assets/config.json', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  // ---- the advisory path: naming ------------------------------------------

  test('a Godot asset filename with uppercase warns, exit 0', () => {
    const message = warningOf(runHook(writePayload('assets/sprites/Player_Idle.png', project), project));
    assert.ok(message.includes('=== Asset Validation: Warnings ==='), message);
    assert.ok(
      message.includes('  NAMING: assets/sprites/Player_Idle.png must be lowercase with underscores (got: Player_Idle.png)'),
      message,
    );
    assert.ok(message.includes('(Warnings are advisory. Fix before final commit.)'), message);
  });

  test('spaces and hyphens warn as well', () => {
    for (const filePath of ['assets/sprites/player idle.png', 'assets/sprites/player-idle.png']) {
      const message = warningOf(runHook(writePayload(filePath, project), project));
      assert.ok(message !== null && message.includes('  NAMING:'), String(message));
    }
  });

  test('Unity\'s Assets/ is exempt from the naming convention (bash 94-104)', () => {
    const result = runHook(writePayload('Assets/sprites/Player_Idle.png', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('naming warnings ride along on a blocking report', () => {
    const result = runHook(writePayload('assets/Data/Player_Stats.json', project), project);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('=== Asset Validation: ERRORS ==='), result.stderr);
    assert.ok(result.stderr.includes('=== Asset Validation: Warnings ==='), result.stderr);
    assert.ok(result.stderr.includes('  NAMING: assets/Data/Player_Stats.json'), result.stderr);
    assert.ok(result.stderr.includes('  FORMAT: assets/Data/Player_Stats.json'), result.stderr);
  });

  // ---- degradation ---------------------------------------------------------

  test('a project with no project.yaml still allows (root falls back)', () => {
    const result = runHook(writePayload('assets/data/__dsh_test_absent__.json', bare), bare);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
