#!/usr/bin/env node
// one-shot-new.mjs — make a one-shot game's folder, or add its tweak panel.
//
// Node port of upstream `.dsh/scripts/one-shot-new.sh` (154 lines). A one-shot lives in
// `prototypes/<name>/`: one HTML file, one config file, an assets folder whose provenance file names
// where each file came from, and the brief copied beside them. `--add tune.js` puts the tweak panel
// into a game that already exists.
//
// Usage: one-shot-new.mjs NAME [--question TEXT] [--title TEXT] [--root DIR]
//        one-shot-new.mjs NAME --add tune.js
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = join(HERE, '..', 'docs', 'templates', 'one-shot-lean');
const FILES = ['index.html', 'config.js'];
const ADDONS = ['tune.js'];
const PROVENANCE = `# Where each file in assets/ and vendor/ came from, one entry per file. The field names are the
# provenance record's, so the entries carry over when the game grows.
# - path: assets/hit.wav      # relative to this game's folder
#   origin: ai                # ai | bought | cc0 | you | outsourced | template | plugin | licensed | code | unknown
#   tool: "what made or fetched it: the generator, or the script for code"
#   model: "the model ID, when a model made it or an AI wrote its code"
#   source: {vendor: "who made or sold it", product: "its name", url: "where from"}   # a download
#   licence: {id: CC0-1.0}    # a download: the SPDX id where one exists
#   date: 2026-01-31
#   ships: true               # false for a file only the build uses
#   placeholder: true         # until it is replaced; leave the line out otherwise
`;

function fail(message, code = 2) {
  process.stderr.write(`one-shot-new: ${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let name = '';
let question = '';
let title = '';
let rootArg = '';
const add = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--question') { question = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--title') { title = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--add') { add.push(args[i + 1] ?? ''); i += 1; }
  else if (arg === '--root') { rootArg = args[i + 1] ?? ''; i += 1; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('one-shot-new NAME [--question TEXT] [--title TEXT] [--root DIR] [--add tune.js]\n');
    process.exit(0);
  } else if (arg.startsWith('-')) fail(`unknown argument: ${arg} (try --help)`);
  else if (name !== '') fail('one name only');
  else name = arg;
}
if (name === '') fail('a name is needed (try --help)');
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`'${name}' is not a folder name: use lower-case letters, digits and hyphens, starting with a letter or digit`);
if (name.length > 40) fail(`'${name}' is longer than 40 characters`, 3);

const root = resolve(rootArg || join(HERE, '..', '..'));
if (!existsSync(root)) fail(`no such folder: ${rootArg || root}`, 1);
const relative = `prototypes/${name}`;
const dest = join(root, relative);
const adding = add.length > 0;

if (adding) {
  if (!existsSync(dest)) fail(`--add: no such game: ${relative}`, 1);
  for (const module of add) {
    if (!ADDONS.includes(module)) fail(`--add: not an add-on: ${module} (tune.js is the one add-on)`);
    if (!existsSync(join(LEAN, module))) fail(`the starter is missing: ${join(LEAN, module)}`, 1);
  }
} else {
  for (const file of FILES) if (!existsSync(join(LEAN, file))) fail(`the starter is missing: ${join(LEAN, file)}`, 1);
  if (existsSync(dest)) { process.stdout.write(`exists\t${relative}\n`); process.exit(4); }
}

if (adding && question === '' && existsSync(join(dest, 'config.js'))) {
  const line = readFileSync(join(dest, 'config.js'), 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('// Question: '));
  if (line !== undefined) question = line.slice('// Question: '.length).replace(/\r$/, '');
  if (question === '(not set)') question = '';
}
if (title === '') title = name.replace(/-/g, ' ');
question = question.replace(/[\r\n]/g, '  ');
title = title.replace(/[\r\n]/g, '  ');
const finalQuestion = question === '' ? '(not set)' : question;
const now0 = new Date();
const date = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}-${String(now0.getDate()).padStart(2, '0')}`;

/** Fill the starter's placeholders, the way the shell's awk does: `@TITLE@` is JSON-escaped in a JS
 *  line and HTML-escaped elsewhere, and a double hyphen in a comment is split so it cannot open one. */
function fill(source, target) {
  const jsonTitle = title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const htmlTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const commentQuestion = finalQuestion.replace(/--/g, '- -');
  const text = readFileSync(source, 'utf8').split(/\r?\n/).map((line) => {
    let out = line.includes(`const TITLE = '@TITLE@'`) ? line.split('@TITLE@').join(jsonTitle) : line.split('@TITLE@').join(htmlTitle);
    out = out.split('@QUESTION@').join(commentQuestion);
    return out.split('@DATE@').join(date);
  }).join('\n');
  writeFileSync(target, text, 'utf8');
}

if (adding) {
  for (const module of add) {
    if (existsSync(join(dest, module))) { process.stdout.write(`kept\t${relative}/${module}\n`); continue; }
    fill(join(LEAN, module), join(dest, module));
    process.stdout.write(`added\t${relative}/${module}\n`);
  }
  process.exit(0);
}

mkdirSync(join(dest, 'assets'), { recursive: true });
mkdirSync(join(dest, 'vendor'), { recursive: true });
mkdirSync(join(dest, 'evidence'), { recursive: true });
process.stdout.write(`created\t${relative}\n`);
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
process.stdout.write(`time\t${stamp}\n`);
for (const file of FILES) {
  fill(join(LEAN, file), join(dest, file));
  process.stdout.write(`file\t${relative}/${file}\n`);
}
writeFileSync(join(dest, 'assets', 'provenance.yaml'), PROVENANCE, 'utf8');
process.stdout.write(`file\t${relative}/assets/provenance.yaml\n`);
process.stdout.write(`dir\t${relative}/vendor\n`);
process.stdout.write(`dir\t${relative}/evidence\n`);
const brief = join(root, 'design', 'game-brief.md');
if (existsSync(brief)) {
  copyFileSync(brief, join(dest, 'brief.md'));
  process.stdout.write(`file\t${relative}/brief.md\n`);
}

