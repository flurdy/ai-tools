.PHONY: test

test:
	@test -x ../../pi/statusline/node_modules/.bin/tsc || { echo "ERROR: run npm install --prefix pi/statusline --no-package-lock" >&2; exit 1; }
	@node --test ../../pi/kitty-tab-title/pi-kitty-tab-title.test.ts
	@cd ../../pi/kitty-tab-title && ../statusline/node_modules/.bin/tsc --noEmit
	@python3 -m unittest discover -s ../../claude/kitty-tab-title -p '*_test.py'
	@bash -n ../../claude/kitty-tab-title/kitty-title.sh
