.PHONY: test install

CLAUDE_DIR ?= $(HOME)/.claude

test:
	bash -n artifact-hygiene-push.sh artifact-hygiene-push.test.sh
	bash artifact-hygiene-push.test.sh

# Symlink rather than copy so the installed hook cannot drift from source.
install:
	mkdir -p "$(CLAUDE_DIR)/hooks"
	ln -sfn "$(CURDIR)/artifact-hygiene-push.sh" "$(CLAUDE_DIR)/hooks/artifact-hygiene-push.sh"
