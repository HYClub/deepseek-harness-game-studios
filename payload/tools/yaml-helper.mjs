#!/usr/bin/env node
/**
 * yaml-helper.mjs — zero-dependency Node ESM port of `.claude/hooks/yaml-helper.sh`.
 *
 * WHY THIS EXISTS
 *   `.claude/hooks/yaml-helper.sh` is bash + an embedded Python 3 heredoc per reader.
 *   On Windows the DSH side has neither: the Python fallback chain (python -> python3 -> py)
 *   is not guaranteed, `jq` is absent, and spawning PYTHONPATH-free interpreters for every
 *   config read is exactly the cost the shell version spent paragraphs of comments avoiding.
 *   This file reproduces the shell version's semantics with `node:` builtins only.
 *
 * PARITY CONTRACT (byte-for-byte, verified by tools/yaml-helper.test.mjs)
 *   - Same subcommand surface as the shell dispatcher: only `resolve_config` is public;
 *     `get_yaml_*`, `validate_*`, `is_*`, `resolve_setting`, `resolve_code_root`,
 *     `get_legacy_key`, `get_yaml_default`, `session_state_enabled`, `log_decision` and
 *     `hook_warn` are the `source`-level API and are reachable here through the hidden
 *     `__call` subcommand (same argv, same stdout/stderr/exit code as calling the shell
 *     function directly). `__call resolve_config ...` behaves like the CLI dispatch, which is
 *     what the diff harness compares against `source <script>; resolve_config ...`.
 *   - Same output bytes: `\t` separators, same case, same spacing, same trailing newlines,
 *     same exit codes. Output goes through process.stdout.write as UTF-8 (never console.log)
 *     so the Windows console encoding (cp1252) cannot re-encode a value.
 *   - Same silent-empty behaviour: a missing file, an unreadable path, a path that resolves
 *     to a map/array, or an absent key each print nothing and exit 0.
 *   - Same parser, four copies included: the shell file carries four copies of the YAML
 *     subset parser on purpose (get_yaml_key, get_yaml_array, get_yaml_child_keys,
 *     validate_yaml_enum / validate_local_scope) and they must agree on edge cases. They are
 *     reproduced here as `parseMap`, `parseArray` and `parseChildKeys` with the same
 *     differences the original copies have. Do not "unify" them.
 *   - Same defaults table, rigor expansion table, legacy mirror table, enum table, local
 *     read/write whitelist and project-root precedence.
 *   - KNOWN REFERENCE BUGS, REPRODUCED (see comments at each site):
 *       * `resolve_config`'s `$(validate_yaml_enum ... 2>&1 >/dev/null)` captures NOTHING, so
 *         no enum complaint ever reaches `notes:`; set YAML_HELPER_ENUM_NOTES=1 for the
 *         documented-intent behaviour instead.
 *       * `resolve_config`'s `orphan=$(validate_local_yaml_base 2>&1) || notes=...` appends a
 *         bare `"; "` separator when an earlier note exists, because `$( )` captures stdout
 *         and that function only writes to stderr.
 *   - There is ONE unavoidable difference in kind: the shell file's
 *     "no python interpreter found" stderr path (and its NO PYTHON note) cannot occur here,
 *     because this port has no interpreter to be missing.
 *
 * USAGE
 *   node tools/yaml-helper.mjs resolve_config [--keys k1,k2,...] [<system>]
 *   node tools/yaml-helper.mjs resolve_config                # full block
 *   node tools/yaml-helper.mjs resolve_config --keys rigor,workflow
 *
 *   Hidden, for tests and for source-compatible ports of the .sh hooks:
 *   node tools/yaml-helper.mjs __call <function> [args...]
 *   node tools/yaml-helper.mjs __call help
 *
 * ROOT RESOLUTION: identical precedence to the shell file — cwd first (project.yaml, then
 * project.local.yaml), then CLAUDE_PROJECT_DIR when it holds a project.yaml, else cwd. The
 * CLI additionally seeds CLAUDE_PROJECT_DIR from this file's own location (`tools/` and
 * `.claude/hooks/` are both two levels below the project root) when that variable has no
 * project.yaml, which is the shell dispatcher's self-root anchor.
 *
 * Always exits 0 on the public path: a non-zero exit from an injected command aborts a
 * skill invocation (same reason the shell dispatcher ends with `exit 0`).
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Small helpers mirroring the shell builtins the original leans on.
// ---------------------------------------------------------------------------

/**
 * `.claude/hooks/yaml-helper.sh` error text for a missing interpreter — kept verbatim so a
 * test can assert on it. UNREACHABLE HERE BY DESIGN: the shell prints this when its
 * python -> python3 -> py chain fails, and this port has no interpreter to be missing, so
 * the `NO PYTHON INTERPRETER` note branch of resolve_config is also dead code.
 */
const NO_PYTHON = 'yaml-helper: no python interpreter found (tried python, python3, py)';

/**
 * Command-substitution emulation: `$(...)` strips EVERY trailing newline, keeps everything
 * else (including \r, tabs and trailing spaces). Internal newlines are preserved, which is
 * what makes `resolve_config`'s `tr '\n' ';'` notes work on both sides.
 */
function cmdSub(s) {
  return String(s).replace(/\n+$/, '');
}

/** `$(cat file)`-style read. Missing/unreadable file yields '' (shell would print an error). */
function readTextOr(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isFile(p) {
  if (!p) return false;
  try {
    return readFileSync(p) !== undefined;
  } catch {
    return false;
  }
}

/** Shell `printf '%s'`. */
function pr(s) {
  process.stdout.write(String(s));
}

/** Shell `echo`. */
function el(s = '') {
  process.stdout.write(`${s}\n`);
}

function errl(s) {
  process.stderr.write(`${s}\n`);
}

/**
 * Python's universal-newline `readlines()`: `\r\n`, a lone `\r`, and `\n` are all line ends.
 * (`file.readlines()` on a text-mode handle is what every embedded parser reads.)
 */
function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\r') {
      out.push(text.slice(start, i));
      if (text[i + 1] === '\n') i += 1;
      start = i + 1;
    } else if (ch === '\n') {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** `python3 open(file, encoding='utf-8-sig', errors='replace')` — BOM stripped, invalid -> U+FFFD. */
function readYamlLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // OSError -> sys.exit(0), silent
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return splitLines(text);
}

