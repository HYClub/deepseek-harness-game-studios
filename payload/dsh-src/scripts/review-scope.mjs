#!/usr/bin/env node
/**
 * review-scope.mjs — Node port of `.claude/scripts/review-scope.sh`.
 *
 * compute the GDD scope for an incremental cross-GDD review.
 *
 * Replaces the git archaeology /review-all-gdds would otherwise reason through:
 * finds the most recent cross-review report, lists GDDs changed since it, and
 * lists each changed GDD's declared dependencies (which must also be in scope).
 *
 * Usage: node .dsh/scripts/review-scope.mjs
 *
 * Output:
 *   PRIOR_REVIEW: <path>          (or "NONE (full review required)")
 *   CHANGED:                      GDDs modified since that review
 *   DEPS ...:                     declared .md dependencies of the changed GDDs
 *
 * CORRECTNESS NOTES — three silent-data-loss bugs were fixed when porting the
 * shell version. All three dropped files without warning, which in a review tool
 * means a changed design doc quietly escapes review:
 *
 *   1. git pathspecs are fnmatch WITHOUT FNM_PATHNAME, so `*` crosses `/`:
 *      'design/gdd/*.md' also matched design/gdd/reviews/*.md, pulling the
 *      review logs this script writes into the review scope. Fixed with
 *      :(glob) magic, which restricts * to one path segment.
 *   2. `git status --porcelain | awk '{print $NF}'` mangles any path containing
 *      a space (returns the trailing fragment) and returns the wrong field for
 *      renames (`R old -> new`). Fixed with -z, which disables quoting entirely.
 *   3. `for f in $changed` word-splits on IFS and glob-expands, so a GDD whose
 *      filename contains a space was split into two nonexistent paths and
 *      silently discarded. Fixed with `while IFS= read -r`.
 *
 * All three fixes are preserved here: pathspecs keep the `:(glob)` magic, git
 * status is parsed from NUL-delimited porcelain output, and paths are handled as
 * whole array elements. Git is invoked through `runCommand()` (no shell, no pipe)
 * because the DSH sandbox denies piped child stdio and cannot start Git Bash;
 * passing arguments as an array also means no caller-side word splitting can
 * reintroduce bug 3, and the `:(glob)` prefix and `--` reach git literally.
 *
 * PORT NOTE: the shell original started with `cd "$(dirname "$0")/../.."` and
 * then used repo-relative paths in both git and the filesystem. This port does
 * not chdir; it derives the same root from `import.meta.dirname` and joins it to
 * every path, which keeps the identical result while making the cwd irrelevant.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../hooks/_capture.mjs';
import { baseName, normPath, readTextOr, splitLines, walkFiles } from './_fsutil.mjs';

const GDD_GLOB = ':(glob)design/gdd/*.md';

/**
 * Single definition — this list is needed at three call sites and is exactly the
 * kind of thing that drifts when copied.
 * @param {string} path
 * @returns {boolean} true when the file is NOT a per-system GDD
 */
function notASystemGdd(path) {
  const name = baseName(path);
  return [
    'game-concept.md',
    'systems-index.md',
    'game-pillars.md',
    'gameplay-tags.md',
    'fixture-swap-ledger.md',
    'entity-registry.md',
    'sound-bible.md',
  ].includes(name) || /^gdd-cross-review-.*\.md$/.test(name);
}

/**
 * `find design/gdd -maxdepth 1 -name '*.md' -type f | sed 's|\\|/|g' | sort` —
 * repo-relative forward-slash paths, so the output never depends on where the
 * project lives on disk.
 * @param {string} root absolute project root
 * @returns {string[]}
 */
function gddFiles(root, nameMatches) {
  const prefix = `${normPath(root)}/`;
  return walkFiles(join(root, 'design', 'gdd'), { maxDepth: 1, nameMatches })
    .map((absolute) => normPath(absolute))
    .map((absolute) => (absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute));
}

/** `find design/gdd -maxdepth 1 -name '*.md' -type f | sort`, system GDDs only. */
function allGdds(root) {
  return gddFiles(root, (name) => name.endsWith('.md'))
    .sort()
    .filter((path) => !notASystemGdd(path));
}

/** Run git in the project root; returns '' on any failure, like `2>/dev/null`. */
function git(root, args) {
  const result = runCommand('git', args, { cwd: root, timeoutMs: 30_000 });
  return result.status === 0 ? result.stdout : '';
}

/**
 * GDDs changed since `base`, unioned with the uncommitted ones, as
 * repo-relative forward-slash paths.
 *
 * `git status --porcelain -z` emits NUL-delimited, unquoted entries. Each entry
 * starts with the two-character status field followed by a space, so `cut -c4-`
 * strips exactly that prefix and keeps a path containing spaces intact. For a
 * rename, -z emits new NUL old, so the first of each pair is the new name, which
 * is what we want. The shell original piped -z through `tr '\0' '\n'` and then
 * `cut -c4-`; the NUL split is done here directly, and an entry whose status
 * field is not followed by the separator is ignored rather than mangled.
 * @param {string} root
 * @param {string} base commit hash
 * @returns {string[]} sorted, unique
 */
