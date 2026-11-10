#!/usr/bin/env bash
# registry.sh — the three registries read one way, and the next ID of every
# kind the skills number: the entity registry (design/registry/entities.yaml),
# the TR-ID registry (docs/architecture/tr-registry.yaml) and the architecture
# registry (docs/registry/architecture.yaml). A skill asks this script instead
# of writing its own grep per entity or per TR-ID, so every skill reads the
# same entries the same way.
#
# EMITS OBSERVATIONS, NOT A VERDICT (CLAUDE.md, "Helpers in .claude/scripts/").
# validate lists what it found. Whether a missing path matters, or a story may
# cite a deprecated TR-ID, is the calling skill's rule.
#
# Usage: bash .claude/scripts/registry.sh [--root DIR] COMMAND [ARGS]
#   list [REGISTRY] [--system SLUG]
#                   one row per entry; REGISTRY is entities, tr or architecture
#                   (all three when left out); --system keeps the TR-IDs of
#                   one system slug (TR-combat-001, not TR-combat-ai-001)
#   get NAME ...    each entry named NAME (an entity name, a TR-ID, or a
#                   state, contract, system, purpose or pattern): its row, then
#                   its lines as the file has them
#   refs NAME|PATH  for a NAME, each path its entry names, and for a TR-ID each
#                   story or epic line under production/epics/ that cites it;
#                   for a PATH (it holds a /), every entry that names it
#   slice PATH      every entry that names PATH as its source, gdd or adr or in
#                   referenced_by: its row, then its lines
#   validate        duplicate names, TR-IDs cited under production/epics/ that
#                   the registry lacks, paths that do not exist, status values
#                   outside the allowed list, and unsupported layout
#   compare REGISTRY OLD [NEW]
#                   one registry before and after a change: each entry OLD
#                   has that NEW lacks (the registries are append-only), each
#                   status the change sets outside the allowed list, and
#                   NEW's unsupported layout. OLD and NEW are files holding
#                   that registry; NEW defaults to the registry itself
#   next-id KIND [SCOPE]
#                   the next ID: the highest one seen plus one, so a deleted or
#                   deprecated ID is never handed out again. KIND and SCOPE:
#                   tr SLUG   TR-SLUG-NNN, from the TR registry
#                   adr       ADR-NNNN, from docs/architecture/adr-NNNN-*.md
#                   bug       BUG-NNNN, from production/qa/bugs/BUG-*.md
#                   asset     ASSET-NNN, from design/assets/asset-manifest.md
#                             and the spec files in design/assets/specs/
#                   td        TD-NNN, from docs/tech-debt-register.md
#                   story EPIC  story-NNN, from production/epics/EPIC/story-*.md
#                   sprint    sprint-NNN, from production/sprints/sprint-N.md
#                   season    SN, from design/live-ops/seasons/SN_*.md
#   --root DIR      the project; defaults to the repo this script is in
#   -h, --help      this text
#
# The layout it reads (each registry's header says so on its LAYOUT line):
#   - a section is a key at column 0 holding a block list, or [] while empty
#   - an entry starts "- KEY: VALUE", the dash at column 0 or 2 and the same
#     column for every entry of a section; KEY is the section's name key
#     (name; id; state, contract, system or target_fps, purpose, pattern) and
#     VALUE is the entry's name
#   - its fields sit two columns past the dash; a deeper line belongs to the
#     field above it; a list under a field may also sit at the field's column
#   - a value holding ": " is quoted; a flow list or map stays on one line
#   - a value of | or > (with any indicators) is multi-line text: the lines
#     deeper than its key are that text, never fields or entries
# Anything else is reported as LAYOUT, with the line and the layout expected
# there, and that registry's entries are left out rather than guessed. One
# unquoted value is read anyway: the architecture registry's
# `status: superseded_by: ADR-NNNN`, as /architecture-decision wrote it before
# 1.2.0. It is read as the status `superseded_by: ADR-NNNN`, the entries are
# listed, and an UNQUOTED row names the line to quote.
#
# Output: TSV, `-` where a value is not there.
#   registry <name> <path> <entries | missing | layout>    first, per registry read
#   ENTRY <registry> <section> <key> <name> <status> <source> <line>
#       source: the source field (entities), gdd (tr) or adr (architecture)
#   REF <registry> <name> <how> <path> <line>
#       how: source | gdd | adr | referenced_by, or cited (a story or epic line)
#   LAYOUT <registry> <path> <found> <expected> <line>
#   UNQUOTED <registry> <path> <value> <the line as it should read> <line>
#       the unquoted superseded status above, read as <value>; after the
#       other rows of every command but next-id, and it changes no exit code
#   NOT_FOUND <name>
#   validate: checked production/epics <files>, then the counts duplicate,
#   tr_unknown, path_missing, status and layout, then the rows
#       DUPLICATE <registry> <section> <name> <lines>
#       TR_UNKNOWN <tr-id> <path> <line>
#       PATH_MISSING <registry> <name> <field> <path> <line>
#       STATUS <registry> <name> <value> <allowed> <line>
#       LAYOUT rows, then UNQUOTED rows
#       a path is missing when test -e fails on it, so a directory exists
#   compare: the registry rows of OLD, then NEW; the counts removed (- when
#   either side is missing or has unsupported layout, so its entries are not
#   known; 0 when OLD is missing, as a new file removes nothing), status and
#   layout; then the rows
#       REMOVED <registry> <section> <name> <line in OLD>
#       STATUS rows, for an entry NEW adds or whose status NEW changes (one
#         already outside the list in OLD is validate's to report)
#       LAYOUT rows, OLD's and NEW's (the path column tells them apart),
#       then UNQUOTED rows the same way
#   next-id: next <kind> <scope | -> <id> <highest | -> <ids seen>  (no other row)
#
# Exit codes: 0 answered; 1 the root cannot be read; 2 usage error; 3 a NAME
# matched no entry (its NOT_FOUND row is printed); 4 a registry the command
# reads has an unsupported layout (its LAYOUT rows are printed). validate and
# compare exit 0 whenever they ran: what they find is rows. Reads only; never
# writes.
#
# bash 3.2 and BWK awk safe, no Python.

