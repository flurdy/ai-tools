.PHONY: test install

CLAUDE_DIR ?= $(HOME)/.claude

test:
	bash -n statusline-command.sh
	bash statusline-command.test.sh

# Symlink rather than copy so the installed statusline cannot drift from source.
install:
	mkdir -p $(CLAUDE_DIR)
	ln -sfn $(CURDIR)/statusline-command.sh $(CLAUDE_DIR)/statusline-command.sh
