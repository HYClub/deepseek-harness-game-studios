#!/usr/bin/env node
// one-shot-run.mjs — play a one-shot in a headless browser from a fresh start, by an input log or its
// bot, and take a screenshot where the run stops.
//
// Node port of upstream `.dsh/scripts/one-shot-run.sh` (216 lines). The game is copied to a temp
// folder and the driver is put in front of its first script there, so nothing check-related is ever
// written into the game itself. The driver fixes time and chance, so the same inputs give the same
// game.
//
// Usage: one-shot-run.mjs <folder> <out.png> [--log TEXT | --bot end|lose] [--stop STEP]
//        [--quiet STEP [--press KEY]] [--trace STEP] [--cap SECONDS] [--seed N] [--limit SECONDS]
//        [--audio SECONDS] [--profile DIR] [--hookless] [--size WxH] [--root DIR]
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (...fields) => process.stdout.write(`${fields.join('\t')}\n`);
const fail = (message, code = 2) => { process.stderr.write(`one-shot-run: ${message}\n`); process.exit(code); };

const args = process.argv.slice(2);
const positional = [];
const opts = { log: '', haveLog: false, bot: '', stop: '', quiet: '', press: '', trace: '', cap: '', seed: '', limit: 150, audio: '', profile: '', prev: '', cold: false, hookless: false, size: '', root: '' };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const need = () => { if (i + 1 >= args.length) fail(`${arg} needs a value`); return args[i + 1]; };
  if (arg === '--log') { opts.log = need(); opts.haveLog = true; i += 1; }
  else if (arg === '--bot') { opts.bot = need(); i += 1; }
  else if (arg === '--stop') { opts.stop = need(); i += 1; }
  else if (arg === '--quiet') { opts.quiet = need(); i += 1; }
  else if (arg === '--press') { opts.press = need(); i += 1; }
  else if (arg === '--trace') { opts.trace = need(); i += 1; }
  else if (arg === '--cap') { opts.cap = need(); i += 1; }
  else if (arg === '--seed') { opts.seed = need(); i += 1; }
  else if (arg === '--limit') { opts.limit = Number.parseInt(need(), 10); i += 1; }
  else if (arg === '--audio') { opts.audio = need(); i += 1; }
  else if (arg === '--profile') { opts.profile = need(); i += 1; }
  else if (arg === '--prev') { opts.prev = need(); i += 1; }
  else if (arg === '--size') { opts.size = need(); i += 1; }
  else if (arg === '--root') { opts.root = need(); i += 1; }
  else if (arg === '--cold') opts.cold = true;
  else if (arg === '--hookless') opts.hookless = true;
  else if (arg === '-h' || arg === '--help') { process.stdout.write('one-shot-run <folder> <out.png> [--log TEXT | --bot end|lose] [--stop N] [--quiet N [--press KEY]] [--trace N] [--cap S] [--seed N] [--limit S] [--audio S] [--profile DIR] [--hookless] [--size WxH] [--root DIR]\n'); process.exit(0); }
  else if (arg.startsWith('-')) fail(`unknown argument: ${arg} (try --help)`);
  else positional.push(arg);
}
if (positional.length < 2) fail('a folder and an output are needed (try --help)');
if (opts.bot !== '' && opts.haveLog) fail('--log or --bot, not both');
if (opts.bot === '' && !opts.haveLog) fail('--log or --bot is needed');
if (opts.bot !== '' && !['end', 'lose'].includes(opts.bot)) fail('--bot is end or lose');
for (const [name, value] of [['--stop', opts.stop], ['--quiet', opts.quiet], ['--seed', opts.seed], ['--trace', opts.trace]])
  if (value !== '' && !/^\d+$/.test(value)) fail(`${name} takes a number`);
if (opts.press !== '' && opts.quiet === '') fail('--press goes with --quiet: the step it is pressed at');
if (opts.press !== '' && !/^([A-Za-z0-9]+|click:\d+,\d+|click:text=\S+)$/.test(opts.press)) fail('--press is a key, click:x,y or click:text=words');
if (!(opts.limit > 0)) fail('--limit is at least 1');
if (opts.cap !== '' && !/^\d+(\.\d+)?$/.test(opts.cap)) fail('--cap is a number of seconds');

