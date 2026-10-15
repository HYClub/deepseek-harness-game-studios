#!/usr/bin/env node
/**
 * statusline.mjs — port of `.claude/statusline.sh`.
 *
 * The port's whole contract is one line of text, so every case builds a temporary mini-project
 * and asserts the exact rendered line: the stage ladder, the rigor default, its deliberate
 * suppression, the minimal-tier path position, the STATUS breadcrumb, JSON degradation, and the
 * missing trailing newline (`printf "%s"`).
 *
 * One upstream behaviour is easy to misread and is asserted on purpose: whenever the resolved
 * workflow is `minimal`, the third segment is the **path position**, not the stage — so a
 * project with the default rigor and no stories renders `Minimal · brief`, not `Concept`.
 * Cases that want to see the stage therefore set `modes.workflow` explicitly.
 *
 * Sandbox rule: piped child stdio is denied, so the process-level case feeds stdin from a file
 * and captures stdout in a file.
 *
 * Run: node tools/tests/scripts/statusline.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'dsh-src', 'statusline.mjs');
const { renderStatus } = await import(pathToFileURL(SCRIPT).href);

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

/** Build a throwaway project tree from a `{ 'relative/path': 'content' }` map. */
function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsgs-statusline-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

const withFixture = (files, assertion) => {
  const root = fixture(files);
  try {
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

check('fresh project renders Concept with unknown model and no context percentage', () => {
  withFixture({}, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Concept');
  });
});

check('model and context percentage come from the status JSON', () => {
  withFixture({}, (root) => {
    const input = JSON.stringify({
      model: { display_name: 'DeepSeek V3' },
      context_window: { used_percentage: 42 },
      workspace: { project_dir: root },
    });
    assert.equal(renderStatus(input, root), 'ctx: 42% | DeepSeek V3 | Concept');
  });
});

check('malformed JSON degrades instead of throwing', () => {
  withFixture({}, (root) => {
    assert.equal(renderStatus('{not json', root), 'ctx: -- | Unknown | Concept');
  });
});

check('project.stage wins, and an explicit rigor shows as the posture suffix', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nproject:\n  stage: Production\nmodes:\n  rigor: full\n  workflow: standard\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Production · full');
  });
});

check('legacy production/stage.txt is the fallback when project.stage is absent', () => {
  withFixture({ 'production/stage.txt': 'Systems Design\n' }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Systems Design');
  });
});

check('the default rigor is minimal, so the segment is the path position', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nproject:\n  stage: Production\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Minimal · brief');
  });
});

check('rigor is suppressed, not guessed, when a fronted knob is set explicitly', () => {
  withFixture({
    // review_mode is one of the six knobs rigor fronts, and workflow is pinned to standard so
    // the path position does not mask what is being asserted here.
    'project.yaml': 'schema_version: 1\nmodes:\n  review_mode: lean\n  workflow: standard\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Concept');
  });
});

check('minimal workflow renders the built-story position instead of the stage', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nmodes:\n  rigor: minimal\n  workflow: minimal\n',
    'production/epics/stack-drop/story-001-core-loop.md': '> **Status**: Complete\n',
    'production/epics/stack-drop/story-002-scoring.md': '**Status:** In Progress\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Minimal · 1/2 stories');
  });
});

check('a substring match must not count "Not Done" as done', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nmodes:\n  rigor: minimal\n  workflow: minimal\n',
    'production/epics/e/story-001-a.md': 'Status: Not Done\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Minimal · 0/1 stories');
  });
});

check('an explicit workflow wins over rigor for the tier gate', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nmodes:\n  rigor: full\n  workflow: minimal\n',
    'production/epics/e/story-001-a.md': 'Status: Done\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Minimal · 1/1 stories');
  });
});

check('Production adds the STATUS breadcrumb from the session checkpoint', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nproject:\n  stage: Production\nmodes:\n  workflow: standard\n',
    'production/session-state/active.md': [
      '# Session State',
      '',
      '<!-- STATUS -->',
      'Epic: Stack Drop',
      'Feature: Core Loop',
      'Task: Collapse detection',
      '<!-- /STATUS -->',
      '',
    ].join('\n'),
  }, (root) => {
    assert.equal(
      renderStatus('', root),
      'ctx: -- | Unknown | Production | Stack Drop > Core Loop > Collapse detection',
    );
  });
});

check('the breadcrumb is Production-and-later only', () => {
  withFixture({
    'project.yaml': 'schema_version: 1\nproject:\n  stage: Concept\nmodes:\n  workflow: standard\n',
    'production/session-state/active.md': '<!-- STATUS -->\nEpic: X\n<!-- /STATUS -->\n',
  }, (root) => {
    assert.equal(renderStatus('', root), 'ctx: -- | Unknown | Concept');
  });
});

check('the line carries no trailing newline, like printf "%s"', () => {
  // The fixture must be a real project root, otherwise the script falls back to its own
  // location (upstream rule 4) and would render the repository's own project instead.
  withFixture({
    'project.yaml': 'schema_version: 1\nmodes:\n  workflow: standard\n',
  }, (root) => {
    const stdin = join(root, 'in.json');
    const stdout = join(root, 'out.txt');
    writeFileSync(stdin, '', 'utf8');
    const inFd = openSync(stdin, 'r');
    const outFd = openSync(stdout, 'w');
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, stdio: [inFd, outFd, 'ignore'] });
    closeSync(inFd);
    closeSync(outFd);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(stdout, 'utf8'), 'ctx: -- | Unknown | Concept');
  });
});

console.log(`\nstatusline.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

