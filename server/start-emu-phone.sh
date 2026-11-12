#!/bin/bash
# start-emu-phone — boot the Pixel emulator, then start phone-control.
# Run:  bash ~/phone-control/start-emu-phone.sh
# Then open http://127.0.0.1:8090 in a browser on the Mac.
# The emulator is emulator-5554 (Pixel AVD, API 35, host GPU, 2048 MB).
# The server binds 127.0.0.1:8090 and controls it via adb (finger + lock).
set -u
EMU="$HOME/projects/emu-wrapper/emu"
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
PC="$(cd "$(dirname "$0")" && pwd)"   # this script lives in server/ — the server dir is its own directory

echo "== 1. emulator =="
"$EMU" start
echo "waiting for emulator-5554 (up to 180s; first boot is a cold boot, ~1-3 min)..."
ok=""
for i in $(seq 1 36); do
  if "$ADB" devices 2>/dev/null | grep -q "emulator-5554.*device"; then ok=1; break; fi
  sleep 5
done
if [ -z "$ok" ]; then echo "emulator-5554 did NOT come up — check: $EMU status"; exit 1; fi
echo "emulator-5554 is up"
"$ADB" -s emulator-5554 shell wm size

echo "== 2. phone-control server =="
cd "$PC" || exit 1
if curl -s -o /dev/null http://127.0.0.1:8090/api/devices; then
  echo "phone-control already running on 8090"
else
  nohup node server.js > /tmp/phone-control.log 2>&1 &
  echo "server pid $!"
  for i in $(seq 1 20); do
    curl -s -o /dev/null http://127.0.0.1:8090/api/devices && break
    sleep 0.5
  done
fi
echo "== devices (via the server) =="
curl -s http://127.0.0.1:8090/api/devices; echo
echo "open http://127.0.0.1:8090"
echo "stop the emulator later with: $EMU stop"
echo "stop the server later with: pkill -f 'node server.js' (exact, or kill the pid above)"
