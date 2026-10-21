#!/usr/bin/env node
/**
 * build-dsh — generate the DSH-native tree (`.dsh/`) from the DSGS source tree (`.claude/`).
 *
 * Single source of truth: `.claude/**` stays exactly as upstream ships it, so Claude Code
 * keeps working. This script derives the DSH side:
 *
 *   .claude/skills/**   -> .dsh/skills/**      (SKILL.md + auxiliary files, DSH-adapted)
 *   .claude/agents/*.md -> .dsh/agents/*.md    (role cards for subagent/workflow delegation)
 *   .claude/rules/*.md  -> .dsh/rules/*.md     (path-scoped standards, referenced by AGENTS.md)
 *   .claude/hooks/*.sh  -> .dsh/hooks/*.sh     (Claude-Code-compatible hook scripts)
 *   .claude/scripts/**  -> .dsh/scripts/**
 *   .claude/docs/**     -> .dsh/docs/**
 *   .claude/statusline.sh -> .dsh/statusline.sh
 *   .claude/settings.json -> .dsh/hooks.json   (hooks map for @deepseek-ai/dsh-hooks-claude-code)
 *
 * The output is generated: never hand-edit `.dsh/`. Edit `.claude/` (or this script) and re-run
 *
 *   node tools/build-dsh.mjs [projectRoot]
 *
 * Options:
 *   --dry-run   report what would change, write nothing
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ROOT = resolve(argv.find((a) => !a.startsWith('--')) ?? process.cwd());

const SRC_ROOT = join(ROOT, '.claude');
const OUT_ROOT = join(ROOT, '.dsh');

const TEXT_EXT = new Set(['.md', '.sh', '.json', '.yaml', '.yml', '.txt', '.py', '.mjs', '.js', '.ts']);

/** Directories mirrored from `.claude/<name>` to `.dsh/<name>`. */
const MIRRORED_DIRS = ['skills', 'agents', 'rules', 'hooks', 'scripts', 'docs'];

/**
 * Output-name overrides: a generated filename is user-visible, so one that names the other
 * runtime is renamed on the DSH side (the content source keeps its own name). The checker
 * mirrors this map (`OUTPUT_RENAMES` in tools/check-dsh.mjs) for its parity comparison.
 */
const OUTPUT_RENAMES = new Map([
  ['docs/CLAUDE-local-template.md', 'docs/local-instructions-template.md'],
]);

/** Tool-name mapping applied to prose and frontmatter tool lists. */
const DISTINCTIVE_TOOLS = new Map([
  ['AskUserQuestion', 'ask_user_question'],
  ['TodoWrite', 'todo_write'],
  ['WebSearch', 'web_search'],
  ['WebFetch', 'web_fetch'],
]);

/** Ambiguous capitalized tool names, rewritten only in frontmatter lists and backticks. */
const CASED_TOOLS = new Map([
  ['Read', 'read'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['Grep', 'grep'],
  ['Glob', 'glob'],
  ['Bash', 'pwsh'],
  ['PowerShell', 'pwsh'],
  ['NotebookEdit', 'edit'],
  ['Agent', 'subagent'],
  ['Task', 'subagent'],
]);

const FRONTMATTER_TOOL_KEYS = new Set(['tools', 'allowed-tools', 'disallowedTools', 'disallowed-tools']);

/** Claude Code frontmatter keys with no DSH equivalent: dropped from generated copies. */
const DROPPED_FRONTMATTER_KEYS = new Set([
  'tools',
  'allowed-tools',
  'disallowedTools',
  'disallowed-tools',
  'argument-hint',
]);

/** Shell that can actually run the framework's POSIX scripts on this machine. */
const BASH = process.platform === 'win32' ? '"C:/Program Files/Git/bin/bash.exe"' : 'bash';

/** DSH-native source tree copied verbatim into `.dsh/` after the derived files. */
const OVERLAY_DIR = 'dsh-src';

/** Base names of the POSIX helper scripts that already have a Node port. */
const SCRIPT_PORTS = new Set(
  existsSync(join(ROOT, OVERLAY_DIR, 'scripts'))
    ? (await readdir(join(ROOT, OVERLAY_DIR, 'scripts')))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => name.replace(/\.mjs$/, ''))
    : [],
);


// The generated header is read by end users inside every skill card and role card. It
// therefore carries ONLY what an end user needs: "this file is generated, here is how to
// regenerate it" plus the runtime notes that change behaviour. Provenance (which source
// file, which frontmatter fields were dropped) lives in PORT-MANIFEST.json instead — the
// port's bookkeeping belongs to maintainers, not to every card a user opens, and it was
// the single largest source of upstream-runtime mentions in generated content.
const HEADER_BEGIN = '<!-- DSGS-GENERATED:BEGIN — do not edit by hand -->';
const HEADER_END = '<!-- DSGS-GENERATED:END -->';

const COMMON_HEADER_LINES = [
  '> **生成物，勿手改**：改动会在下次生成时被覆盖。',
  '>',
  '> - 重新生成：`node tools/build-dsh.mjs`（内容源与 `dsh-src/` → `.dsh/`）。',
  '> - 工具名是 DSH 的：`pwsh` / `read` / `write` / `edit` / `grep` / `glob` / `subagent` / `ask_user_question` / `todo_write` / `web_search`。',
  '> - 委派子代理：读角色卡 `.dsh/agents/<name>.md`，把卡片正文连同任务作为 `subagent`（一次性/可续）或 `workflow`（批量编排）的 prompt。约定见 `.dsh/agents/README.md`。',
];