const root = resolve(opts.root || join(HERE, '..', '..'));
const folder = /^([A-Za-z]:|\/)/.test(positional[0]) ? resolve(positional[0]) : resolve(root, positional[0]);
const shot = /^([A-Za-z]:|\/)/.test(positional[1]) ? resolve(positional[1]) : resolve(root, positional[1]);
if (!existsSync(join(folder, 'index.html'))) fail(`no index.html in ${folder}`, 1);
const driver = join(HERE, 'one-shot-driver.js');
if (!existsSync(driver)) fail('one-shot-driver.js is missing beside this script', 1);

// The game goes to a temp folder; the driver goes in front of its first script, the bot after it.
const work = mkdtempSync(join(tmpdir(), 'dsgs-one-shot-run-'));
const game = join(work, 'game');
cpSync(folder, game, { recursive: true });
const driverScript = '<script src="one-shot-driver.js"></script>';
const botScript = '<script src="bot.js"></script>';
const html = readFileSync(join(game, 'index.html'), 'utf8');
let injected = false;
const lines = html.split('\n').map((line) => {
  if (!injected && /<script/.test(line)) {
    injected = true;
    return `${driverScript}\n${line}`;
  }
  return line;
});
if (!injected) lines.push(driverScript);
if (opts.bot !== '') {
  const at = lines.findIndex((line) => /<\/body>/.test(line));
  const script = `${botScript}`;
  if (at >= 0) lines.splice(at, 0, script); else lines.push(script);
}
writeFileSync(join(game, 'index.html'), lines.join('\n'), 'utf8');
cpSync(driver, join(game, 'one-shot-driver.js'));

const encode = (value) => encodeURIComponent(value);
let query = 'manual=1';
if (opts.seed !== '') query += `&seed=${opts.seed}`;
if (opts.bot !== '') query += `&bot=${opts.bot}`; else query += `&log=${encode(opts.log)}`;
if (opts.stop !== '') query += `&stop=${opts.stop}`;
if (opts.quiet !== '') query += `&quiet=${opts.quiet}`;
if (opts.press !== '') query += `&press=${encode(opts.press)}`;
if (opts.trace !== '') query += `&trace=${opts.trace}`;
query += `&limit=${opts.limit * 1000}`;
if (opts.cap !== '') query += `&cap=${opts.cap}`;
if (opts.hookless) query += '&hookless=1';
if (opts.audio !== '' && opts.audio !== '0') query += `&audio=${opts.audio}`;
const wait = opts.audio !== '' && opts.audio !== '0' ? 60000 : 500;

let raw = '';
let code = 0;
try {
  raw = execFileSync(process.execPath, [
    join(HERE, 'page-shot.mjs'), join(game, 'index.html'), shot,
    '--query', query, '--wait', String(wait), '--timeout', String(opts.limit + 30),
    ...(opts.size === '' ? [] : ['--size', opts.size]),
    ...(opts.profile === '' ? [] : ['--profile', opts.profile]),
  ], { encoding: 'utf8', timeout: (opts.limit + 40) * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  raw = String(error.stdout ?? '');
  if (error.stderr) process.stderr.write(String(error.stderr));
  code = error.status ?? 1;
}
rmSync(work, { recursive: true, force: true });

// The driver's rows: `RUN|<kind>|<rest>` becomes the row itself; two console lines the check causes
// are dropped; only the last frame measurement is the frame in the screenshot.
const linesOut = raw.split('\n').filter((line) => line.trim() !== '');
const kept = [];
let lastMeasured = -1;
for (const line of linesOut) {
  const fields = line.split('\t');
  if (fields[0] === 'console' && fields[2] !== undefined
    && /^(Canvas2D: Multiple readback operations|The AudioContext was not allowed to start)/.test(fields[2])) continue;
  let normalised = line;
  if (fields[0] === 'console' && /^RUN\|/.test(fields[2] ?? '')) normalised = fields[2].slice(4).split('|').join('\t');
  kept.push(normalised);
  if (normalised.startsWith('measured\t')) lastMeasured = kept.length - 1;
}
for (let i = 0; i < kept.length; i += 1) {
  const kind = kept[i].split('\t')[0];
  if (i < lastMeasured && ['measured', 'text', 'textunmapped', 'screen'].includes(kind)) continue;
  process.stdout.write(`${kept[i]}\n`);
}
process.exit(code);
