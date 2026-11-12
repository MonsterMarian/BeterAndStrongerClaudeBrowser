#!/usr/bin/env node
// Browser Hands CDP CLI: hands for the user's real Chrome that work even when Claude in Chrome is stuck or disconnected.
// Needs Chrome 144+ with remote debugging allowed at chrome://inspect/#remote-debugging (Chrome asks to Allow the connection).
// <ext> = extension id; <tab> = page targetId or a unique URL/title substring.
//
//   node cdp.mjs hands <cmd> ['<json args>']        bridge commands without Claude in Chrome (list, reload, recover, ...)
//   node cdp.mjs targets [ext]                       running service workers/pages of extensions
//   node cdp.mjs storage <ext> [area] [key..]        read chrome.storage (local|sync|session|managed, default local)
//   node cdp.mjs set <ext> <area> '<json>'           merge JSON object into chrome.storage.<area>
//   node cdp.mjs logs <ext> [seconds=3]              buffered + live console messages and uncaught errors
//   node cdp.mjs eval <ext> '<js>'                   evaluate in the extension (top-level await ok), prints JSON
//   node cdp.mjs uninstall <ext> [--force]           remove an extension silently (it calls uninstallSelf); needs the bridge to verify
//   node cdp.mjs tabs                                all page tabs: targetId, url, title
//   node cdp.mjs page <tab> '<js>'                   evaluate in a web page, output NOT redacted
//   node cdp.mjs net <tab> [seconds=5] [--reload] [--bodies=<url regex>]   capture network requests (+ response bodies)
//   node cdp.mjs recover <tab>                       frozen tab: reopen same URL, close the stuck one
//   node cdp.mjs upload <tab> <file..> [--click=<css>] [--timeout=30]       answer the next file-chooser dialog with files
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const BRIDGE = 'ahpnamikcofnoeieghfbngknbcojihol';
const TIMEOUT = Number(process.env.HANDS_TIMEOUT || 30) * 1000;
const USER_DATA = process.env.CHROME_USER_DATA || {
  win32: join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
  darwin: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
}[process.platform] || join(homedir(), '.config', 'google-chrome');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.fail(new Error(`${p.method}: ${m.error.message}`)) : p.ok(m.result); } else listeners.forEach((fn) => fn(m));
  };
  // A hung renderer never answers; fail loudly instead of waiting forever.
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out after ${TIMEOUT / 1000}s - renderer frozen? try: cdp.mjs recover <tab>`)); }, TIMEOUT);
    timer.unref(); // abandoned requests must not keep the CLI alive
    pending.set(id, { ok, fail, method, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, on: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => ws.close() };
}

const extOf = (url) => (url.match(/^chrome-extension:\/\/([a-p]{32})\//) || [])[1];
// A worker caught while starting can sit paused "waiting for debugger" and never answer evaluate; release it (no-op otherwise).
const attachTo = async (c, targetId) => {
  const r = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Runtime.runIfWaitingForDebugger', {}, r.sessionId).catch(() => {});
  return r;
};

export async function targets(c, extId) {
  const { targetInfos } = await c.send('Target.getTargets');
  return targetInfos.filter((t) => extOf(t.url) && (!extId || extOf(t.url) === extId))
    .map(({ targetId, type, url, title }) => ({ targetId, type, url, title }));
}

export async function tabs(c) {
  const { targetInfos } = await c.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page').map(({ targetId, url, title }) => ({ targetId, url, title }));
}

export async function pageTarget(c, q) {
  if (!q) throw new Error('missing <tab> (targetId or URL/title substring, see `tabs`)');
  const all = await tabs(c);
  const hits = all.filter((t) => t.targetId === q).concat(all.filter((t) => t.targetId !== q && (t.url.includes(q) || t.title.includes(q))));
  if (hits.length === 1 || hits[0]?.targetId === q) return hits[0];
  throw new Error(hits.length ? `ambiguous tab "${q}": ${hits.map((t) => `${t.targetId} ${t.url}`).join(', ')}` : `no tab matches "${q}"`);
}

// Evaluate and return a JSON value; a promise left as the completion value is awaited too (replMode does not unwrap it).
async function run(c, sessionId, expression) {
  const fail = (r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r; };
  let r = fail(await c.send('Runtime.evaluate', { expression, awaitPromise: true, replMode: true }, sessionId));
  if (r.result.subtype === 'promise') r = fail(await c.send('Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: true }, sessionId));
  else if (r.result.objectId) r = fail(await c.send('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }, sessionId));
  return r.result.value;
}

// Session inside the extension: its service worker if running, else a background tab on its manifest.json (has chrome.* too).
async function attach(c, extId) {
  const ts = await targets(c, extId);
  let t = ts.find((x) => x.type === 'service_worker') || ts.find((x) => x.type === 'page' && !x.url.endsWith('/manifest.json')); // skip our own closing temp tabs
  let opened;
  if (!t) {
    const url = `chrome-extension://${extId}/manifest.json`;
    ({ targetId: opened } = await c.send('Target.createTarget', { url, background: true }));
    t = { targetId: opened };
  }
  const { sessionId } = await attachTo(c, t.targetId);
  const done = () => (opened ? c.send('Target.closeTarget', { targetId: opened }) : c.send('Target.detachFromTarget', { sessionId })).catch(() => {});
  // Short tries: an evaluate sent while the tab still navigates never returns (Chrome 157.0.8103.51), so don't wait on one.
  for (let i = 0; opened; i++) {
    // the navigation swaps to an extension renderer that may start paused for the attached debugger
    await c.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    const v = await Promise.race([
      c.send('Runtime.evaluate', { expression: 'location.protocol + document.readyState', returnByValue: true }, sessionId).then((r) => r.result.value, () => null),
      sleep(1000).then(() => null),
    ]);
    if (v === 'chrome-extension:complete') break;
    if (i > 15) { await done(); throw new Error(`extension ${extId} is not installed or not enabled`); }
    await sleep(100);
  }
  return { sessionId, done };
}

