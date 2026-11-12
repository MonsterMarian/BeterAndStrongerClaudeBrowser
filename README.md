<p align="center"><img src="skills/browser-hands/extension/icons/icon128.png" width="96" height="96" alt="Claude Browser Hands"></p>

# Claude Browser Hands

A Claude Code skill that gives Claude in Chrome the abilities it lacks: managing extensions, recovering stuck tabs, and reaching into extensions, pages and network traffic.

Two parts:

- **Bridge** - a small Chrome extension (`skills/browser-hands/extension`). Claude calls it from Claude in Chrome's `javascript_tool`.
- **`cdp.mjs`** - a Node CLI that talks to your Chrome over the DevTools protocol. Works even when Claude in Chrome is stuck or disconnected.

## What it fixes

| Problem | Command |
|---|---|
| Extension code changed, needs a reload in chrome://extensions | bridge `reload` + `refresh` |
| "Browser extension is not connected" | `cdp.mjs hands reload` (restarts Claude in Chrome) |
| "Renderer may be frozen" timeouts | bridge `recover`, `cdp.mjs recover` |
| Tab outside Claude's tab group | bridge `tabs` + `adopt` |
| Upload button opens the OS file dialog | `cdp.mjs upload` |
| Output redacted as `[BLOCKED: ...]` | `cdp.mjs page` |
| Network of a logged-in page | `cdp.mjs net` |
| What an extension saved or threw | `cdp.mjs storage`, `set`, `logs`, `eval` |
| Remove an extension | `cdp.mjs uninstall` (silent, no dialog) |

Bridge commands: `ping`, `list`, `get`, `enable`, `disable`, `reload`, `open`, `focus`, `tabs`, `refresh`, `recover`, `adopt`.

## How the bridge is called

Claude in Chrome cannot open `chrome://` or `chrome-extension://` pages, so Claude talks to the bridge from an ordinary page via `externally_connectable`:

```
Claude in Chrome -> javascript_tool on an allowed page
                 -> chrome.runtime.sendMessage("ahpnamikcofnoeieghfbngknbcojihol", { cmd, args })
                 -> bridge service worker -> chrome.management / chrome.tabs
```

Allowed pages:

- `http://localhost`, `http://127.0.0.1` - the dev app Claude already works on, no extra tab.
- `https://slashunderscore.com/#claude-hands` - the control tab otherwise. The site stays visible; the bridge adds a "Claude Browser Hands" badge.
- `https://example.com` - fallback.

The bridge updates itself: `reload` on its own id re-reads it from disk, no click in chrome://extensions.

## cdp.mjs

Node 22+, no dependencies. Requires remote debugging enabled once at `chrome://inspect/#remote-debugging` (Chrome 144+).

```
node skills/browser-hands/cdp.mjs hands <cmd> ['<json args>']    # any bridge command, without Claude in Chrome
node skills/browser-hands/cdp.mjs storage <ext> [area] [key..]   # read chrome.storage of an extension
node skills/browser-hands/cdp.mjs set <ext> <area> '<json>'      # write it
node skills/browser-hands/cdp.mjs logs <ext> [seconds]           # console messages and uncaught errors
node skills/browser-hands/cdp.mjs eval <ext> '<js>'              # run JS inside an extension
node skills/browser-hands/cdp.mjs uninstall <ext>                # remove an extension silently
node skills/browser-hands/cdp.mjs tabs                           # list page tabs
node skills/browser-hands/cdp.mjs page <tab> '<js>'              # run JS in a page, unredacted output
node skills/browser-hands/cdp.mjs net <tab> [s] [--reload] [--bodies=<regex>]
node skills/browser-hands/cdp.mjs recover <tab>
node skills/browser-hands/cdp.mjs upload <tab> <file..> [--click=<css>]
```

Every call times out after 30 s (`HANDS_TIMEOUT`).

## Install

1. Link the skill into Claude Code:
   ```powershell
   New-Item -ItemType Junction -Path "$HOME\.claude\skills\browser-hands" -Target "$PWD\skills\browser-hands"
   ```
2. In `chrome://extensions`: Developer mode, Load unpacked, select `skills/browser-hands/extension`. The id is fixed: `ahpnamikcofnoeieghfbngknbcojihol`.
3. For `cdp.mjs`: enable remote debugging at `chrome://inspect/#remote-debugging` and click Allow when Chrome asks.

## Security

- Only the allowed pages above can send commands. Whoever controls the scripts on slashunderscore.com can drive the bridge; to avoid that, fork and put your own domain into `manifest.json` (`externally_connectable`, `content_scripts`, `web_accessible_resources`).
- The bridge refuses to toggle itself, and toggles Claude in Chrome only with `force: true`.
- While remote debugging is on, any local program has full access to the browser. Turn it off when not needed.
- `cdp.mjs page` and `net` bypass Claude in Chrome's redaction of tokens and cookies.

## Tests

```
node --test tests/unit.test.mjs   # bridge logic against a mocked chrome API
node tests/e2e.mjs                # real headless Chrome: every bridge and cdp.mjs command
```

## Icon

Generated with Google Flow. `skills/browser-hands/extension/icons/make-icons.ps1 <source>` rebuilds the 16-128 px PNGs.

## Prior art

- [chrome-devtools-mcp](https://developer.chrome.com/docs/devtools/agents/extensions) `--categoryExtensions` - extension tools over CDP, needs its own Chrome instance.
- [paulirish hot-reload-chrome-ext](https://github.com/paulirish/dotfiles/blob/d27a39a78a36bc5548e320f9bcc064f13b3c0323/agents/skills/hot-reload-chrome-ext/SKILL.md) - restarting extensions via `management`.
- [open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) - open reimplementation of Claude in Chrome.
