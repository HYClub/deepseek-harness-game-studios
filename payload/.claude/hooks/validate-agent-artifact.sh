#!/bin/bash

# --- work from the project root ----------------------------------------------
# Every path below is repo-relative, so a hook invoked with a working directory
# that is not the repo root would silently read and write the WRONG TREE --
# returning a near-empty result instead of the session-recovery block, and
# creating stray trees such as docs/production/session-logs/ on write.
#
# PRECEDENCE IS LOAD-BEARING. A cwd that IS a project root carries real
# information and must win: a caller sitting inside another project means that
# project, not this one. Resolving to the script's own location first would
# override them. So, in order:
#   1. cwd holds project.yaml   -> cwd   (a project root)
#   2. cwd holds .claude/       -> cwd   (a project root not yet configured),
#      unless cwd is itself named .claude: a stray .claude/.claude/ would
#      make .claude/ a root, and the hooks would write .claude/production/
#   3. CLAUDE_PROJECT_DIR       -> that  (populated in the hook environment),
#      unless it names a .claude folder, for the same reason as rule 2
#   4. this script's location   -> <root>/.claude/hooks/../.. by construction
# Rule 4 always works and needs no environment at all; rules 1-2 stop it from
# overriding a caller that legitimately means somewhere else.
#
# NOT an upward search: that resolves a nested project to its parent's config.
if [ -f "project.yaml" ] || { [ -d ".claude" ] && [ "${PWD##*/}" != ".claude" ]; }; then
  CCGS_ROOT="$PWD"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ] && case "${CLAUDE_PROJECT_DIR%/}" in */.claude|*\\.claude) false ;; *) true ;; esac; then
  CCGS_ROOT="$CLAUDE_PROJECT_DIR"
else
  CCGS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
fi
[ -n "$CCGS_ROOT" ] && cd "$CCGS_ROOT" 2>/dev/null || true

# Claude Code SubagentStop hook: warns when a subagent stops without writing
# the file its return contract named. An orchestrating skill ends each agent
# prompt with "Write your full output to `<path>`"; a named artifact that is
# not on disk is a failed phase however fluent the reply reads
# (error-recovery-protocol.md, Trigger 0). The orchestrator still checks the
# path itself; this hook is the extra guarantee, shown to the user.
#
# The path is read from the subagent's own transcript (agent_transcript_path),
# from its prompt only: the transcript's first user message. The rest of the
# transcript holds what the subagent read, and a file that quotes the phrase
# (hooks-reference.md does, with `<path>`) is not its contract. The first
# "Write your full output to `...`" in the prompt whose path is not a template
# placeholder ([path], <path>, {path}, or a path holding one) is the contract.
# A subagent whose prompt names no path is not checked. The existence check is
# `.claude/scripts/write-guard.sh artifact`, its helper twin.
#
# Exit behavior:
#   exit 0 always = advisory (it warns, never blocks; additionalContext on
#   this event would keep the subagent running, so only systemMessage is used)
#
# Input schema (SubagentStop):
# { "agent_id": "...", "agent_type": "qa-tester", "agent_transcript_path": "...",
#   "last_assistant_message": "..." }

INPUT=$(cat)

# Claude Code's internal agents arrive with an empty agent_type
# (log-agent-stop.sh skips them for the same reason).
case "$INPUT" in *'"agent_transcript_path"'*) ;; *) exit 0 ;; esac

if command -v jq >/dev/null 2>&1; then
  # tr: a native Windows jq.exe ends its lines CRLF under Git Bash.
  _VA_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null | tr -d '\r')
  _VA_T=$(printf '%s' "$INPUT" | jq -r '.agent_transcript_path // empty' 2>/dev/null | tr -d '\r')
else
  _VA_TYPE=$(printf '%s' "$INPUT" | LC_ALL=C grep -oE '"agent_type"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | LC_ALL=C sed 's/^"agent_type"[[:space:]]*:[[:space:]]*"//; s/"$//')
  # A path holds no quote; its backslashes arrive doubled, so \\ becomes one.
  _VA_T=$(printf '%s' "$INPUT" | LC_ALL=C grep -oE '"agent_transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
    | LC_ALL=C sed 's/^"agent_transcript_path"[[:space:]]*:[[:space:]]*"//; s/"$//; s/\\\\/\\/g')
fi
[ -n "$_VA_TYPE" ] || exit 0
_VA_T=$(printf '%s' "$_VA_T" | sed 's|\\|/|g')

# Not hook_warn (yaml-helper.sh): it also sets additionalContext, which on this
# event would keep the subagent running. systemMessage only, escaped the same
# way.
va_say() {
  _va_m=$(printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | awk '{ gsub(/\t/, "\\t"); if (NR > 1) printf "\\n"; printf "%s", $0 }')
  printf '{"systemMessage":"%s"}\n' "$_va_m"
  exit 0
}

[ -n "$_VA_T" ] && [ -f "$_VA_T" ] || va_say "Artifact check did not run for subagent $_VA_TYPE: its transcript ($_VA_T) could not be read."
# The first named path in the prompt, the transcript's first user message (a
# JSONL line of type "user"); a template placeholder is not a path.
_VA_P=$(LC_ALL=C awk 'BEGIN { BINMODE = 3 }
  /"type"[ \t]*:[ \t]*"user"/ {
    s = $0
    while (match(s, /Write your full output to `[^`]+`/)) {
      # 27: the phrase and its opening backtick; 28 adds the closing one.
      p = substr(s, RSTART + 27, RLENGTH - 28); s = substr(s, RSTART + RLENGTH)
      if (p !~ /\[[^]]*\]|<[^>]*>|\{[^}]*\}/) { print p; exit }
    }
    exit
  }' "$_VA_T")
[ -n "$_VA_P" ] || exit 0
[ -f .claude/scripts/write-guard.sh ] || va_say "Artifact check did not run for subagent $_VA_TYPE: the helper .claude/scripts/write-guard.sh is missing."
case "$(bash .claude/scripts/write-guard.sh --root . artifact "$_VA_P" 2>/dev/null)" in
  *"	missing") ;;
  *) exit 0 ;;
esac
va_say "Subagent $_VA_TYPE stopped, and the file its return contract named is not on disk: $_VA_P. Treat that phase as not done (error-recovery protocol, Trigger 0): resume the agent and tell it to write the file."
