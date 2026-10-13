#!/usr/bin/env node
/**
 * artifact-check.mjs — port of `.claude/scripts/artifact-check.sh`.
 *
 * The contract is stdout text plus an exit code (the calling skills parse both),
 * so every case runs the real entry point as a child process and asserts on bytes.
 * The fixture is a temporary mini-project containing a copy of the script, so the
 * script's own root rule is exercised and the repository is never touched.
 *
 * Sandbox rule: piped child stdio is denied, so stdout/stderr travel through real
 * files handed to the child by file descriptor.
 *
 * Run: node tools/tests/scripts/artifact-check.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS_SRC = join(REPO_ROOT, 'dsh-src', 'scripts');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 10).join('\n     ')}`);
    process.exitCode = 1;
  }
};

const FIXTURE_CATALOG = [
  '# fixture catalog',
  '',
  'paths:',
  '',
  '  minimal:',
  '    steps:',
  '      - id: engine-setup',
  '        required: true',
  '        artifact:',
  '          any_of:',
  '            - glob: "project.yaml"',
  '              pattern: \'name:[[:space:]]*"?(Godot|Unity|Unreal)\'',
  '            - glob: ".claude/docs/technical-preferences.md"',
  '              pattern: \'\\*\\*Engine\\*\\*: [^[]\'',
  '      - id: many-sprints',
  '        artifact:',
  '          glob: "production/sprints/sprint-*.md"',
  '          min_count: 3',
  '      - id: two-sprints',
  '        artifact:',
  '          glob: "production/sprints/sprint-*.md"',
  '          min_count: 2',
  '      - id: noted',
  '        required: true',
  '        artifact:',
  '          note: "not detectable — em-dash ✓"',
  '',
  'phases:',
  '',
  '  concept:',
  '    steps:',
  '      - id: game-concept',
  '        artifact:',
  '          glob: "design/gdd/game-concept.md"',
  '      - id: missing',
  '        artifact:',
  '          glob: "design/gdd/nope-*.md"',
  '      - id: pattern-miss',
  '        artifact:',
  '          glob: "design/gdd/game-concept.md"',
  '          pattern: "ZZZ-not-here"',
  '',
].join('\n');

/** Copy the script and its imports into a fixture that owns the project root. */
function makeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-artifact-check-'));
  const scripts = join(root, 'dsh-src', 'scripts');
  const hooks = join(root, 'dsh-src', 'hooks');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  cpSync(join(SCRIPTS_SRC, 'artifact-check.mjs'), join(scripts, 'artifact-check.mjs'));
  cpSync(join(SCRIPTS_SRC, '_runner.mjs'), join(scripts, '_runner.mjs'));
  cpSync(join(REPO_ROOT, 'dsh-src', 'hooks', 'runtime.mjs'), join(hooks, 'runtime.mjs'));
  writeFileSync(join(root, 'project.yaml'), 'name: "Godot"\nengine: godot\n', 'utf8');
  if (options.catalog !== false) {
    // `tools/build-dsh.mjs` rewrites `.claude/` to `.dsh/` in the generated copy of
    // the script, so the catalog under test is written to BOTH locations and the
    // suite passes against `dsh-src/scripts/` and `.dsh/scripts/` alike.
    const content = options.catalog === 'real'
      ? readFileSync(join(REPO_ROOT, '.claude', 'docs', 'workflow-catalog.yaml'), 'utf8')
      : FIXTURE_CATALOG;
    for (const marker of ['.claude', '.dsh']) {
      mkdirSync(join(root, marker, 'docs'), { recursive: true });
      writeFileSync(join(root, marker, 'docs', 'workflow-catalog.yaml'), content, 'utf8');
    }
  }
  return root;
}

