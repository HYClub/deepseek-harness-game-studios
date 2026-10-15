#!/usr/bin/env node
/**
 * migrate-v1-config.mjs — convert a v1.0 DSGS project to v1.1 `project.yaml`.
 *
 * DSH-native port of `.claude/scripts/migrate-v1-config.sh` (697 lines, function
 * bodies byte-for-byte referenced below). The shell original is the specification:
 * every message, exit code, guard and row of the migration report is reproduced
 * here, including the ones its comments explain at length. Where the comments say
 * "do not simplify this", the port keeps the shape they defend.
 *
 * WHY THIS IS A SCRIPT AND NOT SKILL PROSE
 *   "Migration on a real v1.0 project loses data" is the highest-severity risk in
 *   this area, so every failure mode the spec names (malformed file, enum
 *   mismatch, split-brain, custom sections) is a testable branch here.
 *
 * MODES  (same as the original)
 *   (default)   migrate: write project.yaml + production/migration-report.md
 *   --dry-run   report what would happen; write nothing
 *   --finalize  delete legacy files, but ONLY after proving their content is
 *               preserved in project.yaml
 *   --root DIR  port-only: project root to operate on (fixtures/tests). Default
 *               resolution is described at `resolveRoot()`.
 *
 * NON-DESTRUCTIVE BY DEFAULT. Migration leaves every legacy file in place, so the
 * whole operation stays reversible with `git checkout` until --finalize is run
 * deliberately. That is why --finalize is a separate invocation.
 *
 * EXIT CODES (unchanged): 0 success/no-op, 2 usage, 3 refused (split-brain /
 * missing project.yaml for --finalize), 4 refused (content not preserved).
 *
 * SUBSTITUTIONS FORCED BY THE DSH SANDBOX (reported, never silent)
 *   - The original shells out to `awk`, `sed` and `grep` for every parse. None of
 *     them exists in the DSH sandbox and Git Bash/WSL cannot start at all, so
 *     `tp_get`, `num`, `is_num`, `yaml_list`, `trim_line`, `re_quote` and
 *     `agent_name(s)` are reimplemented in JS below. Each one carries the comment
 *     from the original that says why it is written the way it is.
 *     `runtime.capture()` is unusable on Windows (it wraps the command line in the
 *     POSIX `{ cmd ; } > file` form, which cmd.exe cannot parse), so subprocesses
 *     go through `_capture.mjs`'s `runCommand()` — direct spawn with stdout/stderr
 *     redirected into a private temp file. No pipe is ever opened.
 *   - The original reads `project.yaml` with `grep -qE '^\s*key:\s*"?value"?'`.
 *     That is config reading, and PORTING.md says config reads go through
 *     `tools/yaml-helper.mjs`, so the three conflict checks call
 *     `__call get_yaml_key <file> <dotted.path>` instead. The comparison is the
 *     same "does project.yaml carry this value" test, made against the PARSED
 *     value rather than the raw line, so a trailing comment after the value no
 *     longer counts as a disagreement. That direction fails closed (refuse and
 *     ask, never delete) and is called out in the delivered report.
 *   - `.claude/` paths in messages are printed as `.dsh/`, matching every other
 *     ported script.
 *
 * Test: `node tools/tests/scripts/migrate-v1-config.test.mjs`
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../hooks/_capture.mjs';

// ---------------------------------------------------------------------------
// Paths and knobs (original lines 43-47)
// ---------------------------------------------------------------------------
const PY = 'project.yaml';
const STAGE_TXT = 'production/stage.txt';
const REVIEW_TXT = 'production/review-mode.txt';
const TP = '.claude/docs/technical-preferences.md';
const REPORT = 'production/migration-report.md';
/** The Node port's own path, as the user must type it for --finalize. */
const SELF = '.dsh/scripts/migrate-v1-config.mjs';

// ---------------------------------------------------------------------------
// Accumulators (original lines 49-52): `warn`/`manual` append a `- …` bullet.
// ---------------------------------------------------------------------------
let WARN = '';
let MANUAL = '';
const warn = (message) => { WARN += `- ${message}\n`; };
const manual = (message) => { MANUAL += `- ${message}\n`; };

/** Read a text file, or '' when it is absent/unreadable (the shell's `[ -f ]` gates). */
function readTextOr(file, root) {
  const full = join(root, file);
  if (!existsSync(full)) return '';
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return '';
  }
}

const isFile = (file, root) => existsSync(join(root, file));

// ---------------------------------------------------------------------------
// Legacy detection (original lines 56-86)
// ---------------------------------------------------------------------------

/**
 * Every key the migration hands to tp_get. A key missing from here fails safe
 * (the file reads as unconfigured) rather than resurrecting the false positive
 * the original's comment block documents: `\*\*[^*]+\*\*` matched ANY bullet,
 * including the template's prose `- **Required Tests**: …` line, so every fresh
 * clone looked like a v1.0 project.
 */
const TP_KEYS = [
  'Engine', 'Language', 'Rendering', 'Physics', 'Target Platforms', 'Primary Input',
  'Gamepad Support', 'Touch Support', 'Classes', 'Variables', 'Constants',
  'Signals(/Events)?', 'Files', 'Scenes(/Prefabs)?', 'Target Framerate', 'Frame Budget',
  'Draw Calls', 'Memory Ceiling', 'Framework', 'Minimum Coverage',
  'Additional Specialists', 'Language/Code Specialist', 'Shader Specialist', 'UI Specialist',
];

