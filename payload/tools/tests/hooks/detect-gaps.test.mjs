#!/usr/bin/env node
/**
 * Tests for the DSH port of `.claude/hooks/detect-gaps.sh` (dsh-src/hooks/detect-gaps.mjs).
 *
 *   node tools/tests/hooks/detect-gaps.test.mjs
 *
 * Every case builds a throwaway project under the OS temp dir (never the repo), runs the hook
 * as a child process with the fixture as cwd, and asserts on the `additionalContext` text.
 *
 * STDIN/STDOUT ARE FILE DESCRIPTORS, NOT PIPES: the DSH sandbox denies piped child stdio
 * (`spawn ... EPERM`), the same constraint that shapes runtime.capture().
 *
 * Config-dependent cases copy the repo's real tools/yaml-helper.mjs into the fixture, so the
 * fixture is self-contained and this repository's own config is never read. If that file does
 * not exist those cases are SKIPPED (and reported), never silently passed.
 *
 * The tier matters to most cases: `modes.workflow` scales checks 1, 3 and 4 (and gates check 6),
 * and it is rigor-fronted, so a rigor-only project resolves it through the expansion table. The
 * fixtures below therefore state `modes.rigor` explicitly instead of leaving it to defaults.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const HOOK = join(REPO, 'dsh-src', 'hooks', 'detect-gaps.mjs');
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

function fixture({ files = {}, dirs = [], helper = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-detect-gaps-'));
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

/** Write N files into <root>/<dir>. */
function manyFiles(root, dir, names, content = 'pass\n') {
  mkdirSync(join(root, dir), { recursive: true });
  for (const name of names) writeFileSync(join(root, dir, name), content, 'utf8');
}

