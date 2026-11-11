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
    },
    management: {
      getAll: async () => exts.map((e) => ({ ...e })),
      get: async (id) => ({ ...exts.find((e) => e.id === id) }),
      setEnabled: async (id, on) => { calls.push([id, on]); exts.find((e) => e.id === id).enabled = on; },
    },
  };
  new Function('chrome', SRC)(chrome);
  const send = (cmd, args) => new Promise((res) => listener({ cmd, args }, {}, res));
  return { send, calls };
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

test('guards: self and Claude in Chrome', async () => {
  const { send, calls } = boot();
  assert.match((await send('disable', { id: 'Claude Browser Hands' })).error, /bridge itself/);
  assert.match((await send('reload', { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn' })).error, /force/);
  assert.deepEqual(calls, []);
  assert.equal((await send('disable', { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn', force: true })).ok, true);
});
