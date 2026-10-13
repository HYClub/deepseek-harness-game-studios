/**
 * DSH hook runtime — the contract every ported DSGS hook builds on.
 *
 * Source: `dsh-src/hooks/runtime.mjs`; generated copy: `.dsh/hooks/runtime.mjs`.
 * Hooks run through @deepseek-ai/dsh-hooks-claude-code, so the wire protocol is
 * the upstream runtime's:
 *
 *   stdin  : JSON payload, always carrying session_id, cwd, hook_event_name (+ per-event fields)
 *   exit 0 : allow; stdout starting with `{` is parsed as a structured decision
 *   exit 2 : block; stderr becomes the model-visible reason
 *
 * Structured stdout fields that are actually honoured (dsh-hook-protocol):
 *   { "continue": false, "stopReason": "…" }                  → stop the turn
 *   { "systemMessage": "…" }                                  → user-visible notice
 *   { "decision": "approve" | "block", "reason": "…" }        → legacy top level
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *       "permissionDecision": "allow" | "deny" | "ask",
 *       "permissionDecisionReason": "…",
 *       "additionalContext": "…" } }
 *
 * `hookSpecificOutput` fields are DISCARDED unless `hookEventName` equals the firing
 * event, so always build them with the event you received.
 *
 * Sandbox note: this harness denies piped child stdio (`spawn ... EPERM`), and
 * Git Bash/WSL bash cannot start at all. `capture()` therefore runs a command with
 * its output redirected to a temp file through a shell, never through a pipe.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The event names the bridge fires, for validating what a hook was called as. */
export const EVENTS = [  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'PostCompact',
];

/** Read and parse the hook payload from stdin. Returns {} when there is none. */
export function readInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim().length === 0) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Project root, in the same precedence the DSGS bash hooks use:
 *   1. cwd holding project.yaml   (a configured project root)
 *   2. cwd holding .dsh/          (this framework's root)
 *   3. the hook payload's cwd
 *   4. this script's location     (`.dsh/hooks/` → two levels up)
 * Never an upward search: a nested project must read itself.
 */
export function projectRoot(input = {}) {
  const candidates = [process.cwd(), input.cwd, resolve(HERE, '..', '..')];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (existsSync(join(candidate, 'project.yaml')) || existsSync(join(candidate, '.dsh'))) {
      return resolve(candidate);
    }
  }
  return resolve(HERE, '..', '..');
}

/**
 * Run a command line through a shell and return its combined output, without
 * touching a pipe: stdout+stderr are redirected into a private temp file.
 *
 * PREFER `_capture.mjs`'s `runCommand(file, args)` / `git(args)` for new code: an
 * argv spawn needs no shell, so nothing has to re-parse quoting. This function stays
 * for a raw shell line (the config resolver uses it), and it does work — an earlier
 * version wrapped the command in POSIX `{ cmd ; }` syntax, which cmd.exe cannot
 * parse, so every call failed on Windows until it was fixed on 2026-10-08. File
 * headers in this tree that still call `capture()` "dead on Windows" are historical.
 *
 * @returns {{ status: number, stdout: string }}
 */
export function capture(commandLine, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeoutMs ?? 20_000;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-'));
  const outFile = join(dir, 'out.txt');
  try {
    // The redirect must be understood by the shell that actually runs it. A POSIX
    // `{ cmd ; }` group is a syntax error under cmd.exe — which is what
    // `shell: true` uses on Windows — so Windows gets an explicit `cmd /d /s /c`
    // with the plain redirect form instead. Both paths avoid pipes: the sandbox
    // denies piped child stdio.
    const result = process.platform === 'win32'
      ? spawnSync('cmd', ['/d', '/s', '/c', `${commandLine} > "${outFile}" 2>&1`], {
        cwd, shell: false, stdio: 'ignore', timeout, windowsHide: true, windowsVerbatimArguments: true,
      })
      : spawnSync(`${commandLine} > "${outFile}" 2>&1`, {
        cwd, shell: true, stdio: 'ignore', timeout,
      });
    const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
    return { status: result.status ?? 1, stdout };
  } catch (error) {
    return { status: 1, stdout: `capture failed: ${error?.message ?? String(error)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve project configuration through the DSH-native resolver
 * (`tools/yaml-helper.mjs`), which replaces the bash+Python helper.
 * @param {string[]} keys dotted setting paths
 * @returns {{ status: number, stdout: string, values: Record<string, string> }}
 */
export function resolveConfig(keys, options = {}) {
  const root = options.root ?? projectRoot(options.input ?? {});
  const result = capture(`node tools/yaml-helper.mjs resolve_config --keys ${keys.join(',')}`, {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  const values = {};
  for (const line of result.stdout.split('\n')) {
    const m = /^\s*([\w.]+)\s*[:=]\s*(.*)$/.exec(line);
    if (m !== null) values[m[1]] = m[2].trim();
  }
  return { ...result, values };
}

/** Emit a structured decision: the hook succeeded and wants to say something. */
export function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

/** Allow, with extra context for the model (the hook's usual "note" channel). */
export function context(event, text) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** Allow, with a user-visible notice. */
export function notifyUser(message) {
  emit({ systemMessage: message });
}

/**
 * Advisory warning: reaches the user (systemMessage) AND the model
 * (additionalContext), and deliberately sets no permissionDecision — an explicit
 * "allow" would skip the user's permission prompt. Parity with the bash
 * `hook_warn` helper. Call it once, as the hook's last output, then exit 0.
 *
 * `DSGS_ADVISORY=deny` escalates the advisory into a **pre-action block**: the text becomes the
 * denial reason, which DSH does deliver to the model before the tool runs (measured: the `ask`
 * reason does *not* survive, the `deny` reason does). That is a policy choice, not the default —
 * upstream's own semantics is "warn and continue".
 *
 * @param {string} event - the firing hook event, used for `hookEventName`
 * @param {string} message - the advisory text
 */
export function warn(event, message) {
  if (advisoryMode() === 'deny') {
    emit({
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    })
    return
  }
  emit({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  })
}

/**
 * How advisories are delivered.
 *
 * `post` (default) keeps upstream's behaviour: a notice that arrives with the tool result on the
 * PostToolUse channel. `deny` turns the same text into a pre-action block, which is the only
 * pre-execution channel DSH deliver（见仓库 README 的说明）
 * README's "Known platform limits").
 *
 * @returns {'post' | 'deny'} the resolved mode
 */
export function advisoryMode() {
  return String(process.env.DSGS_ADVISORY ?? 'post').toLowerCase() === 'deny' ? 'deny' : 'post'
}

/** Deny a tool call / block a prompt, with a model-visible reason. */
export function deny(event, reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/** Force the model to reconsider before the action proceeds (PreToolUse only). */
export function ask(event, reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

/** Block via exit 2: stderr is the reason the model sees. Never use for warnings. */
export function block(reason) {
  process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
  process.exit(2);
}

/** Stop the turn, steering the model with a reason (Stop hook). */
export function stop(reason) {
  emit({ continue: false, stopReason: reason });
}

/**
 * Wrap a hook body: a hook must never crash the session, so an unexpected throw
 * degrades to an allow plus a stderr note, and `main` runs once.
 */
export function run(main) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      process.stderr.write(`hook error: ${error?.stack ?? String(error)}\n`);
      process.exitCode = 0;
    });
}


