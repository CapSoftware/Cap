#!/usr/bin/env python3
"""Use Cap's tray menu the way GNOME's AppIndicator extension does after a
single click on the icon: open the menu the extension built from Cap's
dbusmenu, then send the entry's "clicked" event through the extension's own
menu item (the call it makes when a person clicks it). Needs GNOME_UNSAFE=1.

Usage: panel-menu.py <entry label regex>
"""
import json
import sys

from gi.repository import Gio, GLib


def main() -> int:
    label = sys.argv[1] if len(sys.argv) > 1 else "recording"
    script = (
        "(() => { const re = new RegExp(%s);"
        " const entry = Object.entries(Main.panel.statusArea).find(([key]) => key.startsWith('appindicator'));"
        " if (!entry) return 'no app indicator in the panel';"
        " const button = entry[1]; button.menu.open();"
        " const items = button.menu._getMenuItems();"
        " const item = items.find(item => re.test(item.label?.text ?? ''));"
        " if (!item) return 'no menu entry: ' + JSON.stringify(items.map(item => item.label?.text ?? null));"
        " const GLib = imports.gi.GLib;"
        " item._dbusItem.handleEvent('clicked', GLib.Variant.new('i', 0), 0);"
        " button.menu.close();"
        " return 'clicked ' + item.label.text; })()" % json.dumps(label)
    )
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    ok, result = bus.call_sync(
        "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval",
        GLib.Variant("(s)", (script,)), GLib.VariantType("(bs)"), Gio.DBusCallFlags.NONE, 5000,
    ).unpack()
    print(result if ok else f"eval failed: {result}")
    return 0 if ok and result.startswith('"clicked') else 1


if __name__ == "__main__":
    sys.exit(main())