set -u
# Byte semantics for awk and find.
LC_ALL=C
export LC_ALL

usage() { echo "registry: $1 (try --help)" >&2; exit 2; }
# A system or epic slug: lowercase words joined by single hyphens, as the
# TR-ID format and the epic folder names write them.
is_slug() { printf '%s' "$1" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; }
# A path made absolute against the current directory; C:/ and C:\ count as
# absolute, the forms Git Bash and Windows callers pass.
abs_path() {
  case "$1" in
    /*|[A-Za-z]:[\\/]*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "${1#./}" ;;
  esac
}

ROOT_ARG=""
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || usage "--root needs a value"
      ROOT_ARG="$2"; shift 2 ;;
    --root=*) ROOT_ARG="${1#--root=}"; shift ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *) POS[${#POS[@]}]="$1"; shift ;;
  esac
done
[ ${#POS[@]} -gt 0 ] || usage "no command"
CMD="${POS[0]}"
NARG=$((${#POS[@]} - 1))

# The registries, in the order every command reports them.
REGS="entities tr architecture"
reg_path() {
  case "$1" in
    entities) echo "design/registry/entities.yaml" ;;
    tr) echo "docs/architecture/tr-registry.yaml" ;;
    architecture) echo "docs/registry/architecture.yaml" ;;
  esac
}

READ="$REGS"; SCAN=0; RG_REG=""; RG_SYS=""; RG_ARG=""; RG_NAMES=""
NL='
'
case "$CMD" in
  list)
    i=1
    while [ $i -le $NARG ]; do
      a="${POS[$i]}"
      case "$a" in
        --system)
          [ $i -lt $NARG ] || usage "--system needs a slug"
          i=$((i + 1)); RG_SYS="${POS[$i]}"
          is_slug "$RG_SYS" || usage "not a system slug: $RG_SYS" ;;
        entities|tr|architecture)
          [ -z "$RG_REG" ] || usage "one registry at most"
          RG_REG="$a" ;;
        *) usage "unknown argument to list: $a" ;;
      esac
      i=$((i + 1))
    done
    if [ -n "$RG_SYS" ]; then
      [ -z "$RG_REG" ] || [ "$RG_REG" = tr ] || usage "--system reads the tr registry only"
      RG_REG=tr
    fi
    [ -z "$RG_REG" ] || READ="$RG_REG" ;;
  get)
    [ $NARG -ge 1 ] || usage "get needs a name"
    i=1
    while [ $i -le $NARG ]; do RG_NAMES="$RG_NAMES${POS[$i]}$NL"; i=$((i + 1)); done ;;
  refs)
    [ $NARG -eq 1 ] || usage "refs takes one name or path"
    RG_ARG="${POS[1]}"
    case "$RG_ARG" in */*) RG_ARG="${RG_ARG#./}" ;; *) SCAN=1 ;; esac ;;
  slice)
    [ $NARG -eq 1 ] || usage "slice takes one path"
    RG_ARG="${POS[1]#./}" ;;
  validate)
    [ $NARG -eq 0 ] || usage "validate takes no arguments"
    SCAN=1 ;;
  compare)
    { [ $NARG -ge 2 ] && [ $NARG -le 3 ]; } || usage "compare takes a registry, the old file and optionally the new one"
    RG_REG="${POS[1]}"
    case "$RG_REG" in entities|tr|architecture) ;; *) usage "not a registry: $RG_REG" ;; esac
    # Read from the directory the caller is in, before --root moves it, and
    # shown as the caller wrote them.
    CMP_OLD=$(abs_path "${POS[2]}"); CMP_OLD_AS="${POS[2]}"; CMP_NEW=""; CMP_NEW_AS=""
    if [ $NARG -eq 3 ]; then CMP_NEW=$(abs_path "${POS[3]}"); CMP_NEW_AS="${POS[3]}"; fi
    [ "$CMP_OLD" != "$CMP_NEW" ] || usage "the old and new files are the same path"
    READ="" ;;
  next-id)
    [ $NARG -ge 1 ] || usage "next-id needs a kind"
    KIND="${POS[1]}"
    case "$KIND" in
      tr|story)
        [ $NARG -eq 2 ] || usage "next-id $KIND takes one slug"
        is_slug "${POS[2]}" || usage "not a slug: ${POS[2]}"
        RG_ARG="${POS[2]}" ;;
      adr|bug|asset|td|sprint|season)
        [ $NARG -eq 1 ] || usage "next-id $KIND takes no scope" ;;
      *) usage "unknown ID kind: $KIND" ;;
    esac
    READ="tr" ;;
  *) usage "unknown command: $CMD" ;;
esac

if [ -n "$ROOT_ARG" ]; then
  cd "$ROOT_ARG" 2>/dev/null || { echo "registry: cannot read root $ROOT_ARG" >&2; exit 1; }
