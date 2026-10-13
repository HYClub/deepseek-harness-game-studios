#!/usr/bin/env node
/**
 * statusline.mjs — Node port of `.claude/statusline.sh`.
 *
 * Reads the same JSON on stdin and prints the same single line:
 *
 *   ctx% | model | production stage [| Epic > Feature > Task]
 *
 * At `workflow: minimal` the third segment becomes the path position
 * (`Minimal · 3/5 stories`) instead of the stage, because nothing on the minimal path runs
 * `/gate-check` and `project.stage` therefore never leaves `Concept`.
 *
 * ## Fidelity notes
 *
 * - Every decision ladder is preserved, including the two that upstream comments call
 *   load-bearing: the rigor default is **suppressed** rather than guessed when a fronted knob
 *   is set explicitly, and `Technical Setup` requires a *configured* engine (checked in
 *   `project.yaml` first, then in the technical-preferences bullet with leading whitespace
 *   tolerated).
 * - The YAML reads go through the ported helper in-process instead of spawning it per key.
 *   Upstream already made that optimisation (it sourced the helper once); this keeps it.
 * - Output has **no trailing newline**, matching `printf "%s"`.
 * - DSH has no status-line surface of its own, so this is a runnable equivalent rather than a
 *   wired one: see `.dsh/docs/dsh-differences.md`.
 *
 * Usage: `echo '<status json>' | node .dsh/statusline.mjs`
 *
 * @module .dsh/statusline
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getYamlDefault, getYamlKey, resolveCodeRoot } from '../tools/yaml-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The six knobs `modes.rigor` fronts. Any of them set explicitly suppresses the posture. */
export const FRONTED_KEYS = [
  'modes.review_mode',
  'modes.workflow',
  'docs.density',
  'qa.level',
  'modes.story_granularity',
  'team.size',
];

/** Extensions counted as "source" when detecting the Production stage. */
const SOURCE_EXTENSIONS = new Set(['.gd', '.cs', '.cpp', '.h', '.py', '.rs', '.lua', '.tscn', '.tres']);

/** Ten or more source files means Production — the same threshold the bash version used. */
const SOURCE_THRESHOLD = 10;

/**
 * The project root: a cwd that IS a project root wins (it carries real information), then the
 * hook environment, then this script's own location. Deliberately not an upward search — that
 * would resolve a nested project to its parent's config.
 * @returns {string} absolute project root
 */
export function projectRoot() {
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'project.yaml')) || existsSync(join(cwd, '.dsh')) || existsSync(join(cwd, '.claude'))) {
    return cwd;
  }
  const fromEnv = process.env.DSH_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  return resolve(HERE, '..');
}

/**
 * Pull the three fields the line renders out of the status JSON. Missing or malformed input
 * degrades to the upstream defaults (`Unknown`, no percentage, no workspace dir) rather than
 * throwing: this runs every turn.
 * @param {string} text - raw stdin
 * @returns {{ model: string, usedPct: string, workspace: string }}
 */
export function parseStatusInput(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const pick = (path) => {
    let value = json;
    for (const key of path) {
      if (value === null || typeof value !== 'object') return undefined;
      value = value[key];
    }
    return value;
  };
  const model = pick(['model', 'display_name']);
  const used = pick(['context_window', 'used_percentage']);
  const workspace = pick(['workspace', 'project_dir'])
    ?? pick(['workspace', 'current_dir'])
    ?? pick(['cwd']);
  return {
    model: typeof model === 'string' && model.length > 0 ? model : 'Unknown',
    usedPct: used === undefined || used === null ? '' : String(used),
    // Windows paths are normalised so path joins behave the same on both platforms.
    workspace: typeof workspace === 'string' ? workspace.replace(/\\/g, '/') : '.',
  };
}

