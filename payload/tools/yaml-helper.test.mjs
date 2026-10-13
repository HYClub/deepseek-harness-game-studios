#!/usr/bin/env node
/**
 * yaml-helper.test.mjs — differential test matrix for tools/yaml-helper.mjs against the
 * reference implementation `.claude/hooks/yaml-helper.sh` (Git Bash + Python 3).
 *
 * WHAT IT DOES
 *   1. Builds a fixture tree under `<projectRoot>/.tmp-yaml-fixtures/` covering the documented
 *      matrix: the repo's own template project.yaml, synthetic configs for every rigor level,
 *      explicit review_mode, testing.strict.*, illegal enum values, a project.local.yaml with
 *      both legal and locked keys, legacy mirror .txt files, and engine.name variants
 *      (Godot / Unity / Unreal / absent / tab-indented), plus an empty directory with no
 *      project.yaml at all.
 *   2. Runs every case twice: once through `bash .claude/hooks/yaml-helper.sh`/`source`-level
 *      function calls, once through `node tools/yaml-helper.mjs`.
 *   3. Compares stdout, stderr and the exit code BYTE FOR BYTE (hex-compared, not string-
 *      compared) and reports every mismatch with its expected/actual bytes.
 *
 * USAGE (from the project root)
 *   node tools/yaml-helper.test.mjs              # node + bash, full comparison
 *   node tools/yaml-helper.test.mjs --node-only  # no bash needed; checks the port runs clean
 *   node tools/yaml-helper.test.mjs --keep       # keep the fixture tree for inspection
 *   node tools/yaml-helper.test.mjs --filter rig # only cases whose id contains "rig"
 *
 * EXIT CODES
 *   0  all cases agree
 *   1  at least one case disagrees
 *   2  harness error
 *   3  --node-only was not requested but bash is unusable in this environment
 *
 * WHY THE BASH SIDE IS A `-c` WRAPPER: the shell file has no CLI for its per-function API
 * (`source .claude/hooks/yaml-helper.sh; <fn> ...` is how hooks and skills use it), so the
 * wrapper is the fair comparison for those. `resolve_config` is ALSO exercised via its real
 * CLI on both sides, because that is the only path a skill actually injects.
 *
 * NOTE ON WINDOWS: `bash` on PATH is WSL (`C:\WINDOWS\system32\bash.exe`) and mis-resolves
 * Windows paths, so Git Bash's bash.exe is preferred explicitly.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// Per-process fixture root: two concurrent runs would otherwise delete each other's trees
// mid-flight (which surfaces as a wall of ENOENT spawn failures, not as a test failure).
const FIXROOT = join(ROOT, `.tmp-yaml-fixtures-${process.pid}`);
const STALE_FIXROOT = join(ROOT, '.tmp-yaml-fixtures');
const NODE_BIN = process.execPath;
const YAML_HELPER = join(HERE, 'yaml-helper.mjs');

const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

const argv = process.argv.slice(2);
const NODE_ONLY = argv.includes('--node-only');
const KEEP = argv.includes('--keep');
const FILTER = (() => {
  const i = argv.indexOf('--filter');
  return i === -1 ? '' : (argv[i + 1] ?? '');
})();

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const files = new Map(); // fixture id -> Map(relPath -> contents)

function fixture(id, entries) {
  files.set(id, new Map(Object.entries(entries)));
}

const TEMPLATE_YAML = `# DSGS project configuration — single source of truth for project settings.
# See .claude/docs/effects-map.md for full schema.

schema_version: 1

framework:
  version: 1.1.2
  last_upgraded: 2026-09-25
`;

fixture('template', { 'project.yaml': TEMPLATE_YAML });

for (const level of ['minimal', 'standard', 'full']) {
  fixture(`rigor-${level}`, {
    'project.yaml': `schema_version: 1\nmodes:\n  rigor: ${level}\n`,
  });
}

fixture('rigor-bogus', {
  'project.yaml': 'schema_version: 1\nmodes:\n  rigor: BOGUS\n',
});

fixture('review-mode-explicit', {
  'project.yaml': 'schema_version: 1\nmodes:\n  rigor: minimal\n  review_mode: full\n',
});

fixture('review-mode-bogus', {
  'project.yaml': 'schema_version: 1\nmodes:\n  review_mode: nonsense\n  automation: guided\n',
});

fixture('testing-bogus', {
  'project.yaml': 'schema_version: 1\ntesting:\n  strict:\n    logic: maybe\n    integration: true\n',
});

fixture('strict-map', {
  'project.yaml': 'schema_version: 1\ntesting:\n  strict:\n    logic: true\n    visual: false\n',
});

fixture('strict-scalar', {
  'project.yaml': 'schema_version: 1\ntesting:\n  strict: true\n',
});

fixture('stage-legacy', {
  'project.yaml': 'schema_version: 1\n',
  'production/stage.txt': 'Systems Design\n',
});

fixture('review-legacy', {
  'project.yaml': 'schema_version: 1\n',
  'production/review-mode.txt': 'full\r\n',
});

fixture('legacy-bogus', {
  'project.yaml': 'schema_version: 1\n',
  'production/review-mode.txt': 'not-a-mode\n',
});

fixture('local-override-legal', {
  'project.yaml': 'schema_version: 1\nmodes:\n  rigor: standard\n  automation: collaborative\n',
  'project.local.yaml': 'modes:\n  review_mode: full\n  automation: autonomous\n',
});

fixture('local-override-locked', {
  'project.yaml': 'schema_version: 1\nmodes:\n  rigor: standard\n',
  'project.local.yaml': 'schema_version: 1\nmodes:\n  rigor: full\nframework:\n  version: 9.9.9\ndocs:\n  density: terse\n',
});

fixture('local-orphan', {
  'project.local.yaml': 'modes:\n  automation: guided\n',
});

fixture('local-only-legacy', {
  'project.local.yaml': 'features:\n  session_state: off\n',
  'production/review-mode.txt': 'solo\n',
});

fixture('always-ask-block', {
  'project.yaml': 'modes:\n  automation_always_ask:\n    - scope_changes\n    - file_deletions\n',
});

fixture('always-ask-inline', {
  'project.yaml': 'modes:\n  automation_always_ask: [scope_changes, "with, comma", file_deletions]\n',
});

fixture('always-ask-misindent', {
  'project.yaml': 'modes:\n  automation_always_ask:\n    - scope_changes\n  - file_deletions\n      - schema_changes  # ask anyway\n',
});

fixture('engine-godot', { 'project.yaml': 'engine:\n  name: Godot\n  version: 4.4\n' });
fixture('engine-unity', { 'project.yaml': 'engine:\n  name: Unity\n' });
fixture('engine-unreal', { 'project.yaml': 'engine:\n  name: "Unreal Engine 5"\n' });
fixture('engine-unreal-bare', { 'project.yaml': 'engine:\n  name: Unreal\n' });
fixture('engine-missing', { 'project.yaml': 'schema_version: 1\n' });
fixture('engine-tabbed', { 'project.yaml': 'engine:\n\tname: Godot\n' });
fixture('engine-tabbed-comment', { 'project.yaml': '# a comment\n\t# tabbed comment is exempt\nengine:\n\tname: Godot\n' });
fixture('engine-empty-name', { 'project.yaml': 'engine:\n  name:\n' });
fixture('engine-legacy-tp', {
  'project.yaml': 'schema_version: 1\n',
  '.claude/docs/technical-preferences.md': '# Technical Preferences\n\n- **Engine**: Unity 2022 LTS\n',
});
fixture('engine-legacy-tp-placeholder', {
  'project.yaml': 'schema_version: 1\n',
  '.claude/docs/technical-preferences.md': '- **Engine**: [TO BE CONFIGURED]\n',
});
fixture('detect-ambiguous', { 'project.yaml': 'schema_version: 1\n', 'src/keep.txt': '', 'Assets/keep.txt': '' });
fixture('detect-src-only', { 'project.yaml': 'schema_version: 1\n', 'src/keep.txt': '' });
fixture('detect-assets-only', { 'project.yaml': 'schema_version: 1\n', 'Assets/keep.txt': '' });
fixture('detect-assets-lowercase', { 'project.yaml': 'schema_version: 1\n', 'assets/keep.txt': '' });

fixture('system-overrides', {
  'project.yaml': 'workflow_overrides:\n  system_overrides:\n    combat: full\n    inventory: minimal\n    empty:\n',
});

fixture('yaml-edges', {
  'project.yaml': [
    'schema_version: 1',
    'quoted: "value with # hash"',
    'single: \'single #quoted\'',
    'comment-only: # all comment',
    'trailing: bare value # comment',
    'hashless: a#b',
    'unterminated: "oops',
    'inline-arr: [a, b, c]',
    'quoted-arr: ["x, y", z]',
    'empty-arr: []',
    'block-arr:',
    '  - one',
    '  - "two, with comma"',
    '  - \'three # not a comment\'',
    'nested:',
    '  child: 1',
    'unindent: ok',
    '',
  ].join('\n'),
});

fixture('crlf', {
  'project.yaml': 'modes:\r\n  rigor: full  # comment\r\n  automation: guided\r\n',
});

fixture('bom', {
  'project.yaml': '\uFEFFmodes:\n  rigor: full\n',
});

fixture('empty-project', { 'project.yaml': '' });
fixture('no-project', { 'README.md': 'nothing here\n' });

// ---------------------------------------------------------------------------
// Case definitions
//
// `call`  = (label, ...args) -> { result }
// `cli`   = raw argv for the real dispatcher (bash: `bash <script> <argv...>`)
// ---------------------------------------------------------------------------

const cases = [];
function caseEntry(o) { cases.push(o); }

const ALL_KEYS = 'rigor,review_mode,automation,workflow,docs.density,story_granularity,qa.level,team.size,project.stage,automation_always_ask,engine,testing.strict,performance.enforce,platform.cert_tier,system_overrides';

/** Resolve the whole block plus per-key variants for a fixture. */
function configCases(id) {
  caseEntry({ id: `${id}:resolve_config`, fix: id, call: ['resolve_config'] });
  caseEntry({ id: `${id}:cli`, fix: id, cli: ['resolve_config'] });
  caseEntry({ id: `${id}:keys-all`, fix: id, call: ['resolve_config', '--keys', ALL_KEYS] });
  caseEntry({ id: `${id}:keys-2`, fix: id, call: ['resolve_config', '--keys', 'rigor,workflow'] });
  caseEntry({ id: `${id}:keys-1`, fix: id, call: ['resolve_config', '--keys', 'review_mode'] });
  caseEntry({ id: `${id}:keys-system`, fix: id, call: ['resolve_config', '--keys', 'workflow,qa.level,system_overrides', 'combat'] });
  caseEntry({ id: `${id}:system-only`, fix: id, call: ['resolve_config', 'combat'] });
  caseEntry({ id: `${id}:keys-empty`, fix: id, call: ['resolve_config', '--keys', ''] });
  caseEntry({ id: `${id}:keys-unknown`, fix: id, call: ['resolve_config', '--keys', 'nope,alsonope'] });
  caseEntry({ id: `${id}:keys-stage`, fix: id, call: ['resolve_config', '--keys', 'project.stage'] });
  caseEntry({ id: `${id}:keys-cert`, fix: id, call: ['resolve_config', '--keys', 'platform.cert_tier'] });
}

