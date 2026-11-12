# Tests — finger verification suites

Four Node.js suites that run the server against a **fake adb** (no device
needed) and prove the finger system end to end. No dependencies — Node
stdlib only.

## Run

```bash
bash tests/run-all.sh
```

That copies the suites + `fake-adb` into `/tmp/ai-finger-test` (the run
dir the suites hardcode for logs and fake-adb state), starts fresh
servers from `server/` on ports 8099 (fake adb, two fake devices) and
8098 (`/bin/true`, no devices), runs each suite, and stops the servers.

## Suites (verified 2026-11-12: 159 passed, 0 failed)

| Suite | What it proves | Checks |
|---|---|---|
| `test-ai-finger.js` | Finger endpoints: reticle, tap, hold, swipe, text, key; per-device finger state | 44 |
| `test-closed-loop.js` | Closed loop: fresh frame after every action, frame fingerprints before/after, stale = reported, never `{ok: true}` on a dead device | 40 |
| `test-finger-lock.js` | Per-device finger lock: locked finger answers 423 on every input endpoint and runs no adb; read-only routes still work; lock is the way back out | 43 |
| `test-lock-audit.js` | Lock/latency guards: 423 ordering (lock check before `wm size`/screencap/input), optimistic local lock, inputs wait for the lock to settle (bounded 1 s), stale polls can't overwrite the lock, rapid toggles/switches can't land out of order, stale verify cleared on lock | 32 |

## Files

- `fake-adb` — fake adb binary for the suites. Logs input commands to
  `adb-commands.log` and every adb invocation to `adb-all.log`. Screencap
  returns a 1×1 PNG whose colour changes per capture (the screen
  "changes"); if `frozen` exists every capture returns the same PNG; if
  `fail-screencap` exists screencap exits 1 (device gone).
- `page-js.js` — the page's inline script, extracted for the audit suite's
  DOM shim (section 2, page latency races).
- `index.html.orig` — the control page as it stood before the finger-lock
  work (kept for reference; the live page is `server/index.html`).

## Notes

- **Run via `run-all.sh`, not by hand.** The suites are copied to
  `/tmp/ai-finger-test` for their run dir, and `run-all.sh` sets
  `PAGE_PATH` to this repo's `server/index.html` for the lock-audit
  suite. Run by hand from the wrong directory and the audit suite reads
  the wrong page (it used to hardcode the old working-copy path).
- **`test-lock-audit.js` is timing-sensitive.** Its section 2 races a DOM
  shim against timers, and it is flaky under load: on 2026-11-12 it
  passed 32/32, then failed twice in a row against the *unchanged*
  original harness (section E rapid-switch checks), then passed 32/32
  three times against this repo's copy — with `server.js` and
  `index.html` byte-identical in both cases. A single audit failure on a
  loaded machine is a timing flake until proven otherwise: re-run
  `run-all.sh` before treating it as a regression. The other three
  suites are stable (127 passed, 0 failed, every run).