const numbered = (prefix, count, ext) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}.${ext}`);

function runHook(root, { payload, raw, noStdin = false } = {}) {
  const io = mkdtempSync(join(tmpdir(), 'dsh-detect-gaps-io-'));
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

/** project.yaml that pins the doc-check tier without configuring an engine. */
const STANDARD = 'schema_version: 1\nmodes:\n  rigor: standard\n';
const MINIMAL = 'schema_version: 1\nmodes:\n  rigor: minimal\n';

const cases = [];
const test = (name, fn, { needsHelper = false } = {}) => cases.push({ name, fn, needsHelper });

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('fresh project gets the NEW PROJECT banner and nothing else', () => {
  const root = fixture();
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '=== Checking for Documentation Gaps ===',
    '🚀 NEW PROJECT: No engine configured, no game concept, no source code.',
    '   This looks like a fresh start! Run: /start',
    '💡 To get a comprehensive project analysis, run: /project-stage-detect',
    '===================================',
  );
  lacks(ctx, '⚠️  GAP', 'v1.0 PROJECT');
});

test('empty stdin, malformed stdin and a closed stdin still exit 0 with context', () => {
  const root = fixture();
  // `null` / `[]` matter: readInput() returns whatever JSON.parse produced, so a bare `null`
  // would make projectRoot(null) throw and the hook would silently do nothing.
  for (const opts of [{ raw: '' }, { raw: '}{ broken' }, { raw: 'null' }, { raw: '[]' }, { noStdin: true }]) {
    const ctx = contextOf(runHook(root, opts));
    has(ctx, '=== Checking for Documentation Gaps ===', '🚀 NEW PROJECT');
  }
});

test('a configured engine alone is enough to leave the fresh state', () => {
  const root = fixture({ files: { 'project.yaml': 'schema_version: 1\nengine:\n  name: Godot\n' } });
  const ctx = contextOf(runHook(root));
  lacks(ctx, '🚀 NEW PROJECT', '⚠️  GAP');
  has(ctx, '💡 To get a comprehensive project analysis, run: /project-stage-detect');
}, { needsHelper: true });

test('the minimal tier produces no design-doc gaps', () => {
  const root = fixture({ files: { 'project.yaml': MINIMAL, 'design/game-brief.md': '# brief\n', 'src/main.gd': 'extends Node\n' } });
  manyFiles(root, 'src', numbered('sys', 60, 'gd'));
  mkdirSync(join(root, 'src/core'), { recursive: true });
  writeFileSync(join(root, 'src/core/state.gd'), 'extends Node\n', 'utf8');
  const ctx = contextOf(runHook(root));
  lacks(ctx, '🚀 NEW PROJECT', '⚠️  GAP');
  has(ctx, '===================================');
}, { needsHelper: true });

test('check 1: substantial codebase with sparse design docs', () => {
  const root = fixture({ files: { 'project.yaml': STANDARD } });
  manyFiles(root, 'src', numbered('sys', 51, 'gd'));
  has(
    contextOf(runHook(root)),
    '⚠️  GAP: Substantial codebase (51 source files) but sparse design docs (0 files)',
    '    Suggested action: /reverse-document design src/[system]',
    '    Or run: /project-stage-detect to get full analysis',
  );
}, { needsHelper: true });

test('check 1 counts design/gdd/*.md and stays quiet above the threshold', () => {
  const root = fixture({ files: { 'project.yaml': STANDARD } });
  manyFiles(root, 'src', numbered('sys', 51, 'gd'));
  manyFiles(root, 'design/gdd', ['a.md', 'b.md'], '# doc\n');
  has(contextOf(runHook(root)), 'sparse design docs (2 files)');
  manyFiles(root, 'design/gdd', ['c.md', 'd.md', 'e.md'], '# doc\n');
  lacks(contextOf(runHook(root)), 'Substantial codebase');
}, { needsHelper: true });

test('check 2: prototypes without README or CONCEPT are listed', () => {
  const root = fixture({
    files: { 'project.yaml': STANDARD, 'src/main.gd': 'extends Node\n', 'prototypes/beta/README.md': '# beta\n' },
    dirs: ['prototypes/alpha'],
  });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '⚠️  GAP: 1 undocumented prototype(s) found:',
    '    - prototypes/alpha/ (no README or CONCEPT doc)',
    '    Suggested action: /reverse-document concept prototypes/[name]',
  );
  lacks(ctx, 'prototypes/beta');
}, { needsHelper: true });

test('check 2 fires at the minimal tier (it is not tier-gated)', () => {
  const root = fixture({
    files: { 'project.yaml': MINIMAL, 'design/game-brief.md': '# brief\n' },
    dirs: ['prototypes/alpha'],
  });
  has(contextOf(runHook(root)), 'undocumented prototype(s) found:', '- prototypes/alpha/');
}, { needsHelper: true });

test('check 3: core systems without docs/architecture, then with too few ADRs', () => {
  const bare = fixture({ files: { 'project.yaml': STANDARD, 'src/core/state.gd': 'extends Node\n' } });
  has(
    contextOf(runHook(bare)),
    '⚠️  GAP: Core engine/systems exist but no docs/architecture/ directory',
    '    Suggested action: Create docs/architecture/ and run /architecture-decision',
  );

  const few = fixture({ files: { 'project.yaml': STANDARD, 'src/engine/tick.gd': 'extends Node\n' } });
  manyFiles(few, 'docs/architecture', ['adr-001.md', 'adr-002.md'], '# adr\n');
  has(
    contextOf(runHook(few)),
    '⚠️  GAP: Core systems exist but only 2 ADR(s) documented',
    '    Suggested action: /reverse-document architecture src/core/[system]',
  );

  manyFiles(few, 'docs/architecture', ['adr-003.md'], '# adr\n');
  lacks(contextOf(runHook(few)), 'ADR(s) documented');
}, { needsHelper: true });

test('check 4: a gameplay system of 5+ files without a design doc', () => {
  const root = fixture({ files: { 'project.yaml': STANDARD } });
  manyFiles(root, 'src/gameplay/combat', numbered('hit', 5, 'gd'));
  has(
    contextOf(runHook(root)),
    "⚠️  GAP: Gameplay system 'src/gameplay/combat/' (5 files) has no design doc",
    '    Expected: design/gdd/combat-system.md or design/gdd/combat.md',
    '    Suggested action: /reverse-document design src/gameplay/combat',
  );
  // Under 5 files: not a "system" yet.
  manyFiles(root, 'src/gameplay/audio', numbered('mix', 4, 'gd'));
  lacks(contextOf(runHook(root)), 'gameplay/audio/');

  const documented = fixture({ files: { 'project.yaml': STANDARD, 'design/gdd/combat.md': '# combat\n' } });
  manyFiles(documented, 'src/gameplay/combat', numbered('hit', 5, 'gd'));
  lacks(contextOf(runHook(documented)), 'Gameplay system');
}, { needsHelper: true });

test('check 5 fires on a large codebase even at the minimal tier (preserved quirk)', () => {
  const root = fixture({ files: { 'project.yaml': MINIMAL, 'design/game-brief.md': '# brief\n' } });
  manyFiles(root, 'src', numbered('sys', 101, 'gd'));
  const ctx = contextOf(runHook(root));
  has(ctx, '⚠️  GAP: Large codebase (101 files) but no production planning found', '    Suggested action: /sprint-plan or create production/ directory');
  lacks(ctx, 'Substantial codebase');
}, { needsHelper: true });

test('check 5 stays quiet when sprints or milestones exist', () => {
  const root = fixture({ files: { 'project.yaml': MINIMAL, 'production/sprints/sprint-01.md': '# s\n' } });
  manyFiles(root, 'src', numbered('sys', 101, 'gd'));
  lacks(contextOf(runHook(root)), 'no production planning found');
}, { needsHelper: true });

test('check 6: stage behind what is on disk', () => {
  const files = {
    'project.yaml': `${STANDARD}project:\n  stage: Concept\n`,
    'production/epics/story-001.md': '# story\n',
    'src/main.gd': 'extends Node\n',
  };
  const root = fixture({ files });
  has(
    contextOf(runHook(root)),
    "⚠️  GAP: project.stage says 'Concept', but 1 stories and 1 source files exist",
    '    The stage only advances on a /gate-check PASS (or a CONCERNS whose risks you accepted),',
    "    and none has moved it yet -- so the status line can sit at 'Concept' indefinitely.",
    '    Suggested action: /gate-check  (it asks before advancing; this hook never writes the stage)',
  );
  assert.equal(readFileSync(join(root, 'project.yaml'), 'utf8'), files['project.yaml'], 'hook must not rewrite the stage');
  assert.equal(readFileSync(join(root, 'production/epics/story-001.md'), 'utf8'), '# story\n', 'hook must not touch stories');
}, { needsHelper: true });

test('check 6 is gated off at the minimal tier', () => {
  const root = fixture({
    files: {
      'project.yaml': `${MINIMAL}project:\n  stage: Concept\n`,
      'design/game-brief.md': '# brief\n',
      'production/epics/story-001.md': '# story\n',
      'src/main.gd': 'extends Node\n',
    },
  });
  lacks(contextOf(runHook(root)), 'project.stage says');
}, { needsHelper: true });

test('check 6 reads the legacy stage.txt mirror, CRLF included', () => {
  const root = fixture({
    files: {
      'project.yaml': STANDARD,
      'production/stage.txt': 'Pre-Production\r\n',
      'production/epics/story-002.md': '# story\n',
      'src/main.gd': 'extends Node\n',
    },
  });
  has(contextOf(runHook(root)), "⚠️  GAP: project.stage says 'Pre-Production', but 1 stories and 1 source files exist");
}, { needsHelper: true });

test('an ambiguous code root says the doc checks did not run', () => {
  const root = fixture({ files: { 'project.yaml': STANDARD, 'src/main.gd': 'extends Node\n', 'Assets/main.cs': 'class Main {}\n' } });
  has(
    contextOf(runHook(root)),
    'ℹ️  NOT CHECKED: code exists but the code root is ambiguous (engine.name unset, and the tree does not name one unambiguously).',
    '    Checks 1, 3 and 4 (design and architecture docs for existing code) did NOT run.',
    '    Suggested action: /setup-engine, or set engine.name in project.yaml',
  );
}, { needsHelper: true });

test('v1.0 legacy config without project.yaml routes to /adopt', () => {
  const root = fixture({
    files: {
      'production/stage.txt': 'Concept\n',
      '.dsh/docs/technical-preferences.md': '- **Engine**: Godot 4.3\n',
    },
  });
  const ctx = contextOf(runHook(root));
  has(
    ctx,
    '⬆️  v1.0 PROJECT: legacy config (production/stage.txt, .dsh/docs/technical-preferences.md) but no project.yaml.',
    '   Run: /adopt — it detects this and drives the migration (non-destructive).',
    '   Preview first: bash .dsh/scripts/migrate-v1-config.sh --dry-run',
    '💡 To get a comprehensive project analysis, run: /project-stage-detect',
  );
  lacks(ctx, '🚀 NEW PROJECT');
});

test('an unconfigured technical-preferences.md template is not legacy data', () => {
  const root = fixture({ files: { '.dsh/docs/technical-preferences.md': '- **Engine**: [TO BE CONFIGURED]\n' } });
  has(contextOf(runHook(root)), '🚀 NEW PROJECT');
  lacks(contextOf(runHook(root)), 'v1.0 PROJECT');
});

test('a design record or any source file also leaves the fresh state', () => {
  const brief = fixture({ files: { 'design/game-brief.md': '# brief\n' } });
  lacks(contextOf(runHook(brief)), '🚀 NEW PROJECT');
  const concept = fixture({ files: { 'design/gdd/game-concept.md': '# concept\n' } });
  lacks(contextOf(runHook(concept)), '🚀 NEW PROJECT');
  const code = fixture({ files: { 'Source/Game.cpp': 'int main(){}\n' } });
  lacks(contextOf(runHook(code)), '🚀 NEW PROJECT');
});

test('missing yaml-helper degrades to the standard tier and announces what did not run', () => {
  const root = fixture({
    helper: false,
    files: { 'project.yaml': MINIMAL, 'src/main.gd': 'extends Node\n' },
  });
  const res = runHook(root);
  const ctx = contextOf(res);
  // The tier read is gone, so the doc checks ran as `standard` instead of `minimal`.
  has(ctx, 'ℹ️  NOT CHECKED: code exists but the code root is ambiguous');
  has(
    res.stderr,
    'NOT RUN',
    'the engine-configured probe',
    'modes.workflow could not be resolved',
    'the code-root lookup did not run',
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

console.log(`\ndetect-gaps.test.mjs: ${passed} passed, ${failed} failed, ${skipped} skipped`
  + (HAVE_HELPER ? '' : ' — config-dependent cases need tools/yaml-helper.mjs'));
process.exitCode = failed === 0 ? 0 : 1;