/** Python `lstrip(' ')`: leading SPACES only (tabs are not stripped — the parser's rule). */
function lstripSpaces(s) {
  const m = /^ */.exec(s);
  return s.slice(m[0].length);
}

// ---------------------------------------------------------------------------
// Config tables — byte-identical to the shell variables they replace.
// ---------------------------------------------------------------------------

/** `_yaml_helper_enums` */
const ENUMS = [
  'modes.review_mode::full|lean|solo',
  'modes.rigor::minimal|standard|full',
  'modes.workflow::minimal|standard|full',
  'modes.automation::collaborative|guided|autonomous',
  'modes.story_granularity::coarse|balanced|fine',
  'docs.density::terse|balanced|thorough',
  'qa.level::minimal|standard|full',
  'team.size::individual|small|studio',
  'performance.enforce::warn|block|off',
  'platform.cert_tier::none|itch|steam|console',
  'accessibility.target::none|standard|aaa',
  'engine.name::Godot|Unity|Unreal',
  'project.stage::Concept|Systems Design|Technical Setup|Pre-Production|Production|Polish|Release',
  'testing.strict.logic::true|false',
  'testing.strict.integration::true|false',
  'testing.strict.visual::true|false',
  'testing.strict.ui::true|false',
  'testing.strict.config::true|false',
  'features.session_state::on|off',
  'platform.online::true|false',
  'workflow_overrides.edge_cases::true|false',
  'workflow_overrides.tuning_knobs::true|false',
  'workflow_overrides.art_bible_strict::true|false',
].join('\n');

/** `_yaml_helper_locally_overridable` */
const LOCALLY_OVERRIDABLE = [
  'modes.review_mode',
  'modes.automation',
  'modes.automation_always_ask',
  'team.size',
  'testing.strict.logic',
  'testing.strict.integration',
  'testing.strict.visual',
  'testing.strict.ui',
  'testing.strict.config',
  'performance.enforce',
  'features.session_state',
  'features.token_budget_warn_at',
].join('\n');

/** `_yaml_helper_local_read_scope` (assigned from the whitelist in the shell file). */
const LOCAL_READ_SCOPE = LOCALLY_OVERRIDABLE;

/** `_yaml_helper_defaults` */
const DEFAULTS = [
  'modes.automation::collaborative',
  'modes.rigor::minimal',
  'performance.enforce::warn',
].join('\n');

/** `_yaml_helper_rigor_expansion` */
const RIGOR_EXPANSION = [
  'minimal::modes.workflow=minimal,docs.density=terse,qa.level=minimal,modes.story_granularity=coarse,modes.review_mode=solo,team.size=individual',
  'standard::modes.workflow=standard,docs.density=balanced,qa.level=standard,modes.story_granularity=balanced,modes.review_mode=lean,team.size=individual',
  'full::modes.workflow=full,docs.density=thorough,qa.level=full,modes.story_granularity=fine,modes.review_mode=full,team.size=studio',
].join('\n');

/** `_yaml_helper_legacy_files` */
const LEGACY_FILES = [
  'modes.review_mode::production/review-mode.txt',
  'project.stage::production/stage.txt',
].join('\n');

/** `_yaml_helper_always_ask_default` */
const ALWAYS_ASK_DEFAULT = 'scope_changes\nfile_deletions\nschema_changes';

/** Shell `while IFS= read -r line; do [ -z "$line" ] && continue; ...` over a here-string. */
function shellLines(text) {
  return String(text).split('\n').filter((line) => line !== '');
}

