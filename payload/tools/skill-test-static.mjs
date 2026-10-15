#!/usr/bin/env node
/**
 * skill-test static, mechanised — the 7 structural checks from `.dsh/skills/skill-test/SKILL.md`.
 *
 * The skill's static mode is a per-skill procedure for the model to follow; running it across
 * all 74 skills by hand is neither repeatable nor reviewable, so the checks themselves are
 * implemented here, in the skill's own order and wording, and the output keeps the skill's table
 * format. Anything the skill marks WARN stays a WARN — this script does not promote warnings.
 *
 * One deliberate strengthening: Check 1 is evaluated against the **content source**
 * (`.claude/skills/<name>/SKILL.md`) as well as the generated card. The port maps upstream
 * frontmatter fields onto DSH's smaller schema (`argument-hint`/`allowed-tools` have no DSH
 * field and live in the card's metadata block), so checking only the generated file would report
 * a systematic false failure; checking only the source would miss a field the generator dropped.
 * Both are compared, and a field that reached neither place fails.
 *
 * Run: node tools/skill-test-static.mjs [name ...]
 *
 * @module tools/skill-test-static
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, '.dsh', 'skills');
const SOURCE_DIR = join(ROOT, '.claude', 'skills');

/** Upstream frontmatter fields the linter's Check 1 requires. */
const REQUIRED_UPSTREAM = ['name', 'description', 'argument-hint', 'user-invocable', 'allowed-tools'];
/** Fields DSH's own skill schema understands. */
const REQUIRED_DSH = ['name', 'description', 'user-invocable'];

/** Verdict vocabulary the skill accepts for Check 3, in its three groups. */
const VERDICTS = [
  'PASS', 'FAIL', 'CONCERNS', 'APPROVED', 'BLOCKED', 'COMPLETE', 'READY', 'COMPLIANT', 'NON-COMPLIANT',
  'PROCEED', 'PIVOT', 'KILL', 'GO', 'NO-GO',
  'CRITICAL', 'HIGH', 'MEDIUM', 'LOW',
];

/** Phrasing that promises an assessment — used when no verdict keyword is present. */
const ASSESSMENT_WORDS = /review|audit|check|gate|readiness|validate|assess|verdict/i;

/** Split a leading `---` frontmatter block from the body. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(text.indexOf('\n', 3) + 1, end), body: text.slice(end + 4) };
}

/** Keys present in a frontmatter block (top-level only, which is all these files use). */
function frontmatterKeys(frontmatter) {
  const keys = new Map();
  for (const line of frontmatter.split('\n')) {
    const m = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (m !== null) keys.set(m[1], m[2].trim());
  }
  return keys;
}

/** The generated card's "upstream metadata" block: `>   - \`key: value\``. */
function metadataBlockKeys(text) {
  const keys = new Map();
  for (const line of text.split('\n')) {
    const m = /^>\s+-\s+`([A-Za-z][A-Za-z-]*):\s*([\s\S]*?)`\s*$/.exec(line.trim());
    if (m !== null) keys.set(m[1], m[2].trim());
  }
  return keys;
}

/** Check 2: phase-like headings.
 *
 * The skill lists three acceptable bases, so all three are measured and the best one wins:
 * numbered `Phase N` headings (at any level — the team skills put `## Phase 0` at the top and
 * `### Phase 1..6` under `## Pipeline`, and calling seven phases "only 1" is the false failure
 * the skill's own Check 3 note warns about), dotted `## N.` sections, or simply two distinct
 * `##` headings when the phases are not numbered (which is how `team-audio`/`team-level` read,
 * since they number `### Step N` stages instead).
 */
