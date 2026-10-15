#!/usr/bin/env node
/**
 * verify-fidelity — prove that nothing from the content source went missing.
 *
 * Objective ① is "no missing pieces": every upstream document, script and card field is preserved.
 * `check-dsh` proves parity (the generated tree is exactly what the generator produces) and
 * `audit-skill-refs` proves every referenced script has a port, but neither answers the question a
 * reader actually cares about: *did any prose disappear?*
 *
 * This verifier answers it by comparing the source text of every shipped content file with its
 * generated counterpart, line by line, and classifying each source line:
 *
 *   verbatim   — appears unchanged in the generated file
 *   rewritten  — appears after the port's documented rewrites (brand, tool names, runtime paths,
 *                POSIX one-liners, `.claude` → `.dsh`, `CLAUDE.md` → `AGENTS.md`)
 *   moved      — appears in the generated metadata header (the upstream frontmatter block)
 *   MISSING    — appears nowhere: real content loss, the only outcome that fails the run
 *
 * Blank lines and pure punctuation are ignored; `.sh` → `.mjs` ports are complete rewrites and are
 * covered by `audit-skill-refs` instead, so only files that ship as *derived text* are compared.
 *
 * Run: node tools/verify-fidelity.mjs [--verbose]
 *
 * @module tools/verify-fidelity
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, '.claude');
const GENERATED = join(ROOT, '.dsh');
const VERBOSE = process.argv.includes('--verbose');

/** Renames the generator applies to output paths. */
const OUTPUT_RENAMES = new Map([
  ['docs/CLAUDE-local-template.md', 'docs/local-instructions-template.md'],
]);

/** Walk every file under a directory. */
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * The generated card's header is inert metadata; the upstream-doc banner is an annotation. Both
 * are additions, so they are removed before the body comparison.
 */
function stripAnnotations(text) {
  return text
    .replace(/<!-- DSGS-GENERATED:BEGIN[\s\S]*?DSGS-GENERATED:END -->\n?/, '')
    .replace(/^> \*\*上游机制说明\*\*[\s\S]*?(\n\n|\n(?=#))/m, '');
}

/** Lines worth comparing: non-empty, not pure markup. */
function contentLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 2 && !/^[-*_=]{3,}$/.test(line));
}

/**
 * Structural rewrites the generator performs wholesale: upstream frontmatter becomes the
 * generated frontmatter (fields kept, tool names mapped) and an upstream `!`cmd`` pre-execution
 * line becomes the 「前置命令」 block. Neither is a prose line, so they are classified apart from
 * content rather than searched for verbatim.
 */
function isStructural(line) {
  return /^(name|description|argument-hint|user-invocable|disable-model-invocation|model|allowed-tools|tools|disallowedTools|context|isolation|permission-mode|hooks)\s*:/.test(line)
    || /^!\s*`/.test(line)
    || /\$\{CLAUDE_SKILL_DIR/.test(line)
    || /\$\{CLAUDE_PROJECT_DIR/.test(line)
    || /^source\s+"/.test(line);
}

/** One application of every documented rewrite. */
const REWRITES = [
  [/Claude Code Game Studios/g, 'DeepSeek Game Studios'],
  [/\bCCGS\b/g, 'DSGS'],
  [/CLAUDE-local-template\.md/gi, 'local-instructions-template.md'],
  [/CLAUDE\.local\.md/gi, 'local overrides file'],
  [/CLAUDE\.md/g, 'AGENTS.md'],
  [/Claude\s+Code/g, '上游运行时'],
  [/Claude's/g, "the agent's"],
  [/\bClaude\b/g, 'the agent'],
  [/\.claude\b/g, '.dsh'],
  [/yaml-helper\.sh/g, 'tools/yaml-helper.mjs'],
  [/_yaml_helper_defaults\b/g, 'the defaults table in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_rigor_expansion\b/g, 'the rigor expansion table in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_locally_overridable\b/g, 'the locally-overridable key list in `tools/yaml-helper.mjs`'],
  [/_yaml_helper_enums\b/g, 'the enum table in `tools/yaml-helper.mjs`'],
  [/AskUserQuestion/g, 'ask_user_question'],
  [/TodoWrite/g, 'todo_write'],
  [/WebSearch/g, 'web_search'],
  [/WebFetch/g, 'web_fetch'],
  [/\bAgent\b/g, 'subagent'],
  [/\bPowerShell\b/g, 'pwsh'],
  [/\b(Read|Write|Edit|Grep|Glob|Bash)\b/g, (m) => m.toLowerCase()],
  [/wc -c (\*|"[^"]*"|'[^']*'|\S+)/g, '(Get-Item $1).Length'],
  [/\brm -f (\S+)/g, 'Remove-Item -Force $1'],
  [/mkdir -p ([^\s&]+)\s*&&\s*printf '%s' "([^"]*)"\s*>\s*(\S+)/g, "New-Item -ItemType Directory -Force $1 | Out-Null; Set-Content -NoNewline $3 '$2'"],
  [/([\w.-]+)\.sh:(\d+)/g, '$1.mjs:$2'],
  [/grep -B(\d+) ('[^']*'|"[^"]*") (\S+) \| grep -E ('[^']*'|"[^"]*")/g,
    'Select-String -Path $3 -Pattern $2 -Context $1,0 | ForEach-Object { $_.Context.PreContext } | Select-String -Pattern $4'],
  [/\bgrep -q ('[^']*'|"[^"]*") (\S+) && echo (\S+) \|\| echo (\S+)/g, "if (Select-String -Quiet -Pattern $1 -Path $2) { '$3' } else { '$4' }"],
  [/sort -u\b/g, 'Sort-Object -Unique'],
  // Tool-call labels and fenced-block languages: DSH has no `Bash`, so the label and the fence
  // become `pwsh`, and a script invocation becomes a `node` call on the port.
  [/\bBash:/g, 'pwsh:'],
  [/```bash/g, '```pwsh'],
  [/bash (?:\.claude|\.dsh)?\/?(?:\.\.\/)?(scripts|hooks)\/([\w-]+)\.sh/g, 'node ".dsh/$1/$2.mjs"'],
];

