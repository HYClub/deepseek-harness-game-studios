#!/usr/bin/env node
/**
 * validate-push — DSH port of `.dsh/hooks/validate-push.sh` (lines 30-177).
 *
 * Upstream PreToolUse hook (matched on Bash|PowerShell): WARNS when a `git push`
 * targets a protected branch — `main`, `master`, or `release/*`. It never blocks:
 * exit 0, and the warning rides on hook JSON. The bash original refused to use
 * stderr for it (bash 160-163): on exit 0 stderr reaches the debug log only, so
 * the warning would reach neither the user nor the model.
 *
 * The two awk pipelines of `git_segment()` are reimplemented as explicit passes,
 * each labelled with the bash lines it replaces:
 *
 *   joinContinuations()    bash 66-69   backslash line-continuations
 *   stripHeredocBodies()   bash 69-89   here-doc / PowerShell here-string bodies
 *   normalizeLine()        bash 90-123  git-path + `-C`/`--git-dir` normalisation,
 *                                       quoted-word unquoting, segment splitting
 *   GIT_PUSH_RE            bash 124     "this line runs `git push`"
 *
 * Regexes, thresholds and the warning text are unchanged — including one quirk in
 * GIT_PUSH_RE flagged at its definition, which is preserved on purpose rather
 * than invented away.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, readInput, projectRoot, emit } from './runtime.mjs';

/** The event this hook is registered for; hookSpecificOutput is discarded without it. */
const EVENT = 'PreToolUse';

/**
 * `git rev-parse --abbrev-ref HEAD`, git's stderr dropped the way `2>/dev/null` did.
 *
 * WHY THIS IS NOT `runtime.capture()`: capture() wraps the command as
 * `{ … ; } > file 2>&1` (runtime.mjs:91), which is POSIX shell grouping. On
 * Windows spawnSync(shell: true) runs that through cmd.exe, where `{` is an
 * ordinary command name — so EVERY capture() call there fails with
 * `'{' is not recognized as an internal or external command` and returns
 * `{ status: 1, stdout: <that error> }`, for any command (measured: `echo hi`).
 * resolveConfig() shares the wrapper and is broken the same way. runtime.mjs is
 * outside this port's edit boundary, so the technique capture() intends is done
 * here directly — output redirected to a private temp file through a file
 * descriptor, never a pipe (this sandbox denies piped child stdio). Once
 * runtime.mjs's wrapper is Windows-safe, replace the body of this function with
 * `capture('git rev-parse --abbrev-ref HEAD', { cwd: root }).stdout`.
 */
