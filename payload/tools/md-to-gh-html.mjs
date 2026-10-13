/**
 * Minimal GitHub-flavoured Markdown → HTML renderer, used only to preview README.md the way
 * GitHub will render it. Deliberately small: headings, paragraphs, fenced code, pipe tables,
 * task lists, bullet/ordered lists, blockquotes, rules, and inline bold/code/links.
 *
 * Usage:  node tools/md-to-gh-html.mjs README.md docs/README.preview.html "deepseek-harness-game-studios"
 *
 * @module tools/md-to-gh-html
 */
import { readFileSync, writeFileSync } from 'node:fs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markup: code, bold, links, em. */
function inline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^\w\u4e00-\u9fff -]/g, '').trim().replace(/\s+/g, '-');

/**
 * Render markdown to an HTML body.
 * @param markdown - the document.
 * @returns HTML string (no wrapper).
 */
export function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let code = [];
  let list = null; // 'ul' | 'ol' | 'task'
  let para = [];

  const flushPara = () => {
    if (para.length > 0) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list === 'ol' ? 'ol' : 'ul'}>`); list = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```/.test(line)) {
        out.push(`<pre><code${codeLang ? ` class="language-${codeLang}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
        inCode = false; code = []; codeLang = '';
      } else code.push(line);
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) { flushPara(); flushList(); inCode = true; codeLang = fence[1] || ''; i++; continue; }

    if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const level = h[1].length;
      const text = h[2].replace(/\s*#+\s*$/, '');
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr />'); i++; continue; }

    if (/^>\s?/.test(line)) {
      flushPara(); flushList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    // Pipe table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      flushPara(); flushList();
      // Split on pipes that are NOT escaped (GitHub honours \| inside a cell).
      const cells = (row) => row.replace(/^\||\|$/g, '').split(/(?<!\\\\)\|/).map((c) => c.trim().replace(/\\\\\|/g, '|'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table>\n<thead>\n<tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>\n</thead>\n<tbody>');
      for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      out.push('</tbody>\n</table>');
      continue;
    }

    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      flushPara();
      if (list !== 'task') { flushList(); out.push('<ul class="contains-task-list">'); list = 'task'; }
      const checked = task[1].toLowerCase() === 'x';
      out.push(`<li class="task-list-item"><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${inline(task[2])}</li>`);
      i++;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      i++;
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushPara();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ordered[1])}</li>`);
      i++;
      continue;
    }

    // Raw HTML block: GitHub passes it through, so the preview must too.
    if (/^<[a-zA-Z!/]/.test(line)) {
      flushPara(); flushList();
      const html = [];
      while (i < lines.length && !/^\s*$/.test(lines[i])) { html.push(lines[i]); i++; }
      out.push(html.join('\n'));
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** GitHub-like wrapper (dark theme, matching the harness UI). */
function page(title, body, repoName) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(repoName)} — README 预览（GitHub 风格）</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
    font: 16px/1.6 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; }
  .banner { background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 24px;
    font-size: 13px; color: #8b949e; position: sticky; top: 0; }
  .banner b { color: #e6edf3; }
  .wrap { max-width: 1012px; margin: 0 auto; padding: 24px; }
  .filebar { display: flex; align-items: center; gap: 8px; padding: 8px 0 16px;
    border-bottom: 1px solid #30363d; color: #8b949e; font-size: 14px; }
  .filebar .path { color: #e6edf3; font-weight: 600; }
  .markdown-body { padding: 24px 0 64px; }
  .markdown-body h1, .markdown-body h2 { border-bottom: 1px solid #21262d; padding-bottom: .3em; }
  .markdown-body h1 { font-size: 2em; margin: .5em 0 .6em; }
  .markdown-body h2 { font-size: 1.5em; margin: 1.6em 0 .8em; }
  .markdown-body h3 { font-size: 1.25em; margin: 1.4em 0 .6em; }
  .markdown-body h4 { font-size: 1em; margin: 1.2em 0 .5em; }
  .markdown-body a { color: #4493f8; text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .markdown-body code { background: #6e768166; padding: .2em .4em; border-radius: 6px;
    font: 85% ui-monospace, SFMono-Regular, Consolas, monospace; }
  .markdown-body pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 16px; overflow: auto; }
  .markdown-body pre code { background: none; padding: 0; font-size: 85%; }
  .markdown-body table { border-collapse: collapse; display: block; overflow: auto; margin: 1em 0; }
  .markdown-body th, .markdown-body td { border: 1px solid #30363d; padding: 6px 13px; }
  .markdown-body th { background: #161b22; }
  .markdown-body tr:nth-child(2n) td { background: #161b22; }
  .markdown-body blockquote { border-left: 4px solid #3b434b; margin: 0; padding: 0 1em;
    color: #8b949e; }
  .markdown-body hr { border: 0; border-top: 1px solid #30363d; margin: 24px 0; }
  .markdown-body ul, .markdown-body ol { padding-left: 2em; }
  .markdown-body li + li { margin-top: .25em; }
  .markdown-body .task-list-item { list-style: none; margin-left: -1.4em; }
  .markdown-body input[type=checkbox] { margin-right: .4em; }
  .note { background: #1f6feb1a; border: 1px solid #1f6feb66; border-radius: 6px;
    padding: 12px 16px; margin: 16px 0; font-size: 14px; color: #c9d1d9; }
</style></head>
<body>
<div class="banner">这是 <b>GitHub 渲染预览</b>（本地生成，未联网）：内容与推送后在 ${esc(repoName)} 仓库首页看到的一致。</div>
<div class="wrap">
  <div class="filebar"><span class="path">${esc(repoName)}</span> / README.md</div>
  <div class="markdown-body">
${body}
  </div>
</div>
</body></html>
`;
}

const [input, output, repoName = 'deepseek-harness-game-studios'] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/md-to-gh-html.mjs <input.md> <output.html> [repo-name]');
  process.exit(2);
}
const md = readFileSync(input, 'utf8');
writeFileSync(output, page('README', render(md), repoName), 'utf8');
console.log(`wrote ${output} (${md.length} chars markdown)`);



