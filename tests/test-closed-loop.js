// Test the phone-control closed loop: read the relay back, not the sent.
// Run: node /tmp/ai-finger-test/test-closed-loop.js
// Expects the server running on 8099 with --adb /tmp/ai-finger-test/fake-adb,
// and a second server on 8098 with --adb /bin/true (no devices).
// Resets the screencap counter + flag files at start, cleans them up at end.
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
  return { status: r.status, json: j, text: t, headers: r.headers, raw: Buffer.from(t, 'utf8') };
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
const isHex12 = (s) => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);

(async () => {
  // Reset: fresh counter, no flags, empty command log.
  fs.writeFileSync(DIR + '/screencap-count', '0');
  setFlag('frozen', false); setFlag('fail-screencap', false);
  try { fs.unlinkSync(LOG); } catch {}

  // 1. Fresh-frame route: new capture, fresh timestamp + hash headers.
  const f1 = await req(BASE, '/api/frame?fresh=1');
  check('GET /api/frame?fresh=1 200 PNG', f1.status === 200 && (f1.headers.get('content-type') || '').includes('image/png'), `got ${f1.status}`);
  const at1 = Number(f1.headers.get('x-frame-at'));
  const age1 = Number(f1.headers.get('x-frame-age-ms'));
  const hash1 = f1.headers.get('x-frame-hash');
  check('fresh frame has X-Frame-At (recent epoch ms)', Number.isFinite(at1) && Date.now() - at1 < 5000, `at=${f1.headers.get('x-frame-at')}`);
  check('fresh frame X-Frame-Age-Ms is small', Number.isFinite(age1) && age1 >= 0 && age1 < 5000, `age=${f1.headers.get('x-frame-age-ms')}`);
  check('fresh frame X-Frame-Hash is 12 hex', isHex12(hash1), `hash=${hash1}`);

  // A second fresh frame has a different hash (the screen "changed").
  const f2 = await req(BASE, '/api/frame?fresh=1');
  const hash2 = f2.headers.get('x-frame-hash');
  check('second fresh frame has a different hash', isHex12(hash2) && hash2 !== hash1, `h1=${hash1} h2=${hash2}`);
  check('second fresh frame has a newer X-Frame-At', Number(f2.headers.get('x-frame-at')) >= at1, `at1=${at1} at2=${f2.headers.get('x-frame-at')}`);

  // Plain /api/frame also carries the headers now.
  const f3 = await req(BASE, '/api/frame');
  check('plain /api/frame carries X-Frame-Hash', isHex12(f3.headers.get('x-frame-hash')), `hash=${f3.headers.get('x-frame-hash')}`);
  check('plain /api/frame carries X-Frame-At', Number.isFinite(Number(f3.headers.get('x-frame-at'))));

  // 2. Status reports frame age + timestamp + hash for the selected device.
  const f4 = await req(BASE, '/api/frame'); // make sure a frame is cached
  const st = await req(BASE, '/api/status');
  check('status frameHash is 12 hex', isHex12(st.json && st.json.frameHash), JSON.stringify(st.json && st.json.frameHash));
  check('status frameAt is recent epoch ms', typeof (st.json && st.json.frameAt) === 'number' && Date.now() - st.json.frameAt < 5000, JSON.stringify(st.json && st.json.frameAt));
  check('status frameAgeMs is a small non-negative number', typeof (st.json && st.json.frameAgeMs) === 'number' && st.json.frameAgeMs >= 0 && st.json.frameAgeMs < 5000, JSON.stringify(st.json && st.json.frameAgeMs));
  check('status frameHash matches the last frame header', st.json && st.json.frameHash === f4.headers.get('x-frame-hash'), `status=${st.json && st.json.frameHash} frame=${f4.headers.get('x-frame-hash')}`);

  // 3. Tap: verify object, hash changes (screen changed).
  const beforeTap = await req(BASE, '/api/frame'); // frame the AI is looking at
  const beforeHash = beforeTap.headers.get('x-frame-hash');
  const t1 = await post(BASE, '/api/tap', { x: 300, y: 400 });
  check('tap 200 with ok:true', t1.status === 200 && t1.json && t1.json.ok === true, JSON.stringify(t1.json));
  check('tap returns verify.verified true', t1.json && t1.json.verify && t1.json.verify.verified === true, JSON.stringify(t1.json && t1.json.verify));
  check('tap verify.changed is true (screen changed)', t1.json && t1.json.verify && t1.json.verify.changed === true, JSON.stringify(t1.json && t1.json.verify));
  check('tap verify.before.hash is the frame the AI saw', t1.json && t1.json.verify && t1.json.verify.before && t1.json.verify.before.hash === beforeHash, JSON.stringify(t1.json && t1.json.verify && t1.json.verify.before));
  check('tap verify.after.hash differs from before', t1.json && t1.json.verify && t1.json.verify.after && t1.json.verify.after.hash !== beforeHash, JSON.stringify(t1.json && t1.json.verify && t1.json.verify.after));
  check('tap verify.after.at is newer than before.at', t1.json && t1.json.verify && t1.json.verify.after && t1.json.verify.after.at > t1.json.verify.before.at, JSON.stringify(t1.json && t1.json.verify));
  check('tap verify.after.ageMs is small', t1.json && t1.json.verify && t1.json.verify.after && t1.json.verify.after.ageMs >= 0 && t1.json.verify.after.ageMs < 5000, JSON.stringify(t1.json && t1.json.verify && t1.json.verify.after));
  check('tap still moves the reticle', t1.json && t1.json.reticle && t1.json.reticle.x === 300 && t1.json.reticle.y === 400);
  check('adb got `tap 300 400`', logLines().includes('tap 300 400'));

  // 4. Hold: same verify shape.
  const h1 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 1500 });
  check('hold 200 with ok:true + verify.changed true', h1.status === 200 && h1.json && h1.json.ok === true && h1.json.verify && h1.json.verify.changed === true, JSON.stringify(h1.json));
  check('hold echoes {100,200,1500} + verify', h1.json && h1.json.hold && h1.json.hold.duration === 1500 && h1.json.verify && h1.json.verify.verified === true);

  // 5. Swipe: verify object too.
  const s1 = await post(BASE, '/api/swipe', { x1: 100, y1: 200, x2: 100, y2: 600, duration: 300 });
  check('swipe 200 with ok:true + verify.changed true', s1.status === 200 && s1.json && s1.json.ok === true && s1.json.verify && s1.json.verify.changed === true, JSON.stringify(s1.json));

  // 6. Same hash when the screen does not change (frozen screen).
  await req(BASE, '/api/frame'); // cache a frozen-basis frame first
  setFlag('frozen', true);
  const fz = await req(BASE, '/api/frame'); // now the cached frame is the frozen PNG
  const fzHash = fz.headers.get('x-frame-hash');
  const t2 = await post(BASE, '/api/tap', { x: 50, y: 60 });
  check('frozen: tap still 200 ok:true', t2.status === 200 && t2.json && t2.json.ok === true, JSON.stringify(t2.json));
  check('frozen: verify.verified true', t2.json && t2.json.verify && t2.json.verify.verified === true, JSON.stringify(t2.json && t2.json.verify));
  check('frozen: verify.changed is false (same hash)', t2.json && t2.json.verify && t2.json.verify.changed === false, JSON.stringify(t2.json && t2.json.verify));
  check('frozen: before and after hashes are the frozen hash', t2.json && t2.json.verify && t2.json.verify.before.hash === fzHash && t2.json.verify.after.hash === fzHash, JSON.stringify(t2.json && t2.json.verify));
  setFlag('frozen', false);

  // 7. Device gone mid-action: tap sent, fresh frame fails -> ok:false, verified:false.
  setFlag('fail-screencap', true);
  const t3 = await post(BASE, '/api/tap', { x: 10, y: 10 });
  check('screencap failing: tap returns ok:false (never ok:true on a dead device)', t3.status === 200 && t3.json && t3.json.ok === false, `status=${t3.status} ${JSON.stringify(t3.json)}`);
  check('screencap failing: error names the disconnect', t3.json && typeof t3.json.error === 'string' && /no fresh frame/i.test(t3.json.error), JSON.stringify(t3.json && t3.json.error));
  check('screencap failing: verify.verified false', t3.json && t3.json.verify && t3.json.verify.verified === false, JSON.stringify(t3.json && t3.json.verify));
  check('screencap failing: verify.after is null', t3.json && t3.json.verify && t3.json.verify.after === null, JSON.stringify(t3.json && t3.json.verify));
  check('screencap failing: the tap command was still sent', logLines().includes('tap 10 10'));
  // Fresh route must not serve a stale frame as fresh.
  const ff = await req(BASE, '/api/frame?fresh=1');
  check('screencap failing: GET /api/frame?fresh=1 -> 502, no stale frame', ff.status === 502, `got ${ff.status}`);
  // Plain /api/frame still serves the last good frame (poll loop keeps working).
  const fp = await req(BASE, '/api/frame');
  check('screencap failing: plain /api/frame still serves last good frame with X-Frame-Stale', fp.status === 200 && fp.headers.get('x-frame-stale') === '1', `got ${fp.status} stale=${fp.headers.get('x-frame-stale')}`);
  setFlag('fail-screencap', false);

  // 8. Page shows the verify line + hash/stale UI.
  const page = await req(BASE, '/');
  check('page has verify line element', page.text.includes('id="verifyLine"'));
  check('page shows frame hash/stale handling (showVerify)', page.text.includes('showVerify') && page.text.includes('STALE'));

  // 9. No-device instance: fresh frame 503, tap 503, status nulls.
  const nf = await req(NODEV, '/api/frame?fresh=1');
  check('no-device: /api/frame?fresh=1 -> 503', nf.status === 503, `got ${nf.status}`);
  const nt = await post(NODEV, '/api/tap', { x: 10, y: 10 });
  check('no-device: /api/tap -> 503', nt.status === 503, `got ${nt.status}`);
  const nst = await req(NODEV, '/api/status');
  check('no-device: status frame fields null', nst.status === 200 && nst.json && nst.json.frameHash === null && nst.json.frameAt === null && nst.json.frameAgeMs === null, JSON.stringify(nst.json));

  // Cleanup.
  setFlag('frozen', false); setFlag('fail-screencap', false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
