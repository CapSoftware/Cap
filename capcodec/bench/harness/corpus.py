import json
import math
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

from .common import CACHE_DIR, CORPUS_DIR, FFMPEG, MANIFEST, key_of, log, run

CONVERSION_VERSION = "bt709-limited-lanczos-v1"


@dataclass
class Clip:
    name: str
    file: Path
    width: int
    height: int
    fps: Fraction
    frames: int
    sha256: str
    tags: list[str]
    text_regions: list[list[int]]
    sideinfo: Path | None
    description: str = ""

    @property
    def available(self) -> bool:
        return self.file.exists()


@dataclass
class Source:
    clip: Clip
    path: Path
    width: int
    height: int
    fps: Fraction
    frames: int
    id: str
    sideinfo: Path | None
    text_regions: list[list[int]] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.clip.name

    @property
    def frame_bytes(self) -> int:
        return self.width * self.height * 3 // 2

    @property
    def fps_float(self) -> float:
        return float(self.fps)

    @property
    def fps_arg(self) -> str:
        return f"{self.fps.numerator}/{self.fps.denominator}"

    @property
    def duration_s(self) -> float:
        return self.frames / float(self.fps)

    def describe(self) -> dict:
        return {"clip": self.name, "width": self.width, "height": self.height, "fps": self.fps_arg,
                "frames": self.frames, "id": self.id}


def load_manifest(path: Path = MANIFEST) -> list[Clip]:
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    clips = []
    for c in data.get("clips", []):
        fps = Fraction(str(c.get("fps", 30))).limit_denominator(1001)
        side = c.get("sideinfo")
        clips.append(Clip(
            name=c["name"],
            file=CORPUS_DIR / c["file"],
            width=int(c["width"]),
            height=int(c["height"]),
            fps=fps,
            frames=int(c["frames"]),
            sha256=c.get("sha256", ""),
            tags=list(c.get("tags", [])),
            text_regions=[list(map(int, r)) for r in c.get("text_regions", [])],
            sideinfo=(CORPUS_DIR / side) if side else None,
            description=c.get("description", ""),
        ))
    return clips


def even(v: float) -> int:
    return max(2, int(round(v / 2.0)) * 2)


def target_size(clip: Clip, max_height: int | None) -> tuple[int, int]:
    if max_height is None or clip.height <= max_height:
        return clip.width, clip.height
    scale = max_height / clip.height
    return even(clip.width * scale), even(max_height)


def prepare_source(clip: Clip, max_height: int | None, max_seconds: float | None) -> Source:
    width, height = target_size(clip, max_height)
    frames = clip.frames
    if max_seconds is not None:
        frames = min(frames, int(math.floor(max_seconds * float(clip.fps) + 1e-6)))
    sid = key_of("source", clip.name, clip.sha256, width, height, clip.fps.numerator, clip.fps.denominator, frames,
                 CONVERSION_VERSION)
    out_dir = CACHE_DIR / "sources"
    out_dir.mkdir(parents=True, exist_ok=True)
    yuv = out_dir / f"{clip.name}_{width}x{height}_{frames}f_{sid[:10]}.yuv"
    expected = width * height * 3 // 2 * frames
    if not yuv.exists() or yuv.stat().st_size != expected:
        log(f"prepare source {clip.name} {width}x{height} {frames} frames")
        tmp = yuv.with_suffix(".tmp")
        vf = (f"scale={width}:{height}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_range=tv:"
              f"out_color_matrix=bt709,format=yuv420p")
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(clip.file), "-frames:v", str(frames),
               "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", str(tmp)]
        r = run(cmd)
        if r.returncode != 0:
            raise RuntimeError(f"source conversion failed for {clip.name}: {r.stderr.decode(errors='replace')}")
        got = tmp.stat().st_size
        if got != expected:
            frames = got // (width * height * 3 // 2)
            log(f"  {clip.name}: decoded {frames} frames, fewer than requested")
            sid = key_of("source", clip.name, clip.sha256, width, height, clip.fps.numerator, clip.fps.denominator,
                         frames, CONVERSION_VERSION)
            yuv = out_dir / f"{clip.name}_{width}x{height}_{frames}f_{sid[:10]}.yuv"
        tmp.replace(yuv)
    side = None
    if clip.sideinfo and clip.sideinfo.exists():
        side = scaled_sideinfo(clip, width, height, frames, sid)
    sx = width / clip.width
    sy = height / clip.height
    regions = [[int(r[0] * sx), int(r[1] * sy), int(r[2] * sx), int(r[3] * sy)] for r in clip.text_regions]
    return Source(clip=clip, path=yuv, width=width, height=height, fps=clip.fps, frames=frames, id=sid,
                  sideinfo=side, text_regions=regions)


def scaled_sideinfo(clip: Clip, width: int, height: int, frames: int, sid: str) -> Path:
    out = CACHE_DIR / "sources" / f"{clip.name}_{width}x{height}_{frames}f_{sid[:10]}.sideinfo.jsonl"
    if out.exists():
        return out
    sx = width / clip.width
    sy = height / clip.height
    lines = []
    with open(clip.sideinfo) as f:
        for i, line in enumerate(f):
            if i >= frames:
                break
            rec = json.loads(line)
            if sx != 1.0 or sy != 1.0:
                rec["dirty"] = [scale_rect(r, sx, sy, width, height) for r in rec.get("dirty", [])]
                if rec.get("cursor"):
                    rec["cursor"] = [int(round(rec["cursor"][0] * sx)), int(round(rec["cursor"][1] * sy))]
                scrolls = []
                for s in rec.get("scroll", []):
                    scrolls.append({"rect": scale_rect(s["rect"], sx, sy, width, height),
                                    "dx": int(round(s.get("dx", 0) * sx)), "dy": int(round(s.get("dy", 0) * sy))})
                rec["scroll"] = scrolls
            lines.append(json.dumps(rec, separators=(",", ":")))
    tmp = out.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.replace(out)
    return out


def scale_rect(r, sx, sy, width, height):
    x0 = int(math.floor(r[0] * sx))
    y0 = int(math.floor(r[1] * sy))
    x1 = min(width, int(math.ceil((r[0] + r[2]) * sx)))
    y1 = min(height, int(math.ceil((r[1] + r[3]) * sy)))
    return [x0, y0, max(0, x1 - x0), max(0, y1 - y0)]
