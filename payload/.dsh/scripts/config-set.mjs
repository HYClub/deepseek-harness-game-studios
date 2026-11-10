#!/usr/bin/env node
// config-set.mjs — set one dotted key in project.yaml (or project.local.yaml), then read it back.
//
// Node port of upstream `.dsh/scripts/config-set.sh`. The script never asks and never judges: it
// prints one row per check, writes only when every check passed, and prints what it reads back. The
// asking lives in the /project-settings skill. Run with --dry-run first to show the rows.
//
// Rows (tab separated): file / enum / whitelist / reserved / known / shadow / current / edit / readback.
//
// Exit codes: 0 done (or a dry run that would write); 1 cannot read the root; 2 usage or an unsafe
// value; 3 the enum check failed; 4 the key is not locally overridable; 5 a layout this editor will
// not touch (the key is a block with children); 6 the write could not be made; 7 the read back does
// not match the value asked for.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getYamlKey, validateEnumValue, isLocallyOverridable,
} from '../../tools/yaml-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const row = (kind, status, detail) => process.stdout.write(`${kind}\t${status}\t${detail}\n`);

function usage(message) {
  process.stderr.write(`config-set: ${message} (try --help)\n`);
  process.exit(2);
}

const HELP = `config-set — set one key in project.yaml or project.local.yaml, then read it back

  config-set [--local] KEY VALUE [--dry-run] [--root DIR]
  config-set [--local] KEY=VALUE ...       one or more, split at the first '='
  --local     write project.local.yaml (gitignored) instead of project.yaml
  --dry-run   print every row; write nothing
  --root DIR  the project; defaults to the repo this script lives in
  -h, --help  this text

A value with a newline, one starting with '#' or a quote, or one holding ' #' is refused: YAML would
cut it or read it differently from what was asked for.`;

function parseArgs(argv) {
  const out = { pairs: [], local: false, dryRun: false, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { process.stdout.write(`${HELP}\n`); process.exit(0); }
    else if (arg === '--local') out.local = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) usage('--root needs a directory');
      out.root = value;
      i += 1;
    } else if (arg.includes('=')) {
      const at = arg.indexOf('=');
      out.pairs.push([arg.slice(0, at), arg.slice(at + 1)]);
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
      out.pairs.push([arg, value]);
      i += 1;
    }
  }
  if (!out.pairs.length) usage('a key is required');
  return out;
}

/** The value as YAML will read it, or a reason it will not. */
function checkValue(key, value) {
  if (!key) return 'the key is empty';
  if (value === '') return 'the value is empty';
  if (/[\r\n]/.test(value)) return 'the value holds a newline';
  if (value.startsWith('#')) return 'the value starts with #, which YAML reads as a comment';
  if (value.includes(' #')) return 'the value holds " #", which YAML cuts into a comment';
  if (/^["']/.test(value)) return 'the value starts with a quote; give it bare, this script quotes it';
  return null;
}

function readLines(file) {
  const raw = readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes('\r\n');
  return { lines: text.split(/\r?\n/), crlf, bom };
}

function writeLines(file, lines, crlf, bom) {
  const eol = crlf ? '\r\n' : '\n';
  writeFileSync(file, (bom ? '\uFEFF' : '') + lines.join(eol), 'utf8');
}

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => line.trim() === '' || line.trim().startsWith('#');

/** Index of `segment` as a key at exactly `indent`, searching from `start`; -1 when absent. */
function findKey(lines, segment, start, indent) {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const ind = indentOf(line);
    if (ind < indent) return -1;
    if (ind !== indent) continue;
    const m = line.slice(ind).match(/^([^:#]+?)\s*:(.*)$/);
    if (m && m[1] === segment) return i;
  }
  return -1;
}

/** Index after the last direct child line of the block that starts at `index`. */
function endOfBlock(lines, index, childIndent) {
  let last = index;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) < childIndent) break;
    last = i;
  }
  return last + 1;
}

/** Walk the file's blocks and return where `segments` lives, or where it has to be added. */
function locate(lines, segments) {
  let start = 0;
  let indent = 0;
  let parent = null;
  for (let s = 0; s < segments.length; s += 1) {
    const index = findKey(lines, segments[s], start, indent);
    if (index < 0) {
      const insertAt = parent ? endOfBlock(lines, parent.index, parent.indent + 2) : lines.length;
      return { found: false, insertAt, indent: parent ? parent.indent + 2 : 0, missingFrom: s };
    }
    if (s === segments.length - 1) {
      let hasChildren = false;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (isBlank(lines[next])) continue;
        hasChildren = indentOf(lines[next]) > indent;
        break;
      }
      return { found: true, index, indent, value: lines[index].slice(indent).replace(/^[^:]+:\s*/, ''), hasChildren };
    }
    parent = { index, indent };
    start = index + 1;
    indent += 2;
  }
  return { found: false, insertAt: lines.length, indent: 0 };
}
function setKey(file, segments, value, isLocal) {
  if (!existsSync(file)) {
    const header = isLocal ? ['# project.local.yaml — per-developer overrides (gitignored)', ''] : [];
    const body = segments.map((segment, index) => `${'  '.repeat(index)}${segment}:${index === segments.length - 1 ? ' ' + value : ''}`);
    writeLines(file, [...header, ...body], false, false);
    return { action: 'created', line: body.length };
  }
  const { lines, crlf, bom } = readLines(file);
  const at = locate(lines, segments);
  if (at.found && at.hasChildren) return { action: 'refused', reason: `${segments.join('.')} is a block with children, not a scalar`, line: at.index + 1 };
  if (at.found) {
    const line = lines[at.index];
    const quoted = /:\s*"[^"]*"\s*$/.test(line);
    const prefix = line.slice(0, line.indexOf(':') + 1);
    lines[at.index] = `${prefix} ${quoted ? `"${value}"` : value}`;
    writeLines(file, lines, crlf, bom);
    return { action: 'updated', line: at.index + 1 };
  }
  const insertAt = Math.min(at.insertAt, lines.length);
  const rest = segments.slice(at.missingFrom ?? 0);
  const block = rest.map((segment, index) => `${' '.repeat(at.indent + index * 2)}${segment}:${index === rest.length - 1 ? ' ' + value : ''}`);
  if (insertAt === lines.length && lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.splice(insertAt, 0, ...block);
  writeLines(file, lines, crlf, bom);
  return { action: 'added', line: insertAt + block.length };
}

