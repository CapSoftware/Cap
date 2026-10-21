import json, os, struct, sys, zlib

out, width, height = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(out, exist_ok=True)
rows = bytearray()
for y in range(height):
    rows.append(0)
    g = (y * 255) // max(height - 1, 1)
    row = bytearray(width * 3)
    for x in range(0, width * 3, 3):
        row[x] = ((x // 3) * 255) // max(width - 1, 1)
        row[x + 1] = g
        row[x + 2] = 128
    rows += row

def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(rows), 6))
png += chunk(b"IEND", b"")
with open(os.path.join(out, "original.png"), "wb") as f:
    f.write(png)
with open(os.path.join(out, "recording-meta.json"), "w") as f:
    json.dump({"platform": "MacOS", "pretty_name": "Probe", "display": {"path": "original.png", "fps": 0, "start_time": 0.0}}, f)
