#!/usr/bin/env node
// story-status.mjs — the story files' Status lines, in the order the minimal
// route takes them. Injected into /help and /sprint-status before the model reads
// either skill.
//
// Node port of `.dsh/scripts/story-status.sh` (lines 1-78). The label column
// (`IN_REVIEW    `, `TODO         `, …) is load-bearing: the skill reads the first
// line as "next", so the exact spacing, the story path and the trailing
// `(<status as written>)` are reproduced literally.
//
// WHY A SCRIPT. The route's rule is "an In Review story is next (its work is
// written; close it), else an In Progress one, else the first Ready or Not
// Started one in build order". Given every status line at once, a small model
// ranked them by file order and got the Ready/Not Started case wrong; listing the
// stories already in the route's order leaves nothing to rank. (In Review comes
// first: its work is already written, /story-done is quick, and closing it
// keeps finished work from piling up behind started work.)
//
// OBSERVATIONS ONLY: each line is a story and the status as written. The skill
// decides what the first line means; nothing here says "next".
//
// Output, one line per unfinished story, file-name (build) order within a group:
//   IN_REVIEW    <path>
//   IN_PROGRESS  <path>
//   TODO         <path>  (Ready | Not Started)
//   BLOCKED      <path>  (<status as written>)
//   OTHER        <path>  (<status as written>)   -- e.g. "Not Done", "Draft"
//   NO_STATUS    <path>
//   COMPLETE     <done> of <total>
// or `STORIES      none` when there are no story files.
//
// Reads the same files and Status formats as statusline.sh's story count
// (production/epics/*/story-*.md; `Status: X`, `**Status:** X`, `> **Status**: X`,
// `- **Status**: X`) and counts "done" by the same rule — the value's leading word,
// in any case, is Complete or Done: `Done.` counts, `Not Done` and `Completed` do
// not — so the two cannot disagree on "done".
//
// PORTING NOTES:
//   - `cd "$(dirname "${BASH_SOURCE[0]}")/../.."` becomes `rootFromScript()`: the
//     injected command runs from wherever the skill's shell starts, which need not
//     be the root, so the repo root is found from this file's location. Every path
//     is then resolved against that root — the bash script only changed cwd, and
//     no other path handling follows.
//   - The glob `production/epics/*/story-*.md` is a `readdirSync` of the epics
//     directory, one level of subdirectory, matched against `story-*.md`. A
//     trailing `/` in the directory name is therefore not a path separator, which
//     matches the shell glob's behaviour for this pattern.
//   - `LC_ALL=C sort` becomes the default code-unit `.sort()`.
//   - The `awk` status reader becomes an explicit line scan. Its normalisations
//     are preserved in order: strip a trailing `\r`, strip leading spaces/tabs,
//     strip a leading `> `, strip a leading `- `, then remove every `*`
//     (`gsub`), and only then test `^Status:`. The value is the remainder with
//     surrounding spaces/tabs trimmed.
//   - The status tests keep awk's `[^a-z]` semantics: a negated class over
//     *lowercase ASCII* only, applied to the lowercased value. (A JS `[^a-z]`
//     literal, not `\W`, which would also reject digits and underscore.)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readText, rootFromScript } from './_runner.mjs';

const root = rootFromScript();
const epicsDir = join(root, 'production', 'epics');

/** Path prefix of a story file, as the bash glob spelled it. */
const EPICS_PREFIX = 'production/epics';

/** The story files, one level under production/epics/, in build order. */
function storyFiles() {
  const out = [];
  let epics = [];
  try {
    epics = readdirSync(epicsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const epic of epics) {
    if (!epic.isDirectory()) continue;
    let entries = [];
    try {
      entries = readdirSync(join(epicsDir, epic.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('story-') || !entry.name.endsWith('.md')) continue;
      out.push(`${EPICS_PREFIX}/${epic.name}/${entry.name}`);
    }
  }
  return out.sort();
}

/**
 * The `Status:` value as written, or null when no line carries one.
 * Mirrors the awk reader including the order of its normalisations.
 * @param {string} file path relative to the repo root
 * @returns {string|null}
 */
function readStatus(file) {
  const text = readText(join(root, file));
  if (text === null) return null;
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '');
    line = line.replace(/^[ \t]+/, '');
    if (line.startsWith('> ')) line = line.slice(2);
    if (line.startsWith('- ')) line = line.slice(2);
    line = line.replace(/\*/g, '');
    if (line.startsWith('Status:')) {
      return line.slice(7).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    }
  }
  return null;
}

const files = storyFiles();
if (files.length === 0) {
  process.stdout.write('STORIES      none\n');
  process.exit(0);
}

const review = [];
const progress = [];
const todo = [];
const blocked = [];
const other = [];
let done = 0;

for (const file of files) {
  const status = readStatus(file);
  const found = status !== null;
  const s = (status ?? '').toLowerCase();

  if (!found) other.push(`NO_STATUS    ${file}`);
  else if (/^(complete|done)([^a-z]|$)/.test(s)) done += 1;
  else if (/^in progress([^a-z]|$)/.test(s)) progress.push(`IN_PROGRESS  ${file}`);
  else if (/^in review([^a-z]|$)/.test(s)) review.push(`IN_REVIEW    ${file}`);
  else if (/^(ready|not started)([^a-z]|$)/.test(s)) todo.push(`TODO         ${file}  (${status})`);
  else if (/^blocked([^a-z]|$)/.test(s)) blocked.push(`BLOCKED      ${file}  (${status})`);
  else other.push(`OTHER        ${file}  (${status})`);
}

const lines = [...review, ...progress, ...todo, ...blocked, ...other];
lines.push(`COMPLETE     ${done} of ${files.length}`);
process.stdout.write(`${lines.join('\n')}\n`);
