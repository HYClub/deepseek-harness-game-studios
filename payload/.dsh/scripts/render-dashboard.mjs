#!/usr/bin/env node
// render-dashboard.mjs — write production/dashboard.html from project-state.mjs.
//
// WHY THE CHARTS ARE BUILT HERE, NOT IN THE BROWSER.
// The page used to draw its charts in an inline script. Every defect that survived review lived in that
// script: an arc whose start equalled its end (a single status drew nothing), a one-point line (a single
// day drew nothing), and labels that lost their colour to a CSS rule. None of it was testable — a checker
// can read markup, it cannot run a canvas. So the layout moved here: every chart for every range is
// computed once, emitted as static SVG, and the page script only decides which one is visible.
//
// The page stays self-contained: no external URL, no <script src>, no font, no network.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromScript } from './_runner.mjs';
import { collectState } from './project-state.mjs';

const COLORS = {
  done: '#3fb950', inProgress: '#58a6ff', inReview: '#a371f7',
  ready: '#d29922', blocked: '#f85149', other: '#8b949e', noStatus: '#6e7681',
};
const LABELS = {
  done: '已完成', inProgress: '进行中', inReview: '评审中',
  ready: '待开始', blocked: '受阻', other: '其他', noStatus: '无状态',
};
const RANGES = [7, 30, 90, 0];
const rangeLabel = (days) => (days === 0 ? '全部时间' : '最近 ' + days + ' 天');
const localDate = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const spanFor = (days, now) => (days === 0 ? '全部' : localDate(now - days * 864e5) + ' → ' + localDate(now));

const churnLabel = (source) => ({
  git: 'git 提交历史',
  'mtime-bytes': '文件行数（无 git）',
  unavailable: 'git 历史不可读（改用文件行数）',
  timeout: 'git 历史读取超时（改用文件行数）',
}[source] ?? source);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

const categoryOf = (status) => {
  if (status === null || status === undefined) return 'noStatus';
  const s = String(status).toLowerCase();
  if (/^(complete|done)([^a-z]|$)/.test(s)) return 'done';
  if (/^in progress([^a-z]|$)/.test(s)) return 'inProgress';
  if (/^in review([^a-z]|$)/.test(s)) return 'inReview';
  if (/^(ready|not started)([^a-z]|$)/.test(s)) return 'ready';
  if (/^blocked([^a-z]|$)/.test(s)) return 'blocked';
  return 'other';
};

/** Ticks at 1/2/5 x 10^k so the axis stays readable at any scale. */
function niceStep(max, target = 4) {
  const raw = Math.max(1, max) / target;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const factor = raw / power;
  const mult = factor <= 1 ? 1 : factor <= 2 ? 2 : factor <= 5 ? 5 : 10;
  return Math.max(1, mult * power);
}

const itemsInRange = (items, days, now) => (days === 0 ? items
  : items.filter((item) => !item.date || Date.parse(item.date) >= now - days * 864e5));

const activityInRange = (activity, days, now) => (days === 0 ? activity
  : activity.filter((row) => !row.date || Date.parse(row.date) >= now - days * 864e5));

const W = 720, H = 260, LEFT = 54, RIGHT = W - 30, TOP = 18, BOTTOM = 205;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const emptySvg = (message) => `<text x="${W / 2}" y="125" text-anchor="middle">${esc(message)}</text>`;
const legendItem = (colour, text) => '<span><i style="background:' + colour + '"></i>' + esc(text) + '</span>';

function axisTicks(max) {
  const step = niceStep(max);
  const topValue = Math.ceil(Math.max(1, max) / step) * step;
  const out = [];
  for (let value = 0; value <= topValue; value += step) {
    const y = BOTTOM - (value / topValue) * (BOTTOM - TOP);
    out.push(`<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${RIGHT}" y2="${y.toFixed(1)}" stroke="#21262d"/>`
      + `<text x="${LEFT - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${value}</text>`);
  }
  return { markup: out.join(''), topValue };
}

