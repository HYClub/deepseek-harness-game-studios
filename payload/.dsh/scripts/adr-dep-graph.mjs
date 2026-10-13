#!/usr/bin/env node
// adr-dep-graph.mjs — build the ADR dependency graph and detect cycles.
//
// Node port of `.dsh/scripts/adr-dep-graph.sh` (lines 1-143). Line formats
// (`ADRS:`, `EDGES:` + two-space-indented `from -> to`, `NO_DEPS_SECTION:`,
// `CYCLE:`) and the exit codes are reproduced literally; the caller
// (gate-pre-production) parses them.
//
// Replaces a full read of every ADR (to extract one table row each) plus a manual
// cycle trace. A model tracing A→B→C→A across a dozen ADRs will eventually miss an
// edge; Kahn's algorithm cannot.
//
// EMITS OBSERVATIONS, NOT A VERDICT (per .dsh/docs/context-management.md rule 2).
// The caller decides FAIL vs CONCERNS per tier. In particular NO_DEPS_SECTION is
// load-bearing: it makes "no cycles because the graph is clean" distinguishable
// from "no cycles because half the ADRs have no dependency section".
//
// Usage: node .dsh/scripts/adr-dep-graph.mjs [adr-dir]
//   adr-dir defaults to docs/architecture (relative to repo root). An explicit
//   dir (used by the test suite) is taken as-is.
//
// Output:
//   ADRS: <n>
//   EDGES:                        one "adr-A -> adr-B" per Depends-On reference
//     (or "  (none)")
//   NO_DEPS_SECTION: adr-X, ...   ADRs with no `## ADR Dependencies` / no Depends On
//   CYCLE: adr-A -> adr-B -> adr-A   one line per node in a dependency cycle
//     (absent when the graph is acyclic)
//
// PORTING NOTES:
//   - `find ... -name 'adr-*.md' -type f | sed 's|\\|/|g' | sort` becomes a
//     `readdirSync` filtered to regular files, sorted with the default code-unit
//     comparison (`LC_ALL=C sort` for these names), with forward slashes forced in
//     the display path the same way the `sed` did.
//   - The `awk` section slicer becomes an explicit scan: `## ` at column 0 starts
//     a new section, and the `**Depends On**` row is only recognised inside
//     `## ADR Dependencies`. `insec` is only reassigned on a heading, so the row
//     is collected wherever it appears in the section — same as the original.
//   - `grep -oiE 'adr-[0-9]+' | tr 'A-Z' 'a-z' | sort -u` becomes one global
//     case-insensitive match, lowercased and de-duplicated; the sort is implied by
//     the de-duplication because Kahn's algorithm output is sorted separately, and
//     the EDGES lines are emitted in file order like the original.
//   - Kahn's algorithm: the `awk` version peels nodes with out-degree 0 by
//     decrementing the out-degree of every node that depends on them. That is a
//     faithful (if unusual) formulation — out-degree here means "remaining
//     dependencies of this node" — and it is preserved exactly, including the
//     report of whichever nodes cannot be peeled.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { posixPath, readText, rootFromScript } from './_runner.mjs';

/** Normalise any adr reference (filename or "ADR-0003") to `adr-0003`, or ''. */
function adrId(value) {
  const matches = value.match(/adr-[0-9]+/gi);
  return matches === null || matches.length === 0 ? '' : matches[0].toLowerCase();
}

const arg = process.argv[2] ?? '';
const adrDir = arg !== '' ? arg : join(rootFromScript(), 'docs', 'architecture');

const files = [];
try {
  for (const entry of readdirSync(adrDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('adr-') && entry.name.endsWith('.md')) {
      files.push(posixPath(join(adrDir, entry.name)));
    }
  }
} catch {
  /* missing directory: falls through to the "no ADRs" report, like the original */
}
files.sort();

const out = [];
if (files.length === 0) {
  out.push('ADRS: 0');
  out.push('EDGES:');
  out.push(`  (none — no ADRs in ${posixPath(adrDir)})`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(0);
}

const edges = [];
const noDeps = [];
let n = 0;

for (const file of files) {
  n += 1;
  const from = adrId(file);
  const text = readText(file) ?? '';

  // Slice the `## ADR Dependencies` section, take the `**Depends On**` row.
  let inSection = false;
  const depsRows = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('## ')) inSection = line.includes('## ADR Dependencies');
    if (inSection && line.includes('**Depends On**')) depsRows.push(line);
  }

  if (depsRows.length === 0) {
    noDeps.push(from);
    continue;
  }

  const toIds = [...new Set(
    depsRows.flatMap((row) => (row.match(/adr-[0-9]+/gi) ?? []).map((id) => id.toLowerCase())),
  )].sort();
  if (toIds.length === 0) {
    // Section present but Depends On is "None" (or empty) — a real leaf, not a
    // missing section. Not reported under NO_DEPS_SECTION.
    continue;
  }
  for (const to of toIds) {
    if (to === from) continue; // ignore a self-reference
    edges.push([from, to]);
  }
}

out.push(`ADRS: ${n}`);
out.push('EDGES:');
if (edges.length === 0) {
  out.push('  (none)');
} else {
  for (const [from, to] of edges) out.push(`  ${from} -> ${to}`);
}

// no_deps carries one entry per ADR in file order; comma-joined.
if (noDeps.length > 0) out.push(`NO_DEPS_SECTION: ${noDeps.join(', ')}`);

// Cycle detection — Kahn's algorithm on out-degree (a node "depends on" its
// out-neighbours; a leaf depends on nothing remaining). Whatever cannot be peeled
// away is part of a cycle. Reported as an observation; the caller sets the verdict.
if (edges.length > 0) {
  const cycleNodes = findCycleNodes(edges);
  for (const node of cycleNodes) {
    // Show each cycle node with the in-cycle edges it participates in.
    const outs = edges.filter(([from]) => from === node).map(([, to]) => ` -> ${to}`).join('');
    out.push(`CYCLE: ${node}${outs}`);
  }
}

process.stdout.write(`${out.join('\n')}\n`);

/**
 * Nodes that cannot be peeled by repeatedly removing out-degree-0 nodes, sorted.
 * @param {Array<[string, string]>} edgeList
 * @returns {string[]}
 */
function findCycleNodes(edgeList) {
  const nodes = new Set();
  const outDegree = new Map();
  for (const [from, to] of edgeList) {
    nodes.add(from);
    nodes.add(to);
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
  }
  const gone = new Set();
  const edgeDone = new Array(edgeList.length).fill(false);
  let progress = true;
  while (progress) {
    progress = false;
    for (const node of nodes) {
      if (gone.has(node) || (outDegree.get(node) ?? 0) > 0) continue;
      gone.add(node);
      progress = true;
      for (let i = 0; i < edgeList.length; i += 1) {
        if (edgeList[i][1] === node && !edgeDone[i]) {
          edgeDone[i] = true;
          outDegree.set(edgeList[i][0], (outDegree.get(edgeList[i][0]) ?? 0) - 1);
        }
      }
    }
  }
  return [...nodes].filter((node) => !gone.has(node)).sort();
}