for (const id of files.keys()) {
  configCases(id);
  caseEntry({ id: `${id}:enum-base`, fix: id, call: ['validate_yaml_enum', 'project.yaml'] });
  caseEntry({ id: `${id}:enum-local`, fix: id, call: ['validate_yaml_enum', 'project.local.yaml'] });
  caseEntry({ id: `${id}:local-base`, fix: id, call: ['validate_local_yaml_base'] });
  caseEntry({ id: `${id}:local-scope`, fix: id, call: ['validate_local_scope', 'project.local.yaml'] });
  caseEntry({ id: `${id}:local-scope-default`, fix: id, call: ['validate_local_scope'] });
  caseEntry({ id: `${id}:code-root`, fix: id, call: ['resolve_code_root'] });
  caseEntry({ id: `${id}:sess-state`, fix: id, call: ['session_state_enabled'] });

  for (const k of ['rigor', 'review_mode', 'project.stage', 'engine.name', 'performance.enforce', 'mode.rigor']) {
    caseEntry({ id: `${id}:setting:${k}`, fix: id, call: ['resolve_setting', k] });
  }
  for (const k of ['modes', 'modes.rigor', 'engine', 'engine.name', 'features', 'features.session_state', 'nope.deep']) {
    caseEntry({ id: `${id}:key:${k}`, fix: id, call: ['get_yaml_key', 'project.yaml', k] });
    caseEntry({ id: `${id}:key-local:${k}`, fix: id, call: ['get_yaml_key', 'project.local.yaml', k] });
    caseEntry({ id: `${id}:eff-key:${k}`, fix: id, call: ['get_effective_yaml_key', k] });
    caseEntry({ id: `${id}:arr:${k}`, fix: id, call: ['get_yaml_array', 'project.yaml', k] });
    caseEntry({ id: `${id}:eff-arr:${k}`, fix: id, call: ['get_effective_yaml_array', k] });
    caseEntry({ id: `${id}:children:${k}`, fix: id, call: ['get_yaml_child_keys', 'project.yaml', k] });
    caseEntry({ id: `${id}:default:${k}`, fix: id, call: ['get_yaml_default', k] });
    caseEntry({ id: `${id}:legacy:${k}`, fix: id, call: ['get_legacy_key', k] });
    caseEntry({ id: `${id}:overridable:${k}`, fix: id, call: ['is_locally_overridable', k] });
    caseEntry({ id: `${id}:enum-value:${k}`, fix: id, call: ['validate_enum_value', k, 'minimal'] });
    caseEntry({ id: `${id}:enum-value-bad:${k}`, fix: id, call: ['validate_enum_value', k, 'zzz'] });
  }
  for (const c of ['scope_changes', 'file_deletions', 'schema_changes', 'bogus', '']) {
    caseEntry({ id: `${id}:always-ask:${c || '(empty)'}`, fix: id, call: ['is_always_ask_category', c] });
  }
  caseEntry({ id: `${id}:missing-file`, fix: id, call: ['get_yaml_key', 'does-not-exist.yaml', 'a.b'] });
  caseEntry({ id: `${id}:empty-args`, fix: id, call: ['get_yaml_key', '', ''] });
  caseEntry({ id: `${id}:bad-enum-arg`, fix: id, call: ['validate_enum_value', 'engine.name', 'Godot'] });
}

