#!/usr/bin/env node
/**
 * verify-hooks-events — end-to-end liveness for every hook event DSGS configures.
 *
 * The bridge and mount suites prove the wiring against the real protocol and the real plugin
 * `apply()`. Neither proves that the *harness* actually emits each event in a live session, and
 * that is what this verifier does: it boots a throwaway headless session whose prompt makes the
 * agent run a shell command, write a file and spawn a subagent, then reads the invocation audit
 * the direct-execution plugin writes (`.verify-logs/hook-invocations.log`) and reports which
 * events really fired.
 *
 * Events that cannot be provoked from a prompt (compaction, notification) are reported as
 * `mount-only`: the wiring is verified, the trigger is not available in this environment. They
 * never count as passes, and they do not fail the run either — the report says exactly which
 * evidence exists.
 *
 * Needs to create a throwaway profile (`~/.dsh/profiles/dgsevents`), so run it outside the file
 * sandbox or approve the escalation. The profile is deleted at the end.
 *
 * Usage: node tools/verify-hooks-events.mjs [--keep]
 *
 * @module tools/verify-hooks-events
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'dgsevents';
const INVOCATION_LOG = join(ROOT, '.verify-logs', 'hook-invocations.log');
const PROFILE_DIR = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', PROFILE);
const KEEP = process.argv.includes('--keep');

/** The prompt that makes one live session exercise as many events as it can. */
const PROBE_PROMPT = [
  'Execute these three steps now, in order, without asking anything:',
  '1. Call the pwsh tool with exactly this command: echo event-probe',
  '2. Call the write tool to create .verify-logs/event-probe.txt containing the single word probe',
  '3. Call the subagent tool once, delegating the single word ping to one child',
  'Then reply with the single word: done',
].join('\n');

/** Every event the generated config registers, with the commands it runs. */
function configuredEvents() {
  const config = JSON.parse(readFileSync(join(ROOT, '.dsh', 'hooks.json'), 'utf8'));
  const events = new Map();
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const commands = [];
    for (const group of groups) for (const hook of group.hooks ?? []) commands.push(hook.command);
    events.set(event, commands);
  }
  return events;
}

/** Parse the plugin's invocation audit: `resolve | <command>` and `exit=<n> | <ms> | <command>`. */
function invocationLog() {
  if (!existsSync(INVOCATION_LOG)) return { resolved: [], ran: [] };
  const resolved = [];
  const ran = [];
  for (const line of readFileSync(INVOCATION_LOG, 'utf8').split('\n')) {
    if (line.includes('| resolve |')) {
      const command = line.slice(line.indexOf('| resolve |') + '| resolve |'.length).trim();
      resolved.push(command);
    } else if (line.includes('| exit=')) {
      const exit = /exit=([^ ]*)/.exec(line)?.[1] ?? '?';
      const parts = line.split('|');
      const command = (parts[parts.length - 1] ?? '').trim();
      ran.push({ command, exit });
    }
  }
  return { resolved, ran };
}

/** Which configured event a command belongs to (a command may serve several events). */
function eventsFor(events, command) {
  const hits = [];
  for (const [event, commands] of events) {
    if (commands.some((c) => c === command)) hits.push(event);
  }
  return hits;
}

const NOT_PROVOKABLE = new Set(['Notification', 'PreCompact', 'PostCompact']);

/**
 * Turn a parsed invocation log into a per-event verdict. Exported so the classification is
 * unit-testable without booting a session.
 * @param {Map<string, string[]>} events - event → configured commands
 * @param {{ resolved: string[], ran: Array<{command: string, exit: string}> }} log - the audit
 * @returns {{ rows: Array<{event: string, status: string, evidence: string}>, live: number, gaps: number }}
 */
export function classifyInvocations(events, log) {
  const rows = [];
  let live = 0;
  let gaps = 0;
  for (const event of events.keys()) {
    const commands = events.get(event);
    const hits = log.ran.filter((entry) => commands.includes(entry.command));
    const everResolved = commands.some((c) => log.resolved.includes(c));
    let status;
    if (hits.length > 0) {
      status = 'LIVE';
      live += 1;
    } else if (NOT_PROVOKABLE.has(event)) {
      status = 'mount-only';
    } else {
      status = 'NOT FIRED';
      gaps += 1;
    }
    const evidence = hits.length > 0
      ? `${hits.length} hook(s): ${hits.map((h) => `exit=${h.exit}`).join(', ')}`
      : NOT_PROVOKABLE.has(event)
        ? 'wiring verified by verify-hooks-mount; not provokable from a prompt'
        : everResolved
          ? 'resolved but never executed (the session never triggered it)'
          : 'no invocation recorded';
    rows.push({ event, status, evidence });
  }
  return { rows, live, gaps };
}

function main() {
  const events = configuredEvents();
  writeFileSync(INVOCATION_LOG, '', 'utf8');
  if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });

  console.log(`verify-hooks-events: booting a throwaway headless session (profile "${PROFILE}")`);
  const run = spawnSync(
    'dsh',
    [PROFILE, '--from-default-profile', 'headless', '--patch', join(ROOT, 'tools', 'dsh-hooks-direct-overlay.yml'), PROBE_PROMPT],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
  );
  if (run.error !== undefined) {
    console.error(`  could not start dsh: ${String(run.error)}`);
    return 2;
  }

  const { resolved, ran } = invocationLog();
  const { rows, live, gaps } = classifyInvocations(events, { resolved, ran });

  console.log('\nevent                 status          evidence');
  console.log('--------------------  --------------  ------------------------------------------');
  for (const row of rows) console.log(`${row.event.padEnd(20)}  ${row.status.padEnd(14)}  ${row.evidence}`);

  if (!KEEP) rmSync(PROFILE_DIR, { recursive: true, force: true });

  console.log(`\n${live}/${events.size} events observed live; ${NOT_PROVOKABLE.size} mount-only (compaction/notification)`);
  if (gaps > 0) {
    console.log(`${gaps} event(s) were neither live nor provokable — that is a gap, not a pass.`);
    return 1;
  }
  console.log('No gaps: every provokable event fired.');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

