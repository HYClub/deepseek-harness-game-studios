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
 *   1. the hooks row exists: either an `insert` entry in the profile patch, or the plugin package
 *      listed in the profile's `dsh.profile.bundles` (the plugin-manager install every user has);
 *   2. the hook config exists and is this project's generated `.dsh/hooks.json`;
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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const PROFILE = process.env.DSH_PROFILE ?? 'web';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', PROFILE);
// `DSH_PROFILE_DIR` and `DSH_PROFILE` can disagree (a shell that exports both). The directory is the
// one this script reads, so its basename is the name a suggested command must use.
const PROFILE_LABEL = process.env.DSH_PROFILE_DIR !== undefined ? basename(PROFILE_DIR) : PROFILE;
const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd());

const problems = [];
const notes = [];

console.log(`dsh home : ${DSH_HOME}`);
console.log(`profile  : ${PROFILE_LABEL} (${PROFILE_DIR})`);
console.log(`project  : ${ROOT}`);

// -------------------------------------------------------------- 1. the mounting row
//
// Three ways the hooks can be mounted, and only one of them is a patch entry:
//  - `plugin`: a plugin-manager install. The package is listed in the profile's
//    `dsh.profile.bundles` and inserts its own rows, so the profile patch legitimately has no
//    `insert` entry. This is the path every user has, and requiring a patch entry made a healthy
//    install fail this check.
//  - `direct`: a hand-wired `insert` row naming our plugin (`file://…` or `dsgs-hooks`). Spawns
//    hook commands directly and pins their cwd to the project — immune to the sandbox refusal
//    that silently turns every hook into a no-op when the harness was launched from a directory
//    containing `%TEMP%` (see the repository README's "Known limits").
//  - `bridge`: a row naming the official `@deepseek-ai/dsh-hooks-claude-code`. Hook commands run
//    through the sandboxed shell service.
const patchPath = join(PROFILE_DIR, 'cordis.patch.yml');
let configPath;
let rowKind = 'unknown';
let pluginRoot;
let entry;

// The profile patch first: a hand-wired row is the more specific claim, and a machine can have both
// a patch row and a bundle install. Checking the bundle first skipped the patch entirely there.
const patch = readPatchRows(patchPath);
if (patch.error !== undefined) problems.push(patch.error);
entry = patch.rows.find((e) => e?.id === 'hooks-claude-code')
  ?? patch.rows.find((e) => typeof e?.config?.configPath === 'string');

if (entry !== undefined) {
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
} else {
  pluginRoot = findBundlePlugin(PROFILE_DIR);
  if (pluginRoot === undefined) {
    problems.push(existsSync(patchPath)
      ? 'no `insert` entry carrying a hooks configPath in the profile patch, and no plugin package in the profile bundle list that mounts the hooks'
      : `profile patch not found: ${patchPath}`);
  } else {
    rowKind = 'plugin';
    notes.push(`row mounted from the profile bundle list: ${pluginRoot}`);
    // The plugin finds the project's config by walking up from the launch directory; replicate that
    // from the project passed to this script, and honour the explicit override it also supports.
    const override = process.env.DSH_DSGS_HOOKS_CONFIG;
    configPath = typeof override === 'string' && override.length > 0 ? override : findHookConfig(ROOT);
    if (configPath === undefined) {
      problems.push(`no .dsh/hooks.json found above ${ROOT} — this folder is not initialised (run /start first)`);
    } else {
      notes.push(`hooks config: ${configPath}${typeof override === 'string' && override.length > 0 ? ' (DSH_DSGS_HOOKS_CONFIG)' : ' (found by walking up from the project)'}`);
    }
  }
}

