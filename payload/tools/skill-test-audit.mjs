#!/usr/bin/env node
/**
 * skill-test audit, mechanised — the coverage report from `.dsh/skills/skill-test/SKILL.md`.
 *
 * Audit mode enumerates the repository (not the catalog) as the covered set, then joins the
 * catalog's recorded dates so an uncatalogued skill or agent cannot drop out silently. This
 * script does exactly that and prints the skill's report layout.
 *
 * Run: node tools/skill-test-audit.mjs
 *
 * @module tools/skill-test-audit
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'DSGS Skill Testing Framework', 'catalog.yaml');
const FRAMEWORK = join(ROOT, 'DSGS Skill Testing Framework');
const SKILLS_DIR = join(ROOT, '.dsh', 'skills');
const AGENTS_DIR = join(ROOT, '.dsh', 'agents');

/**
 * Parse the catalog's two lists. The file is a flat list of `- name:` entries with scalar
 * fields, so a line-based reader is exact here and needs no YAML dependency.
 * @param {string} text - catalog.yaml contents
 * @returns {{ skills: object[], agents: object[] }}
 */
export function parseCatalog(text) {
  const lists = { skills: [], agents: [] };
  let section;
  let entry;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^skills:\s*$/.test(line)) {
      section = 'skills';
      continue;
    }
    if (/^agents:\s*$/.test(line)) {
      if (entry !== undefined && section !== undefined) lists[section].push(entry);
      entry = undefined;
      section = 'agents';
      continue;
    }
    if (section === undefined) continue;
    const name = /^\s+-\s+name:\s*(.+?)\s*$/.exec(line);
    if (name !== null) {
      if (entry !== undefined) lists[section].push(entry);
      entry = { name: name[1].replace(/^["']|["']$/g, '') };
      continue;
    }
    const field = /^\s+([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (field !== null && entry !== undefined) {
      entry[field[1]] = field[2].replace(/^["']|["']$/g, '');
    }
  }
  if (entry !== undefined && section !== undefined) lists[section].push(entry);
  return lists;
}

/** Skill directory names in the repository. */
function repoNames(dir, filter) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(filter)
    .map((entry) => (filter.constructor === Function && entry.isDirectory()
      ? entry.name
      : entry.name.replace(/\.md$/, '')))
    .sort();
}

/** Does a spec file exist for this name anywhere under the given framework subtree? */
function hasSpec(subtree, name) {
  const dir = join(FRAMEWORK, subtree);
  if (!existsSync(dir)) return false;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (walk(join(current, entry.name))) return true;
      } else if (entry.name === `${name}.md`) return true;
    }
    return false;
  };
  return walk(dir);
}

function main() {
  if (!existsSync(CATALOG)) {
    console.log('catalog does not exist yet (first-run state)');
    return 0;
  }
  const { skills: catalogSkills, agents: catalogAgents } = parseCatalog(readFileSync(CATALOG, 'utf8'));
  const repoSkills = repoNames(SKILLS_DIR, (entry) => entry.isDirectory());
  const repoAgents = repoNames(AGENTS_DIR, (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md');

  const byName = new Map([...catalogSkills, ...catalogAgents].map((entry) => [entry.name, entry]));
  const uncatalogued = [
    ...repoSkills.filter((name) => !catalogSkills.some((entry) => entry.name === name)),
    ...repoAgents.filter((name) => !catalogAgents.some((entry) => entry.name === name)),
  ];
  const noCategory = [...catalogSkills, ...catalogAgents].filter((entry) => !entry.category || entry.category === '');

  console.log('=== Skill Test Coverage Audit ===');
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}\n`);

  const specsWritten = repoSkills.filter((name) => hasSpec('skills', name)).length;
  const neverStatic = catalogSkills.filter((entry) => !entry.last_static).length;
  const neverCategory = catalogSkills.filter((entry) => !entry.last_category).length;

  console.log(`SKILLS (${repoSkills.length} total)`);
  console.log(`Specs written: ${specsWritten} (${Math.round((specsWritten / repoSkills.length) * 100)}%) | `
    + `Never static tested: ${neverStatic} | Never category tested: ${neverCategory}\n`);
  console.log(`${'Skill'.padEnd(22)} | ${'Cat'.padEnd(10)} | Has Spec | Last Static | S.Result | Last Cat | C.Result | Priority`);
  console.log(`${'-'.repeat(22)}-|${'-'.repeat(12)}|----------|-------------|----------|----------|----------|----------`);
  for (const name of repoSkills) {
    const entry = byName.get(name) ?? {};
    const spec = hasSpec('skills', name) ? 'YES' : 'no';
    console.log(`${name.padEnd(22)} | ${String(entry.category ?? '—').padEnd(10)} | ${spec.padEnd(8)} | `
      + `${String(entry.last_static || 'never').padEnd(11)} | ${String(entry.last_static_result || '—').padEnd(8)} | `
      + `${String(entry.last_category || 'never').padEnd(8)} | ${String(entry.last_category_result || '—').padEnd(8)} | ${entry.priority ?? '—'}`);
  }

  const agentSpecs = repoAgents.filter((name) => hasSpec('agents', name)).length;
  console.log(`\nAGENTS (${repoAgents.length} total)`);
  console.log(`Agent specs written: ${agentSpecs} (${Math.round((agentSpecs / repoAgents.length) * 100)}%)\n`);
  console.log(`${'Agent'.padEnd(22)} | ${'Category'.padEnd(10)} | Has Spec | Last Spec | Result | Last Cat | C.Result`);
  console.log(`${'-'.repeat(22)}-|${'-'.repeat(12)}|----------|-----------|--------|----------|----------`);
  for (const name of repoAgents) {
    const entry = byName.get(name) ?? {};
    console.log(`${name.padEnd(22)} | ${String(entry.category ?? '—').padEnd(10)} | `
      + `${(hasSpec('agents', name) ? 'YES' : 'no').padEnd(8)} | ${String(entry.last_spec || 'never').padEnd(9)} | `
      + `${String(entry.last_spec_result || '—').padEnd(6)} | ${String(entry.last_category || 'never').padEnd(8)} | ${entry.last_category_result || '—'}`);
  }

  // The skill's rule: anything absent from the catalog, or catalogued without a category, is
  // reported as NOT ASSESSED by name — never silently excluded.
  console.log(`\nNOT ASSESSED (absent from the catalog, or catalogued with no category): ${uncatalogued.length + noCategory.length}`);
  for (const name of uncatalogued) console.log(`  ${name} — not in catalog.yaml`);
  for (const entry of noCategory) console.log(`  ${entry.name} — catalogued with no category`);

  const gaps = catalogSkills
    .filter((entry) => !hasSpec('skills', entry.name) && ['critical', 'high'].includes(entry.priority))
    .slice(0, 5);
  console.log('\nTop 5 Priority Gaps (skills with no spec, critical/high priority):');
  if (gaps.length === 0) console.log('  (none)');
  for (const entry of gaps) console.log(`  ${entry.name} (${entry.priority})`);

  console.log(`\nSkill coverage:  ${specsWritten}/${repoSkills.length} specs (${Math.round((specsWritten / repoSkills.length) * 100)}%)`);
  console.log(`Agent coverage:  ${agentSpecs}/${repoAgents.length} specs (${Math.round((agentSpecs / repoAgents.length) * 100)}%)`);
  return 0;
}

/** Helper kept separate so the count and the iteration cannot drift apart. */
function repoSkillsUnused(list) {
  return list;
}

process.exit(main());



