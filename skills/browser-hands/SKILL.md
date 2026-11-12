---
name: browser-hands
description: Extra hands for Claude in Chrome. Manage the user's Chrome extensions (list, enable, disable, reload/restart - including after editing an extension's code), refresh/recover frozen tabs, adopt tabs outside Claude's tab group, look inside an extension (chrome.storage settings, console errors, eval), capture network traffic, answer file-upload dialogs, read page data unredacted, and restart Claude in Chrome itself when it is "not connected". Use whenever Claude in Chrome is stuck, times out, hits chrome:// pages, needs chrome://extensions, or a task depends on an extension's state.
---

# Browser Hands

Two tools, same skill dir (`<skill-dir>` = folder of this file):

- **Bridge** - companion extension *Claude Browser Hands* (`ahpnamikcofnoeieghfbngknbcojihol`), called from Claude in Chrome's `javascript_tool` on `https://example.com`.
- **`cdp.mjs`** - Node 22+ CLI (no deps) run from the shell. Talks CDP to the user's real Chrome, so it works **even when Claude in Chrome is stuck or disconnected**.

## When stuck - playbook

| Symptom | Do |
|---|---|
| Bridge says `unknown cmd`, or its files changed (repo update) | self-reload it yourself: `H('reload', {id: 'ahpnamikcofnoeieghfbngknbcojihol'})`, wait ~2.5 s, poll `ping` until it answers with the new version. **Never ask the user to reload the bridge** |
| You edited an extension's code (content script, worker) | bridge `reload` it, then `refresh` the affected tabs - never ask the user to click ↻ in chrome://extensions (except for `manifest.json` changes) |
| "Browser extension is not connected" / tabs_context hangs | `node <skill-dir>/cdp.mjs hands reload '{"id":"fcoeoabgfenejglbffodgkkbkcdhcgfn","force":true}'`, wait ~3 s, retry `tabs_context_mcp`. Still down (wrong account, multiple browsers) -> tell the user. Meanwhile `cdp.mjs` still works for reading pages/network |
| "renderer may be frozen" / JS or screenshot timeouts | bridge `recover {tabId}` (keeps position + tab group). If the bridge is unreachable: `cdp.mjs recover <tab>`. If afterwards `tabs_context_mcp` says the group no longer exists: `tabs_context_mcp {createIfEmpty: true}`, open example.com there, `adopt` the recovered tab (seen live when the recovered tab was mid-screenshot) |
| "no tab group of its own" / "not in the same group" / need a user's existing tab | bridge `tabs` to find it, then `adopt {tabId}` pulls it into your group |
| Upload button opens the OS file dialog | `cdp.mjs upload <tab> <file..> --click=<css>`; or run it in background without `--click` and click the button with `computer` |
| Output shows `[BLOCKED: ...]` and the user needs that data | `cdp.mjs page <tab> '<js>'` (unredacted - see Rules) |
| Need requests/responses of a logged-in page | `cdp.mjs net <tab> 5 --reload --bodies='api'` (or Claude in Chrome's `read_network_requests` if it works) |
| An extension misbehaves: what did it save, what did it throw | `cdp.mjs storage <ext>` / `logs <ext>` (reload first for startup errors) / `eval <ext> '<js>'` |
| `chrome://` pages are blocked | the bridge covers chrome://extensions; for the rest say what the user must click |

## Bridge (from Claude in Chrome)

1. `tabs_context_mcp`, then a tab of your group on `https://example.com`.
2. `javascript_tool` (if the first call right after navigate errors with "browser-internal", retry):

```js
const H = (cmd, args = {}) => new Promise((ok, fail) => {
  if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) return fail('Claude Browser Hands not installed/enabled - see Setup');
  chrome.runtime.sendMessage('ahpnamikcofnoeieghfbngknbcojihol', { cmd, args }, (r) =>
    chrome.runtime.lastError ? fail(chrome.runtime.lastError.message) : r.ok ? ok(r.result) : fail(r.error));
});
(await H('list')).map(e => `${e.enabled ? 'ON ' : 'off'} ${e.id} ${e.name}`)
```

| cmd | args | does |
|---|---|---|
| `ping` | - | bridge id + version |
| `list` / `get` | - / `{id}` | extensions: `id, name, version, enabled, type, installType, mayDisable, disabledReason` |
| `enable` / `disable` | `{id, force?}` | toggle; returns new state |
| `reload` | `{id, force?}` | disable + enable = restart (new worker, JS re-read from disk). On the bridge's own id: full self-reload from disk incl. manifest |
| `tabs` | `{url?}` | all tabs in all windows: `id, windowId, groupId, url, title, active`; `url` = match pattern |
| `refresh` | `{tabId}` or `{url, bypassCache?}` | reload tab(s), e.g. `{url: '*://localhost/*'}` |
| `recover` | `{tabId}` | reopen the URL at the same index/group, close the frozen tab; returns the new tab |
| `adopt` | `{tabId, groupId?}` | move a tab into your group (default: the group of the calling example.com tab) |

`id` = extension id **or** unique case-insensitive name substring (`'ublock'`). Tab ids are the same ids Claude in Chrome uses.
Claude in Chrome's output filter may redact bare id-like strings (`[BLOCKED: ...]`) - format results into text lines as above.

## cdp.mjs (from the shell)

```
node <skill-dir>/cdp.mjs hands <cmd> ['<json args>']   # any bridge command above, without Claude in Chrome
node <skill-dir>/cdp.mjs targets [ext]                  # running workers/pages of extensions
node <skill-dir>/cdp.mjs storage <ext> [area] [key..]   # chrome.storage local|sync|session|managed = saved settings/values
node <skill-dir>/cdp.mjs set <ext> <area> '<json>'      # merge values into storage, prints the new state
node <skill-dir>/cdp.mjs logs <ext> [seconds]           # console + uncaught errors, incl. buffered since worker start
node <skill-dir>/cdp.mjs eval <ext> '<js>'              # JS inside the extension (top-level await ok)
node <skill-dir>/cdp.mjs tabs                           # page targets: targetId, url, title
node <skill-dir>/cdp.mjs page <tab> '<js>'              # JS in a web page, output not redacted
node <skill-dir>/cdp.mjs net <tab> [s] [--reload] [--bodies=<url regex>]
node <skill-dir>/cdp.mjs recover <tab>
node <skill-dir>/cdp.mjs upload <tab> <file..> [--click=<css>] [--timeout=30]
```

- `<ext>` = extension id (from bridge `list`/`hands list`); `<tab>` = targetId or unique URL/title substring (CDP targetIds are not Claude in Chrome tab ids).
- Every CDP call times out after 30 s (`HANDS_TIMEOUT`) with a hint to `recover` - a timeout on `page` means the tab is frozen.
- `storage`/`set`/`eval`/`hands` work while the extension's worker sleeps (a temporary background tab on its `manifest.json` is used, then closed). `logs` needs it running.
- After `set`, the extension gets `chrome.storage.onChanged`; if it reads settings only at startup, `reload` it.
- Content-script errors are in the web page's console: `read_console_messages` on that tab.

## Rules

- Toggling **Claude in Chrome** (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) needs `force: true`. From the bridge it drops your own connection (you cannot re-enable it from there) - prefer `cdp.mjs hands reload` which survives it.
- Tell the user which extensions you disabled; re-enable them when done unless they want them off. `mayDisable: false` = policy-locked.
- `set`, `eval` and `page` act with the user's full session. Say what you will write before writing. Never print secrets (API keys, tokens, cookies) from storage, pages or network bodies back in full - `page` bypasses Claude in Chrome's redaction filter, so use it only for data the task needs.
- Don't `adopt` or `recover` tabs the user is actively working in without saying so.

## Not possible

- Installing new extensions (Chrome 137+ ignores `--load-extension`; user uses *Load unpacked*), reloading changed `manifest.json` (chrome://extensions ↻), uninstalling another extension (Chrome always asks).

## Setup (once, by the user)

- **Bridge:** `chrome://extensions` -> Developer mode -> **Load unpacked** -> `<skill-dir>/extension`. Id must be `ahpnamikcofnoeieghfbngknbcojihol`. Later updates: self-reload (see playbook) - the example.com tab keeps working, no page reload needed. Only a bridge older than 0.3.1 (self-reload refused) needs the user's ↻ once.
- **cdp.mjs:** "No DevToolsActivePort"/cannot connect -> user opens `chrome://inspect/#remote-debugging` and allows remote debugging (Chrome 144+), then clicks **Allow** when Chrome asks. `CHROME_USER_DATA` overrides the profile dir.
