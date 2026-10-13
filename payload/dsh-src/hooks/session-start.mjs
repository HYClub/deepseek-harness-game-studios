#!/usr/bin/env node
/**
 * session-start.mjs — DSH (Node) port of `.claude/hooks/session-start.sh` (319 lines).
 *
 * WHY THIS EXISTS
 *   The bash original cannot run inside the DSH sandbox: Git Bash (MSYS2) cannot create its
 *   signal pipes, WSL bash is denied, and piped child stdio is denied as well. So this port is
 *   Node built-ins only, and no subprocess output ever travels over a pipe.
 *
 * OUTPUT SHAPE
 *   The original `echo`ed one text block to stdout. DSH carries context through
 *   `context(event, text)`, so the banner is assembled in memory and emitted ONCE with
 *   hookEventName = the event we were actually called as (SessionStart).
 *
 * SUBPROCESSES AND CONFIG GO THROUGH dsh-src/hooks/_capture.mjs
 *   `runtime.capture()` wraps a command in POSIX shell syntax (`{ cmd ; } > file 2>&1`) and runs
 *   it with `shell: true`, i.e. cmd.exe on Windows, which rejects the wrapper before the real
 *   command starts (`'{' is not recognized ...`, status 1 for every call). `resolveConfig()`
 *   delegates to it and is therefore dead too. runtime.mjs is a protected file (PORTING.md
 *   §边界), so the shared runner `_capture.mjs` does the same job the contract describes —
 *   output redirected into a private temp file through a file descriptor, never a pipe — and the
 *   hooks import it. Config reads run the very same
 *   `node tools/yaml-helper.mjs resolve_config --keys …` command and parse its output with the
 *   regex runtime.resolveConfig() uses, so the label semantics are unchanged.
 *
 * CONFIG READS (two mechanisms, on purpose)
 *   - `resolve_config --keys` for what the original resolved with `resolve_setting`:
 *     `review_mode` and `engine` (the latter is a strict project.yaml `engine.name` read
 *     inside the helper, exactly like the original's awk).
 *   - the helper's documented `__call` dispatcher for the source-level functions the
 *     `resolve_config --keys` label surface cannot express:
 *       `validate_yaml_enum` / `validate_local_yaml_base` (schema observation),
 *       `get_yaml_key project.yaml project.stage` (STRICT project.yaml read — the
 *         `project.stage` label runs the full chain, which falls through to the legacy
 *         mirror and would silently suppress the stage-agreement warning),
 *       `resolve_code_root` (engine -> code dir mapping).
 *     `features.session_state` comes from the shared `_session-state.mjs` predicate, which calls
 *     the helper's `session_state_enabled` and keeps the fail-open default.
 *     This is still tools/yaml-helper.mjs; no YAML is parsed here.
 *   - When tools/yaml-helper.mjs is absent the affected checks are announced on STDERR as
 *     NOT RUN. They are never silently reported as having passed.
 *
 * DROPPED (upstream-runtime-only mechanisms) + reason
 *   - upstream project-dir / `$BASH_SOURCE` root discovery -> runtime.projectRoot(input):
 *     same precedence (cwd holding project.yaml or .dsh/, then the payload cwd, then this
 *     script's own tree).
 *   - `source .claude/hooks/yaml-helper.sh` (+ python/jq fallbacks) -> tools/yaml-helper.mjs.
 *   - grep/sed/awk/find/wc/git pipelines -> Node built-ins; `git` via the shared runner.
 *   - `.claude/...` paths in user-facing text -> `.dsh/...` (the generated DSH tree).
 *   - The upstream runtime's "hook output past 10,000 characters is cut to a 2,000-character preview":
 *     DSH documents no such cap, so that reason for the checkpoint cap is gone. The
 *     25-line / 3,000-character cap is KEPT anyway as the token budget the same comment names.
 *   - The FIRE/DONE diagnostic paragraph and the bounded-stdin warning describe the bash
 *     harness; kept as historical notes below, no behaviour attaches to them.
 *
 * INTENTIONAL BEHAVIOUR DIVERGENCES (benign, listed rather than hidden)
 *   - A non-zero `git rev-parse --abbrev-ref HEAD` (e.g. an unborn branch) prints no Branch
 *     line. bash's `2>/dev/null` assignment kept git's stdout, printing a misleading
 *     `Branch: HEAD` followed by an empty commit list; merged output leaves the exit status as
 *     the only honest signal.
 *   - The output ordering is unchanged: sprint/milestone, bugs, code health and the
 *     engine-reference mismatch all print BEFORE the session-state block, because hook output
 *     gets truncated at the end, not the start.
 *   - `capture`/`resolveConfig` trim the whole command output, which eats the LEADING tab of
 *     `resolve_code_root`'s empty result (`\tunset` arrives as `unset`); `firstTabField` below
 *     reads that shape correctly instead of inventing a code root named `unset`.
 *
 * The original's budget note still applies: this hook must finish fast, because a hook that is
 * killed partway leaves the session starting blind. Helper calls are made only when the file
 * they read exists, so a bare project pays for none of them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, git } from './_capture.mjs';
import { normaliseInput, sessionStateEnabled } from './_session-state.mjs';
import { run, readInput, projectRoot, context } from './runtime.mjs';

/** The original's STATE_FILE, repo-relative (project assets keep their paths). */
const STATE_FILE = 'production/session-state/active.md';
/** Templates live in the generated DSH tree now. */
const STATE_TEMPLATE = '.dsh/docs/templates/session-state.md';