/** Reserved settings: the heading above each `> ### RESERVED` banner in effects-map.md. */
function reservedFor(root) {
  const readmes = [join(root, '.dsh', 'docs', 'effects-map.md'), join(root, '.dsh', 'docs', 'effects-map.md')];
  const file = readmes.find((candidate) => existsSync(candidate));
  if (!file) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let heading = '';
  for (const line of lines) {
    if (line.startsWith('## ')) heading = line.slice(3).trim();
    if (line.includes('### RESERVED')) {
      for (const part of heading.split(' and ')) out.push(part.trim());
    }
  }
  return out;
}

const parsed = parseArgs(process.argv.slice(2));
const root = parsed.root ? resolve(parsed.root) : resolve(HERE, '..', '..');
if (!existsSync(root) || !statSync(root).isDirectory()) {
  process.stderr.write(`config-set: cannot read root ${root}\n`);
  process.exit(1);
}
const target = join(root, parsed.local ? 'project.local.yaml' : 'project.yaml');
const reserved = reservedFor(root);

let exitCode = 0;
for (const [key, value] of parsed.pairs) {
  const unsafe = checkValue(key, value);
  if (unsafe) usage(unsafe);
  const segments = key.split('.');
  row('file', target, existsSync(target) ? 'present' : 'absent');

  const enumState = validateEnumValue(key, value);
  if (enumState === 0) row('enum', 'ok', '-');
  else { row('enum', 'invalid', key); exitCode = 3; }

  if (parsed.local) {
    if (isLocallyOverridable(key)) row('whitelist', 'overridable', 'yaml-helper _yaml_helper_locally_overridable');
    else { row('whitelist', 'locked', 'yaml-helper _yaml_helper_locally_overridable'); exitCode = 4; }
  }

  const hit = reserved.find((name) => key === name || key.startsWith(`${name}.`));
  row('reserved', hit ? 'yes' : 'no', hit ?? '-');

  const known = isLocallyOverridable(key) || reserved.some((name) => key === name || key.startsWith(`${name}.`));
  row('known', known ? 'yes' : 'no', 'enums, whitelist, effects-map headings');

  if (!parsed.local && existsSync(join(root, 'project.local.yaml'))) {
    const shadow = getYamlKey(join(root, 'project.local.yaml'), key);
    row('shadow', shadow ? 'yes' : 'no', shadow || '-');
  }

  row('current', getYamlKey(target, key) || '-', target);

  if (exitCode !== 0) {
    row('edit', 'not attempted', '-');
    row('readback', '-', target);
    break;
  }

  if (parsed.dryRun) {
    row('edit', 'dry-run', '-');
    row('readback', '-', target);
    continue;
  }

  const result = setKey(target, segments, value, parsed.local);
  if (result.action === 'refused') { row('edit', 'refused', result.reason); exitCode = 5; row('readback', '-', target); break; }
  row('edit', result.action, String(result.line));

  const back = getYamlKey(target, key);
  row('readback', back || '-', target);
  if (back !== value) exitCode = 7;
}

process.exit(exitCode);


    if (insertAt === lines.length && lines.length && lines[lines.length - 1].trim() !== '') lines.push('');