export async function evaluate(c, extId, expression) {
  const { sessionId, done } = await attach(c, extId);
  try { return await run(c, sessionId, expression); } finally { await done(); }
}

export async function evalPage(c, q, expression) {
  const { sessionId } = await attachTo(c, (await pageTarget(c, q)).targetId);
  try { return await run(c, sessionId, expression); } finally { await c.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

const AREAS = ['local', 'sync', 'session', 'managed'];
const area = (a) => { if (!AREAS.includes(a)) throw new Error(`area must be one of ${AREAS.join('|')}`); return a; };
export const getStorage = (c, extId, a = 'local', keys = []) => evaluate(c, extId, `chrome.storage.${area(a)}.get(${keys.length ? JSON.stringify(keys) : 'null'})`);
export const setStorage = (c, extId, a, obj) => evaluate(c, extId, `chrome.storage.${area(a)}.set(${JSON.stringify(obj)}).then(() => chrome.storage.${a}.get(null))`);

// Bridge commands straight over CDP: in the worker if it runs, else via a bridge page that messages (and wakes) the worker.
export function hands(c, cmd, args = {}) {
  const m = JSON.stringify({ cmd, args });
  return evaluate(c, BRIDGE, `typeof commands === 'object'
    ? (() => { const m = ${m}; if (!commands[m.cmd]) throw new Error('unknown cmd ' + m.cmd + ', known: ' + Object.keys(commands)); return commands[m.cmd](m.args, {}); })()
    : new Promise((ok, no) => chrome.runtime.sendMessage(${m}, (r) => r && r.ok ? ok(r.result) : no(new Error(r ? r.error : chrome.runtime.lastError?.message))))`);
}

// management.uninstall on another extension needs a user gesture + Chrome's confirm dialog; uninstallSelf needs neither,
// so we make the target call it from inside. Verified through the bridge (gone from `get`).
export async function uninstall(c, extId, { force = false } = {}) {
  if (!force && (extId === BRIDGE || extId === 'fcoeoabgfenejglbffodgkkbkcdhcgfn')) throw new Error('refusing to uninstall the bridge or Claude in Chrome without --force');
  const { sessionId, done } = await attach(c, extId);
  // the context dies with the extension, so the evaluate may never answer
  await Promise.race([c.send('Runtime.evaluate', { expression: 'chrome.management.uninstallSelf()', awaitPromise: true }, sessionId).catch(() => {}), sleep(3000)]);
  await done();
  for (let i = 0; i < 30; i++) {
    try { await hands(c, 'get', { id: extId }); } catch (e) { if (/no extension matches/.test(e.message)) return { uninstalled: extId }; throw e; }
    await sleep(200);
  }
  throw new Error(`${extId} is still installed after uninstallSelf`);
}

// Runtime.enable replays messages buffered since the context started, so startup errors show up too.
export async function logs(c, extId, seconds = 3) {
  const ts = await targets(c, extId);
  if (!ts.length) throw new Error('extension has no running service worker/pages - reload it with the bridge (or open its popup), then run logs again');
  const out = [], sessions = new Map();
  const off = c.on(({ method, params, sessionId }) => {
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
  try {
    for (const t of ts) {
      const { sessionId } = await attachTo(c, t.targetId);
      sessions.set(sessionId, t.url);
      await c.send('Runtime.enable', {}, sessionId);
      await c.send('Log.enable', {}, sessionId).catch(() => {}); // not every target type has Log
    }
    await sleep(seconds * 1000);
  } finally { off(); }
  return out;
}

export async function net(c, q, { seconds = 5, reload = false, bodies } = {}) {
  const { sessionId } = await attachTo(c, (await pageTarget(c, q)).targetId);
  const reqs = new Map();
  const off = c.on(({ method, params: p, sessionId: s }) => {
    if (s !== sessionId) return;
    if (method === 'Network.requestWillBeSent') reqs.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type, postData: p.request.postData?.slice(0, 2000) });
    else if (method === 'Network.responseReceived' && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { status: p.response.status, mime: p.response.mimeType });
    else if (method === 'Network.loadingFailed' && reqs.has(p.requestId)) reqs.get(p.requestId).failed = p.errorText;
  });
  try {
    await c.send('Network.enable', {}, sessionId);
    if (reload) await c.send('Page.reload', {}, sessionId);
    await sleep(seconds * 1000);
    const out = [...reqs.values()];
    const re = bodies && new RegExp(bodies);
    for (const r of out) {
      if (!re || !re.test(r.url) || !r.status) continue;
      try {
        const b = await c.send('Network.getResponseBody', { requestId: r.id }, sessionId);
        r.body = b.base64Encoded ? `[base64 ${b.body.length} chars]` : b.body.slice(0, 20000);
      } catch (e) { r.body = `[unavailable: ${e.message}]`; }
    }
    return out;
  } finally { off(); await c.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

export async function recover(c, q) {
  const t = await pageTarget(c, q);
  const { targetId } = await c.send('Target.createTarget', { url: t.url });
  await c.send('Target.closeTarget', { targetId: t.targetId }); // browser-side: works while the renderer hangs
  return { closed: t.targetId, opened: targetId, url: t.url };
}

// Intercepts the page's next file-chooser (incl. ones a click creates on the fly) and fills it - no OS dialog.
// Without `click`, waits for someone (e.g. Claude in Chrome's computer tool) to click the upload button.
export async function upload(c, q, files, { click, timeout = 30 } = {}) {
  if (!files.length) throw new Error('give at least one file');
  const abs = files.map((f) => resolvePath(f));
  abs.forEach((f) => { if (!existsSync(f)) throw new Error(`file not found: ${f}`); });
  const { sessionId } = await attachTo(c, (await pageTarget(c, q)).targetId);
  let off = () => {};
  try {
    await c.send('Page.enable', {}, sessionId);
    await c.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
    const opened = new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`no file chooser opened within ${timeout}s`)), timeout * 1000);
      off = c.on(({ method, params, sessionId: s }) => { if (s === sessionId && method === 'Page.fileChooserOpened') { clearTimeout(t); ok(params); } });
    });
    opened.catch(() => {});
    if (click) { // real input events = user activation, which file choosers require
      const p = await run(c, sessionId, `(() => { const el = document.querySelector(${JSON.stringify(click)}); if (!el) throw new Error('no element matches ' + ${JSON.stringify(click)});
        el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, sessionId);
    }
    const { backendNodeId, mode } = await opened;
    if (mode === 'selectSingle' && abs.length > 1) throw new Error('this input accepts a single file');
    await c.send('DOM.setFileInputFiles', { files: abs, backendNodeId }, sessionId);
    return { files: abs, mode };
  } finally {
    off();
    await c.send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId).catch(() => {});
    await c.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function main(argv) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const [cmd, a1, ...rest] = argv.filter((a) => !a.startsWith('--'));
  const usage = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n');
  const needExt = ['storage', 'set', 'logs', 'eval', 'uninstall'].includes(cmd);
  if (!cmd || (needExt && !/^[a-p]{32}$/.test(a1 || ''))) { console.error(`usage:\n${usage}`); process.exit(2); }
  const c = await connect();
  try {
    const r = await ({
      hands: () => hands(c, a1, rest[0] ? JSON.parse(rest[0]) : {}),
      targets: () => targets(c, a1),
      storage: () => getStorage(c, a1, rest[0], rest.slice(1)),
      set: () => setStorage(c, a1, rest[0], JSON.parse(rest[1])),
      logs: () => logs(c, a1, Number(rest[0] || 3)),
      eval: () => evaluate(c, a1, rest.join(' ')),
      uninstall: () => uninstall(c, a1, { force: !!flags.force }),
      tabs: () => tabs(c),
      page: () => evalPage(c, a1, rest.join(' ')),
      net: () => net(c, a1, { seconds: Number(rest[0] || 5), reload: !!flags.reload, bodies: flags.bodies }),
      recover: () => recover(c, a1),
      upload: () => upload(c, a1, rest, { click: flags.click, timeout: Number(flags.timeout || 30) }),
    }[cmd] || (() => { console.error(`unknown command "${cmd}"\n${usage}`); process.exit(2); }))();
    console.log(JSON.stringify(r, null, 2));
  } finally { c.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