/** Rendered banner lines. */
const out = [];
const w = (line = '') => out.push(line);
/** Checks that could not run, for stderr (never silently counted as passed). */
const notRun = [];
const announce = (text) => notRun.push(text);

// --- small fs/path helpers ---------------------------------------------------

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const readTextOr = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** First line, CR stripped — `head -1 | tr -d '\r'`. */
function firstLine(text) {
  const i = text.indexOf('\n');
  return (i === -1 ? text : text.slice(0, i)).replace(/\r/g, '');
}

/** Last non-empty line of merged output (git's own value is printed after any warning). */
function lastNonEmptyLine(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter((l) => l !== '');
  return lines.length === 0 ? '' : lines[lines.length - 1];
}

/**
 * First tab-separated field of a helper result. `resolve_code_root` prints `<dir>\t<source>`,
 * and capture() trims the whole output — which eats the LEADING tab of the empty-dir case
 * (`\tunset` arrives as `unset`). So a missing tab means the dir field is empty, not that the
 * whole value is the directory. Reading it as the directory invented a code root named `unset`
 * and silently suppressed the code-health line.
 */
function firstTabField(text) {
  const line = String(text).split('\n')[0];
  return line.includes('\t') ? line.split('\t')[0].trim() : '';
}

/** `ls -t <dir>/<pattern>` newest-first, name-ascending on an mtime tie. */
function newestMatching(dir, re) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const hits = [];
  for (const entry of entries) {
    if (!re.test(entry.name)) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(dir, entry.name)).mtimeMs;
    } catch {
      mtime = 0;
    }
    hits.push({ name: entry.name, mtime });
  }
  hits.sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return hits.length === 0 ? '' : hits[0].name;
}

/** `find <dir> -name <pattern> | wc -l` — matches files AND directories, does not follow links. */
function countEntriesNamed(dir, re) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (re.test(entry.name)) count += 1;
      if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
  return count;
}

/**
 * `grep -rI --include=<exts> -c`-style count: matching LINES over source files only.
 * NUL-containing files are skipped, which is what grep's -I does for binaries.
 */
function countMarkerLines(dir, exts, marker) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1 || !exts.has(entry.name.slice(dot).toLowerCase())) continue;
      const text = readTextOr(full);
      if (text === '' || text.includes('\u0000')) continue;
      for (const line of text.split('\n')) {
        if (line.includes(marker)) count += 1;
      }
    }
  }
  return count;
}

// --- tools/yaml-helper.mjs access -------------------------------------------
// All of it runs through the shared runner (see the header): the contract's capture() cannot
// start a command on Windows at all.

const helperFile = (root) => join(root, 'tools', 'yaml-helper.mjs');

/** Run a helper source-level function; null when the helper is not present. */
function helperCall(root, args) {
  if (!existsSync(helperFile(root))) return null;
  return runCommand(process.execPath, ['tools/yaml-helper.mjs', '__call', ...args], { cwd: root });
}

/** `resolve_config --keys` -> { label: { value, source } }; null when the helper is absent. */
function configLabels(root, labels) {
  if (!existsSync(helperFile(root))) return null;
  const result = runCommand(
    process.execPath,
    ['tools/yaml-helper.mjs', 'resolve_config', '--keys', labels.join(',')],
    { cwd: root },
  );
  const parsed = {};
  for (const [label, raw] of Object.entries(parseConfigOutput(result.stdout))) {
    const m = /^([\s\S]*?)\s*\(([^()]*)\)$/.exec(raw);
    const value = (m ? m[1] : raw).trim();
    parsed[label] = { value: value === 'not set' || value === 'unset' ? '' : value, source: m ? m[2].trim() : '' };
  }
  return parsed;
}

