#!/usr/bin/env node
/**
 * Tests for the DSH port of `.claude/hooks/session-start.sh` (dsh-src/hooks/session-start.mjs).
 *
 *   node tools/tests/hooks/session-start.test.mjs
 *
 * Every case builds a throwaway project under the OS temp dir (never the repo), runs the hook
 * as a child process with the fixture as cwd, and asserts on the `additionalContext` text of
 * the structured decision the hook prints.
 *
 * STDIN/STDOUT ARE FILE DESCRIPTORS, NOT PIPES. The DSH sandbox denies piped child stdio
 * (`spawn ... EPERM`), which is the same constraint that forces runtime.capture() to redirect
 * into a temp file. The harness therefore writes the hook payload into a file and hands the
 * child file descriptors, exactly like capture() does.
 *
 * Config-dependent cases copy the repo's real tools/yaml-helper.mjs into the fixture, so the
 * fixture is self-contained and the repo's config is never read. If that file does not exist,
 * those cases are SKIPPED (and reported), never silently passed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const HOOK = join(REPO, 'dsh-src', 'hooks', 'session-start.mjs');
const HELPER = join(REPO, 'tools', 'yaml-helper.mjs');
const HAVE_HELPER = existsSync(HELPER);

const TEMP = [];
const cleanup = () => {
  while (TEMP.length > 0) {
    const dir = TEMP.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
};

/** Create a fixture project. `.dsh/` is always present so projectRoot() resolves to the
 * fixture and never walks up to this repository. */
function fixture({ files = {}, dirs = [], helper = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-start-'));
  TEMP.push(root);
  mkdirSync(join(root, '.dsh'), { recursive: true });
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  if (helper && HAVE_HELPER) {
    mkdirSync(join(root, 'tools'), { recursive: true });
    cpSync(HELPER, join(root, 'tools', 'yaml-helper.mjs'));
  }
  return root;
}

function runHook(root, { payload, raw, noStdin = false } = {}) {
  const io = mkdtempSync(join(tmpdir(), 'dsh-session-start-io-'));
  TEMP.push(io);
  const inPath = join(io, 'stdin.json');
  const outPath = join(io, 'stdout.txt');
  const errPath = join(io, 'stderr.txt');
  const body = raw !== undefined
    ? raw
    : JSON.stringify({ session_id: 'sess-test', cwd: root, hook_event_name: 'SessionStart', source: 'startup', ...(payload ?? {}) });
  writeFileSync(inPath, body, 'utf8');

  let stdin = 'ignore';
  let inFd = null;
  if (!noStdin) {
    inFd = openSync(inPath, 'r');
    stdin = inFd;
  }
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: root, stdio: [stdin, outFd, errFd], timeout: 60_000, windowsHide: true,
  });
  if (inFd !== null) closeSync(inFd);
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    error: res.error,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

/** Assert the hook's contract shape and return the injected context text. */
function contextOf(res) {
  assert.equal(res.error, undefined, `spawn failed: ${res.error?.code ?? res.error}`);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    assert.fail(`stdout is not one JSON object: ${JSON.stringify(res.stdout.slice(0, 300))}`);
  }
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
  return parsed.hookSpecificOutput.additionalContext;
}

const has = (text, ...needles) => {
  for (const needle of needles) assert.ok(text.includes(needle), `missing: ${needle}\n--- got ---\n${text}`);
};
const lacks = (text, ...needles) => {
  for (const needle of needles) assert.ok(!text.includes(needle), `unexpected: ${needle}\n--- got ---\n${text}`);
};

const countNewlines = (text) => (text.match(/\n/g) ?? []).length;

const cases = [];
const test = (name, fn, { needsHelper = false } = {}) => cases.push({ name, fn, needsHelper });

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const BANNER = '=== DeepSeek Game Studios — Session Context ===';

