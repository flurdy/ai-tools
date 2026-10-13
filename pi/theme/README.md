# Pi Flurdy Dark Theme

High-contrast variant of Pi's built-in `dark` theme. It keeps the standard dark palette and semantic token assignments, but separates success and warning states more clearly:

| State | Colour |
| --- | --- |
| Success / healthy | `#5fd75f` (green) |
| Warning | `#ffd75f` (amber) |
| Error | `#cc6666` (red, unchanged) |

The change applies throughout Pi, including the custom statusline, diffs, Markdown code blocks, and bash-mode indicators.

## Install globally

From the `ai-tools` repository root, use the conflict-checked installer:

```bash
make apply
make verify-apply
```

This links the theme into `~/.pi/agent/themes/` along with the other managed Pi resources. Select `flurdy-dark` from `/settings`, or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "flurdy-dark"
}
```

Pi hot-reloads an active custom theme when the JSON file changes.