function phaseCount(body) {
  const numbered = (body.match(/^#{2,4}\s+Phase\s+\d+/gim) ?? []).length;
  const dotted = (body.match(/^##\s+\d+[.)]/gm) ?? []).length;
  const sections = (body.match(/^##\s+\S/gm) ?? []).length;
  return Math.max(numbered, dotted, sections);
}

/**
 * Run the 7 checks for one skill.
 * @param {string} name - skill directory name
 * @returns {{ name: string, result: string, issues: string[], detail: string[] }}
 */
export function checkSkill(name) {
  const generatedPath = join(SKILLS_DIR, name, 'SKILL.md');
  const sourcePath = join(SOURCE_DIR, name, 'SKILL.md');
  if (!existsSync(generatedPath)) {
    return { name, result: 'NOT ASSESSED', issues: ['SKILL.md not found'], detail: [] };
  }
  const generated = readFileSync(generatedPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(generated);
  const dshKeys = frontmatterKeys(frontmatter);
  const upstreamKeys = frontmatterKeys(splitFrontmatter(existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '').frontmatter);
  const carried = metadataBlockKeys(generated);

  const issues = [];
  const detail = [];
  /** Record a finding with its severity. Check 5/6/7 are WARN-only by the skill's own wording;
   * Checks 1/2 always FAIL, Check 3 FAILs only when the skill performs an assessment, and
   * Check 4 FAILs only when the card may write. */
  const fail = (text) => issues.push({ level: 'FAIL', text });
  const warn = (text) => issues.push({ level: 'WARN', text });

  // 1 — required frontmatter fields (DSH schema + nothing lost from upstream).
  const missingDsh = REQUIRED_DSH.filter((key) => !dshKeys.has(key));
  const lost = REQUIRED_UPSTREAM.filter((key) => upstreamKeys.has(key) && !dshKeys.has(key) && !carried.has(key));
  if (missingDsh.length > 0) {
    fail(`Check 1: DSH frontmatter missing ${missingDsh.join(', ')}`);
    detail.push(`Check 1 — Frontmatter Fields:    FAIL (missing ${missingDsh.join(', ')})`);
  } else if (lost.length > 0) {
    fail(`Check 1: upstream field(s) reached neither frontmatter nor metadata block: ${lost.join(', ')}`);
    detail.push(`Check 1 — Frontmatter Fields:    FAIL (${lost.join(', ')} lost)`);
  } else {
    const carriedNote = REQUIRED_UPSTREAM.filter((key) => upstreamKeys.has(key) && carried.has(key));
    detail.push(carriedNote.length > 0
      ? `Check 1 — Frontmatter Fields:    PASS (${carriedNote.join(', ')} preserved in the card's metadata block)`
      : 'Check 1 — Frontmatter Fields:    PASS');
  }

  // 2 — at least two phase-like headings.
  const phases = phaseCount(body);
  if (phases < 2) {
    fail(`Check 2: only ${phases} phase-like heading(s)`);
    detail.push(`Check 2 — Multiple Phases:       FAIL (${phases} found)`);
  } else {
    detail.push(`Check 2 — Multiple Phases:       PASS (${phases} phases found)`);
  }

  // 3 — a verdict vocabulary, or a documented reason not to have one.
  const found = VERDICTS.filter((word) => new RegExp(`\\b${word}\\b`).test(body));
  const promisesAssessment = ASSESSMENT_WORDS.test(`${dshKeys.get('description') ?? ''}\n${body}`);
  if (found.length > 0) {
    detail.push(`Check 3 — Verdict Keywords:      PASS (${found.slice(0, 4).join(', ')}${found.length > 4 ? ', …' : ''})`);
  } else if (promisesAssessment) {
    fail('Check 3: no verdict keyword although the skill performs an assessment');
    detail.push('Check 3 — Verdict Keywords:      FAIL (no verdict keyword)');
  } else {
    warn('Check 3: no verdict keyword (the skill emits an artifact, not a judgement)');
    detail.push('Check 3 — Verdict Keywords:      WARN (artifact, not a judgement)');
  }

  // 4 — ask before writing, required when the card may write. The skill accepts any of three
  // forms: the canonical "May I write", "before writing"/"approval" near a write instruction,
  // or "ask" and "write" inside the same section.
  const sections = body.split(/^##\s+/m);
  const asksBeforeWrite =
    /May I write/i.test(body)
    || /before writing/i.test(body)
    || sections.some((section) => /\bask\b/i.test(section) && /\b(write|edit)\b/i.test(section))
    || body.split('\n').some((line, index, lines) => /\bapproval\b/i.test(line)
      && lines.slice(Math.max(0, index - 3), index + 4).some((near) => /\b(write|edit|append)\b/i.test(near)));
  const mayWrite = /write|edit/i.test(String(upstreamKeys.get('allowed-tools') ?? ''));
  if (!asksBeforeWrite && mayWrite) {
    fail('Check 4: may write but no ask-before-write language');
    detail.push('Check 4 — Collaborative Protocol: FAIL (may write, no ask language)');
  } else if (!asksBeforeWrite) {
    warn('Check 4: no ask-before-write language (read-only card)');
    detail.push('Check 4 — Collaborative Protocol: WARN (no ask language)');
  } else {
    detail.push('Check 4 — Collaborative Protocol: PASS ("May I write" found)');
  }

  // 5 — a next-step handoff. The skill accepts a final section naming another skill, so a
  // trailing `/some-skill` reference counts on its own.
  const tail = body.slice(Math.floor(body.length * 0.7));
  const handoff = /next step|next:|Follow-Up|After this|recommended next|推荐下一步|下一步/i.test(tail)
    || /(^|[\s(`])\/[a-z][a-z-]{2,}/.test(tail);
  if (!handoff) {
    warn('Check 5: no next-step handoff');
    detail.push('Check 5 — Next-Step Handoff:     WARN (no follow-up section found)');
  } else {
    detail.push('Check 5 — Next-Step Handoff:     PASS');
  }

  // 6 — `context: fork` demands a complex skill.
  const fork = String(upstreamKeys.get('context') ?? dshKeys.get('context') ?? '') === 'fork';
  if (fork && phases < 5) {
    warn(`Check 6: context: fork with only ${phases} phases`);
    detail.push(`Check 6 — Fork Context:          WARN (fork with ${phases} phases)`);
  } else {
    detail.push(fork
      ? `Check 6 — Fork Context:          PASS (${phases} phases, context: fork set)`
      : 'Check 6 — Fork Context:          PASS (not fork)');
  }

  // 7 — the argument hint is present and non-empty.
  const hint = carried.get('argument-hint') ?? dshKeys.get('argument-hint') ?? upstreamKeys.get('argument-hint') ?? '';
  if (hint === '' || hint === '""') {
    warn('Check 7: empty argument-hint');
    detail.push('Check 7 — Argument Hint:         WARN (empty hint)');
  } else {
    detail.push('Check 7 — Argument Hint:         PASS');
  }

  const failures = issues.filter((issue) => issue.level === 'FAIL').length;
  const warnings = issues.filter((issue) => issue.level === 'WARN').length;
  const result = failures > 0 ? 'NON-COMPLIANT' : warnings > 0 ? 'WARNINGS' : 'COMPLIANT';
  return { name, result, issues, detail, warnings, failures };
}

/** All skill directory names, sorted. */
export function skillNames() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : skillNames();
  const results = names.map((name) => checkSkill(name));
  const pad = Math.max(20, ...names.map((n) => n.length));

  if (requested.length === 1) {
    const [one] = results;
    console.log(`=== Skill Static Check: /${one.name} ===\n`);
    for (const line of one.detail) console.log(line);
    console.log(`\nVerdict: ${one.result}${one.issues.length > 0 ? ` (${one.issues.length} issue(s))` : ''}`);
    return one.result === 'NON-COMPLIANT' ? 1 : 0;
  }

  console.log(`=== Skill Static Check: All ${results.length} Skills ===\n`);
  console.log(`${'Skill'.padEnd(pad)} | Result       | Issues`);
  console.log(`${'-'.repeat(pad)}-|--------------|-------`);
  for (const row of results) {
    console.log(`${row.name.padEnd(pad)} | ${row.result.padEnd(12)} | ${row.issues.map((issue) => issue.text).join('; ')}`);
  }
  const count = (result) => results.filter((r) => r.result === result).length;
  console.log(`\nSummary: ${count('COMPLIANT')} COMPLIANT, ${count('WARNINGS')} WARNINGS, `
    + `${count('NON-COMPLIANT')} NON-COMPLIANT, ${count('NOT ASSESSED')} NOT ASSESSED`);
  console.log(`[${results.length} of ${skillNames().length} skills checked]`);
  const failures = count('NON-COMPLIANT');
  return failures > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(main());
}

