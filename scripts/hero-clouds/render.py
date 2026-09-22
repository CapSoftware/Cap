"""Bakes the homepage hero clouds to transparent WebPs.

    python3 scripts/hero-clouds/render.py [out_dir]

Each cloud is a domain-warped fractal density field shaped by a cumulus
silhouette, lit from the upper right by marching the density toward the
light. Rendering happens at 2x the largest on-screen size so the edges stay
crisp on retina displays.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

LIGHT = np.array([1.0, 0.992, 0.972])
SHADE = np.array([0.70, 0.78, 0.89])
DEEP = np.array([0.62, 0.71, 0.84])

LIGHT_DIR = np.array([0.62, -0.78])
LIGHT_DIR /= np.linalg.norm(LIGHT_DIR)


def smooth_noise(rng: np.random.Generator, w: int, h: int, cells: int) -> np.ndarray:
    grid = rng.random((max(2, int(h / w * cells) + 1), cells + 1)).astype(np.float32)
    img = Image.fromarray((grid * 255).astype(np.uint8), mode="L")
    img = img.resize((w, h), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def fbm(rng: np.random.Generator, w: int, h: int, base_cells: int, octaves: int, gain: float = 0.5) -> np.ndarray:
    total = np.zeros((h, w), dtype=np.float32)
    amp = 1.0
    norm = 0.0
    cells = base_cells
    for _ in range(octaves):
        total += amp * smooth_noise(rng, w, h, cells)
        norm += amp
        amp *= gain
        cells *= 2
    return total / norm


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def shift(a: np.ndarray, dx: float, dy: float) -> np.ndarray:
    ix, iy = int(round(dx)), int(round(dy))
    out = np.zeros_like(a)
    h, w = a.shape
    xs = slice(max(0, ix), min(w, w + ix))
    xd = slice(max(0, -ix), min(w, w - ix))
    ys = slice(max(0, iy), min(h, h + iy))
    yd = slice(max(0, -iy), min(h, h - iy))
    out[ys, xs] = a[yd, xd]
    return out


@dataclass(frozen=True)
class Puff:
    cx: float
    cy: float
    rx: float
    ry: float


@dataclass(frozen=True)
class CloudSpec:
    name: str
    seed: int
    puffs: tuple[Puff, ...]
    base: float
    detail: float
    erosion: float
    export_width: int
    quality: int


W, H = 1600, 900

CLOUDS: tuple[CloudSpec, ...] = (
    CloudSpec(
        name="cumulus-a",
        seed=7,
        puffs=(
            Puff(0.50, 0.60, 0.40, 0.14),
            Puff(0.30, 0.52, 0.16, 0.20),
            Puff(0.44, 0.42, 0.15, 0.22),
            Puff(0.58, 0.36, 0.17, 0.25),
            Puff(0.71, 0.46, 0.13, 0.19),
            Puff(0.82, 0.56, 0.11, 0.13),
            Puff(0.18, 0.60, 0.10, 0.10),
        ),
        base=0.70,
        detail=0.95,
        erosion=0.34,
        export_width=896,
        quality=76,
    ),
    CloudSpec(
        name="cumulus-b",
        seed=23,
        puffs=(
            Puff(0.50, 0.62, 0.38, 0.12),
            Puff(0.34, 0.50, 0.15, 0.18),
            Puff(0.50, 0.40, 0.16, 0.24),
            Puff(0.65, 0.48, 0.15, 0.20),
            Puff(0.78, 0.58, 0.10, 0.11),
            Puff(0.24, 0.60, 0.10, 0.10),
        ),
        base=0.71,
        detail=0.9,
        erosion=0.38,
        export_width=760,
        quality=78,
    ),
    CloudSpec(
        name="tuft-a",
        seed=41,
        puffs=(
            Puff(0.50, 0.60, 0.30, 0.12),
            Puff(0.40, 0.50, 0.14, 0.16),
            Puff(0.55, 0.44, 0.14, 0.20),
            Puff(0.67, 0.54, 0.10, 0.12),
        ),
        base=0.69,
        detail=1.0,
        erosion=0.42,
        export_width=600,
        quality=78,
    ),
    CloudSpec(
        name="bank-a",
        seed=59,
        puffs=(
            Puff(0.50, 0.62, 0.46, 0.09),
            Puff(0.22, 0.56, 0.14, 0.11),
            Puff(0.40, 0.52, 0.14, 0.14),
            Puff(0.58, 0.50, 0.16, 0.15),
            Puff(0.76, 0.55, 0.13, 0.12),
        ),
        base=0.69,
        detail=0.85,
        erosion=0.40,
        export_width=864,
        quality=76,
    ),
    CloudSpec(
        name="wisp-a",
        seed=73,
        puffs=(
            Puff(0.50, 0.60, 0.36, 0.07),
            Puff(0.36, 0.56, 0.14, 0.09),
            Puff(0.60, 0.54, 0.16, 0.10),
        ),
        base=0.66,
        detail=1.0,
        erosion=0.55,
        export_width=860,
        quality=78,
    ),
)


def silhouette(spec: CloudSpec, warp_x: np.ndarray, warp_y: np.ndarray) -> np.ndarray:
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    u = xs / W + warp_x
    v = ys / H + warp_y
    field = np.zeros((H, W), dtype=np.float32)
    for p in spec.puffs:
        d2 = ((u - p.cx) / p.rx) ** 2 + ((v - p.cy) / p.ry) ** 2
        field = np.maximum(field, np.clip(1.0 - d2, 0.0, 1.0))
    below = smoothstep(spec.base + 0.10, spec.base - 0.02, v)
    return field * below


def render(spec: CloudSpec) -> Image.Image:
    rng = np.random.default_rng(spec.seed)

    warp_x = (fbm(rng, W, H, 5, 3) - 0.5) * 0.17
    warp_y = (fbm(rng, W, H, 5, 3) - 0.5) * 0.13
    shape = silhouette(spec, warp_x, warp_y)

    body = fbm(rng, W, H, 6, 6, gain=0.55)
    fine = fbm(rng, W, H, 24, 4, gain=0.5)
    curd = fbm(rng, W, H, 40, 3, gain=0.5)

    density = shape * (0.25 + 1.35 * body * spec.detail) + 0.3 * fine * shape
    density -= spec.erosion * fine * (1.0 - shape)
    density = smoothstep(0.3, 0.95, density)

    # March toward the light and accumulate how much cloud sits between each
    # pixel and the sun; deeper pixels turn toward the shade colour.
    occlusion = np.zeros_like(density)
    step = 7.0
    for i in range(1, 30):
        occlusion += shift(density, -LIGHT_DIR[0] * step * i, -LIGHT_DIR[1] * step * i)
    occlusion *= step / 210.0
    transmittance = np.exp(-0.95 * occlusion)

    ys = np.mgrid[0:H, 0:W][0].astype(np.float32) / H
    belly = smoothstep(0.30, spec.base + 0.02, ys)
    lit = transmittance ** 0.8 * (1.0 - 0.42 * belly)
    lit = np.clip(lit * (0.92 + 0.16 * (curd - 0.5) * density), 0.0, 1.0)

    rim = smoothstep(0.05, 0.45, density) * (1.0 - smoothstep(0.45, 0.9, density))
    rim *= smoothstep(0.55, 1.0, transmittance)

    colour = SHADE[None, None, :] + (LIGHT - SHADE)[None, None, :] * lit[..., None]
    colour = colour * (1.0 - 0.35 * belly[..., None] * (1.0 - lit[..., None])) + DEEP[None, None, :] * (0.35 * belly[..., None] * (1.0 - lit[..., None]))
    colour = colour + (LIGHT - colour) * (0.45 * rim[..., None])
    colour = np.clip(colour, 0.0, 1.0)

    alpha = 1.0 - np.exp(-3.4 * density)
    alpha = smoothstep(0.03, 0.97, alpha)

    rgba = np.dstack([colour, alpha[..., None]])
    img = Image.fromarray((rgba * 255.0 + 0.5).astype(np.uint8), mode="RGBA")

    bbox = img.getchannel("A").point(lambda a: 255 if a > 4 else 0).getbbox()
    if bbox is None:
        raise SystemExit(f"{spec.name}: empty render")
    pad = 24
    img = img.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(W, bbox[2] + pad), min(H, bbox[3] + pad)))
    scale = spec.export_width / img.width
    img = img.resize((spec.export_width, max(1, round(img.height * scale))), Image.LANCZOS)
    return img


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("apps/web/public/backgrounds/clouds")
    out_dir.mkdir(parents=True, exist_ok=True)
    for spec in CLOUDS:
        img = render(spec)
        path = out_dir / f"{spec.name}.webp"
        img.save(path, format="WEBP", quality=spec.quality, method=6)
        print(f"{path} {img.width}x{img.height} {path.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
