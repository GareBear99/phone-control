// phone-control — web remote control for an Android phone / emulator via adb.
// Stdlib only (node: http + child_process). No dependencies, no build step.
// Every device controlled has its own AI finger: a reticle (visible cursor)
// that acts as a finger — position it, tap with it, hold with it.
// Closed loop (Gary's rule): the finger never trusts "sent". After every
// action it reads the relay back — the screen, visually — and confirms the
// action landed. A tap/hold/swipe returns the frame fingerprint before and
// after, and `verified: false` when no fresh frame arrives.
// Finger lock (Gary's safety switch): each device has a disable toggle.
// A locked finger cannot act on its device at all — every input endpoint
// answers 423 and runs no adb command. Reading the screen is never locked.
// Run:  node server.js            (binds 127.0.0.1:8090)
//       node server.js --lan      (binds 0.0.0.0:8090 — LAN only, never the internet)
//       node server.js --port 8091 --adb /path/to/adb
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const PORT = Number(flagValue('--port') || process.env.PORT || 8090);
const HOST = args.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
const ADB = flagValue('--adb')
  || process.env.ADB
  || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb')
      : 'adb');

// --- state ---------------------------------------------------------------
let selectedDevice = null;          // serial of the device being controlled
const sizeCache = new Map();        // serial -> {w,h} from `adb shell wm size`
const reticleCache = new Map();     // serial -> {x,y} AI finger (reticle) position
// Per-device finger lock (Gary's safety switch): serial -> true when the
// finger on that device is disabled. Default is unlocked — a finger starts
// enabled, Gary locks it explicitly. One lock per device, like the reticle.
const fingerLockCache = new Map();  // serial -> boolean (true = locked)
let frameCache = { png: null, at: 0, device: null, hash: null }; // last good frame + its fingerprint

