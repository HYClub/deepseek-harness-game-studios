#!/usr/bin/env node
/**
 * verify-hooks-bridge — run the generated `.dsh/hooks.json` through the *real* DSH hook
 * protocol implementation, the same code @deepseek-ai/dsh-hooks-claude-code uses at run
 * time (`runHook` + `parseHookOutput` + `mergeHookOutputs`).
 *
 *   node tools/verify-hooks-bridge.mjs [projectRoot]
 *
 * Why: the bridge is a profile plugin, and DSH cannot hot-mount a new plugin into a
 * running session, so "do the hooks actually fire?" cannot be answered from inside the
 * session that enabled them. This script answers the next best question with real
 * evidence: does the shipped hook config parse, do our commands execute, and does the
 * real protocol parser accept what they emit? Every case below drives one generated hook
 * with the payload shape the bridge builds for that event.
 *
 * It runs against a temporary fixture project (its own project.yaml + a copy of
 * `.dsh/hooks` + `tools/yaml-helper.mjs`), so no log or state file in this repository is
 * touched. Exit code 0 = every case behaved as the protocol requires.
 *
 * What this does NOT prove: that the bridge is mounted in a live session. After a profile
 * restart, `pwsh -File tools/check-hooks-live.ps1` proves that instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(HERE, '..'));

// ---------------------------------------------------------------- dsh install lookup
function findDshRoot() {
  const candidates = [
    process.env.DSH_CLI_ROOT,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh') : undefined,
    join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ].filter((c) => typeof c === 'string');
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

const dshRoot = findDshRoot();
if (dshRoot === undefined) {
  // Without the dsh install this check cannot run; that is a missing environment, not a
  // failing port, so it reports SKIP rather than a false failure.
  console.log('SKIP: could not locate the dsh install (set DSH_CLI_ROOT to its package dir).');
  process.exit(0);
}
const protocolPath = join(dshRoot, 'node_modules/@deepseek-ai/dsh-hook-protocol/lib/index.js');
if (!existsSync(protocolPath)) {
  console.error(`FAIL: hook protocol not found at ${protocolPath}`);
  process.exit(1);
}
const { runHook, matchesMatcher, mergeHookOutputs } = await import(pathToFileURL(protocolPath).href);

// ------------------------------------------------------------------- a bash shim
// runHook asks a `bash` service to execute `{ command, stdin, workdir, env }`. The DSH
// sandbox denies piped stdio, so stdin/stdout/stderr all travel through files.
function createBashShim() {
  return {
    resolve(request) {
      return request;
    },
    async execute(request) {
      const dir = mkdtempSync(join(tmpdir(), 'hook-shim-'));
      const inFile = join(dir, 'in.txt');
      const outFile = join(dir, 'out.txt');
      const errFile = join(dir, 'err.txt');
      writeFileSync(inFile, request.stdin ?? '', 'utf8');
      const line = `${request.command} < "${inFile}" > "${outFile}" 2> "${errFile}"`;
      const spawnOptions = {
        cwd: request.workdir,
        env: { ...process.env, ...(request.env ?? {}) },
        stdio: 'ignore',
        timeout: request.timeoutMs,
        windowsHide: true,
      };
      const result = process.platform === 'win32'
        ? spawnSync('cmd', ['/d', '/s', '/c', line], { ...spawnOptions, windowsVerbatimArguments: true })
        : spawnSync(line, { ...spawnOptions, shell: true });
      const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
      return {
        result: async () => ({
          exitCode: result.status ?? undefined,
          stdout: { text: read(outFile) },
          stderr: { text: read(errFile) },
        }),
      };
    },
  };
}

// --------------------------------------------------------------------- fixture
const fixture = mkdtempSync(join(tmpdir(), 'DSGS-bridge-'));
const cleanup = () => rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });

function buildFixture() {
  writeFileSync(join(fixture, 'project.yaml'), 'schema_version: 1\nmodes:\n  rigor: minimal\n', 'utf8');
  cpSync(join(ROOT, '.dsh/hooks'), join(fixture, '.dsh/hooks'), { recursive: true });
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'tools/yaml-helper.mjs'), join(fixture, 'tools/yaml-helper.mjs'));
  mkdirSync(join(fixture, '.dsh/skills/demo'), { recursive: true });
  writeFileSync(join(fixture, '.dsh/skills/demo/SKILL.md'), '# demo\n', 'utf8');
  // A git repo for the push/commit hooks.
  const git = (args) => spawnSync('git', args, { cwd: fixture, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'verify@example.invalid']);
  git(['config', 'user.name', 'verify-port']);
  writeFileSync(join(fixture, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
}

// -------------------------------------------------------------- config + dispatch
const config = JSON.parse(readFileSync(join(ROOT, '.dsh/hooks.json'), 'utf8'));
const bash = createBashShim();
const now = () => Date.now();

/** The bridge's own rule: matcher subject is the tool name for the tool events. */
function groupsFor(event, matchQuery) {
  const groups = config.hooks[event] ?? [];
  return groups.filter((group) => matchesMatcher(group.matcher, matchQuery, 'claude-code'));
}

