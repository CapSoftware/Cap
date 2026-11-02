#!/usr/bin/env python3
"""Where a person clicks to stop a recording in Cap's on-screen controls.

The controls draw their Stop button (icon and elapsed time) in Cap's red,
#ff4766. Given a screenshot and the controls window's frame, prints the centre
of the red pixels inside it as "x y", or nothing when there are none.

GNOME Shell writes an empty screenshot when it renders on a GPU or without a
DRM device, so with no picture to read this prints where the button sits in
the 320x150 controls.

Usage: stop-locate.py <screenshot.png> <x> <y> <width> <height>
"""
import sys

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, GLib  # noqa: E402

RED = (0xFF, 0x47, 0x66)
TOLERANCE = 40
# The red pixels' centre in a session on vkms.
STOP_OFFSET = (48, 116)


def main() -> int:
    path = sys.argv[1]
    left, top, width, height = (int(value) for value in sys.argv[2:6])
    try:
        image = GdkPixbuf.Pixbuf.new_from_file(path)
    except GLib.Error as error:
        print(f"no screenshot ({error.message}); using the Stop button's place", file=sys.stderr)
        print(f"{left + STOP_OFFSET[0]} {top + STOP_OFFSET[1]}")
        return 0
    pixels = image.get_pixels()
    stride = image.get_rowstride()
    channels = image.get_n_channels()
    xs, ys = [], []
    for y in range(max(top, 0), min(top + height, image.get_height())):
        row = y * stride
        for x in range(max(left, 0), min(left + width, image.get_width())):
            offset = row + x * channels
            r, g, b = pixels[offset], pixels[offset + 1], pixels[offset + 2]
            if all(abs(channel - want) <= TOLERANCE for channel, want in zip((r, g, b), RED)):
                xs.append(x)
                ys.append(y)
    if not xs:
        return 1
    print(f"{sum(xs) // len(xs)} {sum(ys) // len(ys)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