/** First table line whose `key::` prefix matches; returns the `value` half (or ''). */
function tableLookup(table, key) {
  if (key === '') return '';
  for (const line of shellLines(table)) {
    const idx = line.indexOf('::');
    if (idx === -1) continue;
    if (line.slice(0, idx) === key) return line.slice(idx + 2);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Project root resolution — `_yaml_helper_set_root`
//
// PRECEDENCE IS LOAD-BEARING, in this order (unchanged from the shell file):
//   1. cwd holds project.yaml         -> cwd
//   2. cwd holds project.local.yaml   -> cwd
//   3. CLAUDE_PROJECT_DIR has a base  -> that directory
//   4. nothing found                  -> cwd (unchanged behaviour)
// No upward walk: it resolves the wrong tree for a project nested inside another.
// ---------------------------------------------------------------------------
let YH_ROOT = '.';

function setRoot() {
  YH_ROOT = '.';
  if (isFile(join(YH_ROOT, 'project.yaml'))) return;
  if (isFile(join(YH_ROOT, 'project.local.yaml'))) return;
  const env = process.env.CLAUDE_PROJECT_DIR ?? '';
  if (env !== '' && isFile(join(env, 'project.yaml'))) {
    YH_ROOT = env;
  }
}

/** Directory listing used by the `src|Assets|Source` detection in resolve_code_root. */
function listDirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// YAML subset parsers
//
// Grammar (identical to the shell file's embedded copies):
//   - nested maps by indentation; leading SPACES are indent, a TAB is not
//   - `key: value` scalar leaves, `key:` opens a child map
//   - a leading '"' or "'" quotes the scalar; the closing quote ends the value and any
//     trailing comment after it is ignored
//   - an unquoted scalar is truncated at the first ' #' (a '#' NOT preceded by a space is data)
//   - arrays: inline `[a, b, c]` (parseValue, quote-aware) and block `- item` (parseChildKeys)
//   - full-line comments and blank lines are skipped
// The 'key regex' is `([^:#\s][^:]*?)\s*:\s*(.*)$` — kept as a real regex so the four copies
// keep the quirk that a leading ':' or space in a key makes the line invisible.
// ---------------------------------------------------------------------------

const KEY_RE = /^([^:#\s][^:]*?)\s*:\s*(.*)$/;

/** Strip the trailing-comment / surrounding-quote rules that apply to a scalar. */
function scalarOf(value) {
  if (value.startsWith('#')) return '';
  const q = value.slice(0, 1);
  if (q === '"' || q === "'") {
    const end = value.indexOf(q, 1);
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }
  const hashPos = value.indexOf(' #');
  return hashPos >= 0 ? value.slice(0, hashPos).trim() : value;
}

/** Length of the leading run of spaces (indent as the parser counts it). */
function indentOf(line) {
  const m = /^ */.exec(line);
  return m[0].length;
}

/** The three parser copies that ignore arrays (get_yaml_key, validate_local_scope, ...). */
function parseMap(lines) {
  const root = {};
  const stack = [[-1, root]];
  for (const raw of lines) {
    const line = raw.replace(/\r+$/, '');
    const stripped = lstripSpaces(line);
    if (!stripped.trim() || stripped.replace(/^\s+/, '').startsWith('#')) continue;
    const indent = indentOf(line);
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    if (!stack.length) return root;
    const parent = stack[stack.length - 1][1];
    const m = KEY_RE.exec(stripped);
    if (!m) continue;
    const key = m[1].trim();
    const value = scalarOf(m[2].trim());
    if (value === '') {
      const next = {};
      parent[key] = next;
      stack.push([indent, next]);
    } else {
      parent[key] = value;
    }
  }
  return root;
}

/** Quote-aware inline-array scan of a value starting with `[`. */
function inlineArray(value) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (let idx = 1; idx < value.length; idx += 1) {
    const ch = value[idx];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ']') {
      break;
    } else if (ch === ',') {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter((p) => p !== '');
}

/** The array-aware copies (get_yaml_array, and the block-dash peek). */
function parseArray(lines) {
  const root = {};
  const stack = [[-1, root]];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\r+$/, '');
    const stripped = lstripSpaces(line);
    if (!stripped.trim() || stripped.replace(/^\s+/, '').startsWith('#')) {
      i += 1;
      continue;
    }
    const indent = indentOf(line);
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    if (!stack.length) return root;
    const parent = stack[stack.length - 1][1];
    const m = KEY_RE.exec(stripped);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1].trim();
    let value = m[2].trim();
    if (value.startsWith('#')) {
      value = '';
    } else if (value.slice(0, 1) === '[') {
      parent[key] = inlineArray(value);
      i += 1;
      continue;
    } else {
      value = scalarOf(value);
    }
    if (value === '') {
      // Peek: block-dash list or sub-map?
      let j = i + 1;
      const items = [];
      while (j < lines.length) {
        const pl = lines[j].replace(/\r+$/, '');
        const pstripped = lstripSpaces(pl);
        if (!pstripped.trim() || pstripped.replace(/^\s+/, '').startsWith('#')) {
          j += 1;
          continue;
        }
        const pindent = indentOf(pl);
        if (pindent <= indent) break;
        if (pstripped.startsWith('- ')) {
          // INDENT IS NOT ENFORCED between items, deliberately: one misindented entry used to
          // end the list silently and drop the configured always-ask categories.
          let item = pstripped.slice(2).trim();
          const q0 = item.slice(0, 1);
          const q1 = item.slice(-1);
          if ((q0 === '"' || q0 === "'") && q1 === q0 && item.length >= 2) {
            item = item.slice(1, -1);
          } else {
            const hashPos = item.indexOf(' #');
            if (hashPos >= 0) item = item.slice(0, hashPos).trim();
          }
          items.push(item);
          j += 1;
          continue;
        }
        break;
      }
      if (items.length) {
        parent[key] = items;
        i = j;
        continue;
      }
      const next = {};
      parent[key] = next;
      stack.push([indent, next]);
    } else {
      parent[key] = value;
    }
    i += 1;
  }
  return root;
}

/** Map-only parse that reports the last matched key's value so `get_yaml_child_keys` can walk. */
function parseChildKeys(lines) {
  const root = {};
  const stack = [[-1, root]];
  for (const raw of lines) {
    const line = raw.replace(/\r+$/, '');
    const stripped = lstripSpaces(line);
    if (!stripped.trim() || stripped.replace(/^\s+/, '').startsWith('#')) continue;
    const indent = indentOf(line);
    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    if (!stack.length) return root;
    const parent = stack[stack.length - 1][1];
    const m = KEY_RE.exec(stripped);
    if (!m) continue;
    const key = m[1].trim();
    const value = scalarOf(m[2].trim());
    if (value === '') {
      const next = {};
      parent[key] = next;
      stack.push([indent, next]);
    } else {
      parent[key] = value;
    }
  }
  return root;
}

/** Walk a dotted path; returns `undefined` when any hop is absent (Python: `sys.exit(0)`). */
function walkDotted(data, dotted) {
  let cur = data;
  for (const k of String(dotted).split('.')) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, k)) {
      cur = cur[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** get_yaml_key <file> <dotted.path> — scalar or nothing. Never fails. */
function getYamlKey(file, dotted) {
  if (!file || !dotted) return '';
  const lines = readYamlLines(file);
  if (lines === null) return '';
  const cur = walkDotted(parseMap(lines), dotted);
  if (cur === undefined || cur === null || typeof cur === 'object') return '';
  return String(cur);
}

/** get_yaml_array <file> <dotted.path> — items one per line (trailing newline included). */
function getYamlArray(file, dotted) {
  if (!file || !dotted) return '';
  const lines = readYamlLines(file);
  if (lines === null) return '';
  const cur = walkDotted(parseArray(lines), dotted);
  if (!Array.isArray(cur)) return '';
  return cur.map((item) => `${String(item)}\n`).join('');
}

/** get_yaml_child_keys <file> <dotted.path> — child key names joined by \n, NO trailing newline. */
function getYamlChildKeys(file, dotted) {
  if (!file || !dotted) return '';
  const lines = readYamlLines(file);
  if (lines === null) return '';
  const cur = walkDotted(parseChildKeys(lines), dotted);
  if (cur === undefined || cur === null || typeof cur !== 'object' || Array.isArray(cur)) return '';
  return Object.keys(cur).join('\n');
}

function getEffectiveYamlKey(dotted) {
  setRoot();
  if (!dotted) return '';
  let val = '';
  if (isFile(join(YH_ROOT, 'project.local.yaml'))) {
    val = cmdSub(getYamlKey(join(YH_ROOT, 'project.local.yaml'), dotted));
  }
  if (val === '' && isFile(join(YH_ROOT, 'project.yaml'))) {
    val = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), dotted));
  }
  return val;
}

