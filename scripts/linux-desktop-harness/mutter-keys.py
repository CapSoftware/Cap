#!/usr/bin/env python3
"""Press a key chord through Mutter's RemoteDesktop D-Bus API, the way a real
keyboard reaches GNOME Shell (and so its global shortcut grabs).

Usage: mutter-keys.py Control_L+Shift_L+F9 [--hold-ms 120]
"""
import sys
import time

from gi.repository import Gio, GLib

KEYSYMS = {
    "Control_L": 0xFFE3,
    "Shift_L": 0xFFE1,
    "Alt_L": 0xFFE9,
    "Super_L": 0xFFEB,
    "Return": 0xFF0D,
    "Escape": 0xFF1B,
    "Tab": 0xFF09,
    "space": 0x0020,
}
for n in range(1, 13):
    KEYSYMS[f"F{n}"] = 0xFFBE + n - 1


def main() -> int:
    chord = sys.argv[1].split("+")
    hold = 0.12
    if "--hold-ms" in sys.argv:
        hold = int(sys.argv[sys.argv.index("--hold-ms") + 1]) / 1000
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    session_path = bus.call_sync(
        "org.gnome.Mutter.RemoteDesktop",
        "/org/gnome/Mutter/RemoteDesktop",
        "org.gnome.Mutter.RemoteDesktop",
        "CreateSession",
        None,
        GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        5000,
    ).unpack()[0]

    def call(method, args=None):
        bus.call_sync(
            "org.gnome.Mutter.RemoteDesktop",
            session_path,
            "org.gnome.Mutter.RemoteDesktop.Session",
            method,
            args,
            None,
            Gio.DBusCallFlags.NONE,
            5000,
        )

    call("Start")
    time.sleep(0.3)
    for key in chord:
        call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (KEYSYMS[key], True)))
        time.sleep(0.03)
    time.sleep(hold)
    for key in reversed(chord):
        call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (KEYSYMS[key], False)))
        time.sleep(0.03)
    time.sleep(0.2)
    call("Stop")
    print(f"pressed {'+'.join(chord)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
