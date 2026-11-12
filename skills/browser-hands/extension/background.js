// Claude Browser Hands: command bridge to chrome.management / chrome.tabs.
// Callers: pages on https://example.com (externally_connectable) and this extension's own contexts (cdp.mjs `hands`).
// Message: { cmd, args } -> reply { ok: true, result } | { ok: false, error }.

const CLAUDE_IN_CHROME = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

const pick = (e) => ({
  id: e.id, name: e.name, version: e.version, enabled: e.enabled, type: e.type,
  installType: e.installType, mayDisable: e.mayDisable, disabledReason: e.disabledReason,
});
const pickTab = ({ id, windowId, groupId, url, title, active }) => ({ id, windowId, groupId, url, title, active });

// Accepts an extension id or a unique case-insensitive name substring.
async function resolve(q) {
  if (!q) throw new Error('missing args.id (extension id or name)');
  const all = await chrome.management.getAll();
  const byId = all.find((e) => e.id === q);
  if (byId) return byId;
  const hits = all.filter((e) => e.name.toLowerCase().includes(String(q).toLowerCase()));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `ambiguous "${q}": ${hits.map((e) => `${e.name} (${e.id})`).join(', ')}` : `no extension matches "${q}"`);
}

// Turning off Claude in Chrome or this bridge cuts the agent's own hands; require explicit force.
function guard(ext, force) {
  if (ext.id === chrome.runtime.id) throw new Error('refusing to toggle the bridge itself');
  if (ext.id === CLAUDE_IN_CHROME && !force) throw new Error('refusing to toggle Claude in Chrome without args.force=true (it would drop the MCP connection)');
}

async function setEnabled(ext, on) {
  await chrome.management.setEnabled(ext.id, on);
  return pick(await chrome.management.get(ext.id));
}

const needTab = (tabId) => { if (!tabId) throw new Error('missing args.tabId (see `tabs`)'); return tabId; };

const commands = {
  ping: async () => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }),
  list: async () => (await chrome.management.getAll()).map(pick),
  get: async ({ id }) => pick(await resolve(id)),
  enable: async ({ id, force }) => { const e = await resolve(id); guard(e, force); return setEnabled(e, true); },
  disable: async ({ id, force }) => { const e = await resolve(id); guard(e, force); return setEnabled(e, false); },
  // Disable + enable restarts the extension (fresh service worker, JS re-read from disk); manifest edits still need chrome://extensions reload.
  reload: async ({ id, force }) => {
    const e = await resolve(id);
    // Self: full reload from disk (manifest + worker), so an updated bridge needs no click on chrome://extensions. Reply first, then reload.
    if (e.id === chrome.runtime.id) { setTimeout(() => chrome.runtime.reload(), 200); return { ...pick(e), reloading: true }; }
    guard(e, force); await setEnabled(e, false); return setEnabled(e, true);
  },
  tabs: async ({ url }) => (await chrome.tabs.query(url ? { url } : {})).map(pickTab),
  // Reloads tabs by id or match pattern (e.g. "*://localhost/*") so content scripts of a reloaded extension get re-injected.
  refresh: async ({ tabId, url, bypassCache = false }) => {
    if (!tabId && !url) throw new Error('give args.tabId or args.url (match pattern, e.g. "*://localhost/*")');
    const tabs = tabId ? [await chrome.tabs.get(tabId)] : await chrome.tabs.query({ url });
    await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id, { bypassCache })));
    return tabs.map((t) => ({ id: t.id, url: t.url }));
  },
  // Frozen renderer: reopen the same URL at the same spot (and tab group), then kill the stuck tab. Browser-side, so it works while the page hangs.
  recover: async ({ tabId }) => {
    const old = await chrome.tabs.get(needTab(tabId));
    const fresh = await chrome.tabs.create({ url: old.pendingUrl || old.url, windowId: old.windowId, index: old.index, active: old.active });
    if (old.groupId !== -1) await chrome.tabs.group({ groupId: old.groupId, tabIds: fresh.id }); // before remove: the group dies with its last tab
    await chrome.tabs.remove(old.id);
    return pickTab(await chrome.tabs.get(fresh.id));
  },
  // Move any tab into a tab group (default: the caller's group = Claude in Chrome's MCP group) so Claude can drive it.
  adopt: async ({ tabId, groupId }, sender) => {
    const gid = groupId ?? sender?.tab?.groupId;
    if (gid == null || gid === -1) throw new Error('caller tab is not in a tab group; pass args.groupId (tabGroupId from tabs_context_mcp)');
    const { windowId } = await chrome.tabGroups.get(gid);
    await chrome.tabs.move(needTab(tabId), { windowId, index: -1 });
    await chrome.tabs.group({ groupId: gid, tabIds: tabId });
    return pickTab(await chrome.tabs.get(tabId));
  },
};

function handle(msg, sender, reply) {
  const fn = commands[msg && msg.cmd];
  if (!fn) { reply({ ok: false, error: `unknown cmd "${msg && msg.cmd}", known: ${Object.keys(commands).join(', ')}` }); return; }
  fn(msg.args || {}, sender).then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, error: String((e && e.message) || e) }),
  );
  return true; // async reply
}
chrome.runtime.onMessageExternal.addListener(handle);
chrome.runtime.onMessage.addListener(handle); // own pages only (no content scripts): lets cdp.mjs wake the worker
