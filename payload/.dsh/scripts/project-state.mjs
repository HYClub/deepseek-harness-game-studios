#!/usr/bin/env node
// project-state.mjs — one JSON line describing where this project stands.
//
// WHY A SCRIPT. /today and /dashboard both need the same facts (engine, stage,
// sprint, story statuses). Two skills reading the same files with their own
// parsing rules is how "76 stories" and "74 stories" end up in one session. The
// story classification below is copied from story-status.mjs on purpose: the two
// must not be able to disagree.
//
// READS ONLY. Nothing here writes, moves or fixes anything; missing inputs become
// warnings, never invented values.
//
// Output: a single line of JSON on stdout. Exit code 0 whenever the read itself
// worked, even for an empty project — a caller must not treat "no stories yet" as
// a failure.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, rootFromScript } from './_runner.mjs';

/** Why git history could not be read, when it could not: 'unavailable' or 'timeout'. Declared before the
 *  readers that set it, because `let` in a later line would put it in the temporal dead zone. */
let gitFailure = null;

/** Last commit date per file, newest first — the honest source for "when did this change". */
function gitDates(root) {
  const map = new Map();
  let out = '';
  try {
    out = execFileSync('git', ['-C', root, 'log', '--max-count=8000', '--name-only', '--pretty=format:__C__%cI', '--', '.'], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    gitFailure = error && (error.code === 'ETIMEDOUT' || /timed out/i.test(String(error.message))) ? 'timeout' : 'unavailable';
    return map;
  }
  let date = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('__C__')) { date = line.slice(5); continue; }
    if (date && !map.has(line)) map.set(line, localDay(Date.parse(date)));
  }
  return map;
}

/** Local calendar day (YYYY-MM-DD) — toISOString would hand a UTC day, which is the previous day after midnight in +08. */
function localDay(ms) {
  const date = new Date(ms);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
/** Lines in a file, or null when it is unreadable or too big to be worth counting. */
function countLines(root, rel, cap = 2 * 1024 * 1024) {
  try {
    const file = join(root, rel);
    if (statSync(file).size > cap) return null;
    const text = readText(file);
    if (text === null) return null;
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

/**
 * Work that is not committed yet, one row per file, each dated by the file's own mtime —
 * "uncommitted" does not mean "today": an edit left from last week still belongs to last week.
 */
function gitPending(root) {
  const out = { rows: [], added: 0, deleted: 0, files: new Set(), binaryFiles: 0, skippedFiles: 0 };
  const dayOf = (rel) => {
    try { return localDay(statSync(join(root, rel)).mtimeMs); } catch { return localDay(Date.now()); }
  };
  const run = (args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
    let text = '';
    try { text = run(args); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const added = m[1] === '-' ? 0 : Number(m[1]);
      const deleted = m[2] === '-' ? 0 : Number(m[2]);
      out.added += added;
      out.deleted += deleted;
      out.files.add(m[3]);
      out.rows.push({ path: m[3], added, deleted, date: dayOf(m[3]) });
    }
  }
  let untracked = '';
  try { untracked = run(['ls-files', '--others', '--exclude-standard']); } catch { untracked = ''; }
  for (const rel of untracked.split('\n')) {
    const path = rel.trim();
    if (!path) continue;
    if (path === 'production/dashboard.html') continue; // our own output is not the user's work
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|wav|ogg)$/i.test(path)) continue;
    const lines = countLines(root, path);
    if (lines === null) { out.skippedFiles += 1; continue; }
    out.added += lines;
    out.files.add(path);
    out.rows.push({ path, added: lines, deleted: 0, date: dayOf(path) });
  }
  return out;
}
/** Lines added/deleted per day from git history (skipped for binary files). */
function gitChurn(root) {
  const map = new Map();
  let out = '';
  try {
    out = execFileSync('git', ['-C', root, 'log', '--max-count=8000', '--numstat', '--pretty=format:__C__%cI', '--', '.'], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    gitFailure = error && (error.code === 'ETIMEDOUT' || /timed out/i.test(String(error.message))) ? 'timeout' : 'unavailable';
    return map;
  }
  let date = null;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('__C__')) { date = localDay(Date.parse(line.slice(5))); continue; }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || !date) continue;
    if (!map.has(date)) map.set(date, { added: 0, deleted: 0, files: new Set() });
    const row = map.get(date);
    if (m[1] !== '-') row.added += Number(m[1]);
    if (m[2] !== '-') row.deleted += Number(m[2]);
    row.files.add(m[3]);
  }
  return map;
}
/** ISO date for a file: its last commit date, else its mtime. */
function fileDate(root, rel, dates) {
  const fromGit = dates.get(rel);
  if (fromGit) return fromGit.slice(0, 10);
  try { return localDay(statSync(join(root, rel)).mtimeMs); }
  catch { return null; }
}
const EPICS_PREFIX = 'production/epics';


