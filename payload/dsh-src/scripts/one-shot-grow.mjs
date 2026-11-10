#!/usr/bin/env node
// one-shot-grow.mjs — grow a one-shot out of prototypes/<name>/ into a web project at the root.
//
// Node port of upstream `.claude/scripts/one-shot-grow.sh` (470 lines). Everything is copied OUT of
// the one-shot; nothing in prototypes/<name>/ is edited, moved or deleted, and no file that already
// exists is overwritten. What the script cannot decide — splitting the code, TypeScript, the tests —
// is the skill's job, and it says so in rows.
//
// Usage: one-shot-grow.mjs guard  <name> [--root DIR]
//        one-shot-grow.mjs copy   <name> [--root DIR]
//        one-shot-grow.mjs record <name> [--root DIR]
//        one-shot-grow.mjs replay <name> --as reference|copy|typescript|story [--stop N] [--log TEXT] [--hookless]
//        one-shot-grow.mjs accept <name> [--root DIR]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (...fields) => process.stdout.write(`${fields.join('\t')}\n`);
const fail = (message, code = 2) => { process.stderr.write(`one-shot-grow: ${message}\n`); process.exit(code); };

const argv = process.argv.slice(2);
const extra = {};
const positional = [];
let rootArg = '';
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--as') { extra.as = argv[i + 1]; i += 1; }
  else if (arg === '--stop') { extra.stop = argv[i + 1]; i += 1; }
  else if (arg === '--log') { extra.log = argv[i + 1]; i += 1; }
  else if (arg === '--hookless') extra.hookless = true;
  else if (arg === '--root') { rootArg = argv[i + 1] ?? ''; i += 1; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('one-shot-grow guard|copy|record|replay|accept <name> [--root DIR]\n');
    process.exit(0);
  } else if (!arg.startsWith('--')) positional.push(arg);
}
const [cmd, name] = positional;
if (!['guard', 'copy', 'record', 'replay', 'accept'].includes(cmd ?? '')) fail(`unknown command: ${cmd ?? '-'} (guard, copy, record, replay or accept)`);
if (!name) fail('a name is needed (try --help)');

const root = resolve(rootArg || join(HERE, '..', '..'));
const OS_DIR = join(root, 'prototypes', name);
const GROW = join(HERE, '..', 'engines', 'web', 'grow');
const CROOT = 'src';
const EVD = join(root, 'production', 'qa', 'evidence', `grow-${name}`);
const isGit = () => existsSync(join(root, '.git'));
const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

