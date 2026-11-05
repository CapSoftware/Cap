#!/usr/bin/env python3
"""A mouse that stays plugged in: one Mutter RemoteDesktop session whose
virtual pointer exists for the whole run. Headless GNOME has no pointer of its
own, and a session per click removes the device again, so apps that bind the
seat's pointer once (gpui does) never receive the clicks. Start it before the
app. Needs GNOME_UNSAFE=1 for window lookups.

Usage: mutter-pointer.py, then one command per line on stdin:
  click <window title regex> <x fraction> <y fraction> [dx dy]
  click-at <x> <y>
Each command prints one line. Stays up until stdin closes.
"""
import json
import sys
import time

from gi.repository import Gio, GLib

BTN_LEFT = 0x110


def window_rect(bus, pattern):
    script = (
        "(() => { const re = new RegExp(%s); const w = global.display.list_all_windows()"
        ".filter(w => re.test(w.get_title() || '')).pop(); if (!w) return '';"
        " w.activate(global.get_current_time());"
        " const r = w.get_frame_rect(); return JSON.stringify([r.x, r.y, r.width, r.height]); })()"
        % json.dumps(pattern)
    )
    ok, result = bus.call_sync(
        "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval",
        GLib.Variant("(s)", (script,)), GLib.VariantType("(bs)"), Gio.DBusCallFlags.NONE, 5000,
    ).unpack()
    return json.loads(json.loads(result)) if ok and result not in ('""', "") else None


def main() -> int:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)

    def call(path, interface, method, args=None, reply=None):
        return bus.call_sync(
            "org.gnome.Mutter.RemoteDesktop" if "RemoteDesktop" in interface else "org.gnome.Mutter.ScreenCast",
            path, interface, method, args, reply, Gio.DBusCallFlags.NONE, 5000,
        )

    session = call("/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop",
                   "CreateSession", None, GLib.VariantType("(o)")).unpack()[0]
    session_id = bus.call_sync(
        "org.gnome.Mutter.RemoteDesktop", session, "org.freedesktop.DBus.Properties", "Get",
        GLib.Variant("(ss)", ("org.gnome.Mutter.RemoteDesktop.Session", "SessionId")),
        GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 5000,
    ).unpack()[0]
    cast = call("/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast", "CreateSession",
                GLib.Variant("(a{sv})", ({"remote-desktop-session-id": GLib.Variant("s", session_id)},)),
                GLib.VariantType("(o)")).unpack()[0]
    stream = call(cast, "org.gnome.Mutter.ScreenCast.Session", "RecordMonitor",
                  GLib.Variant("(sa{sv})", ("", {})), GLib.VariantType("(o)")).unpack()[0]
    remote = lambda method, args=None: call(session, "org.gnome.Mutter.RemoteDesktop.Session", method, args)
    remote("Start")
    time.sleep(0.5)
    # Park the pointer away from the hot corner and panels.
    remote("NotifyPointerMotionAbsolute", GLib.Variant("(sdd)", (stream, 960.0, 600.0)))
    print("pointer ready", flush=True)

    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "click-at" and len(parts) == 3:
            x, y = float(parts[1]), float(parts[2])
        elif parts[0] == "click" and len(parts) >= 4:
            rect = window_rect(bus, parts[1])
            if not rect:
                print(f"no window matching {parts[1]}", flush=True)
                continue
            dx, dy = (float(parts[4]), float(parts[5])) if len(parts) >= 6 else (0.0, 0.0)
            x = rect[0] + rect[2] * float(parts[2]) + dx
            y = rect[1] + rect[3] * float(parts[3]) + dy
        else:
            print(f"unknown command {line.strip()}", flush=True)
            continue
        time.sleep(0.3)
        remote("NotifyPointerMotionAbsolute", GLib.Variant("(sdd)", (stream, x, y)))
        time.sleep(0.3)
        remote("NotifyPointerButton", GLib.Variant("(ib)", (BTN_LEFT, True)))
        time.sleep(0.08)
        remote("NotifyPointerButton", GLib.Variant("(ib)", (BTN_LEFT, False)))
        print(f"clicked at {x:.0f},{y:.0f}", flush=True)
    remote("Stop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