/** One pie — or one full circle when a single status owns everything. */
function pieView(rows) {
  const total = rows.reduce((acc, row) => acc + row.n, 0);
  if (!total) return { svg: emptySvg('这个范围内没有 story'), legend: '' };
  const cx = W / 2, cy = 128, r = 88, ringR = r / 2;
  if (rows.length === 1) {
    const [row] = rows;
    const colour = COLORS[row.key] || '#888';
    return {
      svg: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" opacity="0.92" class="dot">`
        + `<title>${esc((LABELS[row.key] || row.key) + ' ' + row.n + ' 条（100%）')}</title></circle>`
        + `<text x="${cx}" y="${cy + 4}" text-anchor="middle" dominant-baseline="middle" class="lbl">100%</text>`,
      legend: legendItem(colour, (LABELS[row.key] || row.key) + ' ' + row.n),
    };
  }
  let angle = -Math.PI / 2;
  const parts = [];
  rows.forEach((row, index) => {
    const sweep = (row.n / total) * Math.PI * 2;
    const x1 = cx + ringR * Math.cos(angle), y1 = cy + ringR * Math.sin(angle);
    const x2 = cx + ringR * Math.cos(angle + sweep), y2 = cy + ringR * Math.sin(angle + sweep);
    const large = sweep > Math.PI ? 1 : 0;
    const len = ringR * sweep;
    const share = Math.round((row.n / total) * 100);
    const colour = COLORS[row.key] || '#888';
    parts.push(`<path class="wedge" d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${ringR} ${ringR} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}"`
      + ` stroke="${colour}" stroke-width="${r}" fill="none" stroke-linecap="butt"`
      + ` style="--len:${len.toFixed(1)}">`
      + `<title>${esc((LABELS[row.key] || row.key) + ' ' + row.n + ' 条（' + share + '%）')}</title></path>`);
    if (row.n / total >= 0.03) {
      const mid = angle + sweep / 2;
      const tx = cx + (r + 20) * Math.cos(mid), ty = cy + (r + 20) * Math.sin(mid);
      parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" dominant-baseline="middle"`
        + ` class="lbl" font-size="${row.n / total < 0.05 ? 10 : 11}">${share}%</text>`);
    }
    angle += sweep;
  });
  return {
    svg: parts.join(''),
    legend: rows.map((row) => legendItem(COLORS[row.key] || '#888', (LABELS[row.key] || row.key) + ' ' + row.n)).join(''),
  };
}

/** Stories per epic: total (grey) beside done (green). */
function barView(rows) {
  if (!rows.length) return { svg: emptySvg('这个范围内没有 story'), legend: '' };
  const max = Math.max(1, ...rows.map((r) => r.total));
  const { markup, topValue } = axisTicks(max);
  const slot = (RIGHT - LEFT) / rows.length;
  const barW = Math.min(46, slot * 0.34);
  const bars = rows.map((row, index) => {
    const x = LEFT + slot * index + slot / 2 - barW;
    const hAll = (row.total / topValue) * (BOTTOM - TOP);
    const hDone = (row.done / topValue) * (BOTTOM - TOP);
    const out = [`<rect class="cbar" x="${x.toFixed(1)}" y="${(BOTTOM - hAll).toFixed(1)}" width="${barW.toFixed(1)}" height="${hAll.toFixed(1)}" rx="3" fill="#30363d"/>`];
    if (hDone > 0) {
      out.push(`<rect class="cbar" x="${(x + barW + 3).toFixed(1)}" y="${(BOTTOM - hDone).toFixed(1)}" width="${barW.toFixed(1)}" height="${hDone.toFixed(1)}" rx="3" fill="${COLORS.done}"/>`);
    }
    if (slot >= 64 || rows.length <= 4 || index % 2 === 0) {
      out.push(`<text x="${(x + barW).toFixed(1)}" y="${BOTTOM + 16}" text-anchor="middle">${esc(row.epic.slice(0, Math.max(6, Math.floor(slot / 7))))}</text>`);
    }
    return out.join('');
  }).join('');
  return { svg: markup + bars, legend: legendItem('#30363d', '全部 story') + legendItem(COLORS.done, '已完成') };
}

