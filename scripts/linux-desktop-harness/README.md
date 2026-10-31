# Linux desktop harness

Runs the GPUI app on real Linux desktops in systemd containers and drives a
recording the way a person does, so Wayland start and stop failures reproduce
in CI instead of on users' machines. `.github/workflows/linux-desktop-reliability.yml`
runs it on every pull request that touches the desktop app.

| Desktop | Image | What it stands in for |
| --- | --- | --- |
| `gnome` | Ubuntu 26.04, GNOME 50 headless, AppIndicator, xdg-desktop-portal 1.21+ | Ubuntu users: shortcut approval dialog, `ShortcutsChanged`, Share Screen dialog |
| `hyprland` | Arch, Hyprland on vkms, waybar tray, xdg-desktop-portal-hyprland | Omarchy users: the portal refuses host apps ("An app id is required"), tray Stop control, no configure after a remap |
| `kde` | Arch, KWin 6 on its virtual backend, plasmashell tray, xdg-desktop-portal-kde | Plasma users: the screen-share dialog (its screens are buttons), the tray Stop control with `LAUNCH=dock`. Needs a DRM render node (`modprobe vgem`): KWin streams screens only when it composites with OpenGL, so it does not run on CI's runners. KWin's virtual backend takes no injected keys, so a shell launch's Stop shortcut is approved (`APPROVE_SHORTCUT_AFTER`) but not pressed |
| `sway`, `niri` | Arch on vkms | Exploration only: their portals need a render node vkms does not have, and niri refuses software rendering |

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
   TRAY_CLICK=pointer GNOME_UNSAFE=1` takes the tray fallback by clicking the
   icon in the top bar and the entry of the menu it opens (`panel-locate.py`,
   `mutter-pointer.py`);
4. writes `result.txt`, which `check-results.sh` turns into pass or fail.

`SCENARIO=clipboard` (niri, Hyprland) opens Cap's teleprompter, pastes text
another app copied with Ctrl+V and copies it back out with Ctrl+A, Ctrl+C,
pressed through the compositor's virtual keyboard (`wtype`).
`GNOME_TRAY=0` runs GNOME in its plain session without the AppIndicator
extension and without the harness's own tray host, as Fedora ships it. With
`CAP_GPUI_PORTAL_APP_ID=0` and `LAUNCH=terminal` the portal grants no shortcut
either, and the scenario expects Cap to record with its controls visible
(`attempt1_control=visible`): it finds the controls window and clicks their red Stop button with the pointer (needs `GNOME_UNSAFE=1`).
`SCENARIO=reopen` launches Cap from a terminal and again from the app grid,
which must hand over to the running instance. `SCENARIO=raise` (with
`GNOME_UNSAFE=1`) focuses Cap's settings, then has GNOME Shell launch Cap the
way the app grid does; the activation token the relaunch hands over must bring
onboarding, or the main window with `RAISE_WINDOW=main`, to the front.
`MUTTER_DEBUG=focus,startup` writes mutter's reasoning to
`compositor.debug.log`. `SCENARIO=settings-close` instead opens Cap's settings and closes it with the
window's own close button (GNOME draws no title bar for it). Clicks go through
`mutter-pointer.py`, one virtual pointer that exists before Cap starts: gpui
binds the seat's pointer once, so a pointer created per click never reaches it.
`SCENARIO=pick-background` (with `GNOME_UNSAFE=1`) records a clip, opens it in
the editor and presses the Image background's picker
(`CAP_GPUI_AUTO_PICK_BACKGROUND=1`), then types a picture's path into the
portal's file chooser through `mutter-keys.py --type` and presses Select.
Mutter's RemoteDesktop drops the first key of each session, so `mutter-keys.py`
leads every session with a Shift tap.
`SCENARIO=screenshot` takes a screenshot of the display the way the
screenshot mode does, with Cap focused as after a click, and allows it when
the portal asks (GNOME Shell's question is answered from the Shell, so it needs
`GNOME_UNSAFE=1`; elsewhere the permission is granted up front because the GTK
portal's dialog aborts in the container). It checks a PNG of the display's size (`SCREEN`, 1920x1080) was saved.
`PRELAUNCH=1` runs Cap once before, so a `LAUNCH=terminal` run finds the
`so.cap.Cap.desktop` entry GNOME matches Cap's windows to.
`SCENARIO=wallpaper` records a clip, opens it in the editor and imports the
desktop's wallpaper as its background (`CAP_GPUI_AUTO_DESKTOP_BACKGROUND=1`).
GNOME keeps its default JPEG XL wallpaper; `WALLPAPER=swaybg` starts swaybg
with a PNG first, as Omarchy does on Hyprland.
`SCENARIO=register` launches Cap from a shell `ROUNDS` times, each time once
with its `so.cap.Cap.desktop` entry removed and once with it in place, and
counts the launches that registered the app id with the portals.
`AREA=x,y,width,height` makes the start-stop scenario record that area of the
display and check the video is its size.
`SCENARIO=export` records a clip, opens it in the editor and exports it to an
MP4 and to a GIF (`CAP_GPUI_AUTO_EXPORT`), checking the length each file
declares.

`report.sh <out-dir>` prints the results with Cap's own log lines. The
Hyprland image needs `modprobe vkms` on the host. With `GNOME_UNSAFE=1`,
`shot.sh` takes a screenshot of the GNOME session.

Harness-only workarounds (not in the app): Mesa's device_select Vulkan layer is
disabled on the vkms images because it crashes on their virtual devices, and
the GNOME session gets a target bound to `graphical-session.target`, which a
real login activates.

## Checks without a desktop

- `x11-camera.sh <cap-gpui> <ffmpeg lib dir> <out-dir>` records the display on
  Xvfb (X11 capture, no portal) with a camera: a v4l2loopback device that
  ffmpeg feeds a 1280x720 test pattern, as YUYV, NV12 or MJPEG
  (`CAMERA_FORMAT`; CI runs all three). Cap waits for the Stop shortcut to start
  and to stop, pressed with real X input (xdotool), well before its 60 s
  automatic stop. It checks the camera track is 1280x720 and as long as the
  display track, about five seconds, and fails if any result is missing. It
  needs root for modprobe, and runs in the Hyprland job, whose hosted runner
  can build the module.
- `x11-capture.sh <cap-gpui> <ffmpeg lib dir> <out-dir>` records the display,
  an area and another app's window on Xvfb (MIT-SHM capture, no portal),
  pressing the Stop shortcut with real X input where Cap waits for it, records
  the microphone and system audio from a tone a private PulseAudio plays, takes
  a screenshot, and checks the size, length and loudness of each result. It also
  checks the window picker offers the other app's window rather than one of
  Cap's own.
- `x11-stale-wayland.sh <cap-gpui> <ffmpeg lib dir> <out-dir>` starts Cap on
  Xvfb with `WAYLAND_DISPLAY` naming a socket nothing listens on, as a systemd
  user environment keeps it after a Wayland session ends, and checks Cap falls
  back to the X display instead of failing to start.

- `niri-screencast/run.sh` records through Cap's PipeWire capture loop from a
  producer that negotiates and shares frames the way niri 26.04 does: a
  mandatory DMA-BUF modifier, DMA-BUF buffers the consumer must map itself,
  and a chunk size of 1 (GitHub #2941). It needs a host with PipeWire and
  WirePlumber, and runs in the GNOME job.
- `appimage-pipewire/run.sh <Cap.AppImage> <out-dir>` connects a screen
  capture stream inside NixOS's `appimage-run`, through the AppImage's real
  launchers, with the AppDir as the given AppImage shipped it and as
  `scripts/finalize-linux-appimage.mjs` lays it out now. A stand-in for Cap
  links the bundled FFmpeg the way Cap does, so the bundled libva loads ahead
  of the host's PipeWire plugins, as in Cap.