function yamlValue(file, key) {
  if (!existsSync(join(root, file))) return '';
  const helper = [join(root, 'tools', 'yaml-helper.mjs'), join(HERE, '..', '..', 'tools', 'yaml-helper.mjs')].find((candidate) => existsSync(candidate));
  if (helper === undefined) return '';
  try { return execFileSync(process.execPath, [helper, '__call', 'get_yaml_key', file, key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** The four grow conditions. Returns true when every one passed; rows are already printed. */
function runGuard() {
  if (!existsSync(join(OS_DIR, 'index.html'))) { out('not_one_shot', `prototypes/${name}`, 'no index.html there'); process.exit(3); }
  out('one_shot', `prototypes/${name}`);
  if (!existsSync(join(OS_DIR, 'config.js'))) out('no_config', `prototypes/${name}`, 'no config.js (a game brought in by the door): no data/config.json is made');
  let failed = false;

  const range = '^22.12 || ^24 || >=26';
  const version = process.version.replace(/^v/, '');
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if ((major === 22 && minor >= 12) || major === 24 || major >= 26) out('guard', 'node', 'pass', `v${version}`, 'ok', range);
  else { out('guard', 'node', 'fail', `v${version}`, 'too-old', range); failed = true; }

  let engine = yamlValue('project.local.yaml', 'engine.name') || yamlValue('project.yaml', 'engine.name');
  if (engine === '' && !existsSync(join(root, 'project.yaml')) && existsSync(join(root, 'CLAUDE.md'))) {
    const line = readFileSync(join(root, 'CLAUDE.md'), 'utf8').split('\n').find((entry) => /^\s*-\s*\*\*Engine\*\*:/.test(entry));
    if (line) engine = line.replace(/.*\*\*Engine\*\*:\s*/, '').replace(/\[.*$/, '').trim();
  }
  if (/^\[|TO BE CONFIGURED/.test(engine)) engine = '';
  if (engine === '') out('guard', 'engine', 'pass', 'unset');
  else if (engine === 'Web') out('guard', 'engine', 'pass', 'Web');
  else { out('guard', 'engine', 'fail', engine); failed = true; }

  let why = '';
  const override = yamlValue('project.yaml', 'engine.code_root');
  if (!['', '~', 'null', 'NULL', CROOT, `${CROOT}/`, `./${CROOT}`, `./${CROOT}/`].includes(override)) {
    why = `engine.code_root is ${override}: a grown game's code goes in ${CROOT}/, Web's code root`;
  }
  if (why === '' && existsSync(join(root, 'package.json'))) why = 'package.json is at the root';
  if (why === '' && existsSync(join(root, 'index.html'))) why = 'index.html is at the root (a game left there?)';
  if (why === '' && existsSync(join(root, CROOT))) {
    const first = firstFile(join(root, CROOT), ['CLAUDE.md', 'README.md', '.gitkeep']);
    if (first !== '') why = `${CROOT}/ holds ${first}`;
  }
  if (why === '' && isGit()) {
    const tag = git(['tag', '-l', 'grown/*']).split('\n')[0];
    if (tag) why = `the tag ${tag} is here`;
  }
  if (why !== '') { out('guard', 'root', 'fail', why); failed = true; } else out('guard', 'root', 'pass', 'not grown');

  if (isGit()) {
    out('guard', 'git', 'pass');
    const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', `prototypes/${name}`]).split('\n').filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, '').replace(/.* -> /, ''))
      .filter((path) => !/(^|\/)brief\.md$/.test(path) && !/(^|\/)evidence\//.test(path) && !/(^|\/)dist\//.test(path));
    if (dirty.length === 0) out('guard', 'clean', 'pass', '0', '-');
    else { out('guard', 'clean', 'fail', String(dirty.length), dirty[0]); failed = true; }
    out('commit', git(['log', '-1', '--format=%h', '--', `prototypes/${name}`]) || '-');
    out('tag', `one-shot/${name}`, git(['rev-parse', '--short', `one-shot/${name}^{commit}`]) || 'none');
    for (const file of [`prototypes/${name}/brief.md`, 'design/game-brief.md']) {
      if (existsSync(join(root, file)) && git(['status', '--porcelain', '--', file]) !== '') out('brief_dirty', file);
    }
  } else {
    out('guard', 'git', 'none');
    out('guard', 'clean', 'pass', '0', 'not a git project: the one-shot folder is the backup');
  }
  return !failed;
}

function firstFile(dir, skip) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const nested = firstFile(path, skip); if (nested !== '') return nested; continue; }
    if (!skip.includes(entry.name)) return relative(root, path).replace(/\\/g, '/');
  }
  return '';
}

if (cmd === 'guard') process.exit(runGuard() ? 0 : 3);

if (cmd === 'record') {
  if (yamlValue('project.yaml', 'engine.name') === 'Web') { out('engine', 'Web', 'set'); process.exit(0); }
  let vite = '-';
  try { vite = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies?.vite ?? '-').replace(/[^\d.]/g, '') || '-'; } catch { vite = '-'; }
  try {
    execFileSync(process.execPath, [join(HERE, 'config-set.mjs'), 'engine.name', 'Web', '--root', root], { cwd: root, encoding: 'utf8' });
    if (vite !== '-') execFileSync(process.execPath, [join(HERE, 'config-set.mjs'), 'engine.version', vite, '--root', root], { cwd: root, encoding: 'utf8' });
    out('engine', 'Web', 'written');
  } catch (error) {
    process.stderr.write(`one-shot-grow: could not write engine.name: ${String(error.stdout ?? error.message)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ---- copy: the scaffold's tooling, then the one-shot's page, script, values, assets and feel log ----
if (cmd === 'copy') {
  if (!runGuard()) process.exit(3);
  if (!existsSync(join(GROW, 'config.js')) || !existsSync(join(GROW, 'tune.ts'))) fail('.dsh/engines/web/grow/ is missing', 1);
  let failed = false;
  const put = (rel, source) => {
    const target = join(root, rel);
    if (existsSync(target)) { out('EXISTS', rel); return; }
    mkdirSync(dirname(target), { recursive: true });
    try { cpSync(source, target); out('CREATED', rel); } catch { out('FAILED', rel); failed = true; }
  };
  const title = (readFileSync(join(OS_DIR, 'index.html'), 'utf8').split('\n').find((line) => /<title>/.test(line)) ?? '')
    .replace(/.*<title>(.*?)<\/title>.*/, '$1').trim() || name;
  const slug = name.toLowerCase();

  const work = mkdtempDir();
  mkdirSync(join(work, 's'), { recursive: true });
  execFileSync(process.execPath, [join(HERE, 'web-scaffold.mjs'), '--root', join(work, 's'), '--title', title], { encoding: 'utf8' });
  for (const file of ['package.json', 'package-lock.json']) {
    const text = readFileSync(join(work, 's', file), 'utf8').split('"name": "web-game"').join(`"name": "${slug}"`);
    const target = join(work, `w-${file}`);
    writeFileSync(target, text, 'utf8');
    put(file, target);
  }
  for (const file of ['vite.config.ts', 'tsconfig.json', 'playwright.config.ts', `${CROOT}/hook.ts`]) put(file, join(work, 's', file));
  if (existsSync(join(root, '.gitignore'))) {
    const have = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
    const missing = readFileSync(join(work, 's', '.gitignore'), 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '' && !have.includes(line));
    if (missing.length > 0) {
      const text = `${readFileSync(join(root, '.gitignore'), 'utf8').replace(/\n*$/, '')}\n\n# === Web: Vite, Vitest and Playwright output ===\n${missing.join('\n')}\n`;
      writeFileSync(join(root, '.gitignore'), text, 'utf8');
      for (const line of missing) out('gitignore', line, 'added');
    }
  } else put('.gitignore', join(work, 's', '.gitignore'));

  // The page: markup and styles; the inline script becomes the code root's main.js.
  const hasConfig = existsSync(join(OS_DIR, 'config.js'));
  const pageLines = [];
  const scriptLines = ['// The game: the one-shot\'s script, carried over as it was. The grow step splits it', '// by what the code does and moves it to TypeScript.', ...(hasConfig ? ["import './config.js';", ''] : [''])];
  let inline = false;
  let moved = false;
  const pageSource = readFileSync(join(OS_DIR, 'index.html'), 'utf8').split(/\r?\n/);
  pageSource.forEach((line, index) => {
    if (/^[ \t]*<!--[ \t]*(PROTOTYPE - NOT FOR PRODUCTION|Question:|Date:)/.test(line) && index < 6) return;
    if (inline) { if (/^[ \t]*<\/script>[ \t]*$/.test(line)) { inline = false; return; } scriptLines.push(line); return; }
    if (/^[ \t]*<script[ \t]+src="(\.\/)?(config|tune)\.js"[ \t]*><\/script>[ \t]*$/.test(line)) return;
    if (!moved && /^[ \t]*<script>[ \t]*$/.test(line)) { inline = true; moved = true; pageLines.push(`<script type="module" src="./${CROOT}/main.js"></script>`); return; }
    if (/<script/.test(line)) out('left', 'script', line.trim());
    pageLines.push(line);
  });
  if (!moved) out('left', 'script', `no inline script was found: ${CROOT}/main.js holds only the config import`);
  const pageFile = join(work, 'page.html');
  writeFileSync(pageFile, pageLines.join('\n'), 'utf8');
  put('index.html', pageFile);
  const mainFile = join(work, 'main.js');
  writeFileSync(mainFile, scriptLines.join('\n') + '\n', 'utf8');
  put(`${CROOT}/main.js`, mainFile);
  if (hasConfig) {
    put(`${CROOT}/config.js`, join(GROW, 'config.js'));
    const tune = readFileSync(join(GROW, 'tune.ts'), 'utf8').split('@NAME@').join(basename(root));
    const tuneFile = join(work, 'tune.ts');
    writeFileSync(tuneFile, tune, 'utf8');
    put(`${CROOT}/dev/tune.ts`, tuneFile);
  }

  // The values: window.CONFIG read with Node, one entry a line; its comments go to the notes.
  if (hasConfig) {
    if (existsSync(join(root, 'data/config.json'))) out('EXISTS', 'data/config.json');
    else {
      const values = extractConfig(join(OS_DIR, 'config.js'));
      if (values === null) { out('FAILED', 'data/config.json', 'config.js could not be read by Node'); failed = true; }
      else {
        mkdirSync(join(root, 'data'), { recursive: true });
        writeFileSync(join(root, 'data/config.json'), `${JSON.stringify(values.body, null, 2)}\n`, 'utf8');
        out('CREATED', 'data/config.json');
        out('config', String(values.count), String(values.sliders));
      }
    }
    if (!existsSync(join(root, 'data/config-notes.md'))) {
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, 'data/config-notes.md'), configNotes(join(OS_DIR, 'config.js')), 'utf8');
      put('data/config-notes.md', join(root, 'data/config-notes.md'));
    } else out('EXISTS', 'data/config-notes.md');
  }

  // Assets, with their provenance; vendor/ stays the skill's business.
  if (existsSync(join(OS_DIR, 'assets'))) {
    for (const file of walkFiles(join(OS_DIR, 'assets'))) put(relative(OS_DIR, file).replace(/\\/g, '/'), file);
  }
  if (existsSync(join(OS_DIR, 'vendor'))) {
    for (const file of walkFiles(join(OS_DIR, 'vendor'))) out('left', 'vendor', relative(OS_DIR, file).replace(/\\/g, '/'));
  }

  if (existsSync(join(OS_DIR, 'feel-log.md'))) {
    const kept = readFileSync(join(OS_DIR, 'feel-log.md'), 'utf8').split(/\r?\n/)
      .filter((line, index) => !(index < 4 && /^<!--[ \t]*(PROTOTYPE - NOT FOR PRODUCTION|Question:|Date:)/.test(line)));
    const feel = join(work, 'feel-log.md');
    writeFileSync(feel, kept.join('\n'), 'utf8');
    put('design/feel-log.md', feel);
  }
  if (!existsSync(join(root, 'node_modules'))) out('NEEDS', 'npm_install', 'npm ci');
  rmTree(work);
  process.exit(failed ? 1 : 0);
}

// ---- replay: the same scripted run, compared with the reference -------------------------------------
if (cmd === 'replay') {
  const as = extra.as;
  if (!['reference', 'copy', 'typescript', 'story'].includes(as ?? '')) fail('--as is reference, copy, typescript or story');
  mkdirSync(EVD, { recursive: true });
  let stop = extra.stop ? Number.parseInt(extra.stop, 10) : 3600;
  let log = extra.log ?? '';
  let hookless = extra.hookless === true;
  if (as !== 'reference') {
    if (!existsSync(join(EVD, 'replay.args'))) { out('match', 'not_assessed', 'no reference run: replay --as reference first'); process.exit(4); }
    const saved = readFileSync(join(EVD, 'replay.args'), 'utf8').split('\n');
    const savedStop = saved.find((line) => line.startsWith('stop\t'));
    if (savedStop) stop = Number.parseInt(savedStop.split('\t')[1], 10);
    if (saved.some((line) => line.startsWith('hookless\t'))) hookless = true;
    const savedLog = saved.find((line) => line.startsWith('log\t'));
    if (log === '' && savedLog) log = savedLog.slice(4);
  }
  if (!(stop > 120)) { out('not_assessed', '--stop must be past 120 steps'); process.exit(4); }
  let playArgs;
  if (log !== '') playArgs = ['--log', log];
  else if (existsSync(join(OS_DIR, 'bot.js'))) playArgs = ['--bot', 'end'];
  else { out('not_assessed', `no bot.js in prototypes/${name} and no --log: nothing plays the game`); process.exit(4); }

  const work = mkdtempDir();
  let dir = OS_DIR;
  let botCopy = '';
  if (as !== 'reference') {
    if (!existsSync(join(root, 'dist-single/index.html'))) { out('not_assessed', 'no dist-single/index.html: npm run build:single first'); process.exit(4); }
    dir = join(work, 'game');
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'dist-single/index.html'), join(dir, 'index.html'));
    if (existsSync(join(OS_DIR, 'bot.js'))) { cpSync(join(OS_DIR, 'bot.js'), join(dir, 'bot.js')); botCopy = join(dir, 'bot.js'); }
  }
  const runOnce = (png, tsv) => {
    try {
      const text = execFileSync(process.execPath, [join(HERE, 'one-shot-run.mjs'), dir, png, ...playArgs, '--stop', String(stop), '--trace', String(stop - 120), ...(hookless ? ['--hookless'] : []), '--root', root], { encoding: 'utf8', timeout: 600000 });
      writeFileSync(tsv, text, 'utf8');
      return { code: 0, text };
    } catch (error) {
      const text = String(error.stdout ?? '');
      writeFileSync(tsv, text, 'utf8');
      return { code: error.status ?? 1, text };
    }
  };
  const first = runOnce(join(EVD, `${as}.png`), join(EVD, `${as}.tsv`));
  out('run', as, relative(root, join(EVD, `${as}.tsv`)).replace(/\\/g, '/'), relative(root, join(EVD, `${as}.png`)).replace(/\\/g, '/'), String(first.code));
  if (first.code === 3 || first.text.trim() === '') {
    for (const line of first.text.split('\n')) if (line.startsWith('not_assessed')) out(...line.split('\t'));
    process.exit(4);
  }
  const errors = first.text.split('\n').filter((line) => /^(crash|error)\t/.test(line) || /^uncaught\t[1-9]/.test(line)).length;
  out('errors', String(errors));

  if (as === 'reference') {
    writeFileSync(join(EVD, 'replay.args'), [`stop\t${stop}`, ...(log !== '' ? [`log\t${log}`] : []), ...(hookless ? ['hookless\t1'] : [])].join('\n') + '\n', 'utf8');
    const again = runOnce(join(work, 'again.png'), join(EVD, 'reference-again.tsv'));
    out('run', 'reference-again', relative(root, join(EVD, 'reference-again.tsv')).replace(/\\/g, '/'), '-', String(again.code));
    const diff = firstDiff(join(EVD, 'reference.tsv'), join(EVD, 'reference-again.tsv'));
    said('exact', diff);
    writeFileSync(join(EVD, 'exact'), diff === '' ? 'yes\n' : 'no\n', 'utf8');
    rmTree(work);
    process.exit(0);
  }
  if (!existsSync(join(EVD, 'reference.tsv'))) { out('match', 'not_assessed', 'no reference run: replay --as reference first'); process.exit(4); }
  if (readFileSync(join(EVD, 'exact'), 'utf8').trim() !== 'yes') { out('match', 'not_assessed', "the one-shot's own two runs differ, so no run can match it exactly"); process.exit(0); }
  const base = as === 'story' && existsSync(join(EVD, 'accepted.tsv')) ? 'accepted' : 'reference';
  if (as === 'story') out('against', base);
  said('match', firstDiff(join(EVD, `${base}.tsv`), join(EVD, `${as}.tsv`)));
  rmTree(work);
  process.exit(0);
}

