#!/usr/bin/env node
// artifact-check.mjs — evaluate every workflow-catalog step's artifact spec
// against what is actually on disk.
//
// Node port of `.claude/scripts/artifact-check.sh` (lines 1-342). The bash original
// ran an embedded Python 3 program; the contract that matters is its STDOUT, which
// /help, /gate-check and /project-stage-detect read directly. Line formats,
// column text, key order in the trailing `k=v` fields, the `PHASES:`/`STEPS:`/
// `NO_CHECK:` denominators and the exit codes are reproduced literally.
//
// Replaces the "Use Glob and Read to verify files exist and have meaningful
// content" loop in /gate-check (and the equivalent hand-scans in /help and
// /project-stage-detect). workflow-catalog.yaml already encodes `glob`,
// `pattern`, `min_count` and `any_of` per step; nothing consumed it
// deterministically, so the model re-derived the same answers by opening files.
//
// EMITS OBSERVATIONS, NOT A VERDICT (per .dsh/docs/context-management.md
// rule 2). It reports what is on disk; the CALLER applies the workflow tier,
// the required/optional distinction, and any per-system override. In
// particular this script never says PASS or FAIL, and never decides that an
// ABSENT artifact is a blocker — at `minimal` most of them are not.
//
// Usage: node .dsh/scripts/artifact-check.mjs [--phase <id> | --path <id>] [project-root]
//   --phase <id>  restrict output to one phase (concept, systems-design, ...)
//   --path <id>   report one tier path instead of the phase ladder (`minimal`).
//   project-root  defaults to the repo root; an explicit path is taken as-is
//                 (used by the test suite against fixtures).
//
// Output:
//   CATALOG: <path>            the catalog actually read
//   ROOT: <path>               the tree evaluated against
//   PHASES: <n> / STEPS: <n>   denominators — see below (PATHS: with --path)
//   PHASE: <id>                (PATH: <id> with --path)
//     STEP: <id> required=<bool> repeatable=<bool> check=<kind> status=<status> ...
//
// status values (observations):
//   PRESENT       glob matched, count >= min_count, pattern found if specified
//   ABSENT        no file matched the glob
//   SHORT         files matched but fewer than min_count
//   PATTERN_MISS  files matched but none contained the required pattern
//   NO_CHECK      the step declares no artifact — completion is not detectable
//                 from disk. NOT the same as ABSENT.
//
// DENOMINATOR DISCIPLINE: STEPS is printed before any per-step line so a caller
// can tell "0 steps reported because the catalog failed to parse" from "0 steps
// are incomplete". A NO_CHECK count is printed too — a phase that is all NO_CHECK
// has been *scanned*, not *satisfied*.
//
// PORTING NOTES (deliberate divergences, all in the check engine, never the format):
//   - The Python interpreter, the PyYAML-free indentation walk and the
//     `sys.stdout.reconfigure(encoding="utf-8")` dance are gone: Node reads and
//     writes UTF-8 natively, so the cp1252 UnicodeEncodeError death mode cannot
//     occur. The indentation walk itself is ported as-is, including the
//     `strip_val` quote stripping that does NOT unescape.
//   - `grep -qE -f <patternfile>` is replaced by an in-process POSIX-ERE matcher.
//     `grep` is not reachable here (Git Bash refuses to start, so there is no grep
//     on PATH) and the Python original degraded every `pattern:` step to
//     `UNKNOWN why=grep-unavailable` on this machine. Matching in Node restores the
//     real verdict. The two catalog patterns are covered by fixtures in the test;
//     the sub-language used is a literal, `.`/`^`/`*`/`+`/`?`/alternation/
//     `\`-escapes and POSIX bracket expressions.
//   - Python's byte-oriented `glob` is replaced by a segment-wise Node walk. The
//     differences that matter here: `**` only spans directories (Python's also
//     matches zero or more *files*), and dot-directories are reachable (Python's
//     `glob` skips them without `include_hidden`), which is what lets
//     `.github/workflows/tests.yml` be found.
// END-OF-USAGE-HEADER
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixPath, readText, rootFromScript } from './_runner.mjs';

