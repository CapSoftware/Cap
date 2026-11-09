#!/usr/bin/env python3
"""Usage: portal-shot.py <out.png>

Takes a screenshot of the desktop through the Screenshot portal, without a
dialog, the way Cap does, and copies it to out.png: what the screen looks like
to the same capture path, for comparing Cap's screenshots against."""
import os
import shutil
import sys
import urllib.parse

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)
token = f"capharness{os.getpid()}"
sender = bus.get_unique_name()[1:].replace(".", "_")
request = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
loop = GLib.MainLoop()
answer = {}


def on_response(_bus, _sender, _path, _interface, _signal, parameters):
    answer["code"], answer["results"] = parameters.unpack()
    loop.quit()


bus.signal_subscribe(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Request",
    "Response",
    request,
    None,
    Gio.DBusSignalFlags.NONE,
    on_response,
)
bus.call_sync(
    "org.freedesktop.portal.Desktop",
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.Screenshot",
    "Screenshot",
    GLib.Variant(
        "(sa{sv})",
        ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)}),
    ),
    None,
    Gio.DBusCallFlags.NONE,
    -1,
    None,
)
GLib.timeout_add_seconds(20, loop.quit)
loop.run()
uri = answer.get("results", {}).get("uri")
if answer.get("code") != 0 or not uri:
    sys.exit(f"portal-shot: no screenshot ({answer or 'no response'})")
source = urllib.parse.unquote(urllib.parse.urlparse(uri).path)
shutil.copyfile(source, sys.argv[1])
os.remove(source)
