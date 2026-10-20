"""Bakes the painted-sky OG image backgrounds.

    python3 scripts/og-sky/render.py

Satori (next/og) can't run SVG filters, blend WebP clouds or draw film grain,
so the atmosphere is baked here once: the homepage hero sky (HeroSky.tsx
gradients + the real cloud art from public/backgrounds/clouds) and the
Instant-mode mesh used for product frames. The route composites text and UI
on top at request time. Outputs land in apps/web/lib/og/assets.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps" / "web"
CLOUDS = WEB / "public" / "backgrounds" / "clouds"
OUT = WEB / "lib" / "og" / "assets"

W, H = 1200, 630


def hex_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def grid(w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    return xs + 0.5, ys + 0.5


def over(base: np.ndarray, color: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    a = alpha[..., None]
    return base * (1 - a) + color * a


def radial(w: int, h: int, rx: float, ry: float, cx: float, cy: float, stop: float) -> np.ndarray:
    xs, ys = grid(w, h)
    d = np.sqrt(((xs - cx * w) / (rx * w)) ** 2 + ((ys - cy * h) / (ry * h)) ** 2)
    t = np.clip(d / stop, 0, 1)
    return 1 - t


def vertical(w: int, h: int, stops: list[tuple[float, str]]) -> np.ndarray:
    _, ys = grid(w, h)
    t = ys / h
    pos = np.array([p for p, _ in stops], dtype=np.float32)
    cols = np.stack([hex_rgb(c) for _, c in stops])
    out = np.zeros((h, w, 3), dtype=np.float32)
    for ch in range(3):
        out[..., ch] = np.interp(t, pos, cols[:, ch])
    return out


def grain(img: np.ndarray, strength: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, 1, img.shape[:2]).astype(np.float32)
    noise = (np.floor(np.clip(noise * 40 + 128, 0, 255)) - 128) / 40
    return img + noise[..., None] * strength


def paste_cloud(img: np.ndarray, name: str, left: int, top: int, width: int, opacity: float, flip: bool = False) -> np.ndarray:
    art = Image.open(CLOUDS / f"{name}.webp").convert("RGBA")
    if flip:
        art = art.transpose(Image.FLIP_LEFT_RIGHT)
    height = round(art.height * width / art.width)
    art = art.resize((width, height), Image.LANCZOS)
    rgba = np.asarray(art, dtype=np.float32) / 255.0
    h, w = img.shape[:2]
    x0, y0 = max(left, 0), max(top, 0)
    x1, y1 = min(left + width, w), min(top + height, h)
    if x0 >= x1 or y0 >= y1:
        return img
    crop = rgba[y0 - top : y1 - top, x0 - left : x1 - left]
    region = img[y0:y1, x0:x1]
    img[y0:y1, x0:x1] = over(region, crop[..., :3], crop[..., 3] * opacity)
    return img


def sky() -> np.ndarray:
    img = vertical(W, H, [(0, "#C4DAF5"), (0.36, "#D6E5F7"), (0.7, "#E4ECF6"), (1, "#EDF1F6")])
    img = over(img, hex_rgb("#FFF0E0"), radial(W, H, 0.8, 0.46, 0.5, 0.82, 0.72) * 0.45)
    img = over(img, hex_rgb("#FFE0C0"), radial(W, H, 0.34, 0.5, 0.8, 0.0, 0.7) * 0.75)
    return img


def save(img: np.ndarray, name: str, quality: int = 90) -> None:
    out = Image.fromarray((img.clip(0, 1) * 255).round().astype(np.uint8), mode="RGB")
    out.save(OUT / name, quality=quality, optimize=True, progressive=True)
    print(f"{name}: {(OUT / name).stat().st_size // 1024}KB")


def marketing_sky() -> None:
    img = sky()
    img = paste_cloud(img, "wisp-a", 250, -30, 420, 0.55)
    img = paste_cloud(img, "tuft-a", -70, 60, 250, 0.5, flip=True)
    img = paste_cloud(img, "cumulus-b", 800, -40, 420, 0.8)
    img = paste_cloud(img, "bank-a", 470, 150, 380, 0.45)
    img = paste_cloud(img, "cumulus-a", -170, 420, 620, 0.9)
    img = paste_cloud(img, "bank-a", 360, 520, 520, 0.8, flip=True)
    img = grain(img, 0.006, 7)
    save(img, "sky-split.jpg")


def centered_sky() -> None:
    img = sky()
    img = paste_cloud(img, "wisp-a", 60, 20, 380, 0.6)
    img = paste_cloud(img, "cumulus-b", 860, 40, 400, 0.85)
    img = paste_cloud(img, "tuft-a", 420, -40, 260, 0.45)
    img = paste_cloud(img, "cumulus-a", -200, 380, 640, 0.95)
    img = paste_cloud(img, "bank-a", 760, 430, 560, 0.9, flip=True)
    img = grain(img, 0.006, 11)
    save(img, "sky-center.jpg")


def mesh(name: str, w: int, h: int, layers: list[tuple[float, float, float, float, str, float]], base: str) -> None:
    img = np.ones((h, w, 3), dtype=np.float32) * hex_rgb(base)
    # CSS paints the first layer on top, so composite in reverse.
    for rx, ry, cx, cy, color, stop in reversed(layers):
        img = over(img, hex_rgb(color), radial(w, h, rx, ry, cx, cy, stop))
    img = grain(img, 0.01, 3)
    save(img, name, 88)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    marketing_sky()
    centered_sky()
    mesh(
        "mesh-instant.jpg",
        720,
        640,
        [
            (0.92, 0.95, 0.06, 0.06, "#8FC1F7", 0.66),
            (0.70, 0.78, 0.96, 0.02, "#CDEBF4", 0.60),
            (0.82, 0.76, 0.92, 0.96, "#DDD7F8", 0.62),
            (0.92, 0.88, 0.24, 1.00, "#AFD6F8", 0.70),
        ],
        "#E4F0FB",
    )
    wall = Image.open(WEB / "public" / "backgrounds" / "sf.webp").convert("RGB")
    wall = wall.resize((1024, round(wall.height * 1024 / wall.width)), Image.LANCZOS)
    wall.save(OUT / "wallpaper.jpg", quality=86, optimize=True, progressive=True)
    print(f"wallpaper.jpg: {(OUT / 'wallpaper.jpg').stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
