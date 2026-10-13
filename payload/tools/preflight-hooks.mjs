#!/usr/bin/env node
/**
 * preflight-hooks — will the hook bridge actually mount at the next profile restart?
 *
 *   node tools/preflight-hooks.mjs
 *
 * The bridge plugin (@deepseek-ai/dsh-hooks-claude-code) is a profile plugin, and DSH
 * does not hot-mount a new plugin into a running session. So between "the config is
 * generated" and "the hooks fire" there are four things that can silently go wrong, and
 * this script checks all four statically, against the real profile and the real install:
 *
 *   1. the profile patch carries an `insert` entry whose id is hooks-claude-code;
 *   2. its `configPath` exists and is this project's generated `.dsh/hooks.json`;
 *   3. every command in that file is non-empty, has a numeric timeout, and every matcher
 *      compiles as a regex (a malformed matcher makes the bridge skip the whole group);
 *   4. every package the plugin imports at mount time resolves from the *profile*
 *      directory — that resolution base is what the loader uses, and it is NOT this
 *      repository's node_modules.
 *
 * Exit code 0 = nothing static stands in the way of mounting.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const PROFILE = process.env.DSH_PROFILE ?? 'web';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', PROFILE);
const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd());

const problems = [];
const notes = [];

console.log(`dsh home : ${DSH_HOME}`);
console.log(`profile  : ${PROFILE} (${PROFILE_DIR})`);
console.log(`project  : ${ROOT}`);

// ---------------------------------------------------------------- 1. patch entry
const patchPath = join(PROFILE_DIR, 'cordis.patch.yml');
if (!existsSync(patchPath)) {
  problems.push(`profile patch not found: ${patchPath}`);
}
let configPath;
/**
 * Which kind of row mounts the hooks:
 *  - `bridge`: the official `@deepseek-ai/dsh-hooks-claude-code` row. Hook commands run
 *    through the sandboxed shell service.
 *  - `direct`: our own `tools/dsh-plugin` row, which spawns hook commands directly and
 *    pins their cwd to the project — immune to the sandbox refusal that silently turns
 *    every hook into a no-op when the harness was launched from a directory containing
（见仓库 README）
 */
let rowKind = 'unknown';
if (problems.length === 0) {
  // Parse with the js-yaml that ships inside the dsh install (no dependency here).
  const jsYaml = loadJsYaml();
  if (jsYaml === undefined) {
    problems.push('could not load js-yaml from the dsh install to read the profile patch');
  } else {
    let doc;
    try {
      doc = jsYaml.load(readFileSync(patchPath, 'utf8'));
    } catch (error) {
      problems.push(`profile patch is not valid YAML: ${error.message}`);
    }
    const inserts = Array.isArray(doc)
      ? doc.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
      : [];
    const entry = inserts.find((e) => e?.id === 'hooks-claude-code')
      ?? inserts.find((e) => typeof e?.config?.configPath === 'string');
    if (entry === undefined) {
      problems.push('no `insert` entry carrying a hooks configPath i（见仓库 README）
    } else {
      configPath = entry.config?.configPath;
      const rowName = String(entry.name ?? '');
      if (rowName === '@deepseek-ai/dsh-hooks-claude-code') rowKind = 'bridge';
      else if (rowName.startsWith('file://') || rowName.startsWith('dsgs-hooks')) rowKind = 'direct';
      if (rowKind === 'direct') {
        notes.push(`row ${JSON.stringify(entry.id ?? rowName)} mounts the direct-execution plugin — hooks do not depend on the sandboxed shell or the harness launch directory`);
        if (rowName.startsWith('file://')) {
          const pluginFile = fileURLToPath(rowName);
          if (!existsSync(pluginFile)) problems.push(`the plugin file does not exist: ${pluginFile}`);
          else notes.push(`plugin file: ${pluginFile}`);
        }
      } else {
        notes.push('row mounts the official bridge — hook commands run through the sandboxed shell (a sandbox with no usable backend silently allows every hook)');
      }
      if (typeof configPath !== 'string' || configPath.length === 0) {
        problems.push(`the ${entry.id ?? 'hooks'} entry has no configPath`);
      }
      if (entry.config?.projectDir !== undefined && rowKind !== 'direct') {
        notes.push('the entry sets projectDir; leaving it unset is what keeps a copied tree from firing hooks at the original repo');
      }
    }
  }
}

// ------------------------------------------------------------- 2. config file
const expected = join(ROOT, '.dsh', 'hooks.json');
let config;
if (typeof configPath === 'string') {
  if (!existsSync(configPath)) {
    problems.push(`configPath does not exist: ${configPath}`);
  } else {
    if (resolve(configPath).toLowerCase() !== resolve(expected).toLowerCase()) {
      problems.push(`configPath points at ${configPath}, not this project's ${expected}`);
    }
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      problems.push(`configPath is not valid JSON: ${error.message}`);
    }
  }
}

