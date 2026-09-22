PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions
PI_THEMES_DIR ?= $(PI_AGENT_DIR)/themes

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply check check-notify

help:
	@echo "make check         Test artifact-hygiene gates, resource ownership and Pi notifications"
	@echo "make check-notify  Test Pi notifications and managed installation (Node >=22.19)"
	@echo "make apply         Link reviewed local Pi resources into $(PI_AGENT_DIR)"
	@echo "make verify-apply  Verify the managed Pi resource links"

check:
	$(MAKE) -C claude/artifact-hygiene-gate test
	$(MAKE) -C codex/artifact-hygiene-gate test
	@tests/test-watch-loop-extraction.sh
	@bash tests/test-session-mode-extraction.sh
	$(MAKE) check-notify

check-notify:
	node --test pi/notify/pi-notify.test.ts tests/pi-apply.test.mjs

apply:
	@set -e; check_link() { \
		if [ -e "$$2" ] || [ -L "$$2" ]; then \
			if [ "$$(readlink "$$2")" != "$$1" ]; then \
				echo "Refusing to replace $$2; inspect and relocate the conflicting resource first." >&2; exit 1; \
			fi; \
		fi; \
		test -e "$$1"; \
	}; \
	check_link "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"; \
	check_link "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"; \
	check_link "$(CURDIR)/pi/notify/pi-notify.ts" "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"; \
	check_link "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	mkdir -p "$(PI_EXTENSIONS_DIR)" "$(PI_THEMES_DIR)"
	ln -sfn "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"
	ln -sfn "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"
	ln -sfn "$(CURDIR)/pi/notify/pi-notify.ts" "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	ln -sfn "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover newly linked extensions."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-statusline")" = "$(CURDIR)/pi/statusline"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts")" = "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts")" = "$(CURDIR)/pi/notify/pi-notify.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	test "$$(readlink "$(PI_THEMES_DIR)/flurdy-dark.json")" = "$(CURDIR)/pi/theme/flurdy-dark.json"
