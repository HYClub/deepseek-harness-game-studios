/**
 * Shared plumbing for the ported DSGS helper scripts (`dsh-src/scripts/`).
 *
 * These are NOT hooks: the skills call them directly and parse their stdout
 * (`node ".dsh/scripts/<name>.mjs"`), so every script here owns its own exit code
 * and prints plain text — no `hookSpecificOutput`, no `block()`.
 *
 * Where they live: `dsh-src/scripts/*.mjs` is copied verbatim to
 * `.dsh/scripts/*.mjs` by `tools/build-dsh.mjs` (the overlay), and the converter
 * rewrites `bash .dsh/scripts/<name>.sh` in skill bodies to
 * `node ".dsh/scripts/<name>.mjs"` for exactly the basenames present in
 * `dsh-src/scripts/`. `tools/build-dsh.mjs` is not ours to edit, so the port
 * registers itself simply by existing under this directory.
 *
 * Subprocess rule (`dsh-src/hooks/PORTING.md`): child output travels through a
 * temp file, never a pipe — the sandbox denies piped child stdio. Two helpers
 * exist for that:
 *
 *   * `hooks/_capture.mjs` → `runCommand(file, args)` / `git(args)`: an argv-based
 *     spawn with no shell involved. **This is the convention the ports follow**,
 *     because a shell would have to re-parse quoting and Windows has no /bin/sh.
 *   * `hooks/runtime.mjs` → `capture(commandLine)`: a raw shell line redirected to
 *     a temp file (cmd /d /s /c on Windows). It works — it was broken when the
 *     early ports were written, because its wrapper used POSIX `{ cmd ; }` syntax
 *     that cmd.exe cannot parse, and it was fixed on 2026-10-08. Some file headers
 *     in this tree still say "capture() is dead on Windows"; that is historical,
 *     not current.
 *
 * This module used to re-export `capture`; nothing imported it that way, so the
 * re-export is gone. Import the helper you actually need directly.
 *
 * The scripts are expected to run from the generated `.dsh/scripts/` directory,
 * so `rootFromScript()` replaces the bash `cd "$(dirname "$0")/../.."`: it walks
 * up from THIS file's location and takes the first directory holding
 * `project.yaml` or `.dsh/`. That is the same rule `runtime.projectRoot()` uses,
 * minus its dependency on the caller's cwd and on a hook payload, and it leaves
 * the process cwd alone so an explicit `project-root` argument keeps working
 * exactly as the bash originals did.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding this helper — `dsh-src/scripts/` or `.dsh/scripts/`. */
export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The project root, resolved in the same precedence `runtime.projectRoot()` uses:
 *   1. the process cwd, when it holds `project.yaml` or `.dsh/`;
 *   2. otherwise walk up from `start` (default: this file) to the first such
 *      directory.
 * The cwd candidate comes first because a skill may run the helper from anywhere,
 * and a fixture project run from its own directory must read itself rather than
 * the repository that happens to contain the script. The upward walk from the
 * script location is the fallback for the normal case (`.dsh/scripts/` →
 * `.dsh/`), and never runs past the filesystem root.
 * @param {string} [start]
 * @returns {string}
 */
export function rootFromScript(start = SCRIPTS_DIR) {
  const holdsMarker = (dir) => existsSync(resolve(dir, 'project.yaml')) || existsSync(resolve(dir, '.dsh'));
  if (holdsMarker(process.cwd())) return resolve(process.cwd());
  let dir = resolve(start);
  for (;;) {
    if (holdsMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start, '..', '..');
    dir = parent;
  }
}

/** Read a file as UTF-8, or null when it is missing/unreadable. */
export function readText(path) {
  try {
    const bytes = readFileSync(path);
    let text = bytes.toString('utf8');
    // Not everything on a Windows disk is UTF-8. Only when the UTF-8 read is provably broken (replacement
    // characters) do we try GBK, so a correct file is never re-decoded on a guess.
    if (text.includes('\uFFFD')) {
      try {
        const alternative = new TextDecoder('gbk', { fatal: false }).decode(bytes);
        if (!alternative.includes('\uFFFD')) text = alternative;
      } catch { /* no GBK table in this build: keep UTF-8 */ }
    }
    // Windows editors happily write a UTF-8 BOM. Left in place it defeats every line-prefix test the
    // framework does (`> **Status**`, `framework:`), so the mark is dropped here for every reader at once.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/**
 * Forward-slash form of a path, as the bash originals emit (they `sed 's|\\|/|g'`
 * or run under Git Bash where `pwd -W`/Python already produce `C:/...`).
 * @param {string} path
 * @returns {string}
 */
export function posixPath(path) {
  return path.replace(/\\/g, '/');
}