/**
 * `grep -qE "^[[:space:]]*-[[:space:]]+\*\*(…)\*\*:[[:space:]]*[^[:space:]\[]"`.
 * A value under a key nothing reads is not data this migration would carry over,
 * so it cannot be evidence that a migration is needed.
 */
function tpConfigured(root) {
  const text = readTextOr(TP, root);
  if (text === '') return false;
  const names = TP_KEYS.join('|');
  const re = new RegExp(`^[ \\t]*-[ \\t]+\\*\\*(${names})\\*\\*:[ \\t]*[^ \\t\\[]`, 'm');
  return re.test(text);
}

/** `legacy_present()`: any of the three legacy sources, TP only when configured. */
function legacyPresent(root) {
  return isFile(STAGE_TXT, root) || isFile(REVIEW_TXT, root) || tpConfigured(root);
}

// ---------------------------------------------------------------------------
// technical-preferences.md parsing (original lines 88-146)
// ---------------------------------------------------------------------------

/**
 * `tp_get <section> <key>` -> value, or '' when absent/unconfigured.
 *
 * JOINS WRAPPED CONTINUATION LINES. Reading only the first physical line
 * truncated values mid-sentence — a framerate budget migrated as
 * "...Pro-tier target.** *(Changed", cut exactly where the author had wrapped.
 * A continuation is indented and is not itself a new `- **Key**:` bullet.
 *
 * The section match is a SUBSTRING, as `index($0, "## " sec) == 1` in the awk
 * original; section headers may only be recognised at column 1.
 */
function tpGet(section, key, root) {
  const text = readTextOr(TP, root);
  if (text === '') return '';
  const lines = text.split('\n');
  const keyRe = new RegExp(`^- \\*\\*${key}\\*\\*:[ \\t]*`);
  let inside = false;
  let grab = false;
  let val = '';
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(`## ${section}`)) { inside = true; continue; }
    if (inside && line.startsWith('## ')) inside = false;
    if (inside && grab) {
      if (/^[ \t]+[^ \t]/.test(line) && !/^[ \t]*-[ \t]+\*\*/.test(line)) {
        val += ` ${line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')}`;
        continue;
      }
      return cleanup(val); // `print val; grab = 0; exit`
    }
    if (inside) {
      if (keyRe.test(line)) {
        val = line.replace(keyRe, '').replace(/[ \t]+$/, '');
        grab = true;
      }
    }
  }
  return grab ? cleanup(val) : '';
}

