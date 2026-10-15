from ..corpus import Source
from .base import FFmpegAdapter, Point

CRF_LADDER = [18, 23, 28, 33]


def gop_args(src: Source, seconds: float = 2.0) -> list[str]:
    g = max(1, int(round(seconds * src.fps_float)))
    return ["-g", str(g), "-keyint_min", str(min(g, max(1, int(round(src.fps_float)))))]


class X264(FFmpegAdapter):
    codec = "libx264"
    family = "x264"
    reference = True
    speed_weight = 1

    def __init__(self, preset: str, tune: str | None = None, label: str | None = None, params: str = ""):
        self.preset = preset
        self.tune = tune
        self.params = params
        self.name = label or f"x264-{preset}" + (f"-{tune}" if tune else "")
        self.description = (f"libx264 preset {preset}" + (f", tune {tune}" if tune else "") +
                            (f", x264-params {params}" if params else "") + ", CRF ladder, 2 s GOP")
        self.ladder = [Point(f"crf{c}", {"crf": c}) for c in CRF_LADDER]

    def codec_args_template(self) -> list[str]:
        extra = ["-x264-params", self.params] if self.params else []
        return ["-preset", self.preset, "-tune", self.tune or "", *extra, "-crf", "{crf}", "-g", "2s", "-threads", "1|auto"]

    def codec_args(self, src: Source, params: dict, speed: bool) -> list[str]:
        args = ["-c:v", "libx264", "-preset", self.preset]
        if self.tune:
            args += ["-tune", self.tune]
        if self.params:
            args += ["-x264-params", self.params]
        args += ["-crf", str(params["crf"]), *gop_args(src), "-pix_fmt", "yuv420p",
                 "-threads", "0" if speed else "1"]
        return args


class OpenH264(FFmpegAdapter):
    codec = "libopenh264"
    family = "openh264"
    name = "openh264"
    description = "OpenH264 (the library Chrome uses for software H.264), bitrate mode, anchor-relative ladder, 2 s GOP"
    reference = True
    speed_weight = 1
    anchor_scale = [0.35, 0.6, 1.0, 1.7, 3.0]

    def codec_args_template(self) -> list[str]:
        return ["-rc_mode", "bitrate", "-b:v", "{kbps}", "-coder", "cavlc", "-g", "2s", "-threads", "1|auto"]

    def points(self, tier: str, src: Source, anchor_kbps: float | None = None) -> list[Point]:
        base = anchor_kbps or 0.03 * src.width * src.height * src.fps_float / 1000.0
        return [Point(f"x{s:g}", {"kbps": max(20, int(round(base * s)))}) for s in self.anchor_scale]

    def codec_args(self, src: Source, params: dict, speed: bool) -> list[str]:
        g = max(1, int(round(2.0 * src.fps_float)))
        return ["-c:v", "libopenh264", "-rc_mode", "bitrate", "-b:v", f"{params['kbps']}k", "-coder", "cavlc",
                "-g", str(g), "-allow_skip_frames", "0", "-threads", "0" if speed else "1"]
