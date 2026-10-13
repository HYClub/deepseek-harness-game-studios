/**
 * rules-context — the DSH replacement for upstream path-scoped rules.
 *
 * The upstream runtime applies `.dsh/rules/*.md` automatically by the `paths:` globs in their
 * frontmatter. DSH has no such engine, and an instruction in AGENTS.md ("read the
 * matching rule before editing") turned out to be exactly as reliable as a reminder:
 * a real `code-review` run never loaded them, and three of its findings existed only
 * because the reviewer happened to read `ui-code.md` anyway.
 *
 * So the rules are pushed where they are needed. This is a PostToolUse hook: after a
 * write/edit it matches the touched path against every rule's `paths:` globs and injects
 * the matching rule bodies as model context, so the model can fix the change it just made
 * in the same turn. It never blocks and never scores — observations, not verdicts.
 *
 * Source: `dsh-src/hooks/rules-context.mjs`; registered by `dsh-src/hooks/dsh-hooks.json`
 * (merged into the generated `.dsh/hooks.json`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { context, projectRoot, readInput, run } from './runtime.mjs';

/** Expand one `{a,b}` group (one level, as the rule files use them). */
function expandBraces(glob) {
  const out = [];
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  const close = glob.indexOf('}', open);
  if (close === -1) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  for (const option of glob.slice(open + 1, close).split(',')) {
    out.push(...expandBraces(`${prefix}${option}${suffix}`));
  }
  return out;
}

/** Translate one rule glob into a RegExp: `**` crosses directories, `*` does not. */
function globToRegExp(glob) {
  const insensitive = process.platform === 'win32';
  const bodies = expandBraces(glob).map((pattern) => {
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === '*') {
        if (pattern[i + 1] === '*') {
          out += '.*';
          i += 1;
        } else {
          out += '[^/]*';
        }
        continue;
      }
      if (ch === '?') {
        out += '[^/]';
        continue;
      }
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return out;
  });
  return new RegExp(`^(?:${bodies.join('|')})$`, insensitive ? 'i' : '');
}

/** Read a rule file's `paths:` list and its body (frontmatter stripped). */
function readRule(text) {
  const paths = [];
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const frontmatter = text.slice(text.indexOf('\n', 3) + 1, end);
      body = text.slice(text.indexOf('\n', end + 1) + 1);
      let inPaths = false;
      for (const line of frontmatter.split('\n')) {
        const head = /^paths\s*:\s*(.*)$/.exec(line);
        if (head !== null) {
          inPaths = true;
          const inline = head[1].trim();
          if (inline.length > 0) paths.push(inline.replace(/^["']|["']$/g, ''));
          continue;
        }
        if (!inPaths) continue;
        const item = /^\s+-\s*(.+)$/.exec(line);
        if (item !== null) paths.push(item[1].trim().replace(/^["']|["']$/g, ''));
        else if (/^\S/.test(line)) inPaths = false;
      }
    }
  }
  return { paths, body: body.trim() };
}

run(async () => {
  const input = readInput();
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'PostToolUse';
  const toolInput = input.tool_input ?? {};
  const filePath = toolInput.file_path ?? toolInput.path;
  if (typeof filePath !== 'string' || filePath.length === 0) return;

  const root = projectRoot(input);
  const absolute = resolve(root, filePath);
  const rel = relative(root, absolute).split('\\').join('/');
  if (rel.startsWith('..')) return;

  const rulesDir = join(root, '.dsh', 'rules');
  if (!existsSync(rulesDir)) return;

  const matched = [];
  for (const file of readdirSync(rulesDir).sort()) {
    if (!file.endsWith('.md') || file === 'INDEX.md') continue;
    const rule = readRule(readFileSync(join(rulesDir, file), 'utf8'));
    if (rule.paths.length === 0) continue;
    if (rule.paths.some((glob) => globToRegExp(glob).test(rel))) matched.push({ file, body: rule.body });
  }
  if (matched.length === 0) return;

  const text = [
    `路径规则提醒：\`${rel}\` 命中 ${matched.length} 条规则（DSH 没有路径作用域规则引擎，由本钩子在改动后注入）。`,
    '请按下面的原文检查并修正刚才的改动；规则不通过的项要在回复里说明。',
    '',
    ...matched.map((rule) => `### .dsh/rules/${rule.file}\n\n${rule.body}`),
  ].join('\n');
  context(event, text);
});
