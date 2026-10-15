// Test for dsh-src/hooks/validate-commit.mjs
// Run: node tools/tests/hooks/validate-commit.test.mjs
//
// The hook is exercised through its real CLI: a JSON payload on stdin, a temp FILE for
// stdin (never a pipe — the sandbox denies piped child stdio), stdout+stderr redirected
// to a file, and a fresh throwaway git repository as the fixture root. Nothing is
// written inside the repository under test.
//
// The fixture copies the REAL `tools/yaml-helper.mjs`, because the hook resolves the code
// root and the workflow tier through it; a stub would make every code scan report SKIPPED.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const HOOK = join(ROOT, 'dsh-src', 'hooks', 'validate-commit.mjs');
const HELPER = join(ROOT, 'tools', 'yaml-helper.mjs');

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-root-'));
  mkdirSync(join(dir, '.dsh'), { recursive: true });
  return dir;
}

/** Run git in `cwd`; 0 on success. The fixture repos carry their own identity. */
function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
  return result.status ?? 1;
}

function initRepo(root) {
  if (runGit(root, ['init', '--quiet']) !== 0) return false;
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test']);
  return true;
}

function write(root, relPath, text) {
  const full = join(root, ...relPath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

/**
 * Invoke the hook. `payload` may be an object or a raw string (for malformed stdin);
 * `null` means stdin is not redirected at all (the empty-stdin path).
 * @returns {{status: number, stdout: string}}
 */
function invoke(payload, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-in-'));
  const inFile = join(dir, 'in.json');
  const outFile = join(dir, 'out.txt');
  if (payload !== null) {
    writeFileSync(inFile, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  }
  const cwd = options.cwd ?? ROOT;
  const redirect = payload === null ? '' : `< "${inFile}" `;
  try {
    const result = spawnSync(
      `node "${HOOK}" ${redirect}> "${outFile}" 2>&1`,
      { cwd, shell: true, stdio: 'ignore', timeout: 60_000, windowsHide: true,
        ...options.env !== undefined ? { env: { ...process.env, ...options.env } } : {} },
    );
    return {
      status: result.status ?? 1,
      stdout: existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The payload the bridge sends for a PreToolUse on a shell tool. */
function payload(root, command) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session',
    cwd: root,
    tool_name: 'pwsh',
    tool_input: { command },
  };
}

const created = [];
/**
 * Build a throwaway project: a git repo with a `.dsh/` marker, `project.yaml`, the real
 * yaml-helper, and whatever `build` stages. Returns null when git cannot init.
 */
function fixture(build, opts = {}) {
  const root = makeRoot();
  created.push(root);
  if (!initRepo(root)) {
    rmSync(root, { recursive: true, force: true });
    created.pop();
    return null;
  }
  if (opts.projectYaml !== null) {
    write(root, 'project.yaml', opts.projectYaml ?? 'engine:\n  name: Godot\nmodes:\n  workflow: standard\n');
  }
  if (opts.helper !== false && existsSync(HELPER)) {
    write(root, 'tools/yaml-helper.mjs', readFileSync(HELPER, 'utf8'));
  }
  build(root);
  return { root };
}

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 5).join('\n     ')}`);
    failed += 1;
    process.exitCode = 1;
  }
}
function skip(name, why) {
  console.log(`SKIP ${name} -- ${why}`);
  skipped += 1;
}

const gitReady = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'vc-git-'));
  const ok = runGit(probe, ['init', '--quiet']) === 0;
  rmSync(probe, { recursive: true, force: true });
  return ok;
})();

// ---------------------------------------------------------------------------
// 1. Commands that are not a commit leave before any parsing (exit 0, no output)
// ---------------------------------------------------------------------------
check('non-commit command exits 0 with no output', () => {
  const r = invoke(payload(ROOT, 'git status --porcelain'));
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
  assert.equal(r.stdout, '', `expected silence, got ${r.stdout}`);
});

check('payload without "tool_input" exits 0 (the "GitHub" cwd guard)', () => {
  const r = invoke({ hook_event_name: 'PreToolUse', cwd: 'D:/Work/GitHub/digital', tool_name: 'pwsh' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('non-git shell command exits 0 in a configured project', () => {
  const r = invoke(payload(ROOT, 'echo hello'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

if (!gitReady) {
  skip('every git-backed case', 'git is not runnable in this environment');
} else {
  // -------------------------------------------------------------------------
  // 2. A clean commit passes (exit 0, silence)
  // -------------------------------------------------------------------------
  const clean = fixture((root) => {
    write(root, 'src/player.gd', 'func _ready():\n\tpass\n');
  });
  if (clean !== null) {
    check('clean staged code commits without blocking or warning', () => {
      runGit(clean.root, ['add', '-A']);
      const r = invoke(payload(clean.root, 'git commit -m "add player"'), { cwd: clean.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.equal(r.stdout, '', `expected silence, got ${r.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // 3. BLOCKING: invalid JSON in a staged data file
  // -------------------------------------------------------------------------
  const badJson = fixture((root) => {
    write(root, 'assets/data/items.json', '{ "id": 1, }\n');
    write(root, 'assets/data/good.json', '{ "id": 2 }\n');
  });
  if (badJson !== null) {
    check('invalid staged JSON blocks with exit 2 and names the file', () => {
      runGit(badJson.root, ['add', '-A']);
      const r = invoke(payload(badJson.root, 'git commit -m "data"'), { cwd: badJson.root });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /BLOCKED: assets\/data\/items\.json is not valid JSON/);
      assert.doesNotMatch(r.stdout, /good\.json/);
    });

    check('a commit that records nothing staged is allowed (no data check)', () => {
      runGit(badJson.root, ['reset', '--quiet']);
      const r = invoke(payload(badJson.root, 'git commit -m "nothing"'), { cwd: badJson.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // 4. BLOCKING: several bad files, several engines, all reported at once
  // -------------------------------------------------------------------------
  const twoBad = fixture((root) => {
    write(root, 'Assets/Data/a.json', '{oops}\n');
    write(root, 'Content/Game/Data/b.json', '{{{]\n');
  });
  if (twoBad !== null) {
    check('Unity and Unreal data roots are both scanned, every offender reported', () => {
      runGit(twoBad.root, ['add', '-A']);
      const r = invoke(payload(twoBad.root, 'git commit -m "data"'), { cwd: twoBad.root });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /Assets\/Data\/a\.json is not valid JSON/);
      assert.match(r.stdout, /Content\/Game\/Data\/b\.json is not valid JSON/);
    });
  }

  const editorJson = fixture((root) => {
    write(root, '.vscode/settings.json', '{ // comments are not JSON\n }\n');
  });
  if (editorJson !== null) {
    check('JSON outside an asset data root never blocks (editor config with comments)', () => {
      runGit(editorJson.root, ['add', '-A']);
      const r = invoke(payload(editorJson.root, 'git commit -m "editor"'), { cwd: editorJson.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // 5. BLOCKING: an index entry that is not a readable blob is reported, not skipped
  // -------------------------------------------------------------------------
  const weirdBlob = fixture((root) => {
    write(root, 'assets/data/real.json', '{ "id": 1 }\n');
    mkdirSync(join(root, 'assets', 'data'), { recursive: true });
    try {
      symlinkSync(root, join(root, 'assets', 'data', 'sub.json'), 'junction');
    } catch {
      /* symlink refused: the test below degrades to the readable-file assertion */
    }
    mkdirSync(join(root, 'assets', 'data', 'sub'), { recursive: true });
    write(root, 'assets/data/sub.json/inner.json', '{ "ok": true }\n');
  });
  if (weirdBlob !== null) {
    check('a valid staged file still passes when a sibling index entry is a gitlink', () => {
      runGit(weirdBlob.root, ['add', '-A']);
      const r = invoke(payload(weirdBlob.root, 'git commit -m "data"'), { cwd: weirdBlob.root });
      // Whatever git made of the junction, the hook must reach a decision: exit 0 for a
      // readable valid file, or exit 2 naming the entry it could not validate. Silence
      // with exit 0 while a file went unvalidated is the one forbidden outcome.
      if (r.status === 0) {
        assert.equal(r.stdout, '', `expected silence, got ${r.stdout}`);
      } else {
        assert.equal(r.status, 2);
        assert.match(r.stdout, /could not be read from the git index/);
      }
    });
  }

  // -------------------------------------------------------------------------
  // 6. ADVISORY: hardcoded gameplay values and unowned TODOs
  // -------------------------------------------------------------------------
  const codeWarn = fixture((root) => {
    write(root, 'src/gameplay/player.gd', 'var damage = 10\nvar speed: int = 5\n');
  });
  if (codeWarn !== null) {
    check('hardcoded gameplay values warn without blocking', () => {
      runGit(codeWarn.root, ['add', '-A']);
      const r = invoke(payload(codeWarn.root, 'git commit -m "code"'), { cwd: codeWarn.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /=== Commit Validation Warnings ===/);
      assert.match(r.stdout, /CODE: src\/gameplay\/player\.gd may contain hardcoded gameplay values/);
    });

    // `DSGS_ADVISORY=deny` is the project policy that turns the same advisory into a pre-action
    // block: DSH delivers a `deny` reason to the model before the tool runs, while an
    // `additionalContext` notice only reaches it afterwards (measured — see the plugin README).
    check('with DSGS_ADVISORY=deny the same values block instead of advising', () => {
      runGit(codeWarn.root, ['add', '-A']);
      const r = invoke(payload(codeWarn.root, 'git commit -m "code"'), {
        cwd: codeWarn.root,
        env: { DSGS_ADVISORY: 'deny' },
      });
      assert.match(r.stdout, /"permissionDecision":"deny"/);
      assert.match(r.stdout, /may contain hardcoded gameplay values/);
      assert.doesNotMatch(r.stdout, /"additionalContext"/);
    });
  }

  const todoWarn = fixture((root) => {
    write(root, 'src/gameplay/enemy.gd', '# TODO fix the pathing\n# TODO(name) this one is owned\n');
  });
  if (todoWarn !== null) {
    check('an unowned TODO warns and an owned TODO(name) does not', () => {
      runGit(todoWarn.root, ['add', '-A']);
      const r = invoke(payload(todoWarn.root, 'git commit -m "code"'), { cwd: todoWarn.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /STYLE: src\/gameplay\/enemy\.gd has TODO\/FIXME without owner tag/);
    });
  }

  const ownedOnly = fixture((root) => {
    write(root, 'src/gameplay/enemy.gd', '# TODO(name) owned\n# FIXME(name) owned\n');
  });
  if (ownedOnly !== null) {
    check('a file whose only markers are owned produces no STYLE warning', () => {
      runGit(ownedOnly.root, ['add', '-A']);
      const r = invoke(payload(ownedOnly.root, 'git commit -m "code"'), { cwd: ownedOnly.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /STYLE:/);
    });
  }

  // -------------------------------------------------------------------------
  // 7. DEGRADATION: no helper -> the code scan announces that it did NOT run
  // -------------------------------------------------------------------------
  const noHelper = fixture((root) => {
    write(root, 'src/player.gd', 'var speed = 1\n');
  }, { helper: false });
  if (noHelper !== null) {
    check('with no yaml-helper the code scans are SKIPPED, not silently clean', () => {
      runGit(noHelper.root, ['add', '-A']);
      const r = invoke(payload(noHelper.root, 'git commit -m "code"'), { cwd: noHelper.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /SKIPPED: source files are staged but no code root could be resolved/);
      assert.match(r.stdout, /The hardcoded-value and TODO-owner scans did NOT run/);
    });
  }

  const noHelperGdd = fixture((root) => {
    write(root, 'design/gdd/combat.md', '# Combat\n\n## Overview\n');
  }, { helper: false });
  if (noHelperGdd !== null) {
    check('with no yaml-helper the GDD tier falls back to "standard" and still warns', () => {
      runGit(noHelperGdd.root, ['add', '-A']);
      const r = invoke(payload(noHelperGdd.root, 'git commit -m "gdd"'), { cwd: noHelperGdd.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /missing section required at workflow=standard: Acceptance Criteria/);
    });
  }

  const noEngine = fixture((root) => {
    write(root, 'src/player.gd', 'var speed = 1\n');
  }, { projectYaml: 'modes:\n  workflow: minimal\n' });
  if (noEngine !== null) {
    check('engine.name unset still resolves the code root by a single candidate directory', () => {
      runGit(noEngine.root, ['add', '-A']);
      const r = invoke(payload(noEngine.root, 'git commit -m "code"'), { cwd: noEngine.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /CODE: src\/player\.gd may contain hardcoded gameplay values/);
    });
  }

  // -------------------------------------------------------------------------
  // 8. GDD sections scale with modes.workflow
  // -------------------------------------------------------------------------
  const gddStandard = fixture((root) => {
    write(root, 'design/gdd/combat.md', '# Combat\n\n## Overview\n\n## Detailed Design\n\n## Edge Cases\n\n## Dependencies\n\n## Acceptance Criteria\n');
  });
  if (gddStandard !== null) {
    check('a GDD with every standard-tier section produces no DESIGN warning', () => {
      runGit(gddStandard.root, ['add', '-A']);
      const r = invoke(payload(gddStandard.root, 'git commit -m "gdd"'), { cwd: gddStandard.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /DESIGN:/);
    });
  }

  const gddMissing = fixture((root) => {
    write(root, 'design/gdd/combat.md', '# Combat\n\n## Overview\n\n## Edge Cases\n');
  });
  if (gddMissing !== null) {
    check('a GDD missing standard-tier sections warns, naming each one', () => {
      runGit(gddMissing.root, ['add', '-A']);
      const r = invoke(payload(gddMissing.root, 'git commit -m "gdd"'), { cwd: gddMissing.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /DESIGN: design\/gdd\/combat\.md missing section required at workflow=standard: Detailed/);
      assert.match(r.stdout, /missing section required at workflow=standard: Dependencies/);
      assert.match(r.stdout, /missing section required at workflow=standard: Acceptance Criteria/);
    });
  }

  const gddMinimal = fixture((root) => {
    write(root, 'design/gdd/jam.md', '# Jam\n\nnothing else\n');
  }, { projectYaml: 'engine:\n  name: Godot\nmodes:\n  workflow: minimal\n' });
  if (gddMinimal !== null) {
    check('workflow=minimal demands no GDD sections at all', () => {
      runGit(gddMinimal.root, ['add', '-A']);
      const r = invoke(payload(gddMinimal.root, 'git commit -m "gdd"'), { cwd: gddMinimal.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /DESIGN:/);
    });
  }

  const gddFull = fixture((root) => {
    write(root, 'design/gdd/combat.md', '# Combat\n\n## Overview\n');
  }, { projectYaml: 'engine:\n  name: Godot\nmodes:\n  workflow: full\n' });
  if (gddFull !== null) {
    check('workflow=full demands all eight sections', () => {
      runGit(gddFull.root, ['add', '-A']);
      const r = invoke(payload(gddFull.root, 'git commit -m "gdd"'), { cwd: gddFull.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /missing section required at workflow=full: Player Fantasy/);
      assert.match(r.stdout, /missing section required at workflow=full: Tuning Knobs/);
    });
  }

  // -------------------------------------------------------------------------
  // 9. Path-limited commits only check the named paths
  // -------------------------------------------------------------------------
  const pathLimited = fixture((root) => {
    write(root, 'src/player.gd', 'var speed = 1\n');
    write(root, 'assets/data/broken.json', '{oops}\n');
  });
  if (pathLimited !== null) {
    check('a path-limited commit does not block on a broken file it does not record', () => {
      runGit(pathLimited.root, ['add', '-A']);
      const r = invoke(payload(pathLimited.root, 'git commit -m "code" src/player.gd'), { cwd: pathLimited.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // 10. -a widens to the working tree, so an unstaged broken data file blocks
  // -------------------------------------------------------------------------
  const withAll = fixture((root) => {
    write(root, 'src/player.gd', 'func _ready():\n\tpass\n');
    write(root, 'assets/data/tracked.json', '{ "id": 1 }\n');
  });
  if (withAll !== null) {
    check('git commit -a picks up an unstaged broken data file and blocks', () => {
      runGit(withAll.root, ['add', '-A']);
      runGit(withAll.root, ['commit', '--quiet', '-m', 'baseline']);
      write(withAll.root, 'assets/data/tracked.json', '{ broken now\n');
      const r = invoke(payload(withAll.root, 'git commit -am "wip"'), { cwd: withAll.root });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /assets\/data\/tracked\.json is not valid JSON/);
    });
  }

  // -------------------------------------------------------------------------
  // 11. Chained and prefixed forms are still found (the documented bypasses)
  // -------------------------------------------------------------------------
  const chained = fixture((root) => {
    write(root, 'assets/data/broken.json', '{oops}\n');
  });
  if (chained !== null) {
    check('git add -A && git commit is still checked', () => {
      runGit(chained.root, ['add', '-A']);
      const r = invoke(payload(chained.root, 'git add -A && git commit -m "data"'), { cwd: chained.root });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}`);
    });

    check('a here-document body mentioning git commit is not a commit', () => {
      const cmd = 'cat > notes.md <<EOF\ngit commit -m "not really"\nEOF\necho done';
      const r = invoke(payload(chained.root, cmd), { cwd: chained.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      assert.equal(r.stdout, '', `expected silence, got ${r.stdout}`);
    });

    check('a bare "git commit" with nothing staged is allowed', () => {
      runGit(chained.root, ['reset', '--quiet']);
      const r = invoke(payload(chained.root, 'git commit'), { cwd: chained.root });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // 12. Another repository via -C is not ours to check
  // -------------------------------------------------------------------------
  const elsewhere = fixture((root) => {
    write(root, 'src/player.gd', 'func _ready():\n\tpass\n');
  });
  if (elsewhere !== null) {
    const other = makeRoot();
    created.push(other);
    if (initRepo(other)) {
      check('git -C <other repo> commit is left alone', () => {
        const r = invoke(payload(elsewhere.root, `git -C "${other}" commit -m "other"`), { cwd: elsewhere.root });
        assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
      });
    }
  }

  const selfC = fixture((root) => {
    write(root, 'assets/data/broken.json', '{oops}\n');
  });
  if (selfC !== null) {
    check('git -C <this repo> commit is NOT skipped', () => {
      runGit(selfC.root, ['add', '-A']);
      const r = invoke(payload(selfC.root, `git -C "${selfC.root}" commit -m "data"`), { cwd: selfC.root });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stdout}`);
    });
  }
}

// ---------------------------------------------------------------------------
// 13. Malformed / empty stdin degrades to allow
// ---------------------------------------------------------------------------
check('empty stdin exits 0 with no output', () => {
  const r = invoke('');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('missing stdin (no redirection) exits 0', () => {
  const r = invoke(null);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
});

check('malformed JSON stdin exits 0 with no output', () => {
  const r = invoke('{"tool_input": {"command": "git commit -m x"');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('a payload with no command field exits 0', () => {
  const r = invoke({ hook_event_name: 'PreToolUse', cwd: ROOT, tool_name: 'pwsh', tool_input: {} });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('a tool_input that is not an object cannot be parsed into a command (exit 0)', () => {
  const r = invoke({ hook_event_name: 'PreToolUse', cwd: ROOT, tool_name: 'pwsh', tool_input: 'git commit -m x' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('"git" in a path but not in tool_input takes the early exit', () => {
  const r = invoke({
    hook_event_name: 'PreToolUse',
    cwd: 'D:/Work/GitHub/digital',
    tool_name: 'pwsh',
    tool_input: { command: 'echo hello' },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

check('a commit in a directory that is not a git repository is allowed', () => {
  const dir = makeRoot();
  created.push(dir);
  const r = invoke(payload(dir, 'git commit -m "x"'), { cwd: dir });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}`);
});

for (const dir of created) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exitCode = 1;