test('bare DSH root: no project.yaml, no state, no git repo', () => {
  const root = fixture();
  const res = runHook(root);
  const ctx = contextOf(res);
  has(ctx, BANNER, 'Review mode: solo', '===================================');
  lacks(ctx, 'ACTIVE SESSION STATE DETECTED', 'Branch:', 'schema errors');
  // No skipped checks in a bare project.
  assert.ok(!res.stderr.includes('NOT RUN'), `unexpected NOT RUN note: ${res.stderr}`);
});

test('empty stdin and malformed stdin still inject context and exit 0', () => {
  const root = fixture();
  // `null` / `[]` matter: readInput() returns whatever JSON.parse produced, so a bare `null`
  // would make projectRoot(null) throw and the hook would silently do nothing.
  for (const opts of [{ raw: '' }, { raw: 'not json at all' }, { raw: 'null' }, { raw: '[]' }, { noStdin: true }]) {
    const res = runHook(root, opts);
    const ctx = contextOf(res);
    has(ctx, BANNER, 'Review mode: solo');
  }
});

test('git context: branch and recent commits', () => {
  const root = fixture();
  const git = (args) => spawnSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['checkout', '-q', '-b', 'port/hooks']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: fixture commit']);
  const ctx = contextOf(runHook(root));
  has(ctx, 'Branch: port/hooks', 'Recent commits:', 'feat: fixture commit');
});

test('well-formed CHECKPOINT is previewed; narrative is not', () => {
  const state = [
    '# Session State',
    '',
    '<!-- CHECKPOINT -->',
    '- goal: port the hooks',
    '- next: write tests',
    '<!-- /CHECKPOINT -->',
    '',
    '## Narrative',
    'NARRATIVE-SHOULD-NOT-BE-PREVIEWED',
    '',
  ].join('\n');
  const root = fixture({ files: { 'production/session-state/active.md': state } });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '=== ACTIVE SESSION STATE DETECTED ===',
    'A previous session left state at: production/session-state/active.md',
    'Read this file to recover context and continue where you left off.',
    'Checkpoint:',
    '- goal: port the hooks',
    '- next: write tests',
    `  ... (${countNewlines(state)} total lines — read the full file for detail)`,
    '=== END SESSION STATE PREVIEW ===',
  );
  lacks(ctx, 'NARRATIVE-SHOULD-NOT-BE-PREVIEWED', 'checkpoint truncated', 'Quick summary');
});

test('unterminated CHECKPOINT is refused, not previewed as state', () => {
  const state = '# Session State\n\n<!-- CHECKPOINT -->\n- goal: x\nNARRATIVE-SHOULD-NOT-BE-PREVIEWED\n';
  const root = fixture({ files: { 'production/session-state/active.md': state } });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '[!] CHECKPOINT block is not terminated — no <!-- /CHECKPOINT --> marker.',
    'Not previewing it: without the closing marker the checkpoint',
    'Re-create from .dsh/docs/templates/session-state.md.',
    `  ... (${countNewlines(state)} total lines — read the full file to continue)`,
  );
  lacks(ctx, 'Checkpoint:', 'NARRATIVE-SHOULD-NOT-BE-PREVIEWED', 'Quick summary');
});

test('no CHECKPOINT block falls back to the bounded quick summary', () => {
  const state = `${['# Session State', '', 'L3', 'L4', 'L5'].join('\n')}\n`;
  const root = fixture({ files: { 'production/session-state/active.md': state } });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    'Quick summary (first 20 lines — no CHECKPOINT block in this file):',
    'L5',
    'NOTE: re-create from .dsh/docs/templates/session-state.md so',
  );
  lacks(ctx, 'Checkpoint:', 'checkpoint truncated');
});

test('a checkpoint is capped at 25 lines / 3000 characters and says so', () => {
  const body = Array.from({ length: 30 }, (_, i) => `BODY-${String(i + 1).padStart(2, '0')}`);
  const state = `<!-- CHECKPOINT -->\n${body.join('\n')}\n<!-- /CHECKPOINT -->\n`;
  const root = fixture({ files: { 'production/session-state/active.md': state } });
  const ctx = contextOf(runHook(root));
  has(ctx, 'Checkpoint:', 'BODY-01', 'BODY-25', 'checkpoint truncated (30 lines)');
  lacks(ctx, 'BODY-26');
});

