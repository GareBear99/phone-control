# android/ — the native phone app (NOT BUILT YET)

This directory is where the **native Android app** will live — the app
Muse drives *through* on the phone, so Muse can control the phone with
the finger from inside the phone itself.

## What it will be

- A native Android app, installed on the phone, with the Muse app
  pre-installed + logged in beside it (Gary has that ready for testing).
- Muse (in the Muse app on the phone) controls the phone **through this
  app**, using the finger setup from `server/` — reticle, tap/hold,
  closed-loop verification, per-device lock — but routed through the app
  on the phone, **not** through Lucid and not through the Node server.
- It can also control **other synced devices** when paired, under the
  pair/sharing locks and the permission-bound groups (see the top-level
  README).

## What is here now

Nothing yet — this directory is a placeholder so the repo's shape says
the plan: `server/` is the finger as it exists today (Node + adb, the
working reference implementation), `android/` is the native app that
replaces the server as the finger's home on the phone.

## When it gets built

After the terminal work, per Gary (2026-11-06). The repo scaffold is the
step now; the app build is a later project, not this task. When the
build starts, Gary's specifics are still owed: how the app talks to
Muse on the phone, how devices pair/sync, and the exact lock mechanism
in the app.

## Test procedure (Gary, 2026-11-06 — do not do this early)

Test talking to the phone Muse ONLY when ready — by having the phone
Muse start a NEW CHAT, then WAIT FOR IT TO VERIFY; once it verifies,
the connection works. Then work on the app and LEAVE THE PHONE MUSE
ALONE until the app is ready to take control of the phone with a finger
easily. Do not test the phone Muse before being ready, and do not
disturb it after the verify test until the app is ready.
