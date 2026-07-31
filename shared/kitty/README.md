# Shared Kitty Helpers

Small Kitty helpers that are not agent-specific.

## Files

- `update_kitty_tab_title.fish`: Fish prompt hook that clears the Kitty tab title when returning to a normal shell prompt.
- `session-name-cases.json`: shared normalization contract fixtures for the Pi and Claude title integrations.
- `Makefile`: cross-client regression target.

## Install

```bash
mkdir -p ~/.config/fish/functions
cp update_kitty_tab_title.fish ~/.config/fish/functions/update_kitty_tab_title.fish
```

Then source it from Fish, or let your Fish config load it as appropriate.

Requires Kitty with remote control available to the shell.

## Verify agent titles

```bash
npm install --prefix pi/statusline --no-package-lock
make -C shared/kitty test
```

The target verifies identical session-name normalization plus named and unnamed title precedence,
lifecycle states, repository aliases, Beads/watcher fallbacks, SSH behavior, Claude transcript
scoping, and Pi's Orca-writer conflict handling.

