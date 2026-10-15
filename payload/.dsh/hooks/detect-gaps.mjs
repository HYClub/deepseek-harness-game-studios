#!/usr/bin/env node
/**
 * detect-gaps.mjs — DSH (Node) port of `.dsh/hooks/detect-gaps.sh` (342 lines).
 *
 * WHY THIS EXISTS
 *   Same reason as every ported DSGS hook: the bash original cannot start under the DSH
 *   sandbox (Git Bash cannot create its signal pipes, WSL bash is denied), and piped child
 *   stdio is denied, so all subprocess work goes through runtime.capture()'s file redirection.
 *
 * OUTPUT SHAPE
 *   The original `echo`ed a report; DSH injects context via `context(event, text)`, so the
 *   report is assembled and emitted once with hookEventName = the event received (SessionStart).
 *
 * RUNTIME.CAPTURE() IS UNUSABLE ON WINDOWS — subprocess work goes through _capture.mjs
 *   capture() wraps the command line in `{ cmd ; } > file 2>&1`, POSIX shell syntax, while
 *   spawnSync(shell:true) runs cmd.exe, so every call returns status 1 with
 *   `'{' is not recognized as an internal or external command` and the yaml-helper produced
 *   nothing. runtime.mjs is a protected file (PORTING.md §边界), so the shared runner
 *   `_capture.mjs` does the same job the contract describes — output redirected into a private
 *   temp file through a file descriptor, never a pipe — and this hook imports it. Config reads
 *   run the very same `node tools/yaml-helper.mjs resolve_config --keys …` command and parse its
 *   output with the regex runtime.resolveConfig() uses, so the label semantics are unchanged.
 *
 * CONFIG READS (two mechanisms, on purpose)
 *   - `resolve_config --keys`: `engine` (Check 0's "is an engine configured" read — the helper's
 *     `engine` label is a strict project.yaml `engine.name` read, exactly what the original
 *     called) and `workflow` (the original used `resolve_setting modes.workflow`, because
 *     `modes.workflow` is rigor-fronted and a rigor-only project has no key to read).
 *   - the helper's `__call` dispatcher for what `resolve_config --keys` cannot express:
 *     `resolve_code_root` (engine -> code dir), and `get_yaml_key project.yaml project.stage`
 *     (STRICT: the `project.stage` label runs the full resolution chain, whose enum fall-through
 *     would replace an invalid project.yaml stage with the legacy mirror and change this check's
 *     input). Still tools/yaml-helper.mjs — no YAML is parsed here.
 *   - The original's `[ -f .dsh/hooks/yaml-helper.sh ]` guards mean "no helper -> WORKFLOW
 *     stays `standard`, CODE_ROOT stays empty, STAGE stays empty". That degradation is kept, and
 *     the checks that consequently did not run are announced on stderr.
 *
 * DROPPED (upstream-runtime-only mechanisms) + reason
 *   - upstream project-dir / `$BASH_SOURCE` root discovery -> runtime.projectRoot(input);
 *     same precedence (cwd holding project.yaml or .dsh/, then the payload cwd, then this tree).
 *   - `source .dsh/hooks/yaml-helper.sh` -> tools/yaml-helper.mjs via resolveConfig/`__call`.
 *   - grep/sed/find/wc pipelines -> Node built-ins (no grep/sed/find on the DSH PATH).
 *   - `.dsh/...` paths in user-facing text and fixtures -> `.dsh/...` (generated DSH tree):
 *     `.dsh/docs/technical-preferences.md`, `.dsh/scripts/migrate-v1-config.sh`.
 *   - `set +e` (the bash "don't fail the session" switch) -> run()'s catch: an unexpected throw
 *     degrades to a stderr note with exit 0.
 *
 * DELIBERATELY PRESERVED QUIRKS (copied, not "fixed", because inventing here would change what
 * the report claims)
 *   - Check 5 is NOT gated by DOC_CHECKS, while checks 1, 3 and 4 are. Copied as written.
 *   - Check 6 matches the stages `Concept`, `concept` and `Pre-Production` exactly; a lowercase
 *     `pre-production` matches nothing. Copied as written.
 *   - Check 2 (undocumented prototypes) is not tier-gated; check 6 is.
 *   - One divergence, and it can only ADD true positives: the legacy `production/stage.txt` read
 *     strips `\r` as well as spaces. The original stripped only newlines and spaces, so a CRLF
 *     mirror on Windows never matched the stage case and check 6 silently never fired.
 *   - Directory listings are walked in sorted order (find's order is filesystem order), so the
 *     per-item lines of checks 2 and 4 are stable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './_capture.mjs';
import { normaliseInput } from './_session-state.mjs';
import { run, readInput, projectRoot, context } from './runtime.mjs';

/** Source extensions the original counted, in its order. `.lua` is NOT in this list. */
const SOURCE_EXTS = ['.gd', '.cs', '.cpp', '.c', '.h', '.hpp', '.rs', '.py', '.js', '.ts'];
/** Legacy config documents, DSH tree first (the .dsh tree is the generator's source). */
const TECH_PREFS = ['.dsh/docs/technical-preferences.md', '.dsh/docs/technical-preferences.md'];
const MIGRATE_CMD = 'bash .dsh/scripts/migrate-v1-config.sh --dry-run';

