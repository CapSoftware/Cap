#!/usr/bin/env bash
# Host side: one fresh desktop container, one Cap package, one scenario.
# Usage: run-desktop.sh <gnome|hyprland|niri|sway> <package.deb|.AppImage|any file with DEV_BIN> <out-dir> [ENV=VALUE...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desktop=$1
package=$(realpath "$2")
out=$(realpath -m "$3")
shift 3
extra_env=()
case "$desktop" in
  gnome) image=cap-harness-gnome dockerfile=gnome.Dockerfile up=gnome-up.sh ;;
  # Mesa 26.2's device_select Vulkan layer segfaults in vkEnumeratePhysicalDevices
  # on the vgem/vkms faux devices this harness renders with; real GPUs are not
  # affected, so the harness (not Cap) turns that layer off.
  hyprland|niri|sway) image=cap-harness-arch dockerfile=arch.Dockerfile up=arch-up.sh extra_env=(-e VK_LOADER_LAYERS_DISABLE=VK_LAYER_MESA_device_select) ;;
  *) echo "unknown desktop $desktop" >&2; exit 2 ;;
esac
name=cap-$desktop-$$
[[ -d "$out" ]] && find "$out" -mindepth 1 -delete
mkdir -p "$out" && chmod 777 "$out"
docker build -q -f "$here/$dockerfile" -t "$image" "$here" >/dev/null
# DEV_BIN=<path to a built cap-gpui> with DEV_LIBS=<its FFmpeg lib dir> runs a
# local build in place of the packaged binary (the package still provides the
# desktop file and dependencies).
dev_mounts=()
if [[ -n "${DEV_BIN:-}" ]]; then
  dev_mounts=(-v "$(realpath "$DEV_BIN")":/dev-bin/cap-gpui:ro -v "$(realpath "${DEV_LIBS:?set DEV_LIBS}")":/dev-libs:ro)
fi
docker run -d --name "$name" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$package":/pkgs/"$(basename "$package")":ro -v "$here":/harness:ro -v "$out":/out \
  "${dev_mounts[@]}" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT
for _ in $(seq 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  [[ $state == running || $state == degraded ]] && break
  sleep 1
done
# The host's render and KMS node groups do not map into the image, so give the
# test user the access a seat grants it on a real machine.
docker exec "$name" sh -c 'chmod 666 /dev/dri/* 2>/dev/null || true'
envs=(-e HARNESS_OUT=/out -e DESKTOP="$desktop" "${extra_env[@]}")
case "$package" in
  *.deb) if [[ $desktop == gnome ]]; then
           docker exec "$name" apt-get install -y -qq "/pkgs/$(basename "$package")" >"$out/install.log" 2>&1
         elif [[ -z "${DEV_BIN:-}" ]]; then
           echo "a .deb needs the gnome image; pass an AppImage or DEV_BIN for $desktop" >&2
           exit 2
         fi ;;
  *.AppImage)
    docker exec "$name" install -m 755 "/pkgs/$(basename "$package")" /opt/Cap.AppImage
    envs+=(-e CAP_BIN=/opt/Cap.AppImage -e APPIMAGE_EXTRACT_AND_RUN=1)
    ;;
  *) [[ -n "${DEV_BIN:-}" ]] || { echo "unknown package type" >&2; exit 2; } ;;
esac
if [[ -n "${DEV_BIN:-}" ]]; then
  envs+=(-e CAP_BIN=/dev-bin/cap-gpui -e LD_LIBRARY_PATH=/dev-libs)
fi
for kv in "$@"; do envs+=(-e "$kv"); done
docker exec -u tester "${envs[@]}" "$name" bash "/harness/$up"
docker exec -u tester "${envs[@]}" "$name" bash /harness/scenario-start-stop.sh
if [[ -n "${KEEP_CONTAINER:-}" ]]; then
  trap - EXIT
  echo "kept container $name"
fi
