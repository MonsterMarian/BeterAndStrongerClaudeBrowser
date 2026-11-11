// End-to-end: real Chrome (temp profile, headless) + CDP over --remote-debugging-pipe.
// Loads the bridge + a dummy extension, then drives the bridge from https://example.com exactly like Claude in Chrome's javascript_tool would.
// Usage: node tests/e2e.mjs [path-to-chrome]   (needs network access to example.com)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { connect, targets, getStorage, setStorage, logs, evaluate, hands, tabs, evalPage, net, recover, upload } from '../skills/browser-hands/cdp.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const CHROME = process.argv[2] || process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BRIDGE_ID = 'ahpnamikcofnoeieghfbngknbcojihol';
const profile = mkdtempSync(join(tmpdir(), 'hands-e2e-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  // pipe = loading test extensions; port = the websocket the CDP CLI uses (like chrome://inspect remote debugging in a real profile)
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

// CDP pipe protocol: NUL-terminated JSON; we write fd 3, Chrome writes fd 4.
let seq = 0, buf = '';
const pending = new Map();
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
});

const bridge = (sessionId) => async (cmd, args = {}) => {
  const expression = `new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(BRIDGE_ID)}, ${JSON.stringify({ cmd, args })}, r))`;
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  return result.value;
};

try {
  const { id } = await cdp('Extensions.loadUnpacked', { path: resolve('skills/browser-hands/extension') });
  assert.equal(id, BRIDGE_ID, 'manifest key must pin the extension id');
  const { id: dummy } = await cdp('Extensions.loadUnpacked', { path: resolve('tests/fixtures/dummy-ext') });

  const { targetId } = await cdp('Target.createTarget', { url: 'https://example.com/' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; ; i++) { // wait for load + externally_connectable injection
    const { result } = await cdp('Runtime.evaluate', { expression: `location.host + '|' + !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)`, returnByValue: true }, sessionId);
    if (result.value === 'example.com|true') break;
    if (i > 100) throw new Error(`bridge not reachable on page: ${result.value}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const H = bridge(sessionId);

  assert.equal((await H('ping')).result.id, BRIDGE_ID);
  const list = (await H('list')).result;
  assert.ok(list.some((e) => e.id === dummy && e.enabled), 'dummy listed and enabled');

  let r = await H('disable', { id: 'hands test dummy' });
  assert.equal(r.ok, true, r.error); assert.equal(r.result.enabled, false);
  r = await H('enable', { id: dummy });
  assert.equal(r.result.enabled, true);
  r = await H('reload', { id: dummy });
  assert.equal(r.ok, true, r.error); assert.equal(r.result.enabled, true);
  assert.match((await H('disable', { id: BRIDGE_ID })).error, /bridge itself/);
  assert.match((await H('bogus')).error, /unknown cmd/);
  console.log('bridge OK: ping, list, disable, enable, reload, guards');

  // refresh: reload a second tab found via `tabs`, prove it reloaded by a marker that disappears
  const { targetId: t2 } = await cdp('Target.createTarget', { url: 'https://example.com/#second' });
  const { sessionId: s2 } = await cdp('Target.attachToTarget', { targetId: t2, flatten: true });
  const marker = () => cdp('Runtime.evaluate', { expression: 'document.readyState === "complete" && !window.__mark', returnByValue: true }, s2).then((r) => r.result.value).catch(() => false);
  while (!(await marker())) await new Promise((r) => setTimeout(r, 100));
  await cdp('Runtime.evaluate', { expression: 'window.__mark = 1' }, s2);
  const second = (await H('tabs', { url: 'https://example.com/*' })).result.find((t) => t.url.endsWith('#second'));
  assert.ok(second, 'tabs finds the second tab');
  assert.equal((await H('refresh', { tabId: second.id })).result[0].id, second.id);
  for (let i = 0; !(await marker()); i++) { assert.ok(i < 100, 'tab reloaded'); await new Promise((r) => setTimeout(r, 100)); }
  console.log('bridge OK: tabs, refresh');

  // CDP CLI against the websocket: storage, logs, eval inside other extensions
  const { id: noisy } = await cdp('Extensions.loadUnpacked', { path: resolve('tests/fixtures/noisy-ext') });
  while (!existsSync(join(profile, 'DevToolsActivePort'))) await new Promise((r) => setTimeout(r, 100));
  const c = await connect(profile);
  try {
    for (let i = 0; !(await targets(c, noisy)).some((t) => t.type === 'service_worker'); i++) { assert.ok(i < 100, 'noisy SW running'); await new Promise((r) => setTimeout(r, 100)); }
    for (let i = 0; (await getStorage(c, noisy)).count !== 1; i++) { assert.ok(i < 50, 'seeded storage'); await new Promise((r) => setTimeout(r, 100)); }
    assert.deepEqual(await getStorage(c, noisy, 'local', ['apiKey']), { apiKey: 'abc' });
    assert.deepEqual(await setStorage(c, noisy, 'local', { count: 2 }), { apiKey: 'abc', count: 2 });
    // dummy has no service worker -> read through a temporary manifest.json tab
    assert.deepEqual(await getStorage(c, dummy), {});
    assert.deepEqual(await setStorage(c, dummy, 'local', { note: 'hi' }), { note: 'hi' });
    assert.ok(!(await targets(c, dummy)).length, 'temporary tab closed');
    const log = await logs(c, noisy, 0.5);
    assert.ok(log.some((l) => l.level === 'error' && l.text === 'noisy startup error'), `startup error replayed: ${JSON.stringify(log)}`);
    assert.equal(await evaluate(c, noisy, 'const a = await Promise.resolve(40); a + 2'), 42);
    assert.deepEqual(await evaluate(c, noisy, 'chrome.storage.local.get("count")'), { count: 2 }); // un-awaited promise gets unwrapped
    await assert.rejects(evaluate(c, noisy, 'throw new Error("nope")'), /nope/);
    assert.throws(() => { getStorage(c, noisy, 'evil'); }, /area must be/);
    console.log('cdp OK: targets, storage get/set (SW + no-SW), logs replay, eval');

    // hands: bridge commands without Claude in Chrome - worker running, then worker stopped (woken via bridge page)
    assert.ok((await hands(c, 'list')).some((e) => e.id === dummy));
    assert.equal((await hands(c, 'reload', { id: dummy })).enabled, true);
    await assert.rejects(hands(c, 'nope'), /unknown cmd/);
    await cdp('ServiceWorker.enable', {}, sessionId);
    await cdp('ServiceWorker.stopAllWorkers', {}, sessionId);
    for (let i = 0; (await targets(c, BRIDGE_ID)).length; i++) { assert.ok(i < 50, 'bridge worker stopped'); await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await hands(c, 'ping')).id, BRIDGE_ID);
    console.log('cdp OK: hands (running + stopped worker)');

    // tabs / page / net
    assert.ok((await tabs(c)).some((t) => t.url.endsWith('#second')));
    assert.equal(await evalPage(c, '#second', 'location.hash'), '#second');
    const reqs = await net(c, '#second', { seconds: 2, reload: true, bodies: 'example\\.com' });
    const doc = reqs.find((r) => r.url.startsWith('https://example.com/') && r.type === 'Document');
    assert.equal(doc?.status, 200, JSON.stringify(reqs));
    assert.match(doc.body, /Example Domain/);
    console.log('cdp OK: tabs, page, net (+bodies)');

    // frozen tabs: bridge recover (by tabId) and cdp recover (by title)
    const frozen = async (title) => {
      const { targetId } = await cdp('Target.createTarget', { url: `data:text/html,<title>${title}</title>` });
      while (!(await tabs(c)).some((t) => t.title === title)) await new Promise((r) => setTimeout(r, 100));
      await evalPage(c, title, 'setTimeout(() => { for (;;); }, 50); 1');
      await new Promise((r) => setTimeout(r, 300));
      const hung = evalPage(c, title, '1'); hung.catch(() => {}); // stays pending until the 30s timeout
      assert.equal(await Promise.race([hung, new Promise((r) => setTimeout(() => r('frozen'), 1500))]), 'frozen');
      return targetId;
    };
    await frozen('freeze1');
    const ft = (await H('tabs')).result.find((t) => t.title === 'freeze1');
    r = await H('recover', { tabId: ft.id });
    assert.equal(r.ok, true, r.error); assert.notEqual(r.result.id, ft.id);
    for (let i = 0; ; i++) { try { if (await evalPage(c, 'freeze1', '1 + 1') === 2) break; } catch {} assert.ok(i < 50, 'recovered tab responsive'); await new Promise((r) => setTimeout(r, 100)); }
    const stuck = await frozen('freeze2');
    const rec = await recover(c, 'freeze2');
    assert.equal(rec.closed, stuck);
    for (let i = 0; ; i++) { try { if (await evalPage(c, rec.opened, '1 + 1') === 2) break; } catch {} assert.ok(i < 50, 'cdp-recovered tab responsive'); await new Promise((r) => setTimeout(r, 100)); }
    console.log('OK: recover frozen tab (bridge + cdp)');

    // adopt: put the caller (example.com) into a group, then pull the #second tab into it
    const caller = (await H('tabs')).result.find((t) => t.url === 'https://example.com/');
    const gid = await evaluate(c, BRIDGE_ID, `chrome.tabs.group({ tabIds: [${caller.id}] })`);
    r = await H('adopt', { tabId: second.id });
    assert.equal(r.ok, true, r.error); assert.equal(r.result.groupId, gid);
    console.log('bridge OK: adopt');

    // upload: input is created by the click handler (like Google Flow), no OS dialog
    const page = `<title>uploadpage</title><button id=b style="width:200px;height:80px">Upload</button><script>b.onclick=()=>{const i=document.createElement('input');i.type='file';i.onchange=()=>document.title='got:'+i.files[0].name;i.click()}</script>`;
    const { targetId: up } = await cdp('Target.createTarget', { url: 'data:text/html,' + encodeURIComponent(page) });
    while (!(await tabs(c)).some((t) => t.title === 'uploadpage')) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await upload(c, up, ['tests/fixtures/upload.txt'], { click: '#b', timeout: 10 })).mode, 'selectSingle');
    for (let i = 0; (await evalPage(c, up, 'document.title')) !== 'got:upload.txt'; i++) { assert.ok(i < 50, 'file arrived'); await new Promise((r) => setTimeout(r, 100)); }
    await assert.rejects(upload(c, up, ['nope.txt']), /file not found/);
    console.log('cdp OK: upload via intercepted file chooser');
  } finally { c.close(); }
  console.log('e2e OK');
} finally {
  chrome.kill();
  await new Promise((r) => chrome.once('exit', r));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