const out = [];
const w = (line = '') => out.push(line);
const notRun = [];
const announce = (text) => notRun.push(text);

// --- small fs helpers --------------------------------------------------------

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const readTextOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

const readLines = (p) => readTextOr(p).split('\n').map((l) => l.replace(/\r/g, ''));

/**
 * First tab-separated field of a helper result. `resolve_code_root` prints `<dir>\t<source>`,
 * and capture() trims the whole output — which eats the LEADING tab of the empty-dir case
 * (`\tunset` arrives as `unset`). So a missing tab means the dir field is empty, not that the
 * whole value is the directory. Reading it as the directory silently disabled checks 1, 3 and 4
 * by inventing a code root named `unset`.
 */
function firstTabField(text) {
  const line = String(text).split('\n')[0];
  return line.includes('\t') ? line.split('\t')[0].trim() : '';
}

/** `find <dir> -mindepth 1 -maxdepth 1 -type d`, names only, sorted. */
function childDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** `find <dir> -type f -name <re> | wc -l`. */
function countFiles(dir, re) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (entry.isFile() && re.test(entry.name)) count += 1;
    }
  }
  return count;
}

/** `find <dir> -type f \( -name '*.gd' -o ... \)` count, or the first hit for the early probe. */
function countSourceFiles(dir, firstOnly = false) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXTS.includes(entry.name.slice(dot).toLowerCase())) continue;
      if (firstOnly) return 1;
      count += 1;
    }
  }
  return count;
}

/** `find <dir> -type f | wc -l` (any extension) — check 4's "systems with 5+ files". */
function countAllFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}

/** `find <dir> -name <pattern> | wc -l` — matches files AND directories, does not follow links. */
function countEntriesNamed(dir, re) {
  if (!isDir(dir)) return 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (re.test(entry.name)) count += 1;
      if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
  return count;
}

/**
 * Check 0 / 0b: an `- **Engine**:` bullet that is not the `[TO BE CONFIGURED]` template.
 * grep -E '^[[:space:]]*-[[:space:]]+\*\*Engine\*\*:' plus `! grep -q 'TO BE CONFIGURED'`
 * over the whole matched set.
 */
function legacyEngineConfigured(root) {
  for (const rel of TECH_PREFS) {
    const path = join(root, rel);
    if (!isFile(path)) continue;
    const hits = readLines(path).filter((l) => /^\s*-\s+\*\*Engine\*\*:/.test(l));
    if (hits.length === 0) continue;
    if (hits.some((l) => l.includes('TO BE CONFIGURED'))) continue;
    return rel;
  }
  return '';
}

const helperFile = (root) => join(root, 'tools', 'yaml-helper.mjs');

// --- tools/yaml-helper.mjs access -------------------------------------------
// All of it runs through the shared runner (see the header): the contract's capture() cannot
// start a command on Windows at all.

function helperCall(root, args) {
  if (!existsSync(helperFile(root))) return null;
  return runCommand(process.execPath, ['tools/yaml-helper.mjs', '__call', ...args], { cwd: root });
}

