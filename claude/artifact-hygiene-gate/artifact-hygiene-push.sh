#!/usr/bin/env bash
# PreToolUse(Bash) gate: run artifact-hygiene before any `git push`; deny on findings or partial coverage.
set -euo pipefail

deny_unproven_repo() {
  echo "artifact-hygiene: push repository could not be proven; use standalone git -C /absolute/repository push ...; push denied." >&2
  exit 2
}

input="$(cat)" || deny_unproven_repo
command="$(printf '%s' "$input" | python3 -c '
import json, sys
command = json.load(sys.stdin)["tool_input"]["command"]
assert isinstance(command, str) and command and "\0" not in command
print(command)
' 2>/dev/null)" || deny_unproven_repo
if printf '%s' "$command" | grep -E "(^|[;&|()'\"[:space:]])git([[:space:]]+[^;&|()[:space:]]+)*[[:space:]]+push([;&|()'\"[:space:]]|$)" >/dev/null; then
  :
else
  [[ "$?" -eq 1 ]] && exit 0
  deny_unproven_repo
fi

# This gate intentionally accepts only one standalone Git command. Shell wrappers and
# chains can change directory or hide another Git invocation, so auditing any inferred
# fallback would create false assurance.
[[ "$command" != *$'\n'* ]] || deny_unproven_repo
for variable in GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_CEILING_DIRECTORIES \
  GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT \
  GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM; do
  [[ -z "${!variable+x}" ]] || deny_unproven_repo
done
read -r -a words <<< "$command"
for word in "${words[@]}"; do
  [[ "$word" =~ ^[-a-zA-Z0-9_./:@%+=,]+$ ]] || deny_unproven_repo
done
[[ "${words[0]:-}" == "git" ]] || deny_unproven_repo

candidate=""
seen_c=0
push_index=-1
for ((i = 1; i < ${#words[@]}; i++)); do
  case "${words[i]}" in
    push)
      push_index=$i
      break
      ;;
    -C)
      ((seen_c == 0)) || deny_unproven_repo
      ((i + 1 < ${#words[@]})) || deny_unproven_repo
      candidate="${words[++i]}"
      seen_c=1
      ;;
    --no-pager|--paginate|--literal-pathspecs|--no-literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)
      ;;
    *)
      deny_unproven_repo
      ;;
  esac
done
((push_index >= 0)) || deny_unproven_repo

[[ "$candidate" == /* ]] || deny_unproven_repo
repo="$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null)" || deny_unproven_repo
[[ -n "$repo" ]] || deny_unproven_repo

audit="$HOME/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py"
[[ -x "$audit" ]] || { echo "artifact-hygiene: helper missing at $audit; push denied for $repo." >&2; exit 2; }

report="$(cd "$repo" && "$audit" 2>/dev/null)" && status=0 || status=$?

summary="$(printf '%s' "$report" | python3 -c '
import json, sys
from collections import Counter
try:
    r = json.load(sys.stdin)
except ValueError:
    print("unreadable report"); sys.exit(0)
partial = [c["source"] + ":" + ",".join(c.get("errors") or ["partial"]) for c in r.get("coverage", []) if c.get("status") != "complete"]
counts = Counter((f["severity"] if "severity" in f else "?", f["category"]) for f in r.get("findings", []))
if partial: print("partial coverage: " + "; ".join(partial))
for (sev, cat), n in sorted(counts.items()): print(f"{n} {sev} {cat}")
print("verdict: " + str(r.get("verdict")))
')"

# Pass on a complete audit whose only findings are informational (for example the
# audit's own history); anything high/medium/low or partial coverage still denies.
if [[ "$status" -eq 0 ]] && ! printf '%s' "$summary" | grep -qE '^[0-9]+ (high|medium|low|\?) '; then
  echo "artifact-hygiene passed 'git push' for $repo"
  exit 0
fi

{
  echo "artifact-hygiene denied 'git push' for $repo (exit $status):"
  printf '%s\n' "$summary"
  echo "Run /artifact-hygiene for the full redacted report; fix findings, or install gitleaks if coverage is partial."
} >&2
exit 2
