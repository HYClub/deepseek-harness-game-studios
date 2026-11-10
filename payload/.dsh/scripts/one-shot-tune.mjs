#!/usr/bin/env node
// one-shot-tune.mjs — write the tweak panel's numbers into config.js, with a feel-log line.
//
// Node port of upstream `.dsh/scripts/one-shot-tune.sh` (208 lines). A value is written only where
// config.js still holds the value the panel started from, the new value lies inside the value's min and
// max (unless --widen says the person asked to move the range), and the value sits on one line with its
// min and max. Every other line gets a row saying why it was left alone; whether to ask is the skill's
// call.
//
// Usage: one-shot-tune.mjs <folder> <line>... [--why TEXT] [--said] [--widen] [--root DIR]
//   <line>  "Tuned in the panel: <name>" then "<key> <from> → <to>" ("->" works too)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (...fields) => process.stdout.write(`${fields.join('\t')}\n`);
const localDate = () => {
  const at = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const args = process.argv.slice(2);
let dir = '';
let rootArg = '';
let why = '';
let said = false;
let widen = false;
const lines = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--why') { why = (args[i + 1] ?? '').replace(/[\r\n]/g, '  '); i += 1; }
  else if (arg === '--root') { rootArg = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--said') said = true;
  else if (arg === '--widen') widen = true;
  else if (arg === '-h' || arg === '--help') { process.stdout.write('one-shot-tune <folder> <line>... [--why TEXT] [--said] [--widen] [--root DIR]\n'); process.exit(0); }
  else if (arg.startsWith('--')) { process.stderr.write(`one-shot-tune: unknown argument: ${arg}\n`); process.exit(2); }
  else if (dir === '') dir = arg;
  else lines.push(arg);
}
if (dir === '') { process.stderr.write('one-shot-tune: a folder is needed\n'); process.exit(2); }
if (lines.length === 0) { process.stderr.write('one-shot-tune: no lines given: pass each line of the pasted block\n'); process.exit(2); }

const root = resolve(rootArg || join(HERE, '..', '..'));
const folder = resolve(root, dir);
if (!existsSync(folder)) { process.stderr.write(`one-shot-tune: no such folder: ${folder}\n`); process.exit(1); }
const grown = !existsSync(join(folder, 'config.js')) && existsSync(join(folder, 'data', 'config.json'));
const configPath = grown ? join(folder, 'data', 'config.json') : join(folder, 'config.js');
if (!existsSync(configPath)) { process.stderr.write(`one-shot-tune: no config.js in ${folder}\n`); process.exit(1); }
const logPath = join(folder, grown ? 'design/feel-log.md' : 'feel-log.md');
const name = folder.split(/[\\/]/).pop();
out('game', name);

const html = existsSync(join(folder, 'index.html')) ? readFileSync(join(folder, 'index.html'), 'utf8') : '';
const title = (/<title>(.*?)<\/title>/.exec(html) ?? [])[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') ?? '';

/** One entry per line: key, the text around it, and the numbers it holds. */
function entries(text) {
  const found = new Map();
  for (const line of text.split('\n')) {
    // A trailing `// comment` is not part of the value; the line itself is kept for the rewrite.
    const bare = line.replace(/\/\/.*$/, '');
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(\{[^}]*\}|[-+0-9.]+)\s*,?\s*$/.exec(bare);
    if (!match) continue;
    const key = match[1];
    const body = match[2];
    const value = /(?:^|[{,]\s*)"?value"?\s*:\s*([-+0-9.]+)/.exec(body) ?? /^([-+0-9.]+)$/.exec(body);
    const lo = /(?:^|[{,]\s*)"?min"?\s*:\s*([-+0-9.]+)/.exec(body);
    const hi = /(?:^|[{,]\s*)"?max"?\s*:\s*([-+0-9.]+)/.exec(body);
    if (!value) continue;
    found.set(key, { line, value: Number(value[1]), lo: lo ? Number(lo[1]) : null, hi: hi ? Number(hi[1]) : null });
  }
  return found;
}

const text = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n');
const table = entries(text);
const eol = text.includes('\r\n') ? '\r\n' : '\n';
let config = text.split(/\r?\n/);
let appends = [];
let exitCode = 0;

const ARROW = /\s*(?:→|->)\s*/;
for (const line of lines) {
  if (/^Tuned in the panel: /.test(line)) {
    const given = line.slice('Tuned in the panel: '.length).trim();
    if (given !== name) { out('other_game', given); process.exit(4); }
    continue;
  }
  const parts = line.split(ARROW);
  if (parts.length !== 2) { out('bad_line', line); continue; }
  const left = parts[0].trim().split(/\s+/);
  const to = Number(parts[1].trim());
  if (left.length !== 2 || !Number.isFinite(to)) { out('bad_line', line); continue; }
  const [key, fromText] = left;
  const from = Number(fromText);
  const entry = table.get(key);
  if (entry === undefined) { out('unknown', key); continue; }
  if (entry.lo === null || entry.hi === null) { out('unreadable', key); continue; }
  if (to === entry.value) { out('same', key, String(entry.value)); continue; }
  if (!said && from !== entry.value) { out('moved', key, String(from), String(entry.value), String(to)); continue; }
  if (!widen && (to < entry.lo || to > entry.hi)) { out('out_of_range', key, String(to), String(entry.lo), String(entry.hi)); continue; }
  let lo = entry.lo;
  let hi = entry.hi;
  if (to < lo || to > hi) {
    const lo2 = Math.min(lo, to);
    const hi2 = Math.max(hi, to);
    out('widened', key, `${lo},${hi}`, `${lo2},${hi2}`);
    lo = lo2;
    hi = hi2;
    config = config.map((line_) => (line_ === entry.line
      ? line_.replace(/"min"\s*:\s*[-+0-9.]+/, `"min": ${lo}`).replace(/min\s*:\s*[-+0-9.]+/, `min: ${lo}`)
        .replace(/"max"\s*:\s*[-+0-9.]+/, `"max": ${hi}`).replace(/max\s*:\s*[-+0-9.]+/, `max: ${hi}`)
      : line_));
  }
  const updated = config.map((line_) => (line_ === entry.line
    ? line_.replace(/((?:[{,]\s*)"?value"?\s*:\s*)[-+0-9.]+/, `$1${to}`).replace(/^(\s*[A-Za-z_$][\w$]*\s*:\s*)[-+0-9.]+/, `$1${to}`)
    : line_));
  config = updated;
  table.get(key).line = updated[updated.indexOf(entry.line)] ?? entry.line;
  out('set', key, String(entry.value), String(to));
  table.set(key, { ...entry, value: to, line: entry.line });
  if (config !== updated) { /* the map above already wrote it */ }
  appends.push(`- ${localDate()} · ${key}: ${entry.value} → ${to}${why === '' ? '' : ` · ${why}`}`);
}

writeFileSync(configPath, config.join(eol), 'utf8');

if (appends.length > 0) {
  const header = grown
    ? `# Feel log: ${title || name}`
    : `<!-- PROTOTYPE - NOT FOR PRODUCTION -->\n${headerComments(html)}# Feel log: ${title || name}`;
  const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8').replace(/\r\n/g, '\n') : `${header}\n`;
  const next = `${existing.replace(/\n*$/, '')}\n\n${appends.join('\n')}\n`;
  writeFileSync(logPath, next, 'utf8');
  out('log', grown ? 'design/feel-log.md' : 'feel-log.md', String(appends.length));
}

/** The prototype header lines the feel log carries: the question and the date from index.html. */
function headerComments(htmlText) {
  const question = (/^<!-- Question: .* -->$/m.exec(htmlText.split('\n').slice(0, 8).join('\n')) ?? [])[0];
  const dateLine = (/^<!-- Date: .* -->$/m.exec(htmlText.split('\n').slice(0, 8).join('\n')) ?? [])[0];
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = dateLine ?? `<!-- Date: ${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} -->`;
  return `${question ? `${question}\n` : ''}${date}\n`;
}

process.exit(exitCode);


