#!/usr/bin/env node
/**
 * verify-hooks-mount — mount the REAL hook bridge plugin and fire it.
 *
 *   node tools/verify-hooks-mount.mjs [projectRoot]
 *
 * `verify-hooks-bridge.mjs` drives the hook protocol directly; this script goes one level
 * up and calls `apply()` from the actual `@deepseek-ai/dsh-hooks-claude-code` package, so
 * what runs here is the bridge's own config parsing, matcher selection, payload builders,
 * hook execution, output parsing and decision mapping — only the Cordis context surface is
 * a stand-in (logger / effect / on / shell / agents / sessionProjections).
 *
 * That closes the last gap that cannot be closed from inside a running session: the plugin
 * is a profile plugin and DSH does not hot-mount it, so "is it mounted?" can only be
 * *preflighted* (tools/preflight-hooks.mjs) until the profile is restarted — but "does
 * mounting it wire our hooks to real events?" is answered here.
 *
 * Everything runs against a temp fixture project, and the fixture's own paths arrive
 * through the agent the bridge builds its payloads from. Exit 0 = every event behaved.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(HERE, '..'));

// ------------------------------------------------------------- dsh install lookup
function findDshRoot() {
  const candidates = [
    process.env.DSH_CLI_ROOT,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh') : undefined,
    join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  ].filter((c) => typeof c === 'string');
  return candidates.find((c) => existsSync(join(c, 'package.json')));
}
const dshRoot = findDshRoot();
if (dshRoot === undefined) {
  // Without the dsh install this check cannot run; that is a missing environment, not a
  // failing port, so it reports SKIP rather than a false failure.
  console.log('SKIP: could not locate the dsh install (set DSH_CLI_ROOT to its package dir).');
  process.exit(0);
}
const bridgePath = join(dshRoot, 'node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js');
if (!existsSync(bridgePath)) {
  console.error(`FAIL: bridge plugin not found at ${bridgePath}`);
  process.exit(1);
}
const bridge = await import(pathToFileURL(bridgePath).href);

// ---------------------------------------------------------------------- fixture
const fixture = mkdtempSync(join(tmpdir(), 'DSGS-mount-'));
function buildFixture() {
  writeFileSync(join(fixture, 'project.yaml'), 'schema_version: 1\nmodes:\n  rigor: minimal\n', 'utf8');
  cpSync(join(ROOT, '.dsh/hooks'), join(fixture, '.dsh/hooks'), { recursive: true });
  cpSync(join(ROOT, '.dsh/rules'), join(fixture, '.dsh/rules'), { recursive: true });
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'tools/yaml-helper.mjs'), join(fixture, 'tools/yaml-helper.mjs'));
  mkdirSync(join(fixture, 'src/gameplay'), { recursive: true });
  mkdirSync(join(fixture, 'assets/data'), { recursive: true });
  mkdirSync(join(fixture, 'production/session-state'), { recursive: true });
  writeFileSync(join(fixture, 'production/session-state/active.md'), '# Session State\n\nCHECKPOINT\n- fixture\n', 'utf8');
  const git = (args) => spawnSync('git', args, { cwd: fixture, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'mount@example.invalid']);
  git(['config', 'user.name', 'verify-mount']);
  writeFileSync(join(fixture, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
}

// ------------------------------------------------------------------ the fake ctx
const warnings = [];
const handlers = new Map();
const disposers = [];
const sessionEvents = [];
const childAgent = {
  session: { header: { id: 'child-session', cwd: fixture } },
  inject: () => {},
};
const agent = {
  session: {
    header: { id: 'mount-session', cwd: fixture },
    // The bridge records a hook/invoked + hook/result pair per hook when the event
    // carries an open turn; this is that durable audit surface.
    append: (type, payload) => sessionEvents.push({ type, payload }),
  },
  injected: [],
  inject(message) {
    this.injected.push(message);
  },
  steer: () => {},
};

const ctx = {
  logger: { warn: (...args) => warnings.push(args.join(' ')), info: () => {}, debug: () => {}, error: (...a) => warnings.push(a.join(' ')) },
  effect(fn) {
    disposers.push(fn());
  },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
  },
  get(key) {
    if (key === 'agents') return { get: () => childAgent };
    return undefined;
  },
  // `lastTurn` reads a projection; returning no `lastTurn` keeps the bridge's
  // per-turn hook/invoked logging out of the way (it needs a real session).
  sessionProjections: { stateOf: () => ({}) },
  shell: createShellShim(),
};

/** runHook asks a shell service to execute { command, stdin, workdir, env }. */
function createShellShim() {
  return {
    resolve: (request) => request,
    async execute(request) {
      const dir = mkdtempSync(join(tmpdir(), 'mount-shim-'));
      const inFile = join(dir, 'in.txt');
      const outFile = join(dir, 'out.txt');
      const errFile = join(dir, 'err.txt');
      writeFileSync(inFile, request.stdin ?? '', 'utf8');
      const line = `${request.command} < "${inFile}" > "${outFile}" 2> "${errFile}"`;
      const options = {
        cwd: request.workdir,
        env: { ...process.env, ...(request.env ?? {}) },
        stdio: 'ignore',
        timeout: request.timeoutMs,
        windowsHide: true,
      };
      const result = process.platform === 'win32'
        ? spawnSync('cmd', ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
        : spawnSync(line, { ...options, shell: true });
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

const fire = async (event, ...args) => {
  const list = handlers.get(event) ?? [];
  if (list.length === 0) throw new Error(`the bridge registered no handler for ${event}`);
  let result;
  for (const handler of list) result = await handler(...args);
  return result;
};

const allow = async () => ({ kind: 'enter' });
const textOf = (contexts) => JSON.stringify(contexts ?? []);

// ------------------------------------------------------------------------ cases
buildFixture();
const cases = [];
const testCase = (name, fn) => cases.push({ name, fn });

try {
  await bridge.apply(ctx, { configPath: join(ROOT, '.dsh/hooks.json') });
} catch (error) {
  console.error(`FAIL: apply() threw: ${error?.stack ?? error}`);
  rmSync(fixture, { recursive: true, force: true });
  process.exit(1);
}

testCase('apply() registers every supported event', () => {
  const expected = ['agent/created', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'subagent/start', 'subagent/end'];
  const missing = expected.filter((event) => !handlers.has(event));
  if (missing.length > 0) throw new Error(`no handler for ${missing.join(', ')}`);
  if (warnings.length > 0) throw new Error(`apply() warned: ${warnings.join(' | ')}`);
  return `${handlers.size} events wired`;
});

testCase('SessionStart hooks inject context into the agent', async () => {
  agent.injected.length = 0;
  await fire('agent/created', { agent, source: 'startup', signal: undefined });
  if (agent.injected.length === 0) throw new Error('no context was injected');
  const text = JSON.stringify(agent.injected);
  if (!/fixture|project/i.test(text)) throw new Error(`injected context looks empty: ${text.slice(0, 120)}`);
  return `${agent.injected.length} message(s) injected`;
});

testCase('an unrelated tool call is allowed through', async () => {
  const decision = await fire('tools/pre-execute', {
    name: 'pwsh', arguments: { command: 'git status' }, callId: 'c1', agent, signal: undefined,
  }, allow);
  if (decision?.kind !== 'enter') throw new Error(`expected the downstream allow, got ${JSON.stringify(decision)}`);
  return 'next() reached';
});

testCase('the commit gate denies a broken staged JSON through the bridge', async () => {
  writeFileSync(join(fixture, 'assets/data/broken.json'), '{ "a": 1,, }\n', 'utf8');
  spawnSync('git', ['add', 'assets/data/broken.json'], { cwd: fixture, stdio: 'ignore' });
  const decision = await fire('tools/pre-execute', {
    name: 'pwsh', arguments: { command: 'git commit -m "x"' }, callId: 'c2', agent, signal: undefined,
  }, allow);
  spawnSync('git', ['reset'], { cwd: fixture, stdio: 'ignore' });
  if (decision?.kind !== 'deny') throw new Error(`expected deny, got ${JSON.stringify(decision)}`);
  if (!/JSON/i.test(decision.reason ?? '')) throw new Error(`reason looks wrong: ${decision.reason}`);
  return `denied: ${String(decision.reason).split('\n')[0].slice(0, 60)}`;
});

testCase('the path-rule hook injects rule text after an edit', async () => {
  const decision = await fire('tools/post-execute', {
    name: 'edit', arguments: { file_path: join(fixture, 'src/gameplay/combat.gd') }, callId: 'c3', agent, signal: undefined,
  }, { content: [{ type: 'text', text: 'ok' }] }, allow);
  const text = textOf(decision?.additionalContexts);
  if (!/gameplay-code\.md/.test(text)) throw new Error(`rule text missing: ${text.slice(0, 160)}`);
  return 'gameplay rule injected';
});

testCase('an invalid data write is blocked through the bridge', async () => {
  const bad = join(fixture, 'assets/data/written-bad.json');
  writeFileSync(bad, '{ nope }\n', 'utf8');
  const decision = await fire('tools/post-execute', {
    name: 'write', arguments: { file_path: bad }, callId: 'c4', agent, signal: undefined,
  }, { content: [{ type: 'text', text: 'ok' }] }, allow);
  if (decision?.kind !== 'block') throw new Error(`expected block, got ${JSON.stringify(decision)}`);
  return 'blocked';
});

testCase('a protected-branch push warns without blocking', async () => {
  const decision = await fire('tools/pre-execute', {
    name: 'pwsh', arguments: { command: 'git push origin main' }, callId: 'c5', agent, signal: undefined,
  }, allow);
  if (decision?.kind !== 'enter') throw new Error(`push must not deny, got ${JSON.stringify(decision)}`);
  return 'not blocked';
});

testCase('subagent start/end run the audit hooks', async () => {
  const info = { id: 'child-1', runId: 'run-1', agentType: 'general-purpose' };
  await fire('subagent/start', info);
  await fire('subagent/end', info);
  return 'both dispatched';
});

testCase('Stop runs the session hook, returns no deny, and logs the pair', async () => {
  let steered = false;
  const stoppingAgent = {
    session: {
      header: { id: 'mount-session', cwd: fixture },
      append: (type, payload) => sessionEvents.push({ type, payload }),
    },
    steer: () => { steered = true; },
  };
  sessionEvents.length = 0;
  await fire('agent/turn-stopping', { agent: stoppingAgent, turn: 1, signal: undefined });
  if (steered) throw new Error('the Stop hook steered the agent — it must not block');
  const invoked = sessionEvents.filter((event) => event.type === 'hook/invoked');
  const result = sessionEvents.filter((event) => event.type === 'hook/result');
  if (invoked.length === 0 || result.length === 0) {
    throw new Error(`expected a hook/invoked + hook/result pair, got ${JSON.stringify(sessionEvents.map((e) => e.type))}`);
  }
  if (!invoked.every((event) => event.payload.point === 'Stop')) {
    throw new Error(`unexpected point in the audit pair: ${JSON.stringify(invoked.map((e) => e.payload.point))}`);
  }
  return `${invoked.length} invoked / ${result.length} result recorded`;
});

// ------------------------------------------------------------------------ run
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

// Drain the bridge's detached runs (session/subagent hooks) before asserting on files.
for (const dispose of disposers) {
  try {
    await dispose();
  } catch {
    /* a disposer that throws is reported by the audit assertion below, if it matters */
  }
}

const audit = join(fixture, 'production/session-logs/agent-audit.log');
if (existsSync(audit) && /Agent invoked/.test(readFileSync(audit, 'utf8'))) {
  passed += 1;
  console.log('  ok   the audit log was written by the SubagentStart hook');
} else {
  failures.push('audit log: the SubagentStart hook left no record');
  console.log('  FAIL the audit log was written by the SubagentStart hook');
}

if (warnings.length > 0) {
  console.log(`\n  bridge warnings (${warnings.length}):`);
  for (const warning of warnings.slice(0, 5)) console.log(`    ${warning}`);
}

rmSync(fixture, { recursive: true, force: true });
const total = cases.length + 1;
console.log(`\n${passed}/${total} mount cases passed (bridge: ${bridgePath})`);
process.exit(failures.length === 0 ? 0 : 1);