// ------------------------------------------------------- 3. commands and matchers
let commandCount = 0;
if (config !== undefined) {
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      problems.push(`${event}: hooks value is not a list`);
      continue;
    }
    for (const group of groups) {
      if (group.matcher !== undefined && group.matcher !== '' && group.matcher !== '*') {
        try {
          new RegExp(group.matcher);
        } catch {
          problems.push(`${event}: matcher ${JSON.stringify(group.matcher)} is not a valid regex — the bridge skips the group`);
        }
      }
      for (const hook of group.hooks ?? []) {
        commandCount += 1;
        if (typeof hook.command !== 'string' || hook.command.trim().length === 0) {
          problems.push(`${event}: a hook has no command`);
        }
        if (hook.timeout !== undefined && !Number.isFinite(Number(hook.timeout))) {
          problems.push(`${event}: timeout is not numeric (${JSON.stringify(hook.timeout)})`);
        }
        const script = /"([^"]+\.mjs)"/.exec(String(hook.command));
        if (script !== null && !existsSync(join(ROOT, script[1]))) {
          problems.push(`${event}: command references a missing script: ${script[1]}`);
        }
      }
    }
  }
  if (config.$pendingPorts?.length > 0) {
    notes.push(`$pendingPorts: ${config.$pendingPorts.length} hook(s) still without a Node port (not enabled by design)`);
  }
}

// -------------------------------------------------- 4. mount-time resolution check
const MOUNT_IMPORTS = [
  '@deepseek-ai/dsh-hook-protocol', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/schemastery', '@deepseek-ai/dsh-hooks-claude-code',
];
// A require anchored INSIDE the profile dir reproduces the loader's resolution base;
// a plain import() would resolve against this script instead and give a false answer.
const profileRequire = createRequire(join(PROFILE_DIR, 'preflight.cjs'));
for (const specifier of MOUNT_IMPORTS) {
  try {
    profileRequire.resolve(specifier);
  } catch {
    problems.push(`the profile cannot resolve ${specifier} — the plugin would fail to mount`);
  }
}
notes.push(`resolution base checked from ${PROFILE_DIR} (${MOUNT_IMPORTS.length} specifiers)`);

