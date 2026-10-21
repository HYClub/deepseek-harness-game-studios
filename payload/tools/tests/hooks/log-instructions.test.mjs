/**
 * Tests for `dsh-src/hooks/log-instructions.mjs` (InstructionsLoaded diagnostic).
 *
 * Run: node tools/tests/hooks/log-instructions.test.mjs
 * Fixtures live in the OS temp directory and are removed afterwards. Note this
 * hook is NOT registered in `.claude/settings.json`, so it only ever runs when
 * invoked by hand — the tests do exactly that.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, readIfExists, runHook, timestampIsReal } from './_harness.mjs';

const LOG_REL = join('production', 'session-logs', 'instructions-loaded.log');
let checks = 0;
let skipped = 0;

function check(name, fn) {
  try {
    fn();
    checks += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP ${name} — ${why}`);
}

/** Split one record (readable line + RAW line) into its columns. */
function parseRecord(text) {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length < 2) return null;
  const m = /^(\d{8}_\d{6}) \| (.*?) \| (.*)$/.exec(lines[0]);
  const raw = /^(\d{8}_\d{6})   RAW (.*)$/.exec(lines[1]);
  if (m === null || raw === null) return null;
  return {
    timestamp: m[1],
    reason: m[2].trim(),
    file: m[3],
    rawTimestamp: raw[1],
    raw: raw[2],
    lineCount: lines.length,
  };
}

const PROJECT = 'schema_version: 1\n';

console.log('log-instructions.mjs');

