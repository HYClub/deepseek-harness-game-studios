// Test for dsh-src/scripts/migrate-v1-config.mjs
// Run: node tools/tests/scripts/migrate-v1-config.test.mjs
//
// The migration tool is exercised through its real CLI in a throwaway fixture:
// a temp directory shaped like a v1.0 DSGS project (legacy `production/*.txt`
// plus a filled-in `.claude/docs/technical-preferences.md`), with the REAL
// `tools/yaml-helper.mjs` copied in, because the tool reads project.yaml through
// it and the last case asserts the migrated file resolves through it.
//
// Piped stdio is denied by the sandbox, so child stdout/stderr travel through
// real files handed over by file descriptor. Nothing here uses `stdio: 'pipe'`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const TOOL = join(ROOT, 'dsh-src', 'scripts', 'migrate-v1-config.mjs');
const HELPER = join(ROOT, 'tools', 'yaml-helper.mjs');

let passed = 0;
let failed = 0;
const cleanups = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error.message.split('\n').join('\n     ')}`);
  }
}

/** mkdir -p, so nothing in the fixture starts copied from the repository. */
function write(cwd, relPath, text) {
  const full = join(cwd, ...relPath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

function read(cwd, relPath) {
  return readFileSync(join(cwd, ...relPath.split('/')), 'utf8');
}

const has = (cwd, relPath) => existsSync(join(cwd, ...relPath.split('/')));

/**
 * A v1.0 project: legacy files + a filled-in technical-preferences.md, no
 * project.yaml, and the real yaml-helper under `tools/`.
 */
function makeV1Project() {
  const dir = mkdtempSync(join(tmpdir(), 'migv1-'));
  cleanups.push(dir);
  write(dir, 'production/stage.txt', 'Production\n');
  write(dir, 'production/review-mode.txt', 'none\n');
  write(dir, '.claude/docs/technical-preferences.md', TP_V1);
  write(dir, 'tools/yaml-helper.mjs', readFileSync(HELPER, 'utf8'));
  return dir;
}

/** A bare fixture (legacy files added per test). */
function makeEmptyProject() {
  const dir = mkdtempSync(join(tmpdir(), 'migv1-'));
  cleanups.push(dir);
  write(dir, 'tools/yaml-helper.mjs', readFileSync(HELPER, 'utf8'));
  return dir;
}

/**
 * Invoke the tool on a fixture root, with both streams redirected to real files.
 *
 * The sandbox denies piped child stdio, so stdout and stderr are handed to the
 * child as inherited file descriptors (exactly what `_capture.mjs` does), never
 * as a pipe.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function migrate(cwd, args = []) {
  return run(cwd, process.execPath, [TOOL, ...args, '--root', cwd]);
}

/** Run a command in `cwd` with stdout+stderr redirected to files. */
function run(cwd, file, args) {
  const io = mkdtempSync(join(tmpdir(), 'migv1-io-'));
  cleanups.push(io);
  const outFile = join(io, 'out.txt');
  const errFile = join(io, 'err.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(file, args, {
      cwd,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status ?? -1,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

const TP_V1 = [
  '# Technical Preferences',
  '',
  '## Engine & Language',
  '',
  '- **Engine**: Godot 4.4',
  '- **Language**: GDScript',
  '- **Rendering**: Forward+',
  '- **Physics**: Jolt',
  '',
  '## Input & Platform',
  '',
  '- **Target Platforms**: PC, Mac',
  '- **Primary Input**: Keyboard/Mouse',
  '- **Gamepad Support**: Partial',
  '- **Touch Support**: None',
  '',
  '## Naming Conventions',
  '',
  '- **Classes**: PascalCase',
  '- **Variables**: snake_case',
  '- **Constants**: SCREAMING_SNAKE_CASE',
  '- **Signals/Events**: snake_case',
  '- **Files**: snake_case',
  '- **Scenes/Prefabs**: PascalCase',
  '',
  '## Performance Budgets',
  '',
  '- **Target Framerate**: 60',
  '- **Frame Budget**: 16.67ms',
  // A budget that is prose, not a bare number: it MUST be reported, never
  // silently written as `null` and called PRESERVED.
  '- **Draw Calls**: 2000 on the console floor; 4000 as a PC target',
  '- **Memory Ceiling**: 1024MB',
  '',
  '## Testing',
  '',
  '- **Framework**: GUT',
  '- **Minimum Coverage**: 80',
  '',
  '## Engine Specialists',
  '',
  '- **Language/Code Specialist**: godot-specialist (GDScript, scenes)',
  '- **Shader Specialist**: godot-shader-specialist',
  '- **UI Specialist**: godot-ui-specialist',
  '- **Additional Specialists**: godot-gdscript-specialist (typing), godot-multiplayer-specialist',
  '',
  '## Forbidden Patterns',
  '',
  '- No singletons',
  '',
].join('\n');

// ---------------------------------------------------------------------------

test('first migration writes project.yaml + report and preserves values', () => {
  const cwd = makeV1Project();
  const run1 = migrate(cwd);
  assert.equal(run1.status, 0, `exit code (stderr: ${run1.stderr})`);
  assert.match(run1.stdout, /^wrote project\.yaml$/m);
  assert.match(run1.stdout, /^wrote production\/migration-report\.md$/m);
  assert.match(run1.stdout, /Legacy files left in place\. Review production\/migration-report\.md, then:/);
  assert.match(run1.stdout, /node \.dsh\/scripts\/migrate-v1-config\.mjs --finalize/);

  const yaml = read(cwd, 'project.yaml');
  // Indentation and key order match the shell writer, including the trailing
  // blank line each block emits.
  assert.match(yaml, /^schema_version: 1$/m);
  assert.match(yaml, /^framework:\n {2}version: 1\.1\.2\n\n/m);
  assert.match(yaml, /^project:\n {2}stage: "Production"\n\n/m);
  // v1.0 `none` -> v1.1 `solo`, the one documented value rename.
  assert.match(yaml, /^modes:\n {2}review_mode: solo\n\n/m);
  assert.match(yaml, /^engine:\n {2}name: "Godot"\n {2}version: "4\.4"\n {2}language: "GDScript"\n {2}rendering: "Forward\+"\n {2}physics: "Jolt"\n\n/m);
  // Specialist lines keep the bare agent name; the prose is reported, not written.
  assert.match(yaml, /^specialists:\n {2}code: "godot-specialist"\n {2}shader: "godot-shader-specialist"\n {2}ui: "godot-ui-specialist"\n {2}additional: \["godot-gdscript-specialist", "godot-multiplayer-specialist"\]\n\n/m);
  assert.match(yaml, /^naming:\n {2}classes: "PascalCase"\n {2}variables: "snake_case"\n {2}constants: "SCREAMING_SNAKE_CASE"\n {2}signals: "snake_case"\n {2}files: "snake_case"\n {2}scenes: "PascalCase"\n\n/m);
  // Units are stripped; prose becomes `null` and is reported.
  assert.match(yaml, /^performance:\n {2}target_framerate: 60\n {2}frame_budget_ms: 16\.67\n {2}draw_call_limit: null\n {2}memory_ceiling_mb: 1024\n\n/m);
  assert.match(yaml, /^platform:\n {2}targets: \["PC", "Mac"\]\n {2}primary_input: "Keyboard\/Mouse"\n {2}gamepad_support: "Partial"\n {2}touch_support: "None"\n\n/m);
  assert.match(yaml, /^testing:\n {2}framework: "GUT"\n\n/m);
  assert.match(yaml, /^qa:\n {2}coverage_minimum: 80$/m);

  // Legacy files stay in place: migration is non-destructive by default.
  assert.equal(has(cwd, 'production/stage.txt'), true);
  assert.equal(has(cwd, 'production/review-mode.txt'), true);

  const report = read(cwd, 'production/migration-report.md');
  assert.match(report, /^## Values preserved$/m);
  assert.match(report, /\| `project\.stage` \| Production \| production\/stage\.txt \|/);
  // v1.0 `none` is reported under its v1.1 name: `none` is not in the enum and
  // writing it would silently resolve to `lean`, the opposite of intent.
  assert.match(report, /\| `modes\.review_mode` \| solo \| production\/review-mode\.txt \|/);
  assert.match(report, /modes\.review_mode `none` \(v1\.0 "no reviews"\) migrated to v1\.1 `solo`/);
  assert.match(report, /\| `engine\.rendering` \| Forward\+ \| \.claude\/docs\/technical-preferences\.md \|/);
  assert.match(report, /\| `naming\.scenes` \| PascalCase \| \.claude\/docs\/technical-preferences\.md \|/);
  assert.match(report, /not migrated: "2000 on the console floor; 4000 as a PC target" is not a single number/);
  // A prose budget gets no "preserved" row, because null is not preserved.
  assert.doesNotMatch(report, /\| `performance\.draw_call_limit` \|/);
  assert.match(report, /modes\.rigor is not written/);
});

test('second migration is refused and the legacy files survive (idempotent)', () => {
  const cwd = makeV1Project();
  assert.equal(migrate(cwd).status, 0);
  const before = read(cwd, 'project.yaml');
  const reportBefore = read(cwd, 'production/migration-report.md');
  const again = migrate(cwd);
  assert.equal(again.status, 3, 'a re-run must refuse, not re-migrate');
  assert.match(again.stdout, /^REFUSED: both project\.yaml and legacy files exist\.$/m);
  assert.match(again.stdout, /If you already migrated, the next step is: node \.dsh\/scripts\/migrate-v1-config\.mjs --finalize/);
  assert.equal(read(cwd, 'project.yaml'), before, 'project.yaml must not be rewritten');
  assert.equal(read(cwd, 'production/migration-report.md'), reportBefore, 'report must not be rewritten');
  assert.equal(has(cwd, 'production/stage.txt'), true);
});

test('no legacy files: nothing to do (exit 0)', () => {
  const cwd = makeEmptyProject();
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Nothing to do: no legacy config files found \(not a v1\.0 project\)\.$/m);
  assert.equal(has(cwd, 'project.yaml'), false, 'exit-0 no-op must not write');
});

test('project.yaml alone: nothing to do (exit 0)', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'project.yaml', 'schema_version: 1\n');
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Nothing to do: project\.yaml exists and no legacy config was found\.$/m);
  assert.equal(read(cwd, 'project.yaml'), 'schema_version: 1\n', 'must not touch it');
});

test('project.yaml plus MIRRORING legacy files: nothing to do (exit 0)', () => {
  // The /start case: it writes production/stage.txt on purpose, so the file
  // agreeing with project.yaml is not a conflict and --finalize must not be
  // recommended against a file /start meant to create.
  const cwd = makeEmptyProject();
  write(cwd, 'project.yaml', 'schema_version: 1\nproject:\n  stage: "Production"\nmodes:\n  review_mode: solo\n');
  write(cwd, 'production/stage.txt', 'Production\n');
  write(cwd, 'production/review-mode.txt', 'none\n');
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Nothing to do: project\.yaml exists and the legacy files mirror it \(values agree\)\.$/m);
  assert.equal(has(cwd, 'production/migration-report.md'), false);
});

test('project.yaml plus DISAGREEING legacy files: refused (exit 3)', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'project.yaml', 'schema_version: 1\nproject:\n  stage: "Release"\n');
  write(cwd, 'production/stage.txt', 'Production\n');
  const result = migrate(cwd);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /^REFUSED: both project\.yaml and legacy files exist, and their values DISAGREE\.$/m);
  assert.match(result.stdout, /Resolve which is authoritative before migrating\./);
});

test('first session after /start on a NOT-yet-migrated project: report absent, mirrors agree', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'project.yaml', 'schema_version: 1\nproject:\n  stage: "Systems Design"\n');
  write(cwd, 'production/stage.txt', 'Systems Design\n');
  // Interior spaces survive trimming, which is why trim_line never strips them.
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /values agree/);
});

test('dry-run previews everything and writes nothing', () => {
  const cwd = makeV1Project();
  const before = has(cwd, 'project.yaml');
  const result = migrate(cwd, ['--dry-run']);
  assert.equal(result.status, 0);
  assert.equal(before, false);
  assert.match(result.stdout, /^DRY RUN — nothing written\.$/m);
  assert.match(result.stdout, /^would create: project\.yaml$/m);
  assert.match(result.stdout, /^ {2}production\/stage\.txt -> project\.stage: Production$/m);
  assert.match(result.stdout, /^ {2}production\/review-mode\.txt -> modes\.review_mode: solo$/m);
  assert.match(result.stdout, /modes\.review_mode will be set EXPLICITLY to 'solo'/);
  assert.match(result.stdout, /\.claude\/docs\/technical-preferences\.md -> engine\/platform\/naming\/performance\/testing\/specialists/);
  assert.match(result.stdout, /^warnings:$/m);
  assert.equal(has(cwd, 'project.yaml'), false);
  assert.equal(has(cwd, 'production/migration-report.md'), false);
});

test('a fork value is preserved raw and flagged, never coerced', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'production/stage.txt', 'Alpha\n');
  write(cwd, 'production/review-mode.txt', 'triage\n');
  const result = migrate(cwd, ['--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /project\.stage `Alpha` is not a v1\.1 stage — preserved raw, resolve by hand/);
  assert.match(result.stdout, /modes\.review_mode `triage` is not a v1\.1 value — preserved raw, resolve by hand/);

  const written = migrate(cwd);
  assert.equal(written.status, 0);
  const yaml = read(cwd, 'project.yaml');
  assert.match(yaml, /^ {2}stage: "Alpha"$/m);
  assert.match(yaml, /^ {2}review_mode: triage$/m);
  const report = read(cwd, 'production/migration-report.md');
  assert.match(report, /Confirm `project\.stage: Alpha` is intended/);
  assert.match(report, /Confirm `modes\.review_mode: triage` is intended/);
});

test('review-mode.txt absent: modes.review_mode is NOT invented', () => {
  // v1.0's review-mode.txt was optional. Defaulting to `lean` wrote an explicit
  // value the user never chose, and an explicit review_mode outranks
  // modes.rigor — pinning the knob permanently.
  const cwd = makeEmptyProject();
  write(cwd, 'production/stage.txt', 'Pre-Production\n');
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  const yaml = read(cwd, 'project.yaml');
  assert.doesNotMatch(yaml, /review_mode/);
  assert.doesNotMatch(yaml, /^modes:$/m);
  const resolved = run(cwd, process.execPath, ['tools/yaml-helper.mjs', 'resolve_config', '--keys', 'review_mode']);
  assert.equal(resolved.status, 0, resolved.stderr);
  // minimal rigor -> solo, which is what "no explicit value" buys.
  assert.match(resolved.stdout, /review_mode: solo \(rigor:minimal\)/);
  const report = read(cwd, 'production/migration-report.md');
  assert.match(report, /`modes\.review_mode` is \*\*deliberately not written\*\*: no/);
});

test('a project with no stage.txt: no empty project block', () => {
  // `stage: null` failed the project's own schema validation (null is not in
  // the stage enum), so an absent key is the correct answer.
  const cwd = makeEmptyProject();
  write(cwd, 'production/review-mode.txt', 'full\n');
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  const yaml = read(cwd, 'project.yaml');
  assert.doesNotMatch(yaml, /^project:$/m);
  assert.match(yaml, /^modes:\n {2}review_mode: full\n\n/m);
});

test('--finalize refuses while content is not demonstrably preserved (exit 4)', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'project.yaml', 'schema_version: 1\nproject:\n  stage: "Production"\n');
  write(cwd, 'production/stage.txt', 'Release\n');
  const result = migrate(cwd, ['--finalize']);
  assert.equal(result.status, 4);
  assert.match(result.stdout, /^REFUSED: content not preserved in project\.yaml for: production\/stage\.txt$/m);
  assert.match(result.stdout, /Nothing was deleted\./);
  assert.equal(has(cwd, 'production/stage.txt'), true);
});

test('--finalize without project.yaml: refused (exit 3)', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'production/stage.txt', 'Production\n');
  const result = migrate(cwd, ['--finalize']);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /^REFUSED: project\.yaml does not exist\. Run migration first\.$/m);
  assert.equal(has(cwd, 'production/stage.txt'), true);
});

test('--finalize deletes only after verifying preservation', () => {
  const cwd = makeV1Project();
  assert.equal(migrate(cwd).status, 0);
  const result = migrate(cwd, ['--finalize']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^deleted production\/stage\.txt$/m);
  // `none` was migrated to `solo`, and the verifier applies the same rename: it
  // must not look for `review_mode: none` and refuse to delete a preserved file.
  assert.match(result.stdout, /^deleted production\/review-mode\.txt$/m);
  assert.match(result.stdout, /NOTE: \.claude\/docs\/technical-preferences\.md is NOT deleted/);
  assert.match(result.stdout, /^finalize complete\.$/m);
  assert.equal(has(cwd, 'production/stage.txt'), false);
  assert.equal(has(cwd, 'production/review-mode.txt'), false);
  assert.equal(has(cwd, '.claude/docs/technical-preferences.md'), true, 'TP must survive finalize');
});

test('unknown argument: usage on stderr, exit 2', () => {
  const cwd = makeEmptyProject();
  const result = migrate(cwd, ['--wat']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node \.dsh\/scripts\/migrate-v1-config\.mjs \[--dry-run\|--finalize\] \[--root DIR\]/);
});

test('the migrated file resolves through the real yaml-helper', () => {
  const cwd = makeV1Project();
  assert.equal(migrate(cwd).status, 0);
  const resolved = run(cwd, process.execPath, ['tools/yaml-helper.mjs', 'resolve_config', '--keys', 'review_mode']);
  assert.equal(resolved.status, 0, resolved.stderr);
  // Explicit value wins, and `none` must NOT have been written (it is not in the
  // enum, and an enum-invalid value falls through to rigor:minimal -> solo).
  assert.match(resolved.stdout, /review_mode: solo \(project\.yaml\)/);

  const stage = run(cwd, process.execPath, ['tools/yaml-helper.mjs', 'resolve_config', '--keys', 'project.stage']);
  assert.match(stage.stdout, /project\.stage: Production \(project\.yaml\)/);

  const engine = run(cwd, process.execPath, ['tools/yaml-helper.mjs', 'resolve_config', '--keys', 'engine']);
  assert.match(engine.stdout, /engine: Godot 4\.4 \(project\.yaml\)/);
});

test('an empty legacy file is warned about, not treated as a value', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'production/stage.txt', '\n');
  write(cwd, 'production/review-mode.txt', '   \n');
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /production\/stage\.txt is empty — project\.stage left unset/);
  assert.match(result.stdout, /production\/review-mode\.txt is empty — modes\.review_mode left unset, so modes\.rigor supplies it/);
});

test('a value with a double quote stays valid YAML', () => {
  // Hand-written markdown prose, so a quote inside one is ordinary: wrapping it
  // unescaped emitted `key: "He said "hi""`, which takes the whole file down.
  const cwd = makeEmptyProject();
  write(cwd, '.claude/docs/technical-preferences.md', [
    '## Testing',
    '',
    '- **Framework**: GUT "the good one"',
    '',
  ].join('\n'));
  const result = migrate(cwd);
  assert.equal(result.status, 0);
  const yaml = read(cwd, 'project.yaml');
  assert.match(yaml, /^ {2}framework: "GUT \\"the good one\\""$/m);
  // NOTE: `tools/yaml-helper.mjs`'s YAML subset parser stops a quoted scalar at
  // the FIRST `"` and does not process `\"`, so its `get_yaml_key` reads this
  // value back as `GUT \`. That is the helper's documented-parser behaviour and
  // is not this tool's to change; what the migration owes the file is a scalar
  // that a real YAML parser reads correctly, which the assertion above pins.
  assert.equal(read(cwd, 'project.yaml').includes('\\"the good one\\"'), true);
});