/** The `sed 's/^\[TO BE CONFIGURED.*$//'` the awk pipeline ends with. */
function cleanup(value) {
  return value.replace(/^\[TO BE CONFIGURED.*$/, '');
}

/**
 * Strip a trailing unit so "16.67ms" and "1024MB" become numbers. Non-numeric
 * input is returned untouched, which is what surfaces a forked file's prose.
 */
const num = (value) => String(value).replace(/[ \t]*(ms|MB|mb|fps|FPS|%)[ \t]*$/, '');

/** `grep -qE '^[0-9]+(\.[0-9]+)?$'` — anchored, and an empty string never matches. */
const isNum = (value) => /^[0-9]+(\.[0-9]+)?$/.test(String(value));

/**
 * Escapes before quoting. These values are hand-written markdown prose, so a
 * double quote inside one is ordinary — and wrapping it unescaped emitted
 * `key: "He said "hi""`, which is not valid YAML and takes the whole file down.
 * Backslashes first, or the quote's escape gets re-escaped.
 */
function yamlStr(value) {
  if (value === '') return 'null';
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `yaml_num`: anything that is not a bare number is written as `null`. */
const yamlNum = (value) => (value === '' || !isNum(value) ? 'null' : value);

// ---------------------------------------------------------------------------
// Shared legacy-file reader (original lines 148-169)
// ---------------------------------------------------------------------------

/**
 * Trim CR and leading/trailing whitespace from the first line, but NEVER interior
 * spaces: two valid v1.1 stages contain one (`Systems Design`, `Technical
 * Setup`). BOTH the migrate step and the finalize verifier must use this — they
 * read the same legacy files and compare the results, so any divergence in
 * trimming desynchronises them.
 */
function trimLine(file, root) {
  const text = readTextOr(file, root);
  if (text === '') return '';
  const first = text.split('\n')[0].replace(/\r/g, '');
  return first.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * `re_quote` is not needed here: the original needed it only because a legacy
 * value was spliced into a `grep -E` pattern. The port compares parsed values,
 * so a forked value like `Alpha (draft)` cannot be read as a regex group.
 */

/**
 * --- preflight: is a legacy file a MIRROR or a rival source? (original 195-213)
 *
 * A legacy file whose value project.yaml ALREADY carries is a MIRROR, not a
 * rival source of truth. `/start` writes production/stage.txt on every NEW v1.1
 * project deliberately, as a mirror for hooks that have not migrated, so
 * collapsing the three states made every onboarded project answer
 * "REFUSED: … Resolve which is authoritative" with nothing to resolve.
 *
 * Config reads go through `tools/yaml-helper.mjs` (PORTING.md), whose
 * `__call get_yaml_key <file> <dotted.path>` returns the parsed scalar or ''.
 * The DOTTED PATH MATTERS: `get_yaml_key` walks a key path, so `stage` alone
 * finds nothing where the original's `grep '^[[:space:]]*stage:'` would have
 * matched the nested line. Every key this migration writes at a fixed place
 * (`project.stage`, `modes.review_mode`, `engine.name`) is therefore read back
 * at that place.
 */
function yamlKey(root, file, dotted) {
  const helper = join(root, 'tools', 'yaml-helper.mjs');
  if (!existsSync(helper)) {
    // The bash original would have read the file with grep and found nothing.
    // Silence would be a silently weakened check, so say the check did not run.
    process.stderr.write(
      `migrate-v1-config: tools/yaml-helper.mjs not found in ${root} — `
      + `${dotted} NOT compared against ${file}; treating it as absent.\n`,
    );
    return '';
  }
  const result = runCommand(process.execPath, ['tools/yaml-helper.mjs', '__call', 'get_yaml_key', file, dotted], {
    cwd: root,
    timeoutMs: 15_000,
  });
  return result.status === 0 ? result.stdout : '';
}

/**
 * `legacy_conflict()` — a legacy value project.yaml does not carry is a genuine
 * second source; one it does carry is a mirror and needs no resolution. Only
 * reachable when project.yaml exists, so a real v1.0 project — which has none —
 * takes exactly the path it did before.
 */
/**
 * v1.0 used `none` for "no director reviews"; v1.1 renamed that tier to `solo`.
 * Map it transparently rather than writing `none`, which v1.1's enum rejects —
 * that would silently resolve to `lean`, the OPPOSITE of the user's intent. This
 * is a documented rename, not a forked value, so it is coerced-and-flagged
 * rather than preserved-raw.
 *
 * Applied at READ time (the original applies it later, in its parse step) so the
 * preflight's three-state check and the parse step agree on the value: a
 * migrated project's `review_mode: solo` must compare equal to a legacy `none`,
 * or the second run reports a split brain that does not exist.
 */
const normalizeReview = (value) => (value === 'none' ? 'solo' : value);

function legacyConflict(root) {
  if (isFile(STAGE_TXT, root)) {
    const value = trimLine(STAGE_TXT, root);
    if (value !== '' && yamlKey(root, PY, 'project.stage') !== value) return true;
  }
  if (isFile(REVIEW_TXT, root)) {
    const value = normalizeReview(trimLine(REVIEW_TXT, root));
    if (value !== '' && yamlKey(root, PY, 'modes.review_mode') !== value) return true;
  }
  if (tpConfigured(root)) {
    const value = (tpGet('Engine & Language', 'Engine', root).split(/\s+/)[0] ?? '');
    if (value !== '' && yamlKey(root, PY, 'engine.name') !== value) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Preflight (original lines 215-252)
// ---------------------------------------------------------------------------

/**
 * stdout messages + exit code, exactly as the original prints them.
 *
 * Never reached with `--finalize`: `main` handles that mode before this runs, the
 * way the original wraps this whole preflight in `if [ "$MODE" != "finalize" ]`.
 * The guard below states that contract rather than returning a real verdict.
 */
function preflight(mode, root) {
  if (mode === 'finalize') return -1;

  if (isFile(PY, root) && legacyPresent(root)) {
    // THREE states share this shape and only two are problems.
    if (legacyConflict(root)) {
      // Values differ: a real second source of truth, and no way to know which
      // the user edited last.
      process.stdout.write(`REFUSED: both ${PY} and legacy files exist, and their values DISAGREE.\n`);
      process.stdout.write('  Resolve which is authoritative before migrating.\n');
      process.stdout.write(`  If you already migrated, the next step is: node ${SELF} --finalize\n`);
      return 3;
    }
    if (isFile(REPORT, root)) {
      // Values agree AND a migration ran here — the report is written by this
      // script and by nothing else. The legacy files are post-migration
      // leftovers, so --finalize is the next step and a second `migrate` is not.
      process.stdout.write(`REFUSED: both ${PY} and legacy files exist.\n`);
      process.stdout.write('  Resolve which is authoritative before migrating.\n');
      process.stdout.write(`  If you already migrated, the next step is: node ${SELF} --finalize\n`);
      return 3;
    }
    // Values agree and no migration ever ran here. These are v1.1 mirrors —
    // /start writes production/stage.txt on every new project by design.
    // Nothing to resolve, and --finalize would DELETE a file /start meant to
    // create.
    process.stdout.write(`Nothing to do: ${PY} exists and the legacy files mirror it (values agree).\n`);
    return 0;
  }
  if (isFile(PY, root)) {
    process.stdout.write(`Nothing to do: ${PY} exists and no legacy config was found.\n`);
    return 0;
  }
  if (!legacyPresent(root)) {
    process.stdout.write('Nothing to do: no legacy config files found (not a v1.0 project).\n');
    return 0;
  }
  return -1; // "run the migration"
}

// ---------------------------------------------------------------------------
// Finalize (original lines 254-288)
// ---------------------------------------------------------------------------

function finalize(root) {
  if (!isFile(PY, root)) {
    process.stdout.write(`REFUSED: ${PY} does not exist. Run migration first.\n`);
    return 3;
  }
  const failed = [];
  // Verify preservation before deleting anything. A legacy file is only removed
  // once its value is demonstrably present in project.yaml.
  if (isFile(STAGE_TXT, root)) {
    const want = trimLine(STAGE_TXT, root);
    if (yamlKey(root, PY, 'project.stage') !== want) failed.push(STAGE_TXT);
  }
  if (isFile(REVIEW_TXT, root)) {
    // Mirror the migrate step's v1.0 `none` -> v1.1 `solo` rename, or this check
    // would look for `review_mode: none` (never written) and refuse to finalize.
    const want = normalizeReview(trimLine(REVIEW_TXT, root));
    if (yamlKey(root, PY, 'modes.review_mode') !== want) failed.push(REVIEW_TXT);
  }
  if (tpConfigured(root)) {
    const want = (tpGet('Engine & Language', 'Engine', root).split(/\s+/)[0] ?? '');
    if (want !== '' && yamlKey(root, PY, 'engine.name') !== want) failed.push(TP);
  }
  if (failed.length > 0) {
    process.stdout.write(`REFUSED: content not preserved in ${PY} for:${failed.map((f) => ` ${f}`).join('')}\n`);
    process.stdout.write(`  Nothing was deleted. Re-run migration or fix ${PY} by hand.\n`);
    return 4;
  }
  for (const file of [STAGE_TXT, REVIEW_TXT]) {
    if (!isFile(file, root)) continue;
    try {
      // `rm -f file && echo "deleted file"`: the delete happens first, and the
      // announcement follows only on success.
      unlinkSync(join(root, file));
      process.stdout.write(`deleted ${file}\n`);
    } catch { /* leave it in place rather than abort finalize halfway */ }
  }
  process.stdout.write(`NOTE: ${TP} is NOT deleted — it still holds Forbidden Patterns and\n`);
  process.stdout.write('      Allowed Libraries, which have no project.yaml equivalent.\n');
  process.stdout.write('finalize complete.\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Parse (original lines 290-449)
// ---------------------------------------------------------------------------

/** The enum check, spelled out so the raw value is preserved on a fork. */
const STAGES = ['', 'Concept', 'Systems Design', 'Technical Setup', 'Pre-Production', 'Production', 'Polish', 'Release'];
const REVIEW_MODES = ['', 'full', 'lean', 'solo'];

/**
 * `agent_name <prose>` -> first token that looks like an agent name, else the
 * trimmed input unchanged (a value this cannot parse is surfaced, not dropped).
 */
function agentName(value) {
  const m = /[a-z][a-z0-9]*(-[a-z0-9]+)+/.exec(value);
  if (m !== null) return m[0];
  return value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * Split on top-level commas ONLY — a comma inside parentheses stays part of its
 * element (`ue-gas-specialist (abilities, effects)` is ONE specialist).
 */
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { if (depth > 0) depth -= 1; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** `agent_names <prose list>` -> comma-separated agent names, one per element. */
function agentNames(value) {
  if (value === '') return '';
  return splitTopLevel(value)
    .map((element) => agentName(element).trim())
    .filter((name) => name !== '')
    .join(', ');
}

// ---------------------------------------------------------------------------
// Migration entry point
// ---------------------------------------------------------------------------

/**
 * Run one migration invocation.
 * @param {string[]} argv command-line arguments (without `node <script>`)
 * @returns {number} the exit code
 */
export function main(argv) {
  let mode = 'migrate';
  let root = null;
  const args = argv.slice();
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--finalize') mode = 'finalize';
    else if (arg === '--root') {
      root = args.shift() ?? '';
      if (root === '') {
        process.stderr.write(`usage: node ${SELF} [--dry-run|--finalize] [--root DIR]\n`);
        return 2;
      }
    } else {
      process.stderr.write(`usage: node ${SELF} [--dry-run|--finalize] [--root DIR]\n`);
      return 2;
    }
  }
  root = resolveRoot(root);

  // `--finalize` skips the preflight entirely (as the original's
  // `if [ "$MODE" != "finalize" ]` guard does) and goes straight to the
  // preservation verifier. preflight() answers 0 for finalize mode, so it must
  // be tested AFTER this branch, never before.
  if (mode === 'finalize') return finalize(root);

  const pre = preflight(mode, root);
  if (pre === 0) return 0;
  if (pre === 3) return 3;

  // --- parse -----------------------------------------------------------------

  let stage = '';
  // `rawReview` is the legacy file's own text; `review` is what gets written.
  // They differ only for the v1.0 `none` -> v1.1 `solo` rename, and the two
  // warnings below quote the RAW value the user's file actually holds: the
  // original reads the raw value and applies the rename two statements later, so
  // its messages name `none` while its output carries `solo`.
  let rawReview = '';
  let review = '';
  if (isFile(STAGE_TXT, root)) {
    stage = trimLine(STAGE_TXT, root);
    if (stage === '') warn(`${STAGE_TXT} is empty — project.stage left unset`);
  }
  if (isFile(REVIEW_TXT, root)) {
    rawReview = trimLine(REVIEW_TXT, root);
    review = normalizeReview(rawReview);
    if (rawReview === '') warn(`${REVIEW_TXT} is empty — modes.review_mode left unset, so modes.rigor supplies it`);
    // The consequential direction, which went unreported until it was measured.
    // An explicit modes.review_mode OUTRANKS the modes.rigor expansion.
    if (rawReview !== '') {
      warn(`${REVIEW_TXT} is '${rawReview}' — modes.review_mode is now set EXPLICITLY, which outranks the modes.rigor `
        + 'expansion. Setting modes.rigor later will NOT change review depth on this project. To let rigor drive it, '
        + 'delete the modes.review_mode line from project.yaml after migrating.');
    }
  }

  // Enum checks. A fork may hold values v1.1 does not know; the spec says
  // preserve them raw and flag, never silently coerce.
  if (!STAGES.includes(stage)) {
    warn(`project.stage \`${stage}\` is not a v1.1 stage — preserved raw, resolve by hand`);
    manual(`Confirm \`project.stage: ${stage}\` is intended`);
  }
  // The one documented value rename, applied by normalizeReview at read time and
  // reported here.
  if (rawReview === 'none') {
    warn('modes.review_mode `none` (v1.0 "no reviews") migrated to v1.1 `solo` — the renamed "no reviews" tier');
  }
  if (!REVIEW_MODES.includes(review)) {
    warn(`modes.review_mode \`${review}\` is not a v1.1 value — preserved raw, resolve by hand`);
    manual(`Confirm \`modes.review_mode: ${review}\` is intended`);
  }
  // NO DEFAULT HERE. `production/review-mode.txt` was OPTIONAL in v1.0, so it is
  // absent for a large share of upgraders. Defaulting to `lean` wrote an explicit
  // value the user never chose, and an explicit `modes.review_mode` sits ABOVE
  // the rigor expansion in the resolution chain — so it pinned the knob
  // permanently. Leaving it unset lets `modes.rigor` supply it.

  const engineRaw = tpGet('Engine & Language', 'Engine', root);
  const engineName = engineRaw.split(/\s+/)[0] ?? '';
  const engineVer = lastTokenIsVersion(engineRaw);
  const lang = tpGet('Engine & Language', 'Language', root);
  const render = tpGet('Engine & Language', 'Rendering', root);
  const physics = tpGet('Engine & Language', 'Physics', root);

  const targets = tpGet('Input & Platform', 'Target Platforms', root);
  const primaryInput = tpGet('Input & Platform', 'Primary Input', root);
  const gamepad = tpGet('Input & Platform', 'Gamepad Support', root);
  const touch = tpGet('Input & Platform', 'Touch Support', root);

  const nClasses = tpGet('Naming Conventions', 'Classes', root);
  const nVars = tpGet('Naming Conventions', 'Variables', root);
  const nConst = tpGet('Naming Conventions', 'Constants', root);
  // The v1.0 template spells these two keys `Signals/Events` and
  // `Scenes/Prefabs`; a hand-trimmed file may carry the short form. The key is a
  // regex in the original, so both spellings are accepted.
  const nSig = tpGet('Naming Conventions', 'Signals(/Events)?', root);
  const nFiles = tpGet('Naming Conventions', 'Files', root);
  const nScenes = tpGet('Naming Conventions', 'Scenes(/Prefabs)?', root);

  const pFps = num(tpGet('Performance Budgets', 'Target Framerate', root));
  const pBudget = num(tpGet('Performance Budgets', 'Frame Budget', root));
  const pDraw = num(tpGet('Performance Budgets', 'Draw Calls', root));
  const pMem = num(tpGet('Performance Budgets', 'Memory Ceiling', root));

  // A BUDGET THAT IS PRESENT BUT NOT A BARE NUMBER MUST BE REPORTED, NOT
  // DROPPED. These four are written with yaml_num, which emits `null` for
  // anything not numeric, while the report row tested only for non-empty — so
  // prose ("30 FPS on the console floor; 60 FPS as a PC target") wrote `null` and
  // printed as PRESERVED with "Warnings: None". Real budgets routinely carry
  // per-platform splits, ranges and rationale; the converter cannot pick one and
  // MUST NOT guess which platform the user meant.
  for (const [pk, pv] of [['target_framerate', pFps], ['frame_budget_ms', pBudget],
    ['draw_call_limit', pDraw], ['memory_ceiling_mb', pMem]]) {
    if (pv !== '' && !isNum(pv)) {
      warn(`performance.${pk} not migrated: "${pv}" is not a single number`);
      manual(`Set \`performance.${pk}\` by hand — the legacy value was: ${pv}`);
    }
  }

  const testFw = tpGet('Testing', 'Framework', root);
  // "Minimum Coverage" has a v1.1 home (`qa.coverage_minimum`, integer 0-100,
  // enforced only at qa.level: full). Same rule as the budgets: a bare number
  // migrates, prose is reported and handed back, nothing is dropped in silence.
  const testCov = num(tpGet('Testing', 'Minimum Coverage', root));
  if (testCov !== '' && !isNum(testCov)) {
    warn(`qa.coverage_minimum not migrated: "${testCov}" is not a single number`);
    manual(`Set \`qa.coverage_minimum\` by hand — the legacy value was: ${testCov}`);
  }

  // v1.0 /setup-engine wrote every specialist line as `agent-name (what it
  // covers)`, and the Unreal code line as `a-specialist (Blueprint) or
  // b-specialist (C++)`. Skills pass `specialists.*` straight to the Agent tool
  // as a subagent_type, so anything but the bare agent name is an agent that
  // does not exist. Keep the first agent name per entry.
  const sCodeRaw = tpGet('Engine Specialists', 'Language/Code Specialist', root);
  const sShaderRaw = tpGet('Engine Specialists', 'Shader Specialist', root);
  const sUiRaw = tpGet('Engine Specialists', 'UI Specialist', root);
  const sAddRaw = tpGet('Engine Specialists', 'Additional Specialists', root);
  const sCode = agentName(sCodeRaw);
  const sShader = agentName(sShaderRaw);
  const sUi = agentName(sUiRaw);
  const sAdd = agentNames(sAddRaw);
  const specialistWarn = (dotKey, raw, kept) => {
    if (raw === '' || raw === kept) return;
    warn(`${dotKey} trimmed to \`${kept}\` — the legacy line was: ${raw}`);
    if (raw.includes(' or ')) {
      manual(`\`${dotKey}\` had two candidates in ${TP} ("${raw}"); kept the first — change it in project.yaml if the other is right`);
    }
  };
  specialistWarn('specialists.code', sCodeRaw, sCode);
  specialistWarn('specialists.shader', sShaderRaw, sShader);
  specialistWarn('specialists.ui', sUiRaw, sUi);
  specialistWarn('specialists.additional', sAddRaw, sAdd);

  // Sections a fork may have added. Not migrated — surfaced instead of dropped.
  if (isFile(TP, root)) {
    const known = ['Engine & Language', 'Input & Platform', 'Naming Conventions', 'Performance Budgets',
      'Testing', 'Forbidden Patterns', 'Allowed Libraries / Addons', 'Architecture Decisions Log',
      'Engine Specialists'];
    const headings = readTextOr(TP, root).split('\n')
      .filter((line) => /^## /.test(line.replace(/\r$/, '')))
      .map((line) => line.replace(/\r$/, '').replace(/^## /, ''));
    for (const heading of headings) {
      if (known.includes(heading) || heading === '') continue;
      manual(`Custom section \`## ${heading}\` in ${TP} — not migrated, integrate by hand`);
    }
  }
  if (isFile(TP, root)) {
    manual(`Forbidden Patterns and Allowed Libraries stay in ${TP} — they have no project.yaml equivalent`);
  }

  // v1.0 had no `modes.rigor`; its fixed process level matches v1.1's
  // `standard`, while v1.1 defaults `rigor` to `minimal`. This script writes
  // nothing it did not read, so a migrated project lands on `minimal` — a
  // behaviour change the upgrader never chose. Say so in the artifact they read
  // first.
  warn('modes.rigor is not written — v1.1 defaults it to `minimal`, which is lighter than v1.0 behaved '
    + '(v1.0 matched `standard`). To keep v1.0\'s process level, add `modes: { rigor: standard }` to '
    + 'project.yaml or run `/settings modes.rigor=standard`');
  manual('Decide `modes.rigor`: leave unset for the lighter v1.1 default, or pin `standard` to keep v1.0\'s process level');

  // Report the STRING keys that land in the file as `null`, which the numeric
  // family above already does and this half never did. A block is emitted when
  // ANY of its members is set, so PARTIAL configuration is what produces these,
  // and partial is the ordinary state of a v1.0 file. `get_yaml_key` returns the
  // four-character STRING "null" for such a key — not empty — so a caller
  // testing `[ -z ... ]` reads it as CONFIGURED. The value written is
  // deliberately NOT changed; what was missing is telling the user.
  // performance.* is left to its own loop above on purpose: it distinguishes
  // "held a value that would not convert" from "held nothing".
  const nullWarn = (guard, dotKey, value) => {
    if (guard === '' || value !== '') return;
    warn(`${dotKey} written as \`null\` — ${TP} had no value for it`);
    manual(`Set \`${dotKey}\` in project.yaml, or delete the key so it resolves to its default`);
  };
  nullWarn(engineName, 'engine.version', engineVer);
  nullWarn(engineName, 'engine.language', lang);
  nullWarn(engineName, 'engine.rendering', render);
  nullWarn(engineName, 'engine.physics', physics);
  const gSpec = `${sCode}${sShader}${sUi}${sAdd}`;
  nullWarn(gSpec, 'specialists.code', sCode);
  nullWarn(gSpec, 'specialists.shader', sShader);
  nullWarn(gSpec, 'specialists.ui', sUi);
  const gName = `${nClasses}${nVars}${nConst}${nSig}${nFiles}${nScenes}`;
  nullWarn(gName, 'naming.classes', nClasses);
  nullWarn(gName, 'naming.variables', nVars);
  nullWarn(gName, 'naming.constants', nConst);
  nullWarn(gName, 'naming.signals', nSig);
  nullWarn(gName, 'naming.files', nFiles);
  nullWarn(gName, 'naming.scenes', nScenes);
  const gPlat = `${targets}${primaryInput}${gamepad}${touch}`;
  nullWarn(gPlat, 'platform.primary_input', primaryInput);
  nullWarn(gPlat, 'platform.gamepad_support', gamepad);
  nullWarn(gPlat, 'platform.touch_support', touch);

  // --- helpers for list-ish values --------------------------------------------

  /**
   * `yaml_list`: "PC, Mac" -> ["PC", "Mac"]; empty -> [].
   *
   * Splits on top-level commas ONLY, and every element is quoted because prose
   * carries colons, dashes and brackets, all of which make a bare YAML scalar
   * ambiguous or invalid.
   */
  const yamlList = (value) => {
    if (value === '') return '[]';
    const out = [];
    for (const part of splitTopLevel(value)) {
      const item = part.trim();
      if (item === '') continue;
      out.push(`"${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }
    return `[${out.join(', ')}]`;
  };

  if (mode === 'dry-run') {
    process.stdout.write('DRY RUN — nothing written.\n');
    process.stdout.write(`would create: ${PY}\n`);
    process.stdout.write(`would create: ${REPORT}\n`);
    process.stdout.write('\n');
    process.stdout.write('detected sources:\n');
    if (isFile(STAGE_TXT, root)) process.stdout.write(`  ${STAGE_TXT} -> project.stage: ${stage !== '' ? stage : '<empty>'}\n`);
    if (isFile(REVIEW_TXT, root)) process.stdout.write(`  ${REVIEW_TXT} -> modes.review_mode: ${review !== '' ? review : '<empty>'}\n`);
    // State the omission explicitly. Silence here is what let the invented
    // `lean` default ship unnoticed.
    if (review === '') {
      process.stdout.write(`  (no ${REVIEW_TXT} — modes.review_mode left unset; modes.rigor will supply it)\n`);
    }
    // And the other direction, for the same reason: the preview is the one
    // artifact a cautious user reads before migrating.
    if (review !== '') {
      process.stdout.write(`  (modes.review_mode will be set EXPLICITLY to '${review}' — this outranks modes.rigor, so rigor will not control review depth afterwards)\n`);
    }
    if (tpConfigured(root)) {
      process.stdout.write(`  ${TP} -> engine/platform/naming/performance/testing/specialists\n`);
    }
    if (WARN !== '') {
      process.stdout.write('\nwarnings:\n');
      process.stdout.write(WARN);
    }
    return 0;
  }

  // --- write project.yaml (original lines 562-647) -----------------------------

  const out = [];
  out.push('# DSGS project configuration — migrated from v1.0 legacy files.');
  out.push(`# Generated by ${SELF}`);
  out.push(`# Review ${REPORT} before running --finalize.`);
  out.push('');
  out.push('schema_version: 1');
  out.push('');
  out.push('framework:');
  out.push('  version: 1.1.2');
  out.push('');
  // Emit `project:` only when there is a stage to put in it. Writing
  // `stage: null` produced a file that FAILED THIS PROJECT'S OWN SCHEMA
  // VALIDATION: `null` is not in the stage enum. An absent key resolves to
  // unset, which is what "no stage recorded yet" means.
  if (stage !== '') {
    out.push('project:');
    out.push(`  stage: "${stage}"`);
    out.push('');
  }
  // Emit the `modes:` block only when there is something to put in it. An
  // unguarded `review_mode:` wrote a bare key once the invented default was
  // removed. No legacy review mode means no `modes:` block — rigor supplies it.
  if (review !== '') {
    out.push('modes:');
    out.push(`  review_mode: ${review}`);
    out.push('');
  }
  if (engineName !== '') {
    out.push('engine:');
    out.push(`  name: ${yamlStr(engineName)}`);
    out.push(`  version: ${yamlStr(engineVer)}`);
    out.push(`  language: ${yamlStr(lang)}`);
    out.push(`  rendering: ${yamlStr(render)}`);
    out.push(`  physics: ${yamlStr(physics)}`);
    out.push('');
  }
  if (gSpec !== '') {
    out.push('specialists:');
    out.push(`  code: ${yamlStr(sCode)}`);
    out.push(`  shader: ${yamlStr(sShader)}`);
    out.push(`  ui: ${yamlStr(sUi)}`);
    out.push(`  additional: ${yamlList(sAdd)}`);
    out.push('');
  }
  if (gName !== '') {
    out.push('naming:');
    out.push(`  classes: ${yamlStr(nClasses)}`);
    out.push(`  variables: ${yamlStr(nVars)}`);
    out.push(`  constants: ${yamlStr(nConst)}`);
    out.push(`  signals: ${yamlStr(nSig)}`);
    out.push(`  files: ${yamlStr(nFiles)}`);
    out.push(`  scenes: ${yamlStr(nScenes)}`);
    out.push('');
  }
  if (`${pFps}${pBudget}${pDraw}${pMem}` !== '') {
    out.push('performance:');
    out.push(`  target_framerate: ${yamlNum(pFps)}`);
    out.push(`  frame_budget_ms: ${yamlNum(pBudget)}`);
    out.push(`  draw_call_limit: ${yamlNum(pDraw)}`);
    out.push(`  memory_ceiling_mb: ${yamlNum(pMem)}`);
    out.push('');
  }
  if (gPlat !== '') {
    out.push('platform:');
    out.push(`  targets: ${yamlList(targets)}`);
    out.push(`  primary_input: ${yamlStr(primaryInput)}`);
    out.push(`  gamepad_support: ${yamlStr(gamepad)}`);
    out.push(`  touch_support: ${yamlStr(touch)}`);
    out.push('');
  }
  if (testFw !== '') {
    out.push('testing:');
    out.push(`  framework: ${yamlStr(testFw)}`);
    out.push('');
  }
  if (isNum(testCov)) {
    out.push('qa:');
    out.push(`  coverage_minimum: ${testCov}`);
    out.push('');
  }
  writeFileSync(join(root, PY), `${out.join('\n')}\n`, 'utf8');

  // --- write the report (original lines 649-732) -------------------------------

  mkdirSync(join(root, 'production'), { recursive: true });
  const report = [];
  const row = (key, value, source) => { report.push(`| \`${key}\` | ${value} | ${source} |`); };
  report.push('# Migration report — v1.0 to v1.1');
  report.push('');
  report.push(`Generated by \`${SELF}\`.`);
  report.push('Legacy files were **not** deleted. Read this report, then run');
  report.push(`\`node ${SELF} --finalize\` when satisfied.`);
  report.push('');
  report.push('## Source files detected');
  report.push('');
  if (isFile(STAGE_TXT, root)) report.push(`- \`${STAGE_TXT}\``);
  if (isFile(REVIEW_TXT, root)) report.push(`- \`${REVIEW_TXT}\``);
  if (tpConfigured(root)) report.push(`- \`${TP}\``);
  report.push('');
  report.push('## Values preserved');
  report.push('');
  report.push('| Setting | Value | From |');
  report.push('|---|---|---|');
  if (stage !== '') row('project.stage', stage, STAGE_TXT);
  if (review !== '') row('modes.review_mode', review, REVIEW_TXT);
  if (engineName !== '') row('engine.name', engineName, TP);
  if (engineVer !== '') row('engine.version', engineVer, TP);
  if (lang !== '') row('engine.language', lang, TP);
  if (testFw !== '') row('testing.framework', testFw, TP);
  if (isNum(testCov)) row('qa.coverage_minimum', testCov, TP);
  if (sCode !== '') row('specialists.code', sCode, TP);
  // Every migrated value gets a row. This table is titled "Values preserved" and
  // is what the user reviews before --finalize deletes anything -- listing 6 of
  // the 29 keys actually written meant someone checking "did my naming
  // conventions survive?" found nothing and could reasonably conclude they had
  // not. Understating what was preserved is the same defect as overstating it.
  if (render !== '') row('engine.rendering', render, TP);
  if (physics !== '') row('engine.physics', physics, TP);
  if (sShader !== '') row('specialists.shader', sShader, TP);
  if (sUi !== '') row('specialists.ui', sUi, TP);
  if (sAdd !== '') row('specialists.additional', sAdd, TP);
  if (nClasses !== '') row('naming.classes', nClasses, TP);
  if (nVars !== '') row('naming.variables', nVars, TP);
  if (nConst !== '') row('naming.constants', nConst, TP);
  if (nSig !== '') row('naming.signals', nSig, TP);
  if (nFiles !== '') row('naming.files', nFiles, TP);
  if (nScenes !== '') row('naming.scenes', nScenes, TP);
  if (targets !== '') row('platform.targets', targets, TP);
  if (primaryInput !== '') row('platform.primary_input', primaryInput, TP);
  if (gamepad !== '') row('platform.gamepad_support', gamepad, TP);
  if (touch !== '') row('platform.touch_support', touch, TP);
  // Report what was WRITTEN, not what was extracted: is_num is the same test
  // yaml_num applies.
  if (isNum(pFps)) row('performance.target_framerate', pFps, TP);
  if (isNum(pBudget)) row('performance.frame_budget_ms', pBudget, TP);
  if (isNum(pDraw)) row('performance.draw_call_limit', pDraw, TP);
  if (isNum(pMem)) row('performance.memory_ceiling_mb', pMem, TP);
  report.push('');
  report.push('## Defaults applied');
  report.push('');
  report.push('Settings new in v1.1 are absent from legacy files and are NOT written.');
  report.push('They resolve to their documented defaults at read time');
  report.push('(`.dsh/docs/config-resolution.md`): `modes.rigor`, `modes.workflow`,');
  report.push('`modes.automation`, `docs.density`, `qa.level`, `team.size`,');
  report.push('`modes.story_granularity`, `testing.strict`.');
  report.push('');
  report.push('Run `/settings` to see the effective values, or `/start` to be asked.');
  report.push('');
  // `modes.review_mode` is NOT new in v1.1, so the paragraph above does not cover
  // it. Call the omission out by name: listing an invented `lean` sourced to a
  // file that does not exist is worse than saying nothing.
  if (review === '') {
    report.push('`modes.review_mode` is **deliberately not written**: no');
    report.push(`\`${REVIEW_TXT}\` was found, so you never chose one. It is now supplied by`);
    report.push('`modes.rigor` — writing it here would pin it and shadow that expansion.');
    report.push('');
  }
  report.push('## Warnings');
  report.push('');
  // `printf '%s' "$WARN"` keeps the trailing newline; `echo "None."` adds one.
  report.push(WARN !== '' ? WARN : 'None.');
  report.push('');
  report.push('## Manual review');
  report.push('');
  report.push(MANUAL !== '' ? MANUAL : 'None.');
  writeFileSync(join(root, REPORT), `${report.join('\n')}\n`, 'utf8');

  process.stdout.write(`wrote ${PY}\n`);
  process.stdout.write(`wrote ${REPORT}\n`);
  if (WARN !== '') {
    process.stdout.write('\nwarnings:\n');
    process.stdout.write(WARN);
  }
  process.stdout.write('\n');
  process.stdout.write(`Legacy files left in place. Review ${REPORT}, then:\n`);
  process.stdout.write(`  node ${SELF} --finalize\n`);
  return 0;
}

/**
 * `awk '{if (NF>1 && $NF ~ /^[0-9]+(\.[0-9]+)*[A-Za-z0-9]*$/) print $NF}'`: the
 * version is the LAST token when it looks like one, and empty otherwise. A fork
 * that wrote `Godot 4.4 (stable)` therefore keeps the whole string as the name
 * and gets `version: null` reported, which is the original behaviour.
 */
function lastTokenIsVersion(raw) {
  const tokens = raw.split(/\s+/).filter((t) => t !== '');
  if (tokens.length <= 1) return '';
  const last = tokens[tokens.length - 1];
  return /^[0-9]+(\.[0-9]+)*[A-Za-z0-9]*$/.test(last) ? last : '';
}

// ---------------------------------------------------------------------------
// Root resolution — the port's answer to `REPO="$(cd "$(dirname "$0")/../.." && pwd)"`
// ---------------------------------------------------------------------------

/**
 * Project root: `--root`, else cwd when cwd holds any of the files this script
 * looks at, else the directory two levels above this script (which is what
 * `dirname $0/../..` did in the original layout). No upward search: a nested
 * project must read itself.
 *
 * The cwd probe exists because this script is normally invoked as
 * `node tools/…/migrate-v1-config.mjs` from the project root, but also lives at
 * `.dsh/scripts/` inside the project it describes. Both candidates are absolute
 * by the time they reach the file operations below.
 */
function resolveRoot(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return resolve(explicit);
  const cwd = process.cwd();
  const markers = [PY, STAGE_TXT, REVIEW_TXT, TP];
  if (markers.some((marker) => existsSync(join(cwd, marker)))) return resolve(cwd);
  const anchored = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (markers.some((marker) => existsSync(join(anchored, marker)))) return anchored;
  return resolve(cwd);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/** True when this module was started as `node <this file>` (not imported). */
function isMainModule() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}

