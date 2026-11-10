#!/usr/bin/env bash
# Usage: mac_permissions.sh <cap-gpui>
# Blacksmith's macOS runners start with the display asleep, no audio device
# and no Screen Recording grant. This is the setup step of
# instant-reliability.yml, for the app binary given and the processes the
# scenario runs under.
set -euo pipefail
app=$1
sudo pmset -a displaysleep 0 sleep 0 disksleep 0
caffeinate -u -t 2
nohup caffeinate -dimsu > /dev/null 2>&1 &
brew install --cask blackhole-2ch
brew install switchaudio-osx cliclick
sudo killall coreaudiod || true
for _ in $(seq 1 30); do
  SwitchAudioSource -a -t output | grep -qx "BlackHole 2ch" && break
  sleep 1
done
SwitchAudioSource -s "BlackHole 2ch" -t output
SwitchAudioSource -s "BlackHole 2ch" -t input
{
  echo "$app"
  python3 -c 'import os, sys; print(os.path.realpath(sys.executable))'
  echo /usr/sbin/screencapture
  command -v cliclick
} > "$RUNNER_TEMP/capture-binaries"
p=$$
while [ "$p" -gt 1 ]; do
  ps -o comm= -p "$p"
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done >> "$RUNNER_TEMP/capture-binaries"
db="/Library/Application Support/com.apple.TCC/TCC.db"
user_db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
approvals="$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
mkdir -p "$(dirname "$approvals")"
now=$(date +%s)
until=$(date -u -v+1y '+%a %b %d %H:%M:%S GMT %Y')
sort -u "$RUNNER_TEMP/capture-binaries" | grep '^/' | while read -r client; do
  for service in kTCCServiceScreenCapture kTCCServiceMicrophone kTCCServiceAccessibility kTCCServicePostEvent; do
    row="INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,flags,last_modified) VALUES ('$service','$client',1,2,4,1,'UNUSED',0,$now);"
    sudo sqlite3 "$db" "$row"
    sqlite3 "$user_db" "$row" || true
  done
  /usr/libexec/PlistBuddy -c "Add :$client date $until" "$approvals" >/dev/null 2>&1 || true
  echo "granted $client"
done
killall tccd || true
sudo killall tccd || true
sleep 2