function headerFor(kind, rel, meta = {}) {
  const lines = [...COMMON_HEADER_LINES];
  if (kind === 'skill') {
    lines.push('> - 本技能的基础目录见会话注入的 `Base directory for this skill`；相对路径都相对它解析。');
    lines.push('> - 正文里的「前置命令」块需要你亲自运行（原文的预执行行在 DSH 不生效）。');
  }
  if (kind === 'agent') {
    lines.push('> - 这是代理角色卡，不是可自动加载的代理定义：DSH 里由调用方读本卡片，把它作为 `subagent` 的 prompt（或 `workflow` 里 `agent()` 的 prompt）传给子代理。约定见 `.dsh/agents/README.md`。');
  }
  // DSH ignores a role card's `tools:` field, so the boundary is written into the body instead: the
  // delegating model reads it, even though the runtime cannot enforce it. The tool names are mapped to
  // this runtime's names so the line agrees with the frontmatter directly above it.
  const TOOL_NAMES = {
    Read: 'read', Glob: 'glob', Grep: 'grep', Write: 'write', Edit: 'edit', Bash: 'pwsh',
    WebSearch: 'web_search', WebFetch: 'web_fetch', TodoWrite: 'todo_write', Agent: 'subagent', Task: 'subagent',
  };
  const toolsValue = (meta.dropped ?? {}).tools ?? (meta.kept ?? {}).tools;
  const toolsText = Array.isArray(toolsValue) ? toolsValue.join(', ') : String(toolsValue ?? '');
  const mappedTools = toolsText
    .replace(/\b(Agent|Task)\s*\(/g, 'subagent(')
    .replace(/\b(Read|Glob|Grep|Write|Edit|Bash|WebSearch|WebFetch|TodoWrite)\b/g, (name) => TOOL_NAMES[name]);
  if (String(kind).startsWith('agent') && typeof toolsValue === 'string' && toolsValue.trim() !== '') {
    lines.push('> - 工具边界（运行时不会强制，但请把它当作本次角色的边界）：`' + mappedTools + '`');
  }
  const upstreamKeys = Object.entries({ ...(meta.dropped ?? {}), ...(meta.kept ?? {}) });
  if (upstreamKeys.length > 0) {
    // Fidelity: those fields are KEPT in the frontmatter above (DSH ignores keys it does not
    // know), so this note explains rather than replaces them.
    lines.push(`> - frontmatter 里的 ${upstreamKeys.map(([key]) => '`' + key + '`').join('、')} 是上游字段，DSH 原样保留但不读取：`
      + '工具可用性由会话权限决定，技能不能固定模型，子代理的模型在 `subagent`/`workflow` 调用处指定。');
  }
  // No provenance line: PORT-MANIFEST.json already records the source path for every
  // output file, and an end user opening a skill card does not need the port's history.
  return [HEADER_BEGIN, ...lines, HEADER_END, ''].join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isTextFile(path) {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? false : TEXT_EXT.has(name.slice(dot));
}

/** Split a leading `---` frontmatter block from the body. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: undefined, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: undefined, body: text };
  const close = text.indexOf('\n', end + 1);
  const blockEnd = close === -1 ? text.length : close + 1;
  return {
    frontmatter: text.slice(text.indexOf('\n', 3) + 1, end),
    body: text.slice(blockEnd),
  };
}

function rewriteFrontmatter(frontmatter) {
  if (frontmatter === undefined) return { frontmatter: undefined, dropped: {}, kept: {} };
  const dropped = {};
  const kept = {};
  const lines = [];
  for (const line of frontmatter.split('\n')) {
    const m = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*)(.*)$/.exec(line);
    if (m === null) {
      lines.push(line);
      continue;
    }
    const [, indent, key, sep, value] = m;
    // Fidelity: the upstream card's own frontmatter fields are KEPT, not dropped. DSH's skill
    // parser reads only the keys it knows (`name`, `description`, `whenToUse`, the invocation
    // policy, `metadata`) and ignores the rest — verified in dsh-skill-filesystem's
    // `parseSkillFile`, which fails only on broken YAML or a missing name/description — so an
    // unknown key is inert rather than an error. Keeping them means the port matches upstream's
    // frontmatter contract (which every spec's first static assertion checks) instead of
    // failing that assertion on all 74 skills.
    if (DROPPED_FRONTMATTER_KEYS.has(key)) dropped[key] = value.trim();
    if (key === 'model') kept.model = value.trim();
    if (FRONTMATTER_TOOL_KEYS.has(key) || DROPPED_FRONTMATTER_KEYS.has(key)) {
      lines.push(`${indent}${key}${sep}${value.replace(/[A-Za-z][A-Za-z-]*/g, (token) => {
        const mapped = CASED_TOOLS.get(token) ?? DISTINCTIVE_TOOLS.get(token);
        return mapped ?? token;
      })}`);
      continue;
    }
    lines.push(line);
  }
  return { frontmatter: lines.join('\n'), dropped, kept };
}

/**
 * Turn a Claude Code pre-execute line (`!`cmd``) into an explicit instruction.
 * DSH injects a skill body verbatim and never runs it, so the command has to be
 * something the model is told to run itself.
 */
function convertPreExecuteLines(text) {
  return text.replace(/^([ \t]*)!\s*`([^`\n]+)`[ \t]*$/gm, (whole, indent, command) => {
    const isConfig = command.startsWith('node tools/yaml-helper.mjs');
    const isNode = /^node\s/.test(command);
    // A `node …` command runs under pwsh (there is no bash here); only genuine POSIX
    // commands keep a shell label, and they get the Git-Bash caveat instead.
    const fence = isConfig || isNode ? 'pwsh' : 'bash';
    const note = isConfig
      ? '把输出当作已解析的项目配置使用；没有输出块时按 `.dsh/docs/config-resolution.md` 的默认值处理。'
      : isNode
        ? '直接运行（DSH 里有 node，不需要、也不要用 bash）。'
        : `用 Git Bash 运行（Windows 上显式使用 \`${BASH.replaceAll('"', '')}\`），或改写成等价的 pwsh 命令；输出作为下文上下文。`;
    return [
      `${indent}**前置命令（DSH 不会预执行技能里的 \`!\` 命令，需要你自己运行它）**`,
      '',
      `${indent}\`\`\`${fence}`,
      `${indent}${command}`,
      `${indent}\`\`\``,
      '',
      `${indent}${note}`,
    ].join('\n');
  });
}


