// End-to-end: real Chrome (temp profile, headless) + CDP over --remote-debugging-pipe.
// Loads the bridge + a dummy extension, then drives the bridge from https://example.com exactly like Claude in Chrome's javascript_tool would.
// Usage: node tests/e2e.mjs [path-to-chrome]   (needs network access to example.com)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const CHROME = process.argv[2] || process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BRIDGE_ID = 'ahpnamikcofnoeieghfbngknbcojihol';
const profile = mkdtempSync(join(tmpdir(), 'hands-e2e-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank',
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

  console.log('e2e OK: ping, list, disable, enable, reload, guards against real Chrome');
} finally {
  chrome.kill();
  await new Promise((r) => chrome.once('exit', r));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