const SELF = fileURLToPath(import.meta.url);

const PHASE_FILTER = { value: '' };
const PATH_FILTER = { value: '' };
let ROOT_ARG = '';

/** Indentation width of a line — the walk's only structural signal. */
function indentOf(line) {
  return line.length - line.trimStart(' ').length;
}

/** Strip surrounding whitespace and one layer of matching quotes. Never unescapes. */
function stripVal(value) {
  let v = value.trim();
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
    v = v.slice(1, -1);
  }
  return v;
}

const USAGE = parseArgs(process.argv.slice(2));
if (USAGE === 'help') {
  process.stdout.write(helpText());
  process.exit(0);
}
if (PHASE_FILTER.value !== '' && PATH_FILTER.value !== '') {
  process.stderr.write(
    'artifact-check: --phase and --path are exclusive (a path is a tier\'s whole route, not a phase)\n',
  );
  process.exit(2);
}

const ROOT = ROOT_ARG !== '' ? ROOT_ARG : rootFromScript();
const CATALOG = join(ROOT, '.claude', 'docs', 'workflow-catalog.yaml');
if (!existsSync(CATALOG) || !statSync(CATALOG).isFile()) {
  process.stderr.write(`artifact-check: catalog not found at ${CATALOG}\n`);
  process.exit(1);
}

main();

/**
 * Argument walk, mirroring the bash `case` (lines 57-70): a flag without a value
 * exits 2 rather than spinning, `--flag=value` is accepted, `-h/--help` prints
 * the header comment, and ANY other argument is the project root.
 * @param {string[]} argv
 * @returns {'help'|'run'}
 */
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phase' || arg === '--path') {
      if (i + 1 >= argv.length) {
        process.stderr.write(`artifact-check: ${arg} needs a value\n`);
        process.exit(2);
      }
      if (arg === '--phase') PHASE_FILTER.value = argv[i + 1];
      else PATH_FILTER.value = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--phase=')) {
      PHASE_FILTER.value = arg.slice('--phase='.length);
      continue;
    }
    if (arg.startsWith('--path=')) {
      PATH_FILTER.value = arg.slice('--path='.length);
      continue;
    }
    if (arg === '-h' || arg === '--help') return 'help';
    ROOT_ARG = arg;
  }
  return 'run';
}

/** The usage block (lines 2..the END-OF-USAGE-HEADER sentinel) with comment markers
 * stripped — the bash `sed -n '2,/^$/p' "$0"`, which emitted `# …` lines. A sentinel
 * rather than a blank line, because the blank line that ended the bash header is not
 * guaranteed to survive tooling that rewrites this file. */
function helpText() {
  const raw = readText(SELF) ?? '';
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''));
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '' || lines[i].startsWith('// END-OF-USAGE-HEADER')) break;
    out.push(lines[i] === '//' ? '#' : lines[i].replace(/^\/\/ ?/, '# '));
  }
  return `${out.join('\n')}\n`;
}

// --- parse the catalog ----------------------------------------------------

/**
 * Ported indentation walk (sh lines 124-218). Returns { phases, paths } where each
 * entry is [id, steps[]] and each step is
 * { id, required, repeatable, artifact|null, note }.
 */
