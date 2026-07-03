# AI Tools

Personal tools and config glue for working with AI coding agents, mostly Claude Code with Codex and Pi support.

This repo is meant to be the shareable, curated version of tools that also live in my dotfiles. The live setup may still be in [flurdy/dotfiles](https://github.com/flurdy/dotfiles); this repo keeps the pieces easier to browse, copy, and discuss.

## Tools

| Tool | Agent | What it does |
| --- | --- | --- |
| [Claude statusline](claude/statusline/) | Claude Code | Responsive Bobthefish-inspired Claude Code statusline with model, cost, context, rate limit, git, and PR signals. |
| [Claude Kitty tab title](claude/kitty-tab-title/) | Claude Code | Hook script and settings fragment for showing repo/session state in Kitty tab titles. |
| [Codex Kitty tab title](codex/kitty-tab-title/) | Codex | Codex hook script and `hooks.json` for the same Kitty tab title workflow. |
| [Pi statusline](pi/statusline/) | Pi | Pi extension for a responsive Bobthefish/Claude-Code-inspired footer with model, context, git, PR, cost, token, and cache signals. |
| [Pi Kitty tab title](pi/kitty-tab-title/) | Pi | Pi extension for showing repo/session state in Kitty tab titles, matching the Claude/Codex workflow. |
| [Claude launcher](claude/launcher/) | Claude Code | Fish `cl` launcher that picks main checkout, worktree, handoff, or new worktree before starting Claude. |
| [Kitty shell reset](shared/kitty/) | Shared | Fish prompt hook that clears the agent tab title when returning to the shell. |

## Related Repos And Docs

- Skills live separately in [flurdy/agent-skills](https://github.com/flurdy/agent-skills), especially `shared/`. This repo links to skills rather than vendoring them.
- Longer-form docs are published at <https://flurdy.com/docs>.
- The Kitty tab title write-up is at <https://flurdy.com/docs/kitty-ai-tabs/>.
- Dotfiles source is [flurdy/dotfiles](https://github.com/flurdy/dotfiles).

## Layout

```text
claude/
  statusline/
  kitty-tab-title/
  launcher/
codex/
  kitty-tab-title/
pi/
  statusline/
  kitty-tab-title/
shared/
  kitty/
docs/
```

## Notes

These scripts are extracted from my own environment, so they intentionally keep some local workflow assumptions. The per-tool READMEs call those out where they matter.

## Author

Created and maintained by [Ivar Abrahamsen](https://flurdy.com) / [@flurdy](https://github.com/flurdy).

PRs, issues, forks, and adaptations are welcome. These tools are personal and opinionated, but shared in case they are useful as-is or as a starting point.
