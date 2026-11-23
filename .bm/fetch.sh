#!/usr/bin/env bash
# fetch.sh <out-dir>: released installers from the public CDN, plus a probe
# of version-pinned URLs for older releases.
set -uo pipefail
out=$1
mkdir -p "$out"
cdn=https://cdn.crabnebula.app/download/cap/cap
get() { # <url> <file>
  for attempt in 1 2 3 4; do
    code=$(curl -sSL -o "$2" -w '%{http_code}' "$1")
    [[ $code == 200 ]] && return 0
    echo "  $1 -> $code (attempt $attempt)"
    sleep $((attempt * 20))
  done
  rm -f "$2"
  return 1
}
get "$cdn/latest/platform/dmg-aarch64" "$out/latest-mac.dmg"
get "$cdn/latest/platform/nsis-x86_64" "$out/latest-win.exe"
get "$cdn/latest/platform/deb-x86_64" "$out/latest-linux.deb"
for v in 0.6.1 0.6.2; do
  for path in "$v/platform/deb-x86_64" "v$v/platform/deb-x86_64" "$v/deb-x86_64" "cap-v$v/platform/deb-x86_64"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -I "$cdn/$path")
    echo "probe $path -> $code"
    if [[ $code == 200 || $code == 302 ]]; then
      p=${path%/deb-x86_64}
      get "$cdn/$p/deb-x86_64" "$out/$v-linux.deb"
      get "$cdn/$p/nsis-x86_64" "$out/$v-win.exe"
      get "$cdn/$p/dmg-aarch64" "$out/$v-mac.dmg"
      break
    fi
  done
done
curl -s "https://cdn.crabnebula.app/update/cap/cap/linux-x86_64-deb/0.6.0" | head -c 400; echo
ls -la "$out"
dpkg-deb -f "$out/latest-linux.deb" Version Package 2>/dev/null || true
for f in "$out"/*-linux.deb; do echo "$f $(dpkg-deb -f "$f" Version)"; done
