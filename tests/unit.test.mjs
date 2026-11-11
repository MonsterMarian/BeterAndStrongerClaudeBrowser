// Runs background.js against a mocked chrome.* API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../skills/browser-hands/extension/background.js', import.meta.url), 'utf8');

function boot() {
  const exts = [
    { id: 'self'.padEnd(32, 'x'), name: 'Claude Browser Hands', enabled: true },
    { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn', name: 'Claude', enabled: true },
    { id: 'a'.repeat(32), name: 'uBlock Origin', enabled: true },
    { id: 'b'.repeat(32), name: 'React Developer Tools', enabled: false },
    { id: 'c'.repeat(32), name: 'Redux DevTools', enabled: true },
  ];
  const calls = [];
  let listener;
  const chrome = {
    runtime: {
      id: exts[0].id,
      getManifest: () => ({ version: '0.1.0' }),
      onMessageExternal: { addListener: (fn) => { listener = fn; } },
      onMessage: { addListener: (fn) => { internal = fn; } },
    },
    tabGroups: { get: async (id) => ({ id, windowId: 9 }) },
    management: {
      getAll: async () => exts.map((e) => ({ ...e })),
      get: async (id) => ({ ...exts.find((e) => e.id === id) }),
      setEnabled: async (id, on) => { calls.push([id, on]); exts.find((e) => e.id === id).enabled = on; },
    },
    tabs: {
      query: async ({ url }) => [{ id: 1, url: 'http://localhost:3000/' }, { id: 2, url: 'https://example.com/' }]
        .filter((t) => !url || t.url.startsWith(url.replace('*', '').replace('/*', ''))),
      get: async (id) => ({ id, url: 'http://localhost:3000/', windowId: 1, index: 3, active: true, groupId: id === 1 ? 5 : -1 }),
      reload: async (id, opts) => { calls.push(['reload', id, opts.bypassCache]); },
      create: async (p) => { calls.push(['create', p]); return { id: 99 }; },
      group: async (p) => { calls.push(['group', p]); },
      move: async (id, p) => { calls.push(['move', id, p]); },
      remove: async (id) => { calls.push(['remove', id]); },
    },
  };
  let internal;
  new Function('chrome', SRC)(chrome);
  const send = (cmd, args, sender = {}) => new Promise((res) => listener({ cmd, args }, sender, res));
  return { send, calls, internal: (cmd, args) => new Promise((res) => internal({ cmd, args }, {}, res)) };
}

test('ping and list', async () => {
  const { send } = boot();
  assert.deepEqual((await send('ping')).result.version, '0.1.0');
  const r = await send('list');
  assert.equal(r.ok, true);
  assert.equal(r.result.length, 5);
});

test('disable/enable by name substring', async () => {
  const { send, calls } = boot();
  assert.equal((await send('disable', { id: 'ublock' })).result.enabled, false);
  assert.equal((await send('enable', { id: 'uBlock' })).result.enabled, true);
  assert.deepEqual(calls, [['a'.repeat(32), false], ['a'.repeat(32), true]]);
});

test('reload = disable then enable', async () => {
  const { send, calls } = boot();
  const r = await send('reload', { id: 'c'.repeat(32) });
  assert.equal(r.result.enabled, true);
  assert.deepEqual(calls, [['c'.repeat(32), false], ['c'.repeat(32), true]]);
});

test('ambiguous / missing / unknown', async () => {
  const { send } = boot();
  assert.match((await send('disable', { id: 'dev' })).error, /ambiguous/);
  assert.match((await send('disable', { id: 'nope' })).error, /no extension/);
  assert.match((await send('disable', {})).error, /missing/);
  assert.match((await send('rm -rf')).error, /unknown cmd/);
});

test('tabs and refresh', async () => {
  const { send, calls } = boot();
  assert.equal((await send('tabs')).result.length, 2);
  assert.deepEqual((await send('refresh', { url: 'http://localhost:3000/*' })).result, [{ id: 1, url: 'http://localhost:3000/' }]);
  await send('refresh', { tabId: 7, bypassCache: true });
  assert.deepEqual(calls, [['reload', 1, false], ['reload', 7, true]]);
  assert.match((await send('refresh', {})).error, /tabId or args.url/);
});

test('recover reopens in place, keeps group, then removes the stuck tab', async () => {
  const { send, calls } = boot();
  assert.equal((await send('recover', { tabId: 1 })).ok, true);
  assert.deepEqual(calls, [
    ['create', { url: 'http://localhost:3000/', windowId: 1, index: 3, active: true }],
    ['group', { groupId: 5, tabIds: 99 }],
    ['remove', 1],
  ]);
  assert.match((await send('recover', {})).error, /missing args.tabId/);
});

test('adopt into caller group or explicit group', async () => {
  const { send, calls } = boot();
  assert.equal((await send('adopt', { tabId: 2 }, { tab: { groupId: 7 } })).ok, true);
  assert.deepEqual(calls, [['move', 2, { windowId: 9, index: -1 }], ['group', { groupId: 7, tabIds: 2 }]]);
  assert.match((await send('adopt', { tabId: 2 }, { tab: { groupId: -1 } })).error, /not in a tab group/);
  assert.equal((await send('adopt', { tabId: 2, groupId: 8 })).ok, true);
});

test('internal onMessage uses the same commands', async () => {
  const { internal } = boot();
  assert.equal((await internal('list')).result.length, 5);
});

test('guards: self and Claude in Chrome', async () => {
  const { send, calls } = boot();
  assert.match((await send('disable', { id: 'Claude Browser Hands' })).error, /bridge itself/);
  assert.match((await send('reload', { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn' })).error, /force/);
  assert.deepEqual(calls, []);
  assert.equal((await send('disable', { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn', force: true })).ok, true);
});
