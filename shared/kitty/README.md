# Shared Kitty Helpers

Small Kitty helpers that are not agent-specific.

## Files

- `update_kitty_tab_title.fish`: Fish prompt hook that clears the Kitty tab title when returning to a normal shell prompt.

## Install

```bash
mkdir -p ~/.config/fish/functions
cp update_kitty_tab_title.fish ~/.config/fish/functions/update_kitty_tab_title.fish
```

Then source it from Fish, or let your Fish config load it as appropriate.

Requires Kitty with remote control available to the shell.