test('a >200 line state file prints the rotation observation', () => {
  const body = Array.from({ length: 260 }, (_, i) => `L${i + 1}`);
  const state = `<!-- CHECKPOINT -->\n${body.join('\n')}\n<!-- /CHECKPOINT -->\n`;
  const root = fixture({ files: { 'production/session-state/active.md': state } });
  const ctx = contextOf(runHook(root));
  has(ctx, `${countNewlines(state)} lines. Narrative can be rotated into`, 'bash .dsh/scripts/rotate-session-state.sh');
});

test('rigor: standard resolves review_mode to lean', () => {
  const root = fixture({ files: { 'project.yaml': 'schema_version: 1\nmodes:\n  rigor: standard\n' } });
  has(contextOf(runHook(root)), 'Review mode: lean');
}, { needsHelper: true });

test('rigor: minimal resolves review_mode to solo (documented default)', () => {
  const root = fixture({ files: { 'project.yaml': 'schema_version: 1\nmodes:\n  rigor: minimal\n' } });
  has(contextOf(runHook(root)), 'Review mode: solo');
}, { needsHelper: true });

test('features.session_state: off suppresses the recovery block', () => {
  const state = '<!-- CHECKPOINT -->\n- goal: hidden\n<!-- /CHECKPOINT -->\n';
  const root = fixture({
    files: {
      'project.yaml': 'schema_version: 1\nfeatures:\n  session_state: off\n',
      'production/session-state/active.md': state,
    },
  });
  const ctx = contextOf(runHook(root));
  has(ctx, BANNER, 'Review mode: solo');
  lacks(ctx, 'ACTIVE SESSION STATE DETECTED', 'goal: hidden');
}, { needsHelper: true });

test('legacy production/review-mode.txt is used when nothing else resolves', () => {
  const root = fixture({ files: { 'production/review-mode.txt': 'full\n' }, helper: false });
  has(contextOf(runHook(root)), 'Review mode: full');
});

test('invalid enum in project.yaml is surfaced as a schema error', () => {
  const root = fixture({ files: { 'project.yaml': 'modes:\n  rigor: chaotic\n' } });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '[!] project.yaml schema errors:',
    "    modes.rigor: 'chaotic' is not a valid value (expected: minimal|standard|full)",
    'Review mode: solo',
  );
}, { needsHelper: true });

test('project.local.yaml without a project.yaml base is a hard error', () => {
  const root = fixture({ files: { 'project.local.yaml': 'modes:\n  review_mode: full\n' } });
  const ctx = contextOf(runHook(root));
  has(ctx, '[!] project.local.yaml exists but project.yaml is missing');
}, { needsHelper: true });

test('stage sources disagreeing produce the observation, never a rewrite', () => {
  const root = fixture({
    files: {
      'project.yaml': 'schema_version: 1\nmodes:\n  rigor: standard\nproject:\n  stage: Concept\n',
      'production/stage.txt': 'Production\n',
    },
  });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '[!] Stage sources disagree:',
    'project.yaml  project.stage : Concept   (authoritative)',
    'production/stage.txt        : Production   (legacy mirror)',
    'Only /gate-check should change a stage (on a PASS, or a',
    'silence this.',
  );
  assert.equal(readFileSync(join(root, 'production/stage.txt'), 'utf8'), 'Production\n', 'hook must not rewrite the mirror');
}, { needsHelper: true });

test('engine reference mismatch against the content-source instruction file is reported', () => {
  const root = fixture({
    files: {
      'project.yaml': 'schema_version: 1\nengine:\n  name: Godot\n',
      'CLAUDE.md': '# Fixture\n\n@docs/engine-reference/unity/VERSION.md\n',
    },
  });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '!! ENGINE REFERENCE MISMATCH',
    'project.yaml engine.name : godot',
    'CLAUDE.md imports     : docs/engine-reference/unity/VERSION.md',
    'Every session is loading the unity reference on a godot project.',
    'Fix: re-run /setup-engine, or edit the ENGINE-REFERENCE-IMPORT line.',
  );
}, { needsHelper: true });

