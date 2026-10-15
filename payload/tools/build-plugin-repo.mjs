#!/usr/bin/env node
/**
 * build-plugin-repo — assemble the hook bridge plugin as its own distributable git repository.
 *
 * The plugin lives in `tools/dsh-plugin/` because that is what the local profile row points at.
 * Distribution needs something else: a self-contained package with a README, a licence and a
 * test, committed on its own `main`, that anyone can install from a GitHub address or from the
 * bundle this script also writes. `dist/` is already gitignored, so the generated repository never
 * becomes a nested repo inside this one.
 *
 * Run: node tools/build-plugin-repo.mjs
 *
 * @module tools/build-plugin-repo
 */

import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'tools', 'dsh-plugin');
const OUT = join(ROOT, 'dist', 'dsgs-hooks');
const BUNDLE = join(ROOT, 'dist', 'dsgs-hooks.bundle');

/** The harness + bridge versions this plugin was verified against. */
const VERIFIED = JSON.parse(readFileSync(join(ROOT, '.dsh', 'PORT-MANIFEST.json'), 'utf8')).bridge ?? {};

const README = `# dsgs-hooks

Mounts a DeepSeek Game Studios project's hook configuration on DSH and runs the hooks **directly**,
so they work regardless of the sandbox or of the directory the harness was launched from.

Part of [DeepSeek Game Studios](https://github.com/) — a DSH port of the Claude Code Game Studios
template. This package is only the bridge; the hook scripts themselves live in the project.

## Why it exists

DSH already has a hook bridge (\`@deepseek-ai/dsh-hooks-claude-code\`), and this plugin uses it — but
it calls it through its \`execute()\` API itself instead of letting the bridge spawn a shell. Two
failures motivated that:

1. **The sandboxed-shell silent no-op.** Hook commands spawned through the sandboxed shell fail
   before the hook runs (on Windows the ACL temp-root check rejects it), and the hook protocol turns
   *any* executor failure into a neutral allow. Hooks look mounted and do nothing. Running the
   command directly avoids the shell entirely.
2. **Launch-directory dependence.** A bridge configured with a relative config path only finds the
   hooks when the harness happens to start inside the project. This plugin walks up from the launch
   directory to find \`<project>/.dsh/hooks.json\`, so \`dsh web\` started anywhere still mounts the
   project's hooks.

## Install

From a GitHub address:

\`\`\`pwsh
dsh plugin add github:HYClub/dsgs-hooks
\`\`\`

From a local checkout or an unpacked bundle:

\`\`\`pwsh
dsh plugin add <path-to-this-directory>
\`\`\`

The bundled patch inserts one profile row (\`id: dsgs-hooks\`) with an empty config on purpose: the
plugin discovers \`<project>/.dsh/hooks.json\` by walking up from the launch directory, so a
plugin-manager install needs no configuration.

**Restart the harness afterwards** — profile rows are mounted at startup, not hot-added.

## Configuration

| Where | What |
|---|---|
| \`<project>/.dsh/hooks.json\` | discovered automatically by walking up from the launch directory |
| \`DSH_DSGS_HOOKS_CONFIG\` | environment override, absolute path to a hook config |
| \`configPath\` in the profile row | explicit override; wins over discovery |

## Verify it is live

\`\`\`pwsh
dsh hookcheck --from-default-profile headless "<any prompt>"
\`\`\`

A working mount writes an invocation audit next to the project (\`.verify-logs/hook-invocations.log\`
when \`auditFile\` is set in the config) with one \`resolve\` and one \`exit=\` line per hook that ran.
Silence plus a mounted row is the failure mode this plugin exists to prevent: check the audit, not
the presence of the row.

## Known platform limits (measured, not assumed)

**Pre-execution advisories cannot reach the model on this harness.** The upstream framework's
PreToolUse hooks carry a \`systemMessage\` / \`hookSpecificOutput.additionalContext\` meant to be shown
alongside the tool call. Two live experiments (2026-10-10, DSH 0.2.0-rc.2) settled it:

1. Running PreToolUse ourselves and returning \`additionalContexts\` from \`tools/pre-execute\`: the
   hook executes (the invocation audit shows \`resolve\` and \`exit=0\`), but \`dsh-agent-loop\` reads
   that field only from the **finalized tool result**, so a pre-execute value never enters the
   conversation. The harness's own \`dsh-repeat-tool-reminder\` binds \`tools/post-execute\` for
   exactly this reason.
2. Calling \`agent.inject(context)\` mid-execution (the API the bridge uses for SessionStart
   context): no observable effect.

So this plugin deliberately leaves PreToolUse to the official bridge, and DSGS delivers its
advisories on the PostToolUse channel that does work. **PreToolUse \`deny\`/\`ask\` still work** — only
the "warn before you act" half is unavailable.

To reproduce: point the plugin at a config whose PreToolUse hook prints a fixed
\`hookSpecificOutput.additionalContext\` (see \`tools/dsh-hooks-pretooluse-probe.yml\` and
\`.verify-logs/pretooluse-probe-hooks.json\` in the parent project), run a headless session, and ask
the model to quote that text. It reports receiving nothing.

## Compatibility

Verified against DSH **0.2.0-rc.2** with bridge **@deepseek-ai/dsh-hooks-claude-code@0.1.0-rc.7**
(${JSON.stringify(VERIFIED)}). The plugin resolves the bridge from the install that is running it,
so a DSH upgrade that moves the bridge package is picked up automatically; a peer-dependency
mismatch is surfaced by the loader as \`Plugin … is incompatible with dsh …\` rather than failing
silently.

## Test

\`\`\`pwsh
node --test test/
\`\`\`

## Licence

MIT. This plugin is part of DeepSeek Game Studios, a DSH port of the Claude Code Game Studios
template by Donchitos (MIT); the upstream template's copyright is retained in the parent project.
`;

