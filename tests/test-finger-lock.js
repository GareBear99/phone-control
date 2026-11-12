// Test the phone-control per-device finger lock (disable toggle).
// Run: node /tmp/ai-finger-test/test-finger-lock.js
// Expects the server running on 8099 with --adb /tmp/ai-finger-test/fake-adb,
// and a second server on 8098 with --adb /bin/true (no devices).
// Resets the screencap counter + flag files at start, unlocks everything
// and cleans up at end. Run against FRESH servers (the suites assume that).
'use strict';

const BASE = 'http://127.0.0.1:8099';
const NODEV = 'http://127.0.0.1:8098';
const LOG = '/tmp/ai-finger-test/adb-commands.log';
const DIR = '/tmp/ai-finger-test';
const fs = require('node:fs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
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
function logLines() {
  try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}
function setFlag(name, on) {
  const p = DIR + '/' + name;
  if (on) fs.writeFileSync(p, '');
  else { try { fs.unlinkSync(p); } catch {} }
}

(async () => {
  // Reset: fresh counter, no flags, empty command log.
  fs.writeFileSync(DIR + '/screencap-count', '0');
  setFlag('frozen', false); setFlag('fail-screencap', false);
  try { fs.unlinkSync(LOG); } catch {}

  // 1. Lock defaults to unlocked.
  const st0 = await req(BASE, '/api/status');
  check('status fingerLocked defaults to false', st0.status === 200 && st0.json && st0.json.fingerLocked === false, JSON.stringify(st0.json));

  // 2. Page has the toggle + locked styling + lock-aware JS.
  const page = await req(BASE, '/');
  check('page has lock toggle checkbox', page.text.includes('id="lockToggle"'));
  check('page has lock row', page.text.includes('id="lockRow"'));
  check('page has locked reticle styling', page.text.includes('#reticle.locked'));
  check('page wires the toggle to /api/finger-lock', page.text.includes("'/api/finger-lock'") || page.text.includes('/api/finger-lock'));
  check('page refresh drops the forced fresh frame while locked', page.text.includes('fingerLocked') && page.text.includes('pollFrame()'));

  // 3. Invalid lock values -> 400.
  const bad1 = await post(BASE, '/api/finger-lock', { locked: 'yes' });
  check('lock with string value -> 400', bad1.status === 400, `got ${bad1.status} ${JSON.stringify(bad1.json)}`);
  const bad2 = await post(BASE, '/api/finger-lock', {});
  check('lock with missing value -> 400', bad2.status === 400, `got ${bad2.status}`);
  const bad3 = await post(BASE, '/api/finger-lock', { locked: 1 });
  check('lock with numeric value -> 400', bad3.status === 400, `got ${bad3.status}`);

  // 4. Set a known reticle position first (unlocked), then lock.
  const r0 = await post(BASE, '/api/reticle', { x: 100, y: 200 });
  check('reticle moved to 100,200 before locking', r0.status === 200 && r0.json && r0.json.reticle && r0.json.reticle.x === 100 && r0.json.reticle.y === 200);
  const lock = await post(BASE, '/api/finger-lock', { locked: true });
  check('POST /api/finger-lock {locked:true} 200', lock.status === 200 && lock.json && lock.json.ok === true && lock.json.locked === true && lock.json.serial === 'emulator-5554', JSON.stringify(lock.json));
  const st1 = await req(BASE, '/api/status');
  check('status fingerLocked true after locking', st1.json && st1.json.fingerLocked === true, JSON.stringify(st1.json));

  // 5. While locked, every input endpoint -> 423, no adb command, reticle unmoved.
  const logBefore = logLines().length;
  const t1 = await post(BASE, '/api/tap', { x: 300, y: 400 });
  check('locked: tap -> 423', t1.status === 423, `got ${t1.status} ${JSON.stringify(t1.json)}`);
  check('locked: tap error names the lock', t1.json && /finger locked/i.test(t1.json.error || ''), JSON.stringify(t1.json));
  check('locked: tap body carries the serial', t1.json && t1.json.serial === 'emulator-5554', JSON.stringify(t1.json));
  const h1 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 1500 });
  check('locked: hold -> 423', h1.status === 423, `got ${h1.status}`);
  const s1 = await post(BASE, '/api/swipe', { x1: 100, y1: 200, x2: 100, y2: 600, duration: 300 });
  check('locked: swipe -> 423', s1.status === 423, `got ${s1.status}`);
  const rc1 = await post(BASE, '/api/reticle', { x: 50, y: 60 });
  check('locked: reticle -> 423', rc1.status === 423, `got ${rc1.status}`);
  const tx1 = await post(BASE, '/api/text', { text: 'hello' });
  check('locked: text -> 423', tx1.status === 423, `got ${tx1.status}`);
  const k1 = await post(BASE, '/api/key', { key: 'home' });
  check('locked: key -> 423', k1.status === 423, `got ${k1.status}`);
  check('locked: no adb command ran for any refused action', logLines().length === logBefore, `log grew: ${JSON.stringify(logLines().slice(logBefore))}`);
  const st2 = await req(BASE, '/api/status');
  check('locked: reticle did not move', st2.json && st2.json.reticle && st2.json.reticle.x === 100 && st2.json.reticle.y === 200, JSON.stringify(st2.json && st2.json.reticle));

  // 6. Read-only routes still work while locked.
  const st3 = await req(BASE, '/api/status');
  check('locked: /api/status still 200', st3.status === 200 && st3.json && st3.json.fingerLocked === true);
  const fr = await req(BASE, '/api/frame');
  check('locked: /api/frame still 200 PNG', fr.status === 200 && (fr.headers.get('content-type') || '').includes('image/png'), `got ${fr.status}`);
  const frf = await req(BASE, '/api/frame?fresh=1');
  check('locked: /api/frame?fresh=1 still 200 PNG', frf.status === 200 && (frf.headers.get('content-type') || '').includes('image/png'), `got ${frf.status}`);
  const dv = await req(BASE, '/api/devices');
  check('locked: /api/devices still 200', dv.status === 200 && dv.json && dv.json.devices.length === 2);

  // 7. Unlock restores all actions.
  const unlock = await post(BASE, '/api/finger-lock', { locked: false });
  check('POST /api/finger-lock {locked:false} 200', unlock.status === 200 && unlock.json && unlock.json.ok === true && unlock.json.locked === false, JSON.stringify(unlock.json));
  const st4 = await req(BASE, '/api/status');
  check('status fingerLocked false after unlocking', st4.json && st4.json.fingerLocked === false);
  const t2 = await post(BASE, '/api/tap', { x: 300, y: 400 });
  check('unlocked: tap works again (200 ok:true)', t2.status === 200 && t2.json && t2.json.ok === true, JSON.stringify(t2.json));
  check('unlocked: adb got `tap 300 400`', logLines().includes('tap 300 400'));
  check('unlocked: tap moved the reticle to 300,400', t2.json && t2.json.reticle && t2.json.reticle.x === 300 && t2.json.reticle.y === 400);
  const h2 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 1500 });
  check('unlocked: hold works again', h2.status === 200 && h2.json && h2.json.ok === true, JSON.stringify(h2.json));

  // 8. Per-device: lock A, switch to B (unlocked, works), switch back (A still locked).
  const lockA = await post(BASE, '/api/finger-lock', { locked: true });
  check('lock device A (emulator-5554) again', lockA.status === 200 && lockA.json && lockA.json.locked === true && lockA.json.serial === 'emulator-5554');
  const selB = await post(BASE, '/api/select', { serial: 'emulator-5556' });
  check('select device B (emulator-5556)', selB.status === 200 && selB.json && selB.json.selected === 'emulator-5556', JSON.stringify(selB.json));
  const stB = await req(BASE, '/api/status');
  check('device B fingerLocked is false (its own lock)', stB.json && stB.json.fingerLocked === false, JSON.stringify(stB.json));
  check('device B reticle is its own centre (360,640)', stB.json && stB.json.reticle && stB.json.reticle.x === 360 && stB.json.reticle.y === 640, JSON.stringify(stB.json && stB.json.reticle));
  const tB = await post(BASE, '/api/tap', { x: 500, y: 600 });
  check('device B tap works while A is locked', tB.status === 200 && tB.json && tB.json.ok === true, JSON.stringify(tB.json));
  const selA = await post(BASE, '/api/select', { serial: 'emulator-5554' });
  check('select device A back', selA.status === 200 && selA.json && selA.json.selected === 'emulator-5554');
  const stA = await req(BASE, '/api/status');
  check('device A still locked after switching back', stA.json && stA.json.fingerLocked === true, JSON.stringify(stA.json));
  check('device A reticle is its own (100,200 from the hold)', stA.json && stA.json.reticle && stA.json.reticle.x === 100 && stA.json.reticle.y === 200, JSON.stringify(stA.json && stA.json.reticle));
  const tA = await post(BASE, '/api/tap', { x: 10, y: 10 });
  check('device A tap still 423', tA.status === 423, `got ${tA.status}`);

  // 9. No-device instance: status fingerLocked false, lock endpoint 503.
  const nst = await req(NODEV, '/api/status');
  check('no-device: status fingerLocked false', nst.status === 200 && nst.json && nst.json.fingerLocked === false, JSON.stringify(nst.json));
  const nlk = await post(NODEV, '/api/finger-lock', { locked: true });
  check('no-device: POST /api/finger-lock -> 503', nlk.status === 503, `got ${nlk.status} ${JSON.stringify(nlk.json)}`);

  // Cleanup: unlock device A, remove flags.
  await post(BASE, '/api/select', { serial: 'emulator-5554' });
  await post(BASE, '/api/finger-lock', { locked: false });
  setFlag('frozen', false); setFlag('fail-screencap', false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