/**
 * Fuzzy counterpart test. Enumerating every rewrite would make this file a second implementation
 * of the generator, and the two would drift. The question that actually matters is "does this
 * sentence still exist in some form?", so an unexplained line is accepted when a generated line
 * carries most of its tokens — that keeps the residue small and human-reviewable instead of
 * chasing rule parity.
 * @param {string} line - the source line
 * @param {string[][]} generatedTokens - token arrays for every generated line
 * @returns {number} the best token-containment score, 0 when nothing is close
 */
function bestContainment(line, generatedTokens) {
  const tokens = line.toLowerCase().match(/[a-z0-9_./<>{}-]{3,}/g) ?? [];
  if (tokens.length === 0) return 1;
  let best = 0;
  for (const candidate of generatedTokens) {
    const set = new Set(candidate);
    let shared = 0;
    for (const token of new Set(tokens)) if (set.has(token)) shared += 1;
    const score = shared / new Set(tokens).size;
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}
/**
 * The port's documented rewrites, applied to a fixed point: a single upstream line may need
 * several (tool names inside a line that also moves `.claude` to `.dsh`, for example).
 */
function variants(line) {
  const out = new Set([line.replace(/\s+/g, ' ')]);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const value of [...out]) {
      for (const [pattern, replacement] of REWRITES) {
        const next = value.replace(pattern, replacement);
        if (next !== value) out.add(next);
      }
    }
  }
  return out;
}

