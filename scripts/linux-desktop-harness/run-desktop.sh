#!/usr/bin/env bash
# Host side: one fresh desktop container, one Cap package, one scenario.
# Usage: run-desktop.sh <gnome|kde|hyprland|niri|sway> <package.deb|.AppImage|any file with DEV_BIN> <out-dir> [ENV=VALUE...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desktop=$1
package=$(realpath "$2")
out=$(realpath -m "$3")
shift 3
extra_env=()
# Mesa's device_select Vulkan layer segfaults in vkEnumeratePhysicalDevices on
# the vgem/vkms faux devices this harness renders with (Mesa 26.2 on Arch; on
# Ubuntu 26.04 it took down 4 of 16 GNOME screenshot runs and none of 16 with
# the layer off). Real GPUs are not affected, so the harness (not Cap) turns
# that layer off.
no_device_select=(-e VK_LOADER_LAYERS_DISABLE=VK_LAYER_MESA_device_select)
case "$desktop" in
  gnome) image=cap-harness-gnome dockerfile=gnome.Dockerfile up=gnome-up.sh extra_env=("${no_device_select[@]}") ;;
  hyprland|niri|sway) image=cap-harness-arch dockerfile=arch.Dockerfile up=arch-up.sh extra_env=("${no_device_select[@]}") ;;
  kde) image=cap-harness-kde dockerfile=kde.Dockerfile up=kde-up.sh ;;
  *) echo "unknown desktop $desktop" >&2; exit 2 ;;
esac
name=cap-$desktop-$$
[[ -d "$out" ]] && find "$out" -mindepth 1 -delete
mkdir -p "$out" && chmod 777 "$out"
# HARNESS_IMAGE: an image built from this one (a patched compositor) to run
# instead.
if [[ -n "${HARNESS_IMAGE:-}" ]]; then
  image=$HARNESS_IMAGE
else
  docker build -q -f "$here/$dockerfile" -t "$image" "$here" >/dev/null
fi
# DEV_BIN=<path to a built cap-gpui> with DEV_LIBS=<its FFmpeg lib dir> runs a
# local build in place of the packaged binary (the package still provides the
# desktop file and dependencies).
dev_mounts=()
if [[ -n "${DEV_BIN:-}" ]]; then
  dev_mounts=(-v "$(realpath "$DEV_BIN")":/dev-bin/cap-gpui:ro -v "$(realpath "${DEV_LIBS:?set DEV_LIBS}")":/dev-libs:ro)
fi
# DOCKER_EXTRA: more `docker run` flags, e.g. `--gpus all -e
# NVIDIA_DRIVER_CAPABILITIES=all` to hand a real GPU's userspace to the desktop.
read -r -a docker_extra <<<"${DOCKER_EXTRA:-}"
# The .deb's dependencies come from Ubuntu's mirrors. Every run on this host
# shares one package cache, so only the first run downloads them.
apt_cache=${HARNESS_APT_CACHE:-${RUNNER_TEMP:-/tmp}/cap-harness-apt}
cache_mounts=()
if [[ $desktop == gnome ]]; then
  mkdir -p "$apt_cache/partial"
  cache_mounts=(-v "$apt_cache":/var/cache/apt/archives)
fi
docker run -d --name "$name" --privileged --cgroupns=host "${docker_extra[@]}" \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$package":/pkgs/"$(basename "$package")":ro -v "$here":/harness:ro -v "$out":/out \
  "${cache_mounts[@]}" "${dev_mounts[@]}" "$image" >/dev/null
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
# Ubuntu's mirrors answer 502 for minutes at a time: apt retries each file,
# a failed install is tried again, and then again from another mirror.
install_deb() {
  local deb mirror attempt
  deb=/pkgs/$(basename "$package")
  : >"$out/install.log"
  # The image's apt deletes packages once installed; keep them in the cache.
  docker exec "$name" rm -f /etc/apt/apt.conf.d/docker-clean
  for mirror in "" http://azure.archive.ubuntu.com/ubuntu; do
    if [[ -n $mirror ]]; then
      echo "switching to $mirror" >>"$out/install.log"
      docker exec "$name" sed -i "s#http://archive.ubuntu.com/ubuntu#$mirror#g" \
        /etc/apt/sources.list.d/ubuntu.sources >>"$out/install.log" 2>&1 || continue
      docker exec "$name" apt-get update -qq >>"$out/install.log" 2>&1 || continue
    fi
    for attempt in 1 2; do
      docker exec "$name" apt-get install -y -qq -o Acquire::Retries=4 "$deb" \
        >>"$out/install.log" 2>&1 && return 0
      echo "install attempt $attempt failed" >>"$out/install.log"
      sleep $((attempt * 15))
    done
  done
  return 100
}
case "$package" in
  *.deb) if [[ $desktop == gnome ]]; then
           install_deb
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
# SCENARIO picks scenario-<name>.sh (default start-stop); SCENARIO=none only
# brings the desktop up (with KEEP_CONTAINER, for running other checks in it).
if [[ ${SCENARIO:-start-stop} != none ]]; then
  docker exec -u tester "${envs[@]}" "$name" bash "/harness/scenario-${SCENARIO:-start-stop}.sh"
fi
if [[ -n "${KEEP_CONTAINER:-}" ]]; then
  trap - EXIT
  echo "kept container $name"
fi
