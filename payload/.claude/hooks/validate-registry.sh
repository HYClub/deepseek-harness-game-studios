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

# Claude Code PreToolUse hook: warns when a Write or Edit of the entity registry
# (design/registry/entities.yaml) or the TR-ID registry
# (docs/architecture/tr-registry.yaml) would break either of their two rules:
# entries are never deleted or renumbered (append-only), and a status takes only
# the values the file's header lists. It runs BEFORE the write, the only point
# where the old file can still be compared with the new content.
#
# The logic is `.claude/scripts/registry.sh compare`, its helper twin; this hook
# reads the payload and rebuilds the new content through
# `.claude/scripts/hook-input.sh`, then calls it. A skill that writes a registry
# runs `registry.sh validate` itself after writing, because hooks do not run on
# every tool that runs the skills.
#
# Exit behavior:
#   exit 0 always = advisory (it warns, never blocks)
#
# Input schema (PreToolUse for Write|Edit):
# { "tool_name": "Write", "tool_input": { "file_path": "...", "content": "..." } }
# { "tool_name": "Edit",  "tool_input": { "file_path": "...", "old_string": "...",
#                                         "new_string": "...", "replace_all": false } }

INPUT=$(cat)

# Most writes are to other files. Leave before any parsing, which reads the
# whole payload: a write of either registry names its file, in either slash.
case "$INPUT" in
  *'"tool_input"'*entities.yaml*|*'"tool_input"'*tr-registry.yaml*) ;;
  *) exit 0 ;;
esac

[ -f .claude/hooks/yaml-helper.sh ] && . .claude/hooks/yaml-helper.sh 2>/dev/null
vr_warn() {
  if command -v hook_warn >/dev/null 2>&1; then hook_warn PreToolUse "$1"
  else printf '%s\n' "$1" >&2; fi
  exit 0
}
for _vr_s in hook-input.sh registry.sh; do
  [ -f ".claude/scripts/$_vr_s" ] || vr_warn "Registry check skipped: the helper .claude/scripts/$_vr_s is missing, so the write goes ahead unchecked."
done

_VR_NEW=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$_VR_NEW"' EXIT
_VR_IN=$(printf '%s' "$INPUT" | bash .claude/scripts/hook-input.sh --root . --new "$_VR_NEW" 2>/dev/null)
vr_row() { printf '%s\n' "$_VR_IN" | awk -F '\t' -v k="$1" '$1 == k { print $2; exit }'; }
REL_PATH=$(vr_row path)
[ "$(vr_row where)" = inside ] || exit 0

# The two registries the rules guard (the architecture registry has no
# append-only rule in its header).
case "$REL_PATH" in
  design/registry/entities.yaml)      REG=entities ;;
  docs/architecture/tr-registry.yaml) REG=tr ;;
  *) exit 0 ;;
esac

_VR_VALIDATE="run bash .claude/scripts/registry.sh validate after writing and fix what it reports"
vr_skip() { vr_warn "Registry check skipped for $REL_PATH: $1. The write goes ahead; $_VR_VALIDATE."; }
_VR_TOOL=$(vr_row tool)
case "$_VR_TOOL" in Write|Edit) ;; *) vr_skip "the hook rebuilds Write and Edit only, not $_VR_TOOL" ;; esac
case "$(vr_row new)" in
  ok) ;;
  notfound) vr_skip "old_string is not in the current file, so the new content could not be rebuilt" ;;
  empty-old) vr_skip "an empty old_string on a file that has content could not be rebuilt" ;;
  "unread "*) vr_skip "the hook could not read $(vr_row new | sed 's/^unread //') from the tool input" ;;
  *) vr_skip "the new content could not be rebuilt" ;;
esac

_VR_OUT=$(bash .claude/scripts/registry.sh compare "$REG" "$REL_PATH" "$_VR_NEW" 2>/dev/null)

# At most this many names per rule in the warning: a longer list buries the
# point, and validate prints them all.
_VR_MAX=5
_VR_MSG=$(printf '%s\n' "$_VR_OUT" | VR_NEWP="$_VR_NEW" VR_MAX="$_VR_MAX" awk -F '\t' '
  function add(list, n, item) { return (n <= ENVIRON["VR_MAX"]) ? list (n > 1 ? ", " : "") item : list }
  function more(n) { return (n > ENVIRON["VR_MAX"]) ? ", and " (n - ENVIRON["VR_MAX"]) " more" : "" }
  $1 == "removed" { removed = $2 }
  $1 == "REMOVED" { nr++; rl = add(rl, nr, $4 " (line " $5 ")") }
  $1 == "STATUS"  { ns++; sl = add(sl, ns, $3 " set to " $4 " (line " $6 ")"); allowed = $5 }
  $1 == "LAYOUT" && $3 == ENVIRON["VR_NEWP"] { nl++; ll = add(ll, nl, "line " $6 ": " $4 "; expected " $5) }
  $1 == "LAYOUT" && $3 != ENVIRON["VR_NEWP"] { oldbad = 1 }
  END {
    if (nr) print "- It removes " nr (nr == 1 ? " entry" : " entries") " of the current file: " rl more(nr) ". Entries are never deleted or renumbered: keep each one and change its status instead (the header lists the values)."
    if (ns) print "- It sets " ns (ns == 1 ? " status" : " statuses") " outside the allowed values (" allowed "): " sl more(ns) "."
    if (nl) print "- The registry helper cannot read the layout of the new content at " nl (nl == 1 ? " line" : " lines") ": " ll more(nl) "."
    if (removed == "-" && oldbad) print "- Removals were not checked: the current file has lines whose layout the helper cannot read."
  }')

[ -n "$_VR_MSG" ] || exit 0
vr_warn "Registry check on $REL_PATH (a warning; the write goes ahead):
$_VR_MSG
Fix it in this write, or $_VR_VALIDATE."
