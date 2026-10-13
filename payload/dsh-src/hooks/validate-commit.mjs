/**
 * validate-commit — DSH port of `.claude/hooks/validate-commit.sh` (PreToolUse, matcher
 * `Bash|PowerShell`). The heaviest DSGS gate: it decides which files a `git commit` will
 * actually record and refuses the commit when a BLOCKING check cannot pass.
 *
 * ── CONTRACT SUBSTITUTION (same as `_capture.mjs`, reported not hidden) ──────────────
 *   `runtime.capture()` is unusable on Windows — it wraps every command in POSIX
 *   `{ cmd ; }` syntax and runs it through cmd.exe, which answers
 *   `'{' is not recognized as an internal or external command` and exits 1. Measured in
 *   this repository (Windows/Node 24): `capture('git --version')` fails, and therefore so
 *   does `runtime.resolveConfig()`, which delegates to it. (The same substitution is
 *   documented in `session-stop.mjs`; `runtime.capture()` is used nowhere in the ports.)
 *   This file calls `_capture.mjs`'s `runCommand()`/`git()`, which spawn the program
 *   DIRECTLY with stdout+stderr redirected through a file descriptor into a temp file —
 *   never a pipe (the sandbox denies piped stdio: `spawnSync cmd.exe EPERM`).
 *
 * ── PRESERVED SEMANTICS (PORTING.md §"移植行为准则" 1–2) ─────────────────────────────
 *  * Project-root precedence: cwd holding project.yaml/.dsh wins, then the payload cwd,
 *    then this script's location. Never an upward search.
 *  * Early exit: only after `"tool_input"` AND a case-insensitive `git` anywhere in the
 *    payload — a project path containing "GitHub" cannot take it.
 *  * Command decoding: when jq is unavailable the shell decoded `\\` FIRST (through a
 *    placeholder), then `\r`, `\t`, `\n`, `\"`. Decoding `\\` after `\r` ate the `r` of
 *    `C:\\Users\\me\\review`. Node's JSON.parse does this correctly for free; the bash
 *    grep fallback ladder is not reproduced because JSON.parse is the jq branch.
 *  * `git_segment()`: segment splitting on `&& || ; & | ( ) \` " '` and newlines, with
 *    line-continuation joining, here-document dropping (a here-doc that runs an
 *    interpreter is KEPT), PowerShell `@'...'@` here-strings dropped and `@"..."@` kept,
 *    quoted git paths normalised to plain `git`, quoted values of git's own value-taking
 *    options unquoted with their spaces and operators carried as \u0001, quoted words
 *    unquoted in place…
 *  * `git -C <dir> commit`: allowed only when `<dir>` PROVABLY resolves to another
 *    repository; the check fires only when exactly one commit invocation was found.
 *  * Explicit pathspecs (`git commit -m x src/player.gd`) record only those paths, so the
 *    working-tree copy is read for them and the INDEX is excluded (`DSGS-ONLY`).
 *  * BLOCKING check first: staged/working JSON under an asset root's `data/` directory must
 *    parse. Every offender is named at once. A file whose staged blob cannot be read is
 *    reported as a failure, never skipped.
 *  * Advisory checks: GDD required sections by `modes.workflow` tier; hardcoded gameplay
 *    values in the resolved code root; TODO/FIXME/HACK without an owner tag.
 *  * A check that cannot run ANNOUNCES ITSELF (`SKIPPED: …`); it never reports clean.
 *  * Exit 2 (via `block()`, stderr = the model-visible reason) for the blocking paths;
 *    exit 0 with a warning payload for the advisory ones.
 *
 * ── DELIBERATE DEVIATIONS ───────────────────────────────────────────────────────────
 *  1. Python is gone. The original spawned Python 3 for the JSON scan and the GDD
 *     section scan and BLOCKED (`no Python 3 interpreter found`) when it was missing.
 *     Both scans are native here, so the "no Python" block no longer exists — the
 *     protection is strictly stronger (the check always runs) and cannot be lost.
 *  2. `resolveConfig()` / `runtime.capture()` are replaced by `runCommand(process.execPath,
 *     ['tools/yaml-helper.mjs', '__call', …])` — the same helper the bash hook sourced,
 *     so `resolve_setting`/`resolve_code_root` (legacy + rigor + detection fallbacks) are
 *     the authoritative readers, not the public `resolve_config` block.
 *  3. `git cat-file --batch` (all staged blobs in ONE process through piped stdin) is not
 *     reachable without a pipe; each staged path is read with `git show :<path>` instead.
 *     One git process per staged data file rather than one for all of them.
 *  4. The Python tokeniser's `away` computation is ported faithfully, but the final
 *     "is this commit path-limited" decision does NOT require it to have read every
 *     commit in the command: if ANY invocation in the segment stages everything or
 *     records only specific paths, the checks widen to `:/` (index + working tree).
 *     Over-checking is the safe direction; under-checking was the documented bypass
 *     (`git -C other commit && git commit` slipped through unchecked).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand, git } from './_capture.mjs';
import { readInput, projectRoot, run, warn, block } from './runtime.mjs';

const EVENT = 'PreToolUse';

// ---------------------------------------------------------------------------
// git_segment() — `.claude/hooks/validate-commit.sh` lines 68–176, transplanted
// from awk to JS statement for statement. See the source's comment block for the
// history each branch encodes; the notes here only mark the translation.
// ---------------------------------------------------------------------------

/** Split a string on the shell's operator characters, the way awk's `gsub` did. */
function splitOnOperators(line) {
  const parts = [];
  let rest = line;
  while (rest.length > 0) {
    let at = -1;
    let len = 0;
    const two = rest.search(/&&|\|\|/);
    const one = rest.search(/[;&|()`"']/);
    if (two !== -1 && (one === -1 || two <= one)) {
      at = two;
      len = 2;
    } else if (one !== -1) {
      at = one;
      len = 1;
    }
    if (at === -1) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + len);
  }
  return parts;
}

/** True when `line` before offset `end` leaves a quote open (awk's `q` state). */
function quoteOpenBefore(line, end) {
  let q = '';
  for (let i = 0; i < end; i += 1) {
    const c = line[i];
    if (q === '') {
      if (c === '"' || c === "'") q = c;
    } else if (c === q || (q === '"' && c === '$' && line[i + 1] === '(')) {
      q = '';
    }
  }
  return q !== '';
}

/** The interpreter alternation of stage 1's here-doc guard, statement for statement. */
function lineRunsInterpreter(line) {
  const re = /(^|[^A-Za-z0-9_.-])(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|python[0-9.]*|py|node|ruby|perl|php|eval|source)([ \t]|$)/;
  return re.test(line);
}

/** Stage 1: join `\`-continued lines, drop here-doc bodies and `@'…'@` here-strings. */
function joinAndDropBodies(lines) {
  const joined = [];
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
    joined.push(line);
  }

  const kept = [];
  let psPending = false;
  let hereDelim = '';
  let hereTabs = false;
  for (const raw of joined) {
    const text = raw.replace(/\r$/, '');
    if (psPending) {
      if (/^'@/.test(text)) psPending = false;
      continue;
    }
    if (hereDelim !== '') {
      let t = text;
      if (hereTabs) t = t.replace(/^\t+/, '');
      if (t === hereDelim) hereDelim = '';
      continue;
    }
    kept.push(text);

    const m = /<<-?[ \t]*("[^"]*"|'[^']*'|\\?[A-Za-z_][^ \t\r;&|()<>"'\\]*)/.exec(text);
    if (
      m !== null
      && text[m.index - 1] !== '<'
      && !/\$\(\([^)]*$/.test(text.slice(0, m.index))
      && !lineRunsInterpreter(text)
    ) {
      if (!quoteOpenBefore(text, m.index)) {
        let d = m[0];
        hereTabs = d.startsWith('<<-');
        d = d.replace(/^<<-?[ \t]*/, '');
        d = d.replace(/[\\"']/g, '');
        hereDelim = d;
      }
    }
    if (/@'[ \t]*\r?$/.test(text)) psPending = true;
  }
  return kept;
}

/**
 * Does `prefix` end as the run-up to git — the `ok` test of stage 2's option loop?
 * `glued` selects the original's regex: the `=` form (`--work-tree="v"`, prefix ends
 * after `git <word>=`) or the separate-value form (`-C "v"`, prefix ends with the
 * whitespace that precedes the quoted value). Both regexes are the original's, with
 * POSIX classes expanded.
 */
function gitPrefixOk(prefix, glued) {
  const prefixGlued = /(^|[ \t;&|(){`'])([^ \t;&|(){`']*[/\\])?[Gg][Ii][Tt](\.exe)?([ \t]+[^ \t;&|(){`']+)+$/;
  const prefixSeparate = /(^|[ \t;&|(){`'])([^ \t;&|(){`']*[/\\])?[Gg][Ii][Tt](\.exe)?([ \t]+[^ \t;&|(){`']+)*[ \t]+$/;
  return glued ? prefixGlued.test(prefix) : prefixSeparate.test(prefix);
}

/** Stage 2: git paths by name, git's quoted option values unquoted, quoted words unquoted. */
function normaliseGitWords(line) {
  let s = line;
  s = s.replace(/"([^"]*[/\\])?[Gg][Ii][Tt](\.exe)?"/g, 'git');
  s = s.replace(/'([^']*[/\\])?[Gg][Ii][Tt](\.exe)?'/g, 'git');
  s = s.replace(/\$\([^ \t;&|()`"']*\)|`[^ \t;&|()`"']*`/g, '$_');

  // The option-value loop. A failed look-behind emits one literal character and
  // re-runs the match on the remainder, exactly like the awk's `out = p substr(a,1,1)`.
  const option = /(-[Cc]|--(git-dir|work-tree|namespace|super-prefix|config-env|attr-source))[ \t]+("[^"]*"|'[^']*')|=("[^"]*"|'[^']*')/;
  let out = '';
  let rest = s;
  for (;;) {
    const m = option.exec(rest);
    if (m === null) break;
    const prefix = out + rest.slice(0, m.index);
    const token = m[0];
    const glued = /^(-[Cc]|--[a-z-]+)=/.test(token);
    if (!gitPrefixOk(prefix, glued)) {
      out = prefix + token[0];
      rest = token.slice(1) + rest.slice(m.index + token.length);
      continue;
    }
    const quote = token.indexOf('"') === -1 ? token.indexOf("'") : token.indexOf('"');
    const value = token.slice(quote + 1, token.length - 1).replace(/[ \t;&|()`]/g, '\u0001');
    out = prefix + (glued
      ? `${token.slice(0, token.indexOf('='))}=${value}`
      : `${token.slice(0, token.search(/[ \t]/))} ${value}`);
    rest = rest.slice(m.index + token.length);
  }
  s = out + rest;

  // Quoted WORDs with nothing shell-meaningful inside are unquoted in place; a quoted
  // string that DOES contain one is left for the caller's operator split.
  s = s.replace(/"[^" \t;&|()`]*"|'[^' \t;&|()`]*'/g, (word) => word.slice(1, -1));
  return s;
}

/** The `git commit …` line filter of stage 3. POSIX classes expanded by hand. */
function filterGitCommitLines(lines, subcommand) {
  const tail = `[ \\t]+${subcommand}([ \\t]|$)`;
  const gitWord = '([^ \\t]*[/\\\\])?[Gg][Ii][Tt](\\.exe)?';
  const optValue = `(-[Cc][ \\t]+[^ \\t]+|--(git-dir|work-tree|namespace|super-prefix|config-env|attr-source)[ \\t]+[^ \\t]+|-[A-Za-z]|--[A-Za-z-]+(=[^ \\t]+)?)`;
  const gitWithOpts = `${gitWord}([ \\t]+${optValue})*`;
  const envPrefix = '(env|sudo|doas|xargs|nice|timeout|stdbuf|winpty|command)([ \\t]+-[A-Za-z0-9-]+(=[^ \\t]*)?([ \\t]+[^- \\t][^ \\t]*)?)*[ \\t]+([0-9][0-9.]*[smhd]?[ \\t]+)?';
  const assignPrefix = '[A-Za-z_][A-Za-z0-9_]*=[^ \\t]*[ \\t]+';
  const keywordPrefix = '(if|then|else|elif|do|while|until|time|exec|command|nohup|!|[{])[ \\t]+';
  const re = new RegExp(`^[ \\t]*((${keywordPrefix})|(${envPrefix})|(${assignPrefix}))*${gitWithOpts}${tail}`);
  const found = [];
  for (const line of lines) {
    if (re.test(line)) found.push(line);
  }
  return found;
}

/** `git_segment <subcommand> <command>` — returns the matching lines, '' when none. */
function gitSegment(subcommand, command) {
  const lines = String(command ?? '').split('\n');
  const stage1 = joinAndDropBodies(lines);
  const stage2 = [];
  for (const line of stage1) {
    for (const piece of normaliseGitWords(line).split('\n')) stage2.push(piece);
  }
  const stage3 = [];
  for (const line of stage2) {
    for (const piece of splitOnOperators(line)) stage3.push(piece);
  }
  return filterGitCommitLines(stage3, subcommand);
}

// ---------------------------------------------------------------------------
// POSIX shlex emulation (the Python tokeniser's `words()`)
// ---------------------------------------------------------------------------

const OP_CHARS = new Set([';', '&', '|', '(', ')', '<', '>']);
/** Python 3.12 punctuation grouping: run of operator chars that are all the same. */
function punctGroup(text, start) {
  const c = text[start];
  if (!OP_CHARS.has(c)) return [c, 1];
  if (c === '{' || c === '}') return [c, 1];
  let end = start + 1;
  while (end < text.length && text[end] === c) end += 1;
  return [text.slice(start, end), end - start];
}

/** `shlex.shlex(posix=True, punctuation_chars=True)` with `whitespace_split`. */
function shlexWords(line) {
  const words = [];
  let buf = '';
  let started = false;
  const flush = () => {
    if (started) {
      words.push(buf);
      buf = '';
      started = false;
    }
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < line.length) {
        buf += line[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      started = true;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null; // unclosed quote: the caller falls back to whitespace split
      buf += line.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          buf += line[j + 1];
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          closed = true;
          break;
        }
        buf += line[j];
        j += 1;
      }
      if (!closed) return null;
      started = true;
      i = j + 1;
      continue;
    }
    const [group, len] = punctGroup(line, i);
    if (OP_CHARS.has(ch)) {
      flush();
      words.push(group);
      i += len;
      continue;
    }
    buf += group;
    started = true;
    i += len;
  }
  flush();
  return words;
}

function tokenise(line) {
  const words = shlexWords(line);
  if (words !== null) return words;
  return line.split(/\s+/).filter((w) => w.length > 0);
}

// ---------------------------------------------------------------------------
// The Python tokeniser of `.claude/hooks/validate-commit.sh` lines 265–348.
// ---------------------------------------------------------------------------

const GIT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
const COMMIT_ARG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file']);
const REDIR_RE = /^[<>]+&?$|^&>+$/;
const OPS_SET = new Set([';', '&', '|', '(', ')', '<', '>']);
const VALUE_FLAGS = new Set(['m', 'F', 'C', 'c', 't']);

/** True for a token that is exactly a run of operator characters. */
function isOperatorWord(word) {
  if (word.length === 0) return false;
  for (const ch of word) {
    if (!OPS_SET.has(ch)) return false;
  }
  return true;
}

function isGitWord(word) {
  const base = word.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return base === 'git' || base === 'git.exe';
}

/**
 * Walk the tokenised command for every `git … commit`, collecting the pathspecs that
 * commit records and whether anything makes it record more than those paths.
 * `root` is the project root: the original tokeniser asked git from there, and asking
 * from anywhere else resolves the pathspec against the wrong tree.
 * @returns {{specs: string[], commits: number, only: boolean, away: boolean, stagedAll: boolean}}
 */
function collectCommits(command, awayFromCwd, root) {
  let away = awayFromCwd
    || /(^|[^\w.-])(cd|pushd|popd)(\s|[;&|)]|$)/m.test(command);
  const specs = [];
  let commits = 0;
  let stagedAll = false;
  let everyCommitPathLimited = true;

  for (const line of command.split('\n')) {
    const w = tokenise(line);
    let i = 0;
    while (i < w.length) {
      if (!isGitWord(w[i])) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < w.length && w[j].startsWith('-')) {
        if (w[j] === '-C' || w[j] === '--git-dir' || w[j] === '--work-tree'
          || w[j].startsWith('--git-dir=') || w[j].startsWith('--work-tree=')) {
          away = true;
        }
        j += GIT_ARG.has(w[j]) ? 2 : 1;
      }
      if (j >= w.length || w[j] !== 'commit') {
        i = j;
        continue;
      }
      commits += 1;
      let k = j + 1;
      let rest = false;
      let index = false;
      const mine = [];
      while (k < w.length) {
        const a = w[k];
        // `2>&1` arrives as `2`, `>`, `&`, `1`: the digit and the redirection pair go.
        if (/^[0-9]+$/.test(a) && k + 1 < w.length && '<>'.includes(w[k + 1][0])) {
          k += 1;
          break;
        }
        if (REDIR_RE.test(a)) {
          k += 2;
          if (k > w.length) break;
          continue;
        }
        if (isOperatorWord(a)) break;
        if (rest || !a.startsWith('-') || a === '-') {
          mine.push(a);
        } else if (a === '--') {
          rest = true;
        } else if (a.startsWith('--')) {
          if (a === '--all' || a.startsWith('--pathspec-from-file')) mine.push(':/');
          if (a === '--all' || a === '--include' || a === '--patch' || a === '--interactive'
            || a.startsWith('--pathspec-from-file')) index = true;
          if (COMMIT_ARG.has(a)) k += 1;
        } else {
          const chars = a.slice(1);
          for (let n = 0; n < chars.length; n += 1) {
            const ch = chars[n];
            if (VALUE_FLAGS.has(ch)) {
              if (n === chars.length - 1) k += 1;
              break;
            }
            if (ch === 'u' || ch === 'S') break;
            if (ch === 'a') mine.push(':/');
            if ('aip'.includes(ch)) index = true;
          }
        }
        k += 1;
      }
      for (const spec of mine) specs.push(spec);
      if (!(mine.length > 0 && !index)) everyCommitPathLimited = false;
      if (index || mine.includes(':/')) stagedAll = true;
      i = k;
    }
  }

  let onlyPaths = everyCommitPathLimited;
  if (specs.length > 0 && !away) {
    away = git(['ls-files', '--error-unmatch', '--', ...specs], { cwd: root }).status !== 0;
  }
  if (specs.length > 0 && away) {
    specs.push(':/');
    onlyPaths = false;
  }
  const commitWords = (command.match(/(?<![\w.-])commit(?![\w-])/g) ?? []).length;
  const only = onlyPaths && commits > 0 && commitWords === commits;
  return { specs, commits, only, away, stagedAll };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-empty lines of a capture, as an array (the `grep -v '^$'` + `sort -u` shape). */
function lines(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function uniqueSorted(values) {
  return [...new Set(values)].filter((v) => v.length > 0).sort();
}

/** Write `text` to a private temp file; returns { path, cleanup }. */
function scratchFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'DSGS-commit-'));
  const file = join(dir, 'data.txt');
  writeFileSync(file, text, 'utf8');
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Read a staged blob with `git show :<path>`; null when the index has no such entry. */
function readIndexFile(root, path) {
  const result = git(['show', `:${path}`], { cwd: root });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Read a working-tree file as a string; null when it is unreadable. */
function readWorktreeFile(root, path) {
  try {
    const full = isAbsolute(path) ? path : join(root, path);
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** `resolve_setting` / `resolve_code_root` through the same helper the bash sourced. */
function helperCall(root, fn, ...args) {
  const helper = join(root, 'tools', 'yaml-helper.mjs');
  if (!existsSync(helper)) return null;
  const result = runCommand(process.execPath, ['tools/yaml-helper.mjs', '__call', fn, ...args], {
    cwd: root,
    timeoutMs: 15_000,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Is the payload's cwd the same directory as the resolved project root? */
function sameDirectory(a, b) {
  try {
    return resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** BLOCKING: every staged/committed JSON file under an asset `data/` root must parse. */
function jsonCheck(root, staged, wtFiles) {
  const dataFiles = staged.filter((p) => /^(assets|Assets|Content)\/(.*\/)?[Dd]ata\/.*\.json$/i.test(p));
  if (dataFiles.length === 0) return;
  const workingSet = new Set(wtFiles);
  const unreadable = [];
  const bad = [];
  for (const path of dataFiles) {
    let text;
    if (workingSet.has(path)) {
      text = readWorktreeFile(root, path);
      if (text === null) continue; // deleted from the working tree: nothing of it is committed
    } else {
      text = readIndexFile(root, path);
      if (text === null) {
        unreadable.push(path);
        continue;
      }
    }
    try {
      JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      bad.push(path);
    }
  }
  if (unreadable.length > 0) {
    block(
      `BLOCKED: ${unreadable.length} staged data file(s) could not be read from the index, so the `
      + 'JSON check could NOT run on them. Check the repository state and commit again.\n'
      + unreadable.map((p) => `BLOCKED: ${p} could not be read from the git index`).join('\n'),
    );
  }
  if (bad.length > 0) {
    block(bad.map((p) => `BLOCKED: ${p} is not valid JSON`).join('\n'));
  }
}

/** ADVISORY: staged GDDs must contain the sections their workflow tier requires. */
function designSectionCheck(root, staged, warnings) {
  const designFiles = staged.filter((p) => p.startsWith('design/gdd/'));
  if (designFiles.length === 0) return;

  let workflow = 'standard';
  const resolved = helperCall(root, 'resolve_setting', 'modes.workflow');
  if (resolved !== null) {
    const first = resolved.split('\t')[0].split('\n')[0].trim();
    if (first.length > 0) workflow = first;
  }

  let required = [];
  if (workflow === 'minimal') required = [];
  else if (workflow === 'full') {
    required = ['Overview', 'Player Fantasy', 'Detailed', 'Formulas', 'Edge Cases', 'Dependencies', 'Tuning Knobs', 'Acceptance Criteria'];
  } else {
    required = ['Overview', 'Detailed', 'Edge Cases', 'Dependencies', 'Acceptance Criteria'];
  }
  if (required.length === 0) return;

  let ran = false;
  for (const path of designFiles) {
    if (!path.toLowerCase().endsWith('.md')) continue;
    const text = readWorktreeFile(root, path);
    if (text === null) continue;
    ran = true;
    const lower = text.toLowerCase();
    for (const section of required) {
      if (!lower.includes(section.toLowerCase())) {
        warnings.push(`DESIGN: ${path} missing section required at workflow=${workflow}: ${section}`);
      }
    }
  }
  if (!ran) {
    warnings.push(
      'SKIPPED: the staged design doc(s) could not be read, so the GDD section check did NOT run.',
    );
  }
}

/** ADVISORY: hardcoded gameplay values and unowned TODOs inside the code root. */
function codeChecks(root, staged, warnings) {
  let codeRoot = '';
  const resolved = helperCall(root, 'resolve_code_root');
  if (resolved !== null) codeRoot = resolved.split('\t')[0].split('\n')[0].trim();

  if (codeRoot === '') {
    const sourceStaged = staged.some((p) => /\.(gd|cs|cpp|cc|hpp|h|c|py|js|ts|rs|java|kt|lua|gdshader|shader|hlsl)$/i.test(p));
    if (sourceStaged) {
      warnings.push(
        'SKIPPED: source files are staged but no code root could be resolved (engine.name unset, '
        + 'and the tree does not name one unambiguously). The hardcoded-value and TODO-owner scans '
        + 'did NOT run. Run /setup-engine, or set engine.name in project.yaml.',
      );
    }
    return;
  }

  const prefix = `${codeRoot}/`;
  const underRoot = staged.filter((p) => p.startsWith(prefix));

  const codeFiles = underRoot.filter((p) => /\.(gd|cs|cpp|cc|hpp|h|c|py|js|ts|rs|java|kt|lua)$/i.test(p));
  const hardcoded = /(damage|health|speed|rate|chance|cost|duration)[ \t]*[:=][ \t]*[0-9]+/;
  for (const path of codeFiles) {
    const text = readWorktreeFile(root, path);
    if (text === null) continue;
    if (text.split('\n').some((line) => hardcoded.test(line))) {
      warnings.push(`CODE: ${path} may contain hardcoded gameplay values. Use data files.`);
    }
  }

  const unowned = /(TODO|FIXME|HACK)[^(]/;
  for (const path of underRoot) {
    const text = readWorktreeFile(root, path);
    if (text === null) continue;
    if (text.split('\n').some((line) => unowned.test(line))) {
      warnings.push(`STYLE: ${path} has TODO/FIXME without owner tag. Use TODO(name) format.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

run(async () => {
  const input = readInput();
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : EVENT;

  // Early exit: the test runs on the serialised payload AFTER the `"tool_input"` key, so a
  // project path containing "GitHub" or "digital" (which lives in cwd, before the key)
  // never took this exit and paid for the full parse on every call.
  const raw = JSON.stringify(input ?? {}) ?? '';
  const afterToolInput = raw.slice(raw.indexOf('"tool_input"'));
  if (!raw.includes('"tool_input"') || !/git/i.test(afterToolInput)) return;

  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (command.length === 0) return;

  const root = projectRoot(input);

  const commitSegs = gitSegment('commit', command);
  if (commitSegs.length === 0) return;
  const segText = commitSegs.join('\n');

  // `git -C <dir> commit` records whatever repository <dir> is in; another repository is
  // not ours to check. Leave only when <dir> PROVABLY is another repository, and only
  // when exactly one commit invocation was found.
  if (lines(segText).length === 1) {
    const opts = segText.split(/[ \t]commit/)[0] ?? '';
    if (/-C/.test(opts)) {
      const m = /[ \t]-C[ \t]+([^ \t]+)/.exec(` ${opts}`);
      if (m !== null) {
        const cDir = m[1].replace(/\u0001/g, ' ');
        const other = git(['-C', cDir, 'rev-parse', '--show-toplevel'], { cwd: root });
        const ourTop = git(['rev-parse', '--show-toplevel'], { cwd: root });
        const otherTop = other.status === 0 ? other.stdout.trim() : '';
        const ourRoot = ourTop.status === 0 ? ourTop.stdout.trim() : '';
        if (otherTop.length > 0 && ourRoot.length > 0 && !sameDirectory(otherTop, ourRoot)) return;
      }
    }
  }

  // --- which files will this commit record? ---------------------------------
  // A plain commit records the INDEX. `-a`/`--all` (or a cluster such as -am) also commits
  // every modified tracked file, and `git commit <path>` records the named paths' WORKING
  // copies, staged or not — that last case is why the index is dropped below.
  // core.quotePath=false: without it a non-ASCII path comes back quoted
  // ("assets/data/caf\303\251.json") and no pattern below matches it.
  const commitArgs = segText.includes(' commit') ? ` ${segText.slice(segText.indexOf(' commit') + 7)}` : '';
  let indexFiles = uniqueSorted(lines(git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only'], { cwd: root }).stdout));
  let wtFiles = [];
  if (/[ \t](-[ABDEGHIJKLMNOPQRTUVWXYZbdefghijklnopqrsvwxyz]*a[A-Za-z]*|--all)([ \t]|$)/.test(commitArgs)) {
    wtFiles = lines(git(['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd: root }).stdout);
  }

  const cwdRaw = typeof input.cwd === 'string' ? input.cwd : '';
  const awayInitial = cwdRaw.length > 0 && !sameDirectory(cwdRaw, root);
  const collected = collectCommits(segText, awayInitial, root);
  const specified = uniqueSorted(collected.specs);
  const diffPath = (extra) => lines(git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--', ...extra], { cwd: root }).stdout);

  let pathLimited = collected.only;
  if (specified.length > 0) {
    if (pathLimited) {
      // Path-limited: `git commit --dry-run` lists nothing but these paths, so a broken
      // file staged for later must not block. Read the WORKING copy of each (`src/` here
      // resolves where the commit runs; `:/` already widened the specs when it could not).
      const cwdRelative = specified.some((p) => p.startsWith('../'));
      if (collected.away || cwdRelative) {
        pathLimited = false;
        wtFiles = wtFiles.concat(diffPath(specified));
      } else {
        indexFiles = [];
        const out = git(['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD', '--', ...specified], { cwd: root });
        wtFiles = wtFiles.concat(out.status === 0 ? lines(out.stdout) : diffPath(specified));
      }
    } else {
      wtFiles = wtFiles.concat(diffPath(specified));
    }
  }

  // Non-literals the tokeniser could not expand are handled by widening, never by
  // narrowing: a `:/` pathspec (or `--all`) stages everything, and when several commits
  // were chained the union of index and working tree is checked.
  if (collected.stagedAll) {
    wtFiles = wtFiles.concat(lines(git(['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd: root }).stdout));
  }
  wtFiles = uniqueSorted(wtFiles);

  const staged = uniqueSorted(indexFiles.concat(wtFiles));
  if (staged.length === 0) return;

  // --- BLOCKING check first (a starved hook must have done the part that matters) ---
  jsonCheck(root, staged, wtFiles);

  // --- advisory checks -------------------------------------------------------
  const warnings = [];
  designSectionCheck(root, staged, warnings);
  codeChecks(root, staged, warnings);

  if (warnings.length > 0) {
    warn(event, `=== Commit Validation Warnings ===\n${warnings.join('\n')}\n================================`);
  }
});

export { gitSegment, shlexWords, collectCommits };


