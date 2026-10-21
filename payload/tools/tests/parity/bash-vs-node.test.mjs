#!/usr/bin/env node
/**
 * bash ↔ Node byte-parity harness.
 *
 * The port's scripts were rewritten from bash to Node because bash cannot run inside the DSH
 * sandbox (Git Bash fails to start under the restricted token; piped stdio is denied). That
 * means the equivalence claim cannot be checked on this machine — but it *can* be made
 * checkable everywhere else, and the harness itself is verified here:
 *
 *   - the comparison machinery is self-tested with two Node programs (identical → equal,
 *     deliberately different → unequal), so "it compares correctly" does not depend on bash;
 *   - when a usable bash exists, every listed pair runs the real bash original and the Node
 *     port on the same fixture and their stdout and exit codes must match byte for byte;
 *   - with no usable bash, the run is a SKIP that names the reason and lists what would have
 *     been compared. A skip is never reported as a pass.
 *
 * Sandbox rule: piped child stdio is denied, so every child writes stdout/stderr to real files.
 *
 * Run: node tools/tests/parity/bash-vs-node.test.mjs
 *      DSGS_BASH=/path/to/bash node tools/tests/parity/bash-vs-node.test.mjs   # explicit shell
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n').join('\n        ')}`);
  }
};

/**
 * A pair to compare: both sides receive the same stdin and run in the same fixture directory.
 * `needs` names an extra requirement (e.g. `python3`, which the bash side uses to read YAML).
 */
const PAIRS = [
  {
    name: 'statusline (no project config)',
    bash: ['.claude/statusline.sh'],
    node: ['.dsh/statusline.mjs'],
    fixture: {},
    stdin: JSON.stringify({ model: { display_name: 'M' }, context_window: { used_percentage: 10 } }),
  },
  {
    name: 'statusline (project.yaml + stage mirror)',
    bash: ['.claude/statusline.sh'],
    node: ['.dsh/statusline.mjs'],
    fixture: {
      'project.yaml': 'schema_version: 1\nproject:\n  stage: Production\nmodes:\n  workflow: standard\n',
      'production/stage.txt': 'Production\n',
    },
    stdin: JSON.stringify({ model: { display_name: 'M' }, workspace: { project_dir: '.' } }),
    needs: 'python3',
  },
  {
    name: 'statusline (minimal workflow, story counts)',
    bash: ['.claude/statusline.sh'],
    node: ['.dsh/statusline.mjs'],
    fixture: {
      'project.yaml': 'schema_version: 1\nmodes:\n  rigor: minimal\n  workflow: minimal\n',
      'production/epics/e/story-001-a.md': '> **Status**: Complete\n',
      'production/epics/e/story-002-b.md': 'Status: In Progress\n',
    },
    stdin: JSON.stringify({ model: { display_name: 'M' }, workspace: { project_dir: '.' } }),
    needs: 'python3',
  },
];

