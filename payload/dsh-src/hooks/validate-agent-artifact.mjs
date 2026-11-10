#!/usr/bin/env node
/**
 * validate-agent-artifact — DSH port of upstream `.claude/hooks/validate-agent-artifact.sh`.
 *
 * SubagentStop: a subagent whose prompt said "Write your full output to `<path>`" must leave that
 * file on disk. When it did not, the phase is not done — this is Trigger 0 of the error-recovery
 * protocol, and the fix is to resume the agent and tell it to write the file.
 *
 * Only the FIRST user message of the transcript is read: the rest holds what the subagent read, and
 * a document that merely quotes the phrase is not its contract. A template placeholder (`[path]`,
 * `<path>`, `{path}` or a path holding one) is not a path, and a subagent whose prompt names none is
 * not checked.
 *
 * Advisory, never blocking. The message goes out as `systemMessage` only: `additionalContext` on
 * SubagentStop would keep the subagent running.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readInput, projectRoot, emit, run } from './runtime.mjs';

const CONTRACT = /Write your full output to `([^`]+)`/g;
const PLACEHOLDER = /\[[^\]]*\]|<[^>]*>|\{[^}]*\}/;

const say = (message) => emit({ systemMessage: message });

function main() {
  const input = readInput();
  const type = String(input?.agent_type ?? '').trim();
  // Claude Code's internal agents arrive with an empty agent_type; upstream skips them too.
  if (type.length === 0) return;

  const raw = String(input?.agent_transcript_path ?? '').replace(/\\\\/g, '\\');
  const root = (typeof input?.cwd === 'string' && (existsSync(resolve(input.cwd, 'project.yaml')) || existsSync(resolve(input.cwd, '.dsh'))))
    ? resolve(input.cwd)
    : projectRoot(input);
  const transcript = raw.length > 0 && isAbsolute(raw) ? raw : resolve(root, raw);
  if (raw.length === 0 || !existsSync(transcript)) {
    say(`Artifact check did not run for subagent ${type}: its transcript (${raw.length > 0 ? raw : '-'}) could not be read.`);
    return;
  }

  let named = null;
  for (const line of readFileSync(transcript, 'utf8').split(/\r?\n/)) {
    if (!/"type"\s*:\s*"user"/.test(line)) continue;
    CONTRACT.lastIndex = 0;
    let match = CONTRACT.exec(line);
    while (match !== null) {
      if (!PLACEHOLDER.test(match[1])) { named = match[1]; break; }
      match = CONTRACT.exec(line);
    }
    break; // only the transcript's first user message carries the contract
  }
  if (named === null) return;

  const absolute = isAbsolute(named) ? named : resolve(root, named);
  if (existsSync(absolute)) return;
  say(`Subagent ${type} stopped, and the file its return contract named is not on disk: ${named}. Treat that phase as not done (error-recovery protocol, Trigger 0): resume the agent and tell it to write the file.`);
}

run(main);