// ---------------------------------------------------------------------------
// A forked technical-preferences.md: the branches the v1.0 template never hits.
// ---------------------------------------------------------------------------

test('forked technical-preferences.md: wrap-join, "or" specialists, custom section, nulls, CRLF', () => {
  const cwd = makeEmptyProject();
  // CRLF throughout, a wrapped continuation, a two-candidate specialist line, a
  // custom section, and a partial Engine block (name set, the rest absent).
  const tp = [
    '## Engine & Language',
    '',
    '- **Engine**: Unreal Engine 5.3',
    '',
    '## Performance Budgets',
    '',
    '- **Frame Budget**: 16.6ms on the',
    '  Pro-tier target.** *(Changed 2025-01)*',
    '- **Target Framerate**: 30 FPS on the console floor; 60 FPS as a PC target',
    '',
    '## Engine Specialists',
    '',
    '- **Language/Code Specialist**: ue-specialist (Blueprint) or ue-cpp-specialist (C++)',
    '- **Additional Specialists**: ue-gas-specialist (abilities, effects), ue-umg-specialist',
    '',
    '## Our Own Section',
    '',
    '- **Whatever**: custom',
    '',
  ].join('\r\n');
  write(cwd, '.claude/docs/technical-preferences.md', tp);
  write(cwd, 'production/stage.txt', 'Technical Setup\r\n');

  const result = migrate(cwd);
  assert.equal(result.status, 0, result.stderr);
  const yaml = read(cwd, 'project.yaml');
  // `awk '{print $1}'`: only the FIRST token is the engine name, deliberately —
  // skills hand it to a subagent registry that knows `Unreal`, not
  // `Unreal Engine 5.3`.
  assert.match(yaml, /^ {2}name: "Unreal"$/m);
  // The version is the LAST token only when it looks like a version; `5.3` does.
  assert.match(yaml, /^ {2}version: "5\.3"$/m);
  // A continuation line is joined, so the budget is ONE value, not a truncation
  // cut where the author wrapped.
  assert.match(yaml, /^ {2}frame_budget_ms: null$/m);
  assert.match(yaml, /^ {2}target_framerate: null$/m);
  assert.match(yaml, /^ {2}code: "ue-specialist"$/m);
  // One comma inside parentheses is part of its element, not a separator.
  assert.match(yaml, /^ {2}additional: \["ue-gas-specialist", "ue-umg-specialist"\]$/m);

  const report = read(cwd, 'production/migration-report.md');
  assert.match(report, /Custom section `## Our Own Section` in \.claude\/docs\/technical-preferences\.md — not migrated, integrate by hand/);
  assert.match(report, /specialists\.code trimmed to `ue-specialist` — the legacy line was: ue-specialist \(Blueprint\) or ue-cpp-specialist \(C\+\+\)/);
  assert.match(report, /`specialists\.code` had two candidates .*kept the first/);
  // `16.6ms on the Pro-tier target.** *(Changed 2025-01)` — the join is visible
  // in the warning, which is the whole point of joining it. Reading only the
  // first physical line truncated the value mid-sentence.
  assert.match(report, /performance\.frame_budget_ms not migrated: "16\.6ms on the Pro-tier target\.\*\* \*\(Changed 2025-01\)\*" is not a single number/);
  assert.match(report, /target_framerate not migrated/);
  // String keys the Engine block emitted as `null` are reported, because
  // `get_yaml_key` returns the STRING "null" and a caller reads that as set.
  assert.match(report, /engine\.language written as `null`/);
  assert.match(report, /engine\.rendering written as `null`/);
  assert.match(report, /engine\.physics written as `null`/);
  assert.match(report, /Forbidden Patterns and Allowed Libraries stay in/);
});

test('CRLF legacy files are read with CR stripped and interior spaces kept', () => {
  const cwd = makeEmptyProject();
  write(cwd, 'production/stage.txt', 'Systems Design\r\n');
  write(cwd, 'production/review-mode.txt', 'lean\r\n');
  assert.equal(migrate(cwd).status, 0);
  const yaml = read(cwd, 'project.yaml');
  assert.match(yaml, /^ {2}stage: "Systems Design"$/m);
  assert.match(yaml, /^ {2}review_mode: lean$/m);
});

// ---------------------------------------------------------------------------
for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