/** First line of a file, CR/LF stripped (the legacy `production/stage.txt` mirror). */
function firstLine(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

/** `engine.name` from project.yaml, else the technical-preferences bullet, else ''. */
function engineConfigured(root, projectYaml) {
  if (existsSync(projectYaml) && getYamlKey(projectYaml, 'engine.name') !== '') return true;
  const prefs = join(root, '.dsh', 'docs', 'technical-preferences.md');
  if (!existsSync(prefs)) return false;
  for (const line of readFileSync(prefs, 'utf8').split(/\r?\n/)) {
    // Leading whitespace tolerated: an indented bullet must not read as unconfigured.
    if (!/^\s*-\s+\*\*Engine\*\*:/.test(line)) continue;
    return !line.includes('TO BE CONFIGURED');
  }
  return false;
}

/** Count source files under the engine's code root, stopping at the Production threshold. */
function sourceCount(root) {
  let codeRoot = '';
  const previous = process.cwd();
  try {
    process.chdir(root);
    codeRoot = String(resolveCodeRoot()).split('\t')[0].trim();
  } catch {
    codeRoot = '';
  } finally {
    process.chdir(previous);
  }
  if (codeRoot === '') return 0;
  const dir = resolve(root, codeRoot);
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= SOURCE_THRESHOLD) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) count += 1;
    }
  };
  walk(dir);
  return count;
}

/**
 * The production stage, in upstream's priority order: `project.stage`, the legacy mirror,
 * then an artifact-driven ladder from most advanced backward.
 * @param {string} root - project root
 * @param {string} workspace - workspace dir from the status JSON (file lookups use it)
 * @param {string} projectYaml - absolute project.yaml path
 * @returns {string} stage name
 */
export function readStage(root, workspace, projectYaml) {
  if (existsSync(projectYaml)) {
    const fromConfig = getYamlKey(projectYaml, 'project.stage');
    if (fromConfig !== '') return fromConfig;
  }
  const mirror = join(workspace, 'production', 'stage.txt');
  if (existsSync(mirror)) {
    const legacy = firstLine(mirror);
    if (legacy !== '') return legacy;
  }
  const hasConcept = existsSync(join(workspace, 'design', 'gdd', 'game-concept.md'));
  const hasSystems = existsSync(join(workspace, 'design', 'gdd', 'systems-index.md'));
  const configured = engineConfigured(root, projectYaml);
  const adrDir = join(workspace, 'docs', 'architecture');
  let hasAdrs = false;
  try {
    hasAdrs = readdirSync(adrDir).some((name) => /^adr-.*\.md$/.test(name));
  } catch {
    hasAdrs = false;
  }
  if (sourceCount(workspace) >= SOURCE_THRESHOLD) return 'Production';
  if (hasAdrs) return 'Pre-Production';
  if (configured) return 'Technical Setup';
  if (hasSystems) return 'Systems Design';
  if (hasConcept) return 'Concept';
  return 'Concept';
}

/**
 * The displayed posture plus the resolved rigor.
 *
 * The default applies only when nothing contradicts it: if `modes.rigor` is unset but a knob
 * it fronts is set explicitly, the displayed value is suppressed (empty) rather than guessed,
 * matching upstream — "no config, no claim".
 * @param {string} workspace - workspace dir (config lookups use it)
 * @param {string} projectYaml - absolute project.yaml path
 * @returns {{ displayed: string, resolved: string }}
 */
export function readRigor(workspace, projectYaml) {
  if (!existsSync(projectYaml)) return { displayed: '', resolved: '' };
  const explicit = getYamlKey(projectYaml, 'modes.rigor');
  if (explicit !== '') return { displayed: explicit, resolved: explicit };
  const resolved = getYamlDefault('modes.rigor');
  const localYaml = join(workspace, 'project.local.yaml');
  for (const file of [projectYaml, localYaml]) {
    if (!existsSync(file)) continue;
    if (FRONTED_KEYS.some((key) => getYamlKey(file, key) !== '')) return { displayed: '', resolved };
  }
  return { displayed: resolved, resolved };
}

/**
 * At `workflow: minimal`, the third segment is the built-story position instead of the stage.
 * The status word is matched exactly (a substring match on *Done* counted "Not Done").
 * @param {string} workspace - workspace dir
 * @param {string} rigorResolved - resolved rigor, the default workflow when none is explicit
 * @returns {string} `Minimal · 3/5 stories`, `Minimal · brief`, or '' when not minimal
 */
