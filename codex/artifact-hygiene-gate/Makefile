.PHONY: test install

CODEX_DIR ?= $(HOME)/.codex
GATE_SOURCE := $(abspath $(CURDIR)/../../claude/artifact-hygiene-gate/artifact-hygiene-push.sh)

test:
	bash -n artifact-hygiene-gate.test.sh
	bash artifact-hygiene-gate.test.sh

# Share the Claude-tested implementation rather than maintaining a Codex copy.
install:
	test -x "$(GATE_SOURCE)"
	mkdir -p "$(CODEX_DIR)/hooks"
	ln -sfn "$(GATE_SOURCE)" "$(CODEX_DIR)/hooks/artifact-hygiene-push.sh"
