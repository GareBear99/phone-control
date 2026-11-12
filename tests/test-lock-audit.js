// Audit tests for the per-device finger lock: latency glitches both ways.
// Run: node /tmp/ai-finger-test/test-lock-audit.js
// Expects the server running on 8099 with --adb /tmp/ai-finger-test/fake-adb,
// and a second server on 8098 with --adb /bin/true (no devices).
// Run against FRESH servers. Section 1 runs FIRST (it needs a fresh server
// with an empty size cache). Section 2 runs the real page script in Node
// behind a minimal DOM shim, with a fetch wrapper that injects latency so
// each race is deterministic (a slow lock POST, out-of-order responses, a
// slow status poll, out-of-order device switches).
'use strict';

const BASE = 'http://127.0.0.1:8099';
const NODEV = 'http://127.0.0.1:8098';
const LOG = '/tmp/ai-finger-test/adb-commands.log';
const ALL_LOG = '/tmp/ai-finger-test/adb-all.log';
const DIR = '/tmp/ai-finger-test';
// Repo adaptation: PAGE_PATH resolves relative to this test file, so the
// suite is self-contained in the repo. (Upstream harness copy hardcoded
// '/home/hatch/workspace/phone-control/index.html'.)
const path = require('node:path');
const PAGE_PATH = process.env.PAGE_PATH || path.join(__dirname, '..', 'server', 'index.html');
const fs = require('node:fs');
const vm = require('node:vm');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  throw new Error('timeout waiting for: ' + (label || 'condition'));
}

async function req(base, path, opts) {
  const r = await fetch(base + path, opts);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t, headers: r.headers };
}
async function post(base, path, body) {
  return req(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function logLines(file) {
  try { return fs.readFileSync(file || LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}
function setFlag(name, on) {
  const p = DIR + '/' + name;
  if (on) fs.writeFileSync(p, '');
  else { try { fs.unlinkSync(p); } catch {} }
}

// ---------- Section 1: server ordering (fresh server) ----------------------
// The lock check must run BEFORE deviceSize and before any input/screencap
// adb call. On a fresh server the size cache is empty, so if the check ran
// after deviceSize, a locked tap would spawn `adb shell wm size`. Lock
// first (before any /api/status call), then tap while locked.
async function section1() {
  console.log('--- section 1: 423 ordering (fresh server) ---');
  fs.writeFileSync(DIR + '/screencap-count', '0');
  setFlag('frozen', false); setFlag('fail-screencap', false);
  try { fs.unlinkSync(LOG); } catch {}
  try { fs.unlinkSync(ALL_LOG); } catch {}

  const lk = await post(BASE, '/api/finger-lock', { locked: true });
  check('ordering: lock first on a fresh server -> 200', lk.status === 200 && lk.json && lk.json.locked === true, JSON.stringify(lk.json));
  const allBefore = logLines(ALL_LOG).length;
  const t = await post(BASE, '/api/tap', { x: 300, y: 400 });
  check('ordering: locked tap -> 423', t.status === 423, `got ${t.status} ${JSON.stringify(t.json)}`);
  const allNew = logLines(ALL_LOG).slice(allBefore);
  check('ordering: locked tap ran no `wm size` (lock check is before deviceSize)', !allNew.some(l => l.includes('wm size')), JSON.stringify(allNew));
  check('ordering: locked tap ran no `input` command', !allNew.some(l => l.includes('input')), JSON.stringify(allNew));
  check('ordering: locked tap ran no `screencap`', !allNew.some(l => l.includes('screencap')), JSON.stringify(allNew));
  check('ordering: locked tap only ran `devices` (ensureDevice)', allNew.length > 0 && allNew.every(l => l.trim() === 'devices'), JSON.stringify(allNew));
  const un = await post(BASE, '/api/finger-lock', { locked: false });
  check('ordering: unlock again for the page tests', un.status === 200 && un.json && un.json.locked === false);
}

// ---------- Section 2: DOM shim — run the real page script -----------------
class FakeClassList {
  constructor() { this._s = new Set(); }
  add(...c) { c.forEach(x => this._s.add(x)); }
  remove(...c) { c.forEach(x => this._s.delete(x)); }
  toggle(c, force) {
    if (force === undefined) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); }
    else if (force) this._s.add(c); else this._s.delete(c);
    return this._s.has(c);
  }
  contains(c) { return this._s.has(c); }
}
class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.innerHTML = '';
    this.src = '';
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this._handlers = {};
  }
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); }
  // A disabled button does not fire click, like a real browser.
  async dispatch(type, event) {
    if (this.disabled && type === 'click') return;
    const ev = event || {};
    ev.target = ev.target || this;
    if (!ev.preventDefault) ev.preventDefault = () => {};
    const fns = this._handlers[type] || [];
    for (const fn of fns) await fn(ev);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 640 }; }
  setPointerCapture() {}
}

