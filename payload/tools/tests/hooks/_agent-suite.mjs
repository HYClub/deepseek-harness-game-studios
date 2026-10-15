/**
 * Shared suite for the two agent audit hooks: `log-agent.mjs` (SubagentStart)
 * and `log-agent-stop.mjs` (SubagentStop). The pair is byte-for-byte the same
 * logic apart from the verb, so the cases live here and each
 * `tools/tests/hooks/<name>.test.mjs` entry point supplies its own verb.
 *
 * Run both with: node tools/tests/hooks/log-agent.test.mjs
 *                node tools/tests/hooks/log-agent-stop.test.mjs
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixture, parseAuditLine, readIfExists, runHook, timestampIsReal } from './_harness.mjs';

const LOG_REL = join('production', 'session-logs', 'agent-audit.log');
const BASE_YAML = 'schema_version: 1\n';
/** Minimal stand-in for `node tools/yaml-helper.mjs __call session_state_enabled`. */
const STUB_HELPER_OFF = "process.exit(process.argv[2] === '__call' "
  + "&& process.argv[3] === 'session_state_enabled' ? 1 : 0);\n";

/**
 * @param {object} options
 * @param {string} options.hookName file name under dsh-src/hooks
 * @param {string} options.verb "Agent invoked" | "Agent completed"
 */
