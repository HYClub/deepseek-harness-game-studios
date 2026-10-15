/**
 * validate-skill-change — PostToolUse advisory after a skill file changes.
 *
 * Ported from `.claude/hooks/validate-skill-change.sh` (101 lines). Behavior kept:
 *   * project-root precedence (cwd project root wins, then the payload cwd, then this
 *     script's location — never an upward search);
 *   * Windows path normalization, including the escaped-pair form that arrives through
 *     the hook JSON (`\\` must collapse to one separator, not two);
 *   * a path that is still absolute after stripping the root is outside the project → allow;
 *   * only skill files under the project's skills directory are advisory targets;
 *   * advisory only: exit 0, no permission decision, message on both channels.
 *
 * DSH-specific changes:
 *   * `.dsh/skills/**` is watched as well as `.claude/skills/**`. `.dsh` is generated, so
 *     an edit there is reported as the mistake it is (edit the source, then regenerate);
 *   * the advice names the DSH flow: `node tools/build-dsh.mjs` before `/skill-test`.
 */
import { relative, resolve, sep } from 'node:path';
import { readInput, projectRoot, run, warn } from './runtime.mjs';

const SKILL_DIRS = ['.claude/skills/', '.dsh/skills/'];

/** Normalize a hook-supplied path the way the bash hook does (both rules, in order). */
function normalize(value) {
  return String(value ?? '').replace(/\\\\/g, '/').replace(/\\/g, '/');
}

/** Project-relative path, or `undefined` when the path is outside this project. */
function relativize(filePath, root) {
  const normalizedRoot = normalize(root).replace(/\/+$/, '');
  const lowerPath = filePath.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();
  if (lowerPath.startsWith(`${lowerRoot}/`)) {
    return filePath.slice(normalizedRoot.length + 1);
  }
  const nativeRoot = normalize(resolve(root)).replace(/\/+$/, '');
  if (filePath.toLowerCase().startsWith(`${nativeRoot.toLowerCase()}/`)) {
    return filePath.slice(nativeRoot.length + 1);
  }
  // Absolute anywhere else (drive letter or leading slash) means another tree.
  if (/^[A-Za-z]:\//.test(filePath) || filePath.startsWith('/')) return undefined;
  return filePath.replace(/^\.\//, '');
}

run(async () => {
  const input = readInput();
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'PostToolUse';
  const toolInput = input.tool_input ?? {};
  const filePath = normalize(toolInput.file_path ?? toolInput.path ?? '');
  if (filePath.length === 0) return;

  const root = projectRoot(input);
  const rel = relativize(filePath, root);
  if (rel === undefined) return;

  const relPosix = rel.split(sep).join('/');
  const matched = SKILL_DIRS.find((prefix) => relPosix.startsWith(prefix));
  if (matched === undefined) return;

  const skillName = relPosix.slice(matched.length).split('/')[0];
  if (skillName === undefined || skillName.length === 0) return;

  if (matched === '.dsh/skills/') {
    warn(
      event,
      `Skill modified in the generated tree: ${skillName}. .dsh/ is generated — edit `
      + `.claude/skills/${skillName}/SKILL.md, then run "node tools/build-dsh.mjs" to regenerate.`,
    );
    return;
  }

  warn(
    event,
    `Skill modified: ${skillName}. Run "node tools/build-dsh.mjs" to refresh the DSH tree, `
    + `then /skill-test static ${skillName} to validate structural compliance.`,
  );
});