// Latency injection for the page's fetch. Delays are per route/body so each
// race is deterministic: a slow lock POST, out-of-order lock responses, a
// slow status poll, out-of-order device switches.
const delayCfg = { fingerLockReq: 0, fingerLockRes: null, statusRes: 0, selectRes: null };
const requests = []; // every request the page sent: {path, body}
function resetDelays() {
  delayCfg.fingerLockReq = 0; delayCfg.fingerLockRes = null;
  delayCfg.statusRes = 0; delayCfg.selectRes = null;
}
async function wrappedFetch(input, opts) {
  let url = typeof input === 'string' ? input : String(input);
  if (url.startsWith('/')) url = BASE + url;
  const u = new URL(url);
  const p = u.pathname;
  let body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch {}
  if (p === '/api/finger-lock' && delayCfg.fingerLockReq) await sleep(delayCfg.fingerLockReq);
  const r = await fetch(url, opts);
  const t = await r.text();
  requests.push({ path: p, body });
  let resDelay = 0;
  if (p === '/api/finger-lock' && typeof delayCfg.fingerLockRes === 'function') resDelay = delayCfg.fingerLockRes(body);
  if (p === '/api/status' && delayCfg.statusRes) resDelay = delayCfg.statusRes;
  if (p === '/api/select' && typeof delayCfg.selectRes === 'function') resDelay = delayCfg.selectRes(body);
  if (resDelay) await sleep(resDelay);
  return { ok: r.ok, status: r.status, text: async () => t, headers: { get: (n) => r.headers.get(n) } };
}

