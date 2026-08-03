.PHONY: test install

CLAUDE_DIR ?= $(HOME)/.claude

test:
	bash -n worktree-cotenancy.sh
	bash worktree-cotenancy.test.sh

# Symlink rather than copy so the installed hook cannot drift from source.
install:
	mkdir -p $(CLAUDE_DIR)/hooks
	ln -sfn $(CURDIR)/worktree-cotenancy.sh $(CLAUDE_DIR)/hooks/worktree-cotenancy.sh
