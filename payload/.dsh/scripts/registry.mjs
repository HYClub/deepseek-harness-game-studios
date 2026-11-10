#!/usr/bin/env node
// registry.mjs — read a registry and say what a change would do to it.
//
// Node port of the `compare` command from upstream `.dsh/scripts/registry.sh` (774 lines). The two
// rules it guards are the ones the registries themselves state: an entry is never deleted (deprecate
// it instead) and never renumbered, so a write that drops an entry is reported before it lands.
//
// Usage: registry.mjs [--root DIR] compare <entities|tr|architecture> <OLD> [NEW]
// Rows: registry · REMOVED · STATUS · LAYOUT · removed/status/layout counts.
// Exit 0 whenever the comparison ran: what it finds is rows, not a verdict.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (line) => process.stdout.write(`${line}\n`);
const tsv = (value) => (value === '' || value === undefined ? '-' : String(value).replace(/\t/g, ' '));

const PATHS = {
  entities: 'design/registry/entities.yaml',
  tr: 'docs/architecture/tr-registry.yaml',
  architecture: 'docs/registry/architecture.yaml',
};
/** The field that names an entry: `name` for entities and architecture, `id` for TR requirements. */
const KEY_FIELD = { entities: 'name', tr: 'id', architecture: 'name' };
const SECTION = { entities: null, tr: 'requirements', architecture: null };
/** The one-word status an entry may carry; the rest of the allowed value is a superseded reference. */
const ALLOWED = {
  entities: 'active|deprecated',
  tr: 'active|deprecated|superseded-by: TR-<system>-NNN',
  architecture: 'active|superseded_by: ADR-NNNN',
};

function statusOk(registry, value) {
  if (value === 'active' || value === 'deprecated') return true;
  if (registry === 'architecture') return /^superseded_by: ADR-\d+$/.test(value);
  if (!value.startsWith('superseded-by: ')) return false;
  return value.slice(15).split(',').every((item) => /^TR-[a-z0-9-]+-\d+$/.test(item.trim()));
}

/** Entries of one registry file: section, the field that names it, its name, status and line. */
function parse(file, registry) {
  if (!existsSync(file)) return { entries: [], missing: true };
  const keyField = KEY_FIELD[registry];
  const entries = [];
  let section = '';
  let current = null;
  let dashColumn = -1;
  let fieldColumn = -1;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\r$/, '');
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;

    if (indent === 0 && !trimmed.startsWith('- ')) {
      current = null;
      const m = /^([^:#]+?)\s*:(.*)$/.exec(trimmed);
      section = m ? m[1].trim() : '';
      if (SECTION[registry] !== null) section = m && m[1].trim() === SECTION[registry] ? SECTION[registry] : section;
      dashColumn = -1;
      fieldColumn = -1;
      continue;
    }

    if (dashColumn === -1 && /^\s*- \s*[A-Za-z_]+:/.test(line)) {
      dashColumn = indent;
      fieldColumn = indent + 2;
    }
    if (indent === dashColumn && /^- /.test(line.slice(indent))) {
      current = { section, name: '', field: '', status: null, line: i + 1 };
      entries.push(current);
      const field = /^- \s*([A-Za-z_]+):\s*(.*)$/.exec(line.slice(indent));
      if (field) {
        current.field = field[1];
        if (field[1] === keyField) current.name = field[2].trim().replace(/^["']|["']$/g, '');
      }
      continue;
    }
    if (current !== null && indent >= fieldColumn) {
      const field = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!field) continue;
      const value = field[2].trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
      if (field[1] === keyField && current.name === '') current.name = value;
      if (field[1] === 'status') current.status = value;
    }
  }
  return { entries, missing: false };
}

function compare(registry, oldFile, newFile, root) {
  const before = parse(oldFile, registry);
  const after = newFile === null ? { entries: [], missing: true } : parse(newFile, registry);
  out(`registry\t${registry}\t${PATHS[registry]}\t${before.missing ? 'missing' : 'entries'}`);

  let layout = 0;
  if (before.missing) { out(`LAYOUT\t${registry}\t${oldFile}\tmissing\t-`); layout += 1; }
  if (before.entries.length > 0 && before.entries.every((entry) => entry.name === '')) {
    out(`LAYOUT\t${registry}\t${oldFile}\tno entry names\ta section key and its list`); layout += 1;
  }

  let removed = '-';
  if (!before.missing && newFile !== null && !after.missing) {
    const keys = new Set(after.entries.filter((entry) => entry.name !== '').map((entry) => `${entry.section}\u0000${entry.name}`));
    const rows = [];
    const gone = new Set();
    for (const entry of before.entries) {
      if (entry.name === '') continue;
      const key = `${entry.section}\u0000${entry.name}`;
      if (keys.has(key) || gone.has(key)) continue;
      gone.add(key);
      rows.push(`REMOVED\t${registry}\t${tsv(entry.section)}\t${tsv(entry.name)}\t${entry.line}`);
    }
    rows.forEach(out);
    removed = String(rows.length);
  }

  let statuses = 0;
  const known = new Map();
  for (const entry of before.entries) if (entry.status !== null) known.set(`${entry.section}\u0000${entry.name}`, entry.status);
  for (const entry of after.entries) {
    if (entry.status === null || statusOk(registry, entry.status)) continue;
    if (known.get(`${entry.section}\u0000${entry.name}`) === entry.status) continue;
    out(`STATUS\t${registry}\t${tsv(entry.name)}\t${tsv(entry.status)}\t${ALLOWED[registry]}\t${entry.line}`);
    statuses += 1;
  }

  out(`removed\t${removed}`);
  out(`status\t${statuses}`);
  out(`layout\t${layout}`);
  return 0;
}

const argv = process.argv.slice(2);
let root = resolve(HERE, '..', '..');
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--root') { root = resolve(argv[i + 1]); i += 1; }
  else if (argv[i] === '-h' || argv[i] === '--help') { out('registry [--root DIR] compare <entities|tr|architecture> <OLD> [NEW]'); process.exit(0); }
  else positional.push(argv[i]);
}
const [command, registry, ...files] = positional;
if (command !== 'compare' || registry === undefined || PATHS[registry] === undefined || files.length === 0) {
  process.stderr.write('registry: compare takes a registry, the old file and optionally the new one (try --help)\n');
  process.exit(2);
}
const toAbsolute = (value) => (isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value));
process.exit(compare(registry, toAbsolute(files[0]), files[1] ? toAbsolute(files[1]) : null, root));