export function minimalPosition(workspace, rigorResolved) {
  let workflow = rigorResolved;
  const projectYaml = join(workspace, 'project.yaml');
  let text = '';
  try {
    text = readFileSync(projectYaml, 'utf8');
  } catch {
    text = '';
  }
  if (/\s+workflow:/.test(text)) {
    const explicit = getYamlKey(projectYaml, 'modes.workflow');
    if (explicit !== '') workflow = explicit;
  }
  if (workflow !== 'minimal') return '';

  const epicsDir = join(workspace, 'production', 'epics');
  let total = 0;
  let done = 0;
  let epicNames = [];
  try {
    epicNames = readdirSync(epicsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    epicNames = [];
  }
  for (const epic of epicNames) {
    let stories = [];
    try {
      stories = readdirSync(join(epicsDir, epic)).filter((name) => /^story-.*\.md$/.test(name));
    } catch {
      stories = [];
    }
    for (const story of stories) {
      total += 1;
      let body = '';
      try {
        body = readFileSync(join(epicsDir, epic, story), 'utf8');
      } catch {
        continue;
      }
      for (const raw of body.split(/\r?\n/)) {
        // Normalise `> **Status**: X`, `**Status:** X`, `- Status: X` to `Status: X`.
        let line = raw.replace(/\*/g, '').trim();
        if (line.startsWith('> ')) line = line.slice(2).trim();
        if (line.startsWith('- ')) line = line.slice(2).trim();
        if (!line.startsWith('Status:')) continue;
        const value = line.slice('Status:'.length).trim();
        const word = (value.match(/^[A-Za-z]*/) ?? [''])[0];
        if (/^(complete|done)$/i.test(word)) done += 1;
        break;
      }
    }
  }
  return total > 0 ? `Minimal · ${done}/${total} stories` : 'Minimal · brief';
}

/**
 * ` | Epic > Feature > Task` from the STATUS block in the session checkpoint, Production and
 * later only. Returns '' when there is nothing to show.
 * @param {string} workspace - workspace dir
 * @param {string} stage - resolved stage
 * @returns {string} breadcrumb suffix (leading ` | ` included), or ''
 */
export function breadcrumb(workspace, stage) {
  if (!['Production', 'Polish', 'Release'].includes(stage)) return '';
  const stateFile = join(workspace, 'production', 'session-state', 'active.md');
  if (!existsSync(stateFile)) return '';
  let body = '';
  try {
    body = readFileSync(stateFile, 'utf8');
  } catch {
    return '';
  }
  const parts = [];
  let inBlock = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.includes('<!-- STATUS -->')) {
      inBlock = true;
      continue;
    }
    if (line.includes('<!-- /STATUS -->')) break;
    if (!inBlock) continue;
    const m = /^(Epic|Feature|Task):\s*(.*)$/.exec(line.trim());
    if (m === null) continue;
    if (m[2].trim() !== '') parts.push(m[2].trim());
  }
  return parts.length > 0 ? ` | ${parts.join(' > ')}` : '';
}

/**
 * Render the whole status line.
 * @param {string} input - raw status JSON
 * @param {string} [root] - project root override (tests)
 * @returns {string} the status line, with no trailing newline
 */
export function renderStatus(input, root = projectRoot()) {
  const { model, usedPct, workspace: rawWorkspace } = parseStatusInput(input);
  const workspace = resolve(root, rawWorkspace === '' ? '.' : rawWorkspace);
  const ctxLabel = usedPct === '' ? 'ctx: --' : `ctx: ${usedPct}%`;
  const projectYaml = join(workspace, 'project.yaml');
  const stage = readStage(root, workspace, projectYaml);
  const { displayed, resolved } = readRigor(workspace, projectYaml);
  const pathPos = minimalPosition(workspace, resolved);
  const segment = pathPos !== '' ? pathPos : `${stage}${displayed === '' ? '' : ` · ${displayed}`}`;
  return `${ctxLabel} | ${model} | ${segment}${breadcrumb(workspace, stage)}`;
}

/** CLI entry: read stdin, print the line. @returns {number} exit code */
export function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  process.stdout.write(renderStatus(input));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
