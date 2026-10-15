#!/usr/bin/env node
/**
 * check-dsh — validate the generated `.dsh/` tree against its `.claude/` source.
 *
 *   node tools/check-dsh.mjs [projectRoot]
 *
 * Exit code 0 = no errors (warnings allowed), 1 = errors found.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd());
const SRC = join(ROOT, '.claude');
const OUT = join(ROOT, '.dsh');

const MIRRORED_DIRS = ['skills', 'agents', 'rules', 'hooks', 'scripts', 'docs'];

/** Files that legitimately exist only on the DSH side (hand-written or generated). */
const GENERATED_EXTRAS = new Set(['agents/README.md', 'rules/INDEX.md', 'docs/studio-rules.md']);
/** Files the hand-written overlay (`dsh-src/`) adds to the generated tree. */
const OVERLAY_EXTRAS = new Set(['docs/dsh-differences.md', 'statusline.mjs', 'skills/statusline/SKILL.md', 'skills/dsgs-install/SKILL.md']);

/** DSH-side additions by shape: the Node hook ports and their shared helpers. */
function isGeneratedExtra(rel) {
  return GENERATED_EXTRAS.has(rel) || OVERLAY_EXTRAS.has(rel) || /^(hooks|scripts)\/[\w.-]+\.(mjs|md|json)$/.test(rel);
}
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The generated-header sentinels must match tools/build-dsh.mjs exactly; they mark the
// block that is stripped before residual-token scans.
const HEADER_BEGIN = '<!-- DSGS-GENERATED:BEGIN';
const HEADER_END = '<!-- DSGS-GENERATED:END -->';

const errors = [];
const warnings = [];
const info = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function relList(base, files) {
  return files.map((f) => relative(base, f).split('\\').join('/'));
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const block = text.slice(text.indexOf('\n', 3) + 1, end);
  const data = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[m[1]] = value;
  }
  return data;
}

