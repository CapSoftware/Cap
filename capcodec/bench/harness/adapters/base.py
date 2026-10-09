from dataclasses import dataclass, field
from pathlib import Path

from ..common import FFMPEG, RunResult, ffmpeg_version, run, run_measured, sha256_file
from ..corpus import Source


@dataclass
class Point:
    label: str
    params: dict
    production: bool = False


@dataclass
class EncodeOutput:
    file: Path
    container: str
    run: RunResult
    recon: Path | None = None
    extra: dict = field(default_factory=dict)
    error: str | None = None


class Adapter:
    name = "base"
    family = "base"
    description = ""
    container = "mp4"
    weight = 1
    speed_weight = 0
    reference = False
    production = False
    notes = ""

    def available(self) -> tuple[bool, str]:
        return True, ""

    def identity(self) -> dict:
        raise NotImplementedError

    def points(self, tier: str, src: Source) -> list[Point]:
        raise NotImplementedError

    def encode(self, src: Source, point: Point, workdir: Path, speed: bool = False) -> EncodeOutput:
        raise NotImplementedError


_ffmpeg_identity: dict | None = None


def ffmpeg_identity() -> dict:
    global _ffmpeg_identity
    if _ffmpeg_identity is None:
        try:
            digest = sha256_file(Path(FFMPEG).resolve())
        except OSError:
            digest = "missing"
        _ffmpeg_identity = {"ffmpeg": ffmpeg_version(), "sha256": digest}
    return _ffmpeg_identity


_encoder_list: str | None = None


def ffmpeg_has_encoder(name: str) -> bool:
    global _encoder_list
    if _encoder_list is None:
        r = run([FFMPEG, "-hide_banner", "-encoders"])
        _encoder_list = r.stdout.decode(errors="replace")
    return f" {name} " in _encoder_list


COLOR_TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]


def raw_input_args(src: Source) -> list[str]:
    return ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{src.width}x{src.height}", "-r", src.fps_arg,
            *COLOR_TAGS, "-i", str(src.path), "-frames:v", str(src.frames)]


class FFmpegAdapter(Adapter):
    codec = "libx264"
    ladder: list[Point] = []
    out_ext = "mp4"
    mux_args: list[str] = ["-movflags", "+faststart"]

    def available(self) -> tuple[bool, str]:
        if not ffmpeg_has_encoder(self.codec):
            return False, f"ffmpeg has no {self.codec} encoder"
        return True, ""

    def identity(self) -> dict:
        return {"adapter": self.name, "codec": self.codec, "args": self.codec_args_template(), "input": "bt709-tagged-v2",
                **ffmpeg_identity()}

    def codec_args_template(self) -> list[str]:
        return []

    def codec_args(self, src: Source, params: dict, speed: bool) -> list[str]:
        raise NotImplementedError

    def points(self, tier: str, src: Source) -> list[Point]:
        return list(self.ladder)

    def encode(self, src: Source, point: Point, workdir: Path, speed: bool = False) -> EncodeOutput:
        out = workdir / f"out.{self.out_ext}"
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *raw_input_args(src),
               *self.codec_args(src, point.params, speed), "-an", *self.mux_args, str(out)]
        r = run_measured(cmd, cwd=workdir)
        err = None if r.returncode == 0 and out.exists() else (
            r.stderr.decode(errors="replace")[-2000:] or f"exit status {r.returncode}, no output")
        return EncodeOutput(file=out, container=self.out_ext, run=r, error=err, extra={"cmd": [str(c) for c in cmd]})
