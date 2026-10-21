#!/usr/bin/env node
/**
 * Tests for `dsh-src/hooks/validate-push.mjs` (port of `.claude/hooks/validate-push.sh`).
 *
 *   node tools/tests/hooks/validate-push.test.mjs
 *
 * Payloads go in over a file redirection and stdout/stderr come back out of
 * files: this sandbox denies piped child stdio (`spawnSync ... EPERM`), which is
 * the same reason the hook runtime's `capture()` redirects instead of piping.
 *
 * NOTE: this hook reads NO project configuration — the bash original never calls
 * `resolve_config`, and its "(S1; S1-S3 at workflow: full)" wording is static
 * text, not a resolved value. So `resolveConfig()` / `resolve_code_root` are
 * deliberately not exercised here: there is nothing in either hook that reads
 * `project.yaml` (a fixture `project.yaml` below exists only to mark the project
 * root, which is what `projectRoot()` looks for).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dsh-src',
  'hooks',
  'validate-push.mjs',
);

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

/** Run the hook as DSH does: JSON on stdin, exit code + streams out. */
function runHook(payload, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vp-run-'));
  try {
    const inPath = join(dir, 'in.json');
    const outPath = join(dir, 'out.txt');
    const errPath = join(dir, 'err.txt');
    writeFileSync(inPath, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const line = `"${process.execPath}" "${HOOK}" < "${inPath}" > "${outPath}" 2> "${errPath}"`;
    const result = spawnSync(line, { cwd, shell: true, stdio: 'ignore', windowsHide: true });
    return {
      status: result.status,
      stdout: existsSync(outPath) ? readFileSync(outPath, 'utf8') : '',
      stderr: existsSync(errPath) ? readFileSync(errPath, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bashPayload(command, cwd) {
  return {
    session_id: 'test-session',
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

/** A hook JSON warning, or null when the hook stayed silent. */
function warningOf(result) {
  if (result.stdout.trim() === '') return null;
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.systemMessage, parsed.hookSpecificOutput.additionalContext);
  assert.ok(
    !('permissionDecision' in parsed.hookSpecificOutput),
    'no permissionDecision: "allow" would skip the user permission prompt',
  );
  return parsed.systemMessage;
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-vp-fixture-'));
const project = join(scratch, 'project');
const bare = join(scratch, 'bare');
const repo = join(scratch, 'repo');

function writeMarker(dir, contents) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.yaml'), contents, 'utf8');
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

let repoReady = false;

try {
  writeMarker(project, 'engine:\n  name: Godot\n');
  mkdirSync(bare, { recursive: true });
  writeMarker(repo, 'engine:\n  name: Godot\n');
  repoReady =
    git(['init', '-q', '-b', 'main'], repo).status === 0 &&
    git(
      ['-c', 'user.email=hook@test', '-c', 'user.name=hook', 'commit', '-q', '--allow-empty', '-m', 'init'],
      repo,
    ).status === 0;

  // ---- early exit on payloads that have nothing to do with this hook --------

  test('payload with no git at all -> allow, no output at all', () => {
    const result = runHook(bashPayload('npm run test', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('unrelated tool_input (no command key) -> allow, no output', () => {
    const result = runHook(
      { hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Write', tool_input: { file_path: 'src/a.gd' } },
      project,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('malformed stdin -> allow, no output', () => {
    const result = runHook('{"tool_name": "Bash", "tool_input":', project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('empty stdin -> allow, no output', () => {
    const result = runHook('', project);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('non-git payload in a project with no marker -> allow, no output', () => {
    const result = runHook(bashPayload('ls -la', bare), bare);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  // ---- the warning path ----------------------------------------------------

  test('git push origin main warns on stdout and still exits 0', () => {
    const result = runHook(bashPayload('git push origin main', project), project);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const message = warningOf(result);
    assert.ok(message.includes("Push to protected branch 'main' detected."), message);
    assert.ok(message.includes('Ensure build passes, unit tests pass'), message);
    assert.ok(message.includes('S1; S1-S3 at workflow: full'), message);
  });

  test('git push to a feature branch stays silent', () => {
    const result = runHook(bashPayload('git push origin feature/x', project), project);
    assert.equal(warningOf(result), null);
    assert.equal(result.status, 0);
  });

  test('main as a refspec destination warns; main as a source does not', () => {
    const warn = runHook(bashPayload('git push origin HEAD:main', project), project);
    assert.ok(warningOf(warn).includes("'main'"));
    const quiet = runHook(bashPayload('git push origin main:feature', project), project);
    assert.equal(warningOf(quiet), null);
  });

  test('+main and refs/heads/master are recognised', () => {
    assert.ok(warningOf(runHook(bashPayload('git push +main', project), project)).includes("'main'"));
    assert.ok(
      warningOf(runHook(bashPayload('git push origin refs/heads/master', project), project)).includes("'master'"),
    );
  });

  test('release/* is reported with the branch name from the command', () => {
    const message = warningOf(runHook(bashPayload('git push origin release/1.0', project), project));
    assert.ok(message.includes("Push to protected branch 'release/1.0' detected."), message);
  });

  // ---- segment splitting / normalisation (bash 66-124) ----------------------

  test('a chained push is found (git add . && git push origin main)', () => {
    const message = warningOf(runHook(bashPayload('git add . && git push origin main', project), project));
    assert.ok(message.includes("'main'"));
  });

  test('wrapped invocations are found (env/var prefix/sudo/bash -c)', () => {
    for (const command of [
      'env -i git push origin main',
      'VAR=1 git push origin main',
      'sudo git push origin main',
      'if true; then git push origin main; fi',
      'bash -c "git push origin main"',
      '"C:\\Program Files\\Git\\bin\\git.exe" push origin main',
      'git -C "D:/other/repo" push origin master',
      'git --git-dir="D:/other/repo/.git" push origin main',
      'git push origin \'main\'',
    ]) {
      const message = warningOf(runHook(bashPayload(command, project), project));
      assert.ok(message !== null, `expected a warning for: ${command}`);
    }
  });

  test('text that only mentions a push is not a push command', () => {
    for (const command of ['echo git push origin main', 'cat <<EOF\ngit push origin main\nEOF']) {
      assert.equal(warningOf(runHook(bashPayload(command, project), project)), null, command);
    }
  });

  test('a quoted string is re-inspected on its own line (bash 116-123, by design)', () => {
    // The splitter deliberately breaks a quoted string containing shell
    // separators onto its own line so the inner text is re-classified. A commit
    // message that mentions a protected push therefore warns: a false positive the
    // bash original accepts, because this check only ever warns.
    const message = warningOf(runHook(bashPayload('git commit -m "then git push origin main"', project), project));
    assert.ok(message.includes("'main'"));
  });

  test('PRESERVED QUIRK: a bare `git push` yields no warning (bash 124)', () => {
    // bash 124 requires ([[:space:]]|$) AFTER the subcommand, so a line ending at
    // `push` does not match; bash 128 then exits before the current-branch check.
    // Ported as-is rather than "fixed" — see the port report.
    const result = runHook(bashPayload('git push', project), project);
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  // ---- the current-branch path (needs git) ---------------------------------

  if (repoReady) {
    test('on branch main, pushing without naming a branch warns', () => {
      const message = warningOf(runHook(bashPayload('git push origin', repo), repo));
      assert.ok(message !== null, 'expected the current-branch check to fire');
      assert.ok(message.includes("'main'"), message);
    });

    test('on branch feature/x, the same push stays silent', () => {
      assert.equal(git(['checkout', '-q', '-b', 'feature/x'], repo).status, 0);
      assert.equal(warningOf(runHook(bashPayload('git push origin', repo), repo)), null);
      git(['checkout', '-q', 'main'], repo);
    });

    test('on branch release/2.0, the same push warns with that branch', () => {
      assert.equal(git(['checkout', '-q', '-b', 'release/2.0'], repo).status, 0);
      const message = warningOf(runHook(bashPayload('git push origin', repo), repo));
      assert.ok(message !== null && message.includes("'release/2.0'"), String(message));
      git(['checkout', '-q', 'main'], repo);
    });

    test('a non-repo cwd still warns on an explicit main destination', () => {
      const message = warningOf(runHook(bashPayload('git push origin main', project), project));
      assert.ok(message !== null && message.includes("'main'"));
    });
  } else {
    console.log('skip current-branch cases: `git init`/`commit` unavailable in this sandbox');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