function stripHeader(text) {
  const begin = text.indexOf(HEADER_BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(HEADER_END, begin);
  if (end === -1) return text;
  return text.slice(0, begin) + text.slice(end + HEADER_END.length);
}

if (!existsSync(OUT)) {
  console.error(`FAIL: ${OUT} does not exist — run node tools/build-dsh.mjs first`);
  process.exit(1);
}

// 1. File parity between source and generated trees.
// A generated filename may differ from its source when the source name is user-visible and
// names the other runtime; tools/build-dsh.mjs holds the same mapping (`outRel`).
const OUTPUT_RENAMES = new Map([['docs/CLAUDE-local-template.md', 'docs/local-instructions-template.md']]);
for (const dir of MIRRORED_DIRS) {
  const srcDir = join(SRC, dir);
  const outDir = join(OUT, dir);
  if (!existsSync(srcDir)) {
    if (existsSync(outDir)) errors.push(`parity: .dsh/${dir} exists but .claude/${dir} does not`);
    continue;
  }
  const mapped = (f) => OUTPUT_RENAMES.get(`${dir}/${f}`)?.slice(dir.length + 1) ?? f;
  const src = new Set(relList(srcDir, await walk(srcDir)));
  const srcOut = new Set([...src].map(mapped));
  const out = new Set(existsSync(outDir) ? relList(outDir, await walk(outDir)) : []);
  for (const f of srcOut) if (!out.has(f)) errors.push(`parity: missing .dsh/${dir}/${f}`);
  for (const f of out) {
    if (srcOut.has(f) || isGeneratedExtra(`${dir}/${f}`)) continue;
    errors.push(`parity: unexpected .dsh/${dir}/${f}`);
  }
}
if (existsSync(join(SRC, 'statusline.sh')) && !existsSync(join(OUT, 'statusline.sh'))) {
  errors.push('parity: missing .dsh/statusline.sh');
}

// 2. Skill frontmatter validity.
const skillDirs = (await readdir(join(OUT, 'skills'), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const name of skillDirs) {
  const path = join(OUT, 'skills', name, 'SKILL.md');
  if (!existsSync(path)) {
    errors.push(`skill ${name}: SKILL.md missing`);
    continue;
  }
  const text = await readFile(path, 'utf8');
  const fm = splitFrontmatter(text);
  if (fm === undefined) {
    errors.push(`skill ${name}: missing YAML frontmatter`);
    continue;
  }
  if (!fm.name) errors.push(`skill ${name}: frontmatter lacks name`);
  else if (fm.name !== name) errors.push(`skill ${name}: frontmatter name "${fm.name}" != directory name`);
  else if (!SKILL_NAME.test(fm.name)) errors.push(`skill ${name}: name is not kebab-case`);
  if (!fm.description) errors.push(`skill ${name}: frontmatter lacks description`);
  info.push(`skill ${name}: user=${fm['user-invocable'] ?? 'default'} model=${fm['disable-model-invocation'] === 'true' ? 'off' : 'on'} desc=${(fm.description ?? '').length}c`);
}

// 3. Agent cards.
const agentFiles = (await readdir(join(OUT, 'agents')))
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !GENERATED_EXTRAS.has(`agents/${f}`));
for (const file of agentFiles) {
  const text = await readFile(join(OUT, 'agents', file), 'utf8');
  const fm = splitFrontmatter(text);
  const stem = file.replace(/\.md$/, '');
  if (fm === undefined) errors.push(`agent ${stem}: missing YAML frontmatter`);
  else {
    if (!fm.name) errors.push(`agent ${stem}: frontmatter lacks name`);
    else if (fm.name !== stem) errors.push(`agent ${stem}: frontmatter name "${fm.name}" != file name`);
    if (!fm.description) errors.push(`agent ${stem}: frontmatter lacks description`);
  }
}

// 4. Residual Claude-only tokens in generated bodies (generated header and metadata excluded).
const RESIDUALS = [
  ['${CLAUDE_SKILL_DIR}', /CLAUDE_SKILL_DIR/],
  ['AskUserQuestion', /\bAskUserQuestion\b/],
  ['TodoWrite', /\bTodoWrite\b/],
  ['WebSearch', /\bWebSearch\b/],
  ['WebFetch', /\bWebFetch\b/],
  ['.claude/ path', /\.claude[\/\\]/],
  // The studio's own brand must not survive generation: `.claude/**` keeps upstream's
  // name, and `tools/build-dsh.mjs` rewrites it while generating. References to the Claude
  // Code *product* are deliberately not listed here — they stay factual.
  // NOTE: the two entries below name the OLD brand on purpose — do not "fix" them.
  ['CCGS', /\bCCGS\b/],
  ['Claude Code Game Studios', /Claude Code Game Studios/],
];
const METADATA_FILES = new Set(['PORT-MANIFEST.json', 'hooks.json']);
const allGenerated = (await walk(OUT))
  .filter((f) => /\.(md|sh|json|ya?ml)$/.test(f))
  .filter((f) => !METADATA_FILES.has(f.split(/[\\/]/).pop()))
  // Provenance document: its section headings deliberately name the `.claude/` sources.
  .filter((f) => !f.endsWith(join('docs', 'studio-rules.md')));
const residualHits = new Map(RESIDUALS.map(([label]) => [label, []]));
for (const file of allGenerated) {
  const body = stripHeader(await readFile(file, 'utf8'));
  for (const [label, re] of RESIDUALS) {
    const lines = body.split('\n');
    lines.forEach((line, index) => {
      if (re.test(line)) residualHits.get(label).push(`${relative(ROOT, file).split('\\').join('/')}:${index + 1}`);
    });
  }
}
for (const [label, hits] of residualHits) {
  if (hits.length === 0) continue;
  const sample = hits.slice(0, 5).join(', ');
  warnings.push(`residual ${label}: ${hits.length} line(s) — ${sample}${hits.length > 5 ? ', …' : ''}`);
}

// 4b. User-facing surfaces must not name the other runtime.
// A normal DSGS user opens skill cards, role cards and rules; the port replaces the other
// runtime's name there (see tools/build-dsh.mjs) so the product reads as its own thing.
// Maintainer documents (docs/, hooks/, scripts/) keep the porting facts and are exempt.
const userFacing = ['skills', 'agents', 'rules'];
const runtimeHits = [];
for (const dir of userFacing) {
  const root = join(OUT, dir);
  if (!existsSync(root)) continue;
  for (const file of await walk(root)) {
    if (!/\.(md|json|ya?ml)$/.test(file)) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/\bClaude\b/.test(line)) {
        runtimeHits.push(`${relative(ROOT, file).split('\\').join('/')}:${index + 1}`);
      }
    });
  }
}
if (runtimeHits.length > 0) {
  const sample = runtimeHits.slice(0, 5).join(', ');
  errors.push(`user-facing content names the other runtime: ${runtimeHits.length} line(s) — ${sample}${runtimeHits.length > 5 ? ', …' : ''}`);
}

