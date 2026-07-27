#!/usr/bin/env bash
set -euo pipefail

repository_root=$(git rev-parse --show-toplevel)
if ! git -C "$repository_root" diff --quiet || ! git -C "$repository_root" diff --cached --quiet; then
	echo "verify-git-install requires a clean tracked working tree" >&2
	exit 1
fi

git -C "$repository_root" ls-files --error-unmatch package.json >/dev/null
commit=$(git -C "$repository_root" rev-parse HEAD)
base_path=$(dirname "$(dirname "$repository_root")")
repository_path=$(realpath --relative-to="$base_path" "$repository_root")
temporary_root=$(mktemp -d)
daemon_pid=""
cleanup() {
	if [[ -n "$daemon_pid" ]]; then
		kill "$daemon_pid" 2>/dev/null || true
		wait "$daemon_pid" 2>/dev/null || true
	fi
	rm -rf "$temporary_root"
}
trap cleanup EXIT

port=$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
git daemon \
	--reuseaddr \
	--export-all \
	--base-path="$base_path" \
	--listen=127.0.0.1 \
	--port="$port" \
	"$repository_root" \
	>"$temporary_root/git-daemon.log" 2>&1 &
daemon_pid=$!

repository_url="git://localhost:$port/$repository_path"
for _ in $(seq 1 50); do
	if git ls-remote "$repository_url" HEAD >/dev/null 2>&1; then
		break
	fi
	sleep 0.1
done
if ! git ls-remote "$repository_url" HEAD >/dev/null 2>&1; then
	cat "$temporary_root/git-daemon.log" >&2
	echo "git daemon did not become ready" >&2
	exit 1
fi

agent_dir="$temporary_root/agent"
work_dir="$temporary_root/work"
mkdir -p "$agent_dir" "$work_dir"
source="git:$repository_url@$commit"
(
	cd "$work_dir"
	PI_CODING_AGENT_DIR="$agent_dir" \
	PI_SKIP_VERSION_CHECK=1 \
	PI_TELEMETRY=0 \
	GIT_TERMINAL_PROMPT=0 \
	GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" \
	pi install "$source"
)

installed_path="$agent_dir/git/localhost/$repository_path"
test "$(git -C "$installed_path" rev-parse HEAD)" = "$commit"
test ! -e "$installed_path/pi/model-tier-router/model-tier-router.json"

config_path="$agent_dir/model-tier-router.json"
printf '%s\n' '{"enabled":false,"tiers":{}}' >"$config_path"
printf '%s\n' \
	'{"id":"commands","type":"get_commands"}' \
	'{"id":"status","type":"prompt","message":"/model-tier status"}' \
	| (
		cd "$work_dir"
		PI_CODING_AGENT_DIR="$agent_dir" \
		PI_SKIP_VERSION_CHECK=1 \
		PI_TELEMETRY=0 \
		timeout 20 pi --mode rpc --no-session
	) >"$temporary_root/rpc-output.jsonl" 2>"$temporary_root/rpc-error.log"

node "$repository_root/pi/model-tier-router/scripts/verify-rpc-output.mjs" \
	"$temporary_root/rpc-output.jsonl" \
	"$config_path"

echo "Verified git package at immutable ref $commit"