/** The parse runtime.resolveConfig() applies to `resolve_config --keys` output. */
function parseConfigOutput(stdout) {
  const values = {};
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*([\w.]+)\s*[:=]\s*(.*)$/.exec(line);
    if (m !== null) values[m[1]] = m[2].trim();
  }
  return values;
}

// --- the hook ----------------------------------------------------------------

run(async () => {
  // normaliseInput: readInput() hands back whatever JSON.parse produced, and a payload of
  // literal `null` would make projectRoot() throw — a hook that silently does nothing.
  const input = normaliseInput(readInput());
  const event = String(input.hook_event_name ?? 'SessionStart');
  const root = projectRoot(input);
  const hasHelper = existsSync(helperFile(root));
  const hasProjectYaml = existsSync(join(root, 'project.yaml'));

  w('=== DeepSeek Game Studios — Session Context ===');

  // --- git context -----------------------------------------------------------
  const branchRes = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const branch = branchRes.status === 0 ? lastNonEmptyLine(branchRes.stdout) : '';
  if (branch !== '') {
    w(`Branch: ${branch}`);
    w('');
    w('Recent commits:');
    const logRes = git(['log', '--oneline', '-5'], { cwd: root });
    if (logRes.status === 0) {
      for (const line of logRes.stdout.split('\n')) {
        const clean = line.replace(/\r/g, '').trim();
        if (clean !== '') w(`  ${clean}`);
      }
    }
  }

  // --- review mode -----------------------------------------------------------
  // Full chain first (rigor expansion + local override), then the legacy mirror, then the
  // documented default: rigor `minimal` resolves review_mode to `solo`, which is what every
  // skill runs with nothing configured.
  const labels = configLabels(root, ['review_mode', 'engine']);
  let reviewMode = labels?.review_mode?.value ?? '';
  if (reviewMode === '' && existsSync(join(root, 'production/review-mode.txt'))) {
    reviewMode = firstLine(readTextOr(join(root, 'production/review-mode.txt'))).replace(/\s+/g, '');
  }
  if (reviewMode === '') reviewMode = 'solo';
  w('');
  w(`Review mode: ${reviewMode}`);
  if (hasProjectYaml && (labels === null || !labels.review_mode)) {
    announce('review_mode could not be resolved from project.yaml'
      + ` (${hasHelper ? 'yaml-helper failed' : 'tools/yaml-helper.mjs is missing'})`
      + ' — it fell back to production/review-mode.txt, then to `solo`');
  }

  // --- schema validation -----------------------------------------------------
  if (hasHelper) {
    // Hard-error guard: project.local.yaml requires a project.yaml base. The helper returns 0
    // with no output when there is no local file, so only spawn it when there is one.
    if (existsSync(join(root, 'project.local.yaml'))) {
      const base = helperCall(root, ['validate_local_yaml_base']);
      const baseText = base === null ? '' : base.stdout.trim();
      if (base !== null && base.status !== 0 && baseText !== '') {
        w('');
        w(`[!] ${baseText}`);
      }
    }
    for (const file of ['project.yaml', 'project.local.yaml']) {
      if (!existsSync(join(root, file))) continue;
      const res = helperCall(root, ['validate_yaml_enum', file]);
      const text = res === null ? '' : res.stdout.trim();
      if (text !== '') {
        w('');
        w(`[!] ${file} schema errors:`);
        for (const line of text.split('\n')) w(`    ${line.replace(/\r/g, '')}`);
      }
    }
  } else if (hasProjectYaml || existsSync(join(root, 'project.local.yaml'))) {
    announce('project.yaml / project.local.yaml schema validation did not run'
      + ' (tools/yaml-helper.mjs is missing)');
  }

  // --- stage source agreement -------------------------------------------------
  // `project.stage` is authoritative; production/stage.txt is a legacy mirror twelve consumers
  // still read. Warn, never reconcile: only /gate-check may advance a stage.
  let stageYaml = '';
  if (hasProjectYaml) {
    const res = helperCall(root, ['get_yaml_key', 'project.yaml', 'project.stage']);
    if (res === null) {
      announce('the project.yaml vs production/stage.txt stage-agreement check did not run'
        + ' (tools/yaml-helper.mjs is missing)');
    } else if (res.status === 0) {
      stageYaml = firstLine(res.stdout).trim();
    }
  }
  let stageTxt = '';
  const stageFile = join(root, 'production/stage.txt');
  if (existsSync(stageFile)) stageTxt = firstLine(readTextOr(stageFile)).replace(/\s+$/, '');
  if (stageYaml !== '' && stageTxt !== '' && stageYaml !== stageTxt) {
    w('');
    w('[!] Stage sources disagree:');
    w(`      project.yaml  project.stage : ${stageYaml}   (authoritative)`);
    w(`      production/stage.txt        : ${stageTxt}   (legacy mirror)`);
    w('    Twelve consumers read the mirror, so part of the system is acting on');
    w('    each value. Only /gate-check should change a stage (on a PASS, or a');
    w('    CONCERNS whose risks you accepted) — do not hand-edit either file to');
    w('    silence this.');
  }

  // --- sprint / milestone -----------------------------------------------------
  const sprint = newestMatching(join(root, 'production/sprints'), /^sprint-.*\.md$/);
  if (sprint !== '') {
    w('');
    w(`Active sprint: ${sprint.slice(0, -3)}`);
  }
  const milestone = newestMatching(join(root, 'production/milestones'), /\.md$/);
  if (milestone !== '') w(`Active milestone: ${milestone.slice(0, -3)}`);

  // --- open bugs --------------------------------------------------------------
  let bugCount = 0;
  for (const dir of ['tests/playtest', 'production']) {
    if (isDir(join(root, dir))) bugCount += countEntriesNamed(join(root, dir), /^BUG-.*\.md$/);
  }
  if (bugCount > 0) w(`Open bugs: ${bugCount}`);

  // --- code health ------------------------------------------------------------
  // Reads the ENGINE-SPECIFIC code root. Only called when a candidate root exists at all, so a
  // bare project pays for no helper spawn; the original called resolve_code_root always and
  // then discarded the empty result.
  const hasCandidateRoot = ['src', 'Assets', 'Source'].some((d) => isDir(join(root, d)));
  if (hasCandidateRoot) {
    const res = helperCall(root, ['resolve_code_root']);
    if (res === null) {
      announce('the code-health TODO/FIXME scan did not run (tools/yaml-helper.mjs is missing)');
    } else if (res.status === 0) {
      const codeRoot = firstTabField(res.stdout);
      if (codeRoot !== '' && isDir(join(root, codeRoot))) {
        // Source files only, binaries skipped: an unfiltered grep over Unity's Assets/ read
        // every texture and audio file inside this hook's budget.
        const exts = new Set(['.gd', '.cs', '.cpp', '.h', '.hpp', '.c', '.py', '.rs', '.lua']);
        const todo = countMarkerLines(join(root, codeRoot), exts, 'TODO');
        const fixme = countMarkerLines(join(root, codeRoot), exts, 'FIXME');
        if (todo > 0 || fixme > 0) {
          w('');
          w(`Code health: ${todo} TODOs, ${fixme} FIXMEs in ${codeRoot}/`);
        }
      }
    }
  }

  // --- engine reference vs configured engine ----------------------------------
  // An OBSERVATION, never an action. Printed BEFORE the session state: hook output is cut at
  // the end, so a warning below a long checkpoint could be lost.
  // The anchor may live in the DSH instruction file (AGENTS.md) or in the content-source
  // instruction file, so scan both and report which one carried it.
  if (hasProjectYaml) {
    const engineName = labels?.engine?.value ?? '';
    const cfg = engineName.split(/[\s#]/).filter((part) => part !== '')[0]?.toLowerCase() ?? '';
    let eri = '';
    let eriSource = '';
    for (const instructionName of ['AGENTS.md', 'CLAUDE.md']) {
      for (const raw of readTextOr(join(root, instructionName)).split('\n')) {
        const m = /docs\/engine-reference\/([a-z]+)\/VERSION\.md/.exec(raw.replace(/\r/g, ''));
        if (m !== null) {
          eri = m[1];
          eriSource = instructionName;
          break;
        }
      }
      if (eri !== '') break;
    }
    if (eri !== '' && cfg !== '' && eri !== cfg) {
      w('');
      w('!! ENGINE REFERENCE MISMATCH');
      w(`   project.yaml engine.name : ${cfg}`);
      w(`   ${eriSource} imports     : docs/engine-reference/${eri}/VERSION.md`);
      w(`   Every session is loading the ${eri} reference on a ${cfg} project.`);
      w('   Fix: re-run /setup-engine, or edit the ENGINE-REFERENCE-IMPORT line.');
    }
  }

  // --- active session state recovery ------------------------------------------
  // Only THIS block is gated by features.session_state, not the whole hook: git/sprint/stage
  // context is not part of the session-state pipeline. Fail OPEN: an unreadable flag must not
  // suppress the one piece of output whose absence the user cannot notice.
  const statePath = join(root, STATE_FILE);
  if (existsSync(statePath)) {
    // Shared predicate: helper's `session_state_enabled`, fail-open default, and its own stderr
    // announcement when tools/yaml-helper.mjs is missing.
    if (sessionStateEnabled(root)) {
      w('');
      w('=== ACTIVE SESSION STATE DETECTED ===');
      w(`A previous session left state at: ${STATE_FILE}`);
      w('Read this file to recover context and continue where you left off.');
      w('');
      const text = readTextOr(statePath);
      // wc -l counts newlines, not lines; a file without a final newline is one short.
      const totalLines = (text.match(/\n/g) ?? []).length;
      const cpOpen = (text.match(/<!-- CHECKPOINT -->/g) ?? []).length;
      const cpClose = (text.match(/<!-- \/CHECKPOINT -->/g) ?? []).length;
      const checkpoint = extractCheckpoint(text);
      if (cpOpen > 0 && cpClose === 0) {
        // A sed range whose END never matches runs to EOF, so an unterminated block used to be
        // previewed as recoverable state with no warning. Emptiness cannot tell "no block" from
        // "unterminated block"; only the markers can, so test them directly.
        w('  [!] CHECKPOINT block is not terminated — no <!-- /CHECKPOINT --> marker.');
        w('      Not previewing it: without the closing marker the checkpoint');
        w('      cannot be told from the narrative, and everything to the end');
        w('      of the file would be shown as if it were recoverable state.');
        w(`      Re-create from ${STATE_TEMPLATE}.`);
        w(`  ... (${totalLines} total lines — read the full file to continue)`);
      } else if (checkpoint !== '') {
        w('Checkpoint:');
        const cpLines = checkpoint.split('\n');
        let cut = false;
        let printed = 0;
        let chars = 0;
        for (const line of cpLines) {
          printed += 1;
          chars += line.length + 1;
          if (printed > 25 || chars > 3000) {
            cut = true;
            break;
          }
          w(line);
        }
        if (cut) w(`  ... checkpoint truncated (${cpLines.length} lines) — read ${STATE_FILE} for the rest`);
        w(`  ... (${totalLines} total lines — read the full file for detail)`);
      } else {
        w('Quick summary (first 20 lines — no CHECKPOINT block in this file):');
        for (const line of text.split('\n').slice(0, 20)) w(line.replace(/\r/g, ''));
        w(`  ... (${totalLines} total lines — read the full file to continue)`);
        w(`  NOTE: re-create from ${STATE_TEMPLATE} so`);
        w('        recovery reads a bounded checkpoint instead of a slice.');
      }
      // Rotation is an OBSERVATION, never an action. Needs Git Bash on Windows.
      if (totalLines > 200) {
        w(`  Note: ${totalLines} lines. Narrative can be rotated into`);
        w('        production/session-logs/ — bash .dsh/scripts/rotate-session-state.sh');
      }
      w('=== END SESSION STATE PREVIEW ===');
    }
  }

  w('===================================');

  context(event, out.join('\n'));
  for (const note of notRun) process.stderr.write(`session-start: NOT RUN — ${note}\n`);
});

/**
 * The CHECKPOINT region — the same region pre-compact reads:
 * `sed -n '/<!-- CHECKPOINT -->/,/<!-- \/CHECKPOINT -->/p' | grep -v '<!-- /\?CHECKPOINT -->'`.
 * Command substitution strips trailing newlines, so the result does too.
 */
function extractCheckpoint(text) {
  const kept = [];
  let inRange = false;
  for (const line of text.split('\n')) {
    if (!inRange) {
      if (/<!-- CHECKPOINT -->/.test(line)) {
        inRange = true;
        if (!/<!-- \/?CHECKPOINT -->/.test(line)) kept.push(line);
      }
      continue;
    }
    if (!/<!-- \/?CHECKPOINT -->/.test(line)) kept.push(line);
    if (/<!-- \/CHECKPOINT -->/.test(line)) inRange = false;
  }
  return kept.join('\n').replace(/\n+$/, '');
}