function parseCatalog(text) {
  const phases = [];
  const paths = [];
  let curPhase = null;
  let curStep = null;
  let ctx = null;
  let section = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const ind = indentOf(line);
    const s = line.trim();

    if (ind === 0) {
      section = s === 'phases:' ? phases : s === 'paths:' ? paths : null;
      curPhase = null;
      curStep = null;
      ctx = null;
      continue;
    }
    if (section === null) continue;

    if (ind === 2 && s.endsWith(':')) {
      curPhase = [s.slice(0, -1).trim(), []];
      section.push(curPhase);
      curStep = null;
      ctx = null;
      continue;
    }
    if (curPhase === null) continue;

    if (ind === 6 && s.startsWith('- id:')) {
      curStep = {
        id: stripVal(s.slice('- id:'.length)),
        required: false,
        repeatable: false,
        artifact: null,
        note: null,
      };
      curPhase[1].push(curStep);
      ctx = null;
      continue;
    }
    if (curStep === null) continue;

    if (ind === 8) {
      ctx = null;
      if (s === 'artifact:') {
        curStep.artifact = { glob: null, pattern: null, minCount: 1, anyOf: [], note: null };
        ctx = 'artifact';
      } else if (s.startsWith('required:')) {
        curStep.required = stripVal(s.slice('required:'.length)).toLowerCase() === 'true';
      } else if (s.startsWith('repeatable:')) {
        curStep.repeatable = stripVal(s.slice('repeatable:'.length)).toLowerCase() === 'true';
      }
      continue;
    }

    const art = curStep.artifact;
    if (art === null) continue;

    if (ind === 10) {
      if (s === 'any_of:') {
        ctx = 'any_of';
      } else if (s.startsWith('glob:')) {
        art.glob = stripVal(s.slice('glob:'.length));
        ctx = 'artifact';
      } else if (s.startsWith('pattern:')) {
        art.pattern = stripVal(s.slice('pattern:'.length));
        ctx = 'artifact';
      } else if (s.startsWith('min_count:')) {
        const parsed = Number.parseInt(stripVal(s.slice('min_count:'.length)), 10);
        if (Number.isFinite(parsed)) art.minCount = parsed;
        ctx = 'artifact';
      } else if (s.startsWith('note:')) {
        art.note = stripVal(s.slice('note:'.length));
        ctx = 'artifact';
      }
      continue;
    }

    if (ind >= 12 && ctx === 'any_of') {
      if (s.startsWith('- glob:')) {
        art.anyOf.push({ glob: stripVal(s.slice('- glob:'.length)), pattern: null });
      } else if (s.startsWith('pattern:') && art.anyOf.length > 0) {
        art.anyOf[art.anyOf.length - 1].pattern = stripVal(s.slice('pattern:'.length));
      }
    }
  }

  return { phases, paths };
}

// --- glob + pattern matching ---------------------------------------------
/** Turn a glob into a RegExp over a single path segment (`*` and `?` only). */
function segmentRegex(segment) {
  let out = '^';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

/**
 * Expand a repo-relative glob to sorted, forward-slashed relative file paths.
 * Only regular files are returned, sorted like the Python original's `sorted()`.
 * @param {string} pat
 * @param {string} root
 * @returns {string[]}
 */
function expandGlob(pat, root) {
  const relPat = pat.replace(/\\/g, '/');
  const segments = relPat.split('/').filter((part) => part.length > 0);
  if (segments.length === 0) return [];
  const out = [];
  walk(root, '', segments, 0, out);
  return out.sort();
}

function walk(absDir, relDir, segments, index, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const absPath = join(absDir, entry.name);
    if (index === segments.length - 1) {
      if (entry.isFile() && segmentRegex(segments[index]).test(entry.name)) out.push(relPath);
      continue;
    }
    if (entry.isDirectory()) {
      if (segments[index] === '**') {
        walk(absPath, relPath, segments, index, out); // `**` spans directories
        walk(absPath, relPath, segments, index + 1, out);
      } else if (segmentRegex(segments[index]).test(entry.name)) {
        walk(absPath, relPath, segments, index + 1, out);
      }
    }
  }
}

/**
 * POSIX ERE → JS RegExp for the bracket expressions the catalog uses.
 *
 * `[[:space:]]` and friends are POSIX classes: in JS they are a literal character
 * list containing `:`, `s`, `p`, `a`, `c`, `e` — silently never matching. They are
 * rewritten to the C-locale ASCII sets here, which is what `grep -E` with
 * `LC_ALL=C` means. An invalid pattern yields null (the caller reports UNKNOWN,
 * the honest analogue of the original's "grep is not usable" exit code).
 * @param {string} pattern
 * @returns {RegExp|null}
 */
