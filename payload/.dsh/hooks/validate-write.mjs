#!/usr/bin/env node
/**
 * validate-write — DSH port of upstream `.dsh/hooks/validate-write.sh`.
 *
 * PreToolUse on Write|Edit. It asks `write-guard.mjs check` what the rules say about this write and
 * passes the findings on: the files skills never overwrite, a config write that breaks an enum or the
 * local whitelist, and a string-table write during a localization freeze.
 *
 * Advisory, never blocking: upstream exits 0 with stderr. `write-guard` emits observations, not
 * verdicts — whether a row stops the work is the caller's call, or the user's.
 *
 * Most writes are of none of the guarded paths, so the path filter runs before the guard is called.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readInput, projectRoot, warn, run } from './runtime.mjs';

const EVENT = 'PreToolUse';
const GUARD = join(import.meta.dirname, '..', 'scripts', 'write-guard.mjs');

/** Upstream's cheap filter: only these paths can carry a guarded write. */
const GUARDED = /(EPIC\.md|project\.godot|helpers|tech-debt-register|engine-reference|project\.yaml|project\.local\.yaml|review-mode\.txt|prototypes|strings)/;
const GUARDED_ANYWHERE = /(^|\/)(tests|\.github|production|Assets|Source)(\/|$)/;
const GUARDED_DIRS = /^(tests|\.github|production|Assets|Source|prototypes|assets\/data\/strings)(\/|$)/;

function main() {
  const input = readInput();
  const tool = String(input?.tool_name ?? input?.tool ?? '').toLowerCase();
  if (tool !== 'write' && tool !== 'edit') return;
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== 'string' || raw.length === 0) return;

  const root = (typeof input?.cwd === 'string' && (existsSync(join(input.cwd, 'project.yaml')) || existsSync(join(input.cwd, '.dsh'))))
    ? resolve(input.cwd)
    : projectRoot(input);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(input.cwd ?? root, raw);
  const rel = relative(root, absolute).replace(/\\/g, '/');
  if (rel.startsWith('..')) return;
  if (!GUARDED.test(rel) && !GUARDED_ANYWHERE.test(rel) && !GUARDED_DIRS.test(rel)) return;
  if (!existsSync(GUARD)) return;

  // The enum check compares the new content with the file on disk, so Write's content goes to a temp file.
  let temp = null;
  let newFile = null;
  if (tool === 'write' && typeof input?.tool_input?.content === 'string') {
    temp = mkdtempSync(join(tmpdir(), 'dsgs-write-'));
    newFile = join(temp, 'new-content');
    writeFileSync(newFile, input.tool_input.content, 'utf8');
  }

  let text = '';
  try {
    text = execFileSync(process.execPath, [
      GUARD, '--root', root, '--tool', tool === 'write' ? 'Write' : 'Edit', 'check', rel, ...(newFile === null ? [] : [newFile]),
      ...(typeof input?.agent_type === 'string' && input.agent_type !== '' ? ['--agent', input.agent_type] : []),
      '--existed', existsSync(absolute) ? 'yes' : 'no',
    ], { encoding: 'utf8', timeout: 20_000 });
  } catch (error) {
    text = String(error.stdout ?? '');
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }

  const findings = text.split('\n').filter((line) => {
    if (line.trim() === '') return false;
    const kind = line.split('\t')[0];
    return kind !== 'checked' && kind !== 'SKIPPED';
  });
  if (findings.length === 0) return;

  const lines = findings.map((line) => {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'OVERWRITE') return `Overwrite: ${rest[0]} — ${rest[1]}`;
    if (kind === 'ENUM') return `Invalid value: ${rest[1]} = ${rest[2]} in ${rest[0]} (line ${rest[4]}); allowed: ${rest[3]}`;
    if (kind === 'NOT_LOCAL') return `Not locally overridable: ${rest[1]} in ${rest[0]} (line ${rest[2]})`;
    if (kind === 'REVIEW_MODE') return `Review mode: ${rest[1]} in ${rest[0]} (line ${rest[2]})`;
    if (kind === 'FREEZE') return `Localization freeze is active (${rest[2]}): ${rest[0]} is frozen`;
    if (kind === 'PROTOTYPE_HEADER') return `Prototype header missing: ${rest[0]} needs "${rest[1]}" in its first five lines`;
    if (kind === 'PROTOTYPE_IMPORT') return `Prototype boundary crossed (${rest[1]}): ${rest[0]}:${rest[2]} — ${rest[3]}`;
    if (kind === 'AGENT_WRITE') {
      return rest[2] === 'outside'
        ? `A subagent (${rest[1]}) may not write outside production/, docs/ or tests/: ${rest[0]}`
        : `A subagent (${rest[1]}) may add a file but not overwrite one: ${rest[0]}`;
    }
    return line;
  });
  warn(EVENT, `Write guard notes for ${rel}:\n${lines.join('\n')}`);
}

run(main);