// --- normal path ------------------------------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const filePath = join(fx.root, '.claude', 'rules', 'skill-authoring.md');
  const result = runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    input: {
      session_id: 'sess-1',
      file_path: filePath,
      load_reason: 'path_glob_match',
      parent_file_path: join(fx.root, 'CLAUDE.md'),
    },
  });
  check('正常路径: exit 0，stdout/stderr 均为空(退出码被忽略)', () => {
    assert.equal(result.status, 0, `status=${result.status}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
  check('正常路径: 可读行 `%Y%m%d_%H%M%S | reason | path` + RAW 行', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.notEqual(record, null, '记录形状不对');
    assert.ok(timestampIsReal(record.timestamp), `时间戳格式不对: ${record.timestamp}`);
    assert.equal(record.reason, 'path_glob_match');
    assert.equal(record.file, '.claude/rules/skill-authoring.md  (via CLAUDE.md)');
  });
  check('RAW 行保留原始 payload(未被缩短)', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    // The payload carries JSON-escaped Windows separators; the RAW line keeps
    // those bytes, which is the point of the column.
    assert.ok(record.raw.includes(filePath.replace(/\\/g, '\\\\')), `RAW 丢了原路径: ${record.raw}`);
    assert.ok(record.raw.includes('"load_reason":"path_glob_match"'));
    assert.equal(record.rawTimestamp, record.timestamp, 'RAW 行时间戳应与可读行一致');
  });
  fx.cleanup();
}

// --- root prefix stripped ---------------------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const filePath = join(fx.root, '.claude', 'rules', 'gameplay-code.md');
  runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, input: { file_path: filePath, reason: 'include' } });
  check('绝对路径被剥成 repo 相对路径', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.equal(record.file, '.claude/rules/gameplay-code.md');
  });
  fx.cleanup();
}

// --- key fallbacks ----------------------------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    input: { path: 'docs/foo.md', reason: 'session_start' },
  });
  check('file_path 缺失时回退到 path', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.equal(record.file, 'docs/foo.md');
    assert.equal(record.reason, 'session_start');
  });
  fx.cleanup();
}
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    inputText: '{"filePath":"src/main.gd","reason":"path_glob_match"}',
  });
  check('filePath 与 reason 的替代键（无空格）可用', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.equal(record.file, 'src/main.gd');
    assert.equal(record.reason, 'path_glob_match');
  });
  fx.cleanup();
}

// --- missing columns degrade to `?` ----------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, input: { file_path: 'a.md' } });
  check('缺 reason -> `?`，缺 file -> `?`', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.equal(record.reason, '?');
    assert.equal(record.file, 'a.md');
  });
  fx.cleanup();
}
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, input: { load_reason: 'session_start' } });
  check('缺 file 时该列显示 `?`', () => {
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.equal(record.reason, 'session_start');
    assert.equal(record.file, '?');
  });
  fx.cleanup();
}

// --- REASON column padding (printf %-16s) ----------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, input: { reason: 'include', file_path: 'CLAUDE.md' } });
  check('reason 列按 %-16s 左对齐填充', () => {
    const line = readIfExists(join(fx.root, LOG_REL)).replace(/\r\n/g, '\n').split('\n')[0];
    assert.ok(/\| include {9} \| CLAUDE\.md$/.test(line), `列填充不对: ${line}`);
  });
  fx.cleanup();
}

// --- malformed / empty stdin ------------------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const result = runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, inputText: '' });
  check('空 stdin: exit 0 且不写任何记录', () => {
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(fx.root, LOG_REL)), false);
  });
  fx.cleanup();
}
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const result = runHook(fx.hook('log-instructions.mjs'), { cwd: fx.root, inputText: '   \n  ' });
  check('仅空白 stdin: exit 0 且不写记录', () => {
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(fx.root, LOG_REL)), false);
  });
  fx.cleanup();
}
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const result = runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    inputText: '{"file_path":"x.md","reason":"path_glob_match"',
  });
  check('畸形 JSON: 仍记一条(列用文本回退/`?`)，绝不非 0 退出', () => {
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.notEqual(record, null, '畸形 payload 也必须可从 RAW 行恢复');
    assert.equal(record.file, 'x.md');
    assert.equal(record.reason, 'path_glob_match');
  });
  fx.cleanup();
}
{
  // A payload shaped like `include` but with a value that is not a string.
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const result = runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    inputText: '{"file_path":{"nested":1},"reason":2}',
  });
  check('非字符串字段不致崩溃(降级为空 -> `?`)', () => {
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const record = parseRecord(readIfExists(join(fx.root, LOG_REL)));
    assert.notEqual(record, null);
    assert.equal(record.file, '?');
  });
  fx.cleanup();
}

// --- append semantics -------------------------------------------------------
{
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  const hook = fx.hook('log-instructions.mjs');
  runHook(hook, { cwd: fx.root, input: { file_path: 'a.md', reason: 'include' } });
  runHook(hook, { cwd: fx.root, input: { file_path: 'b.md', reason: 'include' } });
  check('两次加载写两条记录（每条占两行）', () => {
    const lines = readIfExists(join(fx.root, LOG_REL)).replace(/\r\n/g, '\n').trim().split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0].endsWith('| a.md'));
    assert.ok(lines[2].endsWith('| b.md'));
  });
  fx.cleanup();
}

// --- empty project ----------------------------------------------------------
{
  const fx = makeFixture({});
  const result = runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    input: { file_path: 'CLAUDE.md', reason: 'session_start' },
  });
  check('无 project.yaml 的空项目: 仍允许并记录', () => {
    assert.equal(result.status, 0);
    assert.notEqual(parseRecord(readIfExists(join(fx.root, LOG_REL))), null);
  });
  fx.cleanup();
}

// --- the diagnostic must not touch the real repository ----------------------
{
  const repoLog = join(process.cwd(), 'production', 'session-logs', 'instructions-loaded.log');
  const before = existsSync(repoLog) ? readFileSync(repoLog, 'utf8').length : -1;
  const fx = makeFixture({ files: { 'project.yaml': PROJECT } });
  runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    input: { file_path: join(fx.root, 'CLAUDE.md'), reason: 'include' },
  });
  check('fixture 运行不污染仓库的 production/session-logs', () => {
    const after = existsSync(repoLog) ? readFileSync(repoLog, 'utf8').length : -1;
    assert.equal(after, before, '仓库日志被测试改动了');
  });
  fx.cleanup();
}

// --- deliberately NOT gated on features.session_state ----------------------
{
  const fx = makeFixture({ files: { 'project.yaml': `${PROJECT}features:\n  session_state: off\n` } });
  runHook(fx.hook('log-instructions.mjs'), {
    cwd: fx.root,
    input: { file_path: 'CLAUDE.md', reason: 'session_start' },
  });
  check('session_state: off 不影响该诊断钩子（与原脚本一致）', () => {
    assert.notEqual(parseRecord(readIfExists(join(fx.root, LOG_REL))), null);
  });
  fx.cleanup();
}

// --- registry / helper availability notes -----------------------------------
if (!existsSync(join(process.cwd(), '.claude', 'settings.json'))) {
  skip('注册状态检查', '.claude/settings.json 缺失');
} else {
  const settings = JSON.parse(readFileSync(join(process.cwd(), '.claude', 'settings.json'), 'utf8'));
  const registered = JSON.stringify(settings.hooks ?? {}).includes('log-instructions');
  check('与 .claude/settings.json 一致: 该钩子未注册(可选诊断)', () => {
    assert.equal(registered, false, 'settings.json 若注册了它，应把它加进 dsh-src/hooks 的启用说明');
  });
}

console.log(`\n${checks} 通过, ${skipped} 跳过; exit=${process.exitCode ?? 0}`);
