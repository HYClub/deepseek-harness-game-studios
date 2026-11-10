#!/usr/bin/env node
// cut-apply.mjs — write the cuts /cut proposed into the brief, and the polish list.
//
// Node port of upstream `.dsh/scripts/cut-apply.sh` (305 lines). The script never decides anything:
// every edit is an argument, and the person agreed to each one before it is passed here.
//
// Usage: cut-apply.mjs --brief PATH [--brief PATH] [ops...]
//   --cut N REASON            Features item N moves to the end of Out of scope, marked [-] with the
//                             reason and today's date; a story traced to it becomes Blocked
//   --mark N                  Features item N becomes [x]
//   --back ITEM built|not_yet the [-] row for ITEM returns to Features, [x] when built
//   --dates TARGET FREEZE WHAT  writes "**Dates:** target TARGET (WHAT) · freeze FREEZE"
//   --polish ROW | --tick ROW | --drop ROW   rows of design/polish-list.md
//   --today YYYY-MM-DD, --root DIR
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const okDate = (value) => DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function usage(message) {
  process.stderr.write(`cut-apply: ${message} (try --help)\n`);
  process.exit(2);
}
const oneLine = (value, what) => {
  if (value === undefined || value === '' || value.includes('\t') || value.includes('\n')) usage(`${what} takes one line of text, no tabs`);
  return value;
};
const number = (value, what) => {
  if (value === undefined || !/^\d+$/.test(value)) usage(`${what} takes an item's number: ${value}`);
  return Number(value);
};

const args = process.argv.slice(2);
const briefs = [];
const ops = [];
let today = '';
let rootArg = '';
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--brief') { if (briefs.length >= 2) usage('two briefs at most'); briefs.push(args[i + 1]); i += 1; }
  else if (arg === '--cut') { ops.push({ kind: 'cut', n: number(args[i + 1], '--cut'), reason: oneLine(args[i + 2], "--cut's reason") }); i += 2; }
  else if (arg === '--mark') { ops.push({ kind: 'mark', n: number(args[i + 1], '--mark') }); i += 1; }
  else if (arg === '--back') {
    const state = args[i + 2];
    if (state !== 'built' && state !== 'not_yet') usage(`--back takes built or not_yet: ${state}`);
    ops.push({ kind: 'back', item: oneLine(args[i + 1], '--back'), state });
    i += 2;
  } else if (arg === '--dates') {
    const target = args[i + 1];
    const freeze = args[i + 2];
    if (!okDate(target) || !okDate(freeze)) usage('--dates takes two ISO dates');
    ops.push({ kind: 'dates', target, freeze, what: oneLine(args[i + 3], "--dates' what") });
    i += 3;
  } else if (arg === '--polish' || arg === '--tick' || arg === '--drop') {
    ops.push({ kind: arg.slice(2), row: oneLine(args[i + 1], arg) });
    i += 1;
  } else if (arg === '--today') { today = args[i + 1]; i += 1; }
  else if (arg === '--root') { rootArg = args[i + 1]; i += 1; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write('cut-apply --brief PATH [--brief PATH] [--cut N REASON | --mark N | --back ITEM built|not_yet | --dates TARGET FREEZE WHAT | --polish ROW | --tick ROW | --drop ROW]\n');
    process.exit(0);
  } else usage(`unknown argument: ${arg}`);
}
if (today === '') today = new Date().toISOString().slice(0, 10);
if (!okDate(today)) usage(`--today is a date, YYYY-MM-DD: ${today}`);
if (briefs.length === 0) usage('--brief is needed: the brief to write, which also names the game');
const root = resolve(rootArg || join(import.meta.dirname, '..', '..'));
if (briefs.length === 2 && readFileSync(resolve(root, briefs[0]), 'utf8') !== readFileSync(resolve(root, briefs[1]), 'utf8')) {
  usage(`${briefs[0]} and ${briefs[1]} are not the same text: give the one to write`);
}

const FEATURE_HEADING = /^## +(Features|MVP)([^A-Za-z]|$)/;
const OUT_HEADING = /^## +Out of scope([^A-Za-z]|$)/;
const BLOCK = /^(?<prefix>[-*] )(?:\[(?<mark>[xX ])\] )?(?<text>.*)$/;

