#!/usr/bin/env node
/**
 * project-coherence.mjs — Node port of `.dsh/scripts/project-coherence.sh`.
 *
 * WHY THIS EXISTS (unchanged from the shell original)
 *
 * Three defects share one shape: `project.yaml` is treated as the source of truth
 * and is never reconciled against the artifact it describes.
 *
 *   1  engine.version says 4.7.2; project.godot says 4.6; the binary is 4.6.1
 *   2  engine.rendering says Forward+; project.godot says gl_compatibility
 *   3  commands.build names an export preset with no export_presets.cfg
 *
 * The second is why this is a script and not another paragraph. `/setup-engine`
 * ALREADY carries an emphatic, source-cited warning naming both of the exact
 * mistakes that produce it ("Jolt is Godot's default 3D engine", "Forward+ is
 * desktop-focused"). Prose is in place and does not hold on its own. What was
 * missing was a step that reads back what was written.
 *
 * F1's root cause was subtler and is fixed elsewhere: `/setup-engine` is told to
 * write an `Installed at pin time` row into VERSION.md, and no VERSION.md had
 * such a row. There was no slot, so the step vanished leaving no trace. The row
 * now ships in all three reference files, and check 1 below reads it.
 *
 * OBSERVATIONS, NEVER VERDICTS
 *
 * Per the project instructions (AGENTS.md): a script that scores or judges will eventually contradict a mode
 * or override it cannot see. This one prints what it compared and what it found,
 * and always exits 0. The reader decides. A check that cannot run says so by
 * name — silence is never treated as agreement. `/setup-engine` and
 * `/smoke-check` read the `[DIFFERS]` and `[NOT CHECKED]` prefixes, so those
 * prefixes and the summary line are a contract.
 *
 * PORT NOTES (what is not a literal translation, and why)
 *   - `ROOT="$(cd "$(dirname "$0")/../.." && pwd)"` becomes
 *     `scriptRoot()`, which resolves this file's own two-levels-up directory.
 *     the upstream project-dir variable is still honoured when set.
 *   - No pipes: the engine probe and `git`-free file reads go through
 *     `runCommand()` (`../hooks/_capture.mjs`), which redirects child output to a
 *     temp file. Every grep/sed/awk/case expression is reimplemented in Node
 *     against the same fields, so no `grep`, `sed`, `awk`, `tr`, `sort` or
 *     `find` executable is needed at all.
 *   - `find src -name '*.gd' -o -name '*.tscn'` is reproduced as a bounded
 *     directory walk (`src/` pruned at depth 7 — see MAX_SCAN_DEPTH) instead of
 *     an unbounded traversal that can stall on a large asset tree.
 *   - `vmm()` keeps the Unity quirk: `6000.N` is read as `6.N`, because the same
 *     editor is marketed both ways and `/setup-engine` may write either.
 */
import { join } from 'node:path';
import { runCommand } from '../hooks/_capture.mjs';
import { isFile, readTextOr, splitLines, walkFiles, whichOnPath } from './_fsutil.mjs';

/** `find src` is unbounded in the original; a bounded walk cannot hang on a deep asset tree. */
const MAX_SCAN_DEPTH = 7;

/* ------------------------------------------------------------------ *
 * Counting output (the contract the skills parse)
 * ------------------------------------------------------------------ */

let checked = 0;
let differs = 0;
let skipped = 0;

const say = (text) => process.stdout.write(`${text}\n`);
const match = (text) => { checked += 1; say(`[MATCH]       ${text}`); };
const differ = (text) => { checked += 1; differs += 1; say(`[DIFFERS]     ${text}`); };
const notChecked = (text) => { skipped += 1; say(`[NOT CHECKED] ${text}`); };

function summarise() {
  say('');
  say(`checked ${checked} · differs ${differs} · not checked ${skipped}`);
  say('');
  say('Observations only — no verdict. \'not checked\' is not agreement:');
  say('each line above names why that comparison could not be made.');
}

/* ------------------------------------------------------------------ *
 * project.yaml readers
 * ------------------------------------------------------------------ */

