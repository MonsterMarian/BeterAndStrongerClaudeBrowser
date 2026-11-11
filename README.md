# Better and Stronger Claude Browser

Skills that give **Claude in Chrome** abilities it does not have out of the box.

## `browser-hands` - manage Chrome extensions

Claude in Chrome cannot open `chrome://extensions` (or any `chrome://` / `chrome-extension://` page).
`browser-hands` adds a tiny companion extension with the `management` permission; Claude talks to it from
`https://example.com` through `javascript_tool` and can **list, enable, disable and reload (restart)** your extensions.

```
Claude Code -> Claude in Chrome -> javascript_tool on https://example.com
            -> chrome.runtime.sendMessage(ahpnamikcofnoeieghfbngknbcojihol)  [externally_connectable]
            -> Claude Browser Hands (service worker) -> chrome.management.*
```

Bridge commands: `ping`, `list`, `get`, `enable`, `disable`, `reload`, `tabs`, `refresh`.

### Inside an extension: `cdp.mjs`

`management` cannot see into other extensions, so `skills/browser-hands/cdp.mjs` (Node 22+, zero deps) connects to your
real Chrome over CDP - enabled at `chrome://inspect/#remote-debugging` (Chrome 144+, the same switch Chrome DevTools MCP
`--autoConnect` uses) - and attaches to the extension's service worker:

```
node skills/browser-hands/cdp.mjs storage <extId> [local|sync|session|managed] [key..]   # saved settings/values
node skills/browser-hands/cdp.mjs set <extId> local '{"debug":true}'                     # write them
node skills/browser-hands/cdp.mjs logs <extId> 3                                         # console + uncaught errors (incl. startup)
node skills/browser-hands/cdp.mjs eval <extId> 'await chrome.alarms.getAll()'            # anything else
node skills/browser-hands/cdp.mjs targets
```

If the worker is asleep, storage/eval go through a temporary background tab on the extension's `manifest.json`.

### Install

1. Copy or link the skill into Claude Code:
   ```powershell
   New-Item -ItemType Junction -Path "$HOME\.claude\skills\browser-hands" -Target "$PWD\skills\browser-hands"
   ```
2. Chrome -> `chrome://extensions` -> **Developer mode** -> **Load unpacked** -> `skills/browser-hands/extension`.
   The id is pinned by the manifest `key`: `ahpnamikcofnoeieghfbngknbcojihol`.
3. For `cdp.mjs`: open `chrome://inspect/#remote-debugging` and allow remote debugging; click **Allow** when Chrome asks.
4. Ask Claude e.g. *"turn off uBlock and reload the page"* or *"what settings has FlowBridge saved, and did it throw any errors?"*.

### Security

- Only pages on `https://example.com/*` can send commands (a static IANA page with no scripts). No other site can reach the bridge.
- The bridge refuses to toggle itself and refuses to toggle Claude in Chrome without `force: true`.
- The manifest `key` is a public key only; no private key is stored anywhere.
- `cdp.mjs` is full DevTools access to the browser while remote debugging is on - turn it off in `chrome://inspect` when not needed.

### Tests

```powershell
node --test tests/unit.test.mjs   # background.js against a mocked chrome.* API
node tests/e2e.mjs                # real headless Chrome (temp profile): bridge from example.com + cdp.mjs storage/logs/eval on fixture extensions
```

### Prior art (what this borrows from)

- [ChromeDevTools/chrome-devtools-mcp](https://developer.chrome.com/docs/devtools/agents/extensions) `--categoryExtensions`: list/install/reload/uninstall extensions via CDP. Needs its own debuggable Chrome, not your everyday profile. The e2e test uses the same CDP `Extensions.loadUnpacked` trick.
- [paulirish hot-reload-chrome-ext skill](https://github.com/paulirish/dotfiles/blob/d27a39a78a36bc5548e320f9bcc064f13b3c0323/agents/skills/hot-reload-chrome-ext/SKILL.md): restarting extensions via `management` / `runtime.reload`.
- [noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome): open, unrestricted reimplementation of Claude in Chrome (no domain blocklist). No extension management.

None of them let Claude in Chrome itself manage extensions in the user's real profile - that is the gap this fills.