// 4c. POSIX-only one-liners in user-facing text.
// The DSH session shell is pwsh and Git Bash cannot start under the sandbox, so a POSIX command
// left in skill text is a command that cannot run. Script *invocations* are translated by the
// generator (`.sh` → `.mjs`); these are the inline forms, and `wc -c` was verified failing
// ("术语 'wc' 不会被识别") before the rewrite rules were added.
const POSIX_ONLY = [
  ['wc -c', /\bwc -c\b/],
  ['rm -f / rm -rf', /\brm -[rf]/],
  ['mkdir -p', /\bmkdir -p\b/],
  ['grep', /\bgrep (-[A-Za-z]+ )?['"]/],
  ['sort -u', /\bsort -u\b/],
  ["printf '%s'", /printf '%s'/],
  ['sed -', /\bsed -[A-Za-z]/],
  ['awk', /\bawk ['"]/],
  ['chmod', /\bchmod \d/],
  ['.sh:NN citation', /[\w.-]+\.sh:\d+/],
];
const posixHits = [];
for (const dir of ['skills', 'agents', 'docs']) {
  const root = join(OUT, dir);
  if (!existsSync(root)) continue;
  for (const file of await walk(root)) {
    if (!/\.(md|json|ya?ml)$/.test(file)) continue;
    // `docs/hooks-reference/**` documents the upstream BASH hook implementations — `grep -n` and
    // friends are its subject matter, not a command a DSH session is told to run. Those documents
    // carry the "上游机制说明" banner and the DSH equivalents live in `.dsh/hooks/*.mjs`.
    // `docs/settings-local-template.md` is a settings template: `"Bash(rm -rf *)"` there is a
    // permission-rule pattern being demonstrated, not a command.
    const outRel = relative(OUT, file).split('\\').join('/');
    if (outRel.startsWith('docs/hooks-reference/') || outRel === 'docs/settings-local-template.md') continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const [label, re] of POSIX_ONLY) {
        if (re.test(line)) posixHits.push(`${relative(ROOT, file).split('\\').join('/')}:${index + 1} (${label})`);
      }
    });
  }
}
if (posixHits.length > 0) {
  const sample = posixHits.slice(0, 5).join(', ');
  errors.push(`POSIX-only command left in user-facing text: ${posixHits.length} line(s) — ${sample}${posixHits.length > 5 ? ', …' : ''}`);
}

// 5. Hooks config.
const hooksJson = join(OUT, 'hooks.json');
if (!existsSync(hooksJson)) errors.push('hooks.json missing (generated from .claude/settings.json)');
else {
  const payload = JSON.parse(await readFile(hooksJson, 'utf8'));
  let commands = 0;
  // The protocol exact-matches pipe-separated matcher literals in claude-code mode, so a
  // matcher left in Claude spelling (`Write|Edit`, `Bash|PowerShell`) never selects a DSH
  // tool call. Catch that here instead of discovering it as silence in a live session.
  const CLAUDE_TOOL_SPELLING = /^(Bash|PowerShell|Write|Edit|Read|Grep|Glob|Agent|Task)(\||$)/;
  for (const [event, groups] of Object.entries(payload.hooks ?? {})) {
    for (const group of groups) {
      if (typeof group.matcher === 'string' && CLAUDE_TOOL_SPELLING.test(group.matcher.trim())) {
        errors.push(`hooks.json ${event}: matcher "${group.matcher}" uses Claude Code tool spelling; DSH tool names are lowercase (pwsh/write/edit/…)`);
      }
      for (const hook of group.hooks ?? []) {
        commands += 1;
        const command = String(hook.command);
        const quoted = /"([^"]+\.(?:mjs|sh|js))"/.exec(command);
        const script = quoted !== null
          ? quoted[1]
          : command.replace(/^\S+\s+/, '').replace(/^["']|["']$/g, '');
        if (!existsSync(script)) {
          errors.push(`hooks.json ${event}: script not found: ${script}`);
        }
      }
    }
  }
  info.push(`hooks.json: ${Object.keys(payload.hooks ?? {}).length} events, ${commands} commands`);
}

const report = {
  root: ROOT,
  skills: skillDirs.length,
  agents: agentFiles.length,
  rules: (await readdir(join(OUT, 'rules')))
    .filter((f) => f.endsWith('.md') && !GENERATED_EXTRAS.has(`rules/${f}`)).length,
  hooks: (await readdir(join(OUT, 'hooks'))).filter((f) => f.endsWith('.sh')).length,
  errors,
  warnings,
};
console.log(JSON.stringify(report, null, 2));
console.log(`\nSUMMARY skills=${report.skills} agents=${report.agents} rules=${report.rules} hooks=${report.hooks} `
  + `errors=${errors.length} warnings=${warnings.length}`);
process.exit(errors.length === 0 ? 0 : 1);