test('engine reference mismatch against the DSH instruction file is reported', () => {
  // The DSH side keeps the engine anchor in AGENTS.md, so that is the file the status line
  // must name when it carries the reference.
  const root = fixture({
    files: {
      'project.yaml': 'schema_version: 1\nengine:\n  name: Godot\n',
      'AGENTS.md': '# Fixture\n\n<!-- ENGINE-REFERENCE-IMPORT: docs/engine-reference/unity/VERSION.md -->\n',
    },
  });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '!! ENGINE REFERENCE MISMATCH',
    'AGENTS.md imports     : docs/engine-reference/unity/VERSION.md',
  );
}, { needsHelper: true });

test('matching engine reference prints no mismatch', () => {
  const root = fixture({
    files: {
      'project.yaml': 'schema_version: 1\nengine:\n  name: Unreal Engine 5\n',
      'CLAUDE.md': '@docs/engine-reference/unreal/VERSION.md\n',
    },
  });
  lacks(contextOf(runHook(root)), 'ENGINE REFERENCE MISMATCH');
}, { needsHelper: true });

test('sprint, milestone, bug count and code health lines', () => {
  const root = fixture({
    dirs: ['production/sprints', 'production/milestones'],
    files: {
      'production/sprints/sprint-01.md': '# one\n',
      'production/sprints/sprint-02.md': '# two\n',
      'production/milestones/m1-core.md': '# m1\n',
      'production/BUG-014-save.md': '# bug\n',
      'src/main.gd': 'extends Node\n# TODO: wire the loop\n# FIXME: leak\n',
    },
  });
  const now = Date.now() / 1000;
  utimesSync(join(root, 'production/sprints/sprint-01.md'), now - 600, now - 600);
  utimesSync(join(root, 'production/sprints/sprint-02.md'), now, now);
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    'Active sprint: sprint-02',
    'Active milestone: m1-core',
    'Open bugs: 1',
    'Code health: 1 TODOs, 1 FIXMEs in src/',
  );
  lacks(ctx, 'Active sprint: sprint-01');
}, { needsHelper: true });

test('missing yaml-helper degrades to defaults and announces every skipped check', () => {
  const root = fixture({
    helper: false,
    files: {
      'project.yaml': 'schema_version: 1\nmodes:\n  rigor: standard\nengine:\n  name: Godot\nproject:\n  stage: Concept\n',
      'production/stage.txt': 'Production\n',
      'production/session-state/active.md': '<!-- CHECKPOINT -->\n- goal: x\n<!-- /CHECKPOINT -->\n',
      'src/main.gd': 'extends Node\n',
    },
  });
  const res = runHook(root);
  const ctx = contextOf(res);
  // Fail-open on the state preview, and the review mode falls back to `solo`, not `lean`.
  has(ctx, 'Review mode: solo', 'ACTIVE SESSION STATE DETECTED');
  has(
    res.stderr,
    'NOT RUN',
    'review_mode could not be resolved from project.yaml',
    'schema validation did not run',
    'stage-agreement check did not run',
    // The shared _session-state.mjs predicate announces its own skip and keeps the fail-open ON.
    'features.session_state NOT checked, treating session state as ON',
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
try {
  for (const { name, fn, needsHelper } of cases) {
    if (needsHelper && !HAVE_HELPER) {
      skipped += 1;
      console.log(`SKIP  ${name} (tools/yaml-helper.mjs is missing)`);
      continue;
    }
    try {
      fn();
      passed += 1;
      console.log(`ok    ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
    }
  }
} finally {
  cleanup();
}

console.log(`\nsession-start.test.mjs: ${passed} passed, ${failed} failed, ${skipped} skipped`
  + (HAVE_HELPER ? '' : ' — config-dependent cases need tools/yaml-helper.mjs'));
process.exitCode = failed === 0 ? 0 : 1;