else
  cd "$(dirname "$0")/../.." 2>/dev/null || { echo "registry: cannot reach the repo root" >&2; exit 1; }
fi

# --------------------------------------------------------- next-id, file kinds
# next_seen KIND SCOPE FORMAT MODE PATTERN FILES...
#   MODE names: PATTERN (anchored) is matched against each file's name.
#   MODE text:  every PATTERN in the files' text, not inside a longer word.
# The number is the first digit run in the match; the row gives the next
# one in FORMAT, the highest seen and how many distinct numbers were seen.
next_seen() {
  _k="$1"; _s="$2"; _f="$3"; _m="$4"; _p="$5"; shift 5
  { for _x in "$@"; do printf '%s\n' "$_x"; done; } | \
  K="$_k" S="$_s" F="$_f" M="$_m" P="$_p" awk '
    BEGIN {
      BINMODE = 3; max = -1; n = 0
      while ((getline f < "/dev/stdin") > 0) {
        if (f == "") continue
        if (ENVIRON["M"] == "names") { b = f; sub(/^.*\//, "", b); take(b, 1) }
        else ARGV[ARGC++] = "./" f
      }
    }
    function take(s, anchored,    base, rest, abs, pre, aft, m, d) {
      base = 0; rest = s
      while (match(rest, ENVIRON["P"])) {
        abs = base + RSTART
        pre = (abs > 1) ? substr(s, abs - 1, 1) : ""
        aft = substr(s, abs + RLENGTH, 1)
        if ((anchored && abs == 1) || (!anchored && pre !~ /[A-Za-z0-9-]/ && aft !~ /[A-Za-z0-9]/)) {
          m = substr(s, abs, RLENGTH); match(m, /[0-9]+/); d = substr(m, RSTART, RLENGTH) + 0
          if (!(d in seen)) { seen[d] = 1; n++ }
          if (d > max) max = d
        }
        if (anchored) return
        base = abs + RLENGTH - 1; rest = substr(s, base + 1)
      }
    }
    { line = $0; sub(/\r$/, "", line); take(line, 0) }
    END {
      printf "next\t%s\t%s\t" ENVIRON["F"] "\t", ENVIRON["K"], ENVIRON["S"], max + 1 + (max < 0)
      if (max < 0) printf "-"; else printf ENVIRON["F"], max
      printf "\t%d\n", n
    }'
}
# files DIR NAME-GLOB [-i] — the files directly in DIR whose name matches, sorted.
files() {
  [ -d "$1" ] || return 0
  if [ "${3:-}" = "-i" ]; then find "$1" -maxdepth 1 -type f -iname "$2" | sort
  else find "$1" -maxdepth 1 -type f -name "$2" | sort; fi
}

if [ "$CMD" = next-id ] && [ "$KIND" != tr ]; then
  # Padding per kind is what the skills that number them write: ADR and BUG
  # four digits, the rest three (season none). Starting numbers are 1.
  # (pat) with its opening paren: bash 3.2 misparses a bare pat) inside $( ).
  NLIST=$(case "$KIND" in
    (adr) files docs/architecture 'adr-*.md' ;;
    (bug) files production/qa/bugs 'bug-*.md' -i ;;
    (asset) [ -f design/assets/asset-manifest.md ] && echo design/assets/asset-manifest.md
            files design/assets/specs '*.md' ;;
    (td) [ -f docs/tech-debt-register.md ] && echo docs/tech-debt-register.md ;;
    (story) files "production/epics/$RG_ARG" 'story-*.md' ;;
    (sprint) files production/sprints 'sprint-*.md' ;;
    (season) files design/live-ops/seasons 'S*_*' ;;
  esac)
  # One path per line; split on newlines only, so a name with a space holds.
  OLDIFS=$IFS; IFS=$NL; set -f
  # shellcheck disable=SC2086
  set -- $NLIST
  set +f; IFS=$OLDIFS
  case "$KIND" in
    adr) next_seen adr - 'ADR-%04d' names '^adr-[0-9]+' "$@" ;;
    bug) next_seen bug - 'BUG-%04d' names '^[Bb][Uu][Gg]-[0-9]+' "$@" ;;
    asset) next_seen asset - 'ASSET-%03d' text 'ASSET-[0-9]+' "$@" ;;
    td) next_seen td - 'TD-%03d' text 'TD-[0-9]+' "$@" ;;
    story) next_seen story "$RG_ARG" 'story-%03d' names '^story-[0-9]+' "$@" ;;
    # Only sprint-<digits>.md is a plan: a retrospective sharing the folder
    # (sprint-3-retrospective.md) is not, as plan-math.sh reads the folder.
    sprint) next_seen sprint - 'sprint-%03d' names '^sprint-[0-9]+\.md$' "$@" ;;
    season) next_seen season - 'S%d' names '^S[0-9]+_' "$@" ;;
  esac
  exit 0
fi

# ------------------------------------------------------------------ registries
LIST=""
for r in $READ; do
  p=$(reg_path "$r")
  if [ -f "$p" ]; then LIST="${LIST}R	$r	$p$NL"; else LIST="${LIST}M	$r	$p$NL"; fi
