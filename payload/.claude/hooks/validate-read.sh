#!/bin/bash

# --- work from the project root ----------------------------------------------
# Same precedence as validate-write.sh (see there for why): a cwd that is a
# project root wins, then CLAUDE_PROJECT_DIR, then this script's location.
if [ -f "project.yaml" ] || { [ -d ".claude" ] && [ "${PWD##*/}" != ".claude" ]; }; then
  CCGS_ROOT="$PWD"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ] && case "${CLAUDE_PROJECT_DIR%/}" in */.claude|*\\.claude) false ;; *) true ;; esac; then
  CCGS_ROOT="$CLAUDE_PROJECT_DIR"
else
  CCGS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
fi
[ -n "$CCGS_ROOT" ] && cd "$CCGS_ROOT" 2>/dev/null || true

# Claude Code PreToolUse hook: refuses a whole-file Read (no offset, no limit)
# of a design doc over the size bar, and answers with the doc's headings by
# line, so the retry reads the section it needs. One refused read costs a turn;
# the read it stops can cost tens of thousands of tokens, and a ranged read
# always passes, so nothing can get stuck behind it. Watched: design/,
# docs/architecture/, production/session-state/; the bar is
# features.read_guard_kb (40 KB); features.read_guard: off turns it off.
#
# The logic is `.claude/scripts/read-guard.sh check`, its helper twin; this
# hook reads the payload through `.claude/scripts/hook-input.sh` and calls it.
#
# Exit behavior:
#   exit 2 = the read is refused; stderr goes to Claude
#   exit 0 = every other read, and every case where the guard cannot run
#            (a missing helper is named; the read goes ahead)
#
# Input schema (PreToolUse for Read):
# { "tool_name": "Read", "tool_input": { "file_path": "...", "offset": 1, "limit": 200 } }

INPUT=$(cat)

# Most reads are of none of the watched folders. Leave before any parsing, with
# builtins only. Only the file_path value is tested, and only its part below
# the project root: the payload's cwd and transcript_path, and the root part of
# an absolute path, are the project's own folder, which can be named anything
# (~/gamedesign/proj), and matching them sent every Read through the full
# parse. A value that may end at an escaped quote is not trusted: then the
# whole payload is tested, as before. Leaving here when the full parse would
# not refuse the read is what keeps the behaviour unchanged: a watched path
# below the root always holds one of the three words.
case "$INPUT" in
  *'"tool_input"'*'"file_path"'*) ;;
  *) exit 0 ;;
esac
_VR_P=${INPUT#*'"tool_input"'}; _VR_P=${_VR_P#*'"file_path"'}; _VR_P=${_VR_P#*'"'}; _VR_P=${_VR_P%%'"'*}
_vr_bs='\'
case "$_VR_P" in
  *"$_vr_bs") _VR_P=$INPUT ;;
  *"$_vr_bs$_vr_bs"*) _VR_P=${_VR_P//"$_vr_bs$_vr_bs"//} ;;   # C:\\Users\\... as C:/Users/...
esac
# The root in both spellings Git Bash gives it: /c/Users/... and C:/Users/...
# (the second read from the first; under a mount such as /tmp only pwd -W
# knows it, which costs a subshell, so it is asked last).
_vr_w=$PWD
case "$PWD" in /[A-Za-z]/*) _vr_w="${PWD:1:1}:${PWD:2}" ;; esac
shopt -s nocasematch
case "$_VR_P" in
  "$PWD"/*) _VR_P=${_VR_P:${#PWD}+1} ;;
  "$_vr_w"/*) _VR_P=${_VR_P:${#_vr_w}+1} ;;
  [A-Za-z]:/*) _vr_w=$(pwd -W 2>/dev/null)
    case "$_VR_P" in "$_vr_w"/*) [ -n "$_vr_w" ] && _VR_P=${_VR_P:${#_vr_w}+1} ;; esac ;;
esac
shopt -u nocasematch
case "$_VR_P" in
  *design*|*architecture*|*session-state*) ;;
  *) exit 0 ;;
esac

[ -f .claude/hooks/yaml-helper.sh ] && . .claude/hooks/yaml-helper.sh 2>/dev/null
vr_warn() {
  if command -v hook_warn >/dev/null 2>&1; then hook_warn PreToolUse "$1"
  else printf '%s\n' "$1" >&2; fi
  exit 0
}
[ -f .claude/scripts/hook-input.sh ] || vr_warn "Read guard skipped: the helper .claude/scripts/hook-input.sh is missing, so the read goes ahead unchecked."

_VR_IN=$(printf '%s' "$INPUT" | bash .claude/scripts/hook-input.sh --root . 2>/dev/null)
vr_row() { printf '%s\n' "$_VR_IN" | awk -F '\t' -v k="$1" '$1 == k { print $2; exit }'; }
[ "$(vr_row tool)" = Read ] || exit 0
[ "$(vr_row where)" = inside ] || exit 0
_VR_PATH=$(vr_row path)
[ -f .claude/scripts/read-guard.sh ] || vr_warn "Read guard skipped: the helper .claude/scripts/read-guard.sh is missing, so the read of $_VR_PATH goes ahead unchecked."

_VR_OUT=$(bash .claude/scripts/read-guard.sh --root . check "$_VR_PATH" --bounded "$(vr_row bounded)" 2>/dev/null)
_VR_LARGE=$(printf '%s\n' "$_VR_OUT" | awk -F '\t' '$1 == "LARGE"')
[ -n "$_VR_LARGE" ] || exit 0

_VR_KB=$(printf '%s\n' "$_VR_LARGE" | awk -F '\t' '{ printf "%d KB", int(($3 + 1023) / 1024) }')
_VR_BAR=$(printf '%s\n' "$_VR_LARGE" | awk -F '\t' '{ printf "%d KB", int($4 / 1024) }')
# At most this many headings: past it the list costs what the read would.
_VR_MAX=40
_VR_HEADS=$(bash .claude/scripts/read-guard.sh --root . sections "$_VR_PATH" 2>/dev/null \
  | VR_MAX="$_VR_MAX" VR_PATH="$_VR_PATH" awk -F '\t' '
      { n++; if (n <= ENVIRON["VR_MAX"]) printf "%5s  %s\n", $1, $2 }
      END {
        if (n == 0) print "  (no markdown headings: read it in ranges of a few hundred lines)"
        if (n > ENVIRON["VR_MAX"]) print "  ... and " (n - ENVIRON["VR_MAX"]) " more: find them with the Grep tool (pattern `^#`, content mode) on " ENVIRON["VR_PATH"] ", then Read that range with offset and limit"
      }')

cat >&2 <<EOF
Read refused: $_VR_PATH is $_VR_KB, over the $_VR_BAR bar for reading a design doc whole (features.read_guard_kb). Read it by section instead: find the heading you need below, then Read with offset at its line and a limit that stops at the next heading.
$_VR_HEADS
If the task needs the whole doc, read it in ranges and say why. The guard is a project setting, features.read_guard (on or off).
EOF
exit 2
