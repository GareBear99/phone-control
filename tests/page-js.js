const $ = id => document.getElementById(id);
const screen = $('screen'), statusEl = $('status'), devSel = $('device'), nodata = $('nodata');
let deviceSize = null;   // {w,h} of the selected device
let reticle = null;      // {x,y} AI finger position, device coords
let selected = null;
let fingerLocked = false; // per-device finger lock, from /api/status
let frameTimer = null;
// Lock/latency guards (audit 2026-11-06): the lock state the page enforces
// must never lag or contradict the server because of polling delay, an
// in-flight request, or a slow network.
// - lockSeq: increments on every toggle click; a toggle response only
//   applies if it is still the latest toggle (rapid toggles cannot land
//   out of order and leave the page in the wrong state).
// - lockPromise: the in-flight lock POST, if any. Input handlers wait for
//   it to settle (bounded) so unlock-then-tap does not race the unlock
//   POST to the server and get lost to a 423.
// - stateVersion: increments on every local finger/lock change (toggle,
//   tap, reticle move, device switch). A status poll that started before
//   the latest change is stale and must not overwrite the state.
// - statusSeq: increments on every status poll; only the newest poll's
//   response applies (overlapping polls cannot land out of order).
// - selectSeq: increments on every device switch; only the newest switch
//   applies (rapid switching cannot leave the wrong device's state).
let lockSeq = 0;
let lockPromise = null;
let stateVersion = 0;
let statusSeq = 0;
let selectSeq = 0;

async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

// Wait for an in-flight lock POST to settle before acting, so an input
// fired right after unlock does not race the unlock POST to the server
// and get lost to a 423, and an input fired right after lock is refused
// only after the lock has landed. Bounded: if the lock POST hangs, the
// input proceeds after 1 s on the local (optimistic) state, and the
// server is the final authority — it 423s anything it still counts as
// locked.
function waitForLockSettle() {
  if (!lockPromise) return Promise.resolve();
  const done = lockPromise.then(() => {}, () => {});
  return Promise.race([done, new Promise(r => setTimeout(r, 1000))]);
}

async function refreshDevices() {
  try {
    const { devices, selected: sel } = await api('/api/devices');
    selected = sel;
    const cur = devSel.value;
    devSel.innerHTML = devices.length
      ? devices.map(d => `<option value="${d.serial}">${d.serial} (${d.state})</option>`).join('')
      : '<option value="">— none —</option>';
    devSel.value = sel || (devices[0] && devices[0].serial) || '';
    if (sel) devSel.value = sel;
    else if (cur && devices.some(d => d.serial === cur)) devSel.value = cur;
    updateStatus(devices);
  } catch (e) { setStatus('server error: ' + e.message, true); }
}

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? 'err' : '';
}

async function updateStatus(devices) {
  const mySeq = ++statusSeq;
  const v = stateVersion;
  try {
    const s = await api('/api/status');
    // Stale poll? A newer status poll superseded this one, or a local
    // finger/lock change landed while this poll was in flight (a toggle,
    // a tap, a device switch). Either way this response predates the
    // current state — do not let it overwrite the lock, the reticle, or
    // the checkbox. The next poll brings fresh state.
    if (mySeq !== statusSeq) return;
    if (v !== stateVersion) return;
    deviceSize = s.size;
    reticle = s.reticle || null;
    fingerLocked = !!s.fingerLocked;
    applyLockUI();
    positionReticle();
    updateFingerPos();
    if (!s.selected) {
      setStatus(devices && devices.length ? 'device offline — pick one above' : 'no devices found (adb devices is empty)', true);
      screen.classList.add('off'); nodata.style.display = 'flex';
    } else {
      const age = s.frameAgeMs, hash = s.frameHash;
      let frameTxt = '';
      if (age != null) {
        frameTxt = `frame ${hash ? hash.slice(0, 8) + ' · ' : ''}${(age / 1000).toFixed(1)}s old`;
        if (age > 2000) frameTxt = '⚠ STALE ' + frameTxt + ' — device may be disconnected';
      }
      setStatus(`● ${s.selected}  ${s.size ? s.size.w + '×' + s.size.h : ''}  ${frameTxt}`, age != null && age > 2000);
      screen.classList.remove('off'); nodata.style.display = 'none';
    }
  } catch (e) { setStatus('status error: ' + e.message, true); }
}

