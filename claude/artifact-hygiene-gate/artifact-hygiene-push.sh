#!/usr/bin/env bash
# PreToolUse(Bash) gate: run artifact-hygiene before any `git push`; deny on findings or partial coverage.
set -euo pipefail

deny_unproven_repo() {
  echo "artifact-hygiene: push repository could not be proven; use standalone git -C /absolute/repository push ...; push denied." >&2
  exit 2
}

input="$(cat)" || deny_unproven_repo
command="$(printf '%s' "$input" | python3 -I -c '
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

# Keep report bytes off shell variables/argv; only fixed diagnostics and counts return.
if summary="$(
  (cd "$repo" && "$audit") 2>/dev/null | python3 -I -c '
import json
import sys


def require(condition):
    if not condition:
        raise ValueError()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError()


try:
    raw = sys.stdin.buffer.read(4_000_001)
    require(len(raw) <= 4_000_000)
    report = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                        parse_constant=reject_constant)
    require(isinstance(report, dict))
    require(report["schemaVersion"] == "artifact-hygiene/v1")
    require(report["status"] == "complete")
    require(isinstance(report["coverage"], list))
    sources = set()
    for entry in report["coverage"]:
        require(isinstance(entry, dict))
        source = entry["source"]
        require(isinstance(source, str) and bool(source))
        require(source not in sources)
        sources.add(source)
        require(entry["status"] == "complete")
        require(entry["errors"] == [] and entry["limits"] == [])
    require({"working-tree", "branch-history", "custom-detectors"} <= sources)
    findings = report["findings"]
    require(isinstance(findings, list))
    require(report["verdict"] == ("findings" if findings else "clean"))
    counts = {severity: 0 for severity in ("critical", "high", "medium", "low", "info")}
    for finding in findings:
        require(isinstance(finding, dict))
        require(isinstance(finding["category"], str) and bool(finding["category"]))
        severity = finding["severity"]
        require(isinstance(severity, str) and severity in counts)
        counts[severity] += 1
except Exception:
    print("invalid audit report")
    sys.exit(2)

blocking = [f"{severity}={count}" for severity, count in counts.items()
            if severity != "info" and count]
if blocking:
    print("blocking findings: " + ", ".join(blocking))
    sys.exit(2)
' 2>/dev/null
  results=("${PIPESTATUS[@]}")
  if [[ "${results[0]}" -ne 0 ]]; then
    printf '\naudit helper failed or returned incomplete coverage (exit %s)\n' "${results[0]}"
    exit 2
  fi
  exit "${results[1]}"
)"; then
  echo "artifact-hygiene passed 'git push' for $repo"
  exit 0
fi

{
  echo "artifact-hygiene denied 'git push' for $repo:"
  printf '%s\n' "${summary:-audit report validation failed}"
  echo "Run /artifact-hygiene for the full redacted report; fix findings or restore complete audit coverage."
} >&2
exit 2
