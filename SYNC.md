# SYNC — where this repo's code comes from, and what stays where

## The three copies

| Copy | Path | Role |
|---|---|---|
| **This repo (scaffold)** | `~/workspace/phone-app-repo/` (VM) → GitHub `GareBear99/phone-control` once created (see `MAC_STEPS.md`) | The repo. Source of truth once it is on GitHub. |
| **Working copy** | `~/workspace/phone-control/` (VM) | Where the code was built (2026-11-06). **Do not move, rename, or delete it.** It is the source this scaffold was copied from. |
| **Mac copy** | `/Users/gary/phone-control/` (Mac) | The live copy: the server runs from here, the emulator script points here, adb is at `~/Library/Android/sdk/platform-tools/adb`. |

## What was copied into this scaffold (2026-11-12)

From `~/workspace/phone-control/` (byte-identical, md5-verified):

- `server.js` → `server/server.js` (f79560b9…)
- `index.html` → `server/index.html` (5ddb513b…)
- `start-emu-phone.sh` → `server/start-emu-phone.sh` (one adaptation:
  `PC` now resolves to the script's own directory instead of
  `$HOME/phone-control`, so it works from the repo layout)

From `~/workspace/phone-control-harness/` (the verification suite):

- `test-ai-finger.js`, `test-closed-loop.js`, `test-finger-lock.js`,
  `test-lock-audit.js`, `fake-adb`, `page-js.js`, `index.html.orig` →
  `tests/`
- `run-all.sh` was **rewritten** for the repo layout (`tests/run-all.sh`):
  it resolves the repo root from its own location, starts the servers
  from `server/`, copies the suites into `/tmp/ai-finger-test` for
  their run dir, and sets `PAGE_PATH` to this repo's
  `server/index.html` for the lock-audit suite.

## Adaptations made in the scaffold (the only edits to copied code)

1. `server/start-emu-phone.sh`: `PC` path (above).
2. `tests/test-lock-audit.js`: `PAGE_PATH` now resolves relative to the
   test file (`path.join(__dirname, '..', 'server', 'index.html')`) with
   a `PAGE_PATH` env override. The upstream harness copy hardcoded
   `/home/hatch/workspace/phone-control/index.html`. **Caveat:** the
   suites are copied to `/tmp/ai-finger-test` for their run dir, so the
   `__dirname` fallback resolves to `/tmp/server/index.html` when run
   that way — `tests/run-all.sh` sets `PAGE_PATH` explicitly, so always
   run via `run-all.sh` (see `tests/README.md`).
3. `tests/run-all.sh`: rewritten for the repo layout (above).

Everything else in `server/` and `tests/` is byte-identical to its
source. The old working copy's long-form README (finger lock detail,
closed loop, limits) has **not** been folded into this repo's README
yet — this repo's README is the summary; the working copy's README is
still the reference for the lock detail. Fold it in when the repo goes
live, don't duplicate it now.

## State of the copied code (verified 2026-11-12)

- Finger system (reticle, tap/hold, closed loop) + per-device finger
  lock: **built and passing** — 159 checks, 0 failed (44 + 40 + 43 +
  32) against both the working copy and this scaffold's copy
  (`bash tests/run-all.sh`).
- The lock-audit suite is timing-sensitive and flaky under load (see
  `tests/README.md`): it failed twice against the unchanged original
  harness and passed three times against this scaffold. Re-run before
  treating a single audit failure as a regression.
- The Mac copy was **not** touched by this scaffold and was **not**
  compared — the Mac is busy with the Lucid live deploy + integrity
  run. The Mac-side steps in `MAC_STEPS.md` include diffing the Mac
  copy against this scaffold before pushing.

## Sync rule (going forward)

Once the repo is on GitHub, the repo is the source of truth: edit in
the repo → run `bash tests/run-all.sh` green → commit → push → pull
into the Mac copy. Never let the Mac copy drift from the repo
unrecorded. The working copy (`~/workspace/phone-control/`) is retired
as a source once the repo is live — keep it until the Mac copy is
verified against the repo, then it can go.
