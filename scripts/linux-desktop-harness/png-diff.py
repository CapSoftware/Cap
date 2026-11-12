#!/usr/bin/env python3
"""Usage: png-diff.py <shot.png> <reference.png> <x,y,width,height> [border]

Compares an area screenshot with the same area of a reference screenshot of
the whole screen. Prints `changed=<n> border=<n> total=<n> max=<n>`: the
pixels whose colour differs by more than 12 of 255 in any channel, how many of
those lie within `border` pixels (default 12) of the area's edge, where a
selection frame is drawn, the area's pixel count and the largest difference.
Reads 8-bit RGB and RGBA PNGs without interlacing; needs no image library."""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"png-diff: {path} is not a PNG")
    position, idat, header = 8, [], None
    while position < len(data):
        length, kind = struct.unpack(">I4s", data[position : position + 8])
        body = data[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        position += 12 + length
    width, height, depth, colour, _, _, interlace = header
    if depth != 8 or colour not in (2, 6) or interlace:
        sys.exit(f"png-diff: {path} is not an 8-bit RGB(A) PNG without interlacing")
    channels = 3 if colour == 2 else 4
    stride = width * channels
    raw = zlib.decompress(b"".join(idat))
    rows, previous = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind, row = raw[start], bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 1:
            for i in range(channels, stride):
                row[i] = (row[i] + row[i - channels]) & 255
        elif kind == 2:
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(stride):
                left = row[i - channels] if i >= channels else 0
                up = previous[i]
                corner = previous[i - channels] if i >= channels else 0
                estimate = left + up - corner
                near_left, near_up, near_corner = abs(estimate - left), abs(estimate - up), abs(estimate - corner)
                if near_left <= near_up and near_left <= near_corner:
                    predictor = left
                elif near_up <= near_corner:
                    predictor = up
                else:
                    predictor = corner
                row[i] = (row[i] + predictor) & 255
        rows.append(row)
        previous = row
    return width, height, channels, rows


shot_width, shot_height, shot_channels, shot = read_png(sys.argv[1])
_, _, reference_channels, reference = read_png(sys.argv[2])
left, top, width, height = (int(float(value)) for value in sys.argv[3].split(","))
border = int(sys.argv[4]) if len(sys.argv) > 4 else 12
if (shot_width, shot_height) != (width, height):
    sys.exit(f"png-diff: the screenshot is {shot_width}x{shot_height}, not {width}x{height}")
changed = on_border = largest = 0
for y in range(height):
    shot_row, reference_row = shot[y], reference[top + y]
    for x in range(width):
        a = x * shot_channels
        b = (left + x) * reference_channels
        difference = max(
            abs(shot_row[a] - reference_row[b]),
            abs(shot_row[a + 1] - reference_row[b + 1]),
            abs(shot_row[a + 2] - reference_row[b + 2]),
        )
        if difference > largest:
            largest = difference
        if difference > 12:
            changed += 1
            if x < border or y < border or x >= width - border or y >= height - border:
                on_border += 1
print(f"changed={changed} border={on_border} total={width * height} max={largest}")
