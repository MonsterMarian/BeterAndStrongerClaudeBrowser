# Better and Stronger Claude Browser

Skills that give **Claude in Chrome** abilities it does not have out of the box.

## `browser-hands`

Built from the places where Claude in Chrome actually got stuck in real sessions:

| Stuck on | Hand |
|---|---|
| "click ↻ on chrome://extensions" after every content-script edit | bridge `reload` + `refresh` |
| "Browser extension is not connected" | `cdp.mjs hands reload` restarts Claude in Chrome from outside |
| "renderer may be frozen" timeouts | bridge `recover` / `cdp.mjs recover` |
| tabs outside Claude's tab group | bridge `tabs` + `adopt` |
| upload buttons that open the OS file dialog | `cdp.mjs upload` (intercepted file chooser) |
| `[BLOCKED: ...]` redacted output | `cdp.mjs page` |
| network of a logged-in page when the extension is down | `cdp.mjs net` |
| what an extension saved / threw | `cdp.mjs storage`, `set`, `logs`, `eval` |

Claude in Chrome cannot open `chrome://extensions` (or any `chrome://` / `chrome-extension://` page).
`browser-hands` adds a tiny companion extension with the `management`, `tabs` and `tabGroups` permissions; Claude talks to it from
`https://example.com` through `javascript_tool`.

```
Claude Code -> Claude in Chrome -> javascript_tool on https://example.com
            -> chrome.runtime.sendMessage(ahpnamikcofnoeieghfbngknbcojihol)  [externally_connectable]
            -> Claude Browser Hands (service worker) -> chrome.management.*
```

Bridge commands: `ping`, `list`, `get`, `enable`, `disable`, `reload`, `tabs`, `refresh`, `recover`, `adopt`.

### `cdp.mjs` - hands that work without Claude in Chrome

`skills/browser-hands/cdp.mjs` (Node 22+, zero deps) connects to your real Chrome over CDP - enabled at
`chrome://inspect/#remote-debugging` (Chrome 144+, the same switch Chrome DevTools MCP `--autoConnect` uses):

```
node skills/browser-hands/cdp.mjs hands reload '{"id":"fcoeoabgfenejglbffodgkkbkcdhcgfn","force":true}'   # any bridge command over CDP (here: restart Claude in Chrome)
node skills/browser-hands/cdp.mjs storage <extId> [local|sync|session|managed]      # an extension's saved settings/values
node skills/browser-hands/cdp.mjs set <extId> local '{"debug":true}'                # write them
node skills/browser-hands/cdp.mjs logs <extId> 3                                    # console + uncaught errors (incl. startup)
node skills/browser-hands/cdp.mjs eval <extId> 'await chrome.alarms.getAll()'       # anything inside the extension
node skills/browser-hands/cdp.mjs tabs | page <tab> '<js>' | recover <tab>
node skills/browser-hands/cdp.mjs net <tab> 5 --reload --bodies='/api/'
node skills/browser-hands/cdp.mjs upload <tab> photo.jpg --click='button.upload'
```

If an extension's worker is asleep, storage/eval/hands go through a temporary background tab on its `manifest.json`.
Every call times out after 30 s (`HANDS_TIMEOUT`) instead of hanging on a frozen renderer.

### Install

1. Copy or link the skill into Claude Code:
   ```powershell
   New-Item -ItemType Junction -Path "$HOME\.claude\skills\browser-hands" -Target "$PWD\skills\browser-hands"
   ```
2. Chrome -> `chrome://extensions` -> **Developer mode** -> **Load unpacked** -> `skills/browser-hands/extension`.
   The id is pinned by the manifest `key`: `ahpnamikcofnoeieghfbngknbcojihol`.
3. For `cdp.mjs`: open `chrome://inspect/#remote-debugging` and allow remote debugging; click **Allow** when Chrome asks.
4. Ask Claude e.g. *"turn off uBlock and reload the page"* or *"what settings has FlowBridge saved, and did it throw any errors?"*.

The bridge icon was generated with Google Flow through [FlowBridge](../Google-flow-for-AI) - queued, generated and downloaded by Claude itself.

### Security

- Only pages on `https://example.com/*` can send commands (a static IANA page with no scripts). No other site can reach the bridge.
- The bridge refuses to toggle itself and refuses to toggle Claude in Chrome without `force: true`.
- The manifest `key` is a public key only; no private key is stored anywhere.
- `cdp.mjs` is full DevTools access to the browser while remote debugging is on - turn it off in `chrome://inspect` when not needed.
- `cdp.mjs page`/`net` output is **not** run through Claude in Chrome's redaction filter (tokens, cookies, query strings).

### Tests

```powershell
node --test tests/unit.test.mjs   # background.js against a mocked chrome.* API
node tests/e2e.mjs                # real headless Chrome (temp profile): every bridge command from example.com and every cdp.mjs command
                                  # (fixture extensions, frozen tabs, tab groups, a click-created file input)
```

### Prior art (what this borrows from)

- [ChromeDevTools/chrome-devtools-mcp](https://developer.chrome.com/docs/devtools/agents/extensions) `--categoryExtensions`: list/install/reload/uninstall extensions via CDP. Needs its own debuggable Chrome, not your everyday profile. The e2e test uses the same CDP `Extensions.loadUnpacked` trick.
- [paulirish hot-reload-chrome-ext skill](https://github.com/paulirish/dotfiles/blob/d27a39a78a36bc5548e320f9bcc064f13b3c0323/agents/skills/hot-reload-chrome-ext/SKILL.md): restarting extensions via `management` / `runtime.reload`.
- [noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome): open, unrestricted reimplementation of Claude in Chrome (no domain blocklist). No extension management.

None of them let Claude in Chrome itself manage extensions in the user's real profile - that is the gap this fills.
