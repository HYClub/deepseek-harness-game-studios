#!/usr/bin/env node
// page-shot.mjs — open a web page in a headless browser, run it for a while, take a picture of where
// it stopped, and report what the page said.
//
// Node port of the browser half of upstream `.dsh/scripts/page-shot.sh` (269 lines): find a browser,
// give it a profile of its own, open the page with the query a one-shot expects, collect the page's
// console lines, and write the screenshot. It speaks the DevTools protocol over the WebSocket built
// into Node, so nothing has to be installed.
//
// Usage: page-shot.mjs <page> <out.png> [--query TEXT] [--wait MS] [--size WxH] [--full]
//                       [--which] [--timeout SECONDS] [--root DIR]
// Rows: browser · time · render · console · shot · not_assessed
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (...fields) => process.stdout.write(`${fields.join('\t')}\n`);

const args = process.argv.slice(2);
const positional = [];
let query = '';
let wait = 500;
let size = '1280x720';
let full = false;
let which = false;
let scroll = 0;
let timeout = 60;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--query') { query = args[i + 1] ?? ''; i += 1; }
  else if (arg === '--wait') { wait = Number.parseInt(args[i + 1] ?? '500', 10); i += 1; }
  else if (arg === '--size') { size = args[i + 1] ?? '1280x720'; i += 1; }
  else if (arg === '--full') full = true;
  else if (arg === '--which') which = true;
  else if (arg === '--scroll') { scroll = Number.parseInt(args[i + 1] ?? '0', 10); i += 1; }
  else if (arg === '--timeout') { timeout = Number.parseInt(args[i + 1] ?? '60', 10); i += 1; }
  else if (arg === '--root') { i += 1; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('page-shot <page> <out.png> [--query TEXT] [--wait MS] [--size WxH] [--full] [--which]\n');
    process.exit(0);
  } else positional.push(arg);
}

const WIN = process.platform === 'win32';
const LA = process.env.LOCALAPPDATA ?? '';

function findBrowser() {
  if (process.env.PAGE_SHOT_BROWSER) return process.env.PAGE_SHOT_BROWSER;
  const candidates = WIN ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    LA ? join(LA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge', '/usr/bin/msedge',
  ];
  for (const candidate of candidates) if (candidate !== '' && existsSync(candidate)) return candidate;
  // Playwright's own headless shell, newest last.
  const bases = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : [join(homedir(), '.cache', 'ms-playwright'), join(homedir(), 'Library', 'Caches', 'ms-playwright'), LA ? join(LA, 'ms-playwright') : ''];
  for (const base of bases) {
    if (base === '' || !existsSync(base)) continue;
    const found = newestShell(base);
    if (found !== '') return found;
  }
  return '';
}

function newestShell(base) {
  let best = '';
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = readFileSyncDir(dir); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (/^chrome-headless-shell(\.exe)?$/.test(entry.name)) best = path;
    }
  };
  walk(base, 0);
  return best;
}
function readFileSyncDir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

const browser = findBrowser();
if (browser === '') {
  const message = 'no browser found: Chrome, Edge, Chromium or chrome-headless-shell (set PAGE_SHOT_BROWSER to one)';
  if (which) { process.stderr.write(`page-shot: ${message}\n`); process.exit(3); }
  out('not_assessed', message);
  process.exit(3);
}
if (which) { process.stdout.write(`${browser}\n`); process.exit(0); }

if (positional.length < 2) { process.stderr.write('page-shot: a page and an output picture are needed (try --help)\n'); process.exit(2); }
const page = resolve(positional[0]);
const shot = resolve(positional[1]);
if (!existsSync(page)) { process.stderr.write(`page-shot: no such page: ${page}\n`); process.exit(1); }

const [width, height] = size.split('x').map((part) => Number.parseInt(part, 10));
const url = `file:///${page.replace(/\\/g, '/').replace(/^\//, '')}${query === '' ? '' : `?${full ? query : `${query}&render=cheap`}`}`;

const work = mkdtempSync(join(tmpdir(), 'dsgs-page-shot-'));
const profile = join(work, 'profile');
mkdirSync(profile, { recursive: true });

const browserArgs = [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  '--enable-unsafe-swiftshader',
  '--remote-allow-origins=*',
  '--use-gl=angle',
  '--use-angle=swiftshader-webgl',
  '--mute-audio',
  'about:blank',
];

const child = spawn(browser, browserArgs, { stdio: 'ignore', windowsHide: true });
const cleanUp = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } try { rmSync(work, { recursive: true, force: true }); } catch { /* locked */ } };
process.on('exit', cleanUp);

/** The port Chrome picked, from the file it writes once the debugger is up. */
async function debuggerPort() {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (/^\d+$/.test(port.trim())) return { port: Number(port.trim()), path: (path ?? '').trim() };
    }
    await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  return null;
}

const debuggerInfo = await debuggerPort();
if (debuggerInfo === null) {
  out('not_assessed', 'the browser started but never opened its debugger port');
  cleanUp();
  process.exit(3);
}

out('browser', browser);
out('time', new Date().toISOString().replace('T', ' ').slice(0, 19));
out('render', full ? 'full' : 'cheap');

const consoleRows = [];
const ws = new WebSocket(`ws://127.0.0.1:${debuggerInfo.port}${debuggerInfo.path === '' ? '' : debuggerInfo.path}`);
let targetId = '';
let sessionId = '';
let messageId = 0;
const pending = new Map();

function send(method, params = {}, session = '') {
  messageId += 1;
  const payload = { id: messageId, method, params };
  if (session !== '') payload.sessionId = session;
  ws.send(JSON.stringify(payload));
  return messageId;
}
function waitFor(id) {
  return new Promise((resolve_) => {
    pending.set(id, resolve_);
  });
}

await new Promise((resolve_, reject) => {
  ws.addEventListener('open', resolve_, { once: true });
  ws.addEventListener('error', () => reject(new Error('the debugger socket refused the connection')), { once: true });
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
    if (text !== '') consoleRows.push(text);
    return;
  }
  if (message.method === 'Log.entryAdded') {
    const text = message.params.entry?.text ?? '';
    if (text !== '') consoleRows.push(text);
  }
});

const create = await waitFor(send('Target.createTarget', { url: 'about:blank' }));
targetId = create.result?.targetId ?? '';
const attach = await waitFor(send('Target.attachToTarget', { targetId, flatten: true }));
sessionId = attach.result?.sessionId ?? '';
send('Runtime.enable', {}, sessionId);
send('Log.enable', {}, sessionId);
send('Page.enable', {}, sessionId);
send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
await waitFor(send('Page.navigate', { url }, sessionId));

// The page gets its run, then the picture; a page that never settles is cut at the timeout.
const deadline = Date.now() + Math.min(timeout * 1000, Math.max(wait + 1000, 5000));
await new Promise((resolve_) => {
  const timer = setInterval(() => {
    if (Date.now() >= deadline) { clearInterval(timer); resolve_(); }
  }, 100);
});
if (scroll > 0) { send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scroll})` }, sessionId); await new Promise((resolve_) => setTimeout(resolve_, 250)); }
const drawn = await waitFor(send('Page.captureScreenshot', { format: 'png' }, sessionId));
const base64 = drawn.result?.data ?? '';
if (base64 === '') {
  out('not_assessed', 'the browser returned no picture');
  cleanUp();
  process.exit(3);
}
mkdirSync(dirname(shot), { recursive: true });
writeFileSync(shot, Buffer.from(base64, 'base64'));
out('shot', shot);
for (const line of consoleRows) out('console', 'page', line);
cleanUp();
process.exit(0);