function writeFile(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function run(root, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-run-'));
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [join(root, 'dsh-src', 'scripts', 'artifact-check.mjs'), ...args], {
      cwd: root,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n');
  const stderr = readFileSync(errFile, 'utf8').replace(/\r\n/g, '\n');
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

// --- cases ----------------------------------------------------------------
check('--path reports the tier path with the exact status/key vocabulary', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/game-concept.md', '# Concept\n');
    writeFile(root, 'production/sprints/sprint-1.md', '# s1\n');
    writeFile(root, 'production/sprints/sprint-2.md', '# s2\n');
    const r = run(root, ['--path', 'minimal']);
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^CATALOG: \.(claude|dsh)\/docs\/workflow-catalog\.yaml$/);
    assert.equal(lines[1], `ROOT: ${root.replace(/\\/g, '/')}`);
    assert.equal(lines[2], 'PATHS: 1');
    assert.equal(lines[3], 'STEPS: 4');
    assert.equal(lines[4], 'NO_CHECK: 1');
    assert.equal(lines[5], 'PATH: minimal');
    assert.equal(lines[6], '  STEP: engine-setup required=true repeatable=false check=any_of status=PRESENT alt=1 match=project.yaml');    assert.equal(lines[7], '  STEP: many-sprints required=false repeatable=false check=glob status=SHORT count=2 glob=production/sprints/sprint-*.md min=3');
    assert.equal(lines[8], '  STEP: two-sprints required=false repeatable=false check=glob status=PRESENT count=2 min=2');
    assert.equal(lines[9], '  STEP: noted required=true repeatable=false check=none status=NO_CHECK note=not detectable — em-dash ✓');
    assert.equal(lines[10], '');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('any_of falls through to the legacy alternative and reports its glob', () => {
  const root = makeFixture();
  try {
    // `name:` does not carry an engine keyword, so alternative 1 has the file but
    // not the pattern, and the `[TO BE CONFIGURED]` placeholder fails `[^[]`.
    writeFile(root, 'project.yaml', 'name: "Torque Game Engine port"\n');
    writeFile(root, '.claude/docs/technical-preferences.md', 'Engine: [TO BE CONFIGURED]\n');
    const r = run(root, ['--path', 'minimal']);
    assert.equal(r.status, 0);
    // Neither alternative matches: ABSENT carries how many were tried.
    assert.match(r.stdout, /STEP: engine-setup required=true repeatable=false check=any_of status=ABSENT alts=2\n/);
    writeFile(root, '.claude/docs/technical-preferences.md', '- **Engine**: Godot 4.6\n');
    const r2 = run(root, ['--path', 'minimal']);
    assert.match(r2.stdout, /STEP: engine-setup required=true repeatable=false check=any_of status=PRESENT alt=2 match=\.claude\/docs\/technical-preferences\.md\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('--phase restricts to one phase; a glob miss is ABSENT, a pattern miss is PATTERN_MISS', () => {
  const root = makeFixture();
  try {
    writeFile(root, 'design/gdd/game-concept.md', '# Concept\n');
    const r = run(root, ['--phase', 'concept']);
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^CATALOG: \.(claude|dsh)\/docs\/workflow-catalog\.yaml$/);
    assert.equal(r.stdout, [
      lines[0],
      `ROOT: ${root.replace(/\\/g, '/')}`,
      'PHASES: 1',
      'STEPS: 3',
      'NO_CHECK: 0',
      'PHASE: concept',
      '  STEP: game-concept required=false repeatable=false check=glob status=PRESENT count=1',
      '  STEP: missing required=false repeatable=false check=glob status=ABSENT glob=design/gdd/nope-*.md',
      '  STEP: pattern-miss required=false repeatable=false check=glob status=PATTERN_MISS found=1 glob=design/gdd/game-concept.md',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('unknown --phase exits 2 and names the phases that were parsed', () => {
  const root = makeFixture();
  try {
    const r = run(root, ['--phase', 'nope']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, "artifact-check: unknown phase 'nope' (known: concept)\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('a flag with no value exits 2 instead of looping', () => {
  const root = makeFixture();
  try {
    const r = run(root, ['--phase']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'artifact-check: --phase needs a value\n');

    const r2 = run(root, ['--phase', 'concept', '--path', 'minimal']);
    assert.equal(r2.status, 2);
    assert.equal(r2.stderr, "artifact-check: --phase and --path are exclusive (a path is a tier's whole route, not a phase)\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('a missing catalog exits 1 and says so instead of printing an empty report', () => {
  const root = makeFixture({ catalog: false });
  try {
    const r = run(root);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    // The generated copy looks for `.dsh/docs/…`; the source copy for
    // `.claude/docs/…`. Both report the path they actually looked at.
    assert.match(r.stderr, /^artifact-check: catalog not found at .*[\\/](\.claude|\.dsh)[\\/]docs[\\/]workflow-catalog\.yaml\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('--help prints the usage header (comment markers normalised) and exits 0', () => {
  const root = makeFixture();
  try {
    const r = run(root, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^# artifact-check\.mjs — evaluate every workflow-catalog step/m);
    assert.match(r.stdout, /^#   NO_CHECK      the step declares no artifact/m);
    assert.equal(r.stdout.endsWith('#     `.github/workflows/tests.yml` be found.\n'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("runs against the repository's real catalog with PHASES/STEPS/NO_CHECK denominators", () => {
  const root = makeFixture({ catalog: 'real' });
  try {
    const r = run(root, ['--phase', 'concept']);
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n');
    assert.equal(lines[2], 'PHASES: 1');
    assert.match(lines[3], /^STEPS: \d+$/);
    assert.match(lines[4], /^NO_CHECK: \d+$/);
    assert.equal(lines[5], 'PHASE: concept');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nartifact-check: ${passed} passed, ${failed} failed`);