/** Story files one level under production/epics/, in build order. */
function storyFiles(root) {
  const dir = join(root, 'production', 'epics');
  const out = [];
  let epics = [];
  try {
    epics = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const epic of epics) {
    if (!epic.isDirectory()) continue;
    let entries = [];
    try {
      entries = readdirSync(join(dir, epic.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('story-') || !entry.name.endsWith('.md')) continue;
      out.push(`${EPICS_PREFIX}/${epic.name}/${entry.name}`);
    }
  }
  return out.sort();
}

/** The `Status:` value as written, or null. Same normalisations as story-status.mjs. */
function readStatus(root, file) {
  const text = readText(join(root, file));
  if (text === null) return null;
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '');
    line = line.replace(/^[ \t]+/, '');
    if (line.startsWith('> ')) line = line.slice(2);
    if (line.startsWith('- ')) line = line.slice(2);
    line = line.replace(/\*/g, '');
    if (line.startsWith('Status:')) {
      return line.slice(7).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    }
  }
  return null;
}

/** First `key: value` under a top-level block of project.yaml, or null. */
function yamlScalar(text, key) {
  if (text === null) return null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(key + ':')) continue;
    const value = line.slice(key.length + 1).trim();
    if (value && value !== '|' && value !== '>') return value.replace(/^["']|["']$/g, '');
  }
  return null;
}