// Finger lock UI: the toggle itself always stays usable (it is the way back
// out of locked). When locked, every input control is disabled/greyed and
// the reticle shows locked (grey/red) — the finger cannot act. The verify
// machinery is also off while locked: a locked device has no actions, so
// there is nothing to verify, and the extra knowing is switched off —
// latency softens. (The refresh handler below also drops the forced fresh
// frame while locked.)
function applyLockUI() {
  $('lockToggle').checked = fingerLocked;
  $('lockRow').classList.toggle('locked', fingerLocked);
  document.querySelectorAll('[data-key]').forEach(b => { b.disabled = fingerLocked; });
  $('text').disabled = fingerLocked;
  $('sendText').disabled = fingerLocked;
  $('holdMs').disabled = fingerLocked;
  $('holdBtn').disabled = fingerLocked;
  $('reticle').classList.toggle('locked', fingerLocked);
  // A locked finger has no actions, so any verify result on the line is
  // from before the lock — it must not linger and look like it belongs to
  // the locked state. Clear it when the lock lands; it stays empty until
  // the next action after unlocking.
  if (fingerLocked) { const vl = $('verifyLine'); vl.textContent = ''; vl.style.color = ''; }
}

function pollFrame(fresh) {
  if (!selected) return;
  // cache-bust so the browser never serves a stale frame
  screen.src = '/api/frame?' + (fresh ? 'fresh=1&' : '') + 't=' + Date.now();
}
screen.addEventListener('error', () => { /* transient: next poll retries */ });

