#!/usr/bin/env node
/**
 * audit-skill-refs — check that what the generated skills tell the model to read
 * and run actually exists in this project.
 *
 *   node tools/audit-skill-refs.mjs [projectRoot] [--json]
 *
 * Why this exists: the port rewrites paths (`.claude/` → `.dsh/`) and tool calls
 * (`bash x.sh` → `node x.mjs`). A single stale reference is invisible until a skill
 * is invoked and the model tries to read or run something that is not there, so the
 * check is mechanical instead of trusting the rewrite.
 *
 * Classification:
 *   FRAMEWORK  a path under `.dsh/`, `.claude/`, `tools/` or the testing framework —
 *              must exist, a miss is an error;
 *   ASSET      a project artifact path (`design/`, `production/`, `docs/`, `src/`, …) —
 *              created by the studio flow, existence is reported but never an error;
 *   SHELL      a `.sh` invocation that is neither a hook nor a ported script —
 *              an error on Windows/DSH, because bash cannot start here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const ROOT = resolve(argv.find((a) => !a.startsWith('--')) ?? process.cwd());

const FRAMEWORK_PREFIXES = ['.dsh/', 'tools/', 'DSGS Skill Testing Framework/', 'dsh-src/'];
const ASSET_PREFIXES = [
  'design/', 'production/', 'docs/', 'src/', 'assets/', 'Assets/', 'Content/',
  'tests/', 'prototypes/', 'Source/',
];

/** Same-basename check that survives the Windows case-insensitive filesystem. */
function exists(rel) {
  return existsSync(join(ROOT, rel));
}

function classify(rel) {
  if (FRAMEWORK_PREFIXES.some((p) => rel.startsWith(p))) return 'FRAMEWORK';
  if (ASSET_PREFIXES.some((p) => rel.startsWith(p))) return 'ASSET';
  return 'OTHER';
}

/** Drop the generated header block. It carries our own notes plus the upstream card's
 * inert metadata (tool grants, argument hints), which are not instructions to audit.
 * @param {string} text - generated file body
 * @returns {string} the body without the generated header
 */
function stripGeneratedHeader(text) {
  const begin = text.indexOf('<!-- DSGS-GENERATED:BEGIN');
  if (begin === -1) return text;
  const end = text.indexOf('<!-- DSGS-GENERATED:END -->', begin);
  if (end === -1) return text;
  return text.slice(0, begin) + text.slice(end);
}

