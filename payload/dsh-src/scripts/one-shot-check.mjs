#!/usr/bin/env node
// one-shot-check.mjs — the one-shot's small check, read as rows.
//
// Node port of upstream `.claude/scripts/one-shot-check.sh` (469 lines). The parts that need no browser
// are ported faithfully: the Keep pins against config.js, the brief checklist against
// evidence/checklist.tsv, brief words against evidence/brief-words.tsv, an emoji in the game's code,
// and `--record` writing evidence/check-run.yaml with the shape rules that refuse a pass without
// evidence. The scripted play itself (`--keys`) needs browser automation, which this port does not
// have: it says so with a `not_run` row instead of inventing a pass.
//
// Usage: one-shot-check.mjs <folder> --keys "<inputs>" [--root DIR]
//        one-shot-check.mjs <folder> --keep
//        one-shot-check.mjs <folder> --checklist
//        one-shot-check.mjs <folder> --record boots=<r> shot=<r> outlines=<r>
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = [];
const row = (...fields) => rows.push(fields.join('\t'));

const args = process.argv.slice(2);
let dir = '';
let keys = '';
let rootArg = '';
let record = false;
let keepOnly = false;
let checklistOnly = false;
const results = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--keys') { keys = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--root') { rootArg = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--record') record = true;
  else if (arg === '--keep') keepOnly = true;
  else if (arg === '--checklist') checklistOnly = true;
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('one-shot-check <folder> [--keys TEXT | --keep | --checklist | --record boots= shot= outlines=]\n');
    process.exit(0);
  } else if (arg.startsWith('-')) { process.stderr.write(`one-shot-check: unknown argument: ${arg} (try --help)\n`); process.exit(2); }
  else if (dir === '') dir = arg;
  else if (record) results.push(arg);
  else { process.stderr.write('one-shot-check: one folder only\n'); process.exit(2); }
}
if (dir === '') { process.stderr.write('one-shot-check: a folder is needed (try --help)\n'); process.exit(2); }

const root = resolve(rootArg || join(HERE, '..', '..'));
const folder = /^([A-Za-z]:|\/)/.test(dir) ? resolve(dir) : resolve(root, dir);
if (!existsSync(join(folder, 'index.html'))) { process.stderr.write(`one-shot-check: no index.html in ${folder}\n`); process.exit(1); }
const evidence = join(folder, 'evidence');
const brief = join(folder, 'brief.md');
const config = join(folder, 'config.js');
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').replace(/\r/g, '') : '');
const briefText = read(brief);

const clean = (value) => value.replace(/^[ \t]+|[ \t]+$/g, '').replace(/\t/g, ' ');

/** The pinned values in the brief's Keep lines, compared with what config.js holds now. */
function keepRows() {
  if (!existsSync(brief)) { row('not_assessed', 'keep', 'no brief.md'); return; }
  if (!existsSync(config)) { row('not_assessed', 'keep', 'no config.js'); return; }
  let inKeep = false;
  let inComment = false;
  let lines = 0;
  let pinned = 0;
  const details = [];
  const configText = read(config).split('\n').map((line) => line.replace(/^[ \t]*\/\/.*$/, '').replace(/[ \t]\/\/.*$/, '')).join('\n');
  const valueOf = (key) => {
    const re = new RegExp(`(?:^|[^A-Za-z0-9_$])["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`);
    const at = configText.search(re);
    if (at < 0) return undefined;
    let rest = configText.slice(at).replace(re, '').replace(/^[ \t]+/, '');
    if (rest.startsWith('{')) {
      const end = rest.indexOf('}');
      rest = end >= 0 ? rest.slice(0, end + 1) : rest;
      const inside = /[^A-Za-z0-9_]value[ \t]*:[ \t]*/.exec(rest);
      if (!inside) return undefined;
      rest = rest.slice(inside.index + inside[0].length);
    }
    const value = /^[^ \t,}]+/.exec(rest);
    return value ? value[0] : undefined;
  };
  const same = (a, b) => {
    const unquote = (x) => x.replace(/["']/g, '');
    const left = unquote(a);
    const right = unquote(b);
    if (left === right) return true;
    const numeric = /^[-+]?(\d+\.?\d*|\.\d+)$/;
    return numeric.test(left) && numeric.test(right) && Number(left) === Number(right);
  };
  for (const rawLine of briefText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^## /.test(line)) { inKeep = /^## Keep[ \t]*$/.test(line); continue; }
    if (/^---[ \t]*$/.test(line)) { inKeep = false; continue; }
    if (!inKeep) continue;
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (/^[ \t]*<!--/.test(line)) { if (!line.includes('-->')) inComment = true; continue; }
    if (!/^[-*][ \t]+[^ \t]/.test(line)) continue;
    const item = clean(line.replace(/^[-*][ \t]+/, ''));
    lines += 1;
    const pins = /[ \t]pins:[ \t]*/.exec(item);
    if (!pins) { details.push(`keep\t${lines}\tunpinned\t${item}`); continue; }
    pinned += 1;
    for (const part of item.slice(pins.index + pins[0].length).split(',')) {
      const entry = part.trim();
      if (entry === '') continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*[ \t]+[^ \t]+$/.test(entry)) { details.push(`keep\t${lines}\tunreadable\t${entry}`); continue; }
      const key = entry.split(/[ \t]/)[0];
      const want = entry.replace(/^[^ \t]+[ \t]+/, '');
      const now = valueOf(key);
      if (now === undefined) details.push(`keep\t${lines}\tgone\t${key}\t${want}\t-`);
      else details.push(`keep\t${lines}\t${same(want, now) ? 'same' : 'changed'}\t${key}\t${want}\t${now}`);
    }
  }
  row('keep', 'lines', String(lines), 'pinned', String(pinned));
  for (const detail of details) row(...detail.split('\t'));
}