function ereToRegExp(pattern) {
  const classes = {
    alnum: '0-9A-Za-z',
    alpha: 'A-Za-z',
    blank: ' \\t',
    cntrl: '\\x00-\\x1f\\x7f',
    digit: '0-9',
    graph: '\\x21-\\x7e',
    lower: 'a-z',
    print: '\\x20-\\x7e',
    punct: '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e',
    space: ' \\t\\r\\n\\v\\f',
    upper: 'A-Z',
    xdigit: '0-9A-Fa-f',
  };
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch !== '[') {
      source += ch;
      i += 1;
      continue;
    }
    // A bracket expression, scanned with POSIX rules: `]` first is a literal
    // member, `[:…:]`/`[.….]`/`[=…=]` are individual members, and `[` alone is a
    // literal member (`[^[]` means "not `[`", which JS also accepts — one test
    // suite depends on exactly that pattern).
    i += 1;
    source += '[';
    if (pattern[i] === '^') {
      source += '^';
      i += 1;
    }
    if (pattern[i] === ']') {
      source += '\\]';
      i += 1;
    }
    let closed = false;
    while (i < pattern.length) {
      if (pattern[i] === ']') {
        source += ']';
        closed = true;
        i += 1;
        break;
      }
      const posixClass = /^\[:(\w+):\]/.exec(pattern.slice(i));
      if (posixClass !== null) {
        const body = classes[posixClass[1]];
        if (body === undefined) return null;
        // At the opening position a bare class is a complete expression; after at
        // least one member it must be nested, or JS reads `[a-z[:digit:]]` as a
        // class containing the literals `[:digit:]`.
        source += source.endsWith('[') || source.endsWith('[^') ? body : `[${body}]`;
        i += posixClass[0].length;
        continue;
      }
      const member = /^\[[:.=.][^\]\n]*[:.=.]\]/.exec(pattern.slice(i));
      if (member !== null) {
        source += member[0];
        i += member[0].length;
        continue;
      }
      // An unescaped `[` inside the class is a literal member; `\[` is too, but
      // must keep its backslash so that JS does not read the next `]` as the
      // class terminator.
      if (pattern[i] === '\\') {
        source += '\\\\';
        i += 1;
        if (i < pattern.length) {
          source += pattern[i];
          i += 1;
        }
        continue;
      }
      if (pattern[i] === '[') {
        source += '\\[';
        i += 1;
        continue;
      }
      source += pattern[i];
      i += 1;
    }
    if (!closed) return null;
  }
  try {
    return new RegExp(source, 'm');
  } catch {
    return null;
  }
}

/**
 * Which of `files` contain `pattern`. Semantics of the original's
 * `grep -qE -f patternfile`: an empty pattern file matches every line, hence
 * every file. `null` means "pattern not usable" (the original's
 * `grep-unavailable` / UNKNOWN path).
 * @param {string[]} files
 * @param {string|null} pattern
 * @param {string} root
 * @returns {string[]|null}
 */