/** Content kinds that ship to end users and must therefore read as DSGS's own product. */
const SHIPS_TO_USERS = new Set(['skill', 'skill-reference', 'agent', 'rule', 'doc']);

/**
 * Documents that describe a mechanism only the upstream runtime has. Their content is
 * ported verbatim (full replication), but a reader must be told that DSH does it
 * differently — the mapping lives in `.dsh/docs/dsh-differences.md`.
 */
const UPSTREAM_ONLY_DOCS = new Set([
  'docs/setup-requirements.md',
  'docs/model-tiers.md',
  'docs/agent-teams.md',
  'docs/hooks-reference.md',
  'docs/hooks-reference/hook-input-schemas.md',
  'docs/local-instructions-template.md',
  'docs/settings-local-template.md',
]);

/** One-line banner inserted under a document's title when its mechanism is upstream-only. */
const UPSTREAM_DOC_BANNER =
  '> **上游机制说明**：本文描述的是上游运行时的做法；DSH 的等价做法见 '
  + '[`dsh-differences.md`](dsh-differences.md)。';

/** Insert `banner` after the document's first heading line (or at the top when it has none). */
function bannerUnderTitle(text, banner) {
  const lines = text.split('\n');
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (titleIndex === -1) return `${banner}\n\n${text}`;
  return [...lines.slice(0, titleIndex + 1), '', banner, ...lines.slice(titleIndex + 1)].join('\n');
}

/**
 * Runtime-neutral prose. Ordinary users open skill cards, role cards, rules and the
 * reference docs, and none of them should read as a wrapper around somebody else's
 * product. Real identifiers of the other runtime (env var names, install URLs, the npm
 * package, the hook-protocol package we bridge) are deliberately left alone — rewriting
 * an identifier would make the document wrong rather than neutral.
 * @param {string} text - generated content
 * @returns {string} the same text with the other runtime's name replaced
 */
function neutralizeRuntime(text) {
  return text
    // Instruction file: DSH's is AGENTS.md, which carries the engine anchor /setup-engine writes.
    .replace(/CLAUDE-local-template\.md/gi, 'local-instructions-template.md')
    .replace(/CLAUDE\.local\.md/gi, 'local overrides file')
    .replace(/CLAUDE\.md/g, 'AGENTS.md')
    .replace(/a fresh Claude Code session/g, 'a fresh session')
    .replace(/independent Claude session/g, 'independent session')
    .replace(/Claude\s+Code session/g, 'session')
    .replace(/Claude-evaluated/g, 'model-judged')
    // Whitespace-tolerant: upstream prose wraps the phrase across lines ("…which Claude\nCode loads…").
    .replace(/Claude\s+Code/g, '上游运行时')
    .replace(/Claude's/g, "the agent's")
    .replace(/\bClaude\b/g, 'the agent')
    // Environment variables of the other runtime have no DSH equivalent; name the concept
    // instead of inventing a variable that nothing sets.
    .replace(/\$\{CLAUDE_PROJECT_DIR:-\.\}/g, '<project root>')
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, '<launch dir>');
    // Template-origin check compares a `git remote` URL against the upstream repository slug.
    // The slug is KEPT: it is a factual provenance marker (which template you cloned from), not
    // a product name presented as ours, and the upstream spec's Case 4 asserts the literal — the
    // brand rules below cover the words `Claude Code Game Studios` and `CCGS` instead.
}

/**
 * POSIX one-liners the port must translate: the skill text is executed by the model in a DSH
 * session, where the shell is pwsh and Git Bash cannot start. Script *invocations* were already
 * translated (`.sh` → `.mjs`); these are the inline commands that were left behind, found by the
 * spec sweep (`wc -c` was verified failing with "术语 'wc' 不会被识别").
 *
 * Each rule keeps the original intent, and `tools/check-dsh.mjs` re-scans the generated tree for
 * POSIX-only invocations so a new one cannot slip in silently.
 */
