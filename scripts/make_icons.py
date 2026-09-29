"""Generate the Gymdex app icons (stdlib only).

Draws an accent-colored dumbbell on the app's canvas color and writes the PNGs
into static/. Run from the repository root:

    python3 scripts/make_icons.py
"""

import struct
import zlib
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"
CANVAS = (0x09, 0x0F, 0x0C)  # --canvas in static/styles.css
ACCENT = (0x78, 0xDF, 0xB5)  # --accent

# Dumbbell as rounded rectangles: (center x, half width, half height, corner radius),
# in units of the icon size, mirrored around the vertical axis. Extent: 0.88 x 0.52.
SHAPES = [
    (0.00, 0.30, 0.045, 0.03),  # handle
    (0.24, 0.06, 0.26, 0.05),  # inner plates
    (0.39, 0.05, 0.17, 0.04),  # outer plates
]

# (file name, pixel size, glyph scale). The maskable icon keeps the whole glyph
# inside the central 80% circle (the maskable safe zone).
ICONS = [
    ("icon-192.png", 192, 0.90),
    ("icon-512.png", 512, 0.90),
    ("icon-maskable-512.png", 512, 0.78),
    ("apple-touch-icon.png", 180, 0.84),
]


def rounded_rect_distance(x, y, cx, half_w, half_h, radius):
    dx = abs(x - cx) - (half_w - radius)
    dy = abs(y) - (half_h - radius)
    outside = (max(dx, 0.0) ** 2 + max(dy, 0.0) ** 2) ** 0.5
    return outside + min(max(dx, dy), 0.0) - radius


def coverage(x, y, pixel):
    """Antialiased coverage of the glyph at (x, y), both in glyph units."""
    x = abs(x)
    distance = min(rounded_rect_distance(x, y, cx, hw, hh, r) for cx, hw, hh, r in SHAPES)
    return min(max(0.5 - distance / pixel, 0.0), 1.0)


def render(size, scale):
    pixel = 1.0 / (size * scale)
    rows = []
    for row in range(size):
        y = ((row + 0.5) / size - 0.5) / scale
        line = bytearray(b"\x00")  # PNG filter type: none
        for column in range(size):
            x = ((column + 0.5) / size - 0.5) / scale
            alpha = coverage(x, y, pixel)
            line += bytes(round(bg + (fg - bg) * alpha) for bg, fg in zip(CANVAS, ACCENT))
        rows.append(bytes(line))
    return b"".join(rows)


def png(size, pixels):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(pixels, 9)) + chunk(b"IEND", b""))


def main():
    for name, size, scale in ICONS:
        (STATIC / name).write_bytes(png(size, render(size, scale)))
        print(f"wrote static/{name} ({size}x{size})")


if __name__ == "__main__":
    main()
