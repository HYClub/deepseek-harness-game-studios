/**
 * Shared primitives for the ported DSGS helper scripts — internal helper.
 *
 * Source of the ported behaviour: `.claude/scripts/*.sh` (bash + sed/awk/grep).
 * The scripts whose stdout a skill parses (`review-receipts.sh`,
 * `project-coherence.sh`, `review-scope.sh`) were written in POSIX shell, which
 * cannot run in the DSH sandbox, and their text output is a contract the calling
 * skills read. What has to be reproduced here is therefore *text*, not logic:
 * every function below mirrors one specific shell construct, and the comment
 * says which one, because "the same output" is the whole acceptance criterion.
 *
 * Sandbox note (see `dsh-src/hooks/PORTING.md`): subprocesses are run through
 * `../hooks/_capture.mjs` → `runCommand()`, which redirects stdout+stderr into a
 * temp file through a file descriptor. Pipes are denied in this sandbox
 * (`spawnSync git EPERM`), so nothing here may hand text to a child on stdin.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Split file content into lines the way `awk`'s NR walks them (and the way
 * `$( ... )` returns them): a final line without a newline still counts, and a
 * lone trailing newline does NOT produce an extra empty line.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  const normalised = text.replace(/\r\n/g, '\n');
  if (normalised === '') return [];
  const lines = normalised.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Read a file as UTF-8, or '' when it cannot be read (bash `cat` on a missing file with 2>/dev/null). */
export function readTextOr(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * `wc -l < file` — counts NEWLINES, so a file whose last line has no newline
 * reports one less than the number of lines a reader sees. Several scripts do
 * arithmetic on that number (`SPLIT` vs `TOTAL` in `rotate-session-state.sh`),
 * so the difference is load-bearing and is reproduced rather than "fixed".
 * @param {string} text
 * @returns {number}
 */
export function wcLines(text) {
  const matches = text.match(/\n/g);
  return matches === null ? 0 : matches.length;
}

/** True for a regular file (`[ -f ]`). */
export function isFile(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `command -v <name>` — PATH lookup for an executable.
 *
 * Windows-aware: the name is tried verbatim and with each `PATHEXT` suffix,
 * because on Windows the thing `yaml_block_value` hands us is usually
 * `godot` or `Godot_v4.6-stable_win64.exe`, and a bare name lives in PATH as
 * `godot.exe`.
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, platform?: string}} [options]
 * @returns {string} the resolved absolute path, or '' when not found
 */
export function whichOnPath(name, options = {}) {
  if (typeof name !== 'string' || name === '') return '';
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  const exts = platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
    : [''];
  for (const dir of dirs) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (isFile(candidate)) return resolve(candidate);
    }
    // A name that already carries its extension is also a valid hit.
    const plain = join(dir, name);
    if (isFile(plain)) return resolve(plain);
  }
  return '';
}

/**
 * `ls`/`find`-style directory listing of immediate children, files only.
 * @param {string} dir absolute directory
 * @returns {Array<{name: string, path: string}>} empty when the directory is absent
 */
export function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }));
  } catch {
    return [];
  }
}

/**
 * Recursive file walk with an optional depth limit, filtering by name.
 *
 * Mirrors the `find` calls in `project-coherence.sh` (2D-node scan under `src/`)
 * and `review-scope.sh` (`-maxdepth 1 -name '*.md' -type f`). Paths are returned
 * with forward slashes, which is what every one of those scripts does before
 * printing or comparing them (`sed 's|\\|/|g'`).
 * @param {string} dir
 * @param {{maxDepth?: number, nameMatches?: (name: string) => boolean}} [options]
 * @returns {string[]} forward-slash paths, unsorted (the caller sorts)
 */
export function walkFiles(dir, options = {}) {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const matches = options.nameMatches ?? (() => true);
  const out = [];
  const visit = (current, depth) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) visit(full, depth + 1);
      } else if (entry.isFile() && matches(entry.name)) {
        out.push(full.split('\\').join('/'));
      }
    }
  };
  visit(dir, 1);
  return out;
}

/** `sed 's|\\|/|g'` — every script normalises Windows separators before printing a path. */
export function normPath(path) {
  return String(path).replace(/\\/g, '/');
}

/** `basename` from the POSIX shell, applied after path normalisation. */
export function baseName(path) {
  return normPath(path).split('/').pop() ?? '';
}

/** `comm`-free set difference helper used by the section-state comparisons. */
export function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