// ------------------------------------------------------------- 2. config file
// The project the hooks belong to. A plugin install finds its config by walking up from the launch
// directory, so running this from a subdirectory is normal — using the argument as the project root
// there turned every hook command into "missing script". A config that belongs to a project the
// argument is *not* inside is the opposite case: the hooks would fire against another tree.
let projectRoot = ROOT;
let config;
if (typeof configPath === 'string') {
  if (!existsSync(configPath)) {
    problems.push(`configPath does not exist: ${configPath}`);
  } else {
    projectRoot = dirname(dirname(resolve(configPath)));
    if (!isInside(projectRoot, ROOT)) {
      problems.push(`configPath points at ${configPath}, which is not inside ${ROOT} — the hooks would run against another project`);
    } else if (resolve(projectRoot).toLowerCase() !== resolve(ROOT).toLowerCase()) {
      notes.push(`the hooks belong to ${projectRoot} (found by walking up from ${ROOT})`);
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
        if (script !== null && !existsSync(join(projectRoot, script[1]))) {
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
if (rowKind === 'direct' || rowKind === 'plugin') {
  // The direct row hands the bridge an executor and calls `apply()` itself: the loader never
  // resolves these specifiers against the profile, so requiring the profile to hold them would
  // report a failure that cannot happen. Section 5 checks what the plugin actually resolves.
  notes.push('resolution base: the plugin resolves the bridge from the running installation, its package, then the profile (checked below)');
} else {
  for (const specifier of MOUNT_IMPORTS) {
    try {
      profileRequire.resolve(specifier);
    } catch {
      problems.push(`the profile cannot resolve ${specifier} — the plugin would fail to mount`);
    }
  }
  notes.push(`resolution base checked from ${PROFILE_DIR} (${MOUNT_IMPORTS.length} specifiers)`);
}

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
} else if (rowKind === 'direct' || rowKind === 'plugin') {
  // Both rows run our plugin, which resolves the bridge from the RUNNING INSTALLATION first and its
  // own package dependencies second, so a profile-local copy can neither shadow it nor trip the
  // loader's peer check. Reproduce those lookups, in the plugin's order. A desktop app keeps the
  // runtime inside `app.asar`, which plain Node cannot read, so a packed candidate is skipped and
  // reported instead of producing a failure that cannot be true.
  let installCopy;
  const bases = [];
  if (rowKind === 'plugin' && pluginRoot !== undefined) bases.push(join(pluginRoot, 'preflight.cjs'));
  if (rowKind === 'direct' && typeof entry?.name === 'string' && entry.name.startsWith('file://')) {
    bases.push(fileURLToPath(entry.name));
  }
  bases.push(join(PROFILE_DIR, 'preflight.cjs'));
  for (const root of dshRootCandidates()) {
    if (!root.includes('.asar')) bases.push(join(root, 'preflight.cjs'));
  }
  for (const base of bases) {
    installCopy = resolvePackageJson(createRequire(base), '@deepseek-ai/dsh-hooks-claude-code');
    if (installCopy !== undefined) {
      // Print where it ACTUALLY resolved, not the require anchor: on a profile install the anchor is
      // the plugin package, while the bridge itself comes from the profile (or the app) — naming the
      // anchor sent a reader to the wrong directory.
      let resolvedEntry;
      try {
        resolvedEntry = createRequire(base).resolve('@deepseek-ai/dsh-hooks-claude-code');
      } catch {
        resolvedEntry = base;
      }
      notes.push(`bridge resolved from ${resolvedEntry}: ${installCopy.version}`);
      break;
    }
  }
  const packed = dshRootCandidates().filter((root) => root.includes('.asar'));
  if (packed.length > 0) {
    notes.push(`the running dsh is packed (${packed[0]}): plain Node cannot read it, so the app's own require is what loads the bridge at mount time — not verifiable here`);
  }
  if (installCopy === undefined) {
    if (packed.length > 0) notes.push('bridge resolution could not be checked outside the app (see the packed-runtime note above) — not counted as a problem');
    else problems.push('the plugin cannot resolve @deepseek-ai/dsh-hooks-claude-code from the package, the profile, or the dsh installation — hooks would not mount');
  } else {
    notes.push(`bridge loaded by the plugin: ${installCopy.version} (runtime ${dshVersion}) — no profile-local copy can shadow it`);
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
        + `dsh plugin --profile ${PROFILE_LABEL} add @deepseek-ai/dsh-hooks-claude-code@${dshVersion}`,
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
/**
 * The insert rows of a profile patch, parsed with the js-yaml that ships inside the dsh install.
 * @param {string} patchPath - the profile's cordis.patch.yml
 * @returns {{ rows: object[], error?: string }} the insert rows, or the reason they could not be read
 */
function readPatchRows(patchPath) {
  if (!existsSync(patchPath)) return { rows: [] };
  const jsYaml = loadJsYaml();
  if (jsYaml === undefined) return { rows: [], error: 'could not load js-yaml from the dsh install to read the profile patch' };
  let doc;
  try {
    doc = jsYaml.load(readFileSync(patchPath, 'utf8'));
  } catch (error) {
    return { rows: [], error: `profile patch is not valid YAML: ${error.message}` };
  }
  const rows = Array.isArray(doc)
    ? doc.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
    : [];
  return { rows };
}

/** Is `child` the same path as `parent`, or inside it? Case-insensitive on Windows. */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The project's hook config, found the way the plugin finds it: walk up from a directory. */
function findHookConfig(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.dsh', 'hooks.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Is a plugin-manager install mounting the hooks? A bundle package is recorded in the profile's
 * `dsh.profile.bundles` and inserts its own rows, so the row is identified from the package's
 * `cordis.patch.yml` rather than from the profile patch. The test is structural (an `id: dsgs-hooks`
 * row, or an insert whose `name` ends in `/hooks`), not a substring: a comment mentioning
 * `dsgs-hooks` must not make an unrelated package look like ours.
 * @param {string} profileDir - the profile directory
 * @returns {string | undefined} the installed package directory, or undefined
 */
function findBundlePlugin(profileDir) {
  const pkgPath = join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return undefined;
  }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  for (const name of bundles) {
    if (typeof name !== 'string') continue;
    const dir = join(profileDir, 'node_modules', name);
    const patch = join(dir, 'cordis.patch.yml');
    if (!existsSync(patch)) continue;
    let text;
    try {
      text = readFileSync(patch, 'utf8');
    } catch {
      continue;
    }
    const hasOurRow = /^\s*(?:-\s*)?id:\s*['"]?dsgs-hooks['"]?\s*$/m.test(text)
      || /^\s*-\s*name:\s*['"]?[^'"\r\n]*\/hooks['"]?\s*$/m.test(text);
    if (!hasOurRow) continue;
    return dir;
  }
  return undefined;
}

/** The dsh install roots that can answer "which runtime version is this?". */
function dshRootCandidates() {
  return [
    // The authoritative path on a desktop app install (points inside app.asar, which only the app's
    // own require can read) and on a CLI install alike.
    process.env.DSH_INSTALL_DIR,
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