const POSIX_REWRITES = [
  // `wc -c <path>` — file size. Also covers the frontmatter grant `pwsh(wc -c *)`.
  [/wc -c (\*|"[^"]*"|'[^']*'|[^\s`)]+)/g, '(Get-Item $1).Length'],
  // `rm -f <path>` → Remove-Item -Force <path>
  [/\brm -f ([^\s`)]+)/g, 'Remove-Item -Force $1'],
  // `mkdir -p <dir> && printf '%s' "<text>" > <file>` → pwsh equivalent (no trailing newline)
  [/mkdir -p ([^\s&]+)\s*&&\s*printf '%s' "([^"]*)"\s*>\s*([^\s`]+)/g,
    "New-Item -ItemType Directory -Force $1 | Out-Null; Set-Content -NoNewline $3 '$2'"],
  // `grep -q '<pat>' <file> && echo X || echo Y` → a pwsh conditional with the same two outcomes
  [/grep -q ('[^']*'|"[^"]*") (\S+) && echo (\S+) \|\| echo (\S+)/g,
    "if (Select-String -Quiet -Pattern $1 -Path $2) { '$3' } else { '$4' }"],
  // Remaining `grep -q '<pat>' <file>` → Select-String -Quiet
  [/grep -q ('[^']*'|"[^"]*") (\S+)/g, 'Select-String -Quiet -Pattern $1 -Path $2'],
  // `grep -B<n> <pat> <file> | grep -E <pat2>` → the same two-stage filter in pwsh
  [/grep -B(\d+) ('[^']*'|"[^"]*") (\S+) \| grep -E ('[^']*'|"[^"]*")/g,
    "Select-String -Path $3 -Pattern $2 -Context $1,0 | ForEach-Object { $_.Context.PreContext } | Select-String -Pattern $4"],
  // `grep [-E] <pat> <file>` → Select-String -Pattern <pat> -Path <file>
  [/grep -E ('[^']*'|"[^"]*") (\S+)/g, 'Select-String -Pattern $1 -Path $2'],
  // A grep stage inside a pipeline reads its input from stdin, which is how Select-String behaves too.
  [/\|\s*grep ('[^']*'|"[^"]*")/g, '| Select-String -Pattern $1'],
  // `sort -u` → Sort-Object -Unique
  [/\bsort -u\b/g, 'Sort-Object -Unique'],
  // A `.sh:NN` citation (a line reference into a ported script) follows the same port as a bare mention.
  [/([\w.-]+)\.sh:(\d+)/g, '$1.mjs:$2'],
  // Bash-internal helper names. The Node port implements the same tables without those function
  // names, so a reader who greps for them finds nothing; name what actually holds the data.
  [/_yaml_helper_defaults\b/g, 'the defaults table in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_rigor_expansion\b/g, 'the rigor expansion table in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_locally_overridable\b/g, 'the locally-overridable key list in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_enums\b/g, 'the enum table in `tools/yaml-helper.mjs`'],
];

/** Apply every DSH rewrite to a text file body. */
async function rewriteText(text, kind, rel) {
  let out = text;

  // End users must never meet the other runtime in generated prose. This runs on the
  // surfaces a normal user actually reads — skill cards, role cards, rules — and NOT on
  // maintainer documents (docs/hooks/scripts), where the porting facts must stay true
  // (the bridge package name, `.claude/` as the content source, the import merge).
  if (SHIPS_TO_USERS.has(kind)) {
    out = neutralizeRuntime(out);
    for (const [pattern, replacement] of POSIX_REWRITES) out = out.replace(pattern, replacement);
  }
  // Every document under `docs/hooks-reference/` describes an upstream BASH hook implementation.
  // It gets the banner (and the POSIX scan in check-dsh exempts it) rather than having its
  // examples rewritten: the examples ARE the subject matter.
  if (rel.startsWith('docs/hooks-reference/')) out = bannerUnderTitle(out, UPSTREAM_DOC_BANNER);
  if (UPSTREAM_ONLY_DOCS.has(rel)) out = bannerUnderTitle(out, UPSTREAM_DOC_BANNER);

  // The studio's own name. `.claude/**` is upstream content (kept byte-identical for
  // clean `git pull`), so the brand is applied HERE, while generating: the DSH side
  // reads "DeepSeek Game Studios" everywhere without forking upstream's prose. Only the
  // brand changes — references to the Claude Code *product* (the `.claude/` stack, the
  // hooks protocol we bridge, `$CLAUDE_PROJECT_DIR`) stay factual.
  // NOTE: the two lines below name the OLD brand on purpose — they ARE the mapping.
  out = out.replace(/Claude Code Game Studios/g, 'DeepSeek Game Studios');
  out = out.replace(/\bCCGS\b/g, 'DSGS');

  // `${CLAUDE_SKILL_DIR}/../..` is the project root for a skill at `.dsh/skills/<name>`.
  out = out.replace(/\$\{?CLAUDE_SKILL_DIR\}?\s*\/\s*\.\.\s*\/\s*\.\./g, '.dsh');
  out = out.replace(/\$\{?CLAUDE_SKILL_DIR\}?/g, '<skill_dir>');

  // Framework asset paths: `.claude/...` -> `.dsh/...` (never touches "Claude Code").
  out = out.replace(/\.claude\b/g, '.dsh');

  // Distinctive Claude tool names are unambiguous anywhere.
  for (const [from, to] of DISTINCTIVE_TOOLS) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  // Ambiguous names: only inside backticks, and only when they look like tool references.
  // `Task` is excluded: it collides with the C# type. The spec sweep caught the port rewriting
  // `Return \`Task\` for testable async methods` into `Return \`subagent\`` and `\`Task.Run\``
  // into `\`subagent.Run\`` in the Godot C# specialist. The unambiguous agent-tool contexts
  // ("the Task tool", `Task:`) are still mapped by the explicit patterns below.
  out = out.replace(/`([^`\n]{1,60})`/g, (whole, inner) => {
    if (!/[A-Za-z]/.test(inner)) return whole;
    const mapped = inner.replace(/\b[A-Za-z][A-Za-z-]*\b/g, (token) => {
      if (token === 'Task') return token;
      const to = CASED_TOOLS.get(token);
      return to ?? token;
    });
    return `\`${mapped}\``;
  });

  // "the Bash tool", "the Agent tool", "Write/Edit tools" in plain prose.
  out = out.replace(/\b(the\s+)?(Read|Write|Edit|Grep|Glob|Bash|PowerShell|Agent|Task)\s+(tool|tools)\b/g,
    (whole, article, token, noun) => `${article ?? ''}${CASED_TOOLS.get(token)} ${noun}`);
  out = out.replace(/\b(Read|Write|Edit|Grep|Glob)\/(Read|Write|Edit|Grep|Glob)(\/[A-Za-z]+)?\b/g,
    (whole) => whole.split('/').map((t) => CASED_TOOLS.get(t) ?? t).join('/'));

  // Tool-call examples written as `Bash: <command>` / `Read:` / `Glob:` — DSGS's way of
  // showing which tool a step uses. DSH has no `Bash` tool, so the label must be real.
  out = out.replace(/\b(Bash|PowerShell|Read|Write|Edit|Grep|Glob|Agent|Task)(:)/g,
    (whole, token, colon) => `${CASED_TOOLS.get(token) ?? token}${colon}`);

  // DSGS names Claude Code's `subagent_type:` parameter. DSH has no such parameter:
  // a delegation passes the role card. Rewrite the parameter into the card reference.
  // The "Spawn `subagent_type: X` with:" shorthand gets a sentence that reads correctly.
  out = out.replace(/Spawn\s+`subagent_type:\s*([^`]+)`\s+with:/g, (_m, name) => (
    /[[\] ]/.test(name)
      ? 'Spawn a subagent with the matching role card under `.dsh/agents/` (convention: `.dsh/agents/README.md`) and:'
      : `Spawn a subagent with the \`${name}\` role card (\`.dsh/agents/${name}.md\`, convention: \`.dsh/agents/README.md\`) and:`
  ));
  out = out.replace(/^(\s*[-*]\s+)`subagent_type:\s*([^`]+)`/gm, (_m, bullet, name) => (
    /[[\] ]/.test(name)
      ? `${bullet}\`${name}\`（对应角色卡，见 \`.dsh/agents/\`）`
      : `${bullet}\`${name}\`（角色卡 \`.dsh/agents/${name}.md\`）`
  ));
  out = out.replace(/`subagent_type:\s*([^`]+)`/g, (_m, name) => (
    /[[\] ]/.test(name)
      ? `${name} 对应的角色卡（见 \`.dsh/agents/\`）`
      : `${name} 的角色卡 \`.dsh/agents/${name}.md\``
  ));
  out = out.replace(/\bsubagent_type:\s*/g, '');

  if (kind === 'skill' || kind === 'agent') {
    const { frontmatter, body } = splitFrontmatter(out);
    const { frontmatter: fm, dropped, kept } = rewriteFrontmatter(frontmatter);
    const head = fm === undefined ? '' : `---\n${fm}\n---\n`;
    out = `${head}${headerFor(kind, rel, { dropped, kept })}\n${body.replace(/^\n+/, '')}`;
  }

  // Per-skill DSH notes (`dsh-src/skill-notes/<skill>.md`) are injected right after the
  // generated header: they carry DSH-only operational knowledge that has no place in the
  // shared `.claude/` source (Windows quirks, sandbox constraints, generated-file traps).
  if (rel.startsWith('skills/')) {
    const skillName = rel.split('/')[1];
    const notePath = join(ROOT, OVERLAY_DIR, 'skill-notes', `${skillName}.md`);
    if (skillName !== undefined && existsSync(notePath)) {
      const note = (await readFile(notePath, 'utf8')).replace(/\.claude\b/g, '.dsh').trimEnd();
      const marker = HEADER_END;
      const at = out.indexOf(marker);
      out = at === -1
        ? `${note}\n\n${out}`
        : `${out.slice(0, at + marker.length)}\n\n${note}\n${out.slice(at + marker.length)}`;
    }
  }

  if (rel.endsWith('.md')) {
    // Config resolution is DSH-native Node now; the bash+Python helper stays for hooks.
    out = out.replace(/bash\s+"?[^\s"]*yaml-helper\.sh"?/g, 'node tools/yaml-helper.mjs');

    // Skills that `source` the bash helper (settings, perf-profile) cannot do that in
    // DSH: there is no bash, and the helper's functions are reachable through `__call`.
    // Each following bare function call becomes the equivalent CLI invocation.
    if (kind === 'skill' || kind === 'agent') {
      const HELPER_FNS = [
        'get_yaml_key', 'get_yaml_array', 'get_yaml_child_keys',
        'get_effective_yaml_key', 'get_effective_yaml_array', 'get_yaml_default', 'get_legacy_key',
        'validate_yaml_enum', 'validate_local_yaml_base', 'validate_local_scope', 'validate_enum_value',
        'is_locally_overridable', 'is_always_ask_category', 'session_state_enabled',
        'log_decision', 'resolve_setting', 'resolve_code_root', 'hook_warn',
      ].join('|');
      out = out.replace(/^[ \t]*source[ \t]+"?[^"\n]*yaml-helper\.sh"?[^\n]*$/gm,
        '# DSH 没有 bash 可以 source：下面每个函数调用都改用 node tools/yaml-helper.mjs __call <函数> <参数>');
      out = out.replace(new RegExp(`^([ \\t]*)(${HELPER_FNS})\\b`, 'gm'),
        '$1node tools/yaml-helper.mjs __call $2');
      out = out.replace(/Source it once via pwsh:/g,
        '在 DSH 里没有 bash 可以 source；改为直接调用 Node 解析器 `node tools/yaml-helper.mjs __call <函数> [参数]`：');
      out = out.replace(/`yaml-helper\.sh`/g, '`tools/yaml-helper.mjs`');
      out = out.replace(/\.dsh\/hooks\/yaml-helper\.sh/g, 'tools/yaml-helper.mjs');
      out = out.replace(/\/\.dsh\/hooks\/yaml-helper\.sh/g, 'tools/yaml-helper.mjs');
    }

    // Helper scripts with a Node port are called through Node; the rest still need
    // a shell that understands them.
    out = out.replace(/(^|[\s(`])bash\s+"?\.dsh\/(scripts|hooks)\/([\w.-]+)\.sh"?/g,
      (_whole, pre, dir, file) => (dir === 'scripts' && SCRIPT_PORTS.has(file)
        ? `${pre}node ".dsh/scripts/${file}.mjs"`
        : `${pre}${BASH} ".dsh/${dir}/${file}.sh"`));
    // Bare mentions of the file name (prose, tables, "printed by …") move to the port too,
    // otherwise the text names a file that no longer exists on the DSH side.
    out = out.replace(/\.dsh\/(scripts|hooks)\/([\w.-]+)\.sh/g,
      (whole, dir, name) => (dir === 'scripts' && SCRIPT_PORTS.has(name)
        ? `.dsh/scripts/${name}.mjs`
        : whole));
    // Relative forms of the same call (`<skill_dir>/../../scripts/<name>.sh`) resolve to the
    // same ports; without this the text keeps a `.sh` name that has no DSH-side file.
    out = out.replace(/((?:\.\.\/)+)((?:scripts|hooks)\/([\w.-]+))\.sh/g,
      (whole, ups, dirFile, name) => (dirFile.startsWith('scripts/') && SCRIPT_PORTS.has(name)
        ? `${ups}scripts/${name}.mjs`
        : whole));
    // A fenced block whose every command is already a `node …` call runs under pwsh in
    // DSH, not bash; the label is what a reader (or the model) trusts first.
    out = out.replace(/```(?:bash|sh)\n([\s\S]*?)```/g, (whole, body) => {
      const commands = body.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      return commands.length > 0 && commands.every((line) => /^node\s/.test(line))
        ? `\`\`\`pwsh\n${body}\`\`\``
        : whole;
    });

    out = convertPreExecuteLines(out);
  }

  return out;
}

