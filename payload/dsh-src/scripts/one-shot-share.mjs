#!/usr/bin/env node
// one-shot-share.mjs — the folder you hand to someone: the game without its working files.
//
// Node port of upstream `.claude/scripts/one-shot-share.sh` (94 lines). It copies the game's shipping
// files into <folder>/dist, leaves out the tweak panel, the check's bot, the brief, the feel log and
// the evidence folder, strips the tweak-panel script tag from index.html, and reports any file that
// still names tune.js (exit 5) so a shared build cannot quietly keep its debug panel.
//
// Usage: one-shot-share.mjs <folder> [--root DIR]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let dir = '';
let rootArg = '';
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--root') { rootArg = args[i + 1] ?? ''; i += 1; }
  else if (arg === '-h' || arg === '--help') { process.stdout.write('one-shot-share <folder> [--root DIR]\n'); process.exit(0); }
  else if (arg.startsWith('-')) { process.stderr.write(`one-shot-share: unknown argument: ${arg} (try --help)\n`); process.exit(2); }
  else if (dir !== '') { process.stderr.write('one-shot-share: one folder only\n'); process.exit(2); }
  else dir = arg;
}
if (dir === '') { process.stderr.write('one-shot-share: a folder is needed (try --help)\n'); process.exit(2); }

const root = resolve(rootArg || join(HERE, '..', '..'));
const show = dir.replace(/\/$/, '');
const folder = /^([A-Za-z]:|\/)/.test(dir) ? resolve(dir) : resolve(root, dir);
if (!existsSync(join(folder, 'index.html'))) { process.stderr.write(`one-shot-share: no index.html in ${folder}\n`); process.exit(1); }
const dist = join(folder, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
process.stdout.write(`dist\t${show}/dist\n`);

const LEFT_OUT = new Set(['tune.js', 'bot.js', 'brief.md', 'feel-log.md', 'REPORT.md', 'evidence']);
for (const name of readdirSync(folder).sort()) {
  if (name === '' || name === 'dist') continue;
  if (LEFT_OUT.has(name) || name.startsWith('.')) { process.stdout.write(`left_out\t${name}\n`); continue; }
  cpSync(join(folder, name), join(dist, name), { recursive: true });
}

// The tweak panel is an add-on: the shipping index.html must not carry its script tag.
const strip = /<script[^>]*src=["'](?:\.\/)?tune\.js["'][^>]*>[ \t]*<\/script>/g;
const source = readFileSync(join(folder, 'index.html'), 'utf8');
const kept = [];
for (const line of source.split('\n')) {
  const before = line;
  let stripped = before.replace(strip, '');
  if (stripped !== before) {
    for (const match of before.match(strip) ?? []) process.stdout.write(`stripped\tindex.html\t${match}\n`);
    if (stripped.trim() === '') continue;
  }
  kept.push(stripped);
}
writeFileSync(join(dist, 'index.html'), kept.join('\n'), 'utf8');

let found = 0;
const walk = (dir_) => {
  for (const entry of readdirSync(dir_, { withFileTypes: true })) {
    const path = join(dir_, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!/\.(html?|js|mjs|css|json)$/.test(entry.name)) continue;
    const name = relative(dist, path).replace(/\\/g, '/');
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (/tune\.js/.test(line)) { process.stdout.write(`found\t${name}\t${index + 1}\n`); found = 1; }
    });
  }
};
walk(dist);

const count = (dir_) => readdirSync(dir_, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? count(join(dir_, entry.name)) : 1), 0);
process.stdout.write(`files\t${count(dist)}\n`);
process.exit(found === 0 ? 0 : 5);
