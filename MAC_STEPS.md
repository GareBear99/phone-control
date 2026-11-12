# Mac-side steps — create the repo + push the scaffold

Do these on the **Mac** (the VM has no GitHub auth; the Mac has the
token at `/Users/gary/projects/github-token.txt`). Wait for a Mac-free
window — the Lucid live deploy + integrity run are on the Mac now.

## 1. Copy the scaffold to the Mac

The scaffold lives in the VM at `~/workspace/phone-app-repo/`. Get it to
the Mac the usual way for this setup (same route as the other repo
scaffolds — e.g. the transfer used for Lucid bundles; do not invent a
new route). Target: `/Users/gary/phone-app-repo/`.

Verify the copy on arrival:

```bash
cd /Users/gary/phone-app-repo
find . -type f | sort
md5 server/server.js server/index.html
# expect server.js f79560b9639192d079bd64eebc324497
# expect index.html 5ddb513b2315e5455c1fd83ab7813709
bash tests/run-all.sh   # expect 159 passed, 0 failed (see tests/README.md on audit flakiness)
```

## 2. Diff the Mac live copy against the scaffold (before pushing)

```bash
diff -r /Users/gary/phone-control/server.js /Users/gary/phone-app-repo/server/server.js
diff -r /Users/gary/phone-control/index.html /Users/gary/phone-app-repo/server/index.html
```

- If identical: the Mac copy is the same code — proceed.
- If different: **stop and report the diff** — the Mac copy may have
  changes the VM never saw. Do not overwrite the Mac copy silently and
  do not push a scaffold that drops live changes. Fold the Mac-side
  changes into the scaffold first, re-run the tests, then proceed.

## 3. Create the GitHub repo

- **Name: `phone-control`** — the natural name: it matches the working
  directory (`~/phone-control`, `/Users/gary/phone-control/`) and the
  code's own name since 2026-11-06. Checked 2026-11-12: no public repo
  `GareBear99/phone-control` exists (API 404 + `git ls-remote` fails
  the way a missing public repo fails; the same check cleared
  `phone-app`, `muse-phone-control`, `android-phone-control`,
  `lucid-phone-control`, `finger-control` — none exist either).
- **Visibility: public** — the app's download lives in Add-ons > Apps
  and the source is public by Gary's plan.
- **Owner: GareBear99.** Do not create it under any other account.
- Create it **empty** (no README/license/.gitignore from GitHub's
  templates — the scaffold already has its own files). Do not create a
  duplicate if one appears in the meantime — re-check
  `https://github.com/GareBear99/phone-control` first.

## 4. Init, commit, push

From `/Users/gary/phone-app-repo/`:

```bash
git init -b main
git add .
git commit -m "phone-control: repo scaffold — finger server + tests + Android app room

Muse phone-control app repo (Gary 2026-11-12): the finger server
(Node + adb, per-device finger lock, 159 checks green) and room for
the native Android app. Vision, locks, and permission-bound groups
in README.md."
git remote add origin https://github.com/GareBear99/phone-control.git
git push -u origin main
```

Then verify: `git ls-remote https://github.com/GareBear99/phone-control.git HEAD`
shows the pushed commit, and the repo page loads at
https://github.com/GareBear99/phone-control.

## 5. Point the Mac live copy at the repo

After the push, the Mac copy `/Users/gary/phone-control/` is the
*deployment* of the repo, not a separate source. Either:

- (a) replace it with a fresh clone of the repo (cleanest), re-checking
  `server/start-emu-phone.sh` still boots the emulator and the server
  still answers on 8090; or
- (b) leave it in place and record the divergence risk in `SYNC.md`.

Option (a) is preferred. Whichever is done, run `bash tests/run-all.sh`
from the repo afterwards and confirm 159 passed, 0 failed.

## 6. Do NOT do yet

- Do not build the native Android app — that starts after the terminal
  work (Gary, 2026-11-06). `android/` stays a placeholder.
- Do not implement groups in code — groups are a design in the README,
  not built yet.
- Do not touch Lucid or Lucid-Mouse — this repo is separate from Lucid
  by Gary's rule.