function getEffectiveYamlArray(dotted) {
  setRoot();
  if (!dotted) return '';
  let val = '';
  if (isFile(join(YH_ROOT, 'project.local.yaml'))) {
    val = cmdSub(getYamlArray(join(YH_ROOT, 'project.local.yaml'), dotted));
  }
  if (val === '' && isFile(join(YH_ROOT, 'project.yaml'))) {
    val = cmdSub(getYamlArray(join(YH_ROOT, 'project.yaml'), dotted));
  }
  return val;
}

function getYamlDefault(path) {
  if (!path) return '';
  return tableLookup(DEFAULTS, path);
}

// ---------------------------------------------------------------------------
// Enums, whitelist, local-scope checks
// ---------------------------------------------------------------------------

function isLocallyOverridable(path) {
  if (!path) return false;
  return shellLines(LOCALLY_OVERRIDABLE).includes(path);
}

function inLocalReadScope(path) {
  if (!path) return false;
  return shellLines(LOCAL_READ_SCOPE).includes(path);
}

/** validate_enum_value <dotted.path> <value> — 0 when unconstrained or in the enum set. */
function validateEnumValue(key, value) {
  if (!key) return 0;
  for (const line of shellLines(ENUMS)) {
    const idx = line.indexOf('::');
    const enumPath = line.slice(0, idx);
    const enumValues = line.slice(idx + 2);
    if (key === enumPath) {
      if (enumValues.split('|').includes(String(value))) return 0;
      errl(`Invalid value '${value}' for '${key}'. Allowed: ${enumValues}`);
      return 1;
    }
  }
  return 0;
}

/**
 * validate_yaml_enum <file>
 *   Tab-indented lines are reported as an error (YAML forbids tabs for indentation, and the
 *   parser cannot see those lines at all, so an invalid value inside one would go unnoticed).
 *   Then every enum key present in the file is checked. Exit 1 if anything was reported.
 */
function validateYamlEnum(file) {
  if (!file || !isFile(file)) return 0;
  const lines = readYamlLines(file);
  if (lines === null) return 0;
  const data = parseMap(lines);

  const tabLines = [];
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\r+$/, '');
    if (!line.trim() || line.replace(/^[ \t]+/, '').startsWith('#')) return;
    const lead = line.slice(0, line.length - line.replace(/^[ \t]+/, '').length);
    if (lead.includes('\t')) tabLines.push(idx + 1);
  });

  const lookup = (dotted) => {
    const cur = walkDotted(data, dotted);
    if (cur === undefined || typeof cur === 'object') return '';
    return String(cur);
  };

  let errors = 0;
  const out = [];
  if (tabLines.length) {
    const shownList = tabLines.slice(0, 5).join(', ');
    const shown = tabLines.length > 5 ? `${shownList} (and ${tabLines.length - 5} more)` : shownList;
    out.push(`line ${shown}: indented with a TAB. YAML forbids tabs for indentation, `
      + 'so these lines are invisible to the config parser and their '
      + 'settings silently fall back to defaults. Replace leading tabs '
      + 'with spaces.');
    errors += 1;
  }
  for (const rawLine of ENUMS.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes('::')) continue;
    const sep = line.indexOf('::');
    const enumPath = line.slice(0, sep);
    const enumValues = line.slice(sep + 2);
    const actual = lookup(enumPath);
    if (actual === '') continue;
    if (!enumValues.split('|').includes(actual)) {
      out.push(`${enumPath}: '${actual}' is not a valid value (expected: ${enumValues})`);
      errors += 1;
    }
  }
  if (out.length) process.stderr.write(`${out.join('\n')}\n`);
  return errors ? 1 : 0;
}

/** validate_local_yaml_base — hard error when project.local.yaml has no project.yaml base. */
function validateLocalYamlBase() {
  setRoot();
  if (isFile(join(YH_ROOT, 'project.local.yaml')) && !isFile(join(YH_ROOT, 'project.yaml'))) {
    errl('project.local.yaml exists but project.yaml is missing — run /start to create one. '
      + 'Local overrides require a base.');
    return 1;
  }
  return 0;
}

const EXEMPT_EXACT = new Set(['schema_version']);
const EXEMPT_PREFIX = 'framework.';

/**
 * validate_local_scope [<file>] — names keys in project.local.yaml that resolution will never
 * read (locked keys). Warns, never reconciles. One line per key on stderr; 1 if any found.
 *
 * An EMPTY map counts as a leaf: array-valued keys parse that way (their `- item` lines carry
 * no colon), so treating an empty map as a branch would exempt every list-valued setting.
 */
