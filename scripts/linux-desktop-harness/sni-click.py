#!/usr/bin/env python3
"""Click a StatusNotifierItem the way a tray host does: from one long-lived
bus connection that stays up for as long as the panel would.

Usage: sni-click.py <out-dir>
Reads one command per line on stdin: "click" activates the first registered
item. Stays connected until stdin closes.
"""
import sys
import time

from gi.repository import Gio, GLib


def items(bus):
    try:
        reply = bus.call_sync(
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.freedesktop.DBus.Properties",
            "Get",
            GLib.Variant("(ss)", ("org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems")),
            GLib.VariantType("(v)"),
            Gio.DBusCallFlags.NONE,
            2000,
        )
    except GLib.Error:
        return []
    return list(reply.unpack()[0])


def split(item):
    if "@" in item:
        dest, path = item.split("@", 1)
    else:
        dest, _, rest = item.partition("/")
        path = "/" + rest
    return dest, path


def first_item(bus, seconds):
    deadline = time.time() + seconds
    found = items(bus)
    while not found and time.time() < deadline:
        time.sleep(0.25)
        found = items(bus)
    return found[0] if found else None


def main() -> int:
    out = sys.argv[1]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    log = open(f"{out}/actions.log", "a")
    for line in sys.stdin:
        if line.strip() != "click":
            continue
        item = first_item(bus, 20)
        if item is None:
            print("sni-click: no tray item", file=log, flush=True)
            continue
        dest, path = split(item)
        try:
            bus.call_sync(dest, path, "org.kde.StatusNotifierItem", "Activate",
                          GLib.Variant("(ii)", (0, 0)), None, Gio.DBusCallFlags.NONE, 3000)
            print(f"sni-click: activated {dest}{path}", file=log, flush=True)
        except GLib.Error as error:
            print(f"sni-click: activate failed: {error.message}", file=log, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
