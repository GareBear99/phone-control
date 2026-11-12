# phone-control

The app that lets **Muse control a phone with a finger** — through the
app, not through Lucid.

## The vision (Gary, 2026-11-06)

Build a phone app so Muse can control the phone **from the Muse app on
the phone, through the app we create, with the finger on that phone** —
reticle, tap/hold, closed-loop verification, lock — and even control
other synced devices if needed, with pair/sharing locks for each device.

- **Muse in the Muse app on the phone** drives the finger through this
  app. The app is the finger's home on the phone.
- **Separate from Lucid.** Lucid keeps its own finger pair (the Devices
  plugin / finger in Lucid), but this app has *no relevance to Lucid in
  theory* — a separate system. Do not wire Lucid into this repo.
- **Distribution:** the app's download lives under **Add-ons > Apps**
  (an Apps area in the Add-ons section), and the source lives here, on
  GitHub.

## What's in this repo

| Path | What it is |
|---|---|
| `server/` | The finger as it exists today: a Node.js stdlib-only server + control page that drives a phone/emulator over `adb`. The working reference implementation the native app replaces on the phone. |
| `server/server.js` | The server: device selection, screen polling, tap/reticle/hold/swipe/text/key, closed-loop verification, per-device finger lock. |
| `server/index.html` | The control page: screen, reticle, lock toggle, keys. |
| `server/start-emu-phone.sh` | Boot the Pixel emulator (API 35) and start the server on 8090. |
| `tests/` | Four suites against a fake adb — 159 checks, 0 failed (verified 2026-11-12). See `tests/README.md`. |
| `android/` | The native phone app — **not built yet**. Placeholder + plan. See `android/README.md`. |

## The finger (one per device)

Each phone or emulator controlled has its own AI finger: a reticle (a
visible crosshair, cyan; amber while holding) drawn over the screen at
the finger's position, plus the intelligence that drives it. Per-device
state, keyed by serial — switching devices shows that device's own
finger; a device never positioned starts at screen centre.

**Gary's rule: the finger never trusts "sent" — it reads the relay back,
visually.** After every action the finger waits for a frame captured
*after* the action and compares fingerprints (SHA-256 of the PNG, first
12 hex). Same hash = the screen did not change. A changed hash proves
the screen changed, not that the *right* thing changed — judging what
changed is the AI's job, from the frames themselves, visually. A tap
whose post-action capture fails returns `{ok: false}` — never `{ok:
true}` on a dead device.

## Pair / sharing locks (one per device)

Every device has a **disable lock toggle** for its finger — a per-device
safety switch, like a kill switch for that finger. `POST /api/finger-lock
{locked: true}` locks the finger on the selected device. When locked,
the finger **cannot act on that device at all**: every input endpoint
answers HTTP 423 and runs **no adb command**; the reticle does not move.
Read-only routes (`/api/devices`, `/api/status`, `/api/frame`) are never
blocked — seeing the screen is fine, only acting is locked. The lock
toggle itself is always usable, even when locked — it is the way back
out. While locked, the closed-loop verification is also off (no forced
fresh frame, no hash comparison) — the extra knowing is off, so latency
softens. Full detail is in the old working copy's README
(`~/workspace/phone-control/README.md`, the "Finger lock" section) and
in `tests/` — the lock/latency guards (optimistic local lock, inputs
wait for the lock to settle bounded 1 s, stale polls can't overwrite
the lock, rapid toggles/switches can't land out of order). This README
is the summary; that one is the reference until it is folded in.

## Groups — permission-bound phone groups (Gary, 2026-11-12)

On top of the pair system, phones group into **permission-bound
groups**:

- A phone can **only see the phones within its group** — visibility is
  group-scoped. You don't see phones outside your group at all.
- **Outbound sharing is toggleable per phone** — each phone chooses
  whether it shares to all (in the group) or not. The choice sits on
  the outbound side.
- That is what makes it easy: group-scoped visibility + a per-phone
  outbound toggle, no per-phone-pair bookkeeping.

Groups are a **design, not code yet** — nothing in `server/` implements
them. They belong to the phone app (this repo), not to Lucid, and not
to Lucid-Mouse (whose Android finger is Lucid's scrcpy pointer, a
different mechanism). When the app build starts, groups are part of it.

## Run the server (on the Mac)

```bash
cd server
node server.js              # binds http://127.0.0.1:8090
```

Then open **http://127.0.0.1:8090** in a browser. The server finds adb
at `~/Library/Android/sdk/platform-tools/adb` on macOS by default
(`--adb` to override, `--port` for another port, `--lan` to bind
0.0.0.0 — localhost is the default; do NOT expose it to the internet).

Or boot the emulator and start everything at once:

```bash
bash server/start-emu-phone.sh
```

## Limits (v1, server)

- Screen is polled screenshots, ~3 fps, not video. Fine for tapping
  around and typing; not smooth enough for games or video. v2 idea:
  [scrcpy](https://github.com/Genymobile/scrcpy) — real-time video plus
  native mouse/keyboard forwarding.
- One frame capture at a time; a slow device just means a slower refresh.
- `input text` can't type newlines or most unicode reliably — an `adb`
  limitation, not this app.
- Physical phone needs USB debugging enabled and the "allow USB
  debugging" prompt accepted. If the phone never appears in `adb
  devices`, try a data cable (charge-only cables are the usual culprit),
  another port, and `adb kill-server && adb start-server`.

## Sequencing

The native app build starts **after the terminal work** (Gary,
2026-11-06). This repo is the scaffold now: the finger's home, the
verified server, the groups design, and the room for the app. Nothing
here claims the native app exists — `android/` is a placeholder until
the build starts.