// --- pointer: click = tap, drag = swipe ------------------------------------
let drag = null;
function toDevice(e) {
  const r = screen.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (!deviceSize) return null;
  return { x: Math.round(fx * deviceSize.w), y: Math.round(fy * deviceSize.h) };
}
screen.addEventListener('pointerdown', e => { drag = { start: toDevice(e), moved: false }; screen.setPointerCapture(e.pointerId); });
screen.addEventListener('pointermove', e => { if (drag && drag.start) drag.moved = true; });
screen.addEventListener('pointerup', async e => {
  if (!drag) return;
  const end = toDevice(e);
  const start = drag.start; drag = null;
  if (!start || !end || !selected) return;
  // Wait for any in-flight lock POST to settle first (bounded), then judge
  // by the local lock state: a tap fired right after lock is refused once
  // the lock has landed, and a tap fired right after unlock goes through
  // once the unlock has landed — neither is lost to the race.
  await waitForLockSettle();
  // Locked: the finger cannot act — no tap, no swipe. (The server also
  // refuses with 423; this guard keeps the click from doing anything.)
  if (fingerLocked) { setStatus('finger is locked for this device — unlock it to act', true); return; }
  try {
    if (!e.target) return;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    if (moved < 10) {
      const r = await api('/api/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: end.x, y: end.y }) });
      reticle = r.reticle || { x: end.x, y: end.y }; stateVersion++; positionReticle(); updateFingerPos();
      showVerify(r.verify);
    }
    else {
      const r = await api('/api/swipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: 300 }) });
      showVerify(r.verify);
    }
    pollFrame();
  } catch (err) { setStatus('input failed: ' + err.message, true); }
});

// --- AI finger reticle ------------------------------------------------------
function positionReticle() {
  const el = $('reticle');
  if (!reticle || !deviceSize) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = (reticle.x / deviceSize.w * 100) + '%';
  el.style.top = (reticle.y / deviceSize.h * 100) + '%';
}
function updateFingerPos() {
  $('fingerPos').textContent = reticle
    ? `AI finger: ${reticle.x}, ${reticle.y}${fingerLocked ? ' — LOCKED' : ''}`
    : 'AI finger: —';
}
// Closed loop, shown on the page: did the screen actually change after the
// action? The server compares the frame fingerprint before and after the
// action; "sent" is not evidence, the screen is.
function showVerify(v) {
  const el = $('verifyLine');
  if (!v) { el.textContent = ''; return; }
  const short = h => h ? h.slice(0, 8) : '—';
  if (!v.verified) { el.textContent = '✗ not verified: ' + (v.reason || 'no fresh frame'); el.style.color = '#f99'; return; }
  if (v.changed === true) { el.textContent = `✓ screen changed ${short(v.before && v.before.hash)} → ${short(v.after && v.after.hash)}`; el.style.color = '#9fd'; }
  else if (v.changed === false) { el.textContent = `○ screen unchanged ${short(v.after && v.after.hash)}`; el.style.color = '#fbbf24'; }
  else { el.textContent = 'screen present after action — no earlier frame to compare'; el.style.color = '#9fd'; }
}
// Right-click moves the finger without tapping — not while locked.
screen.addEventListener('contextmenu', async e => {
  e.preventDefault();
  const p = toDevice(e);
  if (!p || !selected) return;
  await waitForLockSettle();
  if (fingerLocked) { setStatus('finger is locked for this device — unlock it to act', true); return; }
  try {
    const r = await api('/api/reticle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: p.x, y: p.y }) });
    reticle = r.reticle; stateVersion++; positionReticle(); updateFingerPos();
  } catch (err) { setStatus('reticle failed: ' + err.message, true); }
});
$('holdBtn').addEventListener('click', async () => {
  await waitForLockSettle();
  if (fingerLocked) { setStatus('finger is locked for this device — unlock it to act', true); return; }
  if (!reticle || !selected) { setStatus('no finger position yet — tap the screen first', true); return; }
  const duration = Number($('holdMs').value);
  const el = $('reticle');
  el.classList.add('holding');
  try {
    const r = await api('/api/hold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: reticle.x, y: reticle.y, duration }) });
    showVerify(r.verify);
    pollFrame();
  } catch (err) { setStatus('hold failed: ' + err.message, true); }
  finally { el.classList.remove('holding'); }
});

// The lock toggle: always usable, even when locked — it is the way back
// out. The lock applies OPTIMISTICALLY, from the moment the user clicks:
// the finger stops acting before the round trip, so no tap can slip
// through the gap between the click and the server processing the lock.
// The server is reconciled afterwards; on failure the checkbox reverts
// to the pre-click state. A toggle response only applies if it is still
// the latest toggle and the selected device is still the one that was
// locked — a rapid toggle that superseded it, or a device switch in
// between, makes the response stale.
$('lockToggle').addEventListener('change', () => {
  const locked = $('lockToggle').checked;
  const prevLocked = fingerLocked;
  const mySeq = ++lockSeq;
  fingerLocked = locked;
  stateVersion++;
  applyLockUI(); updateFingerPos();
  const p = (async () => {
    try {
      const r = await api('/api/finger-lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked }) });
      if (mySeq === lockSeq && selected === r.serial) {
        fingerLocked = r.locked;
        stateVersion++;
        applyLockUI(); updateFingerPos();
      }
      setStatus(`finger ${r.locked ? 'locked' : 'unlocked'} for ${r.serial}`, false);
    } catch (err) {
      // Revert only if no newer toggle superseded this one — otherwise
      // the newer toggle's optimistic state is the current one.
      if (mySeq === lockSeq) {
        fingerLocked = prevLocked;
        stateVersion++;
        applyLockUI(); updateFingerPos();
        $('lockToggle').checked = fingerLocked;
      }
      setStatus('lock failed: ' + err.message, true);
    }
  })();
  lockPromise = p;
  p.finally(() => { if (lockPromise === p) lockPromise = null; });
});

// --- keys, text, refresh ----------------------------------------------------
document.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', async () => {
  await waitForLockSettle();
  if (fingerLocked) { setStatus('finger is locked for this device — unlock it to act', true); return; }
  try { await api('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.key }) }); pollFrame(); }
  catch (err) { setStatus('key failed: ' + err.message, true); }
}));
async function sendText() {
  const v = $('text').value;
  if (!v) return;
  await waitForLockSettle();
  if (fingerLocked) { setStatus('finger is locked for this device — unlock it to act', true); return; }
  try { await api('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: v }) }); $('text').value = ''; pollFrame(); }
  catch (err) { setStatus('text failed: ' + err.message, true); }
}
$('sendText').addEventListener('click', sendText);
$('text').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
$('refreshBtn').addEventListener('click', () => {
  // Verification is off while locked: no forced fresh frame. A locked
  // device has no actions to verify, so the extra knowing is switched off
  // and the refresh is just a plain poll — latency softens. Seeing the
  // screen is never locked; only acting (and verifying actions) is.
  if (fingerLocked) pollFrame(); else pollFrame(true);
  updateStatus();
});
devSel.addEventListener('change', async () => {
  const mySeq = ++selectSeq;
  try {
    const r = await api('/api/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serial: devSel.value }) });
    // A newer switch superseded this one — do not apply this response.
    // (Without this, two rapid switches can land out of order and leave
    // the page showing the wrong device's lock and reticle.)
    if (mySeq !== selectSeq) return;
    selected = r.selected;
    stateVersion++; // the lock/reticle now belong to another device — invalidate any in-flight status poll
    pollFrame(); updateStatus();
  }
  catch (err) { setStatus('select failed: ' + err.message, true); refreshDevices(); }
});

// --- loops -------------------------------------------------------------------
(async function init() {
  await refreshDevices();
  frameTimer = setInterval(pollFrame, 350);
  setInterval(refreshDevices, 5000);   // pick up newly plugged-in devices
  pollFrame();
})();