/**
 * Read one `key: value` from a named top-level block of project.yaml.
 * Deliberately simple: this file is machine-written and two levels deep.
 *
 * The shell original, reproduced expression for expression:
 *
 *   $0 ~ "^"b":" { inb=1; next }        # the block header line
 *   inb && /^[a-zA-Z_]/ { inb=0 }        # any new top-level key ends the block
 *   inb && $0 ~ "^[[:space:]]+"k":" {
 *     sub("^[[:space:]]*"k":[[:space:]]*", "")
 *     gsub(/^"|"$/, "")                  # strip ONE leading and ONE trailing quote
 *     print; exit                        # first occurrence wins
 *   }
 *
 * Note the block test is a PREFIX test, not an exact one: `engine:` matched
 * `engine_extras:` too in the shell, because awk's `~` is a regex search and
 * nothing anchored the end of the key. That quirk is preserved — this script's
 * job is to read what `/setup-engine` wrote, in whatever shape it wrote it, and
 * a "cleaned up" reader that disagreed with the shell one would silently change
 * which of the two files looks wrong.
 * @param {string} file
 * @param {string} block top-level block name (`engine`, `commands`)
 * @param {string} key key inside the block
 * @returns {string}
 */
function yamlBlockValue(file, block, key) {
  const text = readTextOr(file);
  if (text === '') return '';
  const keyRe = new RegExp(`^[ \\t]+${key}:[ \\t]*`);
  let inBlock = false;
  for (const line of splitLines(text)) {
    if (line.startsWith(`${block}:`)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^[a-zA-Z_]/.test(line)) inBlock = false;
    if (!inBlock) continue;
    if (!keyRe.test(line)) continue;
    let value = line.replace(keyRe, '');
    value = value.replace(/^"/, '').replace(/"$/, '');
    return value;
  }
  return '';
}

/**
 * major.minor of the first version in `value`, with Unity's 6000.N read as 6.N.
 * @param {string} value
 * @returns {string}
 */
function vmm(value) {
  const found = /[0-9]+\.[0-9]+/.exec(value ?? '');
  if (found === null) return '';
  return found[0].replace(/^6000\./, '6.');
}

/* ------------------------------------------------------------------ *
 * Executable discovery (the `command -v` / `[ -x ]` chain)
 * ------------------------------------------------------------------ */

/**
 * `command -v X || [ -x X ]` — a name resolved on PATH, or a path that is
 * directly executable. `whichOnPath` adds the Windows `PATHEXT` suffixes a bare
 * `command -v godot` would find as `godot.exe`.
 * @param {string} candidate
 * @returns {string} resolved path, or ''
 */
function resolveExecutable(candidate) {
  if (candidate === '') return '';
  if (candidate.includes('/') || candidate.includes('\\')) {
    return isFile(candidate) ? candidate : whichOnPath(candidate);
  }
  return whichOnPath(candidate);
}

/** `grep -oE '"[^"]*"' | head -1 | tr -d '"'` — the first double-quoted run. */
function firstQuoted(value) {
  const found = /"([^"]*)"/.exec(value ?? '');
  return found === null ? '' : found[1];
}

/** `awk '{print $1}'` — the first whitespace-separated token. */
function firstWord(value) {
  const found = /\S+/.exec(value ?? '');
  return found === null ? '' : found[0];
}