/**
 * DSH does not interpret `@path` imports in instruction files (`dsh-agent-instructions`
 * documents this as intentional: "lowercase names, .claude/rules/, and @path imports are
 * not interpreted"). DSGS's CLAUDE.md pulls its shared studio rules in that way, so the
 * DSH side needs the merged text: every `@file` line is inlined into one document that
 * AGENTS.md tells the agent to read.
 */
async function claudeImports() {
  const claudeMd = join(ROOT, 'CLAUDE.md');
  if (!existsSync(claudeMd)) return undefined;
  const text = await readFile(claudeMd, 'utf8');
  const imports = [];
  for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
    const rel = m[1];
    if (rel.startsWith('@') || imports.includes(rel)) continue;
    imports.push(rel);
  }
  if (imports.length === 0) return undefined;
  // Section headings come from each imported document's own title, not from its source
  // path: this file is recommended reading for users, and a table of `.claude/docs/...`
  // paths tells them nothing. Provenance stays in PORT-MANIFEST.json.
  const titles = new Map();
  for (const rel of imports) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const body = (await readFile(abs, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '');
    const heading = /^#\s+(.+)$/m.exec(body);
    titles.set(rel, heading === null ? rel.replace(/^\.claude\//, '') : heading[1].trim());
  }
  const sections = [
    '# 工作室共享规则（DSH 合并版）',
    '',
    'DSH 的 `dsh-agent-instructions` **不解释 `@path` 导入**（官方文档明确说明这一行为是有意的），',
    '所以内容源里用 `@` 拉进来的共享规则在 DSH 会话里不会自动加载。',
    '本文件由 `tools/build-dsh.mjs` 生成：把那些导入的原文按顺序合并，供 `AGENTS.md` 指引用。',
    '',
    `来源：项目指令文件 → ${imports.map((i) => `\`${titles.get(i) ?? i}\``).join('、')}`,
    '',
  ];
  for (const rel of imports) {
    const abs = join(ROOT, rel);
    sections.push('---', '', `## ${titles.get(rel) ?? rel}`, '');
    if (!existsSync(abs)) {
      sections.push(`> 警告：\`${rel}\` 不存在（共享规则的导入源指向了缺失文件）。`, '');
      continue;
    }
    const body = (await readFile(abs, 'utf8')).trimEnd();
    // The merged imports are prose copied straight out of the content source, so they need
    // the same treatment as any other generated file: brand, asset paths, and the
    // runtime-neutral wording — otherwise this document is the one place a user still reads
    // the other runtime's name and `.claude/...` paths.
    const branded = neutralizeRuntime(
      body
        .replace(/Claude Code Game Studios/g, 'DeepSeek Game Studios')
        .replace(/\bCCGS\b/g, 'DSGS')
        .replace(/\.claude\b/g, '.dsh'),
    )
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .trimStart();
    sections.push(branded, '');
  }
  return { text: sections.join('\n'), imports };
}

