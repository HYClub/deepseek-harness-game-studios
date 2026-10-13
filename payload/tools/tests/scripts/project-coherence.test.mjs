// Test for dsh-src/scripts/project-coherence.mjs
//   (port of .claude/scripts/project-coherence.sh)
// Run: node tools/tests/scripts/project-coherence.test.mjs
//
// /setup-engine and /smoke-check parse this script's stdout, so the `[MATCH]` /
// `[DIFFERS]` / `[NOT CHECKED]` prefixes, the wording and the summary line are
// asserted literally.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeChecker, makeFixture, runScript } from './_harness.mjs';

const SCRIPT = 'project-coherence.mjs';
const check = makeChecker('project-coherence');

const PROJECT_YAML = [
  'schema_version: 1',
  '',
  'engine:',
  '  name: Godot',
  '  version: 4.6',
  '  path: godot',
  '  rendering: Forward+',
  '  physics: Jolt',
  '',
  'commands:',
  '  build: "godot --headless --export-release Linux"',
  '  test: "addons/gdUnit4/bin/GdUnitCmdTool.gd"',
  '',
].join('\n');

const VERSION_MD = [
  '# Godot Engine Version Reference',
  '',
  '| Field | Value |',
  '| --- | --- |',
  '| **Engine Version** | Godot 4.6 |',
  '| **Installed at pin time** | 4.6.1.stable |',
  '',
].join('\n');

const VERSION_MD_NO_PROBE = VERSION_MD.replace(
  '| **Installed at pin time** | 4.6.1.stable |',
  '',
);

const PROJECT_GODOT = [
  'config_version=5',
  '',
  '[rendering]',
  '',
  'renderer/rendering_method="forward_plus"',
  '',
].join('\n');

/** Every `[CATEGORY]`-tagged line, in order. */
const tagged = (stdout) => stdout.split('\n').filter((line) => line.startsWith('['));
const matches = (stdout) => tagged(stdout).filter((l) => l.startsWith('[MATCH]'));
const differs = (stdout) => tagged(stdout).filter((l) => l.startsWith('[DIFFERS]'));
const skipped = (stdout) => tagged(stdout).filter((l) => l.startsWith('[NOT CHECKED]'));

/**
 * The counts on the summary line, as written: `checked N · differs N · not checked N`.
 * The counters are incremented per COMPLETED comparison, so `checked` equals the
 * MATCH + DIFFERS lines.
 */
function summary(stdout) {
  const found = /checked (\d+) · differs (\d+) · not checked (\d+)/.exec(stdout);
  assert.ok(found !== null, `no summary line in: ${stdout}`);
  return { checked: Number(found[1]), differs: Number(found[2]), notChecked: Number(found[3]) };
}

const coherent = makeFixture({
  files: {
    'project.yaml': PROJECT_YAML,
    'docs/engine-reference/godot/VERSION.md': VERSION_MD,
    'project.godot': PROJECT_GODOT,
    // Node3D, because the declaration is Jolt and Jolt is a 3D backend: a 2D node
    // here would be a legitimate physics DIFFERS, not a coherent project.
    'src/gameplay/combat.gd': 'extends Node3D\n',
    'export_presets.cfg': '[preset.0]\nname="Linux"\n',
    'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
  },
});