function validateLocalScope(file) {
  const target = file === undefined || file === '' ? 'project.local.yaml' : file;
  if (!isFile(target)) return 0;
  const lines = readYamlLines(target);
  if (lines === null) return 0;
  const data = parseMap(lines);

  const found = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const dotted = prefix === '' ? k : `${prefix}.${k}`;
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
        walk(v, dotted);
      } else if (shellLines(LOCALLY_OVERRIDABLE).includes(dotted) || EXEMPT_EXACT.has(dotted)) {
        continue;
      } else if (dotted.startsWith(EXEMPT_PREFIX)) {
        continue;
      } else {
        found.push(dotted);
      }
    }
  };
  walk(data, '');

  if (!found.length) return 0;
  for (const key of found) {
    errl(`${target}: \`${key}\` is not locally overridable — ignored, not applied. `
      + 'Move it to project.yaml (or delete it); see the whitelist in yaml-helper.sh.');
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Session-state flag (awk fast path in the shell file; same regex, same result)
// ---------------------------------------------------------------------------
function sessionStateEnabled() {
  for (const f of ['project.local.yaml', 'project.yaml']) {
    if (!isFile(f)) continue;
    const text = readTextOr(f);
    // Faithful port of the awk state machine: only `session_state:` inside a `features:`
    // block counts. Note the block flag matches `^features:` exactly — `features :` (space
    // before the colon) does NOT open a block, which is the shell file's actual behaviour.
    let inFeatures = false;
    let v = '';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r/g, '');
      if (/^features:[ \t]*$/.test(line)) {
        inFeatures = true;
        continue;
      }
      if (/^[^ \t#]/.test(line)) inFeatures = false;
      if (inFeatures && /^[ \t]+session_state:/.test(line)) {
        v = line
          .replace(/^[ \t]*session_state:[ \t]*/, '')
          .replace(/[ \t]*#.*$/, '')
          .replace(/["']/g, '');
        break;
      }
    }
    v = v.replace(/\r/g, '').replace(/ /g, '');
    if (v !== '') {
      if (v === 'off') return false;
      return true;
    }
  }
  return true; // unset anywhere => on
}

// ---------------------------------------------------------------------------
// Whole-config resolution
// ---------------------------------------------------------------------------

function getLegacyFileFor(path) {
  if (!path) return '';
  return tableLookup(LEGACY_FILES, path);
}

/**
 * get_legacy_key <dotted.path> — first non-blank line of the mirror, CR stripped, surrounding
 * whitespace trimmed, INTERNAL SPACES PRESERVED ("Systems Design" is a legal project.stage).
 */
function getLegacyKey(path) {
  if (!path) return '';
  const file = getLegacyFileFor(path);
  if (!file || !isFile(file)) return '';
  const text = readTextOr(file);
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r/g, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (line.length > 0) return line;
  }
  return '';
}

/** _yaml_helper_rigor_level */
function rigorLevel() {
  setRoot();
  let level = '';
  if (isFile(join(YH_ROOT, 'project.yaml'))) level = getYamlKey(join(YH_ROOT, 'project.yaml'), 'modes.rigor');
  if (level !== '' && validateEnumValue('modes.rigor', level) !== 0) level = '';
  if (level === '') level = getYamlDefault('modes.rigor');
  return level;
}

/** _yaml_helper_rigor_value — value for <path> implied by rigor, or '' if rigor does not front it. */
function rigorValue(path) {
  setRoot();
  if (!path) return '';
  if (path === 'modes.rigor') return '';
  let level = rigorLevel();
  if (level === '') return '';
  for (const line of shellLines(RIGOR_EXPANSION)) {
    const idx = line.indexOf('::');
    if (line.slice(0, idx) !== level) continue;
    for (const pair of line.slice(idx + 2).split(',')) {
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq) === path) return pair.slice(eq + 1);
    }
  }
  return '';
}

/**
 * resolve_setting <dotted.path> — prints "<value>\t<source>", always exits 0.
 *   source: project.local.yaml | project.yaml | <legacy path> | rigor:<level> | default | unset
 * Enum-invalid values FALL THROUGH to the next source instead of winning.
 */
function resolveSetting(path) {
  setRoot();
  if (!path) return '\tunset';
  let val = '';
  let src = '';

  if (inLocalReadScope(path) && isFile(join(YH_ROOT, 'project.local.yaml'))) {
    val = cmdSub(getYamlKey(join(YH_ROOT, 'project.local.yaml'), path));
    if (val !== '' && validateEnumValue(path, val) !== 0) val = '';
    if (val !== '') src = 'project.local.yaml';
  }

  if (val === '' && isFile(join(YH_ROOT, 'project.yaml'))) {
    val = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), path));
    if (val !== '' && validateEnumValue(path, val) !== 0) val = '';
    if (val !== '') src = 'project.yaml';
  }

  if (val === '') {
    const legacy = getLegacyFileFor(path);
    if (legacy !== '' && isFile(legacy)) {
      val = cmdSub(getLegacyKey(path));
      if (val !== '' && validateEnumValue(path, val) !== 0) val = '';
      if (val !== '') src = legacy;
    }
  }

  // Rigor expansion sits BELOW every explicit source and ABOVE the terminal default.
  if (val === '') {
    val = rigorValue(path);
    if (val !== '') src = `rigor:${rigorLevel()}`;
  }

  if (val === '') {
    val = getYamlDefault(path);
    if (val !== '') src = 'default';
  }

  if (src === '') src = 'unset';
  return `${val}\t${src}`;
}

/**
 * resolve_code_root — prints "<dir>\t<source>", always exits 0.
 *   source: project.local.yaml | engine.name | .claude/docs/technical-preferences.md
 *         | detected | unset
 * UNSET DOES NOT DEFAULT TO `src`: an absent value may not default to the permissive one, so
 * an unresolvable root is empty and the caller must announce that its check did not run.
 */