/**
 * Hook matchers name tools. Claude Code spells them `Bash|PowerShell` / `Write|Edit`;
 * DSH's tool events carry its own lowercase tool names, and the protocol's
 * claude-code dialect exact-matches pipe-separated literals — so a matcher left in
 * Claude spelling NEVER selects a DSH tool call. Translate, and keep `bash` alongside
 * `pwsh` because a profile may expose either shell tool.
 */
function dshMatcher(matcher) {
  if (typeof matcher !== 'string') return matcher;
  const trimmed = matcher.trim();
  if (trimmed === '' || trimmed === '*') return matcher;
  const alternatives = trimmed.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
  const mapped = [];
  for (const alternative of alternatives) {
    const tool = CASED_TOOLS.get(alternative) ?? alternative;
    if (!mapped.includes(tool)) mapped.push(tool);
    if ((alternative === 'Bash' || alternative === 'PowerShell') && !mapped.includes('bash')) {
      mapped.push('bash');
    }
  }
  return mapped.join('|');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Read the `paths:` glob list from a rule file's frontmatter. */
function rulePaths(frontmatter) {
  const paths = [];
  if (frontmatter === undefined) return paths;
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
  return paths;
}

/**
 * DSH has no path-scoped rule engine, so the rules are wired by an explicit index
 * plus the instruction in AGENTS.md to read the matching rule before an edit.
 */
async function rulesIndex() {
  const rulesDir = join(SRC_ROOT, 'rules');
  if (!existsSync(rulesDir)) return undefined;
  const files = (await readdir(rulesDir)).filter((f) => f.endsWith('.md')).sort();
  const lines = [
    '# 路径规则索引（由 tools/build-dsh.mjs 生成）',
    '',
    '上游运行时用规则文件的 `paths:` frontmatter 自动施加这些标准；DSH 没有该机制，',
    '因此改由本索引 + `AGENTS.md` 的约定落实：**在编辑匹配路径的文件之前，先读对应规则文件。**',
    '',
    '| 规则文件 | 适用路径 |',
    '| --- | --- |',
  ];
  for (const file of files) {
    const { frontmatter } = splitFrontmatter(await readFile(join(rulesDir, file), 'utf8'));
    const paths = rulePaths(frontmatter).map((p) => p.replace(/\.claude\b/g, '.dsh'));
    lines.push(`| \`.dsh/rules/${file}\` | ${paths.length > 0 ? paths.map((p) => `\`${p}\``).join('<br>') : '（未声明路径）'} |`);
  }
  lines.push('');
  return lines.join('\n');
}


function kindFor(rel) {
  // Anything under a skill directory is user-visible (SKILL.md plus its references/),
  // so reference files get the same runtime-neutral treatment as the card itself.
  if (rel.startsWith('skills/')) return rel.endsWith('SKILL.md') ? 'skill' : 'skill-reference';
  if (rel.startsWith('agents/')) return 'agent';
  if (rel.startsWith('rules/')) return 'rule';
  // Reference documents ship to users as well, so they get the runtime-neutral treatment.
  if (rel.startsWith('docs/')) return 'doc';
  if (rel.startsWith('hooks/')) return 'hook';
  if (rel === 'statusline.sh') return 'script';
  return 'other';
}

async function convert() {
  const manifest = [];
  let written = 0;
  let changed = 0;

  if (!DRY_RUN) {
    for (const dir of MIRRORED_DIRS) {
      await rm(join(OUT_ROOT, dir), { recursive: true, force: true });
    }
    await rm(join(OUT_ROOT, 'statusline.sh'), { force: true });
  }

  const files = [];
  for (const dir of MIRRORED_DIRS) {
    const abs = join(SRC_ROOT, dir);
    if (existsSync(abs)) files.push(...(await walk(abs)));
  }
  const statusline = join(SRC_ROOT, 'statusline.sh');
  if (existsSync(statusline)) files.push(statusline);

  for (const file of files) {
    const rel = relative(SRC_ROOT, file).split('\\').join('/');
    const outRel = OUTPUT_RENAMES.get(rel) ?? rel;
    const target = join(OUT_ROOT, outRel);
    const raw = await readFile(file, 'utf8');
    const kind = kindFor(rel);
    const output = isTextFile(file) ? await rewriteText(raw, kind, outRel) : raw;

    if (DRY_RUN) {
      if (!existsSync(target) || (await readFile(target, 'utf8')) !== output) changed += 1;
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output, 'utf8');
      written += 1;
    }
    manifest.push({
      kind,
      source: OUTPUT_RENAMES.get(rel) ?? rel,
      output: `.dsh/${outRel}`,
      // Fidelity record: the card's original frontmatter, verbatim, so a consumer can
      // recover every upstream field even though the DSH frontmatter keeps only the ones
      // DSH understands.
      upstreamFrontmatter: splitFrontmatter(raw).frontmatter?.trim(),
      sourceSha256: sha256(raw).slice(0, 16),
      outputSha256: sha256(output).slice(0, 16),
      rewritten: output !== raw,
    });
  }

  // Hand-written DSH-only assets, copied over the derived tree (no generated header:
  // these files are source, not derived).
  const overlay = join(ROOT, OVERLAY_DIR);
  const overlayFiles = [];
  if (existsSync(overlay)) overlayFiles.push(...(await walk(overlay)));
  for (const file of overlayFiles) {
    const rel = relative(overlay, file).split('\\').join('/');
    const target = join(OUT_ROOT, rel);
    const raw = await readFile(file, 'utf8');
    const output = isTextFile(file)
      ? raw.replace(/\.claude\b/g, '.dsh')
      : raw;
    if (!DRY_RUN) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output, 'utf8');
      written += 1;
    }
    manifest.push({
      kind: 'overlay',
      source: `${OVERLAY_DIR}/${rel}`,
      output: `.dsh/${rel}`,
      sourceSha256: sha256(raw).slice(0, 16),
      outputSha256: sha256(output).slice(0, 16),
      rewritten: output !== raw,
    });
  }

  // Rules index — DSH has no path-scoped rule engine, so the mapping is explicit.
  const index = await rulesIndex();
  if (index !== undefined && !DRY_RUN) {
    await mkdir(join(OUT_ROOT, 'rules'), { recursive: true });
    await writeFile(join(OUT_ROOT, 'rules', 'INDEX.md'), index, 'utf8');
    written += 1;
  }

  // CLAUDE.md's `@` imports, merged — DSH does not expand them.
  const imports = await claudeImports();
  if (imports !== undefined && !DRY_RUN) {
    await mkdir(join(OUT_ROOT, 'docs'), { recursive: true });
    await writeFile(join(OUT_ROOT, 'docs', 'studio-rules.md'), `${imports.text}\n`, 'utf8');
    written += 1;
  }

  // Hooks config for @deepseek-ai/dsh-hooks-claude-code, derived from .claude/settings.json.
  const settingsPath = join(SRC_ROOT, 'settings.json');
  let hooksNote = 'no .claude/settings.json found';
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    const rootPosix = ROOT.split('\\').join('/');
    const portedDir = join(ROOT, OVERLAY_DIR, 'hooks');
    const hooks = {};
    const pending = [];
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      const keptGroups = [];
      for (const group of groups) {
        const keptHooks = [];
        for (const hook of group.hooks ?? []) {
          const match = /([\w.-]+)\.sh/.exec(String(hook.command ?? ''));
          if (match === null) continue;
          const base = match[1];
          // Only hooks with a Node port are enabled: the bash originals cannot run
          // inside the DSH sandbox (no Git Bash, no piped stdio).
          if (!existsSync(join(portedDir, `${base}.mjs`))) {
            pending.push(`${base} (${event})`);
            continue;
          }
          // Relative command: the hook process starts in the session workspace, and every
          // Node hook re-resolves the project root itself. An absolute path here would
          // make a *copy* of the tree fire hooks against the original repository.
          keptHooks.push({ ...hook, command: `node ".dsh/hooks/${base}.mjs"` });
        }
        if (keptHooks.length > 0) keptGroups.push({ ...group, matcher: dshMatcher(group.matcher), hooks: keptHooks });
      }
      if (keptGroups.length > 0) hooks[event] = keptGroups;
    }

    // DSH-only hooks: mechanisms DSH does not have (path-scoped rules) are replaced by
    // hooks here rather than by prose, so they are merged in instead of derived.
    const extraHooksPath = join(portedDir, 'dsh-hooks.json');
    const extraNames = [];
    if (existsSync(extraHooksPath)) {
      const extra = JSON.parse(await readFile(extraHooksPath, 'utf8'));
      for (const [event, groups] of Object.entries(extra)) {
        if (event.startsWith('$')) continue;
        hooks[event] = [...(hooks[event] ?? []), ...groups];
        for (const group of groups) {
          for (const hook of group.hooks ?? []) {
            const name = /([\w.-]+)\.mjs/.exec(String(hook.command ?? ''));
            if (name !== null) extraNames.push(name[1]);
          }
        }
      }
    }
    const payload = {
      $comment: [
        'Generated by tools/build-dsh.mjs from the content source\'s hook settings.',
        'Consumed by @deepseek-ai/dsh-hooks-claude-code (configPath in the dsh profile patch).',
        'Only hooks with a Node port under dsh-src/hooks/ are enabled; the bash originals',
        'cannot run inside the DSH sandbox (Git Bash fails to start, piped stdio is denied).',
        'Commands are project-relative on purpose: the hook process starts in the session',
        'workspace and each hook resolves its own project root, so a copy of this tree does',
        'not fire hooks against the repository it was copied from.',
      ],
      ...pending.length > 0 ? { $pendingPorts: pending } : {},
      hooks,
    };
    if (!DRY_RUN) {
      await mkdir(OUT_ROOT, { recursive: true });
      await writeFile(join(OUT_ROOT, 'hooks.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    const enabled = Object.values(hooks).flat().reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
    hooksNote = `${enabled} enabled (${extraNames.length} DSH-only: ${extraNames.join(', ') || 'none'}), `
      + `${pending.length} pending port (${Object.keys(hooks).length} events)`;
  }

  if (!DRY_RUN) {
    const summary = {
      generatedBy: 'tools/build-dsh.mjs',
      generatedAt: new Date().toISOString(),
      // Brand-free on purpose: this manifest ships inside .dsh/, and the content tree it
      // mirrors is documented in AGENTS.md ("目录契约") rather than named 285 times here.
      generatedFrom: 'content-source',
      output: '.dsh',
      fileCount: manifest.length,
      files: manifest,
    };
    await mkdir(OUT_ROOT, { recursive: true });
    await writeFile(join(OUT_ROOT, 'PORT-MANIFEST.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  const rewrites = manifest.filter((entry) => entry.rewritten).length;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}files=${manifest.length} rewritten=${rewrites} `
    + `skills=${manifest.filter((e) => e.kind === 'skill').length} `
    + `agents=${manifest.filter((e) => e.kind === 'agent').length} `
    + `rules=${manifest.filter((e) => e.kind === 'rule').length} `
    + `hooks=${manifest.filter((e) => e.kind === 'hook').length}`);
  console.log(`hooks.json: ${hooksNote}`);
  console.log(imports === undefined
    ? 'studio-rules.md: no @ imports found in CLAUDE.md'
    : `studio-rules.md: merged ${imports.imports.length} @ import(s) from CLAUDE.md`);
  if (DRY_RUN) console.log(`would change ${changed} file(s)`);
  else console.log(`wrote ${written} file(s) under ${relative(ROOT, OUT_ROOT) || '.dsh'}`);
}

await convert();