const LICENSE = `MIT License

Copyright (c) 2026 DeepSeek Game Studios contributors

This package is part of DeepSeek Game Studios, a DSH (DeepSeek Harness) port of the
Claude Code Game Studios template by Donchitos (MIT licensed). The upstream template's
copyright and licence are retained in the parent project.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const TEST = `#!/usr/bin/env node
/**
 * The package's own test: it must load standalone (no monorepo helpers), export the plugin
 * surface DSH looks for, and refuse to invent a hook config that is not there.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const plugin = await import('../index.js');

test('exports the DSH plugin surface', () => {
  assert.equal(plugin.name, 'dsgs-hooks');
  assert.deepEqual(plugin.inject, ['shell', 'sessionProjections']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.findHookConfig, 'function');
  assert.equal(typeof plugin.createDirectShell, 'function');
});

test('apply refuses a config it cannot resolve instead of mounting nothing silently', () => {
  const seen = [];
  const ctx = {
    logger: { warn: (m) => seen.push(m), info() {}, error: (m) => seen.push(m) },
    on: () => () => {},
  };
  const result = plugin.apply(ctx, { configPath: join(tmpdir(), 'definitely-not-here.json') });
  assert.equal(result, undefined);
  assert.ok(seen.length > 0, 'a missing config must be reported, not swallowed');
});

test('findHookConfig walks up to the project hook config', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsgs-hooks-'));
  try {
    mkdirSync(join(root, '.dsh'), { recursive: true });
    writeFileSync(join(root, '.dsh', 'hooks.json'), '{"hooks":{}}');
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    assert.equal(plugin.findHookConfig(nested), join(root, '.dsh', 'hooks.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The three hook events the official bridge has no code for. The plugin runs their hook groups
 * itself against DSH's own events, so these tests pin the mapping and the payload contract.
 */
function unmappedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'DSGS-unmapped-'));
  const configPath = join(root, '.dsh', 'hooks.json');
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: 'node ".dsh/hooks/pre-compact.mjs"' }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'node ".dsh/hooks/post-compact.mjs"', timeout: 5 }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'node ".dsh/hooks/notify.mjs"' }] }],
    },
  }, null, 2));
  const handlers = new Map();
  const calls = [];
  const ctx = {
    logger: { warn: (m) => calls.push({ warn: m }) },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); },
  };
  const shell = {
    execute: (request) => {
      calls.push(request);
      return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) };
    },
  };
  const disposers = plugin.registerUnmappedHooks(ctx, { shell, configPath, projectDir: root });
  return { root, handlers, calls, disposers };
}