/** `grep -oE '"[^"]*\/Unity(\.exe)?"' | head -1 | tr -d '"'` — the first quoted path ending in Unity. */
function unityFromCommands(value) {
  const found = /"[^"]*\/Unity(\.exe)?"/.exec(value ?? '');
  if (found === null) return '';
  return found[0].replace(/"/g, '');
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/** Grab the value of a `| **Label** | value |` table row in a reference file. */
function versionRow(verfile, label) {
  const re = new RegExp(`^\\| \\*\\*${label}\\*\\* \\|`);
  for (const line of splitLines(readTextOr(verfile))) {
    if (!re.test(line)) continue;
    // sed -E 's/^\| \*\*Label\*\* \| *//; s/ *\|$//'
    return line.replace(re, '').replace(/^ */, '').replace(/ *\|$/, '');
  }
  return '';
}

/**
 * `grep -oE '(res://)?[A-Za-z0-9_/.-]+\.(gd|cs|py|sh)' | head -1`, then strip the
 * `res://` prefix: Godot names its runner as `res://addons/gdUnit4/bin/GdUnitCmdTool.gd`,
 * and stripping the prefix is what makes the file test work. The shell version
 * was written without the `//` escape and reported a present runner as missing.
 * @param {string} testCommand
 * @returns {string}
 */
function firstRunnerPath(testCommand) {
  const re = /(res:\/\/)?[A-Za-z0-9_/.-]+\.(gd|cs|py|sh)/g;
  const found = re.exec(testCommand ?? '');
  if (found === null) return '';
  return found[0].replace(/^res:\/\//, '');
}

/**
 * Run a version probe and take the first line of its output.
 *
 * Two conditions, both of them the shell original's:
 *   - the probe must have RUN (`"$GEXE" --version 2>/dev/null`); a failed spawn
 *     must read as "no probe", never as a version string. On Windows a resolved
 *     candidate can exist yet refuse to execute (EFTYPE for a `.gd` file), and
 *     `runCommand` reports that in `stdout` — unchecked, it would be compared as
 *     if it were the engine's version. The shell had the same hazard one level
 *     down: it only ran a candidate that passed `command -v` or `[ -x ]` first.
 *   - `| head -1` takes the first line, not all of them.
 * @param {string} executable
 * @param {string[]} args
 * @returns {string}
 */
function probeVersion(executable, args) {
  const result = runCommand(executable, args, { timeoutMs: 20_000 });
  if (result.status !== 0) return '';
  return splitLines(result.stdout)[0] ?? '';
}

function probeGodot(commandsTest, enginePath) {
  // The executable named in commands.test (quoted, or its first word), else
  // engine.path, else `godot` on PATH -- the same fallback order dev-story and
  // smoke-check use. commands.* now carries the full editor path once
  // /setup-engine has run, so a bare `command -v godot` alone reported "no
  // Godot binary found on PATH" even on a correctly configured project.
  const candidates = [firstQuoted(commandsTest), firstWord(commandsTest), enginePath, 'godot'];
  let executable = '';
  for (const candidate of candidates) {
    if (candidate === '') continue;
    if (resolveExecutable(candidate) !== '') {
      executable = candidate;
      break;
    }
  }
  if (executable === '') return '';
  return probeVersion(executable, ['--version']);
}

function probeUnity(commandsTest, version) {
  // The editor named in commands.test (/setup-engine writes its full, quoted
  // path), else the Hub folder for engine.version, picked by OS -- Unity's Hub
  // installs to a different path on each. Never bare `Unity`: on PATH that is
  // often Unity's separate CLI, which rejects -version with exit 2.
  let executable = unityFromCommands(commandsTest);
  if (executable === '' && version !== '') {
    if (process.platform === 'darwin') {
      executable = `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`;
    } else if (process.platform === 'linux') {
      executable = join(process.env.HOME ?? '', 'Unity/Hub/Editor', version, 'Editor/Unity');
    } else {
      executable = `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`;
    }
  }
  if (executable === '' || !isFile(executable)) return '';
  return probeVersion(executable, ['-version']);
}

function probeUnreal() {
  if (whichOnPath('UnrealEditor-Cmd') === '') return '';
  return probeVersion('UnrealEditor-Cmd', ['-version']);
}

/**
 * `grep -qE '(Node2D|CharacterBody2D|…)' $(find src -name '*.gd' -o -name '*.tscn')`
 * — does any Godot source or scene under `src/` mention a 2D node type?
 * @param {string} root
 * @returns {boolean}
 */
function has2DNodes(root) {
  const files = walkFiles(join(root, 'src'), {
    maxDepth: MAX_SCAN_DEPTH,
    nameMatches: (name) => name.endsWith('.gd') || name.endsWith('.tscn'),
  });
  const re = /(Node2D|CharacterBody2D|RigidBody2D|Area2D|StaticBody2D)/;
  for (const file of files) {
    if (re.test(readTextOr(file))) return true;
  }
  return false;
}

/**
 * `grep -E '^renderer/rendering_method' project.godot`, then
 * `sed -E 's/.*= *"?([a-z_]+)"?.*'` — the first `[a-z_]+` run after an `=`.
 * @param {string} root
 * @returns {string}
 */
function projectGodotRenderingMethod(root) {
  for (const line of splitLines(readTextOr(join(root, 'project.godot')))) {
    if (!line.startsWith('renderer/rendering_method')) continue;
    const found = /= *"?([a-z_]+)"?/.exec(line);
    return found === null ? '' : found[1];
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Program
 * ------------------------------------------------------------------ */

function scriptRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  // `.dsh/scripts/` (and `dsh-src/scripts/`) are both two levels below the root.
  return join(import.meta.dirname, '..', '..');
}

function main() {
  const root = scriptRoot();
  const projectYaml = join(root, 'project.yaml');

  say('=== project coherence ===');

  if (!isFile(projectYaml)) {
    // The shell original cd'd to the root or exited 0 without printing anything
    // at all; saying so is the same "a check that could not run is named"
    // contract the rest of the script follows, and keeps the summary legible.
    notChecked('everything — no project.yaml at the repo root. Run /start.');
    summarise();
    return 0;
  }

  const engine = yamlBlockValue(projectYaml, 'engine', 'name');
  const version = yamlBlockValue(projectYaml, 'engine', 'version');
  const rendering = yamlBlockValue(projectYaml, 'engine', 'rendering');
  const physics = yamlBlockValue(projectYaml, 'engine', 'physics');
  const commandsTest = yamlBlockValue(projectYaml, 'commands', 'test');

  if (engine === '') {
    notChecked('every engine check — project.yaml has no engine.name. Run /setup-engine.');
    summarise();
    return 0;
  }

  const engineLc = engine.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const verfile = `docs/engine-reference/${engineLc}/VERSION.md`;
  const verfileAbs = join(root, verfile);

  // --- 1. VERSION.md carries a recorded installed-version probe ---------------
  if (!isFile(verfileAbs)) {
    notChecked(`pinned-reference checks — ${verfile} does not exist`);
  } else {
    const pinned = versionRow(verfileAbs, 'Engine Version');
    const installedRow = versionRow(verfileAbs, 'Installed at pin time');

    if (installedRow === '') {
      differ(`${verfile} has no 'Installed at pin time' row. /setup-engine is required to write one; its absence means the probe result was never recorded, not that the versions agree.`);
    } else if (installedRow.includes('NOT DETERMINED')) {
      notChecked(`pinned-vs-installed — ${verfile} records '${installedRow}'. A probe that did not run has not established a match.`);
    } else {
      match(`VERSION.md records the installed version at pin time: ${installedRow}`);
    }

    // --- 2. project.yaml version vs the pinned reference ----------------------
    // Compared on major.minor, as check 3 does: engine.version is usually the
    // full release (4.6.1, 6000.3.23f1) and the pin the series (Godot 4.6, Unity
    // 6.3 LTS). Unity numbers the same editor two ways -- 6000.3 is marketed as
    // 6.3.
    const want2 = vmm(version);
    const got2 = vmm(pinned);
    if (pinned === '') {
      notChecked(`project.yaml version vs pinned reference — no Engine Version row in ${verfile}`);
    } else if (version === '') {
      notChecked('project.yaml version vs pinned reference — project.yaml has no engine.version');
    } else if (pinned.includes(version) || (want2 !== '' && want2 === got2)) {
      match(`engine.version (${version}) agrees with ${verfile} (${pinned})`);
    } else {
      differ(`engine.version is '${version}' but ${verfile} pins '${pinned}'. Agents consult the reference file, so they will answer for a version the project does not declare.`);
    }
  }

  // --- 3. Declared version vs the binary actually installed -------------------
  let probe = '';
  if (engineLc === 'godot') {
    probe = probeGodot(commandsTest, yamlBlockValue(projectYaml, 'engine', 'path'));
  } else if (engineLc === 'unity') {
    probe = probeUnity(commandsTest, version);
  } else if (engineLc === 'unreal') {
    probe = probeUnreal();
  }

  if (probe === '') {
    if (engineLc === 'unity') {
      notChecked('declared version vs installed binary — no Unity editor at the path in commands.test or in the Hub folder for engine.version. A probe that could not run has not established absence.');
    } else if (engineLc === 'godot') {
      notChecked('declared version vs installed binary — no Godot executable found (commands.test, engine.path, PATH). A probe that could not run has not established absence.');
    } else {
      notChecked(`declared version vs installed binary — no ${engine} binary found on PATH. A probe that could not run has not established absence.`);
    }
  } else if (version === '') {
    notChecked('declared version vs installed binary — project.yaml has no engine.version');
  } else {
    // Compare on major.minor: a patch difference is normal and not worth a flag.
    const want = vmm(version);
    const got = vmm(probe);
    if (want !== '' && want === got) {
      match(`engine.version ${version} matches the installed binary (${probe})`);
    } else {
      differ(`engine.version is '${version}' but the installed binary reports '${probe}'. Build, test and smoke commands all target the declared version.`);
    }
  }

  // --- 4/5. Godot: declared rendering + physics vs the real project file ------
  if (engineLc !== 'godot') {
    notChecked(`project-file checks — implemented for Godot only; ${engine} has no single equivalent file this script can read`);
  } else if (!isFile(join(root, 'project.godot'))) {
    notChecked('project-file checks — no project.godot in this repo');
  } else {
    const method = projectGodotRenderingMethod(root);
    if (method === '') {
      notChecked('rendering — project.godot sets no renderer/rendering_method (Godot then uses its own default, which this script will not guess)');
    } else if (rendering === '') {
      notChecked('rendering — project.yaml has no engine.rendering');
    } else {
      let wantMethod = '';
      if (['Compatibility', 'compatibility', 'GL Compatibility'].includes(rendering)) wantMethod = 'gl_compatibility';
      else if (['Forward+', 'forward_plus', 'Forward Plus'].includes(rendering)) wantMethod = 'forward_plus';
      else if (['Mobile', 'mobile'].includes(rendering)) wantMethod = 'mobile';
      if (wantMethod === '') {
        notChecked(`rendering — engine.rendering '${rendering}' is not one this script maps to a Godot rendering_method`);
      } else if (wantMethod === method) {
        match(`engine.rendering (${rendering}) agrees with project.godot (${method})`);
      } else {
        differ(`engine.rendering is '${rendering}' (expects ${wantMethod}) but project.godot runs '${method}'. Whichever is wrong, an agent reading project.yaml will advise for the wrong renderer.`);
      }
    }

    // Jolt is Godot's default 3D physics engine; 2D is unchanged (Godot Physics
    // 2D). See docs/engine-reference/godot/modules/physics.md. Declaring Jolt on
    // a 2D project sends the implementer to tune a backend the game does not use.
    if (physics === '') {
      notChecked('physics — project.yaml has no engine.physics');
    } else if (/jolt/i.test(physics)) {
      if (has2DNodes(root)) {
        differ(`engine.physics is '${physics}', but 2D nodes were found under src/. Jolt is Godot's default 3D engine; 2D still uses Godot Physics 2D (docs/engine-reference/godot/modules/physics.md).`);
      } else {
        match(`engine.physics (${physics}) — no 2D nodes found under src/ to contradict it`);
      }
    } else {
      match(`engine.physics (${physics})`);
    }
  }

  // --- 6. Declared commands reference files that exist -----------------------
  const buildCmd = yamlBlockValue(projectYaml, 'commands', 'build');

  if (buildCmd === '' && commandsTest === '') {
    notChecked('command checks — project.yaml declares no commands.build or commands.test');
  } else {
    if (/export-(debug|release|pack)/.test(buildCmd)) {
      if (isFile(join(root, 'export_presets.cfg'))) {
        match('commands.build names an export preset and export_presets.cfg exists');
      } else {
        differ(`commands.build is '${buildCmd}' but there is no export_presets.cfg. Godot cannot resolve the preset, so this command fails the first time CI or /smoke-check runs it.`);
      }
    }

    const runner = firstRunnerPath(commandsTest);
    if (runner !== '') {
      if (isFile(join(root, runner))) {
        match(`commands.test runner exists (${runner})`);
      } else {
        const hint = runner.startsWith('addons/gdUnit4/')
          ? ' gdUnit4 is not installed at addons/gdUnit4/ (capital U) — see /test-setup.'
          : '';
        differ(`commands.test is '${commandsTest}' but '${runner}' does not exist, so this command cannot run as written.${hint}`);
      }
    }
  }

  summarise();
  return 0;
}

process.exitCode = main();
