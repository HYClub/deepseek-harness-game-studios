#!/usr/bin/env node
// cut-read.mjs — what /cut needs to know about a project before it proposes cuts.
//
// Node port of upstream `.dsh/scripts/cut-read.sh` (261 lines). It reads, and only reads: the brief
// (`design/game-brief.md`), the one-shot game folder when the brief is copied there, the check record,
// the feel log, the polish list, the project goal, and the stories traced to a Features item.
//
// Usage: cut-read.mjs [--today YYYY-MM-DD] [--target YYYY-MM-DD] [--root DIR]
// Output: TSV rows, one per fact. Exit 1 when there is no brief (row `brief none`).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const okDate = (value) => DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const dayNumber = (value) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
const isoDay = (z) => new Date(z * 86_400_000).toISOString().slice(0, 10);

function usage(message) {
  process.stderr.write(`cut-read: ${message} (try --help)\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let today = '';
let target = '';
let rootArg = '';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--today') { today = argv[i + 1]; i += 1; }
  else if (argv[i] === '--target') { target = argv[i + 1]; i += 1; }
  else if (argv[i] === '--root') { rootArg = argv[i + 1]; i += 1; }
  else if (argv[i] === '-h' || argv[i] === '--help') {
    process.stdout.write('cut-read [--today YYYY-MM-DD] [--target YYYY-MM-DD] [--root DIR]\n');
    process.exit(0);
  } else usage(`unknown argument: ${argv[i]}`);
}
if (today === '') today = new Date().toISOString().slice(0, 10);
if (!okDate(today)) usage(`--today is a date, YYYY-MM-DD: ${today}`);
if (target !== '' && !okDate(target)) usage(`--target is a date, YYYY-MM-DD: ${target}`);

const root = resolve(rootArg || join(import.meta.dirname, '..', '..'));
const BRIEF = join(root, 'design', 'game-brief.md');
if (!existsSync(BRIEF)) { process.stdout.write('brief\tnone\n'); process.exit(1); }

/** `get_yaml_key` from the shared helper, stderr silenced as the shell does. */
function yget(file, key) {
  if (!existsSync(join(root, file))) return '';
  // The project's own helper first (a payload ships tools/), then this checkout's.
  const helper = [join(root, 'tools', 'yaml-helper.mjs'), join(import.meta.dirname, '..', '..', 'tools', 'yaml-helper.mjs')]
    .find((candidate) => existsSync(candidate));
  if (helper === undefined) return '';
  try {
    return execFileSync(process.execPath, [helper, '__call', 'get_yaml_key', file, key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// ---- The brief, and the game folder that copies it ------------------------------------------------
const GAME_NAME_RE = /^# Game Brief:/;
let game = 'project';
let folder = '';
let copy = '';
if (!existsSync(join(root, 'package.json'))) {
  const briefTitle = (readFileSync(BRIEF, 'utf8').split(/\r?\n/).find((line) => GAME_NAME_RE.test(line)) ?? '').replace(/\r$/, '');
  const prototypes = existsSync(join(root, 'prototypes'))
    ? readdirSync(join(root, 'prototypes'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  let same = '';
  for (const name of prototypes) {
    const candidate = name;
    const brief = join(root, 'prototypes', candidate, 'brief.md');
    if (!existsSync(brief)) continue;
    const text = readFileSync(brief, 'utf8').replace(/\r/g, '');
    if (text === readFileSync(BRIEF, 'utf8').replace(/\r/g, '')) { copy = candidate; break; }
    if (same === '' && briefTitle !== '') {
      const other = (readFileSync(brief, 'utf8').split(/\r?\n/).find((line) => GAME_NAME_RE.test(line)) ?? '').replace(/\r$/, '');
      if (other === briefTitle) same = candidate;
    }
  }
  folder = copy !== '' ? copy : same;
  if (folder !== '') game = 'one-shot';
}
process.stdout.write('brief\t design/game-brief.md\n'.replace(' ', ''));

// ---- The brief's sections -------------------------------------------------------------------------
let title = false;
let section = '';
let featureNumber = 0;
const lines = readFileSync(BRIEF, 'utf8').split(/\r?\n/);
let inComment = false;
const clean = (value) => value.replace(/\t/g, ' ').replace(/[ \t]+$/, '');
for (const raw of lines) {
  const line = raw.replace(/\r$/, '');
  if (inComment) { if (line.includes('-->')) inComment = false; continue; }
  if (/^[ \t]*<!--/.test(line)) { if (!line.includes('-->')) inComment = true; continue; }
  if (GAME_NAME_RE.test(line) && !title) {
    process.stdout.write(`title\t${clean(line.replace(/^# Game Brief: */, ''))}\n`);
    title = true;
    continue;
  }
  const heading = /^## +(.*)$/.exec(line);
  if (heading) {
    const text = heading[1];
    section = '';
    if (/^(Features|MVP)([^A-Za-z]|$)/.test(text)) section = 'feature';
    else if (/^Keep([^A-Za-z]|$)/.test(text)) section = 'keep';
    else if (/^Avoid([^A-Za-z]|$)/.test(text)) section = 'avoid';
    else if (/^Out of scope([^A-Za-z]|$)/.test(text)) section = 'out';
    continue;
  }
  if (/^---[ \t]*$/.test(line)) { section = ''; continue; }
  if (line.startsWith('**Dates:**')) {
    const dates = clean(line).replace(/^\*\*Dates:\*\* */, '');
    const separator = ') · freeze ';
    const at = dates.indexOf(separator);
    const onlyTarget = dates.slice(0, 7) === 'target ' && dates.slice(8, 18);
    const freeze = at >= 0 ? dates.slice(at + separator.length) : '';
    if (onlyTarget && dates.slice(17, 19) === ' (' && at > 20 && okDate(dates.slice(8, 18)) && okDate(freeze)) {
      process.stdout.write(`recorded\t${dates.slice(8, 18)}\t${freeze}\t${dates.slice(19, at)}\n`);
      if (freeze < today) process.stdout.write(`passed\tfreeze\t${freeze}\n`);
      if (dates.slice(8, 18) < today) process.stdout.write(`passed\ttarget\t${dates.slice(8, 18)}\n`);
    } else {
      process.stdout.write(`recorded\tunreadable\t${dates}\n`);
    }
    continue;
  }
  if (section === 'feature') {
    let mark = '';
    let item = '';
    let m = /^[-*] \[[xX]\] (.*)$/.exec(line);
    if (m) { mark = 'built'; item = m[1]; }
    else if ((m = /^[-*] \[ \] (.*)$/.exec(line))) { mark = 'not_yet'; item = m[1]; }
    else if (/^[-*] \[.\][ \t]*$/.test(line) || /^[-*] \[-\]/.test(line)) continue;
    else if ((m = /^[-*] (.*)$/.exec(line))) { mark = 'not_yet'; item = m[1]; }
    else if ((m = /^[0-9]+\. +(.*)$/.exec(line))) { mark = 'not_yet'; item = m[1]; }
    else continue;
    const text = clean(item);
    if (text !== '') process.stdout.write(`feature\t${++featureNumber}\t${mark}\t${text}\n`);
    continue;
  }
  if (section !== '' && /^[-*] /.test(line)) {
    const item = clean(line.slice(2));
    if (item === '') continue;
    if (section === 'out' && item.startsWith('[-] ')) process.stdout.write(`cut\t${item.slice(4)}\n`);
    else process.stdout.write(`${section}\t${item}\n`);
  }
}

// ---- A target date the person gave: the freeze sits 70% of the way there --------------------------
if (target !== '') {
  if (target <= today) {
    process.stdout.write(`target_past\t${target}\n`);
  } else {
    const days = dayNumber(target) - dayNumber(today);
    process.stdout.write(`proposed\tfreeze\t${isoDay(dayNumber(today) + Math.floor((days * 7) / 10))}\t${days}\n`);
  }
}

// ---- The goal: whether dates are asked ------------------------------------------------------------
let goal = '';
let goalSource = '';
for (const file of ['project.local.yaml', 'project.yaml']) {
  if (goal !== '') break;
  goal = yget(file, 'project.goal');
  if (goal !== '') goalSource = file;
}
let datesAsked = 'guess';
if (goal === '') process.stdout.write('goal\t-\tunset\n');
else if (['sell', 'early_access', 'publisher'].includes(goal)) { process.stdout.write(`goal\t${goal}\tset\t${goalSource}\n`); datesAsked = 'asked'; }
else if (['jam', 'learn', 'hobby', 'portfolio', 'mobile', 'other'].includes(goal)) { process.stdout.write(`goal\t${goal}\tset\t${goalSource}\n`); datesAsked = 'not_asked'; }
else process.stdout.write(`goal\t${goal}\tunknown\t${goalSource}\n`);
process.stdout.write(`dates\t${datesAsked}\n`);

// ---- The game: a one-shot folder or the project itself --------------------------------------------
let feelLog = '';
if (game === 'one-shot') {
  process.stdout.write(`game\tone-shot\t${folder}\n`);
  const evidence = join(root, 'prototypes', folder, 'evidence');
  const record = join(evidence, 'check-run.yaml');
  if (existsSync(record)) {
    let newer = '';
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (dir === join(root, 'prototypes', folder) && (entry.name === 'evidence' || entry.name === 'dist')) continue;
          walk(path);
          continue;
        }
        if (['brief.md', 'feel-log.md', 'polish-list.md'].includes(entry.name)) continue;
        if (newer !== '' && statSync(path).mtimeMs <= statSync(record).mtimeMs) continue;
        if (statSync(path).mtimeMs > statSync(record).mtimeMs && (newer === '' || statSync(path).mtimeMs < statSync(newer).mtimeMs)) newer = path;
      }
    };
    walk(join(root, 'prototypes', folder));
    let time = '';
    const open = [];
    let id = '';
    let result = '';
    let mark = '';
    let why = '';
    const flush = () => {
      if (id === '') return;
      if (result === 'fail' && mark !== 'deliberate') open.push(`${id}\t${why === '' ? '-' : why}`);
      id = '';
    };
    for (const line of readFileSync(record, 'utf8').split(/\r?\n/)) {
      const l = line.replace(/\r$/, '');
      let m;
      if ((m = /^time: (.*)$/.exec(l))) { time = m[1].replace(/"/g, ''); continue; }
      if (/^checks:/.test(l)) continue;
      if ((m = /^  - id: (.*)$/.exec(l))) { flush(); id = m[1]; result = ''; mark = ''; why = ''; continue; }
      if ((m = /^    result: (.*)$/.exec(l))) { result = m[1]; continue; }
      if ((m = /^    mark: (.*)$/.exec(l))) { mark = m[1]; continue; }
      if ((m = /^    why: (.*)$/.exec(l))) { why = m[1].replace(/^"|"$/g, '').replace(/\\"/g, '"'); continue; }
    }
    flush();
    process.stdout.write(`record\t${record.slice(root.length + 1)}\t${time === '' ? '-' : time}\t${newer === '' ? 'fresh' : `stale\t${newer.slice(root.length + 1)}`}\n`);
    for (const row of open) process.stdout.write(`open\t${row}\n`);
  } else {
    process.stdout.write('record\tnone\n');
  }
  feelLog = join('prototypes', folder, 'feel-log.md');
} else {
  process.stdout.write('game\tproject\t.\n');
  process.stdout.write('record\tnone\n');
  const engine = yget('project.local.yaml', 'engine.name') || yget('project.yaml', 'engine.name');
  process.stdout.write(engine === '' ? 'smoke\tnone\tno engine set\n' : `smoke\tunset\tthe engine table is not ported for ${engine}\n`);
  feelLog = 'design/feel-log.md';
}

// ---- The feel log ---------------------------------------------------------------------------------
const feelPath = join(root, feelLog);
if (existsSync(feelPath)) {
  const passes = readFileSync(feelPath, 'utf8').split(/\r?\n/).filter((line) => /^## Feel pass /.test(line)).length;
  process.stdout.write(`feel\t${feelLog}\t${passes}\n`);
} else {
  process.stdout.write('feel\tnone\n');
}

// ---- The polish list ------------------------------------------------------------------------------
const polish = join(root, 'design', 'polish-list.md');
if (existsSync(polish)) {
  const name = (value) => value.replace(/[ \t]*\*\([^)]*\)\*[ \t]*$/, '');
  const briefTitle = (readFileSync(BRIEF, 'utf8').split(/\r?\n/).find((line) => GAME_NAME_RE.test(line)) ?? '').replace(/^# Game Brief: */, '').replace(/\r$/, '');
  let listTitle = '';
  let open = 0;
  let ticked = 0;
  const rows = [];
  for (const line of readFileSync(polish, 'utf8').split(/\r?\n/)) {
    if (listTitle === '' && line.startsWith('# Polish list: ')) listTitle = line.slice(15);
    const row = /^- \[ \] (.*)$/.exec(line) ?? /^- \[[xX]\] (.*)$/.exec(line);
    if (row) {
      const isOpen = line.startsWith('- [ ]');
      rows.push(`${isOpen ? 'open' : 'ticked'}\t${row[1]}`);
      if (isOpen) open += 1; else ticked += 1;
    }
  }
  if (listTitle !== '' && name(listTitle) !== name(briefTitle)) {
    process.stdout.write(`polish\tother_game\t${listTitle}\n`);
  } else {
    process.stdout.write(`polish\tdesign/polish-list.md\t${open}\t${ticked}\n`);
    for (const row of rows) process.stdout.write(`polish_row\t${row}\n`);
  }
} else {
  process.stdout.write('polish\tnone\tdesign/polish-list.md\n');
}

// ---- Stories traced to a Features item ------------------------------------------------------------
const epics = join(root, 'production', 'epics');
const stories = [];
if (existsSync(epics)) {
  for (const epic of readdirSync(epics, { withFileTypes: true })) {
    if (!epic.isDirectory()) continue;
    const dir = join(epics, epic.name);
    for (const file of readdirSync(dir)) {
      if (/^story-.*\.md$/.test(file)) stories.push(join(dir, file));
    }
  }
}
let other = 0;
for (const file of stories) {
  let status = '';
  let requirement = '';
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '').replace(/^[ \t]+/, '').replace(/^> /, '').replace(/^- /, '').replace(/\*/g, '');
    if (status === '' && /^Status:/.test(line)) status = line.slice(7).trim();
    if (requirement === '' && /^Requirement:/.test(line)) {
      const m = /Brief MVP feature [0-9]+/.exec(line);
      requirement = m ? m[0].slice(18) : (line.includes('Brief Out of scope:') ? 'cut' : 'other');
    }
  }
  if (requirement === '' || requirement === 'other') other += 1;
  else process.stdout.write(`story\t${requirement}\t${status === '' ? '-' : status}\t${file.slice(root.length + 1)}\n`);
}
if (other > 0) process.stdout.write(`stories_other\t${other}\n`);
process.exit(0);