done
if [ "$CMD" = compare ]; then
  # OLD first, then NEW: the awk tells them apart by that order. The fourth
  # field is the path as shown.
  if [ -z "$CMP_NEW" ]; then CMP_NEW=$(reg_path "$RG_REG"); CMP_NEW_AS="$CMP_NEW"; fi
  for p in "$CMP_OLD	$CMP_OLD_AS" "$CMP_NEW	$CMP_NEW_AS"; do
    if [ -f "${p%%	*}" ]; then LIST="${LIST}R	$RG_REG	$p$NL"; else LIST="${LIST}M	$RG_REG	$p$NL"; fi
  done
fi
if [ "$SCAN" = 1 ] && [ -d production/epics ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && LIST="${LIST}S	-	${f#./}$NL"
  done <<EOF
$(find production/epics -type f -name '*.md' | sort)
EOF
fi

# One awk: each registry is read once, line by line, into entries; the story
# and epic files are scanned for TR-IDs; END answers the command. The file list
# goes in on stdin, never as arguments (a long list passes the command-line
# limit of some systems); "./" in front keeps a name like x=1.md a file name.
# An absolute path (compare's files) goes in as it is: a name starting with /
# or C: cannot read as an assignment.
printf '%s' "$LIST" | \
RG_CMD="$CMD" RG_REG="$RG_REG" RG_SYS="$RG_SYS" RG_ARG="$RG_ARG" RG_NAMES="$RG_NAMES" awk '
  BEGIN {
    # Git for Windows gawk reads files in text mode; BINMODE keeps the bytes.
    BINMODE = 3
    # The field that holds each registry entry'"'"'s authoritative path.
    SRCF["entities"] = "source"; SRCF["tr"] = "gdd"; SRCF["architecture"] = "adr"
    # The name key an entry of each documented section starts with; a section
    # not listed here (one a project added) may start with any key.
    split("entities items formulas constants", t, " ")
    for (i = 1; i <= 4; i++) NK["entities", t[i]] = "name"
    NK["tr", "requirements"] = "id"
    NK["architecture", "state_ownership"] = "state"
    NK["architecture", "interfaces"] = "contract"
    NK["architecture", "performance_budgets"] = "system target_fps"
    NK["architecture", "api_decisions"] = "purpose"
    NK["architecture", "forbidden_patterns"] = "pattern"
    # The status values each registry documents in its header.
    ALLOWED["entities"] = "active|deprecated"
    ALLOWED["tr"] = "active|deprecated|\"superseded-by: TR-<system>-NNN\""
    ALLOWED["architecture"] = "active|\"superseded_by: ADR-NNNN\""
    # A TR-ID: TR-, a slug of lowercase words joined by hyphens, -, digits.
    TRID = "TR-[a-z0-9]+(-[a-z0-9]+)*-[0-9]+"
    SQ = sprintf("%c", 39)
    cmd = ENVIRON["RG_CMD"]; nreg = 0; nscan = 0; ne = 0; nlay = 0; ncite = 0; nunq = 0
    while ((getline l < "/dev/stdin") > 0) {
      split(l, p, "\t")
      a = (p[3] ~ /^\// || p[3] ~ /^[A-Za-z]:/) ? p[3] : "./" p[3]
      if (p[1] == "S") { nscan++; KIND[a] = "S"; ARGV[ARGC++] = a; continue }
      nreg++; RN[nreg] = p[2]; RP[nreg] = (4 in p) ? p[4] : p[3]; RMISS[nreg] = (p[1] == "M")
      if (p[1] == "R") { KIND[a] = "R"; RIDX[a] = nreg; ARGV[ARGC++] = a }
    }
    cur_r = 0
  }

  function layout(found, expected, ln) {
    nlay++; LR[nlay] = cur_r; LF[nlay] = found; LE[nlay] = expected; LL[nlay] = (ln == "") ? FNR : ln
    BAD[cur_r] = 1
  }
  # The closing quote q in s (a backslash escapes a double quote; two single
  # quotes are one), or 0.
  function qclose(s, q,    i, c) {
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (q == "\"" && c == "\\") { i++; continue }
      if (c == q) { if (q == "'"'"'" && substr(s, i + 1, 1) == "'"'"'") { i++; continue } return i }
    }
    return 0
  }
  # "key: value" or "key:" -> K and V; 0 when s does not start with a plain key.
  function keysplit(s,    p) {
    p = index(s, ": ")
    if (p == 0 && substr(s, length(s)) == ":") p = length(s)
    if (p <= 1) return 0
    K = substr(s, 1, p - 1); V = substr(s, p + 1)
    sub(/^[ \t]+/, "", V); sub(/[ \t]+$/, "", V)
    return (K ~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
  }
  # A value -> PV (its text), PQ (its quote, if quoted), PUNCL (the quote does
  # not close on this line), PFLOW / PFLOWOPEN (a [..] or {..} and whether it
  # runs past the line), PBLOCK (| or >), PCOLON (plain, holding ": ").
  function pval(v,    c, rest, i, h, closer) {
    PV = ""; PQ = ""; PUNCL = 0; PFLOW = 0; PFLOWOPEN = 0; PBLOCK = 0; PCOLON = 0
    if (v == "") return
    c = substr(v, 1, 1)
    if (c == "#") return
    if (c == "\"" || c == "'"'"'") {
      PQ = c; rest = substr(v, 2); i = qclose(rest, c)
      if (i == 0) { PUNCL = 1; PV = rest; return }
      PV = substr(rest, 1, i - 1)
      if (c == "'"'"'") gsub(/'"''"'/, "'"'"'", PV); else gsub(/\\"/, "\"", PV)
      return
    }
    if (c == "[" || c == "{") {
      PFLOW = 1; h = v; i = index(h, " #"); if (i > 0) h = substr(h, 1, i - 1)
      sub(/[ \t]+$/, "", h); closer = (c == "[") ? "]" : "}"
      if (substr(h, length(h)) != closer) PFLOWOPEN = 1
      PV = h; return
    }
    if (v ~ /^[|>][-+0-9]*([ \t]+#.*)?$/) { PBLOCK = 1; return }
    i = index(v, " #"); if (i > 0) v = substr(v, 1, i - 1)
    sub(/[ \t]+$/, "", v); PV = v
    if (index(v, ": ") > 0 || substr(v, length(v)) == ":") PCOLON = 1
  }
  function addref(e, how, path, ln) {
    if (path == "") return
    NR_[e]++; RFP[e, NR_[e]] = path; RFH[e, NR_[e]] = how; RFL[e, NR_[e]] = ln
    if (how == SRCF[RN[cur_r]] && ESRC[e] == "") ESRC[e] = path
  }
  function close_entry() { inentry = 0; cf = ""; cflist = 0; cfplain = 0 }
  function open_entry() {
    ne++; ER[ne] = cur_r; ES[ne] = sec; EL[ne] = FNR; EE[ne] = FNR
    EK[ne] = ""; EN[ne] = ""; ESRC[ne] = ""; NR_[ne] = 0; ESTSET[ne] = 0
    cur = ne; inentry = 1; cf = ""; cflist = 0; cfplain = 0; listcol = -1
  }
  function start_reg(r) {
    cur_r = r; sec = ""; secempty = 0; dcol = -1; fcol = -1; inq = ""; inq_line = 0; blk = -1; close_entry()
  }
  # opens(s, n): when line s (at indent n, its leading spaces removed) opens a
  # block scalar (a value of | or >, with any indicators), the indent its text
  # must exceed; else -1. The text is never a section, an entry, a field or a
  # tab in the indent: yaml-get.awk reads by the same rule.
  function opens(s, n,    r, p, v) {
    r = s
    if (r == "-" || substr(r, 1, 2) == "- ") {
      r = substr(r, 2); sub(/^ +/, "", r)
      if (r ~ /^[|>][-+0-9]*[ \t]*(#.*)?$/) return n
      n = n + length(s) - length(r)
    }
    if (r == "" || r ~ /^[:# \t]/) return -1
    p = index(r, ":"); if (p == 0) return -1
    v = substr(r, p + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
    return (v ~ /^[|>][-+0-9]*[ \t]*(#.*)?$/) ? n : -1
  }
  function end_reg() {
    if (cur_r && inq != "") layout("a quote that never closes", "the closing quote", inq_line)
    inq = ""
  }
  # The superseded status 1.1.x wrote into the architecture registry without
  # quotes: status: superseded_by: <id>, with no other ": " after it.
  function legacy_status(v,    rest) {
    if (RN[cur_r] != "architecture" || K != "status" || substr(v, 1, 15) != "superseded_by: ") return 0
    rest = substr(v, 16)
    return rest != "" && index(rest, ": ") == 0 && substr(rest, length(rest)) != ":"
  }
  # A field line: KEY (K) and its raw value (V) at the field column.
  function field(ln) {
    pval(V)
    cf = K; listcol = -1
    cflist = (PV == "" && PQ == "" && !PFLOW && !PBLOCK)
    cfplain = (!cflist && !PBLOCK && !PUNCL)
    EE[cur] = ln
    if (PCOLON && legacy_status(PV)) { nunq++; UR[nunq] = cur_r; UV[nunq] = PV; UL[nunq] = ln }
    else if (PCOLON) layout("an unquoted value holding \": \"", "the value in quotes")
    if (PFLOWOPEN) layout("a flow list or map that runs past its line", "[a, b] on one line, or a block list")
    if (PUNCL) { inq = PQ; inq_line = ln }
    if (K == "status") { EST[cur] = PV; ESTL[cur] = ln; ESTSET[cur] = 1 }
    if (K == SRCF[RN[cur_r]]) addref(cur, K, PV, ln)
    if (K == "referenced_by" && PFLOW && !PFLOWOPEN) flow_refs(PV, ln)
  }
  function flow_refs(v, ln,    n, a, i, it) {
    v = substr(v, 2, length(v) - 2)
    n = split(v, a, ",")
    for (i = 1; i <= n; i++) {
      it = a[i]; sub(/^[ \t]+/, "", it); sub(/[ \t]+$/, "", it)
      pval(it); addref(cur, "referenced_by", PV, ln)
    }
  }
  function list_item(s, ln) {
    if (cf != "referenced_by") return
    pval(substr(s, 3)); addref(cur, "referenced_by", PV, ln)
  }
  # A line deeper than the field column: part of the field above it.
  function deeper(n, s) {
    EE[cur] = FNR
    if (cflist) {
      if (s == "-" || substr(s, 1, 2) == "- ") {
        if (listcol == -1) listcol = n
        if (n == listcol) list_item(s, FNR)
      }
      return
    }
    if (cfplain && (index(s, ": ") > 0 || substr(s, length(s)) == ":"))
      layout("a key at column " n " under the value of " cf ":", "a field at column " fcol ", or the value in quotes")
  }
  function top_line(s,    known) {
    close_entry(); sec = ""; secempty = 0; dcol = -1
    if (s == "---" || s == "...") return
    if (!keysplit(s)) { layout("text with no key", "key: value at column 0"); return }
    pval(V)
    if (PV == "" && PQ == "" && !PFLOW && !PBLOCK) { sec = K; return }
    if (PFLOW && PV == "[]") { sec = K; secempty = 1; return }
    if ((RN[cur_r], K) in NK) layout("a value after " K ":", "[] or nothing after " K ":, the entries below")
  }
  function dash_line(n, s,    rest, nk, first) {
    if (sec == "") { close_entry(); layout("a list item outside a section", "a section key at column 0 above it"); return }
    if (secempty) { layout("a list item under " sec ": []", "nothing after " sec ": when it has entries"); return }
    if (inentry && n > dcol) {
      if (n > fcol) { deeper(n, s); return }
      if (n == fcol && cflist && (listcol == -1 || listcol == fcol)) { listcol = fcol; EE[cur] = FNR; list_item(s, FNR); return }
      if (n == fcol) { layout("a list item at column " fcol, "a field at column " fcol ", or a list under a field with no value"); return }
      layout("a list item at column " n, "column " dcol " for the next entry, or deeper than column " fcol); return
    }
    close_entry()
    if (dcol == -1) {
      # The two columns the shipped registries use: 0 (tr-registry.yaml) and
      # 2 (entities.yaml, architecture.yaml). Another column is reported, then
      # taken, so the lines below it are still checked.
      if (n != 0 && n != 2) layout("a list item at column " n, "column 0 or 2")
      dcol = n; fcol = n + 2
    } else if (n != dcol) {
      layout("a list item at column " n, "column " dcol ", like the first entry of " sec); return
    }
    open_entry()
    rest = (s == "-") ? "" : substr(s, 3)
    if (!keysplit(rest)) { layout("an entry with no key", "- key: value"); return }
    nk = ((RN[cur_r], sec) in NK) ? NK[RN[cur_r], sec] : ""
    if (nk != "" && index(" " nk " ", " " K " ") == 0) {
      first = nk; sub(/ .*/, "", first)
      layout("an entry that starts with " K ":", "- " first ": as the first line of each entry")
    }
    pval(V)
    if (PV == "" && PQ == "" && !PFLOW && !PUNCL) layout("an entry with an empty " K, "- " K ": <name>")
    EK[cur] = K; EN[cur] = PV
    field(FNR)
  }
  function plain_line(n, s) {
    if (sec == "") { layout("an indented line outside a section", "a section key at column 0 above it"); return }
    if (!inentry) { layout("a line at column " n " before any entry", "- key: value at column 0 or 2"); return }
    if (n > fcol) { deeper(n, s); return }
    if (n < fcol) { layout("a line at column " n, "a field at column " fcol ", two past the dash"); return }
    if (!keysplit(s)) { layout("text with no key at column " fcol, "key: value"); return }
    field(FNR)
  }
  function reg_line(line,    t, n, s) {
    RAW[cur_r, FNR] = line
    if (inq != "") { if (qclose(line, inq)) inq = ""; if (inentry) EE[cur] = FNR; return }
    t = line; sub(/^[ \t]+/, "", t)
    if (t == "" || substr(t, 1, 1) == "#") return
    n = 0; while (substr(line, n + 1, 1) == " ") n++
    if (blk >= 0) { if (n > blk) { if (inentry) EE[cur] = FNR; return } blk = -1 }
    if (line ~ /^ *\t/) { layout("a tab in the indent", "spaces only"); return }
    s = substr(line, n + 1)
    blk = opens(s, n)
    if (s == "-" || substr(s, 1, 2) == "- ") { dash_line(n, s); return }
    if (n == 0) { top_line(s); return }
    plain_line(n, s)
  }
  function scan_line(line, file,    base, rest, abs, pre, aft) {
    base = 0; rest = line
    while (match(rest, TRID)) {
      abs = base + RSTART
      pre = (abs > 1) ? substr(line, abs - 1, 1) : ""
      aft = substr(line, abs + RLENGTH, 1)
      if (pre !~ /[A-Za-z0-9-]/ && aft !~ /[A-Za-z0-9]/) { ncite++; CI[ncite] = substr(line, abs, RLENGTH); CF[ncite] = file; CL[ncite] = FNR }
      base = abs + RLENGTH - 1; rest = substr(line, base + 1)
    }
  }

  FNR == 1 {
    end_reg(); cur_r = 0
    fk = KIND[FILENAME]; fname = substr(FILENAME, 3)
    if (fk == "R") start_reg(RIDX[FILENAME])
  }
  {
    line = $0; sub(/\r$/, "", line)
    # "\357\273\277" is the UTF-8 byte-order mark.
    if (FNR == 1 && substr(line, 1, 3) == "\357\273\277") line = substr(line, 4)
    if (fk == "R") reg_line(line); else scan_line(line, fname)
  }

  function tsv(s) { gsub(/\t/, " ", s); return (s == "") ? "-" : s }
  function ok(e) { return !BAD[ER[e]] }
  function entry_row(e) {
    printf "ENTRY\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", RN[ER[e]], tsv(ES[e]), tsv(EK[e]), tsv(EN[e]), \
      (ESTSET[e] ? tsv(EST[e]) : "-"), tsv(ESRC[e]), EL[e]
  }
  function block(e,    i) { entry_row(e); for (i = EL[e]; i <= EE[e]; i++) print RAW[ER[e], i] }
  function layout_rows(    i) {
    for (i = 1; i <= nlay; i++)
      printf "LAYOUT\t%s\t%s\t%s\t%s\t%d\n", RN[LR[i]], RP[LR[i]], LF[i], LE[i], LL[i]
  }
  function unquoted_rows(    i) {
    for (i = 1; i <= nunq; i++)
      printf "UNQUOTED\t%s\t%s\t%s\tstatus: \"%s\"\t%d\n", RN[UR[i]], RP[UR[i]], tsv(UV[i]), tsv(UV[i]), UL[i]
  }
  function anybad(    r) { for (r = 1; r <= nreg; r++) if (BAD[r]) return 1; return 0 }
  # The TR-ID anchored on slug s: TR-<s>-<digits> and nothing more.
  function on_slug(id, s,    rest) {
    if (substr(id, 1, length(s) + 4) != "TR-" s "-") return 0
    rest = substr(id, length(s) + 5)
    return (rest != "" && rest !~ /[^0-9]/)
  }
  # Whether each path the entries name exists, file or directory, by test -e
  # in the shell: getline cannot read a directory (and some awks stop on one).
  # One shell per hundred paths, each path in single quotes.
  function shq(s,    out, i) {
    out = ""
    while ((i = index(s, SQ)) > 0) { out = out substr(s, 1, i - 1) SQ "\\" SQ SQ; s = substr(s, i + 1) }
    return SQ out s SQ
  }
  function check_paths(    e, j, p, n, a, b, i, sh, r) {
    n = 0
    for (e = 1; e <= ne; e++) if (ok(e)) for (j = 1; j <= NR_[e]; j++) {
      p = RFP[e, j]
      if (!(p in QUEUED)) { QUEUED[p] = 1; QP[++n] = p }
    }
    for (a = 1; a <= n; a += 100) {
      b = (a + 99 < n) ? a + 99 : n
      sh = "for p in"; for (i = a; i <= b; i++) sh = sh " " shq(QP[i])
      sh = sh "; do if [ -e \"$p\" ]; then echo y; else echo n; fi; done"
      i = a
      while ((sh | getline r) > 0) { if (i <= b) EXISTS[QP[i]] = (r == "y"); i++ }
      close(sh)
      # A path the shell gave no answer for is not reported missing.
      for (; i <= b; i++) EXISTS[QP[i]] = 1
    }
  }
  function exists(p) { return (p in EXISTS) ? EXISTS[p] : 1 }
  function status_ok(reg, v,    n, a, i, it) {
    if (v == "active") return 1
    if (reg == "entities") return v == "deprecated"
    if (reg == "architecture") return v ~ /^superseded_by: ADR-[0-9]+$/
    if (v == "deprecated") return 1
    if (substr(v, 1, 15) != "superseded-by: ") return 0
    n = split(substr(v, 16), a, ",")
    for (i = 1; i <= n; i++) { it = a[i]; sub(/^ +/, "", it); sub(/ +$/, "", it); if (it !~ ("^" TRID "$")) return 0 }
    return n > 0
  }

  END {
    end_reg()
    for (e = 1; e <= ne; e++) CNT[ER[e]]++
    if (cmd != "next-id")
      for (r = 1; r <= nreg; r++)
        printf "registry\t%s\t%s\t%s\n", RN[r], RP[r], RMISS[r] ? "missing" : (BAD[r] ? "layout" : CNT[r] + 0)
    rc = 0

    if (cmd == "list") {
      sys = ENVIRON["RG_SYS"]
      for (e = 1; e <= ne; e++) if (ok(e) && (sys == "" || on_slug(EN[e], sys))) entry_row(e)
    }

    else if (cmd == "get") {
      nn = split(ENVIRON["RG_NAMES"], names, "\n"); nmiss = 0
      for (i = 1; i <= nn; i++) {
        if (names[i] == "") continue
        hit = 0
        for (e = 1; e <= ne; e++) if (ok(e) && EN[e] == names[i]) { block(e); hit = 1 }
        if (!hit) MISS[++nmiss] = names[i]
      }
    }

    else if (cmd == "refs") {
      a = ENVIRON["RG_ARG"]
      if (index(a, "/")) {
        for (e = 1; e <= ne; e++) if (ok(e))
          for (j = 1; j <= NR_[e]; j++) if (RFP[e, j] == a)
            printf "REF\t%s\t%s\t%s\t%s\t%d\n", RN[ER[e]], tsv(EN[e]), RFH[e, j], RFP[e, j], RFL[e, j]
      } else {
        hit = 0
        for (e = 1; e <= ne; e++) if (ok(e) && EN[e] == a) {
          hit = 1
          for (j = 1; j <= NR_[e]; j++)
            printf "REF\t%s\t%s\t%s\t%s\t%d\n", RN[ER[e]], tsv(EN[e]), RFH[e, j], RFP[e, j], RFL[e, j]
          if (RN[ER[e]] == "tr")
            for (c = 1; c <= ncite; c++) if (CI[c] == a)
              printf "REF\ttr\t%s\tcited\t%s\t%d\n", a, CF[c], CL[c]
        }
        if (!hit) MISS[++nmiss] = a
      }
    }

    else if (cmd == "slice") {
      a = ENVIRON["RG_ARG"]
      for (e = 1; e <= ne; e++) if (ok(e))
        for (j = 1; j <= NR_[e]; j++) if (RFP[e, j] == a) { block(e); break }
    }

    else if (cmd == "validate") {
      nd = 0; nt = 0; np = 0; ns = 0
      for (e = 1; e <= ne; e++) {
        if (!ok(e) || EN[e] == "") continue
        k = ER[e] SUBSEP ES[e] SUBSEP EN[e]
        if (k in DL) DL[k] = DL[k] "," EL[e]; else { DL[k] = EL[e]; DORD[++ndk] = e }
      }
      for (i = 1; i <= ndk; i++) {
        e = DORD[i]; k = ER[e] SUBSEP ES[e] SUBSEP EN[e]
        if (index(DL[k], ",")) DROW[++nd] = sprintf("DUPLICATE\t%s\t%s\t%s\t%s", RN[ER[e]], ES[e], tsv(EN[e]), DL[k])
      }
      trr = 0; for (r = 1; r <= nreg; r++) if (RN[r] == "tr") trr = r
      if (!(trr && BAD[trr])) {
        for (e = 1; e <= ne; e++) if (RN[ER[e]] == "tr") TRK[EN[e]] = 1
        for (c = 1; c <= ncite; c++) if (!(CI[c] in TRK)) TROW[++nt] = sprintf("TR_UNKNOWN\t%s\t%s\t%d", CI[c], CF[c], CL[c])
      }
      check_paths()
      for (e = 1; e <= ne; e++) if (ok(e))
        for (j = 1; j <= NR_[e]; j++) if (!exists(RFP[e, j]))
          PROW[++np] = sprintf("PATH_MISSING\t%s\t%s\t%s\t%s\t%d", RN[ER[e]], tsv(EN[e]), RFH[e, j], RFP[e, j], RFL[e, j])
      for (e = 1; e <= ne; e++) if (ok(e) && ESTSET[e] && !status_ok(RN[ER[e]], EST[e]))
        SROW[++ns] = sprintf("STATUS\t%s\t%s\t%s\t%s\t%d", RN[ER[e]], tsv(EN[e]), (EST[e] == "" ? "\"\"" : tsv(EST[e])), ALLOWED[RN[ER[e]]], ESTL[e])
      printf "checked\tproduction/epics\t%d\nduplicate\t%d\ntr_unknown\t%d\npath_missing\t%d\nstatus\t%d\nlayout\t%d\n", nscan, nd, nt, np, ns, nlay
      for (i = 1; i <= nd; i++) print DROW[i]
      for (i = 1; i <= nt; i++) print TROW[i]
      for (i = 1; i <= np; i++) print PROW[i]
      for (i = 1; i <= ns; i++) print SROW[i]
      layout_rows(); unquoted_rows()
      exit 0
    }

    else if (cmd == "compare") {
      # Registry 1 is OLD and 2 is NEW, the order the file list gave them. An
      # entry is its section and name, as validate keys a duplicate.
      for (e = 1; e <= ne; e++) {
        k = ES[e] SUBSEP EN[e]
        if (ER[e] == 2) NEWK[k] = 1
        else if (ESTSET[e] && !(k in OLDST)) OLDST[k] = EST[e]
      }
      nrm = 0; nst = 0
      if (RMISS[1]) removed = 0
      else if (RMISS[2] || BAD[1] || BAD[2]) removed = "-"
      else {
        for (e = 1; e <= ne; e++) if (ER[e] == 1 && EN[e] != "") {
          k = ES[e] SUBSEP EN[e]
          if ((k in NEWK) || (k in GONE)) continue
          GONE[k] = 1
          RROW[++nrm] = sprintf("REMOVED\t%s\t%s\t%s\t%d", RN[1], tsv(ES[e]), tsv(EN[e]), EL[e])
        }
        removed = nrm
      }
      if (!BAD[2]) for (e = 1; e <= ne; e++) if (ER[e] == 2 && ESTSET[e] && !status_ok(RN[2], EST[e])) {
        k = ES[e] SUBSEP EN[e]
        if ((k in OLDST) && OLDST[k] == EST[e]) continue
        SROW[++nst] = sprintf("STATUS\t%s\t%s\t%s\t%s\t%d", RN[2], tsv(EN[e]), (EST[e] == "" ? "\"\"" : tsv(EST[e])), ALLOWED[RN[2]], ESTL[e])
      }
      printf "removed\t%s\nstatus\t%d\nlayout\t%d\n", removed, nst, nlay
      for (i = 1; i <= nrm; i++) print RROW[i]
      for (i = 1; i <= nst; i++) print SROW[i]
      layout_rows(); unquoted_rows()
      exit 0
    }

    else if (cmd == "next-id") {
      if (anybad()) { layout_rows(); exit 4 }
      s = ENVIRON["RG_ARG"]; max = -1; n = 0
      for (e = 1; e <= ne; e++) if (on_slug(EN[e], s)) {
        d = substr(EN[e], length(s) + 5) + 0
        if (!(d in SEEN)) { SEEN[d] = 1; n++ }
        if (d > max) max = d
      }
      # Three digits: the TR-ID format, TR-[system]-[NNN].
      printf "next\ttr\t%s\tTR-%s-%03d\t%s\t%d\n", s, s, (max < 0 ? 1 : max + 1), (max < 0 ? "-" : sprintf("TR-%s-%03d", s, max)), n
      exit 0
    }

    if (anybad()) { layout_rows(); rc = 4 }
    unquoted_rows()
    for (i = 1; i <= nmiss; i++) printf "NOT_FOUND\t%s\n", MISS[i]
    if (!rc && nmiss) rc = 3
    exit rc
  }
'
rc=$?
[ "$rc" = 4 ] && echo "registry: unsupported layout; the LAYOUT rows give each line and the layout expected there" >&2
exit $rc