// ---- accept ----------------------------------------------------------------------------------------
for (const [from, to] of [['story.tsv', 'accepted.tsv'], ['story.png', 'accepted.png']]) {
  if (!existsSync(join(EVD, from))) fail(`no ${from} in production/qa/evidence/grow-${name}`, 1);
  cpSync(join(EVD, from), join(EVD, to));
  out('accepted', `production/qa/evidence/grow-${name}/${to}`);
}
process.exit(0);

// ---- helpers ---------------------------------------------------------------------------------------
function mkdtempDir() {
  const base = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `dsgs-grow-${process.pid}-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  return base;
}
function rmTree(dir) { try { execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(dir)},{recursive:true,force:true})`], { stdio: 'ignore' }); } catch { /* left behind is fine */ } }
function walkFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path)); else found.push(path);
  }
  return found;
}
/** window.CONFIG read in an empty sandbox: the values, how many, and how many are sliders. */
function extractConfig(file) {
  const script = `
    const fs = require('fs'), vm = require('vm');
    const sb = { window: {} }; sb.globalThis = sb; vm.createContext(sb);
    vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), sb, { filename: 'config.js', timeout: 2000 });
    const C = sb.window.CONFIG;
    if (!C || typeof C !== 'object') { console.error('config.js sets no window.CONFIG'); process.exit(5); }
    const four = ['value', 'min', 'max', 'step'];
    const slider = (v) => v && typeof v === 'object' && four.every((f) => typeof v[f] === 'number');
    const lost = (v, p) => typeof v === 'function' ? p + '\\ta function' : typeof v === 'number' && !isFinite(v) ? p + '\\tnot a finite number'
      : v && typeof v === 'object' ? Object.keys(v).map((k) => lost(v[k], p + '.' + k)).find(Boolean) : '';
    const keys = Object.keys(C); let n = 0;
    const body = {};
    for (const k of keys) {
      const v = C[k], why = lost(v, k);
      if (why) process.stdout.write('config_lost\\t' + why + '\\n');
      if (slider(v)) { n++; body[k] = Object.fromEntries(four.concat(Object.keys(v).filter((f) => !four.includes(f))).map((f) => [f, v[f]])); }
      else body[k] = v;
    }
    process.stdout.write(JSON.stringify({ n: keys.length, sliders: n, body }) + '\\n');
  `;
  const scriptFile = join(mkdtempDir(), 'extract.cjs');
  writeFileSync(scriptFile, script, 'utf8');
  try {
    const raw = execFileSync(process.execPath, [scriptFile, file], { encoding: 'utf8' });
    const last = raw.trim().split('\n').pop();
    const parsed = JSON.parse(last);
    return { count: parsed.n, sliders: parsed.sliders, body: parsed.body };
  } catch { return null; }
}
/** The comments beside config.js's values, kept as notes. */
function configNotes(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = ['# The values\' notes', '', `What \`prototypes/${name}/config.js\` said beside its values, kept here because the game now`, 'holds no comments. The values themselves are in `data/config.json`.', ''];
  let inside = false;
  for (const line of lines) {
    if (/window\.CONFIG[ \t]*=/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\};?[ \t]*$/.test(line)) break;
    const comment = /^[ \t]*\/\//.test(line);
    if (comment) { kept.push(line.replace(/^[ \t]*\/\/[ \t]?/, '')); continue; }
    if (/^[ \t]*$/.test(line)) { kept.push(''); continue; }
    const trailing = /[ \t]\/\/.*$/.exec(line);
    if (trailing) {
      const key = line.replace(/^[ \t]*["']?/, '').replace(/["']?[ \t]*:.*$/, '');
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) kept.push(`- \`${key}\`: ${trailing[0].replace(/^[ \t]*\/\/[ \t]*/, '')}`);
    }
  }
  return kept.join('\n') + '\n';
}
/** The rows two runs are compared on: what happened in the game, never the browser or the clock. */
function normRows(file) {
  const KINDS = /^(scene|state|frame|screen|end|left|noexit|stuck|crash|error|playinput|nonfinite|staged|recovered|norecover|badinput)$/;
  return readFileSync(file, 'utf8').split('\n').filter((line) => {
    const fields = line.split('\t');
    if (KINDS.test(fields[0])) return true;
    if (fields[0] === 'uncaught') return true;
    if (fields[0] === 'done') return true;
    return false;
  }).map((line) => {
    const fields = line.split('\t');
    if (fields[0] === 'uncaught') return `${fields[0]}\t${fields[1]}`;
    if (fields[0] === 'done') return fields.slice(0, 5).join('\t');
    return line;
  });
}function firstDiff(a, b) {
  const left = normRows(a);
  const right = normRows(b);
  for (let i = 0; i < right.length; i += 1) {
    if (left[i] !== right[i]) return `${right[i]}\nwas\t${left[i] ?? '(no row: the reference stopped)'}`;
  }
  if (right.length < left.length) return `(no row: the run stopped early)\nwas\t${left[right.length]}`;
  return '';
}
function said(label, diff) {
  if (diff === '') { out(label, 'yes'); return; }
  const [row, was] = diff.split('\n');
  out(label, 'no', row);
  if (was !== undefined) out(...was.split('\t'));
}



