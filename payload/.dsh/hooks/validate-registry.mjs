#!/usr/bin/env node
/**
 * validate-registry — DSH port of upstream `.dsh/hooks/validate-registry.sh`.
 *
 * PreToolUse on a write of an entity or TR-ID registry. The registries' own rule is that an entry is
 * never deleted (deprecate it instead) and never renumbered, so the hook rebuilds the content the
 * write would leave, compares it with the file on disk, and reports what the change would remove or
 * what status it sets outside the allowed set.
 *
 * Advisory, never blocking. When the new content cannot be rebuilt (an Edit whose old_string is not
 * in the file), the hook says the check was skipped instead of passing silently, and points at
 * `registry.mjs compare`, which the skill can run after writing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readInput, projectRoot, warn, run } from './runtime.mjs';

const EVENT = 'PreToolUse';
const REGISTRIES = new Map([
  ['design/registry/entities.yaml', 'entities'],
  ['docs/architecture/tr-registry.yaml', 'tr'],
]);
const MAX_ROWS = 5;

function main() {
  const input = readInput();
  const tool = String(input?.tool_name ?? input?.tool ?? '').toLowerCase();
  if (tool !== 'write' && tool !== 'edit') return;
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== 'string' || raw.length === 0) return;

  // The file decides the project: a path below the payload's cwd belongs to that project, whether or
  // not it has been configured yet (a write can land before /setup-engine does).
  const cwd = typeof input?.cwd === 'string' ? resolve(input.cwd) : null;
  const absolute = cwd !== null ? resolve(cwd, raw) : resolve(projectRoot(input), raw);
  const root = cwd !== null && absolute.startsWith(cwd) ? cwd : projectRoot(input);
  const rel = absolute.startsWith(root) ? absolute.slice(root.length + 1).replace(/\\/g, '/') : '';
  const registry = REGISTRIES.get(rel);
  if (registry === undefined) return;

  const guard = join(import.meta.dirname, '..', 'scripts', 'registry.mjs');
  if (!existsSync(guard)) return;

  const target = absolute;
  const after = tool === 'write'
    ? (typeof input?.tool_input?.content === 'string' ? input.tool_input.content : null)
    : rebuild(absolute, input?.tool_input ?? {});
  if (after === null) {
    warn(EVENT, `Registry check skipped for ${rel}: the new content could not be rebuilt from this edit. The write goes ahead; run \`registry.mjs compare ${registry} ${rel}\` after writing and fix what it reports.`);
    return;
  }

  const temp = mkdtempSync(join(tmpdir(), 'dsgs-registry-'));
  const newFile = join(temp, 'new.yaml');
  writeFileSync(newFile, after, 'utf8');
  let text = '';
  try {
    text = execFileSync(process.execPath, [guard, '--root', root, 'compare', registry, target, newFile], { encoding: 'utf8', timeout: 20_000 });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const removed = [];
  const statuses = [];
  for (const line of text.split('\n')) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'REMOVED') removed.push(`${rest[2]} (${rest[1]})`);
    if (kind === 'STATUS') statuses.push(`${rest[1]} = "${rest[2]}"`);
  }
  if (removed.length === 0 && statuses.length === 0) return;
  const parts = [];
  if (removed.length > 0) {
    const shown = removed.slice(0, MAX_ROWS).join(', ');
    const more = removed.length > MAX_ROWS ? `, and ${removed.length - MAX_ROWS} more` : '';
    parts.push(`${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} would be removed from ${rel}: ${shown}${more}. The registries never delete an entry — set status: deprecated instead.`);
  }
  if (statuses.length > 0) {
    const shown = statuses.slice(0, MAX_ROWS).join(', ');
    const more = statuses.length > MAX_ROWS ? `, and ${statuses.length - MAX_ROWS} more` : '';
    parts.push(`A status outside the allowed set in ${rel}: ${shown}${more}.`);
  }
  warn(EVENT, `Registry change in ${rel}:\n${parts.join('\n')}`);
}

/** The content an Edit would leave: old_string replaced by new_string, first match unless replace_all. */
function rebuild(file, toolInput) {
  if (typeof toolInput.old_string !== 'string' || typeof toolInput.new_string !== 'string') return null;
  if (!existsSync(file)) return null;
  const before = readFileSync(file, 'utf8');
  if (toolInput.old_string === '') return before === '' ? toolInput.new_string : null;
  if (!before.includes(toolInput.old_string)) return null;
  return toolInput.replace_all === true
    ? before.split(toolInput.old_string).join(toolInput.new_string)
    : before.replace(toolInput.old_string, toolInput.new_string);
}

run(main);

