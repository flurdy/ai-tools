PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions
PI_THEMES_DIR ?= $(PI_AGENT_DIR)/themes

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply

help:
	@echo "make apply         Link reviewed local Pi resources into $(PI_AGENT_DIR)"
	@echo "make verify-apply  Verify the managed Pi resource links"

apply:
	mkdir -p "$(PI_EXTENSIONS_DIR)" "$(PI_THEMES_DIR)"
	ln -sfn "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"
	ln -sfn "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"
	ln -sfn "$(CURDIR)/pi/watch-loop" "$(PI_EXTENSIONS_DIR)/watch-loop"
	ln -sfn "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover newly linked extensions."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-statusline")" = "$(CURDIR)/pi/statusline"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts")" = "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/watch-loop")" = "$(CURDIR)/pi/watch-loop"
	test "$$(readlink "$(PI_THEMES_DIR)/flurdy-dark.json")" = "$(CURDIR)/pi/theme/flurdy-dark.json"