function resolveCodeRoot() {
  setRoot();
  let ename = '';
  let src = '';

  if (isFile(join(YH_ROOT, 'project.local.yaml'))) {
    ename = cmdSub(getYamlKey(join(YH_ROOT, 'project.local.yaml'), 'engine.name'));
    if (ename !== '') src = 'project.local.yaml';
  }
  if (ename === '' && isFile(join(YH_ROOT, 'project.yaml'))) {
    ename = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), 'engine.name'));
    if (ename !== '') src = 'engine.name';
  }

  const legacy = join(YH_ROOT, '.claude/docs/technical-preferences.md');
  if (ename === '' && isFile(legacy)) {
    // grep -iE '^[[:space:]]*[-*]?[[:space:]]*\*{0,2}Engine\*{0,2}[[:space:]]*:' | head -1
    //   | sed 's/.*://' | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]].*$//; s/\*//g'
    const grepRe = /^[ \t]*[-*]?[ \t]*\*{0,2}Engine\*{0,2}[ \t]*:/i;
    const text = readTextOr(legacy);
    const hit = text.split('\n').find((l) => grepRe.test(l.replace(/\r/g, '')));
    if (hit !== undefined) {
      let name = hit.replace(/\r/g, '').replace(/^[\s\S]*:/, '');
      name = name.replace(/^[ \t]+/, '').replace(/[ \t][\s\S]*$/, '').replace(/\*/g, '');
      /* sed 's/\*//g' — backslashes are NOT stripped, matching sed */
      if (name.includes('[TO BE CONFIGURED]') || name.startsWith('[')) name = '';
      ename = name;
    }
    if (ename !== '') src = '.claude/docs/technical-preferences.md';
  }

  let root = '';
  switch (ename.toLowerCase()) {
    case 'godot': root = 'src'; break;
    case 'unity': root = 'Assets'; break;
    default: root = ename.toLowerCase().startsWith('unreal') ? 'Source' : '';
  }

  // Believe the tree only when it is UNAMBIGUOUS: two roots present is undecidable.
  if (root === '') {
    let found = '';
    let n = 0;
    for (const d of listDirNames(YH_ROOT)) {
      if (d === 'src' || d === 'Assets' || d === 'Source') {
        found = d;
        n += 1;
      }
    }
    if (n === 1) {
      root = found;
      src = 'detected';
    } else {
      root = '';
      src = '';
    }
  }

  if (src === '') src = 'unset';
  return `${root}\t${src}`;
}

function isAlwaysAskCategory(category) {
  if (!category) return false;
  let configured = cmdSub(getEffectiveYamlArray('modes.automation_always_ask'));
  if (configured === '') configured = ALWAYS_ASK_DEFAULT;
  return shellLines(configured).includes(category);
}

/**
 * log_decision <skill> <point> <options> <chosen> <reason> <category>
 * Appends to production/session-logs/decision-log.md, creating file and directory if absent.
 */
function logDecision(skill, point, options, chosen, reason, category) {
  setRoot();
  const logfile = join(YH_ROOT, 'production/session-logs/decision-log.md');
  mkdirSync(dirname(logfile), { recursive: true });
  if (!isFile(logfile)) {
    writeFileSync(logfile, '# Decision Log\n\nAppend-only audit trail of decisions made in autonomous mode.\n', 'utf8');
  }
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  appendFileSync(logfile, `\n## ${timestamp} — ${skill}\n\n**Decision point:** ${point}\n`
    + `**Options considered:** ${options}\n**Chosen:** ${chosen}\n**Reason:** ${reason}\n`
    + `**Category:** ${category}\n`, 'utf8');
}

/**
 * hook_warn <PreToolUse|PostToolUse> "<message>" — the one JSON object a hook may print.
 * Backslash/quote escaped, tab/newline escaped, CR and other control characters dropped.
 * (The shell version starts the message argument at $2 because $1 is the event.)
 */
function hookWarn(event, message) {
  const cleaned = String(message).replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
  const escaped = cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const m = escaped.replace(/\t/g, '\\t').replace(/\n/g, '\\n');
  process.stdout.write(`{"systemMessage":"${m}","hookSpecificOutput":`
    + `{"hookEventName":"${event}","additionalContext":"${m}"}}\n`);
}