function gitCurrentBranch(root) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-git-'));
  try {
    const outPath = join(dir, 'out.txt');
    const fd = openSync(outPath, 'w');
    try {
      spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        stdio: ['ignore', fd, 'ignore'], // stdout -> file, stderr -> null, no pipes
        timeout: 20_000,
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }
    return existsSync(outPath) ? readFileSync(outPath, 'utf8').trim() : '';
  } catch {
    return ''; // bash: `$(git … 2>/dev/null)` on failure is the empty string too
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- git_segment()

/**
 * bash 66-69 — join a trailing `\` with the next line.
 * awk's `while ($0 ~ /\\$/)` reapplies after every splice, so a chain of
 * continuations collapses into one record.
 */
function joinContinuations(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    while (/\\$/.test(line)) {
      const head = line.replace(/\\$/, '');
      if (i + 1 < lines.length) {
        i += 1;
        line = head + lines[i];
      } else {
        line = head;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

// bash 73: a here-doc opener whose body is literal text.
const HEREDOC_OPEN_RE = /<<-?[ \t]*("[^"]*"|'[^']*'|\\?[A-Za-z_][^ \t\r;&|()<>"'\\]*)/;
// bash 75: an interpreter invocation on the same line means a quoted command is
// NOT a here-doc body — it is left alone so the inner text can be re-inspected
// after the splitter breaks it onto its own line.
const INTERPRETER_RE =
  /(^|[^A-Za-z0-9_.-])(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|python[0-9.]*|py|node|ruby|perl|php|eval|source)([ \t]|$)/;

/**
 * bash 69-89 — drop here-doc and PowerShell here-string bodies.
 * `pd` marks the body of a PowerShell single-quote here-string (`@'` … `'@`), which
 * is literal text exactly like a here-doc — unless it is the double-quote form,
 * which PowerShell expands itself, so that form is deliberately not marked.
 */
function stripHeredocBodies(lines) {
  const out = [];
  let pd = false;
  let delimiter = '';
  let stripTabs = false;
  for (const original of lines) {
    if (pd) {
      if (/^'@/.test(original.replace(/\r$/, ''))) pd = false;
      continue;
    }
    if (delimiter !== '') {
      let t = original.replace(/\r$/, '');
      if (stripTabs) t = t.replace(/^\t+/, '');
      if (t === delimiter) delimiter = '';
      continue;
    }
    out.push(original);
    const m = HEREDOC_OPEN_RE.exec(original);
    if (m !== null) {
      const before = m.index > 0 ? original[m.index - 1] : '';
      const prefix = original.slice(0, m.index);
      if (before !== '<' && !/\$\(\([^)]*$/.test(prefix) && !INTERPRETER_RE.test(original)) {
        stripTabs = /^<<-/.test(m[0]);
        delimiter = m[0].replace(/^<<-?[ \t]*/, '').replace(/[\\"']/g, '');
      }
    }
    if (/@'[ \t]*\r?$/.test(original)) pd = true;
  }
  return out;
}

/** bash 94 — the flag/value pairs whose value must be hidden from the splitter. */
const REQUIRE_FLAG_VALUE_RE =
  /(-[Cc]|--(git-dir|work-tree|namespace|super-prefix|config-env|attr-source))[ \t]+("[^"]*"|'[^']*')|=("[^"]*"|'[^']*')/g;
/** bash 96-97 — `… git --git-dir="…"`: the text before the `=` must end in git. */
const FLAG_EQ_OK_RE =
  /(^|[ \t;&|(){`"'])([^ \t;&|(){`"']*[/\\])?[Gg][Ii][Tt](\.exe)?([ \t]+[^ \t;&|(){`"']+)+$/;
/** bash 98-100 — `… git -C "…"`: same, with the flag still attached. */
const FLAG_SPACE_OK_RE =
  /(^|[ \t;&|(){`"'])([^ \t;&|(){`"']*[/\\])?[Gg][Ii][Tt](\.exe)?([ \t]+[^ \t;&|(){`"']+)*[ \t]+$/;
/** bash 117 — a quoted word with nothing inside a shell would split on. */
const QUOTED_WORD_RE = /"[^" \t;&|()`]*"|'[^' \t;&|()`]*'/g;

/**
 * bash 90-123 — normalise one line, then split it into the command segments a
 * shell would actually run (every `&&`, `;`, `|`, quote … becomes a line break).
 */
function normalizeLine(line) {
  let s = line;
  // bash 92-93: a quoted path ending in `git` is that git.
  s = s.replace(/"([^"]*[/\\])?[Gg][Ii][Tt](\.exe)?"/g, 'git');
  s = s.replace(/'([^']*[/\\])?[Gg][Ii][Tt](\.exe)?'/g, 'git');
  // bash 93: `$(…)` and backticks collapse to one opaque word.
  s = s.replace(/\$\([^ \t;&|()`']*\)|`[^ \t;&|()`']*`/g, '$_');

  // bash 94-105: `git -C "<dir>" push` must not be split at the space inside the
  // path. A matched argument that really belongs to git has its separators
  // replaced with \x01 so the splitter below cannot see them; one that does not
  // is dropped back a character at a time and rescanned.
  let out = '';
  REQUIRE_FLAG_VALUE_RE.lastIndex = 0;
  let m = REQUIRE_FLAG_VALUE_RE.exec(s);
  while (m !== null) {
    const p = out + s.slice(0, m.index);
    const a = m[0];
    const rest = s.slice(m.index + a.length);
    let ok;
    let flag = a;
    if (a.startsWith('=')) {
      flag = '=';
      ok = FLAG_EQ_OK_RE.test(p);
    } else {
      // Keep the flag plus one space, dropping the quoted value (bash 99).
      flag = a.replace(/[ \t]+["'].*$/, ' ');
      ok = FLAG_SPACE_OK_RE.test(p);
    }
    if (!ok) {
      out = p + a.slice(0, 1);
      s = a.slice(1) + rest;
      REQUIRE_FLAG_VALUE_RE.lastIndex = 0;
    } else {
      let v = a;
      v = v.replace(/^[^"']*["']/, '');
      v = v.slice(0, -1);
      v = v.replace(/[ \t;&|()`]/g, '\u0001');
      out = p + flag + v;
      s = rest;
      REQUIRE_FLAG_VALUE_RE.lastIndex = 0;
    }
    m = REQUIRE_FLAG_VALUE_RE.exec(s);
  }
  s = out + s;

  // bash 116-121: unquote a quoted word with nothing inside a shell would split
  // on (a quoted branch name, a quoted refspec). A quoted string that DOES
  // contain such characters is left alone: it may be a whole command meant to
  // fall on its own line for re-inspection.
  out = '';
  QUOTED_WORD_RE.lastIndex = 0;
  let q = QUOTED_WORD_RE.exec(s);
  while (q !== null) {
    out = out + s.slice(0, q.index) + q[0].slice(1, -1);
    s = s.slice(q.index + q[0].length);
    QUOTED_WORD_RE.lastIndex = 0;
    q = QUOTED_WORD_RE.exec(s);
  }
  s = out + s;

  // bash 122: split on command separators.
  s = s.replace(/&&|\|\|/g, '\n');
  return s.replace(/[;&|()`'"]/g, '\n');
}

/**
 * bash 124 — keep the lines whose first command is `git push`; the leading
 * group is the set of wrappers an unwrapped `git` may hide behind (`env sudo …`,
 * `if … then`, `VAR=x`, …).
 *
 * QUIRK, preserved deliberately: bash requires `([[:space:]]|\$)` AFTER the
 * subcommand, so a line that ends exactly at `push` does not match. A bare
 * `git push` therefore yields no PUSH_SEG, and bash 128 (`|| exit 0`) leaves
 * before the current-branch check ever runs. Copied as-is — see the port report.
 */
const GIT_PUSH_RE = new RegExp(
  '^[ \\t\\v\\f\\r]*(?:(?:if|then|else|elif|do|while|until|time|exec|command|nohup|!|\\{)[ \\t\\v\\f\\r]+' +
    '|(?:env|sudo|doas|xargs|nice|timeout|stdbuf|winpty|command)' +
    '(?:[ \\t\\v\\f\\r]+-[A-Za-z0-9-]+(?:=[^ \\t\\v\\f\\r]*)?(?:[ \\t\\v\\f\\r]+[^- \\t\\v\\f\\r][^ \\t\\v\\f\\r]*)?)*' +
    '[ \\t\\v\\f\\r]+(?:[0-9][0-9.]*[smhd]?[ \\t\\v\\f\\r]+)?' +
    '|[A-Za-z_][A-Za-z0-9_]*=[^ \\t\\v\\f\\r]*[ \\t\\v\\f\\r]+)*' +
    '(?:[^ \\t\\v\\f\\r]*[/\\\\])?[Gg][Ii][Tt](?:\\.exe)?' +
    '(?:[ \\t\\v\\f\\r]+(?:-[Cc][ \\t\\v\\f\\r]+[^ \\t\\v\\f\\r]+' +
    '|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source)[ \\t\\v\\f\\r]+[^ \\t\\v\\f\\r]+' +
    '|-[A-Za-z]|--[A-Za-z-]+(?:=[^ \\t\\v\\f\\r]+)?))*' +
    '[ \\t\\v\\f\\r]+push(?:[ \\t\\v\\f\\r]|\\$)',
);

/** `git_segment push "$COMMAND"` — the segments of $COMMAND that run `git push`. */
function gitPushSegments(command) {
  const segments = [];
  for (const line of stripHeredocBodies(joinContinuations(String(command).split('\n')))) {
    for (const part of normalizeLine(line).split('\n')) {
      if (GIT_PUSH_RE.test(part)) segments.push(part);
    }
  }
  return segments;
}

// ------------------------------------------------------------------- hook body

run(async () => {
  const input = readInput();

  // The event name must match the event the hook was actually invoked for: the protocol
  // discards a `hookSpecificOutput` block whose `hookEventName` disagrees with the event.
  // This hook is registered on PreToolUse (it can block) and again on PostToolUse (where the
  // advisory reaches the model, since DSH does not surface a pre-execute systemMessage).
  const event = typeof input?.hook_event_name === 'string' ? input.hook_event_name : EVENT;

  // bash 46, performance: "this hook runs on every Bash and PowerShell call".
  // Most of them do not mention git at all, so leave before doing any work.
  // The bash test is `*'"tool_input"'*git*` over the raw payload: it looks past
  // the `tool_input` key only, so a project path containing "GitHub" or
  // "digital" does not defeat it. The parsed equivalent is the tool_input
  // subtree alone; the whole payload would test cwd/transcript_path as well.
  const toolInput = input?.tool_input;
  if (toolInput === undefined || toolInput === null) return;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!/git/i.test(JSON.stringify(toolInput))) return;

  // bash 128: no `git push` segment -> nothing to check, exit 0.
  const pushSegments = gitPushSegments(command);
  if (pushSegments.length === 0) return;

  const root = projectRoot(input);

  // bash 130. stderr is discarded exactly as `2>/dev/null` did: without that, a
  // "not a git repository" line would be read as the branch name.
  const currentBranch = gitCurrentBranch(root);

  let matched = '';

  // bash 133-147: protected fixed names — pushing FROM them (a relative/remote
  // push while on them), or explicitly TO them: as their own word, or as a
  // refspec's destination (HEAD:main, feature:main, +main, refs/heads/main).
  // `main:feature` pushes TO feature and stays quiet.
  for (const branch of ['main', 'master']) {
    if (currentBranch === branch) {
      matched = branch;
      break;
    }
    const toBranch = new RegExp(`([ \\t\\v\\f\\r+:]|refs/heads/)${branch}([ \\t\\v\\f\\r]|$)`);
    if (pushSegments.some((segment) => toBranch.test(segment))) {
      matched = branch;
      break;
    }
  }

  // bash 149-158: `release/*` is a name pattern, not a fixed branch, so it needs
  // its own checks — pushing FROM a release/* branch, or explicitly TO one.
  if (matched === '') {
    if (/^release\//.test(currentBranch)) matched = currentBranch;
  }
  if (matched === '') {
    const toRelease = new RegExp(
      '([ \\t\\v\\f\\r+:]|refs/heads/)release/[^ \\t\\v\\f\\r:]+([ \\t\\v\\f\\r]|$)',
    );
    if (pushSegments.some((segment) => toRelease.test(segment))) {
      // bash 157: the branch name reported is the first `release/…` text found.
      const hit = /release\/[^ \t\v\f\r:]+/.exec(pushSegments.join('\n'));
      if (hit !== null) matched = hit[0];
    }
  }

  if (matched === '') return;

  // bash 160-175: allow the push, but warn where it is seen. No
  // permissionDecision: "allow" would skip the user's permission prompt — the
  // normal permission flow must still run. `matched` is echoed back as-is (for
  // release/* it can be text taken from the command); JSON string escaping
  // replaces the hand-rolled sed escaping of bash 169.
  const message =
    `Push to protected branch '${matched}' detected. Reminder: Ensure build passes, ` +
    'unit tests pass, and no open bugs the release gate blocks (S1; S1-S3 at workflow: full).';
  emit({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  });
});