// A few extra targeted reads on the edge-case fixtures.
for (const k of ['quoted', 'single', 'comment-only', 'trailing', 'hashless', 'unterminated', 'inline-arr', 'quoted-arr', 'empty-arr', 'block-arr', 'nested.child', 'unindent']) {
  caseEntry({ id: `yaml-edges:read:${k}`, fix: 'yaml-edges', call: ['get_yaml_key', 'project.yaml', k] });
  caseEntry({ id: `yaml-edges:arr:${k}`, fix: 'yaml-edges', call: ['get_yaml_array', 'project.yaml', k] });
}
for (const k of ['logic', 'integration', 'visual', 'ui', 'config']) {
  caseEntry({ id: `testing-bogus:strict:${k}`, fix: 'testing-bogus', call: ['get_effective_yaml_key', `testing.strict.${k}`] });
  caseEntry({ id: `strict-map:strict:${k}`, fix: 'strict-map', call: ['get_effective_yaml_key', `testing.strict.${k}`] });
}
for (const k of ['combat', 'inventory', 'empty', 'missing']) {
  caseEntry({ id: `system-overrides:key:${k}`, fix: 'system-overrides', call: ['get_yaml_key', 'project.yaml', `workflow_overrides.system_overrides.${k}`] });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function hex(buf) {
  return Buffer.from(buf ?? '').toString('hex');
}

/**
 * Capture target output WITHOUT pipes.
 *
 * A confined Windows sandbox denies CreateNamedPipe, so spawning a child with `stdio: 'pipe'`
 * fails outright (EPERM) — which would make this harness unrunnable exactly where it is most
 * needed. Both streams are therefore redirected to FILES: stdout to a scratch file opened
 * here, stderr to a per-case file the child inherits directly. The runner's own stderr stays
 * clean; every diagnostic it prints goes to stdout after the case loop.
 */
const spawned = [];
// Unique per process: two concurrent runs must not fight over the same scratch files (and a
// run that ends with `rm -rf .tmp-yaml-fixtures` would otherwise pull them out from under one).
const CAPTURE_TAG = `.capture-${process.pid}`;

function captureSpawn(cwd, cmd, args) {
  mkdirSync(FIXROOT, { recursive: true });
  const outPath = join(FIXROOT, `${CAPTURE_TAG}.stdout`);
  const errPath = join(FIXROOT, `${CAPTURE_TAG}.stderr`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { cwd, stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  spawned.push({ outPath, errPath });
  return {
    failed: Boolean(r.error),
    message: r.error ? r.error.message : '',
    status: r.status,
    signal: r.signal,
    stdout: read(outPath),
    stderr: read(errPath),
  };
}

function runNode(cwd, args) {
  return captureSpawn(cwd, NODE_BIN, [YAML_HELPER, ...args]);
}

function shQuote(s) {
  return `'${String(s).split("'").join("'\\''")}'`;
}

function bashCommand(args) {
  const [first, ...rest] = args;
  if (first === 'resolve_config') {
    return `${shQuote(join(ROOT, '.claude/hooks/yaml-helper.sh'))} ${rest.map(shQuote).join(' ')}`;
  }
  return `. ${shQuote(join(ROOT, '.claude/hooks/yaml-helper.sh'))} >/dev/null 2>&1; `
    + `${first} ${rest.map(shQuote).join(' ')}`;
}

function runBash(bashPath, cwd, args) {
  return captureSpawn(cwd, bashPath, ['-c', bashCommand(args)]);
}

function findBash() {
  const candidates = [...BASH_CANDIDATES, 'bash'];
  const probes = [];
  for (const p of candidates) {
    if (p !== 'bash' && !existsSync(p)) continue;
    // stdio:'ignore' on purpose: a piped probe cannot even spawn under the sandbox.
    const probe = spawnSync(p, ['-c', 'exit 0'], { stdio: 'ignore' });
    probes.push({ path: p, error: probe.error, status: probe.status });
    if (!probe.error && probe.status === 0) return { path: p, probes };
  }
  return { path: null, probes };
}

/** rm with retries: Windows can hold handles briefly (ENOTEMPTY/EBUSY) right after a spawn. */
function rmTree(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return true;
  } catch (err) {
    console.error(`warning: could not remove ${p}: ${err.code ?? err.message}`);
    return false;
  }
}

function buildFixtures() {
  rmTree(FIXROOT);
  rmTree(STALE_FIXROOT);
  mkdirSync(FIXROOT, { recursive: true });
  const dirs = {};
  for (const [id, entries] of files) {
    const dir = join(FIXROOT, id);
    dirs[id] = dir;
    mkdirSync(dir, { recursive: true });
    for (const [rel, contents] of entries) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    }
  }
  // The repo's own template state, used verbatim as the "run from the real project root" case.
  dirs['@root'] = ROOT;
  return dirs;
}

function main() {
  const report = [];
  const dirs = buildFixtures();
  const bash = NODE_ONLY ? { path: null, probes: [] } : findBash();

  if (!NODE_ONLY && !bash.path) {
    console.error('yaml-helper.test.mjs: no usable bash found (tried: '
      + [...BASH_CANDIDATES, 'bash on PATH'].join(', ') + ')');
    for (const p of bash.probes) {
      console.error(`  ${p.path}: ${p.error ? p.error.message : `exit ${p.status}`}`);
    }
    console.error('  (MSYS2 needs named pipes; a confined sandbox denies CreateNamedPipe, so every'
      + ' Git Bash process dies at startup with "couldn\'t create signal pipe".)');
    console.error('  Re-run this script outside that sandbox, or use --node-only.');
    if (!KEEP) rmSync(FIXROOT, { recursive: true, force: true });
    return 3;
  }

  const results = [];
  const casesRun = FILTER ? cases.filter((c) => c.id.includes(FILTER)) : cases;

  for (const c of casesRun) {
    const cwd = dirs[c.fix];
    // `cli` cases exercise the real dispatchers on both sides (node tools/yaml-helper.mjs ...,
    // bash .claude/hooks/yaml-helper.sh ...). Everything else is the source-level API and is
    // compared as `source <script>; <fn>` vs `node tools/yaml-helper.mjs __call <fn>`.
    const nodeArgv = c.cli ?? ['__call', ...c.call];
    const bashArgv = c.cli ?? c.call;
    const node = runNode(cwd, nodeArgv);
    if (NODE_ONLY) {
      // Exit 0 and 1 are both legitimate API answers (validate_* / is_* / session_state_enabled
      // return 1 for "no"); only a crash, a harness-level error, or a stray exit >= 2 is a
      // failure here.
      const ok = !node.failed && (node.status === 0 || node.status === 1);
      results.push({ id: c.id, ok, node, mode: 'node-only' });
      continue;
    }
    const bashRes = runBash(bash.path, cwd, bashArgv);
    const same = !node.failed && !bashRes.failed
      && node.status === bashRes.status
      && hex(node.stdout) === hex(bashRes.stdout)
      && hex(node.stderr) === hex(bashRes.stderr);
    results.push({ id: c.id, ok: same, node, bash: bashRes, mode: 'diff' });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    report.push(`FAIL ${r.id}`);
    if (r.mode === 'node-only') {
      report.push(`  node ${r.node.failed ? `spawn error: ${r.node.message}`
        : `exit=${r.node.status}`}`);
      if (r.node.stderr) report.push(`  node stderr: ${JSON.stringify(r.node.stderr.slice(0, 600))}`);
      continue;
    }
    report.push(`  bash exit=${r.bash.status} node exit=${r.node.status}`);
    if (hex(r.bash.stdout) !== hex(r.node.stdout)) {
      report.push(`  stdout bash: ${JSON.stringify(r.bash.stdout)}`);
      report.push(`  stdout node: ${JSON.stringify(r.node.stdout)}`);
    }
    if (hex(r.bash.stderr) !== hex(r.node.stderr)) {
      report.push(`  stderr bash: ${JSON.stringify(r.bash.stderr)}`);
      report.push(`  stderr node: ${JSON.stringify(r.node.stderr)}`);
    }
  }

  report.push(`${NODE_ONLY ? '[node-only] ' : ''}cases=${results.length} `
    + `pass=${results.length - failed.length} fail=${failed.length}`);
  if (NODE_ONLY) {
    report.push('bash comparison skipped (--node-only): the port exited 0 or 1 (never a crash or'
      + ' a stray exit >= 2) on every case. NOT a parity result.');
  } else {
    report.push(`compared against: ${bash.path}`);
  }
  if (KEEP) report.push(`fixtures kept at ${FIXROOT}`);
  console.log(report.join('\n'));

  if (!KEEP) {
    for (const s of spawned) {
      try {
        rmSync(s.outPath, { force: true });
        rmSync(s.errPath, { force: true });
      } catch { /* best effort */ }
    }
    rmSync(FIXROOT, { recursive: true, force: true });
  }

  return failed.length ? 1 : 0;
}

process.exitCode = main();