/** Run one program with stdin from a file and stdout/stderr captured in files. */
function run(command, args, { cwd, stdin }) {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-parity-'));
  const inFile = join(dir, 'in');
  const outFile = join(dir, 'out');
  const errFile = join(dir, 'err');
  writeFileSync(inFile, stdin ?? '', 'utf8');
  const inFd = openSync(inFile, 'r');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(command, args, { cwd, stdio: [inFd, outFd, errFd] });
  } finally {
    closeSync(inFd);
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outFile, 'utf8');
  const stderr = readFileSync(errFile, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

/** Build a throwaway project tree from a `{ 'relative/path': 'content' }` map. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'DSGS-parity-fixture-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

/** Run both sides of a pair against one fixture and report whether they match. */
export function comparePair(pair, bashCommand) {
  const root = fixture(pair.fixture ?? {});
  try {
    // Absolute script paths: the *cwd* is the fixture (so the script sees a project), but the
    // script itself lives in this repository. Passing the repo-relative path with a fixture cwd
    // made the node side fail with ENOENT and the bash side with 127 — the harness then reported
    // a mismatch that had nothing to do with either implementation.
    const absolute = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
    // Git Bash does not accept `D:/…` as a command path (exit 127) and `cygpath` is not on the
    // Windows PATH, so the drive path is translated here: `D:\Work\dsh` → `/d/Work/dsh`.
    const posix = (p) => (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(p)
      ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`
      : p);
    const bashArgs = pair.bash.map(absolute);
    // Only shell scripts are wrapped: the machinery self-tests deliberately run the *same Node
    // program* on both sides, and those must be invoked directly.
    const bashInvocation = bashArgs.every((p) => p.endsWith('.sh'))
      ? `exec bash ${bashArgs.map((p) => `'${posix(p)}'`).join(' ')}`
      : bashArgs[0];
    const bash = run(bashCommand.command, [...bashCommand.args, bashInvocation], { cwd: root, stdin: pair.stdin });
    const node = run(process.execPath, pair.node.map(absolute), { cwd: root, stdin: pair.stdin });
    return { equal: bash.stdout === node.stdout && bash.status === node.status, bash, node };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Find a usable bash. Returns `{ command, args, label }` or undefined. */
function findBash() {
  const candidates = [];
  if (typeof process.env.DSGS_BASH === 'string' && process.env.DSGS_BASH.length > 0) {
    candidates.push({ command: process.env.DSGS_BASH, args: ['-c'], label: process.env.DSGS_BASH });
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8' });
  if (which.status === 0) {
    const found = String(which.stdout).split(/\r?\n/).find((line) => line.trim() !== '');
    if (found !== undefined) candidates.push({ command: found.trim(), args: ['-c'], label: `${found.trim()} (PATH)` });
  }
  for (const guess of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (existsSync(guess)) candidates.push({ command: guess, args: ['-c'], label: guess });
  }
  for (const candidate of candidates) {
    // Probe by asking bash to read a file the pair will actually run, using the same absolute
    // Windows-style path the comparison passes. `exit 0` alone is not enough: the WSL launcher
    // (`C:\Windows\System32\bash.exe`) satisfies it and then cannot see `D:/…` paths, and it also
    // writes its own NAT complaints to stderr — so a usable bash here means "quiet, and can read
    // this script".
    const probeScript = join(REPO_ROOT, '.claude', 'statusline.sh');
    const probe = run(candidate.command, [...candidate.args, `test -r "${probeScript}"`], { cwd: REPO_ROOT });
    if (probe.status === 0 && probe.stdout.trim() === '' && probe.stderr.trim() === '') return candidate;
  }
  return undefined;
}

/**
 * Is `python3` available **inside the bash we will use**? The bash side's YAML helper is what needs
 * it, and bash's PATH is not the Windows PATH: probing `python3` with the host's PATH reported it
 * present while the script inside Git Bash exited 127 without it.
 * @param {{command: string, args: string[]} | undefined} bashCommand - the shell found by findBash
 * @returns {boolean} true only when bash itself resolves python3
 */
function hasPython(bashCommand) {
  if (bashCommand === undefined) return false;
  // `command -v` is not enough on Windows: it resolves to the Microsoft Store stub
  // (`…/WindowsApps/python3`), which exists, is found, and cannot run. Only a real interpreter
  // counts, so this executes one.
  const probe = run(bashCommand.command, [...bashCommand.args, 'python3 -c pass'], { cwd: REPO_ROOT });
  return probe.status === 0;
}

// ---------------------------------------------------------------- machinery self-test
check('the comparator detects two identical programs as equal', () => {
  const echo = join(REPO_ROOT, 'tools', 'tests', 'parity', 'fixtures', 'echo-stdin.mjs');
  const result = comparePair(
    { bash: [echo], node: [echo], fixture: {}, stdin: 'same-input' },
    { command: process.execPath, args: [] },
  );
  assert.equal(result.equal, true, `expected equality, got bash=${JSON.stringify(result.bash.stdout)} node=${JSON.stringify(result.node.stdout)}`);
});

check('the comparator detects a different exit code as unequal', () => {
  const one = join(REPO_ROOT, 'tools', 'tests', 'parity', 'fixtures', 'echo-stdin.mjs');
  const two = join(REPO_ROOT, 'tools', 'tests', 'parity', 'fixtures', 'echo-stdin-fail.mjs');
  const result = comparePair(
    { bash: [two], node: [one], fixture: {}, stdin: 'x' },
    { command: process.execPath, args: [] },
  );
  assert.equal(result.equal, false);
});

check('the comparator detects different stdout as unequal', () => {
  const one = join(REPO_ROOT, 'tools', 'tests', 'parity', 'fixtures', 'echo-stdin.mjs');
  const two = join(REPO_ROOT, 'tools', 'tests', 'parity', 'fixtures', 'echo-other.mjs');
  const result = comparePair(
    { bash: [two], node: [one], fixture: {}, stdin: 'x' },
    { command: process.execPath, args: [] },
  );
  assert.equal(result.equal, false);
});

// ------------------------------------------------------------------- real bash if present
const bash = findBash();
let skipped = 0;
let pythonAvailable = false;
if (bash === undefined) {
  console.log('  skip  bash ↔ Node comparison: no usable bash on this host');
  console.log('        reason: Git Bash/WSL cannot start under the DSH sandbox (MSYS2 signal pipe,');
  console.log('                CreateFileMapping, and E_ACCESSDENIED were all observed), so the bash');
  console.log('                originals cannot be executed here. Run this file on a host where bash');
  console.log('                works — the pairs below compare automatically.');
  for (const pair of PAIRS) console.log(`        would compare: ${pair.name}`);
} else {
  pythonAvailable = hasPython(bash);
  const python = pythonAvailable;
  console.log(`  info  bash: ${bash.label}${python ? '' : ' (no python3: YAML-dependent pairs will skip)'}`);
  for (const pair of PAIRS) {
    if (pair.needs === 'python3' && !python) {
      console.log(`  skip  ${pair.name}: needs python3 for the bash side's YAML helper`);
      skipped += 1;
      continue;
    }
    check(`${pair.name} matches byte for byte`, () => {
      const result = comparePair(pair, bash);
      assert.equal(
        result.equal,
        true,
        `bash: ${JSON.stringify(result.bash.stdout)} (exit ${result.bash.status})\n`
        + `node: ${JSON.stringify(result.node.stdout)} (exit ${result.node.status})`,
      );
    });
  }
}

// Skips are expected only when the host has no python3 for the bash side's YAML helper. Anything else is
// a regression that has to be visible, and PARITY_REQUIRE_ALL=1 (used where python3 exists) forbids them.
{
  const expectedSkips = pythonAvailable ? 0 : 2;
  check(`skips as expected (${skipped} of ${expectedSkips}, python3 ${pythonAvailable ? 'present' : 'absent'})`, () => {
    assert.equal(skipped, expectedSkips, 'unexpected skip count — read the reason printed above');
    if (process.env.PARITY_REQUIRE_ALL === '1') assert.equal(skipped, 0, 'PARITY_REQUIRE_ALL=1 requires every pair to run');
  });
}

console.log(`\nparity/bash-vs-node.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);