// ------------------------------------------- 5. version compatibility of the bridge
// Resolving is not enough. The profile may hold an OLD copy of the bridge — for example
// because another plugin pack depends on it — and the loader then DISABLES the row:
//   disabling profile plugin row "hooks-claude-code": Plugin …@0.1.0-rc.7 is incompatible
//   with dsh 0.2.0-rc.2: peerDependencies { … }
// Hooks then never run, and nothing else reports it. Compare the resolved copy's
// peerDependencies against the running dsh version.
const dshVersion = readDshVersion();
if (dshVersion === undefined) {
  notes.push('could not read the dsh runtime version — peer compatibility NOT checked');
} else if (rowKind === 'direct') {
  // The direct plugin loads the bridge from the RUNNING INSTALLATION at mount time, so a
  // profile-local copy can neither shadow it nor trip the loader's peer check. Verify the
  // resolution the plugin will actually perform.
  let installCopy;
  for (const root of dshRootCandidates()) {
    installCopy = resolvePackageJson(createRequire(join(root, 'preflight.cjs')), '@deepseek-ai/dsh-hooks-claude-code');
    if (installCopy !== undefined) break;
  }
  if (installCopy === undefined) {
    problems.push('the direct plugin cannot resolve @deepseek-ai/dsh-hooks-claude-code from the dsh installation — hooks would not mount');
  } else {
    notes.push(`bridge loaded by the direct plugin: ${installCopy.version} (from the dsh installation; runtime ${dshVersion}) — no profile-local copy can shadow it`);
  }
} else {
  const resolved = resolvePackageJson(profileRequire, '@deepseek-ai/dsh-hooks-claude-code');
  if (resolved === undefined) {
    problems.push('@deepseek-ai/dsh-hooks-claude-code resolves, but its package.json could not be read');
  } else {
    notes.push(`bridge resolved from the profile: ${resolved.version} (runtime dsh ${dshVersion})`);
    const mismatched = [];
    for (const [name, range] of Object.entries(resolved.peers)) {
      // cordis is the host framework's own line, not this runtime's plugin version line.
      if (name === '@deepseek-ai/cordis') continue;
      if (!rangeMatches(range, dshVersion)) mismatched.push([name, range]);
    }
    if (mismatched.length > 0) {
      problems.push(
        `the profile resolves ${resolved.version}, whose peers reject the runtime: `
        + `${mismatched.map(([name, range]) => `${name}@${range}`).join(', ')}. `
        + `The loader disables the row for this. Install the matching version: `
        + `dsh plugin --profile ${PROFILE} add @deepseek-ai/dsh-hooks-claude-code@${dshVersion}`,
      );
    }
    if (resolved.version !== dshVersion) {
      notes.push(`the resolved bridge (${resolved.version}) is not the runtime's own version `
        + `(${dshVersion}) — another copy takes precedence in this profile`);
    }
  }
}

// ------------------------------------------------------------------------ report
console.log(`hooks.json: ${commandCount} command(s) in ${Object.keys(config?.hooks ?? {}).length} event(s)`);
for (const note of notes) console.log(`  note: ${note}`);
if (problems.length === 0) {
  console.log('\nPREFLIGHT OK — nothing static blocks the bridge from mounting.');
  console.log('Next: restart the profile, spawn any subagent, then run tools/check-hooks-live.ps1.');
  process.exit(0);
}
console.log('\nPREFLIGHT PROBLEMS:');
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);

// ------------------------------------------------------------------------ helpers
/** The dsh install roots that can answer "which runtime version is this?". */
function dshRootCandidates() {
  return [
    process.env.DSH_CLI_ROOT,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh') : undefined,
    join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  ].filter((c) => typeof c === 'string');
}

/** Version of the running dsh runtime, or undefined when it cannot be read. */
function readDshVersion() {
  for (const root of dshRootCandidates()) {
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Resolve a package by name from the profile and read its package.json. */
function resolvePackageJson(require, name) {
  let entry;
  try {
    entry = require.resolve(name);
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === name) {
          return { version: pkg.version, peers: pkg.peerDependencies ?? {} };
        }
      } catch {
        /* keep walking up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Minimal semver range check, covering the shapes these rc packages publish
 * (`0.2.0-rc.2` exact pins and `^0.1.0-rc.7`-style carets). An unparseable range or
 * version returns true: this check exists to catch a real line mismatch, not to invent one.
 */
function rangeMatches(range, version) {
  const parse = (value) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim());
    return m === null ? undefined : { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  };
  const v = parse(version);
  const raw = String(range).trim().replace(/^[\^~]/, '');
  const b = parse(raw);
  if (v === undefined || b === undefined) return true;
  const cmp = (a, c) => a.major - c.major || a.minor - c.minor || a.patch - c.patch;
  if (String(range).startsWith('^')) {
    if (b.major > 0) return v.major === b.major && cmp(v, b) >= 0;
    if (b.minor > 0) return v.major === b.major && v.minor === b.minor && cmp(v, b) >= 0;
    return cmp(v, b) === 0;
  }
  if (String(range).startsWith('~')) return v.major === b.major && v.minor === b.minor && cmp(v, b) >= 0;
  return cmp(v, b) === 0;
}

function loadJsYaml() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/index.js'),
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/dist/js-yaml.js'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return createRequire(import.meta.url)(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}




