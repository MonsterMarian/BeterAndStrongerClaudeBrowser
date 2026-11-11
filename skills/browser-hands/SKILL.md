---
name: browser-hands
description: Extra hands for Claude in Chrome - list, enable, disable and reload (restart/reset) the user's Chrome extensions, refresh tabs, and look inside an extension (read/write its chrome.storage settings, read its console errors/logs, eval in its service worker). Use when a task needs an extension turned on/off, restarted after code changes, its saved values or errors checked or changed, or when chrome://extensions would be needed (Claude in Chrome cannot open chrome:// or chrome-extension:// pages).
---

# Browser Hands

Claude in Chrome blocks `chrome://` and `chrome-extension://` URLs, so it cannot touch `chrome://extensions`.
This skill ships a tiny companion extension (**Claude Browser Hands**, id `ahpnamikcofnoeieghfbngknbcojihol`)
with the `management` permission. It accepts commands only from pages on `https://example.com/*`
(`externally_connectable`), where `javascript_tool` can call it via `chrome.runtime.sendMessage`.

## Call it

1. `tabs_context_mcp`, then open a tab (or reuse your own) on `https://example.com`.
2. Run with `javascript_tool` (if the first call right after navigate errors with "browser-internal", just retry):

```js
const H = (cmd, args = {}) => new Promise((ok, fail) => {
  if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) return fail('Claude Browser Hands not installed/enabled - see Setup');
  chrome.runtime.sendMessage('ahpnamikcofnoeieghfbngknbcojihol', { cmd, args }, (r) =>
    chrome.runtime.lastError ? fail(chrome.runtime.lastError.message) : r.ok ? ok(r.result) : fail(r.error));
});
await H('list')
```

| cmd | args | does |
|---|---|---|
| `ping` | - | bridge id + version |
| `list` | - | all extensions/apps: `id, name, version, enabled, type, installType, mayDisable, disabledReason` |
| `get` | `{id}` | one extension |
| `enable` / `disable` | `{id, force?}` | toggle; returns new state |
| `reload` | `{id, force?}` | disable + enable = restart (new service worker, JS re-read from disk, extension pages close) |
| `tabs` | `{url?}` | all tabs (any window, not only your group): `id, windowId, url, title, active`; `url` = match pattern |
| `refresh` | `{tabId}` or `{url, bypassCache?}` | reload tab(s), e.g. `{url: '*://localhost/*'}` after `reload` so content scripts re-inject |

`id` is the extension id **or** a unique case-insensitive name substring (`{id: 'ublock'}`). Ambiguous names return an error listing the matches - pick by id.
Claude in Chrome's output filter may redact bare id-like strings (`[BLOCKED: ...]`); format results into text lines, as in the snippet above.

## Look inside an extension (storage, errors, eval) - `cdp.mjs`

The bridge cannot see into other extensions. For that, run the CLI next to this file from the shell
(Node 22+, no deps). It talks CDP to the user's real Chrome:

```
node <skill-dir>/cdp.mjs targets [extId]                 # running service workers / pages of extensions
node <skill-dir>/cdp.mjs storage <extId> [area] [key..]  # read chrome.storage (local|sync|session|managed), = saved settings/values
node <skill-dir>/cdp.mjs set <extId> <area> '<json>'     # merge values into storage, prints the new state
node <skill-dir>/cdp.mjs logs <extId> [seconds]          # console messages + uncaught errors, incl. ones logged since the worker started
node <skill-dir>/cdp.mjs eval <extId> '<js>'             # run JS inside the extension (top-level await ok), prints JSON
```

- Get `extId` from bridge `list`. `storage`/`set`/`eval` work even if the extension's worker is asleep (a background tab on its `manifest.json` is opened and closed).
- `logs` needs it running: to catch startup errors, `reload` it with the bridge, then `logs` right after.
- `localStorage`/IndexedDB of extension pages: `eval` with `JSON.stringify(localStorage)` only when no service worker runs (otherwise eval lands in the worker).
- After `set`, the extension sees `chrome.storage.onChanged`; if it only reads settings at startup, `reload` it.
- Show the user what you are about to write before `set`/`eval` that changes data; never print secrets (API keys, tokens) from storage back in full.
- Content-script errors live in the web page's console, not here - use Claude in Chrome's `read_console_messages` on that tab.

**One-time setup for cdp.mjs:** if it says "No DevToolsActivePort" or cannot connect, ask the user to open
`chrome://inspect/#remote-debugging` and allow remote debugging (Chrome 144+). Chrome shows an **Allow** dialog
when the CLI connects - the user must click it. `CHROME_USER_DATA` overrides the profile dir (default: Chrome Stable).

## Rules

- Toggling **Claude in Chrome** itself (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) is refused unless `force: true` - it drops your own MCP connection, and you cannot turn it back on. Only do it when the user asks.
- The bridge never toggles itself.
- `mayDisable: false` (policy-installed) extensions cannot be changed - tell the user.
- Tell the user which extensions you disabled, and re-enable them when the task is done unless they want them off.
- After `reload`, pages that depend on the extension's content scripts need a page reload to pick it up.

## Not possible (Chrome limits)

- Installing/loading new extensions: Chrome 137+ ignores `--load-extension`; the user must use *Load unpacked* or the Web Store.
- Reloading a changed `manifest.json`: needs the reload button on `chrome://extensions` (user).
- Uninstalling another extension always shows Chrome's confirm dialog - not exposed.

## Setup (once, by the user)

If `H('ping')` fails with "not installed", or `H('tabs')` says unknown cmd (old version - ask the user to click reload on the bridge in `chrome://extensions`): ask the user to open `chrome://extensions`, turn on **Developer mode**,
click **Load unpacked** and pick the `extension` folder next to this SKILL.md. The id must be `ahpnamikcofnoeieghfbngknbcojihol`.
