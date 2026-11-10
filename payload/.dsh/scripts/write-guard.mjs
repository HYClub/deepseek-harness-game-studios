#!/usr/bin/env node
// write-guard.mjs — the rules that must hold on a write, read as observations.
//
// Node port of upstream `.dsh/scripts/write-guard.sh` (455 lines). It emits rows; whether a row
// stops the work is the caller's call. The hook `validate-write` prints them as advice; a skill that
// writes a guarded file can call this itself, because hooks do not run in every tool.
//
// Commands implemented: `check PATH [NEWFILE] [--tool Write|Edit] [--agent TYPE] [--existed yes|no]`,
// `overwrite PATH`, `freeze PATH`.
//
// Rows: OVERWRITE · ENUM · NOT_LOCAL · REVIEW_MODE · FREEZE · PROTOtYPE_* · SKIPPED · checked.
//
// The prototype-import and subagent-exception rules are NOT ported yet: each one emits a SKIPPED row
// naming what could not run, which is what upstream does when a helper is missing. Silence would read
// as "checked and clean", which is the one thing this file must never do.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const row = (kind, ...fields) => process.stdout.write([kind, ...fields].join('\t') + '\n');

function usage(message) {
  process.stderr.write(`write-guard: ${message} (try --help)\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { tool: 'Write', agent: '', existed: '', root: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') { out.root = argv[i + 1]; i += 1; }
    else if (arg === '--tool') { out.tool = argv[i + 1]; i += 1; }
    else if (arg === '--agent') { out.agent = argv[i + 1]; i += 1; }
    else if (arg === '--existed') { out.existed = argv[i + 1]; i += 1; }
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('write-guard [--root DIR] COMMAND [ARGS]\n  check PATH [NEWFILE] [--tool Write|Edit] [--agent TYPE] [--existed yes|no]\n  overwrite PATH\n  freeze PATH\n');
      process.exit(0);
    } else out.positional.push(arg);
  }
  if (out.tool !== 'Write' && out.tool !== 'Edit') usage(`--tool takes Write or Edit, not ${out.tool}`);
  if (out.existed !== '' && out.existed !== 'yes' && out.existed !== 'no') usage('--existed takes yes or no');
  if (out.positional.length === 0) usage('no command');
  return out;
}

/** The two tables live in yaml-helper.mjs as text, exactly as the shell reads them. */
function readTable(name) {
  const file = join(HERE, '..', '..', 'tools', 'yaml-helper.mjs');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`).exec(text);
  if (block === null) return [];
  return block[1].split(',').map((line) => line.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

function enumTable() {
  const table = new Map();
  for (const line of readTable('ENUMS')) {
    const at = line.indexOf('::');
    if (at > 0) table.set(line.slice(0, at), line.slice(at + 2));
  }
  // `testing.strict` is a block of five booleans, which the shell special-cases.
  table.set('testing.strict', 'true|false');
  return table;
}

/** Dotted leaves of a YAML file: key, value, line number. */
function yamlLeaves(file) {
  const out = [];
  let depth = 0;
  const keys = [];
  const indents = [];
  let blockIndent = -1;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\r$/, '');
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    const indent = line.match(/^ */)[0].length;
    const body = line.slice(indent);
    const trimmed = body.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (blockIndent >= 0) { if (indent > blockIndent) continue; blockIndent = -1; }
    const opens = /^([^:#]+?)\s*:\s*[|>][-+0-9]*\s*(#.*)?$/.test(body);
    if (opens) { blockIndent = indent; continue; }
    if (body.startsWith('- ') || body.startsWith('\t')) continue;
    const at = body.indexOf(':');
    if (at <= 0) continue;
    const key = body.slice(0, at);
    let value = body.slice(at + 1).trim();
    while (depth > 0 && indents[depth - 1] >= indent) { depth -= 1; keys.length = depth; }
    if (value === '' || value.startsWith('#')) { keys[depth] = key; indents[depth] = indent; depth += 1; continue; }
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end > 0) value = value.slice(1, end);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.push({ key: [...keys.slice(0, depth), key].join('.'), value, line: i + 1 });
  }
  return out;
}

const OVERWRITE_WHY = [
  [/^production\/epics\/[^/]+\/EPIC\.md$/, '/create-epics updates an existing EPIC.md in place and never rewrites it'],
  [/^project\.godot$/, '/setup-engine never replaces an existing Godot project file'],
  [/^tests\/helpers\//, '/test-helpers never overwrites existing helpers, which may hold hand-written code'],
  [/^docs\/tech-debt-register\.md$/, '/tech-debt appends to the register and never rewrites it'],
  [/^docs\/engine-reference\//, '/setup-engine never overwrites an engine reference doc without asking'],
];

function ruleOverwrite(root, path) {
  if (statSync(resolve(root, path), { throwIfNoEntry: false }) === undefined) return false;
  for (const [re, why] of OVERWRITE_WHY) {
    if (re.test(path)) { row('OVERWRITE', path, why); return true; }
  }
  if (/^(tests\/|\.github\/|production\/qa\/|Assets\/Tests\/|Source\/)/.test(path) || path === 'playwright.config.ts') {
    row('SKIPPED', 'overwrite', 'test-scaffold.sh is not ported, so the files /test-setup creates were not checked');
  }
  return true;
}

function ruleConfig(root, path, newFile) {
  if (path === 'production/review-mode.txt') {
    if (newFile === null || !existsSync(newFile)) return false;
    const value = readFileSync(newFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
    row('REVIEW_MODE', path, value === '' ? '-' : value, String(value === '' ? '-' : 1));
    return true;
  }
  if (path !== 'project.yaml' && path !== 'project.local.yaml') return false;
  if (newFile === null || !existsSync(newFile)) return true;
  const enums = enumTable();
  const local = readTable('LOCALLY_OVERRIDABLE');
  const before = new Map();
  if (newFile !== path && existsSync(resolve(root, path))) {
    for (const leaf of yamlLeaves(resolve(root, path))) before.set(leaf.key, leaf.value);
  }
  for (const leaf of yamlLeaves(newFile)) {
    const changed = !before.has(leaf.key) || before.get(leaf.key) !== leaf.value;
    const allowed = enums.get(leaf.key);
    if (allowed !== undefined && changed && !allowed.split('|').includes(leaf.value)) {
      row('ENUM', path, leaf.key, leaf.value, allowed, String(leaf.line));
    }
    if (path === 'project.local.yaml' && !local.includes(leaf.key) && leaf.key !== 'schema_version'
      && !leaf.key.startsWith('framework.') && !before.has(leaf.key)) {
      row('NOT_LOCAL', path, leaf.key, String(leaf.line));
    }
    if (leaf.key === 'modes.review_mode' && changed) row('REVIEW_MODE', path, leaf.value, String(leaf.line));
  }
  return true;
}

const FREEZE_FILE = 'production/localization/freeze-status.md';
function ruleFreeze(root, path) {
  if (!path.startsWith('assets/data/strings/')) return false;
  const file = resolve(root, FREEZE_FILE);
  if (!existsSync(file)) return true;
  let active = false;
  let called = '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const upper = line.toUpperCase();
    if (/^\*\*STATUS\*\*:\s*ACTIVE(\s|$)/.test(upper) || /^STATUS:\s*ACTIVE(\s|$)/.test(upper)) active = true;
    if (upper.startsWith('**CALLED**:')) called = line.replace(/^\*\*CALLED\*\*:\s*/i, '').trim();
  }
  if (active) row('FREEZE', path, FREEZE_FILE, called === '' ? '-' : called);
  return true;
}

const COMMENTABLE = /\.(gd|py|cs|cpp|cc|cxx|h|hpp|js|mjs|ts|tsx|lua|html|htm|md|gdshader|shader|hlsl|glsl|sh)$/i;
const CODE_ROOTS = ['src', 'Assets', 'Source'];

/** The prototype boundary: production code does not import a prototype's files, and a prototype does
 *  not import production code. The engine's code roots come from engines.tsv upstream; that table is
 *  not part of this port, so its first three roots are used. */
function rulePrototype(root, path, newFile) {
  let direction = '';
  if (path.startsWith('prototypes/')) direction = 'into-production';
  else if (CODE_ROOTS.some((dir) => path.startsWith(`${dir}/`))) direction = 'into-prototypes';
  if (direction === '') return false;
  if (newFile === null || !existsSync(newFile)) return true;

  if (direction === 'into-production' && COMMENTABLE.test(path)) {
    const head = readFileSync(newFile, 'utf8').split(/\r?\n/).slice(0, 5).join('\n');
    if (!/PROTOTYPE - NOT FOR PRODUCTION|VERTICAL SLICE - NOT FOR PRODUCTION/.test(head)) {
      const header = /prototypes\/[^/]*-vertical-slice\//.test(path)
        ? 'VERTICAL SLICE - NOT FOR PRODUCTION'
        : 'PROTOTYPE - NOT FOR PRODUCTION';
      row('PROTOTYPE_HEADER', path, header);
    }
  }

  const importRe = direction === 'into-production'
    ? /(res:\/\/|\.\.\/)(\.\.\/)*((src|Assets|Source))\//
    : /(res:\/\/|\.\.\/|["'(<])(\.\.\/)*prototypes\//;
  const lines = readFileSync(newFile, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (importRe.test(lines[i])) row('PROTOTYPE_IMPORT', path, direction, String(i + 1), lines[i].trim());
  }
  return true;
}

/** The subagent write exception: a subagent may add files under production/, docs/ and tests/, never
 *  overwrite an existing one, and never write outside those three. Agent memory and the session
 *  checkpoint are exempt (`.dsh/rules/agent-memory.md`). */
function ruleAgent(root, path, agent, existed) {
  if (agent === '') return false;
  if (path.startsWith('.dsh/agent-memory/') || path === 'production/session-state/active.md') return true;
  if (!/^(production|docs|tests)\//.test(path)) {
    row('AGENT_WRITE', path, agent, 'outside');
    return true;
  }
  const exists = existed !== '' ? existed : (existsSync(resolve(root, path)) ? 'yes' : 'no');
  if (exists === 'yes') row('AGENT_WRITE', path, agent, 'existing-file');
  return true;
}

const parsed = parseArgs(process.argv.slice(2));
const [command, ...rest] = parsed.positional;
const root = parsed.root ? resolve(parsed.root) : resolve(HERE, '..', '..');
const toRelative = (value) => {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
  const rel = relative(root, absolute).replace(/\\/g, '/');
  return rel.startsWith('..') ? value.replace(/\\\\/g, '/') : rel;
};

if (command === 'check') {
  const target = toRelative(rest[0]);
  const newFile = rest[1] ? resolve(root, toRelative(rest[1])) : null;
  const applied = [];
  if (ruleOverwrite(root, target)) applied.push('overwrite');
  if (ruleConfig(root, target, newFile)) applied.push('config');
  if (rulePrototype(root, target, newFile)) applied.push('prototype');
  if (ruleFreeze(root, target)) applied.push('freeze');
  if (ruleAgent(root, target, parsed.agent, parsed.existed)) applied.push('agent');
  row('checked', target, applied.length > 0 ? applied.join(',') : '-');
} else if (command === 'overwrite') {
  ruleOverwrite(root, toRelative(rest[0]));
} else if (command === 'freeze') {
  ruleFreeze(root, toRelative(rest[0]));
} else if (command === 'prototype') {
  rulePrototype(root, toRelative(rest[0]), rest[1] ? resolve(root, toRelative(rest[1])) : null);
} else if (command === 'agent') {
  ruleAgent(root, toRelative(rest[0]), parsed.agent, parsed.existed);
} else {
  usage(`unknown command: ${command}`);
}