/** One day inside the range: a bar, because one day is not a line. */
function singleDayView(row) {
  if (!row) return { svg: emptySvg('这个范围内没有活动'), legend: '' };
  const peak = Math.max(1, row.added || 0, row.deleted || 0);
  const { markup, topValue } = axisTicks(peak);
  const centre = (LEFT + RIGHT) / 2, barW = 46, height = BOTTOM - TOP;
  const parts = [markup];
  const addedH = ((row.added || 0) / topValue) * height;
  const deletedH = ((row.deleted || 0) / topValue) * height;
  if (addedH > 0) parts.push(`<rect class="cbar" x="${centre - barW - 3}" y="${(BOTTOM - addedH).toFixed(1)}" width="${barW}" height="${addedH.toFixed(1)}" rx="3" fill="${COLORS.done}"/>`);
  if (deletedH > 0) parts.push(`<rect class="cbar" x="${centre + 3}" y="${(BOTTOM - deletedH).toFixed(1)}" width="${barW}" height="${deletedH.toFixed(1)}" rx="3" fill="${COLORS.blocked}"/>`);
  // A day with activity but no line churn still gets a baseline stub: drawing nothing read as a bug.
  if (addedH === 0 && deletedH === 0) {
    parts.push(`<rect x="${centre - barW - 3}" y="${BOTTOM - 2}" width="${barW * 2 + 6}" height="2" fill="#30363d"/>`);
  }
  parts.push(`<text x="${centre}" y="${BOTTOM + 18}" text-anchor="middle">${esc(row.date)}</text>`);
  const stories = row.stories ? ' · 当日 ' + row.stories + ' 个 story 变动' : '';
  parts.push(`<text x="${LEFT}" y="${TOP - 8}" text-anchor="start" class="note">该范围只有 1 天有记录${esc(stories)}</text>`);
  return {
    svg: parts.join(''),
    legend: legendItem(COLORS.done, '新增 ' + (row.added || 0) + ' 行')
      + legendItem(COLORS.blocked, '删除 ' + (row.deleted || 0) + ' 行') + '<span>' + esc(row.date) + '</span>',
  };
}

