PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions
PI_THEMES_DIR ?= $(PI_AGENT_DIR)/themes
SESSION_MODE_PACKAGE ?= $(PI_EXTENSIONS_DIR)/flurdy-session-mode

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply prepare-statusline verify-statusline check

help:
	@echo "make check         Test the Claude and Codex artifact-hygiene gates"
	@echo "make apply         Link reviewed local Pi resources into $(PI_AGENT_DIR)"
	@echo "make verify-apply  Verify the managed Pi resource links"
	@echo "make prepare-statusline SESSION_MODE_PACKAGE=/path/to/package  Wire the observer dependency"

check:
	$(MAKE) -C claude/artifact-hygiene-gate test
	$(MAKE) -C codex/artifact-hygiene-gate test
	@tests/test-watch-loop-extraction.sh
	@bash tests/test-session-mode-extraction.sh
	node --test pi/statusline/session-mode-package.test.mjs

prepare-statusline:
	node pi/statusline/session-mode-package.mjs link "$(SESSION_MODE_PACKAGE)"

verify-statusline:
	node pi/statusline/session-mode-package.mjs verify "$(SESSION_MODE_PACKAGE)"

apply: prepare-statusline
	mkdir -p "$(PI_EXTENSIONS_DIR)" "$(PI_THEMES_DIR)"
	ln -sfn "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"
	ln -sfn "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"
	ln -sfn "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover newly linked extensions."

verify-apply: verify-statusline
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-statusline")" = "$(CURDIR)/pi/statusline"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts")" = "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts"
	test "$$(readlink "$(PI_THEMES_DIR)/flurdy-dark.json")" = "$(CURDIR)/pi/theme/flurdy-dark.json"