try {
  check('a coherent project reports MATCH lines and a well-formed summary', () => {
    const r = runScript(coherent, SCRIPT, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^=== project coherence ===\n/);
    // The engine-binary probe is legitimately NOT CHECKED where no godot is
    // installed; every OTHER check must have produced a MATCH or a DIFFERS.
    const otherSkips = skipped(r.stdout).filter((l) => !/installed binary/.test(l));
    assert.equal(otherSkips.length, 0, otherSkips.join('\n'));
    // Pinned-reference, project.yaml-vs-pin, rendering, physics, commands.build,
    // commands.test. The binary probe is asserted separately, below.
    assert.ok(matches(r.stdout).length >= 6, `n=${matches(r.stdout).length} :: ${r.stdout}`);
    const counts = summary(r.stdout);
    assert.equal(counts.differs, differs(r.stdout).length);
    assert.equal(counts.checked, matches(r.stdout).length + differs(r.stdout).length);
    assert.equal(counts.notChecked, skipped(r.stdout).length);
    assert.match(r.stdout, /Observations only — no verdict\. 'not checked' is not agreement:/);
    assert.match(
      r.stdout,
      /each line above names why that comparison could not be made\.\n$/,
    );
  });

  check('a 2D project declaring Forward+ and Jolt is flagged, with both reasons', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML.replace('rendering: Forward+', 'rendering: Compatibility'),
        'docs/engine-reference/godot/VERSION.md': VERSION_MD,
        'project.godot': PROJECT_GODOT,
        'src/gameplay/combat.gd': 'extends CharacterBody2D\n',
        'export_presets.cfg': '[preset.0]\n',
        'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      const diffs = differs(r.stdout);
      assert.equal(diffs.length, 2, r.stdout);
      assert.match(diffs[0], /^\[DIFFERS\]     engine\.rendering is 'Compatibility' \(expects gl_compatibility\) but project\.godot runs 'forward_plus'\./);
      assert.match(diffs[1], /^\[DIFFERS\]     engine\.physics is 'Jolt', but 2D nodes were found under src\/\./);
    } finally {
      fixture.cleanup();
    }
  });

  check('version drift against VERSION.md and project.godot is DIFFERS', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML.replace('version: 4.6', 'version: 4.7'),
        'docs/engine-reference/godot/VERSION.md': VERSION_MD,
        'project.godot': PROJECT_GODOT.replace('forward_plus', 'gl_compatibility'),
        'export_presets.cfg': '',
        'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      const diffs = differs(r.stdout);
      assert.match(diffs.join('\n'), /engine\.version is '4\.7' but docs\/engine-reference\/godot\/VERSION\.md pins 'Godot 4\.6'\./);
      assert.match(diffs.join('\n'), /project\.godot runs 'gl_compatibility'/);
    } finally {
      fixture.cleanup();
    }
  });

  check('a missing export preset and a missing test runner are DIFFERS with the hint', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML,
        'docs/engine-reference/godot/VERSION.md': VERSION_MD,
        'project.godot': PROJECT_GODOT,
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      const diffs = differs(r.stdout).join('\n');
      assert.match(diffs, /\[DIFFERS\]     commands\.build is 'godot --headless --export-release Linux' but there is no export_presets\.cfg\./);
      assert.match(diffs, /commands\.test is 'addons\/gdUnit4\/bin\/GdUnitCmdTool\.gd' but 'addons\/gdUnit4\/bin\/GdUnitCmdTool\.gd' does not exist/);
      // A runner under addons/gdUnit4/ gets the capital-U hint, in the original's
      // wording: on a case-insensitive checkout the folder trap is the usual cause.
      assert.match(diffs, /gdUnit4 is not installed at addons\/gdUnit4\/ \(capital U\) — see \/test-setup\./);
    } finally {
      fixture.cleanup();
    }
  });

  check('a runner named with res:// has the prefix stripped before the file test', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML.replace(
          'test: "addons/gdUnit4/bin/GdUnitCmdTool.gd"',
          'test: "godot --headless res://addons/gdUnit4/bin/GdUnitCmdTool.gd"',
        ),
        'docs/engine-reference/godot/VERSION.md': VERSION_MD,
        'project.godot': PROJECT_GODOT,
        'export_presets.cfg': '',
        'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      // The file exists, so the runner check is a MATCH — proving the `res://`
      // prefix was stripped (a class that stopped at the colon would have checked
      // `//addons/...` and reported a present runner as missing).
      assert.match(
        matches(r.stdout).join('\n'),
        /commands\.test runner exists \(addons\/gdUnit4\/bin\/GdUnitCmdTool\.gd\)/,
      );
      assert.equal(differs(r.stdout).length, 0, r.stdout);
    } finally {
      fixture.cleanup();
    }
  });

  check('a missing `Installed at pin time` row is DIFFERS, not silence', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML,
        'docs/engine-reference/godot/VERSION.md': VERSION_MD_NO_PROBE,
        'project.godot': PROJECT_GODOT,
      },
    });
    try {
      const diffs = differs(runScoped(fixture)).join('\n');
      assert.match(diffs, /has no 'Installed at pin time' row\. \/setup-engine is required to write one/);
    } finally {
      fixture.cleanup();
    }
  });

  check('a NOT DETERMINED probe is NOT CHECKED, never a match', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML,
        'docs/engine-reference/godot/VERSION.md': VERSION_MD.replace('4.6.1.stable', 'NOT DETERMINED'),
        'project.godot': PROJECT_GODOT,
        // Present so the only thing this case can report is the NOT DETERMINED
        // skip; the command checks would otherwise add unrelated DIFFERS.
        'export_presets.cfg': '',
        'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
      },
    });
    try {
      const out = runScoped(fixture);
      assert.equal(differs(out).length, 0, out);
      assert.match(
        skipped(out).join('\n'),
        /\[NOT CHECKED\] pinned-vs-installed — docs\/engine-reference\/godot\/VERSION\.md records 'NOT DETERMINED'\./,
      );
    } finally {
      fixture.cleanup();
    }
  });

  check('no project.yaml at all: everything is NOT CHECKED, exit 0', () => {
    const fixture = makeFixture({ files: { 'README.md': '# empty project\n' } });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        skipped(r.stdout)[0],
        '[NOT CHECKED] everything — no project.yaml at the repo root. Run /start.',
      );
      assert.match(r.stdout, /checked 0 · differs 0 · not checked 1/);
    } finally {
      fixture.cleanup();
    }
  });

  check('project.yaml without engine.name skips every engine check', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': 'schema_version: 1\n\nengine:\n  version: 4.6\n',
        'project.godot': PROJECT_GODOT,
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        skipped(r.stdout)[0],
        '[NOT CHECKED] every engine check — project.yaml has no engine.name. Run /setup-engine.',
      );
      assert.match(r.stdout, /checked 0 · differs 0 · not checked 1/);
    } finally {
      fixture.cleanup();
    }
  });

  check('every engine-specific NOT CHECKED branch names why, without a verdict', () => {
    const cases = [
      {
        name: 'no VERSION.md',
        files: { 'project.yaml': PROJECT_YAML, 'project.godot': PROJECT_GODOT },
        expect: /\[NOT CHECKED\] pinned-reference checks — docs\/engine-reference\/godot\/VERSION\.md does not exist/,
        commandsChecked: true,
      },
      {
        name: 'no project.godot',
        files: { 'project.yaml': PROJECT_YAML, 'docs/engine-reference/godot/VERSION.md': VERSION_MD },
        expect: /\[NOT CHECKED\] project-file checks — no project\.godot in this repo/,
        commandsChecked: true,
      },
      {
        name: 'no engine.rendering',
        files: {
          'project.yaml': PROJECT_YAML.replace('  rendering: Forward+\n', ''),
          'docs/engine-reference/godot/VERSION.md': VERSION_MD,
          'project.godot': PROJECT_GODOT,
          'export_presets.cfg': '',
          'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
        },
        expect: /\[NOT CHECKED\] rendering — project\.yaml has no engine\.rendering/,
      },
      {
        name: 'unmapped rendering value',
        files: {
          'project.yaml': PROJECT_YAML.replace('rendering: Forward+', 'rendering: Vulkanish'),
          'docs/engine-reference/godot/VERSION.md': VERSION_MD,
          'project.godot': PROJECT_GODOT,
          'export_presets.cfg': '',
          'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
        },
        expect: /\[NOT CHECKED\] rendering — engine\.rendering 'Vulkanish' is not one this script maps/,
      },
      {
        name: 'no engine.physics',
        files: {
          'project.yaml': PROJECT_YAML.replace('  physics: Jolt\n', ''),
          'docs/engine-reference/godot/VERSION.md': VERSION_MD,
          'project.godot': PROJECT_GODOT,
          'export_presets.cfg': '',
          'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
        },
        expect: /\[NOT CHECKED\] physics — project\.yaml has no engine\.physics/,
      },
      {
        name: 'no commands',
        files: {
          'project.yaml': PROJECT_YAML.replace(/commands:[\s\S]*$/, ''),
          'docs/engine-reference/godot/VERSION.md': VERSION_MD,
          'project.godot': PROJECT_GODOT,
        },
        expect: /\[NOT CHECKED\] command checks — project\.yaml declares no commands\.build or commands\.test/,
      },
      {
        name: 'another engine',
        files: {
          'project.yaml': PROJECT_YAML.replace('name: Godot', 'name: Unity'),
          'project.godot': PROJECT_GODOT,
          'export_presets.cfg': '',
          'addons/gdUnit4/bin/GdUnitCmdTool.gd': 'extends Node\n',
        },
        expect: /\[NOT CHECKED\] project-file checks — implemented for Godot only; Unity has no single equivalent file/,
      },
    ];
    for (const { name, files, expect, commandsChecked } of cases) {
      const fixture = makeFixture({ files });
      try {
        const r = runScript(fixture, SCRIPT, []);
        assert.equal(r.status, 0, `${name}: ${r.stderr}`);
        assert.match(skipped(r.stdout).join('\n'), expect, name);
        // Nothing may be reported as a DIFFERS on a comparison that could not run.
        // `commandsChecked` marks the cases that deliberately leave commands.*
        // pointing at files the fixture does not have — those ARE real findings.
        if (commandsChecked !== true) assert.equal(differs(r.stdout).length, 0, name);
      } finally {
        fixture.cleanup();
      }
    }
  });

  check('the installed-binary probe is either a MATCH or a named skip', () => {
    const r = runScript(coherent, SCRIPT, []);
    const probeLines = tagged(r.stdout).filter((l) => /installed binary|binary reports|no Godot executable/.test(l));
    assert.equal(probeLines.length, 1, r.stdout);
    if (probeLines[0].startsWith('[MATCH]')) {
      assert.match(probeLines[0], /engine\.version 4\.6 matches the installed binary/);
    } else {
      assert.equal(
        probeLines[0],
        '[NOT CHECKED] declared version vs installed binary — no Godot executable found (commands.test, engine.path, PATH). A probe that could not run has not established absence.',
      );
    }
  });

  check('a binary reporting a different major.minor is DIFFERS', () => {
    // A fake `godot` on PATH: the probe must use it and compare major.minor, not
    // the full release string.
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML,
        'docs/engine-reference/godot/VERSION.md': VERSION_MD,
        'project.godot': PROJECT_GODOT,
        'bin/godot.cmd': '@echo 4.5.2.stable\r\n',
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, [], {
        env: { PATH: `${join(fixture.root, 'bin')};${process.env.PATH}` },
      });
      const probe = tagged(r.stdout).find((l) => /installed binary/.test(l));
      assert.ok(probe !== undefined, r.stdout);
      // `.cmd` is in PATHEXT, so `godot` resolves; if the probe could not run at
      // all, the skip text is acceptable but must say so rather than pass.
      if (probe.startsWith('[DIFFERS]')) {
        assert.match(probe, /installed binary reports '4\.5\.2\.stable'/);
      } else {
        assert.match(probe, /no Godot executable found/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  check('Unity 6000.N is compared as 6.N against the pinned series', () => {
    const fixture = makeFixture({
      files: {
        'project.yaml': PROJECT_YAML
          .replace('name: Godot', 'name: Unity')
          .replace('version: 4.6', 'version: 6000.3.23f1'),
        'docs/engine-reference/unity/VERSION.md': '| **Engine Version** | Unity 6.3 LTS |\n',
      },
    });
    try {
      const r = runScript(fixture, SCRIPT, []);
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        matches(r.stdout).join('\n'),
        /engine\.version \(6000\.3\.23f1\) agrees with docs\/engine-reference\/unity\/VERSION\.md \(Unity 6\.3 LTS\)/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  check('the fixture root is what was read, not the repository', () => {
    const r = runScript(coherent, SCRIPT, []);
    assert.match(r.stdout, /engine\.rendering \(Forward\+\) agrees with project\.godot \(forward_plus\)/);
    assert.ok(!r.stdout.includes('D:\\Work\\dsh'), r.stdout);
  });
} finally {
  coherent.cleanup();
}

/** Run the script in a fixture and return its stdout (asserting exit 0). */
function runScoped(fixture) {
  const r = runScript(fixture, SCRIPT, []);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