/** Lines added / deleted per day. */
function lineView(activity) {
  if (activity.length < 2) return singleDayView(activity[0]);
  const peak = Math.max(1, ...activity.map((row) => Math.max(row.added || 0, row.deleted || 0)));
  const { markup, topValue } = axisTicks(peak);
  const step = (RIGHT - LEFT) / (activity.length - 1);
  const series = [
    { key: 'added', colour: COLORS.done, name: '新增' },
    { key: 'deleted', colour: COLORS.blocked, name: '删除' },
  ];
  const parts = [markup];
  const totals = {};
  for (const s of series) {
    const values = activity.map((row) => row[s.key] || 0);
    totals[s.key] = sum(values);
    if (totals[s.key] === 0) continue;
    const pts = values.map((value, i) => [LEFT + step * i, BOTTOM - (value / topValue) * (BOTTOM - TOP)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    parts.push(`<path class="line" d="${d}" stroke="${s.colour}" stroke-width="2.5" fill="none"/>`);
    pts.forEach((p, i) => {
      const row = activity[i];
      const style = row.pending
        ? `r="4" fill="none" stroke="${s.colour}" stroke-width="2"`
        : `r="2.8" fill="${s.colour}"`;
      parts.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" ${style} class="dot">`
        + `<title>${esc(row.date + ' · ' + s.name + ' ' + (row[s.key] || 0) + ' 行'
          + (row.stories ? ' · ' + row.stories + ' 个 story 变动' : '') + (row.pending ? ' · 未提交' : ''))}</title></circle>`);
    });
  }
  const first = activity[0].date, last = activity[activity.length - 1].date;
  parts.push(`<text x="${LEFT}" y="${BOTTOM + 18}" text-anchor="start">${esc(first)}</text>`);
  parts.push(`<text x="${RIGHT}" y="${BOTTOM + 18}" text-anchor="end">${esc(last)}</text>`);
  const pendingRows = activity.filter((row) => row.pending);
  const pendingBit = pendingRows.length
    ? ' · 未提交合计 +' + sum(pendingRows.map((r) => r.added)) + ' / -' + sum(pendingRows.map((r) => r.deleted))
    : '';
  return {
    svg: parts.join(''),
    legend: legendItem(COLORS.done, '新增 ' + totals.added + ' 行')
      + legendItem(COLORS.blocked, '删除 ' + totals.deleted + ' 行')
      + '<span>' + esc(first + ' → ' + last + pendingBit) + '</span>',
  };
}

/** Dates unusable: say so, and show the status breakdown instead of a fake trend. */
function noDatesView(counts) {
  const rows = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return { svg: emptySvg('这个范围内没有 story'), legend: '' };
  const left = 120, right = W - 60, max = Math.max(...rows.map(([, n]) => n));
  const bars = rows.map(([key, n], index) => {
    const y = TOP + 12 + index * 34;
    const w = ((right - left) * n) / max;
    return `<text x="${left - 12}" y="${y + 13}" text-anchor="end">${esc(LABELS[key] || key)}</text>`
      + `<rect class="cbar" x="${left}" y="${y}" width="${Math.max(2, w).toFixed(1)}" height="18" rx="4" fill="${COLORS[key] || '#888'}"/>`
      + `<text x="${(left + w + 8).toFixed(1)}" y="${y + 13}" text-anchor="start">${n}</text>`;
  }).join('');
  const note = `<text x="${left}" y="${TOP + 12 + rows.length * 34 + 16}" text-anchor="start" class="note">日期不可用：此目录没有 git 历史，或所有文件同一天落地</text>`;
  return { svg: bars + note, legend: '<span>按状态分布</span>' };
}

/** A view wrapper: one chart, its legend, and the keys the page script toggles on. */
function view(type, days, chart, isDefault = false, now = Date.now()) {
  return `<div class="view${isDefault ? ' on' : ''}" data-type="${type}" data-days="${days}" id="v-${type}-${days}">`
    + `<div class="caption">${esc(rangeLabel(days))}（${esc(spanFor(days, now))}）</div>`
    + `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${type} · ${esc(rangeLabel(days))}">${chart.svg}</svg>`
    + `<div class="legend">${chart.legend}</div></div>`;
}

/** Range aggregates, so the cards and the charts cannot disagree. */
function rangeSummary(items, now) {
  const out = {};
  for (const days of RANGES) {
    const rows = itemsInRange(items, days, now);
    const done = rows.filter((row) => categoryOf(row.status) === 'done').length;
    out[days] = { done, total: rows.length, share: rows.length ? Math.round((done / rows.length) * 100) : 0 };
  }
  return out;
}

/**
 * Build the dashboard document.
 * @param {object} state from collectState()
 * @param {string} root project root, shown in the header only
 * @returns {string} a self-contained HTML document
 */
export function renderDashboard(state, root) {
  const { engine, sprint, stage, stories } = state;
  const now = Date.parse(state.generatedAt) || Date.now();
  const engineLine = engine.name
    ? `${engine.name}${engine.version ? ' ' + engine.version : ''}${engine.language ? ' · ' + engine.language : ''}`
    : 'not configured';
  const sprintLine = sprint.number
    ? `Sprint ${sprint.number}${sprint.goal ? ' — ' + sprint.goal : ''}`
    : 'no sprint plan yet';

  const items = stories.items || [];
  const activity = stories.activity || [];
  const summaries = rangeSummary(items, now);
  const pend = stories.pending || { added: 0, deleted: 0, files: 0, binaryFiles: 0, skippedFiles: 0 };
  const pendingNote = stories.hasPending
    ? ' · 未提交 +' + pend.added + ' / -' + pend.deleted
      + (pend.binaryFiles ? ' · ' + pend.binaryFiles + ' 个二进制文件不计行' : '')
      + (pend.skippedFiles ? ' · ' + pend.skippedFiles + ' 个文件超限跳过' : '')
    : '';

  const views = [];
  for (const days of RANGES) {
    const rows = itemsInRange(items, days, now);
    const counts = {};
    for (const row of rows) {
      const key = categoryOf(row.status);
      counts[key] = (counts[key] || 0) + 1;
    }
    views.push(view('pie', days, pieView(Object.entries(counts).filter(([, n]) => n > 0).map(([key, n]) => ({ key, n }))), days === 90, now));

    const epicMap = new Map();
    for (const row of rows) {
      const key = row.epic || '—';
      if (!epicMap.has(key)) epicMap.set(key, { epic: key, total: 0, done: 0 });
      const entry = epicMap.get(key);
      entry.total += 1;
      if (categoryOf(row.status) === 'done') entry.done += 1;
    }
    views.push(view('bar', days, barView([...epicMap.values()].sort((a, b) => a.epic.localeCompare(b.epic))), false, now));

    const series = activityInRange(activity, days, now);
    const chart = (stories.dateSpread || 0) < 2 ? noDatesView(counts) : lineView(series);
    views.push(view('line', days, chart, false, now));
  }

  const mobileRows = Object.entries(summaries)
    .map(([days, s]) => `<tr><td>${esc(rangeLabel(Number(days)))}</td><td>${s.done} / ${s.total}（${s.share}%）</td></tr>`)
    .join('');
  const epicNames = [...new Set(items.map((item) => item.epic))];
  const epicRows = epicNames.map((epic) => {
    const rows = items.filter((item) => item.epic === epic);
    const done = rows.filter((row) => categoryOf(row.status) === 'done').length;
    return `<tr><td>${esc(epic)}</td><td>${rows.length}</td><td>${done}</td></tr>`;
  }).join('');
  const dayRows = activity.slice(-10).reverse()
    .map((row) => `<tr><td>${esc(row.date)}</td><td>${row.added || 0}</td><td>${row.deleted || 0}</td><td>${row.stories || 0}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio dashboard</title>
<style>
  :root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--ink:#e6edf3;--muted:#8b949e;
        --green:#3fb950;--blue:#58a6ff;--amber:#d29922;--red:#f85149}
  *{box-sizing:border-box}
  body{margin:0;overflow-x:hidden;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:26px 20px 56px}
  header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:20px;margin:0}
  .sub{color:var(--muted);font-size:12.5px;margin-top:4px;font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:12px;margin-bottom:18px}
  @media (max-width:640px){.grid{grid-template-columns:1fr}.wrap{padding:20px 14px 40px}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
  .k{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
  .v{font-size:17px;margin-top:5px}
  .bar{height:7px;border-radius:4px;background:#21262d;overflow:hidden;margin-top:9px}
  .fill{height:100%;background:linear-gradient(90deg,var(--green),#56d364);transform-origin:left;animation:fillin .9s cubic-bezier(.2,.7,.3,1)}
  @keyframes fillin{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px}
  .panel h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
  .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .seg a{display:inline-block;text-decoration:none;color:var(--muted);padding:6px 12px;font-size:12.5px;transition:background .2s,color .2s}
  .seg a[aria-pressed="true"]{background:#1f6feb33;color:#79c0ff}
  .seg a:hover{color:var(--ink)}
  .hint{color:var(--muted);font-size:12px;margin-left:4px}
  .view{display:none;scroll-margin-top:12px}
  /* Base rule first: browsers without :has() (Firefox < 121, Safari < 15.4) must still see the default. */
  .view.on{display:block}
  .view:target{display:block}
  .charts:has(.view:target) .view.on:not(:target){display:none}
  .caption{color:var(--muted);font-size:12px;margin:2px 0 6px}
  .chart{width:100%;height:auto;display:block}
  .chart text{fill:var(--muted);font-size:11px;font-family:inherit}
  .chart .lbl{fill:#f0f6fc;font-weight:600}
  .view .cbar{transform-box:fill-box;transform-origin:bottom;animation:grow .8s cubic-bezier(.2,.7,.3,1)}
  @keyframes grow{from{transform:scaleY(.05);opacity:.2}to{transform:scaleY(1);opacity:1}}
  .view .line{animation:fade .7s ease}
  .view .dot{animation:pop .45s ease}
  @keyframes pop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .view .wedge{stroke-dashoffset:0}
  .view.play .wedge{animation:sweep .7s cubic-bezier(.2,.7,.3,1)}
  @keyframes sweep{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--muted)}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
  ul{margin:8px 0 0;padding-left:18px}
  li{margin:4px 0}
  code{background:#6e768166;padding:.1em .4em;border-radius:4px;font-size:12.5px}
  .tag{color:var(--muted);font-size:12px}
  .empty{color:var(--muted);margin:8px 0 0}
  .warn{color:var(--amber);font-size:12.5px;margin:6px 0;border-left:3px solid var(--amber);padding-left:10px}
  table.m{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed;word-break:break-word}
  table.m th,table.m td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left}
  .mobile{display:none}
  @media (max-width:640px){.charts{display:none}.mobile{display:block}}
  .two{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
  @media (max-width:760px){.two{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
  <header>
    <div>
      <h1>Studio dashboard</h1>
      <div class="sub">${esc(root)} · ${esc(stories.generatedOn || state.generatedAt.slice(0, 10))}</div>
    </div>
    <div class="sub">框架 ${esc(state.framework.version ?? '—')} · ${esc(state.timeZone || 'local time')} · 可离线打开</div>
  </header>

  <div class="grid">
    <div class="card"><div class="k">Engine</div><div class="v">${esc(engineLine)}</div></div>
    <div class="card"><div class="k">Stage</div><div class="v">${esc(stage ?? 'not recorded')}</div></div>
    <div class="card"><div class="k">Sprint</div><div class="v">${esc(sprintLine)}</div></div>
    <div class="card"><div class="k">Stories done · 范围内</div>
      <div class="v"><span id="doneRange">${summaries[90].done} / ${summaries[90].total}</span> <span class="tag" id="donePct">(${summaries[90].share}%)</span></div>
      <div class="bar"><div class="fill" id="doneFill" style="width:${summaries[90].share}%"></div></div>
      <div class="tag" id="doneAll" style="margin-top:6px">全部 ${stories.done} / ${stories.total}${esc(pendingNote)}</div>
    </div>
  </div>

  <div class="panel charts">
    <h2>图表 <span class="hint" id="hint">三张图都按所选范围统计 · 范围以生成时间为准</span></h2>
    <div class="controls">
      <div class="seg" id="type">
        <a href="#v-pie-90" data-type="pie" aria-pressed="true">饼图 · 状态分布</a>
        <a href="#v-bar-90" data-type="bar" aria-pressed="false">柱图 · 每个 epic</a>
        <a href="#v-line-90" data-type="line" aria-pressed="false">折线图 · 活动趋势</a>
      </div>
      <div class="seg" id="range">
        <a href="#v-pie-7" data-days="7" aria-pressed="false">7 天</a>
        <a href="#v-pie-30" data-days="30" aria-pressed="false">30 天</a>
        <a href="#v-pie-90" data-days="90" aria-pressed="true">90 天</a>
        <a href="#v-pie-0" data-days="0" aria-pressed="false">全部</a>
      </div>
    </div>
${views.join('\n')}
  </div>

  <div class="panel mobile">
    <h2>范围汇总</h2>
    <table class="m"><tr><th>范围</th><th>完成 / 总数（占比）</th></tr>${mobileRows}</table>
    <h2 style="margin-top:16px">每个 epic</h2>
    <table class="m"><tr><th>epic</th><th>story</th><th>完成</th></tr>${epicRows || '<tr><td colspan="3">暂无 story</td></tr>'}</table>
    <h2 style="margin-top:16px">最近 10 个有记录的日子</h2>
    <table class="m"><tr><th>日期</th><th>新增</th><th>删除</th><th>story</th></tr>${dayRows || '<tr><td colspan="4">暂无记录</td></tr>'}</table>
  </div>

  <div class="two">
    <div class="panel">
      <h2>Next</h2>
      ${stories.next
        ? `<p><code>${esc(stories.next.file)}</code> <span class="tag">${esc(stories.next.status ?? 'no status line')}</span></p>`
        : '<p class="empty">No story files yet. Run /map-systems, then /create-epics and /create-stories.</p>'}
      <h2 style="margin-top:18px">Blocked (${esc(stories.blocked)})</h2>
      ${stories.blocked > 0
        ? `<ul>${stories.blockedList.map((s) => `<li><code>${esc(s.file)}</code> <span class="tag">${esc(s.status)}</span></li>`).join('')}</ul>`
        : '<p class="empty">Nothing blocked.</p>'}
    </div>
    <div class="panel">
      <h2>数据来源</h2>
      <ul>
        <li>story 文件 <span class="tag">${esc(stories.total)}</span></li>
        <li>session 日志 <span class="tag">${esc(stories.docs.sessionLogs)}</span></li>
        <li>GDD 文档 <span class="tag">${esc(stories.docs.gdd)}</span></li>
        <li>叙事 / 关卡 / 数值 <span class="tag">${esc(stories.docs.narrative)} / ${esc(stories.docs.levels)} / ${esc(stories.docs.balance)}</span></li>
        <li>ADR 文档 <span class="tag">${esc(stories.docs.adr)}</span></li>
        <li>有活动的日期 <span class="tag">${esc(stories.activity.length)}</span></li>
        <li>行数来源 <span class="tag">${esc(churnLabel(stories.churnSource))}</span></li>
      </ul>
      <h2 style="margin-top:18px">Warnings</h2>
      ${state.warnings.length ? state.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('') : '<p class="empty">None.</p>'}
    </div>
  </div>
</div>
<script id="state" type="application/json">${JSON.stringify({ summaries }).replace(/</g, '\\u003c')}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('state').textContent);
  const views = [...document.querySelectorAll('.view')];
  let type = 'pie';
  let days = '90';

  // The hash is the single source of visibility: CSS :target reveals the view, so a link works with or
  // without this script. The script only keeps the two controls combined and refreshes the numbers.
  function show(clearHash = true) {
    for (const view of views) {
      const on = view.dataset.type === type && view.dataset.days === days;
      view.classList.toggle('on', on);
      view.classList.remove('play');
      if (on) requestAnimationFrame(() => view.classList.add('play'));
    }
    if (clearHash && location.hash) history.replaceState(null, '', location.pathname + location.search);
    const summary = data.summaries[days];
    const range = document.getElementById('doneRange');
    const pct = document.getElementById('donePct');
    const fill = document.getElementById('doneFill');
    if (range) range.textContent = summary.done + ' / ' + summary.total;
    if (pct) pct.textContent = '(' + summary.share + '%)';
    if (fill) fill.style.width = summary.share + '%';
  }

  document.getElementById('type').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    type = link.dataset.type;
    for (const a of document.querySelectorAll('#type a')) a.setAttribute('aria-pressed', String(a === link));
    show();
  });
  document.getElementById('range').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    days = link.dataset.days;
    for (const a of document.querySelectorAll('#range a')) a.setAttribute('aria-pressed', String(a === link));
    show();
  });
  function syncPressed() {
    for (const a of document.querySelectorAll('#type a')) a.setAttribute('aria-pressed', String(a.dataset.type === type));
    for (const a of document.querySelectorAll('#range a')) a.setAttribute('aria-pressed', String(a.dataset.days === days));
  }

  function adoptHash() {
    const match = location.hash.match(/^#v-(pie|bar|line)-(7|30|90|0)$/);
    if (!match) return false;
    type = match[1];
    days = match[2];
    return true;
  }

  window.addEventListener('hashchange', () => {
    if (!adoptHash()) return;
    syncPressed();
    show();
  });

  adoptHash();
  syncPressed();
  show();
})();
</script>
</body></html>
`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const rootArg = process.argv.indexOf('--root');
  let root;
  if (rootArg >= 0) {
    const value = process.argv[rootArg + 1];
    if (!value || value.startsWith('--')) { console.error('--root needs a directory'); process.exit(2); }
    root = resolve(value);
    if (!existsSync(root)) { console.error('--root does not exist: ' + root); process.exit(2); }
    if (!statSync(root).isDirectory()) { console.error('--root is not a directory: ' + root); process.exit(2); }
  } else {
    root = rootFromScript();
  }
const out = join(root, 'production', 'dashboard.html');
  const state = collectState(root);
  const html = renderDashboard(state, root);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html, 'utf8');
  } catch (error) {
    console.error('cannot write ' + out + ': ' + error.message);
    process.exit(3);
  }
  process.stdout.write(`wrote ${out} (${state.stories.done}/${state.stories.total} stories, ${state.warnings.length} warning(s))\n`);
}





