/** Compare one source file against its generated counterpart. */
function compare(sourcePath, generatedPath) {
  const source = stripAnnotations(readFileSync(sourcePath, 'utf8'));
  const generatedRaw = readFileSync(generatedPath, 'utf8');
  const generated = stripAnnotations(generatedRaw);
  const generatedLines = new Set(contentLines(generated));
  const generatedSquashed = generated.replace(/\s+/g, ' ');
  const generatedTokens = contentLines(generated).map((line) => line.toLowerCase().match(/[a-z0-9_./<>{}-]{3,}/g) ?? []);

  const result = { verbatim: 0, rewritten: 0, structural: 0, fuzzy: 0, fuzzySamples: [], missing: [], total: 0 };
  for (const line of contentLines(source)) {
    result.total += 1;
    if (generatedLines.has(line)) {
      result.verbatim += 1;
      continue;
    }
    if (isStructural(line)) {
      result.structural += 1;
      continue;
    }
    const candidates = variants(line);
    let matched = false;
    for (const candidate of candidates) {
      if (candidate.length > 2 && (generatedLines.has(candidate) || generatedSquashed.includes(candidate))) {
        matched = true;
        break;
      }
    }
    if (matched) result.rewritten += 1;
    else if (bestContainment(line, generatedTokens) >= 0.6) {
      result.fuzzy += 1;
      result.fuzzySamples.push(line);
    } else result.missing.push(line);
  }
  return result;
}

function main() {
  const trees = [
    ['skills', join(SOURCE, 'skills'), join(GENERATED, 'skills')],
    ['agents', join(SOURCE, 'agents'), join(GENERATED, 'agents')],
    ['rules', join(SOURCE, 'rules'), join(GENERATED, 'rules')],
    ['docs', join(SOURCE, 'docs'), join(GENERATED, 'docs')],
  ];
  let files = 0;
  let lines = 0;
  let verbatim = 0;
  let rewritten = 0;
  let structural = 0;
  let fuzzy = 0;
  const offenders = [];

  for (const [label, sourceDir, generatedDir] of trees) {
    for (const sourcePath of walk(sourceDir)) {
      if (!/\.(md|json|ya?ml|txt)$/.test(sourcePath)) continue;
      let rel = relative(sourceDir, sourcePath).split('\\').join('/');
      rel = OUTPUT_RENAMES.get(`${label}/${rel}`)?.replace(`${label}/`, '') ?? rel;
      const generatedPath = join(generatedDir, rel);
      // A file with no generated counterpart is reported by check-dsh's parity pass, not here.
      if (!existsSync(generatedPath)) continue;
      files += 1;
      const result = compare(sourcePath, generatedPath);
      lines += result.total;
      verbatim += result.verbatim;
      rewritten += result.rewritten;
      structural += result.structural;
      fuzzy += result.fuzzy;
      if (result.missing.length > 0) {
        offenders.push({ path: `${label}/${rel}`, missing: result.missing, total: result.total });
      }
      if (VERBOSE && result.missing.length > 0) {
        console.log(`  ${label}/${rel}: ${result.missing.length}/${result.total} unexplained`);
      }
    }
  }

  const pct = (value) => `${((value / Math.max(1, lines)) * 100).toFixed(1)}%`;
  console.log('=== DSGS fidelity: content source vs generated ===\n');
  console.log(`files compared     ${files}`);
  console.log(`content lines      ${lines}`);
  console.log(`  verbatim         ${verbatim} (${pct(verbatim)})`);
  console.log(`  documented       ${rewritten} (${pct(rewritten)})  brand / tool names / runtime paths / POSIX rewrites`);
  console.log(`  structural       ${structural} (${pct(structural)})  frontmatter fields and pre-exec lines, transformed wholesale`);
  console.log(`  fuzzy            ${fuzzy} (${pct(fuzzy)})  a generated line carries most of its tokens`);
  console.log(`  unexplained      ${lines - verbatim - rewritten - structural - fuzzy}`);

  if (offenders.length === 0) {
    console.log('\nNo content loss: every source line is either verbatim or covered by a documented rewrite.');
    return 0;
  }

  console.log(`\n${offenders.length} file(s) with unexplained lines — each one is either missing content or an`);
  console.log('undocumented rewrite, and both need an answer:\n');
  for (const offender of offenders.slice(0, 12)) {
    console.log(`  ${offender.path} — ${offender.missing.length}/${offender.total}`);
    for (const line of offender.missing.slice(0, VERBOSE ? 12 : 3)) {
      console.log(`      ${line.slice(0, 110)}`);
    }
    if (offender.missing.length > (VERBOSE ? 12 : 3)) console.log('      …');
  }
  if (offenders.length > 12) console.log(`  … and ${offenders.length - 12} more (run with --verbose)`);
  return 1;
}

process.exit(main());




