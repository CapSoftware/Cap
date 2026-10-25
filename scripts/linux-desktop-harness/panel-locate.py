#!/usr/bin/env python3
"""Print the screen centre of Cap's icon in GNOME's top bar ("icon"), or of
the entry in the menu it opened that matches a regex ("entry <regex>"), for
mutter-pointer.py to click. Needs GNOME_UNSAFE=1.
"""
import json
import sys

from gi.repository import Gio, GLib

CENTRE = (
    "const [x, y] = actor.get_transformed_position(); const [w, h] = actor.get_transformed_size();"
    " return JSON.stringify([x + w / 2, y + h / 2]);"
)


def main() -> int:
    find = (
        "const entry = Object.entries(Main.panel.statusArea).find(([key]) => key.startsWith('appindicator'));"
        " if (!entry) return '';"
    )
    if sys.argv[1] == "icon":
        body = find + " const actor = entry[1]; " + CENTRE
    else:
        body = (
            find + " const re = new RegExp(%s);"
            " const item = entry[1].menu._getMenuItems().find(item => re.test(item.label?.text ?? ''));"
            " if (!item || !item.visible || !entry[1].menu.isOpen) return ''; const actor = item; "
            % json.dumps(sys.argv[2]) + CENTRE
        )
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    ok, result = bus.call_sync(
        "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval",
        GLib.Variant("(s)", ("(() => { %s })()" % body,)), GLib.VariantType("(bs)"),
        Gio.DBusCallFlags.NONE, 5000,
    ).unpack()
    found = json.loads(result) if ok else ""
    if not found:
        return 1
    x, y = json.loads(found)
    print(f"{x:.0f} {y:.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
