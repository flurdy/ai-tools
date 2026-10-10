PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions
PI_THEMES_DIR ?= $(PI_AGENT_DIR)/themes
BIN_DIR ?= $(HOME)/bin

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply check check-notify check-goal-baseline check-skill-spotlight check-quota

help:
	@echo "make check         Test artifact-hygiene gates, resource ownership, Pi UI extensions and goal fixture"
	@echo "make check-skill-spotlight  Test the opt-in startup skill tip (Node >=22.19)"
	@echo "make check-notify  Test Pi notifications and managed installation (Node >=22.19)"
	@echo "make check-goal-baseline  Check the goal fixture without launching models (Node >=22.19)"
	@echo "make check-quota   Test the codex-quota helper against a fake Codex CLI (Node >=22.19)"
	@echo "make apply         Link reviewed Pi resources into $(PI_AGENT_DIR) and codex-quota into $(BIN_DIR)"
	@echo "make verify-apply  Verify the managed resource and helper links"
	@echo "BIN_DIR=$(BIN_DIR) (override with an absolute directory on your PATH)"

check:
	$(MAKE) -C claude/artifact-hygiene-gate test
	$(MAKE) -C codex/artifact-hygiene-gate test
	@tests/test-watch-loop-extraction.sh
	@bash tests/test-session-mode-extraction.sh
	$(MAKE) check-notify
	$(MAKE) check-skill-spotlight
	$(MAKE) check-goal-baseline
	$(MAKE) check-quota

check-quota:
	node --test pi/quota/codex-quota-report.test.ts

check-notify:
	node --test pi/notify/pi-notify.test.ts tests/pi-apply.test.mjs

check-skill-spotlight:
	node --test pi/skill-spotlight/pi-skill-spotlight.test.ts

check-goal-baseline:
	node --test tests/goal-baseline.test.mjs

apply:
	@set -e; case "$(BIN_DIR)" in ""|/|[!/]*) echo "BIN_DIR must be an absolute non-root path" >&2; exit 1;; esac; \
	check_link() { \
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
	check_link "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts" "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"; \
	check_link "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"; \
	test -x "$(CURDIR)/pi/quota/codex-quota.ts"; \
	check_link "$(CURDIR)/pi/quota/codex-quota.ts" "$(BIN_DIR)/codex-quota"
	mkdir -p "$(PI_EXTENSIONS_DIR)" "$(PI_THEMES_DIR)" "$(BIN_DIR)"
	ln -sfn "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"
	ln -sfn "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"
	ln -sfn "$(CURDIR)/pi/notify/pi-notify.ts" "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	ln -sfn "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts" "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"
	ln -sfn "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	ln -sfn "$(CURDIR)/pi/quota/codex-quota.ts" "$(BIN_DIR)/codex-quota"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover newly linked extensions; ensure $(BIN_DIR) is on Pi's PATH for codex-quota."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-statusline")" = "$(CURDIR)/pi/statusline"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts")" = "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts")" = "$(CURDIR)/pi/notify/pi-notify.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts")" = "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"
	test "$$(readlink "$(PI_THEMES_DIR)/flurdy-dark.json")" = "$(CURDIR)/pi/theme/flurdy-dark.json"
	test "$$(readlink "$(BIN_DIR)/codex-quota")" = "$(CURDIR)/pi/quota/codex-quota.ts"
	test -x "$(BIN_DIR)/codex-quota"