/** Collect every plausible repository path mentioned in a markdown body. */
function referencedPaths(text) {
  const found = new Map();
  const lines = stripGeneratedHeader(text).split('\n');
  const re = /(?:^|[\s(`"'|])((?:\.dsh|\.claude|tools|DSGS Skill Testing Framework|dsh-src|design|production|docs|src|assets|Assets|Content|tests|prototypes|Source)\/[\w./@{}*+\[\]-]*[\w/*])/gm;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(re)) {
      const rel = match[1].replace(/[.,;:)]+$/, '');
      if (rel.includes('*') || rel.includes('{') || rel.includes('...')) continue;
      // Placeholder paths (`…-spec-[name]-[date].md`) name a file the skill will create.
      if (rel.includes('[') || rel.includes(']')) continue;
      if (rel.endsWith('/')) continue;
      // "Glob for X", "if found", "check whether X exists" are optional lookups, not deps.
      const optional = /glob for|if found|if it exists|check whether|optionally|may exist/i.test(line);
      const prior = found.get(rel) ?? { optional: true, lines: [] };
      prior.optional = prior.optional && optional;
      prior.lines.push(index + 1);
      found.set(rel, prior);
    }
  });
  return found;
}

/** Shell invocations that cannot run in a confined DSH session. */
function shellReferences(text) {
  const found = [];
  for (const match of text.matchAll(/(?:^|[\s(`"'])bash\s+"?([^\s"']+\.sh)"?/gm)) {
    found.push(match[1]);
  }
  return found;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const skillsDir = join(ROOT, '.dsh', 'skills');
if (!existsSync(skillsDir)) {
  console.error(`FAIL: ${skillsDir} does not exist — run node tools/build-dsh.mjs first`);
  process.exit(1);
}

const files = walk(skillsDir);
const missingFramework = new Map();
const optionalMissing = new Map();
const missingShellTargets = new Map();
const shellInvocations = new Map();
const assetRefs = new Set();
let referenceCount = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  for (const [ref, meta] of referencedPaths(text)) {
    referenceCount += 1;
    const kind = classify(ref);
    if (kind === 'ASSET') {
      assetRefs.add(ref);
      continue;
    }
    if (kind === 'OTHER') continue;
    if (exists(ref)) continue;
    const target = meta.optional ? optionalMissing : missingFramework;
    const list = target.get(ref) ?? [];
    list.push(rel);
    target.set(ref, list);
  }
  for (const sh of shellReferences(text)) {
    shellInvocations.set(sh, (shellInvocations.get(sh) ?? 0) + 1);
    // A `.sh` that has a Node port is fine; one that does not cannot run here.
    const ported = sh.replace(/\.sh$/, '.mjs');
    const isHookOrScript = sh.startsWith('.dsh/hooks/') || sh.startsWith('.dsh/scripts/');
    if (!isHookOrScript || !exists(ported)) {
      const list = missingShellTargets.get(sh) ?? [];
      list.push(rel);
      missingShellTargets.set(sh, list);
    }
  }
}

// Stale prose mentions: a `.sh` file name whose Node port exists is misleading text.
const staleScriptNames = new Map();
for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  const text = stripGeneratedHeader(readFileSync(file, 'utf8'));
  for (const match of text.matchAll(/\.dsh\/(scripts|hooks)\/([\w.-]+)\.sh/g)) {
    const ported = `.dsh/${match[1]}/${match[2]}.mjs`;
    if (!exists(ported)) continue;
    const list = staleScriptNames.get(`.dsh/${match[1]}/${match[2]}.sh`) ?? [];
    list.push(rel);
    staleScriptNames.set(`.dsh/${match[1]}/${match[2]}.sh`, list);
  }
}

const report = {
  root: ROOT,
  scannedFiles: files.length,
  references: referenceCount,
  missingFramework: [...missingFramework.entries()].map(([path, from]) => ({ path, referencedBy: [...new Set(from)] })),
  optionalMissing: [...optionalMissing.entries()].map(([path, from]) => ({ path, referencedBy: [...new Set(from)] })),
  shellWithoutPort: [...missingShellTargets.entries()].map(([path, from]) => ({ path, referencedBy: [...new Set(from)], invocations: shellInvocations.get(path) })),
  staleShellMentions: [...staleScriptNames.entries()].map(([path, from]) => ({ path, referencedBy: [...new Set(from)] })),
  assetPathsReferenced: assetRefs.size,
  assetPathsMissing: [...assetRefs].filter((p) => !exists(p)).length,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`scanned ${report.scannedFiles} skill files, ${report.references} path references`);
  console.log(`framework references missing: ${report.missingFramework.length}`);
  for (const item of report.missingFramework.slice(0, 25)) {
    console.log(`  MISSING ${item.path}\n      referenced by: ${item.referencedBy.slice(0, 4).join(', ')}${item.referencedBy.length > 4 ? ', …' : ''}`);
  }
  if (report.optionalMissing.length > 0) {
    console.log(`optional lookups that resolve to nothing (not an error): ${report.optionalMissing.length}`);
    for (const item of report.optionalMissing.slice(0, 10)) {
      console.log(`  optional ${item.path} — ${item.referencedBy.slice(0, 3).join(', ')}`);
    }
  }
  console.log(`shell invocations without a Node port: ${report.shellWithoutPort.length}`);
  for (const item of report.shellWithoutPort.slice(0, 15)) {
    console.log(`  SHELL ${item.path} (${item.invocations}×)\n      referenced by: ${item.referencedBy.slice(0, 4).join(', ')}${item.referencedBy.length > 4 ? ', …' : ''}`);
  }
  console.log(`asset paths referenced: ${report.assetPathsReferenced} (missing now: ${report.assetPathsMissing} — expected before the flow creates them)`);
  if (report.staleShellMentions.length > 0) {
    console.log(`stale \`.sh\` mentions whose Node port exists: ${report.staleShellMentions.length}`);
    for (const item of report.staleShellMentions.slice(0, 10)) {
      console.log(`  STALE ${item.path} — ${item.referencedBy.slice(0, 3).join(', ')}`);
    }
  }
}

process.exit(report.missingFramework.length === 0 && report.shellWithoutPort.length === 0 && report.staleShellMentions.length === 0 ? 0 : 1);