export function runAgentHookSuite({ hookName, verb }) {
  let checks = 0;
  const failures = [];

  const check = (name, fn) => {
    try {
      fn();
      checks += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  };

  console.log(hookName);

  // --- normal path ----------------------------------------------------------
  {
    // A normal deployment has the Node config resolver in place; without it the hook
    // correctly reports "session_state NOT checked" on stderr, which is not a pass path.
    const fx = makeFixture({
      files: { 'project.yaml': BASE_YAML, 'tools/yaml-helper.mjs': 'process.exit(0);\n' },
    });
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-1', agent_id: 'agent-abc', agent_type: 'Explore' },
    });
    check('正常路径: exit 0 且 stdout 为空(观测型，绝不阻断)', () => {
      assert.equal(result.status, 0, `status=${result.status} stderr=${result.stderr}`);
      assert.equal(result.stdout, '', '必须是「允许」，不能有结构化阻断输出');
      assert.equal(result.stderr, '', `不应有 stderr: ${result.stderr}`);
    });
    check(`正常路径: 追加 \`%Y%m%d_%H%M%S | <session> | ${verb}: <type>\``, () => {
      const lines = readIfExists(join(fx.root, LOG_REL)).trim().split('\n');
      assert.equal(lines.length, 1, `行数不对: ${lines.length}`);
      const record = parseAuditLine(lines[0]);
      assert.notEqual(record, null, `无法解析: ${lines[0]}`);
      assert.ok(timestampIsReal(record.timestamp), `时间戳格式不对: ${record.timestamp}`);
      assert.equal(record.sessionId, 'sess-1');
      assert.equal(record.message, `${verb}: Explore`);
    });
    check('正常路径: session-stop.sh 依赖的固定串存在', () => {
      const text = readIfExists(join(fx.root, LOG_REL));
      assert.ok(text.includes(` | sess-1 | ${verb}: `), '固定串变了会静默破坏 spawn 计数');
    });
    fx.cleanup();
  }

  // --- internal agents (agent_type: "") -------------------------------------
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-2', agent_type: '' },
    });
    check('内部代理 agent_type:"" 不记录', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), false, '不应创建审计日志');
    });
    fx.cleanup();
  }
  {
    // Spacing variants of the same payload must still be skipped.
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    runHook(fx.hook(hookName), {
      cwd: fx.root,
      inputText: '{"session_id":"sess-2b", "agent_type" :  "" }',
    });
    check('agent_type:"" 的空格变体同样跳过', () => {
      assert.equal(existsSync(join(fx.root, LOG_REL)), false);
    });
    fx.cleanup();
  }

  // --- missing agent_type still logs as unknown -----------------------------
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const result = runHook(fx.hook(hookName), { cwd: fx.root, input: { session_id: 'sess-3' } });
    check('缺失 agent_type 仍记录为 unknown', () => {
      assert.equal(result.status, 0);
      const record = parseAuditLine(readIfExists(join(fx.root, LOG_REL)).trim());
      assert.notEqual(record, null);
      assert.equal(record.message, `${verb}: unknown`);
      assert.equal(record.sessionId, 'sess-3');
    });
    fx.cleanup();
  }
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    runHook(fx.hook(hookName), { cwd: fx.root, input: { session_id: 'sess-3b', agent_type: '' } });
    check('agent_type 为空串时既不记录也不产生 unknown 记录', () => {
      assert.equal(existsSync(join(fx.root, LOG_REL)), false);
    });
    fx.cleanup();
  }

  // --- missing session_id ---------------------------------------------------
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    runHook(fx.hook(hookName), { cwd: fx.root, input: { agent_type: 'godot-specialist' } });
    check('缺失 session_id 记录为 unknown', () => {
      const record = parseAuditLine(readIfExists(join(fx.root, LOG_REL)).trim());
      assert.notEqual(record, null);
      assert.equal(record.sessionId, 'unknown');
      assert.equal(record.message, `${verb}: godot-specialist`);
    });
    fx.cleanup();
  }

  // --- malformed / empty stdin ----------------------------------------------
  // The bash original only guards `agent_type: ""`; an empty payload still falls
  // through to the `unknown` record. Same here (verified by reading log-agent.sh
  // lines 48-87: nothing short-circuits on an empty INPUT).
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const result = runHook(fx.hook(hookName), { cwd: fx.root, inputText: '' });
    check('空 stdin: exit 0，落一条 unknown 记录(与原脚本一致)', () => {
      assert.equal(result.status, 0);
      const record = parseAuditLine(readIfExists(join(fx.root, LOG_REL)).trim());
      assert.notEqual(record, null, '空 stdin 在 bash 版里也会写一条 unknown');
      assert.equal(record.message, `${verb}: unknown`);
      assert.equal(record.sessionId, 'unknown');
    });
    fx.cleanup();
  }
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const result = runHook(fx.hook(hookName), { cwd: fx.root, inputText: '{ not json' });
    check('畸形 stdin: 降级为 unknown 记录，绝不非 0 退出', () => {
      assert.equal(result.status, 0, `stderr=${result.stderr}`);
      const record = parseAuditLine(readIfExists(join(fx.root, LOG_REL)).trim());
      assert.notEqual(record, null);
      assert.equal(record.message, `${verb}: unknown`);
    });
    fx.cleanup();
  }

  // --- features.session_state ----------------------------------------------
  // `_session-state.mjs` mirrors `session_state_enabled()` by running
  // `node tools/yaml-helper.mjs __call session_state_enabled` (exit 1 = off).
  // These cases therefore need a `tools/yaml-helper.mjs` in the fixture; the
  // real one is copied for the primary case, a one-line stub for the variants.
  {
    const fx = makeFixture({
      files: {
        'project.yaml': { copy: 'project.yaml' },
        'tools/yaml-helper.mjs': { copy: 'tools/yaml-helper.mjs' },
      },
    });
    appendFileSync(join(fx.root, 'project.yaml'), '\nfeatures:\n  session_state: off\n', 'utf8');
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-off', agent_type: 'Explore' },
    });
    check('features.session_state: off 关闭审计(真实 yaml-helper)', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), false, 'off 时不应写审计日志');
    });
    fx.cleanup();
  }
  {
    const fx = makeFixture({
      files: {
        'project.yaml': { copy: 'project.yaml' },
        'tools/yaml-helper.mjs': { copy: 'tools/yaml-helper.mjs' },
      },
    });
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-default', agent_type: 'Explore' },
    });
    check('未设置该键时默认 on，仍记录(真实 yaml-helper)', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), true);
    });
    fx.cleanup();
  }
  {
    const fx = makeFixture({
      files: {
        'project.yaml': `${BASE_YAML}features:\n  session_state: off\n`,
        'tools/yaml-helper.mjs': STUB_HELPER_OFF,
      },
    });
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-stub-off', agent_type: 'Explore' },
    });
    check('off 时 exit 0 且不写日志(stub 判定 off)', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), false);
    });
    fx.cleanup();
  }
  {
    // No `tools/yaml-helper.mjs` at all: the helper defaults to ON, like an
    // absent key did in the bash `session_state_enabled()`.
    const fx = makeFixture({ files: { 'project.yaml': `${BASE_YAML}features:\n  session_state: off\n` } });
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-no-helper', agent_type: 'Explore' },
    });
    check('缺 tools/yaml-helper.mjs 时默认 on 并记录(与原脚本降级一致)', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), true);
    });
    fx.cleanup();
  }
  {
    const fx = makeFixture({
      files: {
        'project.yaml': `${BASE_YAML}features:\n  session_state: on\n`,
        'tools/yaml-helper.mjs': 'process.exit(0);\n',
      },
    });
    runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-on', agent_type: 'Explore' },
    });
    check('session_state: on 仍记录', () => {
      assert.equal(existsSync(join(fx.root, LOG_REL)), true);
    });
    fx.cleanup();
  }

  // --- project-root resolution ---------------------------------------------
  {
    // cwd is a bare temp dir with NO project.yaml / .dsh / .claude, so the hook
    // must fall back to the payload's cwd — the original's CLAUDE_PROJECT_DIR
    // rule. (makeFixture always seeds .dsh/, so this one is created by hand.)
    const outer = mkdtempSync(join(tmpdir(), 'dsh-hook-bare-'));
    const target = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const result = runHook(target.hook(hookName), {
      cwd: outer,
      input: { session_id: 'sess-cwd', agent_type: 'Explore', cwd: target.root },
    });
    check('cwd 非项目根时用 payload.cwd 定位项目，不写错树', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(target.root, LOG_REL)), true, `未写入 ${target.root}`);
      assert.equal(existsSync(join(outer, LOG_REL)), false, '不能写到错误的树');
    });
    rmSync(outer, { recursive: true, force: true });
    target.cleanup();
  }

  // --- append semantics -----------------------------------------------------
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    const hook = fx.hook(hookName);
    runHook(hook, { cwd: fx.root, input: { session_id: 'sess-a', agent_type: 'A' } });
    runHook(hook, { cwd: fx.root, input: { session_id: 'sess-b', agent_type: 'B' } });
    check('两条记录按行追加，不覆盖', () => {
      const lines = readFileSync(join(fx.root, LOG_REL), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.ok(lines[0].endsWith(`${verb}: A`), lines[0]);
      assert.ok(lines[1].endsWith(`${verb}: B`), lines[1]);
    });
    fx.cleanup();
  }

  // --- empty project --------------------------------------------------------
  {
    const fx = makeFixture({});
    const result = runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-bare', agent_type: 'Explore' },
    });
    check('无 project.yaml 的空项目: 仍允许并记录(默认 on)', () => {
      assert.equal(result.status, 0);
      assert.equal(existsSync(join(fx.root, LOG_REL)), true);
    });
    fx.cleanup();
  }

  // --- unicode / odd names stay on one line ---------------------------------
  {
    const fx = makeFixture({ files: { 'project.yaml': BASE_YAML } });
    runHook(fx.hook(hookName), {
      cwd: fx.root,
      input: { session_id: 'sess-u', agent_type: '关卡设计师' },
    });
    check('非 ASCII 代理名保持单行并保留', () => {
      const lines = readIfExists(join(fx.root, LOG_REL)).trim().split('\n');
      assert.equal(lines.length, 1);
      assert.ok(lines[0].endsWith(`${verb}: 关卡设计师`), lines[0]);
    });
    fx.cleanup();
  }

  console.log(`  ${checks} 通过, ${failures.length} 失败`);
  if (failures.length > 0) {
    process.exitCode = 1;
    for (const f of failures) console.error(`  - ${f}`);
  }
  return { checks, failures };
}
