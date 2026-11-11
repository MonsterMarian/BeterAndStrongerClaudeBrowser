// Claude Browser Hands: command bridge from https://example.com (externally_connectable) to chrome.management.
// Message: { cmd, args } -> reply { ok: true, result } | { ok: false, error }.

const CLAUDE_IN_CHROME = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

const pick = (e) => ({
  id: e.id, name: e.name, version: e.version, enabled: e.enabled, type: e.type,
  installType: e.installType, mayDisable: e.mayDisable, disabledReason: e.disabledReason,
});

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

const commands = {
  ping: async () => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }),
  list: async () => (await chrome.management.getAll()).map(pick),
  get: async ({ id }) => pick(await resolve(id)),
  enable: async ({ id, force }) => { const e = await resolve(id); guard(e, force); return setEnabled(e, true); },
  disable: async ({ id, force }) => { const e = await resolve(id); guard(e, force); return setEnabled(e, false); },
  // Disable + enable restarts the extension (fresh service worker, JS re-read from disk); manifest edits still need chrome://extensions reload.
  reload: async ({ id, force }) => { const e = await resolve(id); guard(e, force); await setEnabled(e, false); return setEnabled(e, true); },
};

chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
  const fn = commands[msg && msg.cmd];
  if (!fn) { reply({ ok: false, error: `unknown cmd "${msg && msg.cmd}", known: ${Object.keys(commands).join(', ')}` }); return; }
  fn(msg.args || {}).then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, error: String((e && e.message) || e) }),
  );
  return true; // async reply
});
