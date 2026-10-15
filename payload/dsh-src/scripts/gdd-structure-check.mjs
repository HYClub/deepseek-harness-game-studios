#!/usr/bin/env node
// gdd-structure-check.mjs — deterministic section-presence check for system GDDs.
//
// Node port of `.claude/scripts/gdd-structure-check.sh` (lines 1-95). The skill
// reads the two output lines verbatim, so the column text, the leading space in
// `ABSENT:  ` and the comma-joined name lists are reproduced literally.
//
// Replaces a full-document model read per GDD with ~2 lines of output that cannot
// hallucinate a missing section.
//
// REPORTS PRESENCE ONLY — IT DOES NOT JUDGE COMPLETENESS. Which sections are
// REQUIRED depends on the workflow tier and on what the system defines; the
// caller applies the tier.
//
// Usage:
//   node .dsh/scripts/gdd-structure-check.mjs                    # all system GDDs
//   node .dsh/scripts/gdd-structure-check.mjs design/gdd/foo.md  # one GDD
//
// Output (per GDD; the ABSENT line is omitted when nothing is absent):
//   combat.md PRESENT: Overview,Player Fantasy,Detailed Rules,...
//   loot.md   ABSENT:  Player Fantasy,Formulas,Tuning Knobs
//
// PORTING NOTES:
//   - `grep -qiE "^##+[[:space:]]+([0-9]+[.)]?[[:space:]]*)?${s}"` becomes one
//     RegExp per section, matched against every line. The file is split on `\n`
//     after collapsing CRLF and lone CR, so a trailing `\r` cannot be mistaken
//     for the `$` anchor's prey, and `[[:space:]]` becomes the explicit
//     `[ \t\r\n\f\v]` set (JS `\s` also matches Unicode spaces, which `grep` with
//     `LC_ALL=C` would not).
//   - `find design/gdd -maxdepth 1 -name '*.md' -type f | sort` becomes a
//     `readdirSync` filtered to regular `.md` files and sorted with the default
//     (byte/code-unit) comparison, which is `LC_ALL=C sort` for these names.
//     `reviews/` stays out of scope because only the top level is read.
//   - A section name is interpolated into the pattern unescaped, exactly like the
//     bash array does. None of the eight names contain a regex metacharacter.
//   - The bash `cd "$(dirname "$0")/../.."` becomes `rootFromScript()`; the
//     explicit single-file argument is still resolved against the CALLER's cwd,
//     as before.
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readText, rootFromScript } from './_runner.mjs';

// Each MATCH entry is an ERE alternation of every accepted heading for one
// required section; LABEL is the canonical name reported to the caller.
//
// "Detailed Rules" is authored as "## Detailed Design" by the GDD template and by
// /design-system. They denote the SAME required section. Accepting only one name
// reports 7/8 MISSING on every conforming GDD — the exact failure this guard
// exists to prevent.
const MATCH = [
  'Overview',
  'Player Fantasy',
  'Detailed (Rules|Design)',
  'Formulas',
  'Edge Cases',
  'Dependencies',
  'Tuning Knobs',
  'Acceptance Criteria',
];
const LABEL = [
  'Overview',
  'Player Fantasy',
  'Detailed Rules',
  'Formulas',
  'Edge Cases',
  'Dependencies',
  'Tuning Knobs',
  'Acceptance Criteria',
];

/** `[[:space:]]` in the C locale: space, tab, CR, LF, VT, FF. */
const SPACE = ' \\t\\r\\n\\f\\v';

// Heading matchers, compiled once. `-i` is grep's case-insensitive flag.
const HEADING = MATCH.map((name) => new RegExp(`^##+[${SPACE}]+([0-9]+[.)]?[${SPACE}]*)?${name}`, 'i'));

/** Governance and registry docs that live in design/gdd/ but are not system GDDs. */
const NOT_A_SYSTEM_GDD = [
  'game-concept.md',
  'systems-index.md',
  'game-pillars.md',
  /^gdd-cross-review-.*\.md$/,
  'gameplay-tags.md',
  'fixture-swap-ledger.md',
  'entity-registry.md',
  'sound-bible.md',
];

const root = rootFromScript();

const arg = process.argv[2] ?? '';
if (arg !== '') {
  let isFile = false;
  try {
    isFile = statSync(arg).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    process.stderr.write(`Not found: ${arg}\n`);
    process.exit(1);
  }
  checkFile(arg);
  process.exit(0);
}

const gddDir = join(root, 'design', 'gdd');
let names = [];
try {
  names = readdirSync(gddDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
} catch {
  names = [];
}

let any = 0;
for (const name of names) {
  if (notASystemGdd(name)) continue;
  any = 1;
  checkFile(join(gddDir, name));
}

if (any !== 1) process.stdout.write('No system GDDs found in design/gdd/.\n');

/** @param {string} name file name only */
function notASystemGdd(name) {
  return NOT_A_SYSTEM_GDD.some((rule) => (typeof rule === 'string' ? rule === name : rule.test(name)));
}

/** Print the PRESENT line and, when non-empty, the ABSENT line for one GDD. */
function checkFile(file) {
  const text = readText(file);
  const body = text === null ? '' : text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.length > 0 ? body.split('\n') : [];
  const present = [];
  const absent = [];
  for (let i = 0; i < HEADING.length; i += 1) {
    // One matcher per line: grep anchors `^` per line, and `$` was never used.
    if (lines.some((line) => HEADING[i].test(line))) {
      present.push(LABEL[i]);
    } else {
      absent.push(LABEL[i]);
    }
  }
  const name = basename(file);
  process.stdout.write(`${name} PRESENT: ${present.join(',')}\n`);
  if (absent.length > 0) process.stdout.write(`${name} ABSENT:  ${absent.join(',')}\n`);
}
