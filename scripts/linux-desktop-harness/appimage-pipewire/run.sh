#!/usr/bin/env bash
# The AppImage's libraries against a NixOS PipeWire (GitHub #2941): a stand-in
# for Cap that links the bundled FFmpeg connects a screen-capture stream
# inside NixOS's appimage-run, once with the AppDir as shipped and once laid
# out by scripts/finalize-linux-appimage.mjs. Prints key=value results.
# Usage: run.sh <Cap.AppImage> <out-dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
appimage=$(realpath "$1")
out=$(realpath -m "$2")
mkdir -p "$out"
work=$(mktemp -d)
trap 'chmod -R u+w "$work" 2>/dev/null; find "$work" -mindepth 1 -delete 2>/dev/null' EXIT
cd "$work"
cp "$appimage" Cap.AppImage
chmod +x Cap.AppImage
./Cap.AppImage --appimage-extract >/dev/null
chmod -R a+rX squashfs-root

# Built like Cap: a host-ABI binary (Ubuntu's toolchain) that finds the
# bundled FFmpeg through RUNPATH $ORIGIN/../lib.
docker run --rm -v "$here":/src:ro -v "$work":/work -w /work ubuntu:24.04 bash -euc '
  apt-get update -qq >/dev/null && apt-get install -y -qq gcc pkg-config libpipewire-0.3-dev >/dev/null
  gcc -o probe /src/probe.c $(pkg-config --cflags --libs libpipewire-0.3) \
    -L squashfs-root/usr/lib -l:libavutil.so.59 -Wl,--allow-shlib-undefined -Wl,-rpath,"\$ORIGIN/../lib"
  chmod 755 probe'

cp -a squashfs-root shipped
cp -a squashfs-root fixed
# The fixed layout is what scripts/finalize-linux-appimage.mjs ships: the
# direct launcher and the pinned fallback libva (CAP_APPIMAGE_LIBVA_DIR to
# use another).
mkdir -p libva-work
FINALIZE="$repo/scripts/finalize-linux-appimage.mjs" APPDIR_FIXED="$work/fixed" LIBVA_WORK="$work/libva-work" \
  node --input-type=module -e '
  const { isolateBundledLibva, directAppRunWrapper, fallbackLibvaDirectory } = await import(process.env.FINALIZE);
  const { writeFile } = await import("node:fs/promises");
  const replacement = await fallbackLibvaDirectory(process.env.LIBVA_WORK);
  const moved = await isolateBundledLibva(process.env.APPDIR_FIXED, { replacement });
  await writeFile(process.env.APPDIR_FIXED + "/AppRun", directAppRunWrapper, { mode: 0o755 });
  console.log("moved " + moved.join(" ") + "; fallback from " + replacement);
'
for layout in shipped fixed; do
  install -m 755 probe "$layout/usr/bin/Cap"
done
chmod -R a+rX "$work"
# appimage-run takes AppImage files: the original runtime and each layout
# packed the way the original was.
offset=$(./Cap.AppImage --appimage-offset)
head -c "$offset" Cap.AppImage >runtime
docker run --rm -v "$work":/work -w /work ubuntu:24.04 bash -euc '
  apt-get update -qq >/dev/null && apt-get install -y -qq squashfs-tools >/dev/null
  for layout in shipped fixed; do
    mksquashfs "$layout" "$layout.squashfs" -root-owned -noappend -comp zstd -quiet >/dev/null
    cat runtime "$layout.squashfs" >"$layout.AppImage"
    chmod 755 "$layout.AppImage"
  done'

docker run --rm --privileged -e PIPEWIRE_DEBUG -e SHOW_LINES -v "$work":/work:ro nixos/nix:latest bash -c '
  export NIX_CONFIG="experimental-features = nix-command flakes
sandbox = false
filter-syscalls = false"
  export XDG_RUNTIME_DIR=/tmp/xdg
  mkdir -p $XDG_RUNTIME_DIR && chmod 700 $XDG_RUNTIME_DIR
  nix build -o /tmp/pipewire nixpkgs#pipewire nixpkgs#appimage-run >/dev/null 2>&1
  /tmp/pipewire/bin/pipewire >/tmp/pipewire.log 2>&1 &
  sleep 4
  run=$(ls -d /nix/store/*-appimage-run*/bin/appimage-run | head -1)
  echo "versions $(/tmp/pipewire/bin/pipewire --version | tail -1)"
  for layout in shipped fixed; do
    echo "== $layout"
    PIPEWIRE_DEBUG=${PIPEWIRE_DEBUG:-1} "$run" /work/$layout.AppImage >/tmp/$layout.log 2>&1
    status=$?
    grep -v "rtkit\|=====\|Uncompress\|is now installed" /tmp/$layout.log | tail -${SHOW_LINES:-40}
    echo "exit $layout=$status"
  done
' 2>&1 | tee "$out/appimage-pipewire.log"
result() { printf '%s=%s\n' "$1" "$2" >>"$out/result.txt"; }
: >"$out/result.txt"
for layout in shipped fixed; do
  if grep -q "^exit $layout=0" "$out/appimage-pipewire.log"; then
    result "${layout}_connects" yes
  else
    result "${layout}_connects" no
  fi
  # What a program Cap starts (a file manager through xdg-open) inherits:
  # any bundle library directory other than the libva fallback leaks Cap's
  # libraries into it, which is why folders did not open on NixOS in 0.6.1.
  libraries=$(sed -n "/^== $layout\$/,/^exit $layout=/p" "$out/appimage-pipewire.log" | sed -n 's/^LD_LIBRARY_PATH=//p')
  if tr ':' '\n' <<<"$libraries" | grep '/appimage-run/' | grep -qv '/usr/lib/cap/libva$'; then
    result "${layout}_children_get_bundle_libraries" yes
  else
    result "${layout}_children_get_bundle_libraries" no
  fi
done
cat "$out/result.txt"
