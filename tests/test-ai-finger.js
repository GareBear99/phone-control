// Test the phone-control AI finger endpoints against the fake adb.
// Run: node /tmp/ai-finger-test/test-ai-finger.js
// Expects the server running on 8099 with --adb /tmp/ai-finger-test/fake-adb,
// and a second server on 8098 with --adb /bin/true (no devices).
'use strict';

const BASE = 'http://127.0.0.1:8099';
const NODEV = 'http://127.0.0.1:8098';
const LOG = '/tmp/ai-finger-test/adb-commands.log';
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

(async () => {
  // 1. Page serves and contains the reticle + Hold UI.
  const page = await req(BASE, '/');
  check('GET / serves 200', page.status === 200);
  check('page has reticle element', page.text.includes('id="reticle"'));
  check('page has hold button', page.text.includes('id="holdBtn"'));
  check('page has hold duration input', page.text.includes('id="holdMs"'));
  check('page has finger position readout', page.text.includes('id="fingerPos"'));

  // 2. Devices: two fake devices, emulator-5554 preferred/selected.
  const devs = await req(BASE, '/api/devices');
  check('GET /api/devices 200', devs.status === 200);
  check('two fake devices listed', devs.json && devs.json.devices.length === 2, JSON.stringify(devs.json));
  check('emulator-5554 selected', devs.json && devs.json.selected === 'emulator-5554');

  // 3. Status: size 720x1280, reticle defaults to centre (360, 640).
  const st0 = await req(BASE, '/api/status');
  check('GET /api/status 200', st0.status === 200);
  check('size is 720x1280', st0.json && st0.json.size && st0.json.size.w === 720 && st0.json.size.h === 1280, JSON.stringify(st0.json));
  check('reticle defaults to centre', st0.json && st0.json.reticle && st0.json.reticle.x === 360 && st0.json.reticle.y === 640, JSON.stringify(st0.json && st0.json.reticle));

  // 4. Reticle positioning.
  const r1 = await post(BASE, '/api/reticle', { x: 100, y: 200 });
  check('POST /api/reticle 200', r1.status === 200, JSON.stringify(r1.json));
  check('reticle moved to 100,200', r1.json && r1.json.reticle && r1.json.reticle.x === 100 && r1.json.reticle.y === 200);
  const st1 = await req(BASE, '/api/status');
  check('status shows moved reticle', st1.json && st1.json.reticle && st1.json.reticle.x === 100 && st1.json.reticle.y === 200);

  // 5. Reticle validation.
  const rb1 = await post(BASE, '/api/reticle', { x: 9999, y: 200 });
  check('reticle x out of range -> 400', rb1.status === 400, `got ${rb1.status}`);
  const rb2 = await post(BASE, '/api/reticle', { x: -1, y: 0 });
  check('reticle negative x -> 400', rb2.status === 400, `got ${rb2.status}`);
  const rb3 = await post(BASE, '/api/reticle', { x: 'a', y: 0 });
  check('reticle non-integer x -> 400', rb3.status === 400, `got ${rb3.status}`);

  // 6. Tap moves the reticle and runs `input tap`.
  const t1 = await post(BASE, '/api/tap', { x: 300, y: 400 });
  check('POST /api/tap 200', t1.status === 200, JSON.stringify(t1.json));
  check('tap moves reticle to 300,400', t1.json && t1.json.reticle && t1.json.reticle.x === 300 && t1.json.reticle.y === 400);
  check('adb got `tap 300 400`', logLines().includes('tap 300 400'), logLines().join(' | '));
  const tb1 = await post(BASE, '/api/tap', { x: 720, y: 0 });
  check('tap x=720 (w=720) -> 400', tb1.status === 400, `got ${tb1.status}`);

  // 7. Hold: same start/end swipe, reticle moves, validation.
  const h1 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 1500 });
  check('POST /api/hold 200', h1.status === 200, JSON.stringify(h1.json));
  check('hold echoes {100,200,1500}', h1.json && h1.json.hold && h1.json.hold.x === 100 && h1.json.hold.y === 200 && h1.json.hold.duration === 1500);
  check('hold moves reticle to 100,200', h1.json && h1.json.reticle && h1.json.reticle.x === 100 && h1.json.reticle.y === 200);
  check('adb got `swipe 100 200 100 200 1500` (same start/end)', logLines().includes('swipe 100 200 100 200 1500'), logLines().join(' | '));
  const hb1 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 50 });
  check('hold duration 50 -> 400', hb1.status === 400, `got ${hb1.status}`);
  const hb2 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 20000 });
  check('hold duration 20000 -> 400', hb2.status === 400, `got ${hb2.status}`);
  const hb3 = await post(BASE, '/api/hold', { x: 100, y: 200, duration: 'abc' });
  check('hold non-integer duration -> 400', hb3.status === 400, `got ${hb3.status}`);
  const hb4 = await post(BASE, '/api/hold', { x: 721, y: 200, duration: 1000 });
  check('hold x out of range -> 400', hb4.status === 400, `got ${hb4.status}`);
  const h2 = await post(BASE, '/api/hold', { x: 100, y: 200 });
  check('hold without duration defaults to 1000', h2.status === 200 && h2.json && h2.json.hold.duration === 1000, JSON.stringify(h2.json));
  check('adb got default-duration `swipe 100 200 100 200 1000`', logLines().includes('swipe 100 200 100 200 1000'));

  // 8. Per-device fingers: 5554 remembers 100,200; 5556 starts at centre.
  const s2 = await post(BASE, '/api/select', { serial: 'emulator-5556' });
  check('select emulator-5556 200', s2.status === 200, JSON.stringify(s2.json));
  const st2 = await req(BASE, '/api/status');
  check('5556 reticle is its own centre default', st2.json && st2.json.reticle && st2.json.reticle.x === 360 && st2.json.reticle.y === 640, JSON.stringify(st2.json && st2.json.reticle));
  await post(BASE, '/api/reticle', { x: 10, y: 20 });
  const s1 = await post(BASE, '/api/select', { serial: 'emulator-5554' });
  check('select emulator-5554 back 200', s1.status === 200);
  const st3 = await req(BASE, '/api/status');
  check('5554 still remembers 100,200', st3.json && st3.json.reticle && st3.json.reticle.x === 100 && st3.json.reticle.y === 200, JSON.stringify(st3.json && st3.json.reticle));
  await post(BASE, '/api/select', { serial: 'emulator-5556' });
  const st4 = await req(BASE, '/api/status');
  check('5556 still remembers 10,20', st4.json && st4.json.reticle && st4.json.reticle.x === 10 && st4.json.reticle.y === 20, JSON.stringify(st4.json && st4.json.reticle));
  const sbad = await post(BASE, '/api/select', { serial: 'no-such-device' });
  check('select unknown serial -> 400', sbad.status === 400, `got ${sbad.status}`);

  // 9. Frame works through the fake adb.
  const fr = await req(BASE, '/api/frame');
  check('GET /api/frame 200 PNG', fr.status === 200 && (fr.headers.get('content-type') || '').includes('image/png'), `got ${fr.status}`);

  // 10. No-device instance: clean 503s, no crash.
  const nd = await req(NODEV, '/api/devices');
  check('no-device: /api/devices 200 empty list', nd.status === 200 && nd.json && nd.json.devices.length === 0, JSON.stringify(nd.json));
  const nst = await req(NODEV, '/api/status');
  check('no-device: /api/status selected null, reticle null', nst.status === 200 && nst.json && nst.json.selected === null && nst.json.reticle === null, JSON.stringify(nst.json));
  const nt = await post(NODEV, '/api/tap', { x: 10, y: 10 });
  check('no-device: /api/tap -> 503', nt.status === 503, `got ${nt.status}`);
  const nh = await post(NODEV, '/api/hold', { x: 10, y: 10, duration: 1000 });
  check('no-device: /api/hold -> 503', nh.status === 503, `got ${nh.status}`);
  const nr = await post(NODEV, '/api/reticle', { x: 10, y: 10 });
  check('no-device: /api/reticle -> 503', nr.status === 503, `got ${nr.status}`);
  const nf = await req(NODEV, '/api/frame');
  check('no-device: /api/frame -> 503', nf.status === 503, `got ${nf.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
