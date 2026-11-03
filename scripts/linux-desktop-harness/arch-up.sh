#!/usr/bin/env bash
# Runs as the test user inside the systemd Arch container: the desktop under
# test (DESKTOP=hyprland|niri|sway) on the host's vkms KMS device through
# seatd, with waybar as the tray host, the way Omarchy and most Niri setups
# run. Exports the session to the user bus and systemd manager.
set -euo pipefail
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
desktop=${DESKTOP:-hyprland}
kms=
for card in /sys/class/drm/card[0-9]*; do
  if [[ $(readlink -f "$card/device") == */vkms ]]; then kms=/dev/dri/$(basename "$card"); break; fi
done
[[ -n "$kms" ]] || { echo "arch-up: no vkms device; run 'modprobe vkms' on the host" >&2; exit 1; }
mkdir -p "$out" "$HOME/.config/waybar" "$HOME/.config/hypr" "$HOME/.config/niri" "$HOME/.config/sway"

cat >"$HOME/.config/waybar/config" <<'JSON'
{ "layer": "top", "modules-right": ["tray"], "tray": { "spacing": 4 } }
JSON
export_session='dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE HYPRLAND_INSTANCE_SIGNATURE; systemctl --user import-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE HYPRLAND_INSTANCE_SIGNATURE'
common=(LIBSEAT_BACKEND=seatd XDG_SESSION_TYPE=wayland)

case "$desktop" in
  hyprland)
    cat >"$HOME/.config/hypr/hyprland.conf" <<CONF
monitor = , 1920x1080, 0x0, 1
misc { disable_hyprland_logo = true }
debug { disable_logs = false }
exec-once = sh -c '$export_session'
exec-once = waybar
CONF
    # The screen-share picker: answer with the one screen, as a person would.
    cat >"$HOME/.config/hypr/xdph.conf" <<CONF
screencopy {
  custom_picker_binary = /harness/xdph-pick.sh
}
CONF
    systemd-run --user --unit=desktop --collect -p StandardOutput=file:"$out/compositor.log" -p StandardError=inherit \
      env "${common[@]}" AQ_DRM_DEVICES="$kms" XDG_CURRENT_DESKTOP=Hyprland Hyprland
    ;;
  niri)
    # vkms has no render node of its own; niri needs one named. On a host
    # with no GPU, NIRI_RENDER_DEVICE=vkms renders on the vkms card itself,
    # for a niri built to accept software rendering (niri-software.Dockerfile).
    render=${NIRI_RENDER_DEVICE:-$(ls /dev/dri/renderD* 2>/dev/null | head -1)}
    [[ $render == vkms ]] && render=$kms
    cat >"$HOME/.config/niri/config.kdl" <<KDL
spawn-at-startup "sh" "-c" "$export_session; waybar"
debug {
    render-drm-device "$render"
}
KDL
    # NIRI_OUTPUTS_OFF: outputs to switch off (a cloud GPU's EFI framebuffer),
    # so the screen-share dialog has the one screen to pick.
    for output in ${NIRI_OUTPUTS_OFF:-}; do
      printf 'output "%s" {\n    off\n}\n' "$output" >>"$HOME/.config/niri/config.kdl"
    done
    # The packaged session unit, as niri-session starts it: it brings up
    # graphical-session.target, which the GNOME portal backend (niri's
    # ScreenCast portal) requires.
    mkdir -p "$HOME/.config/systemd/user/niri.service.d"
    printf '[Service]\nStandardOutput=file:%s\nStandardError=inherit\nEnvironment=LIBSEAT_BACKEND=seatd XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=niri RUST_LOG=%s\n' \
      "$out/compositor.log" "${NIRI_LOG:-niri=debug}" >"$HOME/.config/systemd/user/niri.service.d/harness.conf"
    # GSK_RENDERER: the portal dialogs' GTK renderer (cairo on software GL).
    [[ -n ${GSK_RENDERER:-} ]] && systemctl --user set-environment GSK_RENDERER="$GSK_RENDERER"
    systemctl --user daemon-reload
    systemctl --user start niri.service
    ;;
  sway)
    # xdg-desktop-portal-wlr: share the one output, as a person picks it.
    mkdir -p "$HOME/.config/xdg-desktop-portal-wlr"
    printf '[screencast]\nchooser_type=none\noutput_name=\n' >"$HOME/.config/xdg-desktop-portal-wlr/config"
    printf 'exec sh -c "%s"\nexec waybar\n' "$export_session" >"$HOME/.config/sway/config"
    systemd-run --user --unit=desktop --collect -p StandardOutput=file:"$out/compositor.log" -p StandardError=inherit \
      env "${common[@]}" WLR_BACKENDS=drm WLR_DRM_DEVICES="$kms" WLR_RENDERER_ALLOW_SOFTWARE=1 \
      WLR_LIBINPUT_NO_DEVICES=1 XDG_CURRENT_DESKTOP=sway sway -c "$HOME/.config/sway/config"
    ;;
  *) echo "arch-up: unknown DESKTOP=$desktop" >&2; exit 2 ;;
esac

for _ in $(seq 300); do
  systemctl --user show-environment | grep -q '^WAYLAND_DISPLAY=' && break
  sleep 0.1
done
systemctl --user show-environment | grep -q '^WAYLAND_DISPLAY=' || { echo "arch-up: $desktop did not start" >&2; tail -20 "$out/compositor.log" >&2; exit 1; }
systemctl --user set-environment XDG_SESSION_TYPE=wayland
echo "arch-up: $desktop on $(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p') ($kms)"