// ---------------------------------------------------------------------------
// resolve_config — the only public subcommand.
//   resolve_config [--keys k1,k2,...] [<system>]
// ALWAYS emits a complete block and ALWAYS exits 0.
// ---------------------------------------------------------------------------
function resolveConfig(argv) {
  setRoot();
  let rest = argv.slice();
  let want = '';
  if ((rest[0] ?? '') === '--keys') {
    want = `,${rest[1]},`;
    rest = rest.slice(2);
  }
  const system = rest[0] ?? '';
  let notes = '';

  if (!isFile(join(YH_ROOT, 'project.yaml'))) {
    notes = `${notes ? `${notes}; ` : ''}project.yaml absent — defaults in use`;
  } else {
    let size;
    try {
      size = readFileSync(join(YH_ROOT, 'project.yaml')).length;
    } catch {
      size = 0;
    }
    if (size === 0) {
      notes = `${notes ? `${notes}; ` : ''}project.yaml is EMPTY — defaults in use; `
        + 'if you configured this project, the file did not survive';
    }
  }
  if (validateLocalYamlBase() !== 0) {
    // PARITY BUG, REPRODUCED ON PURPOSE. The shell line is
    //     orphan=$(validate_local_yaml_base 2>&1) || notes="...; $orphan"
    // `$( )` captures STDOUT, and validate_local_yaml_base only ever writes to STDERR — so
    // `$orphan` is always empty and the shell's note adds a bare "; ". The message itself still
    // reaches the caller, because 2>&1 is not applied to the function's own stderr (it goes
    // straight to the terminal) — while the `; ` separator does land inside notes when an
    // earlier note exists. Both halves are reproduced here, byte for byte.
    notes = `${notes ? `${notes}; ` : ''}`;
  }

  // Collect enum complaints from both files so a typo is visible, not silent.
  //
  // PARITY BUG, REPRODUCED ON PURPOSE — read this before "fixing" it. The shell line is
  //     enum_err=$(validate_yaml_enum project.yaml 2>&1 >/dev/null)
  // and redirections apply LEFT TO RIGHT: `2>&1` first points fd 2 at the CURRENT fd 1 (the
  // command-substitution read end), then `>/dev/null` repoints fd 1 at /dev/null. Net effect:
  // the enum text goes into the substitution PIPE while the substitution reads stdout, so
  // `enum_err` is ALWAYS EMPTY. No `— ignored, chain continued` note is ever appended, and the
  // text the redirections were meant to swallow is simply not produced for the caller.
  //
  // The documented intent (`.claude/docs/config-resolution.md`: "resolve_config surfaces what
  // was rejected") is therefore NOT achieved by the shell implementation. This port follows the
  // CODE, not the doc, because skills are calibrated against what the shell actually prints:
  // capture the text, append nothing to notes, emit nothing to stderr. Set
  // YAML_HELPER_ENUM_NOTES=1 to get the documented-intent behaviour instead (the text is then
  // appended to notes exactly as the shell line reads as if it worked).
  const enumNotesMode = process.env.YAML_HELPER_ENUM_NOTES === '1';
  let enumErr = captureStderr(() => validateYamlEnum('project.yaml')).text;
  if (enumErr !== '') {
    if (enumNotesMode) {
      notes = `${notes ? `${notes}; ` : ''}${enumErr.split('\n').join(';').replace(/;$/, '')} — ignored, chain continued`;
    }
  }
  if (isFile(join(YH_ROOT, 'project.local.yaml'))) {
    enumErr = captureStderr(() => validateYamlEnum('project.local.yaml')).text;
    if (enumErr !== '' && enumNotesMode) {
      notes = `${notes ? `${notes}; ` : ''}local: ${enumErr.split('\n').join(';').replace(/;$/, '')}`;
    }
    const scopeErr = captureStderr(() => validateLocalScope('project.local.yaml')).text;
    if (scopeErr !== '' && enumNotesMode) {
      const scopeKeys = [];
      for (const line of scopeErr.split('\n')) {
        const m = /.*`([^`]*)`.*/.exec(line);
        if (m) scopeKeys.push(m[1]);
      }
      notes = `${notes ? `${notes}; ` : ''}local: not locally overridable, ignored — `
        + `${scopeKeys.join(', ')} (move to project.yaml or delete)`;
    }
  }

  let nkeys = 0;
  if (want !== '') nkeys = want.split(',').filter((k) => /[a-z]/.test(k)).length;
  const bare = want !== '' && nkeys <= 2 ? 1 : 0;

  const rcWant = (label) => want === '' || want.includes(`,${label},`);

  if (bare === 1) {
    // bare form prints no header at all
  } else if (want !== '') {
    el('=== DSGS Config (resolved: local->yaml->legacy->default; use as-is) ===');
  } else {
    el('=== DSGS Resolved Config ===');
  }

  const pairs = [
    ['modes.rigor', 'rigor'],
    ['modes.review_mode', 'review_mode'],
    ['modes.automation', 'automation'],
    ['modes.workflow', 'workflow'],
    ['docs.density', 'docs.density'],
    ['modes.story_granularity', 'story_granularity'],
    ['qa.level', 'qa.level'],
    ['team.size', 'team.size'],
    ['project.stage', 'project.stage'],
  ];
  for (const [path, label] of pairs) {
    if (!rcWant(label)) continue;
    const v = resolveSetting(path);
    const tab = v.indexOf('\t');
    const value = v.slice(0, tab);
    const src = v.slice(tab + 1);
    el(`${label}: ${value !== '' ? value : 'not set'} (${src})`);
  }

  if (rcWant('automation_always_ask')) {
    const aaa = cmdSub(getEffectiveYamlArray('modes.automation_always_ask'));
    if (aaa !== '') {
      el(`automation_always_ask: ${aaa.split('\n').join(', ')} (configured)`);
    } else {
      el(`automation_always_ask: ${ALWAYS_ASK_DEFAULT.split('\n').join(', ')} (default)`);
    }
  }

  if (rcWant('engine')) {
    const ename = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), 'engine.name'));
    const eversion = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), 'engine.version'));
    if (ename !== '') {
      el(`engine: ${ename}${eversion !== '' ? ` ${eversion}` : ''} (project.yaml)`);
    } else {
      el('engine: unset (fall back to .claude/docs/technical-preferences.md)');
    }
  }

  if (rcWant('testing.strict')) {
    let tsOut = '';
    for (const k of ['logic', 'integration', 'visual', 'ui', 'config']) {
      let tv = cmdSub(getEffectiveYamlKey(`testing.strict.${k}`));
      if (tv === '') tv = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), 'testing.strict'));
      tsOut += ` ${k}=${tv !== '' ? tv : 'unset'}`;
    }
    el(`testing.strict:${tsOut} (unset = each skill applies its own default)`);
  }

  if (rcWant('performance.enforce')) {
    const pe = resolveSetting('performance.enforce');
    const tab = pe.indexOf('\t');
    const value = pe.slice(0, tab);
    const src = pe.slice(tab + 1);
    el(`performance.enforce: ${value !== '' ? value : 'warn'} (${src})`);
  }

  if (rcWant('cert_tier') || rcWant('platform.cert_tier')) {
    const ct = cmdSub(getEffectiveYamlKey('platform.cert_tier'));
    if (ct !== '') {
      el(`platform.cert_tier: ${ct}`);
    } else {
      el('platform.cert_tier: (unset -- ask which platforms are in scope)');
    }
  }

  if (rcWant('system_overrides')) {
    const soKeys = cmdSub(getYamlChildKeys('project.yaml', 'workflow_overrides.system_overrides'));
    let soOut = '';
    if (soKeys !== '') {
      for (const sk of shellLines(soKeys)) {
        const sv = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), `workflow_overrides.system_overrides.${sk}`));
        if (sv !== '') soOut += ` ${sk}=${sv}`;
      }
    }
    el(`system_overrides:${soOut !== '' ? soOut : ' none'}`);
  }
  if (system !== '') {
    const sv = cmdSub(getYamlKey(join(YH_ROOT, 'project.yaml'), `workflow_overrides.system_overrides.${system}`));
    if (sv !== '') {
      el(`workflow[${system}]: ${sv} (system_overrides)`);
    } else {
      const v = resolveSetting('modes.workflow');
      el(`workflow[${system}]: ${v.slice(0, v.indexOf('\t'))} (no override — project value)`);
    }
  }

  if (bare === 1) {
    if (notes !== '') el(`notes: ${notes}`);
  } else if (want !== '') {
    if (notes !== '') el(`notes: ${notes}`);
    el('=== end ===');
  } else {
    el(`notes: ${notes !== '' ? notes : 'none'}`);
    el('Values above are fully resolved (local -> yaml -> legacy -> default). Use as-is.');
    el('An inline --review flag, if passed, overrides review_mode.');
    el('=== end DSGS config ===');
  }
  return 0;
}

/**
 * Run `fn` capturing whatever it writes to stderr (the shell's `2>&1 >/dev/null`).
 * stdout is dropped, which is what `>/dev/null` does for the enum checks.
 * Returns `{ text, value }`: the captured stderr text and fn's return value.
 */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  let value;
  try {
    value = fn();
  } finally {
    process.stderr.write = orig;
  }
  return { text: cmdSub(chunks.join('')), value };
}

// ---------------------------------------------------------------------------
// Hidden `__call` dispatcher: same signature and output as sourcing the .sh file.
// ---------------------------------------------------------------------------
const CALL_TABLE = {
  // Source-compatible entry for the shell's public subcommand: `source <script>; resolve_config ...`
  // behaves exactly like the CLI dispatch, so tests can call it either way.
  resolve_config: (a) => { resolveConfig(a); return 0; },
  get_yaml_key: (a) => { const s = getYamlKey(a[0], a[1]); if (s) pr(s); return 0; },
  get_yaml_array: (a) => { const s = getYamlArray(a[0], a[1]); if (s) pr(s); return 0; },
  get_yaml_child_keys: (a) => { const s = getYamlChildKeys(a[0], a[1]); if (s) pr(s); return 0; },
  get_effective_yaml_key: (a) => { const s = getEffectiveYamlKey(a[0]); if (s) pr(s); return 0; },
  get_effective_yaml_array: (a) => { const s = getEffectiveYamlArray(a[0]); if (s) pr(s); return 0; },
  get_yaml_default: (a) => { const s = getYamlDefault(a[0]); if (s) pr(s); return 0; },
  get_legacy_key: (a) => { const s = getLegacyKey(a[0]); if (s) pr(s); return 0; },
  validate_yaml_enum: (a) => validateYamlEnum(a[0]),
  validate_local_yaml_base: () => validateLocalYamlBase(),
  validate_local_scope: (a) => validateLocalScope(a[0]),
  validate_enum_value: (a) => validateEnumValue(a[0], a[1]),
  is_locally_overridable: (a) => (isLocallyOverridable(a[0]) ? 0 : 1),
  is_always_ask_category: (a) => (isAlwaysAskCategory(a[0]) ? 0 : 1),
  session_state_enabled: () => (sessionStateEnabled() ? 0 : 1),
  resolve_setting: (a) => { const s = resolveSetting(a[0]); if (s) pr(s); return 0; },
  resolve_code_root: () => { const s = resolveCodeRoot(); if (s) pr(s); return 0; },
  log_decision: (a) => { logDecision(a[0], a[1], a[2], a[3], a[4], a[5]); return 0; },
  hook_warn: (a) => { hookWarn(a[0], a[1]); return 0; },
};

function printCallHelp() {
  process.stdout.write([
    'yaml-helper.mjs __call <function> [args...]',
    '',
    'resolve_config [--keys k1,k2,...] [<system>]',
    'get_yaml_key <file> <dotted.path>',
    'get_yaml_array <file> <dotted.path>',
    'get_yaml_child_keys <file> <dotted.path>',
    'get_effective_yaml_key <dotted.path>',
    'get_effective_yaml_array <dotted.path>',
    'get_yaml_default <dotted.path>',
    'get_legacy_key <dotted.path>',
    'validate_yaml_enum <file>',
    'validate_local_yaml_base',
    'validate_local_scope [<file>]',
    'validate_enum_value <dotted.path> <value>',
    'is_locally_overridable <dotted.path>',
    'is_always_ask_category <category>',
    'session_state_enabled',
    'resolve_setting <dotted.path>',
    'resolve_code_root',
    'log_decision <skill> <point> <options> <chosen> <reason> <category>',
    'hook_warn <PreToolUse|PostToolUse> <message>',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '__call') {
    const fn = argv[1] ?? '';
    if (fn === '' || fn === 'help' || fn === '--help') {
      printCallHelp();
      return 0;
    }
    const entry = CALL_TABLE[fn];
    if (!entry) {
      errl(`yaml-helper.mjs: unknown function '${fn}' (try: __call help)`);
      return 2;
    }
    return entry(argv.slice(2));
  }

  switch (argv[0] ?? '') {
    case 'resolve_config': {
      // Same anchor as the shell dispatcher: hooks/ sits two levels below the project root,
      // and tools/ does too, so `dirname(self)/..` is the root in both layouts. It only fills
      // CLAUDE_PROJECT_DIR when that has no project.yaml, so cwd-first precedence survives.
      if (!process.env.CLAUDE_PROJECT_DIR || !isFile(join(process.env.CLAUDE_PROJECT_DIR, 'project.yaml'))) {
        const selfDir = dirname(fileURLToPath(import.meta.url));
        const root = resolve(selfDir, '..');
        const projectDir = root.split(sep).join('/');
        if (projectDir !== '') process.env.CLAUDE_PROJECT_DIR = projectDir;
      }
      resolveConfig(argv.slice(1));
      return 0;
    }
    default:
      el('yaml-helper.sh: usage: bash yaml-helper.sh resolve_config [--keys k1,k2,...] [<system>]');
      return 0;
  }
}

if (isMainModule()) {
  process.exitCode = main();
}

export {
  getYamlKey,
  getYamlArray,
  getYamlChildKeys,
  getEffectiveYamlKey,
  getEffectiveYamlArray,
  getYamlDefault,
  getLegacyKey,
  validateYamlEnum,
  validateLocalYamlBase,
  validateLocalScope,
  validateEnumValue,
  isLocallyOverridable,
  isAlwaysAskCategory,
  sessionStateEnabled,
  resolveSetting,
  resolveCodeRoot,
  rigorLevel,
  rigorValue,
  logDecision,
  hookWarn,
  resolveConfig,
  setRoot,
  ENUMS,
  DEFAULTS,
  RIGOR_EXPANSION,
  LEGACY_FILES,
  LOCALLY_OVERRIDABLE,
};

export const __test = { parseMap, parseArray, parseChildKeys, splitLines, CALL_TABLE, captureStderr };

