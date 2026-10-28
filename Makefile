PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions
PI_THEMES_DIR ?= $(PI_AGENT_DIR)/themes
BIN_DIR ?= $(HOME)/bin

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply check check-prompt-shortcuts check-notify check-task-session-name check-goal-baseline check-skill-spotlight check-quota check-gondolin-pilot apply-gondolin-pilot verify-gondolin-pilot

help:
	@echo "make check         Test artifact-hygiene gates, resource ownership, Pi UI extensions and goal fixture"
	@echo "make check-skill-spotlight  Test the opt-in startup skill tip (Node >=22.19)"
	@echo "make check-notify  Test Pi notifications and managed installation (Node >=22.19)"
	@echo "make check-task-session-name  Test Orca task session naming (Node >=22.19)"
	@echo "make check-prompt-shortcuts  Test manual Pi quick prompts (Node >=22.19)"
	@echo "make check-goal-baseline  Check the goal fixture without launching models (Node >=22.19)"
	@echo "make check-quota   Test all three quota helpers without provider calls (Node >=22.19)"
	@echo "make check-gondolin-pilot  Syntax and pure confinement policy tests; no VM or download"
	@echo "make apply-gondolin-pilot PILOT_AGENT_DIR=/absolute/path  Isolated .artifacts agent only"
	@echo "make apply         Link reviewed Pi resources into $(PI_AGENT_DIR) and the quota helpers into $(BIN_DIR)"
	@echo "make verify-apply  Verify the managed resource and helper links"
	@echo "BIN_DIR=$(BIN_DIR) (override with an absolute directory on your PATH)"

check:
	node --test tests/response-guidance.test.mjs
	$(MAKE) -C claude/artifact-hygiene-gate test
	$(MAKE) -C codex/artifact-hygiene-gate test
	@tests/test-watch-loop-extraction.sh
	@bash tests/test-session-mode-extraction.sh
	$(MAKE) check-notify
	$(MAKE) check-task-session-name
	$(MAKE) check-prompt-shortcuts
	$(MAKE) check-skill-spotlight
	$(MAKE) check-goal-baseline
	$(MAKE) check-quota
	$(MAKE) check-gondolin-pilot

check-gondolin-pilot:
	node --check pi/experiments/gondolin/index.ts
	node --check pi/experiments/gondolin/runtime.ts
	node --check pi/experiments/gondolin/install.mjs
	node --test pi/experiments/gondolin/policy.test.ts pi/experiments/gondolin/install.test.mjs

apply-gondolin-pilot:
	node pi/experiments/gondolin/install.mjs "$(PILOT_AGENT_DIR)"

verify-gondolin-pilot:
	node pi/experiments/gondolin/install.mjs "$(PILOT_AGENT_DIR)" --check

check-quota:
	node --test pi/quota/codex-quota-report.test.ts pi/quota/claude-quota-report.test.ts pi/quota/openrouter-quota-report.test.ts pi/statusline/openrouter-credits.test.ts

check-task-session-name:
	node --test pi/task-session-name/pi-task-session-name.test.ts

check-prompt-shortcuts:
	node --test pi/prompt-shortcuts/pi-prompt-shortcuts.test.ts

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
	check_link "$(CURDIR)/pi/task-session-name/pi-task-session-name.ts" "$(PI_EXTENSIONS_DIR)/flurdy-task-session-name.ts"; \
	check_link "$(CURDIR)/pi/prompt-shortcuts/pi-prompt-shortcuts.ts" "$(PI_EXTENSIONS_DIR)/flurdy-prompt-shortcuts.ts"; \
	check_link "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts" "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"; \
	check_link "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"; \
	test -x "$(CURDIR)/pi/quota/codex-quota.ts"; \
	check_link "$(CURDIR)/pi/quota/codex-quota.ts" "$(BIN_DIR)/codex-quota"; \
	test -x "$(CURDIR)/pi/quota/claude-quota.ts"; \
	check_link "$(CURDIR)/pi/quota/claude-quota.ts" "$(BIN_DIR)/claude-quota"; \
	test -x "$(CURDIR)/pi/quota/openrouter-quota.ts"; \
	check_link "$(CURDIR)/pi/quota/openrouter-quota.ts" "$(BIN_DIR)/openrouter-quota"
	mkdir -p "$(PI_EXTENSIONS_DIR)" "$(PI_THEMES_DIR)" "$(BIN_DIR)"
	ln -sfn "$(CURDIR)/pi/statusline" "$(PI_EXTENSIONS_DIR)/flurdy-statusline"
	ln -sfn "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts" "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts"
	ln -sfn "$(CURDIR)/pi/notify/pi-notify.ts" "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	ln -sfn "$(CURDIR)/pi/task-session-name/pi-task-session-name.ts" "$(PI_EXTENSIONS_DIR)/flurdy-task-session-name.ts"
	ln -sfn "$(CURDIR)/pi/prompt-shortcuts/pi-prompt-shortcuts.ts" "$(PI_EXTENSIONS_DIR)/flurdy-prompt-shortcuts.ts"
	ln -sfn "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts" "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"
	ln -sfn "$(CURDIR)/pi/theme/flurdy-dark.json" "$(PI_THEMES_DIR)/flurdy-dark.json"
	ln -sfn "$(CURDIR)/pi/quota/codex-quota.ts" "$(BIN_DIR)/codex-quota"
	ln -sfn "$(CURDIR)/pi/quota/claude-quota.ts" "$(BIN_DIR)/claude-quota"
	ln -sfn "$(CURDIR)/pi/quota/openrouter-quota.ts" "$(BIN_DIR)/openrouter-quota"
	$(MAKE) verify-apply
	@echo "Restart Pi to discover newly linked extensions; ensure $(BIN_DIR) is on Pi's PATH for the quota helpers."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-statusline")" = "$(CURDIR)/pi/statusline"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-kitty-tab-title.ts")" = "$(CURDIR)/pi/kitty-tab-title/pi-kitty-tab-title.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts")" = "$(CURDIR)/pi/notify/pi-notify.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-notify.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-task-session-name.ts")" = "$(CURDIR)/pi/task-session-name/pi-task-session-name.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-task-session-name.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-prompt-shortcuts.ts")" = "$(CURDIR)/pi/prompt-shortcuts/pi-prompt-shortcuts.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-prompt-shortcuts.ts"
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts")" = "$(CURDIR)/pi/skill-spotlight/pi-skill-spotlight.ts"
	test -f "$(PI_EXTENSIONS_DIR)/flurdy-skill-spotlight.ts"
	test "$$(readlink "$(PI_THEMES_DIR)/flurdy-dark.json")" = "$(CURDIR)/pi/theme/flurdy-dark.json"
	test "$$(readlink "$(BIN_DIR)/codex-quota")" = "$(CURDIR)/pi/quota/codex-quota.ts"
	test -x "$(BIN_DIR)/codex-quota"
	test "$$(readlink "$(BIN_DIR)/claude-quota")" = "$(CURDIR)/pi/quota/claude-quota.ts"
	test -x "$(BIN_DIR)/claude-quota"
	test "$$(readlink "$(BIN_DIR)/openrouter-quota")" = "$(CURDIR)/pi/quota/openrouter-quota.ts"
	test -x "$(BIN_DIR)/openrouter-quota"