test('the three unmapped events are registered and nothing else', () => {
  const fixture = unmappedFixture();
  try {
    assert.deepEqual([...fixture.handlers.keys()].sort(), ['approval/asked', 'compact/end', 'compact/start']);
    assert.equal(fixture.disposers.length, 3);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('compact/start runs the PreCompact hook with the upstream event name', async () => {
  const fixture = unmappedFixture();
  try {
    await fixture.handlers.get('compact/start')({ trigger: 'auto', sessionId: 's1' }, async () => {});
    const call = fixture.calls.find((c) => typeof c === 'object' && c.command !== undefined);
    assert.match(call.command, /pre-compact\.mjs/);
    const body = JSON.parse(call.stdin);
    assert.equal(body.hook_event_name, 'PreCompact');
    assert.equal(body.trigger, 'auto');
    assert.equal(body.session_id, 's1');
    assert.equal(call.env.CLAUDE_PROJECT_DIR, fixture.root);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('approval/asked becomes a Notification whose message names the tool', async () => {
  const fixture = unmappedFixture();
  try {
    await fixture.handlers.get('approval/asked')({ toolName: 'pwsh', reason: 'needs approval' }, async () => {});
    const call = fixture.calls.find((c) => typeof c === 'object' && c.command !== undefined);
    assert.match(call.command, /notify\.mjs/);
    const body = JSON.parse(call.stdin);
    assert.equal(body.hook_event_name, 'Notification');
    assert.match(body.message, /pwsh/);
    assert.match(body.message, /needs approval/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

`;

/**
 * Run git and return its stdout.
 *
 * A confined DSH session cannot open named pipes, so `stdio: 'pipe'` fails with EPERM for any
 * child process (`node:child_process`). Output is redirected to a file instead, which the sandbox
 * allows, and stderr is inherited so a git failure is visible in the run.
 */
function git(args, cwd) {
  const capture = join(ROOT, 'dist', '.git-capture.txt');
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const fd = openSync(capture, 'w');
  try {
    const status = spawnSync('git', args, { cwd, stdio: ['ignore', fd, 'inherit'] }).status;
    if (status !== 0) throw new Error(`git ${args.join(' ')} failed with exit ${status}`);
    return readFileSync(capture, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

function main() {
  if (!existsSync(SOURCE)) {
    console.error(`missing plugin source: ${SOURCE}`);
    return 2;
  }
  rmSync(OUT, { recursive: true, force: true });
  rmSync(BUNDLE, { force: true });
  mkdirSync(join(OUT, 'test'), { recursive: true });

  for (const file of ['index.js', 'package.json', 'cordis.patch.yml']) {
    cpSync(join(SOURCE, file), join(OUT, file));
  }
  writeFileSync(join(OUT, 'README.md'), README, 'utf8');
  writeFileSync(join(OUT, 'LICENSE'), LICENSE, 'utf8');
  writeFileSync(join(OUT, 'test', 'plugin.test.mjs'), TEST, 'utf8');
  writeFileSync(join(OUT, '.gitignore'), 'node_modules/\n*.log\n', 'utf8');

  // A commit is what makes the package installable by address; `dist/` is gitignored, so this
  // repository is never nested inside the parent one.
  git(['init', '-b', 'main'], OUT);
  git(['add', '-A'], OUT);
  git(['-c', 'user.name=DeepSeek Game Studios', '-c', 'user.email=DSGS@example.invalid',
    'commit', '-m', 'dsgs-hooks 0.1.0 — mount DSGS hook configs on DSH with direct execution'], OUT);
  git(['tag', '-a', 'v0.1.0', '-m', 'dsgs-hooks 0.1.0'], OUT);
  git(['bundle', 'create', BUNDLE, '--all'], OUT);

  const files = git(['ls-files'], OUT).split('\n');
  const size = statSync(BUNDLE).size;
  console.log(`plugin repo   ${OUT}`);
  console.log(`              ${files.length} tracked file(s): ${files.join(', ')}`);
  console.log(`              commit ${git(['rev-parse', '--short', 'HEAD'], OUT)} on ${git(['branch', '--show-current'], OUT)}`);
  console.log(`bundle        ${BUNDLE} (${size} B)`);
  console.log('\nPush it (once you have an address):');
  console.log(`  git -C "${OUT}" remote add origin <url>`);
  console.log(`  git -C "${OUT}" push -u origin main --tags`);
  console.log('\nOr hand someone the bundle:');
  console.log(`  git clone "${BUNDLE}" dsgs-hooks`);
  return 0;
}

process.exit(main());