function changedSince(root, base) {
  const out = [];
  const diff = git(root, ['diff', '--name-only', base, '--', GDD_GLOB]);
  for (const line of splitLines(diff)) {
    if (line !== '') out.push(normPath(line));
  }
  const status = runCommand('git', ['status', '--porcelain', '-z', '--', GDD_GLOB], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (status.status === 0) {
    for (const entry of status.stdout.split('\0')) {
      if (entry.length < 4) continue;
      if (entry[2] !== ' ') continue;
      out.push(normPath(entry.slice(3)));
    }
  }
  return [...new Set(out)].sort();
}

/**
 * `find design/gdd -maxdepth 1 -name '*.md' -type f -newer "$last_review"` — the
 * fallback for a prior review that was never committed. mtime is used ONLY
 * here, and only because the shell original used it here: the report's ISO 8601
 * date in the filename is the ordering that survives being cloned, which is why
 * `last_review` does not use mtime.
 * @param {string} root absolute project root
 * @param {number} referenceMtimeMs
 * @returns {string[]} repo-relative paths, sorted
 */
function changedByMtime(root, referenceMtimeMs) {
  const prefix = `${normPath(root)}/`;
  return walkFiles(join(root, 'design', 'gdd'), {
    maxDepth: 1,
    nameMatches: (name) => name.endsWith('.md'),
  })
    .filter((absolute) => {
      try {
        return statSync(absolute).mtimeMs > referenceMtimeMs;
      } catch {
        return false;
      }
    })
    .sort()
    .map((absolute) => normPath(absolute))
    .map((absolute) => (absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute));
}

/**
 * Declared `.md` dependencies of one GDD: every heading whose text (lowercased,
 * with any leading digits and `.`/`)` stripped) starts with `dependencies`, plus
 * every line under it, scanned for `[A-Za-z0-9_-]+\.md`.
 *
 * The awk program it replaces, for reference (note the `*` after `[.)]` — that
 * sequence is what makes a naive copy of this text into a block comment
 * terminate the comment early):
 *
 *   /^## / {
 *     h = tolower($0)
 *     sub(/^##[ \t]+/, "", h)
 *     sub(/^[0-9]+[.)]?[ \t]+/, "", h)
 *     dep = (h ~ /^dependencies/) ? 1 : 0
 *   }
 *   dep { print }
 *
 * Matches are `sort -u`-ed, so the caller sees each dependency once.
 * @param {string} absolute
 * @returns {string[]}
 */
function declaredDeps(absolute) {
  const text = readTextOr(absolute);
  if (text === '') return [];
  const collected = [];
  let inDeps = false;
  for (const line of splitLines(text)) {
    if (line.startsWith('## ')) {
      const heading = line.toLowerCase().replace(/^##[ \t]+/, '').replace(/^[0-9]+[.)]?[ \t]*/, '');
      inDeps = heading.startsWith('dependencies');
    }
    if (inDeps) collected.push(line);
  }
  const names = new Set();
  for (const line of collected) {
    const re = /[A-Za-z0-9_-]+\.md/g;
    let hit = re.exec(line);
    while (hit !== null) {
      names.add(hit[0]);
      hit = re.exec(line);
    }
  }
  return [...names].sort();
}

/** A path is in scope only while it still names a file (`[ -f "$f" ]`). */
function stillAFile(root, relative) {
  try {
    return existsSync(join(root, relative)) && statSync(join(root, relative)).isFile();
  } catch {
    return false;
  }
}

function main() {
  // `cd "$(dirname "$0")/../.."` — `.dsh/scripts/` and `dsh-src/scripts/` are
  // both two levels below the project root.
  const root = join(import.meta.dirname, '..', '..');

  // `sort | tail -1` is chronological ONLY because the report filename carries an
  // ISO 8601 date. /review-all-gdds states that requirement at the point it asks
  // permission to write the file; if that ever loosens, this line silently picks
  // the wrong baseline and every GDD changed since the real last review escapes
  // the next one -- failure number four, reached from the filename instead of the
  // path handling.
  //
  // Not mtime: on a fresh clone every file carries the checkout time, so `ls -t`
  // here would order the reports arbitrarily. The date in the name is the only
  // ordering that survives being cloned.
  const reviews = gddFiles(root, (name) => name.startsWith('gdd-cross-review-') && name.endsWith('.md'))
    .sort();
  const lastReview = reviews.length === 0 ? '' : reviews[reviews.length - 1];

  if (lastReview === '') {
    process.stdout.write('PRIOR_REVIEW: NONE (full review required)\n');
    process.stdout.write('CHANGED:\n');
    const gdds = allGdds(root);
    if (gdds.length === 0) {
      process.stdout.write('  (no system GDDs found)\n');
    } else {
      for (const gdd of gdds) process.stdout.write(`  ${gdd}\n`);
    }
    return 0;
  }

  process.stdout.write(`PRIOR_REVIEW: ${lastReview}\n`);

  // Prefer git history if the review file is committed; fall back to file mtime.
  const base = git(root, ['log', '-1', '--format=%H', '--', lastReview]);
  let changed;
  if (base !== '') {
    changed = changedSince(root, base);
  } else {
    let mtime = 0;
    try {
      mtime = statSync(join(root, lastReview)).mtimeMs;
    } catch {
      mtime = 0;
    }
    changed = changedByMtime(root, mtime);
  }

  const scope = changed.filter((file) => file !== '' && !notASystemGdd(file) && stillAFile(root, file));

  process.stdout.write('CHANGED:\n');
  if (scope.length === 0) {
    process.stdout.write('  (none — no GDDs modified since last review)\n');
    return 0;
  }
  for (const file of scope) process.stdout.write(`  ${file}\n`);

  process.stdout.write('DEPS (declared in changed GDDs — include these in review scope too):\n');
  for (const file of scope) {
    const deps = declaredDeps(join(root, file));
    if (deps.length === 0) continue;
    for (const dep of deps) process.stdout.write(`  ${baseName(file)} -> ${dep}\n`);
  }
  return 0;
}

process.exitCode = main();