function patternHits(files, pattern, root) {
  if (!pattern) return files;
  const re = ereToRegExp(pattern);
  if (re === null) return null;
  const hits = [];
  for (const file of files) {
    const text = readText(join(root, file.replace(/\//g, sep)));
    if (text !== null && re.test(text)) hits.push(file);
  }
  return hits;
}

/** -> { status, kind, detail } — observation only; no verdict. */
function evaluate(art, root) {
  if (art === null) return { status: 'NO_CHECK', kind: 'none', detail: {} };

  if (art.anyOf.length > 0) {
    for (let i = 0; i < art.anyOf.length; i += 1) {
      const alt = art.anyOf[i];
      const files = expandGlob(alt.glob ?? '', root);
      if (files.length === 0) continue;
      const hits = patternHits(files, alt.pattern, root);
      if (hits === null) return { status: 'UNKNOWN', kind: 'any_of', detail: { why: 'grep-unavailable' } };
      if (hits.length > 0) {
        return { status: 'PRESENT', kind: 'any_of', detail: { match: alt.glob, alt: String(i + 1) } };
      }
    }
    return { status: 'ABSENT', kind: 'any_of', detail: { alts: String(art.anyOf.length) } };
  }

  if (!art.glob) {
    return {
      status: 'NO_CHECK',
      kind: 'none',
      detail: art.note ? { note: art.note } : {},
    };
  }

  const files = expandGlob(art.glob, root);
  if (files.length === 0) return { status: 'ABSENT', kind: 'glob', detail: { glob: art.glob } };

  const hits = patternHits(files, art.pattern, root);
  if (hits === null) return { status: 'UNKNOWN', kind: 'glob', detail: { why: 'grep-unavailable' } };
  if (art.pattern && hits.length === 0) {
    return {
      status: 'PATTERN_MISS',
      kind: 'glob',
      detail: { glob: art.glob, found: String(files.length) },
    };
  }

  const counted = art.pattern ? hits : files;
  const need = art.minCount;
  if (counted.length < need) {
    return {
      status: 'SHORT',
      kind: 'glob',
      detail: { glob: art.glob, count: String(counted.length), min: String(need) },
    };
  }
  const detail = { count: String(counted.length) };
  if (need > 1) detail.min = String(need);
  return { status: 'PRESENT', kind: 'glob', detail };
}

// --- report ---------------------------------------------------------------
function main() {
  const catalogText = readText(CATALOG);
  if (catalogText === null) {
    process.stderr.write(`artifact-check: catalog not readable at ${CATALOG}\n`);
    process.exit(1);
  }
  const { phases, paths } = parseCatalog(catalogText);

  const usePath = PATH_FILTER.value !== '';
  const label = usePath ? 'PATH' : 'PHASE';
  const pool = usePath ? paths : phases;
  const flt = usePath ? PATH_FILTER.value : PHASE_FILTER.value;
  const sel = pool.filter(([id]) => flt === '' || id === flt);

  if (flt !== '' && sel.length === 0) {
    const known = pool.map(([id]) => id).join(', ') || '(none parsed)';
    process.stderr.write(`artifact-check: unknown ${label.toLowerCase()} '${flt}' (known: ${known})\n`);
    process.exit(2);
  }

  const totalSteps = sel.reduce((sum, [, steps]) => sum + steps.length, 0);
  const lines = [];
  lines.push(`CATALOG: ${posixPath(relpathForDisplay(CATALOG, ROOT))}`);
  lines.push(`ROOT: ${posixPath(ROOT)}`);
  lines.push(`${label}S: ${sel.length}`);
  lines.push(`STEPS: ${totalSteps}`);

  let noCheck = 0;
  const rows = [];
  for (const [pid, steps] of sel) {
    rows.push(`${label}: ${pid}`);
    for (const step of steps) {
      const { status, kind, detail } = evaluate(step.artifact, ROOT);
      if (status === 'NO_CHECK') noCheck += 1;
      const extra = Object.keys(detail)
        .sort()
        .filter((key) => detail[key] !== null && detail[key] !== undefined)
        .map((key) => ` ${key}=${detail[key]}`)
        .join('');
      rows.push(
        `  STEP: ${step.id} required=${String(step.required).toLowerCase()}`
        + ` repeatable=${String(step.repeatable).toLowerCase()}`
        + ` check=${kind} status=${status}${extra}`,
      );
    }
  }

  // Printed BEFORE the rows so a caller reading top-down knows how much of what
  // follows is undetectable-from-disk before it reads any of it.
  lines.push(`NO_CHECK: ${noCheck}`);
  lines.push(...rows);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * `os.path.relpath(catalog, root)` then `.replace(sep, "/")`. Python emits `..`
 * segments; on Windows that path is not valid for file access, so when it escapes
 * the root the absolute path is kept instead — the same choice the original made
 * when it handed the joined path to `glob`/`grep` (both accept it) and the same
 * text on POSIX where `relpath` never escapes for a catalog under the root.
 */
function relpathForDisplay(target, root) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return '.';
  if (isAbsolute(rel) || rel.startsWith('..')) return target;
  return rel;
}
