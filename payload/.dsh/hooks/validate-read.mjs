#!/usr/bin/env node
/**
 * validate-read — DSH port of upstream `.dsh/hooks/validate-read.sh` (110 lines).
 *
 * PreToolUse hook: refuses a WHOLE-FILE read of a design doc over the size bar, and answers with the
 * document's headings by line, so the retry reads the section it needs. A ranged read always passes,
 * so nothing can get stuck behind it.
 *
 * Watched: `design/`, `docs/architecture/`, `production/session-state/` — and not an image or a PDF.
 * The bar is `features.read_guard_kb` (default 40 KB); `features.read_guard: off` turns it off. The
 * two settings are read from `project.local.yaml` first, then `project.yaml`, as the rest of the
 * framework reads them.
 *
 * Behaviour, unchanged from upstream except the channel: upstream exits 2 and writes stderr;
 * DSH's PreToolUse channel is a JSON decision, so the same text goes out as `permissionDecision:
 * deny`. Nothing is refused when the guard cannot run: it says so and lets the read through.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getYamlKey } from '../../tools/yaml-helper.mjs';
import { readInput, projectRoot, deny, run } from './runtime.mjs';

const EVENT = 'PreToolUse';
const WATCHED = [/^design\//i, /^docs\/architecture\//i, /^production\/session-state\//i];
const NOT_TEXT = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;
const DEFAULT_KB = 40;
const MAX_HEADINGS = 40;

/** Read one dotted key from the two config files, local first; null when neither sets it. */
function readSetting(root, key) {
  for (const file of ['project.local.yaml', 'project.yaml']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const value = getYamlKey(path, key);
    if (value !== '') return value;
  }
  return null;
}
/** on/off with YAML's other spelling; anything else is passed over, as upstream does. */
function guardSetting(root) {
  const value = readSetting(root, 'features.read_guard');
  if (value === null) return true;
  const spelling = value.toLowerCase();
  if (spelling === 'off' || spelling === 'false') return false;
  if (spelling === 'on' || spelling === 'true') return true;
  return true;
}

function thresholdBytes(root) {
  const value = readSetting(root, 'features.read_guard_kb');
  const kb = value === null ? DEFAULT_KB : Number.parseInt(value, 10);
  return (Number.isFinite(kb) && kb > 0 ? kb : DEFAULT_KB) * 1024;
}

/** Markdown headings with line numbers, skipping fenced blocks (a fence closes on its own char, at least as long). */
function headings(file) {
  const out = [];
  let fence = null;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const run_ = marker[1];
      if (fence === null) fence = { char: run_[0], length: run_.length };
      else if (run_[0] === fence.char && run_.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^#{1,6}\s/.test(line)) out.push({ line: i + 1, text: line.trim() });
  }
  return out;
}

/** The project-relative path of the read, or null when it is outside the project or unwatched. */
function watchedRelative(root, input) {
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(input.cwd ?? root, raw);
  const rel = relative(root, absolute).replace(/\\/g, '/');
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (NOT_TEXT.test(rel)) return null;
  return WATCHED.some((re) => re.test(rel)) ? { rel, absolute } : null;
}

function main() {
  const input = readInput();
  const tool = String(input?.tool_name ?? input?.tool ?? '').toLowerCase();
  if (tool !== 'read') return;

  // The root is the project that owns the file: the payload's cwd when it is a project, else the hook's.
  const root = (typeof input?.cwd === 'string' && (existsSync(join(input.cwd, 'project.yaml')) || existsSync(join(input.cwd, '.dsh'))))
    ? resolve(input.cwd)
    : projectRoot(input);
  const target = watchedRelative(root, input);
  if (target === null) return;

  if (!guardSetting(root)) return;

  let size = 0;
  try { size = statSync(target.absolute).size; } catch { return; }

  const bounded = input?.tool_input?.offset !== undefined || input?.tool_input?.limit !== undefined;
  if (bounded) return;

  const bar = thresholdBytes(root);
  if (size <= bar) return;

  const shown = Math.max(1, Math.ceil(size / 1024));
  const barKb = Math.max(1, Math.floor(bar / 1024));
  const all = headings(target.absolute);
  const list = all.slice(0, MAX_HEADINGS).map((h) => `  ${String(h.line).padStart(5)}  ${h.text}`).join('\n');
  const more = all.length > MAX_HEADINGS
    ? `\n  ... and ${all.length - MAX_HEADINGS} more: find them with the grep tool (pattern \`^#\`) on ${target.rel}, then read that range with offset and limit`
    : (all.length === 0 ? '\n  (no markdown headings: read it in ranges of a few hundred lines)' : '');

  deny(EVENT, [
    `Read refused: ${target.rel} is ${shown} KB, over the ${barKb} KB bar for reading a design doc whole (features.read_guard_kb).`,
    'Read it by section instead: find the heading you need below, then read with offset at its line and a limit that stops at the next heading.',
    list + more,
    'If the task needs the whole doc, read it in ranges and say why. The guard is a project setting, features.read_guard (on or off).',
  ].join('\n'));
}

run(main);