/** The brief checklist: each Features item, Look line and Your systems line, marked against evidence. */
function checklistRows() {
  if (!existsSync(brief)) return;
  const responses = new Map();
  const checklist = join(evidence, 'checklist.tsv');
  if (existsSync(checklist)) {
    for (const line of read(checklist).split('\n')) {
      if (line.trim() === '') continue;
      const fields = line.split('\t');
      responses.set(fields[0], { status: fields[1] ?? '', evidence: fields[2] ?? '', why: fields[3] ?? '' });
    }
  }
  const items = [];
  let section = '';
  let inComment = false;
  const counters = { F: 0, L: 0, S: 0 };
  for (const line of briefText.split('\n')) {
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (/^[ \t]*<!--/.test(line)) { if (!line.includes('-->')) inComment = true; continue; }
    const heading = /^## (.*)$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    if (section === 'Features' && /^- \[[ xX]\] /.test(line)) items.push({ id: `F${++counters.F}`, text: line.slice(6).trim() });
    if (section === 'Look and references' && /^- /.test(line)) items.push({ id: `L${++counters.L}`, text: line.slice(2).trim() });
    if (section === 'Your systems' && /^- /.test(line) && !/ · later( |$)/.test(line) && !/ · (thin stand-in|later)( |$)/.test(line)) {
      items.push({ id: `S${++counters.S}`, text: line.slice(2).trim() });
    }
  }
  for (const item of items) {
    const response = responses.get(item.id);
    if (response === undefined) { row('checklist', item.id, 'unlisted', '-', item.text); continue; }
    let status = ['pass', 'missing', 'broken', 'not_assessed'].includes(response.status) ? response.status : 'unlisted';
    if (status === 'not_assessed' && response.why === '') status = 'unlisted';
    if (status === 'pass') {
      const named = response.evidence;
      const looksLikePath = named.includes('/') || /\.(png|jpe?g|webp|tsv|txt|ya?ml|json)$/.test(named);
      if (looksLikePath ? !existsSync(join(folder, named)) : !/\d/.test(named)) status = 'noevidence';
    }
    row('checklist', item.id, status, response.evidence === '' ? '-' : response.evidence, item.text);
  }
}

/** An emoji in the game's own code, unless the brief asks for emoji. */
function emojiRows() {
  if (existsSync(brief) && /emoji/i.test(briefText)) return;
  for (const name of readdirSync(folder)) {
    if (!/\.(html|js)$/.test(name) || name === 'bot.js') continue;
    const lines = read(join(folder, name)).split('\n');
    let found = 0;
    for (let i = 0; i < lines.length && found < 5; i += 1) {
      if (/[\u{1F300}-\u{1FAFF}\u{FE0F}]/u.test(lines[i])) { row('art', 'emoji', `${name}:${i + 1}`); found += 1; }
    }
  }
}

