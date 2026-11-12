#!/bin/bash
# Run the finger test suites against THIS repo's server copy.
# The suites hardcode /tmp/ai-finger-test as their run dir (logs, fake-adb
# state), so this script copies the tests + fake-adb there first, then
# starts fresh servers from server/ in this repo and runs each suite.
# Usage: bash tests/run-all.sh   (from the repo root, or anywhere)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$REPO/server"
TEST_RUN=/tmp/ai-finger-test

mkdir -p "$TEST_RUN"
cp "$REPO/tests/test-ai-finger.js" "$REPO/tests/test-closed-loop.js" \
   "$REPO/tests/test-finger-lock.js" "$REPO/tests/test-lock-audit.js" \
   "$REPO/tests/fake-adb" "$REPO/tests/page-js.js" "$TEST_RUN/"
chmod +x "$TEST_RUN/fake-adb"

cd "$SERVER_DIR" || exit 1
start_servers() {
  node server.js --port 8099 --adb "$TEST_RUN/fake-adb" > "$TEST_RUN/server-8099.log" 2>&1 &
  echo $! > "$TEST_RUN/pid-8099"
  node server.js --port 8098 --adb /bin/true > "$TEST_RUN/server-8098.log" 2>&1 &
  echo $! > "$TEST_RUN/pid-8098"
  for i in $(seq 1 20); do
    curl -s -o /dev/null http://127.0.0.1:8099/api/devices && curl -s -o /dev/null http://127.0.0.1:8098/api/devices && return 0
    sleep 0.25
  done
  echo "servers did not come up"; return 1
}
stop_servers() {
  kill $(cat "$TEST_RUN/pid-8099") $(cat "$TEST_RUN/pid-8098") 2>/dev/null
  sleep 0.5
}
for suite in test-ai-finger.js test-closed-loop.js test-finger-lock.js test-lock-audit.js; do
  echo "===== $suite (fresh servers) ====="
  start_servers || exit 1
  # The lock-audit suite reads the control page from PAGE_PATH. Point it at
  # THIS repo's server/index.html (its __dirname fallback would resolve
  # against the /tmp copy, not the repo — see tests/README.md).
  PAGE_PATH="$SERVER_DIR/index.html" node "$TEST_RUN/$suite"
  rc=$?
  stop_servers
  echo "----- $suite exit=$rc -----"
  [ $rc -ne 0 ] && echo "SUITE FAILED: $suite"
done
echo "ALL DONE"