/** `resolve_config --keys` -> { label: value }; null when the helper is absent. */
function configLabels(root, labels) {
  if (!existsSync(helperFile(root))) return null;
  const result = runCommand(
    process.execPath,
    ['tools/yaml-helper.mjs', 'resolve_config', '--keys', labels.join(',')],
    { cwd: root },
  );
  const parsed = {};
  for (const [label, raw] of Object.entries(parseConfigOutput(result.stdout))) {
    const m = /^([\s\S]*?)\s*\(([^()]*)\)$/.exec(raw);
    const value = (m ? m[1] : raw).trim();
    parsed[label] = value === 'not set' || value === 'unset' ? '' : value;
  }
  return parsed;
}

/** The parse runtime.resolveConfig() applies to `resolve_config --keys` output. */
function parseConfigOutput(stdout) {
  const values = {};
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*([\w.]+)\s*[:=]\s*(.*)$/.exec(line);
    if (m !== null) values[m[1]] = m[2].trim();
  }
  return values;
}

// --- the hook ----------------------------------------------------------------

run(async () => {
  // normaliseInput: readInput() hands back whatever JSON.parse produced, and a payload of
  // literal `null` would make projectRoot() throw — a hook that silently does nothing.
  const input = normaliseInput(readInput());
  const event = String(input.hook_event_name ?? 'SessionStart');
  const root = projectRoot(input);
  const hasHelper = existsSync(helperFile(root));
  const hasProjectYaml = existsSync(join(root, 'project.yaml'));

  w('=== Checking for Documentation Gaps ===');

  // --- Check 0: fresh project detection (suggests /start) ---------------------
  let fresh = true;

  // Engine configured: project.yaml first, legacy technical-preferences.md second.
  const labels = configLabels(root, ['engine']);
  const engineName = labels?.engine ?? '';
  if (engineName !== '') fresh = false;
  if (fresh && !hasHelper && hasProjectYaml) {
    announce('the engine-configured probe (engine.name in project.yaml) did not run'
      + ' (tools/yaml-helper.mjs is missing)');
  }
  if (fresh) {
    const legacy = legacyEngineConfigured(root);
    if (legacy !== '') fresh = false;
  }

  // A design record: the standard/full concept doc, or the minimal one-page brief.
  // Testing only for game-concept.md greeted a minimal-tier project with the NEW PROJECT
  // banner at every session start, about the one artifact that tier actually produces.
  if (isFile(join(root, 'design/gdd/game-concept.md')) || isFile(join(root, 'design/game-brief.md'))) {
    fresh = false;
  }

  // Any code at all, in any of the three engine code roots (src is only the Godot row).
  // Tested directly rather than through resolve_code_root: this runs before the config helper
  // is guaranteed to be reachable, and "is there any code" does not need the engine.
  for (const candidate of ['src', 'Assets', 'Source']) {
    if (!isDir(join(root, candidate))) continue;
    if (countSourceFiles(join(root, candidate), true) > 0) {
      fresh = false;
      break;
    }
  }

  // --- Check 0b: v1.0 project — legacy config present, project.yaml absent ----
  if (!hasProjectYaml) {
    const legacyFiles = [];
    if (isFile(join(root, 'production/stage.txt'))) legacyFiles.push('production/stage.txt');
    if (isFile(join(root, 'production/review-mode.txt'))) legacyFiles.push('production/review-mode.txt');
    const legacy = legacyEngineConfigured(root);
    if (legacy !== '') legacyFiles.push(legacy);
    if (legacyFiles.length > 0) {
      // Legacy config also means the project is not fresh: the NEW PROJECT banner would be wrong.
      fresh = false;
      w('');
      w(`⬆️  v1.0 PROJECT: legacy config (${legacyFiles.join(', ')}) but no project.yaml.`);
      w('   Run: /adopt — it detects this and drives the migration (non-destructive).');
      w(`   Preview first: ${MIGRATE_CMD}`);
    }
  }

  if (fresh) {
    w('');
    w('🚀 NEW PROJECT: No engine configured, no game concept, no source code.');
    w('   This looks like a fresh start! Run: /start');
    w('');
    w('💡 To get a comprehensive project analysis, run: /project-stage-detect');
    w('===================================');
    context(event, out.join('\n'));
    for (const note of notRun) process.stderr.write(`detect-gaps: NOT RUN — ${note}\n`);
    return;
  }

  // --- Resolve the workflow tier once, for the checks below -------------------
  // Checks 1, 3 and 4 ask "where is the design/architecture document for this code?". At
  // `minimal` the answer is that there deliberately is none, so reporting their absence as a
  // GAP would nag about work the project's own configuration said to skip.
  const settings = configLabels(root, ['workflow']);
  let workflow = 'standard';
  if (settings?.workflow) {
    workflow = settings.workflow;
  } else {
    announce('modes.workflow could not be resolved'
      + ` (${hasHelper ? 'yaml-helper failed' : 'tools/yaml-helper.mjs is missing'})`
      + ` — the doc checks ran as the \`${workflow}\` tier, not the project's tier`);
  }
  // Check 2 is NOT gated: an undocumented prototype is a gap about the prototype itself.
  const docChecks = workflow !== 'minimal';

  // --- Engine-specific code root for checks 1, 3 and 4 ------------------------
  // Only the ROOT is engine-specific; core/, engine/ and gameplay/ are DSGS's own layout.
  let codeRoot = '';
  const codeRootRes = helperCall(root, ['resolve_code_root']);
  if (codeRootRes !== null && codeRootRes.status === 0) {
    codeRoot = firstTabField(codeRootRes.stdout);
  } else if (codeRootRes === null && ['src', 'Assets', 'Source'].some((d) => isDir(join(root, d)))) {
    announce('the code-root lookup did not run (tools/yaml-helper.mjs is missing)'
      + ' — checks 1, 3 and 4 report as NOT CHECKED below');
  }

  // A doc check that cannot locate the code root has established nothing. Announce it, once,
  // and only when the checks would otherwise have had somewhere to look.
  if (docChecks && codeRoot === '') {
    if (isDir(join(root, 'src')) || isDir(join(root, 'Assets')) || isDir(join(root, 'Source'))) {
      w('ℹ️  NOT CHECKED: code exists but the code root is ambiguous (engine.name unset, and the tree does not name one unambiguously).');
      w('    Checks 1, 3 and 4 (design and architecture docs for existing code) did NOT run.');
      w('    Suggested action: /setup-engine, or set engine.name in project.yaml');
    }
  }

  // --- Check 1: substantial codebase but sparse design docs -------------------
  const srcFiles = codeRoot !== '' && isDir(join(root, codeRoot))
    ? countSourceFiles(join(root, codeRoot))
    : 0;
  const designFiles = isDir(join(root, 'design/gdd')) ? countFiles(join(root, 'design/gdd'), /\.md$/) : 0;

  if (docChecks && srcFiles > 50 && designFiles < 5) {
    w(`⚠️  GAP: Substantial codebase (${srcFiles} source files) but sparse design docs (${designFiles} files)`);
    w(`    Suggested action: /reverse-document design ${codeRoot !== '' ? codeRoot : '<code root>'}/[system]`);
    w('    Or run: /project-stage-detect to get full analysis');
  }

  // --- Check 2: prototypes without documentation ------------------------------
  if (isDir(join(root, 'prototypes'))) {
    const undocumented = [];
    for (const name of childDirs(join(root, 'prototypes'))) {
      const dir = join(root, 'prototypes', name);
      if (!isFile(join(dir, 'README.md')) && !isFile(join(dir, 'CONCEPT.md'))) undocumented.push(name);
    }
    if (undocumented.length > 0) {
      w(`⚠️  GAP: ${undocumented.length} undocumented prototype(s) found:`);
      for (const name of undocumented) w(`    - prototypes/${name}/ (no README or CONCEPT doc)`);
      w('    Suggested action: /reverse-document concept prototypes/[name]');
    }
  }

  // --- Check 3: core systems without architecture docs ------------------------
  if (docChecks && codeRoot !== '' && (isDir(join(root, codeRoot, 'core')) || isDir(join(root, codeRoot, 'engine')))) {
    if (!isDir(join(root, 'docs/architecture'))) {
      w('⚠️  GAP: Core engine/systems exist but no docs/architecture/ directory');
      w('    Suggested action: Create docs/architecture/ and run /architecture-decision');
    } else {
      const adrCount = countFiles(join(root, 'docs/architecture'), /\.md$/);
      if (adrCount < 3) {
        w(`⚠️  GAP: Core systems exist but only ${adrCount} ADR(s) documented`);
        w(`    Suggested action: /reverse-document architecture ${codeRoot}/core/[system]`);
      }
    }
  }

  // --- Check 4: gameplay systems without design docs --------------------------
  if (docChecks && codeRoot !== '' && isDir(join(root, codeRoot, 'gameplay'))) {
    for (const name of childDirs(join(root, codeRoot, 'gameplay'))) {
      const systemDir = join(root, codeRoot, 'gameplay', name);
      const fileCount = countAllFiles(systemDir);
      if (fileCount < 5) continue;
      // Allow variations: combat-system.md, combat.md.
      if (isFile(join(root, `design/gdd/${name}-system.md`)) || isFile(join(root, `design/gdd/${name}.md`))) continue;
      w(`⚠️  GAP: Gameplay system '${codeRoot}/gameplay/${name}/' (${fileCount} files) has no design doc`);
      w(`    Expected: design/gdd/${name}-system.md or design/gdd/${name}.md`);
      w(`    Suggested action: /reverse-document design ${codeRoot}/gameplay/${name}`);
    }
  }

  // --- Check 5: production planning -------------------------------------------
  // NOT gated by DOC_CHECKS in the original; copied as written.
  if (srcFiles > 100) {
    if (!isDir(join(root, 'production/sprints')) && !isDir(join(root, 'production/milestones'))) {
      w(`⚠️  GAP: Large codebase (${srcFiles} files) but no production planning found`);
      w('    Suggested action: /sprint-plan or create production/ directory');
    }
  }

  // --- Check 6: project.stage is behind what is actually on disk --------------
  // An OBSERVATION, never a write: only a /gate-check PASS (or a CONCERNS whose risks the user
  // accepted) advances the stage. Not at `minimal`: nothing on that path runs /gate-check, so a
  // stage that never moves is the design there, not a gap.
  let stage = '';
  if (workflow !== 'minimal') {
    const res = helperCall(root, ['get_yaml_key', 'project.yaml', 'project.stage']);
    if (res === null && hasProjectYaml) {
      announce('project.stage could not be read (tools/yaml-helper.mjs is missing)'
        + ' — check 6 fell back to production/stage.txt only');
    } else if (res !== null && res.status === 0) {
      stage = res.stdout.split('\n')[0].trim();
    }
    if (stage === '' && isFile(join(root, 'production/stage.txt'))) {
      // `head -1 production/stage.txt | tr -d '\n' | tr -d ' '` (+ \r, see the header).
      stage = readLines(join(root, 'production/stage.txt'))[0].replace(/ /g, '');
    }
  }
  if (stage !== '') {
    const storyCount = countEntriesNamed(join(root, 'production/epics'), /^story-.*\.md$/);
    if ((stage === 'Concept' || stage === 'concept' || stage === 'Pre-Production')
      && storyCount > 0 && srcFiles > 0) {
      w(`⚠️  GAP: project.stage says '${stage}', but ${storyCount} stories and ${srcFiles} source files exist`);
      w('    The stage only advances on a /gate-check PASS (or a CONCERNS whose risks you accepted),');
      w(`    and none has moved it yet -- so the status line can sit at '${stage}' indefinitely.`);
      w('    Suggested action: /gate-check  (it asks before advancing; this hook never writes the stage)');
    }
  }

  // --- Summary -----------------------------------------------------------------
  w('');
  w('💡 To get a comprehensive project analysis, run: /project-stage-detect');
  w('===================================');

  context(event, out.join('\n'));
  for (const note of notRun) process.stderr.write(`detect-gaps: NOT RUN — ${note}\n`);
});