function loadPage() {
  const html = fs.readFileSync(PAGE_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline script in ' + PAGE_PATH);
  let js = m[1];
  // Debug accessor into the page's own state (defensive: names that do not
  // exist yet — e.g. on the pre-fix page — read as undefined, not a throw).
  js += `\n;globalThis.__page = {
    get fingerLocked(){ try { return fingerLocked; } catch(e){ return undefined; } },
    get selected(){ try { return selected; } catch(e){ return undefined; } },
    get reticle(){ try { return reticle; } catch(e){ return undefined; } },
    get deviceSize(){ try { return deviceSize; } catch(e){ return undefined; } },
    get stateVersion(){ try { return stateVersion; } catch(e){ return undefined; } },
    get lockSeq(){ try { return lockSeq; } catch(e){ return undefined; } },
    get sendText(){ try { return sendText; } catch(e){ return undefined; } },
  };`;
  const elements = {};
  const mk = (id) => { const el = new FakeElement(id); elements[id] = el; return el; };
  ['screen', 'status', 'device', 'nodata', 'lockToggle', 'lockRow', 'reticle', 'fingerPos', 'verifyLine', 'text', 'sendText', 'holdMs', 'holdBtn', 'refreshBtn'].forEach(mk);
  const keyButtons = ['home', 'back', 'recents', 'power', 'volup', 'voldown'].map(k => {
    const b = new FakeElement('key-' + k); b.dataset.key = k; return b;
  });
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: (sel) => (sel === '[data-key]' ? keyButtons : []),
  };
  const sandbox = {
    document, console,
    // The page's intervals are recorded, never auto-run: the test drives
    // polls explicitly so timing is deterministic.
    setInterval: (fn) => 1,
    clearInterval: () => {},
    setTimeout, clearTimeout,
    fetch: wrappedFetch,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return { P: sandbox.__page, els: elements, keyButtons };
}

async function section2() {
  console.log('--- section 2: page latency races (DOM shim) ---');
  const { P, els, keyButtons } = loadPage();
  await waitFor(() => P.selected === 'emulator-5554' && P.deviceSize, 3000, 'page init');
  check('page init: selected emulator-5554, size known', P.selected === 'emulator-5554' && !!P.deviceSize, `selected=${P.selected} size=${JSON.stringify(P.deviceSize)}`);

  // The screen is 360x640 in the shim, the device 720x1280: client (150,200)
  // is device (300,400).
  async function tapAt(cx, cy) {
    await els.screen.dispatch('pointerdown', { clientX: cx, clientY: cy, pointerId: 1 });
    await els.screen.dispatch('pointerup', { clientX: cx, clientY: cy, pointerId: 1 });
  }
  async function syncPage() {
    await els.refreshBtn.dispatch('click');
    // Wait until the page's state converges to the server's state. The
    // status fetch is fire-and-forget, and a fixed sleep is too tight:
    // each fake-adb spawn costs ~0.14s (node startup) and a status round
    // trip needs two of them (devices + wm size), so 250ms is not enough
    // for the page to reflect the server. Poll the server, then wait for
    // the page to match it.
    const s = await req(BASE, '/api/status');
    const want = s.json;
    if (!want) { await sleep(700); return; }
    await waitFor(() => P.selected === want.selected
      && P.fingerLocked === !!want.fingerLocked
      && JSON.stringify(P.reticle) === JSON.stringify(want.reticle), 5000, 'page state converges to server state');
  }
  async function setLockViaPage(locked) {
    els.lockToggle.checked = locked;
    await els.lockToggle.dispatch('change');
    await sleep(250);
  }

  // --- A. Lock gap: a tap fired right after the lock click must not slip through.
  await syncPage();
  check('A setup: page unlocked', P.fingerLocked === false && els.lockToggle.checked === false, `locked=${P.fingerLocked}`);
  requests.length = 0;
  try { fs.unlinkSync(LOG); } catch {}
  delayCfg.fingerLockReq = 200; // the lock POST is slow to reach the server
  els.lockToggle.checked = true;
  // Fire-and-forget: a real user taps while the lock POST is still in flight.
  // (Awaiting the dispatch would wait for the POST and hide the gap.)
  const changeA = els.lockToggle.dispatch('change');
  await tapAt(150, 200); // fired immediately, before the lock POST lands
  await changeA;
  await sleep(400);
  check('A lock-gap: tap fired right after lock click was NOT sent to the server', requests.filter(r => r.path === '/api/tap').length === 0, JSON.stringify(requests.filter(r => r.path === '/api/tap')));
  check('A lock-gap: no `tap 300 400` ran on the device', !logLines().includes('tap 300 400'), logLines().join(' | '));
  check('A lock-gap: page shows locked (checkbox + controls disabled)', P.fingerLocked === true && els.lockToggle.checked === true && keyButtons[0].disabled === true, `locked=${P.fingerLocked} checked=${els.lockToggle.checked} disabled=${keyButtons[0].disabled}`);
  delayCfg.fingerLockReq = 0;
  const stA = await req(BASE, '/api/status');
  check('A lock-gap: server is locked', stA.json && stA.json.fingerLocked === true, JSON.stringify(stA.json && stA.json.fingerLocked));

  // --- B. Unlock latency: a tap fired right after unlock must work.
  requests.length = 0;
  try { fs.unlinkSync(LOG); } catch {}
  delayCfg.fingerLockReq = 200; // the unlock POST is slow
  els.lockToggle.checked = false;
  // Fire-and-forget: the tap is fired while the unlock POST is in flight.
  const changeB = els.lockToggle.dispatch('change');
  await tapAt(150, 200); // fired immediately after unlock
  await changeB;
  await sleep(400);
  check('B unlock-then-tap: the tap went through once the unlock landed', logLines().includes('tap 300 400'), logLines().join(' | '));
  check('B unlock-then-tap: exactly one /api/tap request was sent', requests.filter(r => r.path === '/api/tap').length === 1, JSON.stringify(requests.filter(r => r.path === '/api/tap')));
  delayCfg.fingerLockReq = 0;

  // --- C. Rapid toggling: out-of-order responses must not leave the wrong state.
  await syncPage();
  check('C setup: page unlocked', P.fingerLocked === false, `locked=${P.fingerLocked}`);
  // Unlock responses arrive LAST (300ms) while lock responses are fast (50ms),
  // so the unlock response lands after both lock responses.
  delayCfg.fingerLockRes = (body) => (body && body.locked) ? 50 : 300;
  // Fire-and-forget all three toggles so all three POSTs are in flight at
  // once (awaiting each dispatch would serialize them and hide the race).
  els.lockToggle.checked = true; const cg1 = els.lockToggle.dispatch('change');
  await sleep(10);
  els.lockToggle.checked = false; const cg2 = els.lockToggle.dispatch('change');
  await sleep(10);
  els.lockToggle.checked = true; const cg3 = els.lockToggle.dispatch('change');
  await Promise.all([cg1, cg2, cg3]);
  await sleep(600);
  const stC = await req(BASE, '/api/status');
  check('C rapid-toggle: server is locked (last toggle wins)', stC.json && stC.json.fingerLocked === true, JSON.stringify(stC.json && stC.json.fingerLocked));
  check('C rapid-toggle: page agrees it is locked (stale unlock response ignored)', P.fingerLocked === true && els.lockToggle.checked === true, `locked=${P.fingerLocked} checked=${els.lockToggle.checked}`);
  delayCfg.fingerLockRes = null;
  await setLockViaPage(false);

  // --- D. Stale poll: a status response that predates the lock must not flip it back.
  await syncPage();
  delayCfg.statusRes = 250; // the status poll is slow
  await els.refreshBtn.dispatch('click'); // kicks off updateStatus (pre-lock state)
  // Let the server compute the status response BEFORE the lock lands, so the
  // response the page eventually gets genuinely predates the lock. (Without
  // this wait the server may process the lock first and the response is not
  // stale at all, which hides the glitch.)
  await sleep(100);
  els.lockToggle.checked = true; await els.lockToggle.dispatch('change');
  await sleep(500); // the stale status response arrived at ~250ms
  check('D stale-poll: checkbox was NOT flipped back by the stale poll', els.lockToggle.checked === true, `checked=${els.lockToggle.checked}`);
  check('D stale-poll: page still knows it is locked', P.fingerLocked === true, `locked=${P.fingerLocked}`);
  check('D stale-poll: input controls still disabled', keyButtons[0].disabled === true, `disabled=${keyButtons[0].disabled}`);
  delayCfg.statusRes = 0;
  await setLockViaPage(false);

  // --- E. Rapid device switch: the newest switch wins, lock + reticle follow it.
  await post(BASE, '/api/select', { serial: 'emulator-5554' });
  await post(BASE, '/api/reticle', { x: 100, y: 200 });
  await post(BASE, '/api/finger-lock', { locked: true });
  await post(BASE, '/api/select', { serial: 'emulator-5556' });
  await post(BASE, '/api/finger-lock', { locked: false });
  await post(BASE, '/api/select', { serial: 'emulator-5554' });
  await syncPage();
  check('E setup: page on A, locked, reticle (100,200)', P.selected === 'emulator-5554' && P.fingerLocked === true && P.reticle && P.reticle.x === 100 && P.reticle.y === 200, `selected=${P.selected} locked=${P.fingerLocked} reticle=${JSON.stringify(P.reticle)}`);
  // The switch-to-B response is slow (300ms), the switch-to-A response fast (50ms).
  delayCfg.selectRes = (body) => (body && body.serial === 'emulator-5556') ? 300 : 50;
  delayCfg.statusRes = 100;
  // Fire-and-forget both switches so both select POSTs are in flight at once.
  els.device.value = 'emulator-5556'; const sw1 = els.device.dispatch('change');
  await sleep(10);
  els.device.value = 'emulator-5554'; const sw2 = els.device.dispatch('change');
  await Promise.all([sw1, sw2]);
  await sleep(700);
  check('E rapid-switch: page selected is A (the last switch)', P.selected === 'emulator-5554', `selected=${P.selected}`);
  check('E rapid-switch: page shows A locked', P.fingerLocked === true && els.lockToggle.checked === true, `locked=${P.fingerLocked} checked=${els.lockToggle.checked}`);
  check('E rapid-switch: page shows A reticle (100,200)', P.reticle && P.reticle.x === 100 && P.reticle.y === 200, JSON.stringify(P.reticle));
  delayCfg.selectRes = null; delayCfg.statusRes = 0;
  await post(BASE, '/api/finger-lock', { locked: false });
  await syncPage();

  // --- F. Stale verify: locking must clear the verify line.
  await tapAt(150, 200);
  // Wait for the tap round trip to land and the verify line to show it:
  // a tap needs several adb spawns (~0.14s each), so a fixed 150ms sleep
  // is far too short and the line is still empty when the check runs.
  await waitFor(() => /screen changed|screen unchanged|screen present/.test(els.verifyLine.textContent), 5000, 'verify line shows the tap result');
  check('F setup: verify line shows the tap result', /screen changed|screen unchanged|screen present/.test(els.verifyLine.textContent), `verify=${els.verifyLine.textContent}`);
  els.lockToggle.checked = true; await els.lockToggle.dispatch('change');
  await sleep(250);
  check('F stale-verify: verify line is cleared while locked', els.verifyLine.textContent === '', `verify=${els.verifyLine.textContent}`);
  check('F stale-verify: page shows locked', P.fingerLocked === true, `locked=${P.fingerLocked}`);
  await setLockViaPage(false);

  // --- G. Key/text handlers refuse locally when locked (handler-level guard).
  await syncPage();
  els.lockToggle.checked = true; await els.lockToggle.dispatch('change');
  await sleep(250);
  check('G setup: page locked', P.fingerLocked === true, `locked=${P.fingerLocked}`);
  requests.length = 0;
  // Invoke the Home handler directly, bypassing the disabled button (a real
  // browser would not fire it; this tests the handler's own guard).
  const homeBtn = keyButtons.find(b => b.dataset.key === 'home');
  for (const fn of (homeBtn._handlers.click || [])) await fn();
  check('G key-guard: locked key press sent no /api/key request', requests.filter(r => r.path === '/api/key').length === 0, JSON.stringify(requests.filter(r => r.path === '/api/key')));
  els.text.value = 'hello';
  await P.sendText();
  check('G text-guard: locked text send sent no /api/text request', requests.filter(r => r.path === '/api/text').length === 0, JSON.stringify(requests.filter(r => r.path === '/api/text')));
  check('G text-guard: the text was not cleared (send refused)', els.text.value === 'hello', `text=${els.text.value}`);
  await setLockViaPage(false);

  // Cleanup: unlock both devices, reset flags.
  await post(BASE, '/api/select', { serial: 'emulator-5554' });
  await post(BASE, '/api/finger-lock', { locked: false });
  await post(BASE, '/api/select', { serial: 'emulator-5556' });
  await post(BASE, '/api/finger-lock', { locked: false });
  await post(BASE, '/api/select', { serial: 'emulator-5554' });
  setFlag('frozen', false); setFlag('fail-screencap', false);
  resetDelays();
}

(async () => {
  await section1();
  await section2();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
