#!/usr/bin/env node
/**
 * validate-assets — DSH port of `.claude/hooks/validate-assets.sh` (lines 30-162).
 *
 * Upstream PostToolUse hook (matched on Write|Edit). Two checks, with two
 * different weights — unchanged from the original:
 *
 *   ADVISORY  (bash 94-104) naming: under Godot's `assets/` a filename with an
 *             uppercase letter, a space or a hyphen warns. Unity and Unreal name
 *             assets in PascalCase with type prefixes, so warning on every one of
 *             them would only train the user to ignore this hook.
 *   BLOCKING  (bash 106-138) JSON validity for data files — in ANY engine's data
 *             folder, the same set validate-commit.sh blocks on. Invalid JSON
 *             breaks runtime loading, so it is a build-breaking error.
 *
 * Exit behavior, and why it cannot be "fix the file and retry":
 *   exit 0 + hook JSON -> warnings only. On exit 0 stderr reaches the debug log
 *                         only, so the message rides on systemMessage (the user)
 *                         and additionalContext (the model) — what `hook_warn`
 *                         did in yaml-helper.sh.
 *   exit 2             -> stderr, which is fed back to the model, so the file it
 *                         just wrote can be corrected. A PostToolUse hook cannot
 *                         undo the write; the exit code only selects the audience.
 *
 * The python interpreter lookup of bash 112-136 is gone: `JSON.parse` is built in
 * and never missing, which removes the "UNCHECKED: python not found" degradation.
 * The strictness is kept — see the port report for the two deliberate differences
 * (Python's NaN/Infinity leniency, and reading with `fatal` UTF-8).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run, readInput, projectRoot, emit, block } from './runtime.mjs';

/** The event this hook is registered for; hookSpecificOutput is discarded without it. */
const EVENT = 'PostToolUse';

// bash 85-88: only these three roots are asset roots. Case-SENSITIVE, as the bash
// `case` is (its `nocasematch` was switched off again on bash 82).
const ASSET_ROOT_RE = /^(assets|Assets|Content)\//;
// bash 99-104: Godot's lowercase_with_underscores convention, checked on the
// basename only, and only under `assets/`.
const NAMING_RE = /[A-Z \t\v\f\r-]/;
// bash 109: `<root>/…/Data/*.json`, any case on the file extension.
const DATA_JSON_RE = /^(assets|Assets|Content)\/(.*\/)?[Dd]ata\/.*\.[Jj][Ss][Oo][Nn]$/;

/** bash 111-128 — verdict for "is this a file python's json.load would accept?". */
function jsonVerdict(absolutePath) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return null; // bash 111: `[ -f "$FILE_PATH" ]` is false — nothing to open
  }
  if (!stats.isFile()) return null;
  let buf;
  try {
    buf = readFileSync(absolutePath);
  } catch {
    return false; // python's open() would raise, and bash reports that as invalid
  }
  let text;
  try {
    // bash 126 reads with utf-8-sig: a UTF-8 BOM is accepted. `fatal` keeps the
    // other half of that contract — bytes that are not UTF-8 are a decode error,
    // which is what python's utf-8-sig raises, not silently valid JSON.
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** bash 1569-1576 of yaml-helper.sh: control characters are dropped from hook JSON. */
function stripControlChars(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
}

run(async () => {
  const input = readInput();

  // Nothing to check: no path at all. (bash reads an empty FILE_PATH and falls
  // through its `case` to exit 0.)
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== 'string' || raw === '') return;

  const root = projectRoot(input);
  const rootFwd = root.replace(/\\/g, '/').replace(/\/+$/, '');
  // bash 74: Git Bash spells the same root two ways (`pwd` -> /d/Work/x,
  // `pwd -W` -> D:/example/x). Both are carried here so a POSIX-spelled path inside
  // the project is still recognised instead of being written off as outside it.
  const rootMsys = rootFwd.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

  // bash 66: normalize separators. The payload is already JSON-decoded, so the
  // `\\\\` rule of the sed fallback has nothing left to unescape; applying both
  // rules in order is harmless and keeps the pair documented.
  let p = raw.replace(/\\\\/g, '/').replace(/\\/g, '/');
  let rel;
  if (p.toLowerCase().startsWith(`${rootFwd.toLowerCase()}/`)) {
    rel = p.slice(rootFwd.length + 1);
  } else if (p.toLowerCase().startsWith(`${rootMsys.toLowerCase()}/`)) {
    rel = p.slice(rootMsys.length + 1);
  } else if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
    return; // bash 79: still absolute — outside the project, not our file
  } else {
    rel = p.startsWith('./') ? p.slice(2) : p; // bash 80
  }

  // bash 85-88: only files under an asset root.
  if (!ASSET_ROOT_RE.test(rel)) return;

  const filename = rel.split('/').pop() ?? '';
  const warnings = []; // bash 91 — advisory, exit 0
  const errors = []; // bash 92 — build-breaking, exit 2

  // bash 99-104: naming conventions, Godot's `assets/` only.
  if (/^assets\//.test(rel) && NAMING_RE.test(filename)) {
    warnings.push(`  NAMING: ${rel} must be lowercase with underscores (got: ${filename})`);
  }

  // bash 106-138: JSON validity for data files, in any engine's data folder.
  if (DATA_JSON_RE.test(rel)) {
    const verdict = jsonVerdict(join(root, rel)); // bash 110: relative to the project root
    if (verdict === false) {
      errors.push(
        `  FORMAT: ${rel} is not valid JSON — fix syntax errors before continuing`,
      );
    }
  }

  // bash 140-147: exit 2 routes this to the model, not just the user, so the file
  // that was already written can actually be corrected. Warnings ride along on
  // the same channel, on their own header, exactly as the bash version does.
  if (errors.length > 0) {
    let text =
      `=== Asset Validation: ERRORS ===\n${errors.join('\n')}\n` +
      '================================\n' +
      'The file was written but is broken. Fix it now, before continuing.';
    if (warnings.length > 0) {
      text += `\n=== Asset Validation: Warnings ===\n${warnings.join('\n')}`;
    }
    block(text);
  }

  // bash 149-160: warnings alone need no fix now, but they must be SEEN. stderr
  // on exit 0 would not be, so this is hook JSON — the shape `hook_warn
  // PostToolUse` produced.
  if (warnings.length > 0) {
    const message = stripControlChars(
      `=== Asset Validation: Warnings ===\n${warnings.join('\n')}\n` +
        '==================================\n' +
        '(Warnings are advisory. Fix before final commit.)',
    );
    emit({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: EVENT, additionalContext: message },
    });
  }
});