/** Value of `key:` inside a top-level `block:` of project.yaml, or null. */
function blockField(text, block, key) {
  if (text === null) return null;
  let inEngine = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (new RegExp('^' + block + ':\\s*$').test(line)) { inEngine = true; continue; }
    if (inEngine) {
      if (/^\S/.test(line) && !/^\s/.test(line)) break;
      const m = line.match(new RegExp('^\\s+' + key + ':\\s*(.+)$'));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/** Ask the framework's config resolver; null when it cannot answer. */
function resolved(root, keys) {
  const helper = join(root, 'tools', 'yaml-helper.mjs');
  if (!existsSync(helper)) return null;
  try {
    const out = execFileSync(process.execPath, [helper, 'resolve_config', '--keys', keys], {
      cwd: root, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Stage as recorded in the session checkpoint, else null. */
function readStage(root) {
  const text = readText(join(root, 'production', 'session-state', 'active.md'));
  if (text === null) return null;
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (line.startsWith('> ')) line = line.slice(2);
    if (line.startsWith('- ')) line = line.slice(2);
    const stripped = line.replace(/\*/g, '');
    const m = stripped.match(/^(?:stage|阶段)\s*[:：]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Collect the studio state for `root`.
 * @param {string} root absolute project root
 * @returns {object} the documented JSON shape
 */
export function collectState(root) {
  const warnings = [];

  const projectYaml = join(root, 'project.yaml');
  const projectText = readText(projectYaml);
  if (projectText === null) warnings.push('project.yaml not found — engine unknown');

  const resolvedText = resolved(root, 'engine,language');
  const engineFromResolver = resolvedText === null ? null : resolvedText.split('\n').map((l) => l.trim()).filter(Boolean);

  let engine = { name: null, version: null, language: null, source: 'none' };
  // project.yaml is the explicit configuration: its `engine.name` is authoritative, because a name like
  // "Unreal Engine 5" cannot be split into name + version by guessing where the words end.
  const yamlName = blockField(projectText, 'engine', 'name');
  const yamlVersion = blockField(projectText, 'engine', 'version');
  const yamlLanguage = blockField(projectText, 'engine', 'language');
  if (yamlName) {
    engine = { name: yamlName, version: yamlVersion, language: yamlLanguage, source: 'project.yaml' };
  } else if (engineFromResolver && engineFromResolver.length) {
    for (const line of engineFromResolver) {
      const m = line.match(/^(engine|language)\s*:\s*(.+?)(?:\s*\([^)]*\))?$/);
      if (!m) continue;
      if (m[1] === 'language') engine.language = m[2].trim();
      else engine.name = m[2].trim();
    }
    if (engine.name || engine.language) engine.source = 'yaml-helper';
  }
  // A template placeholder (`unset`, `[CHOOSE: …]`) is not a configuration.
  if (engine.name && (/^\[/.test(engine.name) || /^(unset|none|tbd)$/i.test(engine.name))) {
    engine = { name: null, version: null, language: null, source: 'unconfigured' };
    warnings.push('engine is not configured yet — run /setup-engine');
  }
  // A flat `engine: Godot` is a shape the rest of the framework cannot read either; say so precisely
  // instead of reporting "not configured" as if the line were missing.
  if (!engine.name) {
    const flat = yamlScalar(projectText, 'engine');
    if (flat && !/^\[/.test(flat) && !/^(unset|none|tbd)$/i.test(flat)) {
      warnings.push('project.yaml has a flat `engine: ' + flat + '` — the framework expects engine.name; run /setup-engine');
    }
  }

  const sprintText = readText(join(root, 'production', 'sprint-status.yaml'));
  if (sprintText === null) warnings.push('production/sprint-status.yaml not found — sprint unknown');
  const sprint = {
    number: sprintText === null ? null : blockField(sprintText, 'sprint', 'number') ?? yamlScalar(sprintText, 'number'),
    goal: sprintText === null ? null : blockField(sprintText, 'sprint', 'goal') ?? yamlScalar(sprintText, 'goal'),
    source: sprintText === null ? 'none' : 'production/sprint-status.yaml',
  };
  if (sprint.number !== null && !/^\d+$/.test(String(sprint.number))) sprint.number = null;

  const dates = gitDates(root);
  const churn = gitChurn(root);
  const files = storyFiles(root);
  // A file that is obviously a story but not named `story-*.md` is skipped by every counter in this
  // framework. Silence would read as "no stories"; name it instead.
  const ignoredStories = [];
  try {
    for (const epic of readdirSync(join(root, 'production', 'epics'), { withFileTypes: true })) {
      if (!epic.isDirectory()) continue;
      for (const entry of readdirSync(join(root, 'production', 'epics', epic.name), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (/^story-.*\.md$/.test(entry.name)) continue;
        if (!/story|story-\d|^\d{3}-/i.test(entry.name)) continue;
        ignoredStories.push(epic.name + '/' + entry.name);
      }
    }
  } catch { /* no epics directory */ }
  if (ignoredStories.length) {
    warnings.push(ignoredStories.length + ' file(s) look like stories but are not named story-*.md (silently excluded): ' + ignoredStories.slice(0, 3).join(', '));
  }
  const buckets = { inReview: [], inProgress: [], ready: [], blocked: [], other: [], noStatus: [] };
  const perEpic = new Map();
  const activity = new Map();
  let done = 0;
  const items = [];
  for (const file of files) {
    const status = readStatus(root, file);
    const s = (status ?? '').toLowerCase();
    const epic = file.split('/')[2];
    if (!perEpic.has(epic)) perEpic.set(epic, { epic, total: 0, done: 0, open: 0 });
    const row = perEpic.get(epic);
    row.total += 1;
    const issued = fileDate(root, file, dates);
    if (issued) activity.set(issued, (activity.get(issued) ?? 0) + 1);
    items.push({ file, status, epic, date: issued });
    if (status === null) { buckets.noStatus.push({ file, status: null }); row.open += 1; continue; }
    if (/^(complete|done)([^a-z]|$)/.test(s)) { done += 1; row.done += 1; }
    else if (/^in progress([^a-z]|$)/.test(s)) { buckets.inProgress.push({ file, status }); row.open += 1; }
    else if (/^in review([^a-z]|$)/.test(s)) { buckets.inReview.push({ file, status }); row.open += 1; }
    else if (/^(ready|not started)([^a-z]|$)/.test(s)) { buckets.ready.push({ file, status }); row.open += 1; }
    else if (/^blocked([^a-z]|$)/.test(s)) { buckets.blocked.push({ file, status }); row.open += 1; }
    else { buckets.other.push({ file, status }); row.open += 1; }
  }
  if (files.length === 0) warnings.push('no story files under production/epics/*/story-*.md');

  // Session logs are the only activity trail a project keeps by itself.
  const logDir = join(root, 'production', 'session-logs');
  let sessionLogs = 0;
  try {
    for (const entry of readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      sessionLogs += 1;
      const issued = fileDate(root, join('production', 'session-logs', entry.name), dates);
      if (issued) activity.set(issued, (activity.get(issued) ?? 0) + 1);
    }
  } catch { /* no session logs: not an error */ }

  const countMd = (dir) => {
    let out = 0;
    const walk = (abs) => {
      let entries = [];
      try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(abs, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.md')) out += 1;
      }
    };
    walk(join(root, dir));
    return out;
  };

// Churn: real line counts when git knows the history, otherwise bytes touched that day, labelled as such.
const churnSource = churn.size > 0 ? 'git' : (gitFailure ?? 'mtime-bytes');
  if (gitFailure) {
    warnings.push('git history could not be read (' + gitFailure + ') — line counts fall back to file sizes');
  }
  const byDate = new Map();
  for (const [date, count] of activity.entries()) byDate.set(date, { date, stories: count, added: 0, deleted: 0, files: 0 });
  if (churn.size > 0) {
    for (const [date, row] of churn.entries()) {
      const entry = byDate.get(date) ?? { date, stories: 0, added: 0, deleted: 0, files: 0 };
      entry.added += row.added;
      entry.deleted += row.deleted;
      entry.files += row.files.size;
      byDate.set(date, entry);
    }
  } else {
    for (const item of items) {
      if (!item.date) continue;
      const entry = byDate.get(item.date) ?? { date: item.date, stories: 0, added: 0, deleted: 0, files: 0 };
      const lines = countLines(root, item.file);
      if (lines !== null) { entry.added += lines; entry.files += 1; }
      byDate.set(item.date, entry);
    }
  }
  // Uncommitted work belongs to today, and must be labelled as uncommitted.
  const pending = dates.size > 0
    ? gitPending(root)
    : { rows: [], added: 0, deleted: 0, files: new Set(), binaryFiles: 0, skippedFiles: 0 };
  const hasPending = pending.rows.length > 0;
  for (const row of pending.rows) {
    const entry = byDate.get(row.date) ?? { date: row.date, stories: 0, added: 0, deleted: 0, files: 0, pending: false };
    entry.added += row.added;
    entry.deleted += row.deleted;
    entry.files += 1;
    entry.pending = true;
    byDate.set(row.date, entry);
  }
  const activityDays = [...byDate.values()]
    .map((row) => ({ ...row, added: Math.round(row.added), deleted: Math.round(row.deleted) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const statusCounts = {
    done,
    inReview: buckets.inReview.length,
    inProgress: buckets.inProgress.length,
    ready: buckets.ready.length,
    blocked: buckets.blocked.length,
    other: buckets.other.length,
    noStatus: buckets.noStatus.length,
  };

  const nextOrder = [...buckets.inReview, ...buckets.inProgress, ...buckets.ready,
    ...buckets.noStatus, ...buckets.other, ...buckets.blocked];

  return {
    generatedAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    engine,
    framework: {
      version: blockField(projectText, 'framework', 'version'),
    },
    stage: readStage(root),
    sprint,
    stories: {
      total: files.length,
      done,
      inReview: buckets.inReview.length,
      inProgress: buckets.inProgress.length,
      ready: buckets.ready.length,
      blocked: buckets.blocked.length,
      other: buckets.other.length,
      noStatus: buckets.noStatus.length,
      next: nextOrder[0] ?? null,
      blockedList: buckets.blocked,
      statusCounts,
      epics: [...perEpic.values()].sort((a, b) => a.epic.localeCompare(b.epic)),
      activity: activityDays,
      items,
      dateSource: dates.size > 0 ? 'git' : 'mtime',
      churnSource,
      pending: {
        added: pending.added,
        deleted: pending.deleted,
        files: pending.files.size,
        binaryFiles: pending.binaryFiles,
        skippedFiles: pending.skippedFiles,
      },
      hasPending,
      generatedOn: localDay(Date.now()),
      dateSpread: activityDays.length,
      docs: {
        gdd: countMd(join('design', 'gdd')),
        narrative: countMd(join('design', 'narrative')),
        levels: countMd(join('design', 'levels')),
        balance: countMd(join('design', 'balance')),
        adr: countMd(join('docs', 'architecture')),
        sessionLogs,
      },
    },
    warnings,
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const i = process.argv.indexOf('--root');
  let root;
  if (i >= 0) {
    const value = process.argv[i + 1];
    if (!value || value.startsWith('--')) { console.error('--root needs a directory'); process.exit(2); }
    root = resolve(value);
    if (!existsSync(root)) { console.error('--root does not exist: ' + root); process.exit(2); }
    if (!statSync(root).isDirectory()) { console.error('--root is not a directory: ' + root); process.exit(2); }
  } else {
    root = rootFromScript();
  }
  process.stdout.write(JSON.stringify(collectState(root)) + '\n');
}




