async function fire(event, payload, matchQuery = '') {
  const outputs = [];
  for (const group of groupsFor(event, matchQuery)) {
    for (const hook of group.hooks ?? []) {
      const { output } = await runHook(bash, hook, {
        payload,
        cwd: fixture,
        env: { CLAUDE_PROJECT_DIR: fixture },
        expectedEventName: event,
        defaultTimeoutMs: 30_000,
        trailingNewline: false,
      }, now);
      outputs.push({ command: hook.command, output });
    }
  }
  return { outputs, merged: mergeHookOutputs(outputs.map((o) => o.output), { expectedEventName: event }) };
}

// ------------------------------------------------------------------- the cases
const cases = [];
function testCase(name, fn) {
  cases.push({ name, fn });
}

const base = (event, extra) => ({
  session_id: 'verify-session',
  transcript_path: '',
  cwd: fixture,
  hook_event_name: event,
  ...extra,
});

testCase('SessionStart runs both context hooks and the merge keeps their text', async () => {
  const { outputs, merged } = await fire('SessionStart', base('SessionStart', { source: 'startup' }), 'startup');
  if (outputs.length !== 2) throw new Error(`expected 2 hooks, got ${outputs.length}`);
  for (const { command, output } of outputs) {
    if (output.exitCode !== 0) throw new Error(`${command} exited ${output.exitCode}: ${output.stderr}`);
  }
  if (merged.additionalContext.length === 0) throw new Error('no additionalContext merged from SessionStart hooks');
  if (merged.decision === 'block' || merged.decision === 'deny') throw new Error(`unexpected decision ${merged.decision}`);
  return `2 hooks, ${merged.additionalContext.join(' | ').length} chars of context`;
});

testCase('PreToolUse: an unrelated command passes with no decision', async () => {
  const { outputs, merged } = await fire('PreToolUse', base('PreToolUse', {
    tool_name: 'pwsh', tool_input: { command: 'git status' },
  }), 'pwsh');
  if (outputs.length !== 2) throw new Error(`expected commit+push hooks, got ${outputs.length}`);
  if (merged.decision !== 'none') throw new Error(`expected no decision, got ${merged.decision}`);
  return 'no decision (allow)';
});

testCase('matchers select DSH tool names, not the Claude Code spellings', async () => {
  // The protocol exact-matches pipe-separated literals in claude-code mode, so a
  // matcher left as `Bash|PowerShell` would silently never fire on DSH's `pwsh`.
  const dshSpelling = await fire('PreToolUse', base('PreToolUse', {
    tool_name: 'pwsh', tool_input: { command: 'git status' },
  }), 'pwsh');
  if (dshSpelling.outputs.length === 0) throw new Error('pwsh did not select any PreToolUse hook');
  const claudeSpelling = await fire('PreToolUse', base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'git status' },
  }), 'Bash');
  if (claudeSpelling.outputs.length !== 0) {
    throw new Error('the Claude spelling still matches — the matcher rewrite regressed');
  }
  return 'pwsh matches, Bash does not';
});

testCase('PreToolUse: a protected-branch push warns without denying', async () => {
  const { merged } = await fire('PreToolUse', base('PreToolUse', {
    tool_name: 'pwsh', tool_input: { command: 'git push origin main' },
  }), 'pwsh');
  if (merged.decision !== 'none') throw new Error(`push must not deny, got ${merged.decision}`);
  if (!merged.systemMessages.join('').match(/main|protected/i)) {
    throw new Error(`expected a protected-branch warning, got: ${JSON.stringify(merged.systemMessages)}`);
  }
  return 'warned, not blocked';
});

testCase('PostToolUse: the advisory reroute carries the same warning to the model', async () => {
  // Upstream raises this warning on PreToolUse, and DSH never surfaces a pre-execute
  // systemMessage — the bridge maps only deny/ask there, so the model never saw it. The same
  // script is registered again on PostToolUse, where `additionalContext` IS delivered; this
  // case proves the text arrives through the channel DSH actually reads, with the event name
  // matching (a mismatched hookEventName makes the protocol discard the block entirely).
  const { outputs, merged } = await fire('PostToolUse', base('PostToolUse', {
    tool_name: 'pwsh', tool_input: { command: 'git push origin main' }, tool_response: {},
  }), 'pwsh');
  if (outputs.length !== 2) throw new Error(`expected commit+push advisories, got ${outputs.length}`);
  for (const { command, output } of outputs) {
    if (output.exitCode !== 0) throw new Error(`${command} exited ${output.exitCode}: ${output.stderr}`);
  }
  const text = merged.additionalContext.join('');
  if (!/main|protected/i.test(text)) {
    throw new Error(`expected the push advisory as context, got: ${JSON.stringify(merged.additionalContext)}`);
  }
  if (merged.decision !== 'none') throw new Error(`an advisory must not decide, got ${merged.decision}`);
  return 'advisory reached additionalContext';
});