/** The look/view words in the brief's "In your words", each against evidence/brief-words.tsv. */
function briefWords() {
  if (!existsSync(brief)) return;
  const words = [];
  let inSection = false;
  for (const line of briefText.split('\n')) {
    if (/^## In your words/.test(line)) { inSection = true; continue; }
    if (inSection && /^## /.test(line)) break;
    if (!inSection || /^<!--/.test(line)) continue;
    const found = line.match(/\b(2\.5 ?d|2d|3d|isometric|top[- ]down|side[- ]on|side[- ]scroll(?:ing|er)?|first[- ]person|third[- ]person|vector|pixel art|low[- ]poly)\b/gi);
    if (found) for (const word of found) words.push(word.toLowerCase());
  }
  const unique = [...new Set(words)];
  if (unique.length === 0) return;
  const table = new Map();
  const wordsFile = join(evidence, 'brief-words.tsv');
  if (existsSync(wordsFile)) {
    for (const line of read(wordsFile).split('\n')) {
      if (line.trim() === '') continue;
      const fields = line.split('\t');
      table.set(fields[0].toLowerCase(), { how: fields[1] ?? '', shot: fields[2] ?? '' });
    }
  }
  for (const word of unique) {
    const entry = table.get(word);
    if (entry === undefined || entry.how === '') { row('briefword', word, 'unlisted'); continue; }
    if (entry.how.startsWith('miss:')) { row('briefword', word, 'missed', entry.how.slice(5).replace(/^ */, '')); continue; }
    if (entry.shot !== '' && existsSync(join(folder, entry.shot))) row('briefword', word, 'shown', entry.shot);
    else row('briefword', word, 'unlisted', `no shot at ${entry.shot === '' ? '-' : entry.shot}`);
  }
}

function now() {
  const at = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function writeSelfCheck() {
  mkdirSync(evidence, { recursive: true });
  const text = [`time\t${now()}`, ...rows].join('\n') + '\n';
  writeFileSync(join(evidence, 'self-check.tsv'), text, 'utf8');
}

if (keepOnly) {
  keepRows();
} else if (checklistOnly) {
  checklistRows();
} else if (record) {
  // The shape rules: a pass needs the evidence the rows name, and a run that played.
  const values = {};
  for (const item of results) {
    const at = item.indexOf('=');
    if (at > 0) values[item.slice(0, at)] = item.slice(at + 1);
  }
  const runsFile = join(evidence, 'self-check.runs');
  const runs = existsSync(runsFile) ? Number.parseInt(read(runsFile).trim(), 10) || 0 : 0;
  const lines = [`time: "${now()}"`, 'checks:'];
  for (const key of ['boots', 'shot', 'outlines']) {
    const value = values[key] ?? 'not_run:not-assessed:no value given';
    if (value === 'pass') {
      if (key === 'boots' && runs === 0) { process.stderr.write('one-shot-check: boots=pass needs a run in evidence/self-check.runs\n'); process.exit(2); }
      if (key === 'shot' && !readdirSync(folder).some((name) => /\.(png|jpe?g|webp)$/.test(name)) && !existsSync(join(evidence, 'shot.png'))) {
        process.stderr.write('one-shot-check: shot=pass needs a screenshot on disk\n');
        process.exit(2);
      }
      if (key === 'outlines' && !existsSync(join(evidence, 'figures.png'))) {
        process.stderr.write('one-shot-check: outlines=pass needs evidence/figures.png\n');
        process.exit(2);
      }
    }
    lines.push(`  - id: ${key}`, `    result: ${value.startsWith('pass') ? 'pass' : value.startsWith('fail') ? 'fail' : 'not_run'}`, `    why: "${value.split(':').slice(1).join(':') || '-'}"`);
  }
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'check-run.yaml'), `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`record\t${join('evidence', 'check-run.yaml')}\n`);
} else {
  // --keys: the scripted play needs a browser harness, which this port does not ship.
  keepRows();
  emojiRows();
  briefWords();
  checklistRows();
  row('lane', 'play', 'not_run', '0', '0');
  row('not_assessed', 'play', 'the scripted play needs browser automation, which this port does not ship');
  writeSelfCheck();
}
process.stdout.write(`${rows.join('\n')}${rows.length ? '\n' : ''}`);