// --- adb helpers ----------------------------------------------------------
function runAdb(argv, { timeout = 15000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ADB, argv, { timeout, maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr && stderr.toString().trim()) || err.message);
        e.code = err.code;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

async function listDevices() {
  try {
    const out = await runAdb(['devices'], { timeout: 8000 });
    const devices = [];
    for (const line of out.toString().split('\n').slice(1)) {
      const m = line.trim().match(/^(\S+)\s+(\S+)$/);
      if (m) devices.push({ serial: m[1], state: m[2] });
    }
    return devices;
  } catch {
    return []; // adb missing / not running -> empty list, never a crash
  }
}

async function deviceSize(serial) {
  if (sizeCache.has(serial)) return sizeCache.get(serial);
  const out = await runAdb(['-s', serial, 'shell', 'wm', 'size'], { timeout: 8000 });
  const m = out.toString().match(/(\d+)\s*x\s*(\d+)/);
  if (!m) throw new Error('could not read device size');
  const size = { w: Number(m[1]), h: Number(m[2]) };
  sizeCache.set(serial, size);
  return size;
}

// The AI finger: one reticle per device, keyed by serial. A device that has
// never had its finger positioned starts at screen centre.
function reticleFor(serial, size) {
  const r = reticleCache.get(serial);
  if (r) return r;
  if (!size) return null;
  const centre = { x: Math.round(size.w / 2), y: Math.round(size.h / 2) };
  reticleCache.set(serial, centre);
  return centre;
}
function setReticle(serial, x, y) {
  const r = { x, y };
  reticleCache.set(serial, r);
  return r;
}

// The finger lock: a hard stop, not a warning. A locked finger cannot act
// on its device at all — no tap, no hold, no swipe, no reticle move, no
// text, no key. Reading the screen is still fine (see the status/frame
// routes, which the lock never blocks). A device that has never been
// locked is unlocked.
function isFingerLocked(serial) {
  return fingerLockCache.get(serial) === true;
}
function setFingerLock(serial, locked) {
  fingerLockCache.set(serial, locked);
  return locked;
}

async function ensureDevice() {
  const devices = await listDevices();
  const online = devices.filter(d => d.state === 'device');
  if (!selectedDevice || !online.some(d => d.serial === selectedDevice)) {
    // Prefer emulator-5554 when present, otherwise the first online device.
    selectedDevice = (online.find(d => d.serial === 'emulator-5554') || online[0] || null)?.serial ?? null;
  }
  return { devices, selected: selectedDevice };
}

function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// `adb shell input text` needs %s for spaces and escaping of shell specials.
function escapeInputText(s) {
  return s.replace(/%/g, '%25')
    .replace(/ /g, '%s')
    .replace(/(["'\\$`!&;()<>|*?~#^])/g, '\\$1');
}

// --- http helpers ---------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

// --- frame capture ---------------------------------------------------------
// Closed loop (Gary's rule): the finger never trusts "sent" — it reads the
// relay back, visually. The relay back is the screen itself. A frame's
// fingerprint (SHA-256 of the PNG bytes, first 12 hex chars) is the cheap
// signal for "did the screen change": same hash = the screen did not
// change; different hash = it did. A changed hash proves the screen
// changed, not that the RIGHT thing changed — judging what changed is the
// AI's job, from the frames themselves.
function frameHash(png) {
  return crypto.createHash('sha256').update(png).digest('hex').slice(0, 12);
}

// The frame the AI was looking at, for one device. Null fields when there
// is no cached frame for that device — a frame from another device (or no
// frame at all) says nothing about this device's screen.
function frameSnapshotFor(serial) {
  if (!frameCache.png || frameCache.device !== serial) return { hash: null, at: null, ageMs: null };
  return { hash: frameCache.hash, at: frameCache.at, ageMs: Date.now() - frameCache.at };
}

// Read the relay back after an action: capture a fresh frame (taken after
// the action) and compare its fingerprint with the frame the AI saw before
// the action. Returns the verify object; never claims success it cannot
// see. If no fresh frame arrives the action is UNVERIFIED — the device may
// be gone — and the caller must say so, not pretend it worked.
async function verifyAfterAction(selected, before) {
  try {
    await captureFrame(selected, { force: true });
  } catch (e) {
    return { verified: false, reason: 'no fresh frame after action — device may be disconnected', before, after: null };
  }
  const after = frameSnapshotFor(selected);
  const changed = before.hash && after.hash ? before.hash !== after.hash : null;
  return { verified: true, changed, before, after };
}

let frameInFlight = null; // promise for the capture currently running, else null
async function doCapture(serial) {
  // Smallest valid PNG is 45 bytes (8 signature + 25 IHDR + 12 IEND).
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const validPng = (b) => b && b.length >= 45 && b.subarray(0, 4).equals(PNG_SIG);
  // exec-out is binary-safe, but some emulators reject it
  // ("adb: unknown command screencap") — fall back to plain shell,
  // which returns a clean PNG on this setup (verified: 725,420 bytes).
  let png = await runAdb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 10000 }).catch(() => null);
  if (!validPng(png)) {
    png = await runAdb(['-s', serial, 'shell', 'screencap', '-p'], { timeout: 10000 }).catch(() => null);
  }
  if (validPng(png)) {
    frameCache = { png, at: Date.now(), device: serial, hash: frameHash(png) };
    return png;
  }
  throw new Error('bad screencap output');
}

// Capture a frame. A plain call returns the cached frame while a capture is
// already in flight (the ~3 fps poll loop must not stack up screencaps).
// A forced call waits for any in-flight capture, then captures anew — the
// frame it returns was taken AFTER the caller asked for it. That is the
// frame the finger judges an action against.
async function captureFrame(serial, { force = false } = {}) {
  if (frameInFlight) {
    if (!force) return frameCache.png;
    try { await frameInFlight; } catch { /* fall through, try a fresh one */ }
  }
  const p = doCapture(serial);
  frameInFlight = p;
  try {
    return await p;
  } finally {
    if (frameInFlight === p) frameInFlight = null;
  }
}

// --- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/api/devices') {
      const { devices, selected } = await ensureDevice();
      return json(res, 200, { devices, selected });
    }

    if (req.method === 'POST' && p === '/api/select') {
      const body = await readJson(req);
      const { devices } = await ensureDevice();
      if (typeof body.serial !== 'string' || !devices.some(d => d.serial === body.serial && d.state === 'device')) {
        return json(res, 400, { error: 'unknown or offline device' });
      }
      selectedDevice = body.serial;
      return json(res, 200, { selected: selectedDevice });
    }

    if (req.method === 'GET' && p === '/api/status') {
      const { devices, selected } = await ensureDevice();
      const size = selected ? await deviceSize(selected).catch(() => null) : null;
      const reticle = selected ? reticleFor(selected, size) : null;
      // Frame freshness is part of the answer: frameAgeMs/frameAt/frameHash
      // describe the last frame captured FOR THIS DEVICE (null when there
      // is none yet). The AI checks the age before trusting a frame.
      const frame = selected ? frameSnapshotFor(selected) : { hash: null, at: null, ageMs: null };
      return json(res, 200, { devices, selected, size, frameAgeMs: frame.ageMs, frameAt: frame.at, frameHash: frame.hash, reticle, fingerLocked: selected ? isFingerLocked(selected) : false });
    }

    if (req.method === 'GET' && p === '/api/frame') {
      const { selected } = await ensureDevice();
      if (!selected) return json(res, 503, { error: 'no device connected' });
      // ?fresh=1 forces a new screencap taken after this request — the frame
      // the finger judges an action against. It must NEVER be a stale frame
      // in disguise: on failure it returns 502, never the cached frame.
      const fresh = url.searchParams.get('fresh') === '1';
      try {
        const png = await captureFrame(selected, { force: fresh });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'no-store',
          'X-Frame-At': String(frameCache.at),
          'X-Frame-Age-Ms': String(Date.now() - frameCache.at),
          'X-Frame-Hash': frameCache.hash || '',
        });
        return res.end(png);
      } catch (e) {
        if (fresh) return json(res, 502, { error: 'fresh screencap failed: ' + e.message });
        // Serve the last good frame rather than failing the poll loop.
        if (frameCache.png && frameCache.device === selected) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': frameCache.png.length,
            'Cache-Control': 'no-store',
            'X-Frame-Stale': '1',
            'X-Frame-At': String(frameCache.at),
            'X-Frame-Age-Ms': String(Date.now() - frameCache.at),
            'X-Frame-Hash': frameCache.hash || '',
          });
          return res.end(frameCache.png);
        }
        return json(res, 502, { error: 'screencap failed: ' + e.message });
      }
    }

    // --- finger lock: per-device safety switch ----------------------------
    // POST /api/finger-lock {locked: true|false} — disables/locks the AI
    // finger on the SELECTED device. Locked means the finger cannot act on
    // that device at all (see the enforcement below). This route itself is
    // never blocked by the lock — it is the way back out. Runs no adb
    // command. No device selected → 503, like the other input endpoints.
    if (req.method === 'POST' && p === '/api/finger-lock') {
      const { selected } = await ensureDevice();
      if (!selected) return json(res, 503, { error: 'no device connected' });
      const body = await readJson(req);
      if (typeof body.locked !== 'boolean') {
        return json(res, 400, { error: 'locked must be true or false' });
      }
      const locked = setFingerLock(selected, body.locked);
      return json(res, 200, { ok: true, locked, serial: selected });
    }

    // --- input endpoints (all require a selected device) -------------------
    if (req.method === 'POST' && ['/api/tap', '/api/reticle', '/api/hold', '/api/swipe', '/api/text', '/api/key'].includes(p)) {
      const { selected } = await ensureDevice();
      if (!selected) return json(res, 503, { error: 'no device connected' });
      // The lock is a hard stop: it is checked BEFORE any adb runs, so a
      // locked finger issues no adb command at all — and the reticle does
      // not move, because no action runs. Read-only routes (devices,
      // status, frame) are never blocked by the lock; only acting is.
      // The lock also switches off the verification cost for this device:
      // the 423 returns before any action, so there is no forced
      // fresh-frame capture, no hash comparison, and no verify object —
      // the extra knowing is off while locked, and latency softens.
      // Unlocking brings the verification back, as before.
      if (isFingerLocked(selected)) {
        return json(res, 423, { error: 'finger locked for this device', serial: selected });
      }
      const size = await deviceSize(selected).catch(() => null);
      if (!size) return json(res, 502, { error: 'could not read device size' });
      const body = await readJson(req);

      if (p === '/api/tap') {
        const { x, y } = body;
        if (!isInt(x, 0, size.w - 1) || !isInt(y, 0, size.h - 1)) {
          return json(res, 400, { error: `x/y out of range for ${size.w}x${size.h}` });
        }
        // The "before" frame is the one the AI was looking at when it
        // decided to act — no new capture here, that would be the AI's
        // frame, not a fresh one. The relay back comes after the tap.
        const before = frameSnapshotFor(selected);
        await runAdb(['-s', selected, 'shell', 'input', 'tap', String(x), String(y)]);
        // The tap IS the finger: the reticle moves to where it tapped.
        const reticle = setReticle(selected, x, y);
        const verify = await verifyAfterAction(selected, before);
        if (!verify.verified) {
          return json(res, 200, { ok: false, error: verify.reason, reticle, verify });
        }
        return json(res, 200, { ok: true, reticle, verify });
      }

      // Position the finger without tapping — the AI moves its reticle here.
      if (p === '/api/reticle') {
        const { x, y } = body;
        if (!isInt(x, 0, size.w - 1) || !isInt(y, 0, size.h - 1)) {
          return json(res, 400, { error: `x/y out of range for ${size.w}x${size.h}` });
        }
        const reticle = setReticle(selected, x, y);
        return json(res, 200, { ok: true, reticle });
      }

      // Press and hold at (x, y) for `duration` ms. A hold is a swipe that
      // starts and ends at the same point — Android treats it as a long-press.
      // A pre-briefed hold is just this call with x, y, duration set in
      // advance, before it runs.
      if (p === '/api/hold') {
        const { x, y, duration = 1000 } = body;
        if (!isInt(x, 0, size.w - 1) || !isInt(y, 0, size.h - 1)) {
          return json(res, 400, { error: `x/y out of range for ${size.w}x${size.h}` });
        }
        if (!isInt(duration, 100, 10000)) {
          return json(res, 400, { error: 'duration must be 100-10000 ms' });
        }
        const before = frameSnapshotFor(selected);
        await runAdb(['-s', selected, 'shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(duration)]);
        const reticle = setReticle(selected, x, y);
        const verify = await verifyAfterAction(selected, before);
        if (!verify.verified) {
          return json(res, 200, { ok: false, error: verify.reason, hold: { x, y, duration }, reticle, verify });
        }
        return json(res, 200, { ok: true, hold: { x, y, duration }, reticle, verify });
      }

      if (p === '/api/swipe') {
        const { x1, y1, x2, y2, duration = 300 } = body;
        const ok = [x1, y1].every(v => isInt(v, 0, 100000)) && [x2, y2].every(v => isInt(v, 0, 100000))
          && isInt(x1, 0, size.w - 1) && isInt(y1, 0, size.h - 1)
          && isInt(x2, 0, size.w - 1) && isInt(y2, 0, size.h - 1)
          && isInt(duration, 50, 5000);
        if (!ok) return json(res, 400, { error: `swipe out of range for ${size.w}x${size.h} (duration 50-5000ms)` });
        const before = frameSnapshotFor(selected);
        await runAdb(['-s', selected, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]);
        const verify = await verifyAfterAction(selected, before);
        if (!verify.verified) {
          return json(res, 200, { ok: false, error: verify.reason, verify });
        }
        return json(res, 200, { ok: true, verify });
      }

      if (p === '/api/text') {
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text || text.length > 1000) return json(res, 400, { error: 'text must be 1-1000 chars' });
        await runAdb(['-s', selected, 'shell', 'input', 'text', escapeInputText(text)]);
        return json(res, 200, { ok: true });
      }

      if (p === '/api/key') {
        const ALLOWED = { home: 3, back: 4, recents: 187, power: 26, volup: 24, voldown: 25 };
        const code = ALLOWED[body.key];
        if (code === undefined) return json(res, 400, { error: 'unknown key (home|back|recents|power|volup|voldown)' });
        await runAdb(['-s', selected, 'shell', 'input', 'keyevent', String(code)]);
        return json(res, 200, { ok: true });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`phone-control listening on http://${HOST}:${PORT}`);
  console.log(`adb: ${ADB}  (override with --adb <path> or ADB env)`);
  if (HOST === '0.0.0.0') console.log('WARNING: bound to LAN (0.0.0.0). Anyone on your network can control the phone.');
});