testCase('PreToolUse: an invalid staged data JSON is blocked by the commit gate', async () => {
  mkdirSync(join(fixture, 'assets/data'), { recursive: true });
  writeFileSync(join(fixture, 'assets/data/broken.json'), '{ "a": 1,, }\n', 'utf8');
  spawnSync('git', ['add', 'assets/data/broken.json'], { cwd: fixture, stdio: 'ignore' });
  const { merged } = await fire('PreToolUse', base('PreToolUse', {
    tool_name: 'pwsh', tool_input: { command: 'git commit -m "test"' },
  }), 'pwsh');
  if (merged.decision !== 'deny') throw new Error(`expected deny, got ${merged.decision} (${merged.reason ?? ''})`);
  spawnSync('git', ['reset'], { cwd: fixture, stdio: 'ignore' });
  return `denied: ${String(merged.reason).split('\n')[0].slice(0, 70)}`;
});

testCase('PostToolUse: an edited skill file yields the regeneration advice', async () => {
  const { merged } = await fire('PostToolUse', base('PostToolUse', {
    tool_name: 'edit', tool_input: { file_path: join(fixture, '.dsh/skills/demo/SKILL.md') },
  }), 'edit');
  const text = `${merged.additionalContext.join(' ')} ${merged.systemMessages.join(' ')}`;
  if (!/build-dsh|generated/i.test(text)) throw new Error(`no advice in output: ${JSON.stringify(merged)}`);
  return 'advice emitted';
});

testCase('PostToolUse: an invalid data file is blocked', async () => {
  mkdirSync(join(fixture, 'assets/data'), { recursive: true });
  const bad = join(fixture, 'assets/data/tool-broken.json');
  writeFileSync(bad, '{ nope }\n', 'utf8');
  const { merged } = await fire('PostToolUse', base('PostToolUse', {
    tool_name: 'write', tool_input: { file_path: bad },
  }), 'write');
  // `deny` (permissionDecision) and `block` (exit 2) are both blocking outcomes; the
  // port may use either, so the assertion is "the write is stopped", not one spelling.
  if (merged.decision !== 'block' && merged.decision !== 'deny') {
    throw new Error(`expected a blocking decision, got ${merged.decision}`);
  }
  return `stopped with ${merged.decision}`;
});

testCase('SubagentStart/Stop: the audit hooks log and never block', async () => {
  const payload = (event) => base(event, { agent_type: 'general-purpose', agent_id: 'agent-verify' });
  const start = await fire('SubagentStart', payload('SubagentStart'), 'general-purpose');
  const stop = await fire('SubagentStop', payload('SubagentStop'), 'general-purpose');
  for (const [label, result] of [['start', start], ['stop', stop]]) {
    if (result.merged.decision !== 'none') throw new Error(`${label} must not decide, got ${result.merged.decision}`);
    if (result.outputs.length !== 1) throw new Error(`${label}: expected 1 hook, got ${result.outputs.length}`);
  }
  const audit = join(fixture, 'production/session-logs/agent-audit.log');
  if (!existsSync(audit)) throw new Error('agent-audit.log was not written');
  const text = readFileSync(audit, 'utf8');
  if (!/Agent invoked: general-purpose/.test(text)) throw new Error(`audit line missing: ${text}`);
  return 'both logged, neither blocked';
});

testCase('Stop: the session hook archives and allows', async () => {
  const { merged } = await fire('Stop', base('Stop', {}), '');
  if (merged.decision === 'block' || merged.decision === 'deny') throw new Error(`Stop must not block, got ${merged.decision}`);
  return 'ran, no block';
});

testCase('Notification: the toast downgrade emits a system message', async () => {
  const { outputs, merged } = await fire('Notification', base('Notification', { message: 'verify' }), '');
  if (outputs.length !== 1) throw new Error(`expected 1 hook, got ${outputs.length}`);
  const text = `${merged.systemMessages.join(' ')}${merged.additionalContext.join(' ')}`;
  if (text.trim().length === 0) throw new Error('notify emitted nothing');
  return 'emitted a message';
});

testCase('PreCompact/PostCompact run without deciding', async () => {
  for (const event of ['PreCompact', 'PostCompact']) {
    const { outputs, merged } = await fire(event, base(event, { trigger: 'auto' }), '');
    if (outputs.length !== 1) throw new Error(`${event}: expected 1 hook, got ${outputs.length}`);
    if (merged.decision !== 'none') throw new Error(`${event}: unexpected decision ${merged.decision}`);
  }
  return 'both ran';
});

// ------------------------------------------------------------------------ main
buildFixture();
let passed = 0;
const failures = [];
for (const { name, fn } of cases) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
cleanup();
console.log(`\n${passed}/${cases.length} bridge cases passed (protocol: ${protocolPath})`);
process.exit(failures.length === 0 ? 0 : 1);

