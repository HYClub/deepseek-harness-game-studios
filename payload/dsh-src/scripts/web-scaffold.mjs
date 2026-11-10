#!/usr/bin/env node
// web-scaffold.mjs — copy the Web scaffold into a project, never overwriting a file.
//
// Node port of upstream `.claude/scripts/web-scaffold.sh` (187 lines). It prints the Node.js the
// project needs, then one row per path: created, already there, or (with --dry-run) would be created.
// `--list` prints the paths alone, so a caller can read them without side effects. `--starter` swaps in
// one of the library starters (three, phaser, pixi) for the scaffold's own package and entry file.
//
// Usage: web-scaffold.mjs [--dry-run | --list] [--root DIR] [--title TEXT] [--gitignore] [--starter NAME]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'engines', 'web', 'scaffold');
const RANGE = '^22.12 || ^24 || >=26';

function usage(message) {
  process.stderr.write(`web-scaffold: ${message} (try --help)\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let mode = 'write';
let rootArg = '';
let title = '';
let titleSet = false;
let gitignore = false;
let starter = 'none';
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--dry-run') { if (mode === 'list') usage('--list and --dry-run cannot be combined'); mode = 'dry-run'; }
  else if (arg === '--list') { if (mode === 'dry-run') usage('--list and --dry-run cannot be combined'); mode = 'list'; }
  else if (arg === '--root') { rootArg = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--title') { title = args[i + 1] ?? ''; titleSet = true; i += 1; }
  else if (arg === '--gitignore') gitignore = true;
  else if (arg === '--starter') { starter = args[i + 1] ?? ''; i += 1; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('web-scaffold [--dry-run | --list] [--root DIR] [--title TEXT] [--gitignore] [--starter none|three|phaser|pixi]\n');
    process.exit(0);
  } else usage(`unknown argument: ${arg}`);
}
if (titleSet && title === '') usage('--title needs a value');
if (!existsSync(SRC)) { process.stderr.write(`web-scaffold: the scaffold is missing: ${SRC}\n`); process.exit(1); }
let starterDir = '';
if (starter !== 'none') {
  if (!['three', 'phaser', 'pixi'].includes(starter)) usage('--starter is none, three, phaser or pixi');
  starterDir = join(HERE, '..', 'engines', 'web', 'starters', starter);
  if (!existsSync(starterDir)) { process.stderr.write(`web-scaffold: the ${starter} starter is missing: ${starterDir}\n`); process.exit(1); }
}

/** Every scaffold file, project-relative, with `.tmpl` dropped from the name. */
function listPaths() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      found.push(relative(SRC, path).replace(/\\/g, '/').replace(/\.tmpl$/, ''));
    }
  };
  walk(SRC);
  return found.sort();
}

/** The file that holds one path: the starter's when it has one, else the scaffold's, else its template. */
function stored(path) {
  if (starterDir !== '' && existsSync(join(starterDir, path))) return join(starterDir, path);
  if (existsSync(join(SRC, path))) return join(SRC, path);
  return join(SRC, `${path}.tmpl`);
}

if (mode === 'list') { process.stdout.write(`${listPaths().join('\n')}\n`); process.exit(0); }

const root = resolve(rootArg || join(HERE, '..', '..'));
if (!existsSync(root)) { process.stderr.write(`web-scaffold: cannot read root ${rootArg}\n`); process.exit(1); }
const gameTitle = titleSet ? title : root.split(/[\\/]/).pop();

// The Node.js the project needs, read the way the scaffold's package.json asks for it.
const nodeVersion = process.version.replace(/^v/, '');
const [major, minor] = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
const nodeState = (major === 22 && minor >= 12) || major === 24 || major >= 26 ? 'ok' : 'too-old';
process.stdout.write(`node\tv${nodeVersion}\t${nodeState}\t${RANGE}\n`);
process.stdout.write(`mode\t${mode}\n`);

const library = starterDir === '' ? '-' : (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(starterDir, 'package.json'), 'utf8'));
    const first = Object.entries(pkg.dependencies ?? {})[0];
    return first === undefined ? '-' : `${first[0]}@${String(first[1]).replace(/[^\d.]/g, '')}`;
  } catch { return '-'; }
})();
process.stdout.write(`starter\t${starter}\t${library}\n`);

const created = [];
for (const path of listPaths()) {
  const target = join(root, path);
  if (existsSync(target)) { process.stdout.write(`EXISTS\t${path}\n`); continue; }
  created.push(path);
  if (mode === 'dry-run') { process.stdout.write(`WOULD_CREATE\t${path}\n`); continue; }
  mkdirSync(dirname(target), { recursive: true });
  let body = readFileSync(stored(path), 'utf8');
  if (path === 'index.html') body = body.split('@TITLE@').join(gameTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  if (path === 'package.json') body = body.replace(/"name": "web-game"/, `"name": "${root.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9-]/g, '-')}"`);
  writeFileSync(target, body, 'utf8');
  process.stdout.write(`CREATED\t${path}\n`);
}

// `.gitignore`: the scaffold's lines the project lacks are listed, and with --gitignore appended.
const gitignoreFile = join(root, '.gitignore');
const scaffoldIgnore = readFileSync(join(SRC, '.gitignore'), 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
const existing = existsSync(gitignoreFile) ? readFileSync(gitignoreFile, 'utf8') : '';
const missing = scaffoldIgnore.filter((line) => !existing.split(/\r?\n/).includes(line));
if (missing.length === 0) process.stdout.write('gitignore\tcomplete\n');
else {
  for (const line of missing) process.stdout.write(`gitignore\tmissing\t${line}\n`);
  if (gitignore) {
    const text = `${existing.replace(/\n*$/, '')}\n\n# from the web scaffold\n${missing.join('\n')}\n`;
    writeFileSync(gitignoreFile, text, 'utf8');
    process.stdout.write('gitignore\twritten\n');
  }
}

process.stdout.write(created.length === 0 ? 'scaffold\tcomplete\n' : `scaffold\tcreated ${created.length}\n`);
process.exit(0);
