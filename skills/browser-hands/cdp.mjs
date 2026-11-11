#!/usr/bin/env node
// Browser Hands CDP CLI: reach *inside* an extension in the user's real Chrome - storage, console/errors, eval.
// Needs Chrome 144+ with remote debugging allowed at chrome://inspect/#remote-debugging (Chrome asks to Allow the connection).
//
//   node cdp.mjs targets [extId]                 running service workers/pages of extensions
//   node cdp.mjs storage <extId> [area] [key..]  read chrome.storage (area: local|sync|session|managed, default local)
//   node cdp.mjs set <extId> <area> '<json>'     merge JSON object into chrome.storage.<area>
//   node cdp.mjs logs <extId> [seconds=3]        buffered + live console messages and uncaught errors
//   node cdp.mjs eval <extId> '<js>'             evaluate in the extension (top-level await ok), prints JSON
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const USER_DATA = process.env.CHROME_USER_DATA || {
  win32: join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
  darwin: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
}[process.platform] || join(homedir(), '.config', 'google-chrome');

export async function connect(userData = USER_DATA) {
  let port, path;
  try { [port, path] = readFileSync(join(userData, 'DevToolsActivePort'), 'utf8').split('\n'); } catch {
    throw new Error(`No DevToolsActivePort in "${userData}". Ask the user to open chrome://inspect/#remote-debugging and allow remote debugging (or set CHROME_USER_DATA).`);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port.trim()}${path.trim()}`);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`Cannot connect to Chrome on port ${port.trim()} - remote debugging off, Chrome closed, or the Allow dialog was declined.`));
  });
  let seq = 0;
  const pending = new Map(), listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.fail(new Error(`${p.method}: ${m.error.message}`)) : p.ok(m.result); } else listeners.forEach((fn) => fn(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq; pending.set(id, { ok, fail, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, on: (fn) => listeners.add(fn), close: () => ws.close() };
}

const extOf = (url) => (url.match(/^chrome-extension:\/\/([a-p]{32})\//) || [])[1];

export async function targets(c, extId) {
  const { targetInfos } = await c.send('Target.getTargets');
  return targetInfos.filter((t) => extOf(t.url) && (!extId || extOf(t.url) === extId))
    .map(({ targetId, type, url, title }) => ({ targetId, type, url, title }));
}

// Session inside the extension: its service worker if running, else a background tab on its manifest.json (has chrome.* too).
async function attach(c, extId) {
  const ts = await targets(c, extId);
  let t = ts.find((x) => x.type === 'service_worker') || ts.find((x) => x.type === 'page');
  let opened;
  if (!t) {
    ({ targetId: opened } = await c.send('Target.createTarget', { url: `chrome-extension://${extId}/manifest.json`, background: true }));
    t = { targetId: opened };
  }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  for (let i = 0; opened && i < 50; i++) { // wait until the fresh tab is an extension document
    const { result } = await c.send('Runtime.evaluate', { expression: `location.protocol + document.readyState`, returnByValue: true }, sessionId);
    if (result.value === 'chrome-extension:complete') break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return { sessionId, done: () => opened ? c.send('Target.closeTarget', { targetId: opened }) : c.send('Target.detachFromTarget', { sessionId }) };
}

export async function evaluate(c, extId, expression) {
  const { sessionId, done } = await attach(c, extId);
  try {
    const fail = (r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r; };
    let r = fail(await c.send('Runtime.evaluate', { expression, awaitPromise: true, replMode: true }, sessionId));
    // replMode does not unwrap a promise that is the completion value (e.g. `chrome.storage.local.get()` without await)
    if (r.result.subtype === 'promise') r = fail(await c.send('Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: true }, sessionId));
    else if (r.result.objectId) r = fail(await c.send('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }, sessionId));
    return r.result.value;
  } finally { await done(); }
}

const AREAS = ['local', 'sync', 'session', 'managed'];
const area = (a) => { if (!AREAS.includes(a)) throw new Error(`area must be one of ${AREAS.join('|')}`); return a; };
export const getStorage = (c, extId, a = 'local', keys = []) => evaluate(c, extId, `chrome.storage.${area(a)}.get(${keys.length ? JSON.stringify(keys) : 'null'})`);
export const setStorage = (c, extId, a, obj) => evaluate(c, extId, `chrome.storage.${area(a)}.set(${JSON.stringify(obj)}).then(() => chrome.storage.${a}.get(null))`);

// Runtime.enable replays messages buffered since the context started, so startup errors show up too.
export async function logs(c, extId, seconds = 3) {
  const ts = await targets(c, extId);
  if (!ts.length) throw new Error('extension has no running service worker/pages - reload it with the bridge (or open its popup), then run logs again');
  const out = [], sessions = new Map();
  c.on(({ method, params, sessionId }) => {
    const where = sessions.get(sessionId);
    if (!where) return;
    if (method === 'Runtime.consoleAPICalled') {
      const f = params.stackTrace?.callFrames?.[0];
      out.push({ level: params.type, text: params.args.map((a) => a.value ?? a.description ?? a.type).join(' '), at: f ? `${f.url}:${f.lineNumber + 1}` : where });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      out.push({ level: 'exception', text: d.exception?.description || d.text, at: `${d.url || where}:${d.lineNumber + 1}` });
    } else if (method === 'Log.entryAdded') {
      out.push({ level: params.entry.level, text: params.entry.text, at: params.entry.url || where });
    }
  });
  for (const t of ts) {
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    sessions.set(sessionId, t.url);
    await c.send('Runtime.enable', {}, sessionId);
    await c.send('Log.enable', {}, sessionId).catch(() => {}); // not every target type has Log
  }
  await new Promise((ok) => setTimeout(ok, seconds * 1000));
  return out;
}

async function main([cmd, extId, ...rest]) {
  const usage = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n');
  if (!cmd || (cmd !== 'targets' && !/^[a-p]{32}$/.test(extId || ''))) { console.error(`usage:\n${usage}`); process.exit(2); }
  const c = await connect();
  try {
    let r;
    if (cmd === 'targets') r = await targets(c, extId);
    else if (cmd === 'storage') r = await getStorage(c, extId, rest[0], rest.slice(1));
    else if (cmd === 'set') r = await setStorage(c, extId, rest[0], JSON.parse(rest[1]));
    else if (cmd === 'logs') r = await logs(c, extId, Number(rest[0] || 3));
    else if (cmd === 'eval') r = await evaluate(c, extId, rest.join(' '));
    else { console.error(`unknown command "${cmd}"\n${usage}`); process.exit(2); }
    console.log(JSON.stringify(r, null, 2));
  } finally { c.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