/** Apply the Features/Out-of-scope edits to one brief's lines. */
function applyToBrief(lines) {
  const status = { error: '' };
  const featureAt = lines.findIndex((line) => FEATURE_HEADING.test(line));
  const outAt = lines.findIndex((line) => OUT_HEADING.test(line));
  if (featureAt < 0) { status.error = 'no Features section (## Features or ## MVP)'; return lines; }

  // The items, numbered the way cut-read numbers them.
  const items = [];
  for (let i = featureAt + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i]) || /^---[ \t]*$/.test(lines[i])) break;
    const m = BLOCK.exec(lines[i]);
    if (!m) continue;
    items.push({ index: i, mark: m.groups.mark === 'x' || m.groups.mark === 'X' ? 'built' : 'not_yet', text: m.groups.text });
  }

  const cutOps = ops.filter((op) => op.kind === 'cut');
  const markOps = ops.filter((op) => op.kind === 'mark');
  const backOps = ops.filter((op) => op.kind === 'back');
  for (const op of cutOps) if (op.n < 1 || op.n > items.length) { status.error = `item ${op.n} is not a Features item`; return lines; }

  const removed = new Set();
  const backRows = [];
  for (const op of cutOps) {
    const item = items[op.n - 1];
    if (removed.has(item.index)) { status.error = `item ${op.n} is cut twice`; return lines; }
    removed.add(item.index);
    backRows.push(`- [-] ${item.text} · cut: ${op.reason} (${today})${item.mark === 'built' ? ' · was built' : ''}`);
  }
  for (const op of markOps) {
    if (op.n < 1 || op.n > items.length) { status.error = `item ${op.n} is not a Features item`; return lines; }
  }

  const outLines = [];
  if (outAt >= 0) {
    let at = outAt + 1;
    while (at < lines.length && !/^## /.test(lines[at]) && !/^---[ \t]*$/.test(lines[at])) at += 1;
    // The new rows go at the end of the block's rows, before the blank line that follows them.
    while (at - 1 > outAt && lines[at - 1].trim() === '') at -= 1;
    outLines.push({ at, rows: backRows });
  } else {
    outLines.push({ at: lines.length, rows: backRows, needsHeading: true });
  }

  const output = [];
  let outInserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    const insertion = outLines.find((entry) => entry.at === i && !outInserted);
    if (insertion && !outInserted) {
      if (insertion.needsHeading) output.push('', '## Out of scope — not building this');
      output.push(...insertion.rows);
      outInserted = true;
    }
    if (removed.has(i)) continue;
    const mark = markOps.find((op) => items[op.n - 1].index === i);
    if (mark) { output.push(lines[i].replace(/^([-*] )\[[xX ]\] /, '$1[x] ')); continue; }
    output.push(lines[i]);
  }
  if (!outInserted && backRows.length > 0) {
    output.push('', '## Out of scope — not building this', ...backRows);
  }

  for (const op of backOps) {
    const row = new RegExp(`^- \\[-\\] ${op.item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( · .*)?$`);
    for (let i = output.length - 1; i >= 0; i -= 1) {
      if (!row.test(output[i])) continue;
      output.splice(i, 1);
      // The row returns to Features, at its end.
      const featureNow = output.findIndex((line) => FEATURE_HEADING.test(line));
      let at = featureNow + 1;
      while (at < output.length && !/^## /.test(output[at]) && !/^---[ \t]*$/.test(output[at])) at += 1;
      // Directly after the last row, not after the blank line that ends the block.
      while (at - 1 > featureNow && output[at - 1].trim() === '') at -= 1;
      const restored = `- [${op.state === 'built' ? 'x' : ' '}] ${op.item}`;
      const already = output.slice(featureNow + 1, at).some((line) => line.trim() === restored || line.trim() === `- [ ] ${op.item}` || line.trim() === `- [x] ${op.item}`);
      if (!already) output.splice(at, 0, restored);
      break;
    }
  }

  const datesOp = ops.find((op) => op.kind === 'dates');
  if (datesOp) {
    const line = `**Dates:** target ${datesOp.target} (${datesOp.what}) · freeze ${datesOp.freeze}`;
    const at = output.findIndex((entry) => entry.startsWith('**Dates:**'));
    if (at >= 0) output[at] = line;
    else output.push('', line);
  }
  return output;
}

for (const brief of briefs) {
  const path = resolve(root, brief);
  if (!existsSync(path)) usage(`no such brief: ${brief}`);
  const before = readFileSync(path, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const after = applyToBrief(lines);
  writeFileSync(path, after.join(eol) + eol, 'utf8');
}

// ---- The polish list ------------------------------------------------------------------------------
const polishOps = ops.filter((op) => op.kind === 'polish' || op.kind === 'tick' || op.kind === 'drop');
if (polishOps.length > 0) {
  const path = join(root, 'design', 'polish-list.md');
  const briefName = (readFileSync(resolve(root, briefs[0]), 'utf8').split(/\r?\n/).find((line) => /^# Game Brief:/.test(line)) ?? '')
    .replace(/^# Game Brief: */, '').replace(/\r$/, '');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [`# Polish list: ${briefName}`, ''];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const op of polishOps) {
    if (op.kind === 'polish') { lines.push(`- [ ] ${op.row}`); continue; }
    const row = op.row;
    const at = lines.findIndex((line) => line === `- [ ] ${row}` || line === `- [x] ${row}`);
    if (at < 0) usage(`no such polish row: ${row}`);
    if (op.kind === 'tick') lines[at] = `- [x] ${row}`;
    else lines.splice(at, 1);
  }
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

// ---- Stories traced to a cut feature become Blocked ------------------------------------------------
const cutOps = ops.filter((op) => op.kind === 'cut');
if (cutOps.length > 0) {
  const epics = join(root, 'production', 'epics');
  if (existsSync(epics)) {
    for (const epic of readdirSync(epics, { withFileTypes: true })) {
      if (!epic.isDirectory()) continue;
      const dir = join(epics, epic.name);
      for (const file of readdirSync(dir)) {
        if (!/^story-.*\.md$/.test(file)) continue;
        const path = join(dir, file);
        const text = readFileSync(path, 'utf8');
        const requirement = /Brief MVP feature (\d+)/.exec(text);
        if (!requirement) continue;
        const op = cutOps.find((candidate) => candidate.n === Number(requirement[1]));
        if (!op) continue;
        const updated = text.replace(/^(> \*\*Status\*\*: ).*$/m, `$1Blocked — BLOCKED: cut by /cut ${today}: ${op.reason}`);
        if (updated !== text) writeFileSync(path, updated, 'utf8');
      }
    }
  }
}
process.exit(0);



