# Linux desktop harness

Runs the GPUI app on real Linux desktops in systemd containers and drives a
recording the way a person does, so Wayland start and stop failures reproduce
in CI instead of on users' machines. `.github/workflows/linux-desktop-reliability.yml`
runs it on every pull request that touches the desktop app.

| Desktop | Image | What it stands in for |
| --- | --- | --- |
| `gnome` | Ubuntu 26.04, GNOME 50 headless, AppIndicator, xdg-desktop-portal 1.21+ | Ubuntu users: shortcut approval dialog, `ShortcutsChanged`, Share Screen dialog |
| `hyprland` | Arch, Hyprland on vkms, waybar tray, xdg-desktop-portal-hyprland | Omarchy users: the portal refuses host apps ("An app id is required"), tray Stop control, no configure after a remap |
| `sway`, `niri` | Arch on vkms | Exploration only; their portals need a render node vkms does not have |

Each run (`run-desktop.sh <desktop> <package> <out-dir> [KEY=VALUE...]`):

1. boots a fresh container with systemd as PID 1, a user session and PipeWire;
2. starts the desktop (`gnome-up.sh` or `arch-up.sh`) and installs the package
   (`.deb` on GNOME, AppImage anywhere) or mounts a local build with
   `DEV_BIN=<cap-gpui> DEV_LIBS=<FFmpeg lib dir>`;
3. runs `scenario-start-stop.sh`: launch Cap in a launcher-style systemd scope,
   start a Display recording from the overlay, approve the shortcut
   (`atspi-press.py`, the dialog's Add button) or click the tray item from a
   long-lived host connection (`sni-click.py`), approve the screen share, record
   for a few seconds, stop with the same control. On GNOME, `LAUNCH=terminal
   TRAY_CLICK=menu GNOME_UNSAFE=1` takes the tray fallback through the
   AppIndicator extension's menu (`panel-menu.py`), which is what a single click
   on the icon opens;
4. writes `result.txt`, which `check-results.sh` turns into pass or fail.

`report.sh <out-dir>` prints the results with Cap's own log lines. The
Hyprland image needs `modprobe vkms` on the host. With `GNOME_UNSAFE=1`,
`shot.sh` takes a screenshot of the GNOME session.

Harness-only workarounds (not in the app): Mesa's device_select Vulkan layer is
disabled on the vkms images because it crashes on their virtual devices, and
the GNOME session gets a target bound to `graphical-session.target`, which a
real login activates.
