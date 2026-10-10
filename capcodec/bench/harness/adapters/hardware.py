import tempfile
from pathlib import Path

from ..common import FFMPEG, run
from ..corpus import Source
from .base import FFmpegAdapter, Point, ffmpeg_has_encoder

_probe_cache: dict[str, tuple[bool, str]] = {}


def probe_encoder(codec: str, extra: list[str]) -> tuple[bool, str]:
    if codec in _probe_cache:
        return _probe_cache[codec]
    if not ffmpeg_has_encoder(codec):
        _probe_cache[codec] = (False, f"ffmpeg has no {codec} encoder")
        return _probe_cache[codec]
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "probe.mp4"
        r = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i",
                 "testsrc2=size=1280x720:rate=30", "-frames:v", "10", "-pix_fmt", "yuv420p", *extra, "-c:v", codec,
                 "-b:v", "2M", str(out)], timeout=60)
        ok = r.returncode == 0 and out.exists() and out.stat().st_size > 0
        reason = "" if ok else (r.stderr.decode(errors="replace").strip().splitlines() or ["probe failed"])[-1]
    _probe_cache[codec] = (ok, reason)
    return _probe_cache[codec]


class HardwareEncoder(FFmpegAdapter):
    family = "hardware"
    weight = 2
    anchor_scale = [0.35, 0.6, 1.0, 1.7, 3.0]
    init_args: list[str] = []
    rc_args: list[str] = []

    def __init__(self, codec: str, name: str, description: str, rc_args: list[str], init_args: list[str] | None = None,
                 pix_fmt: str = "yuv420p"):
        self.codec = codec
        self.name = name
        self.description = description
        self.rc_args = rc_args
        self.init_args = init_args or []
        self.pix_fmt = pix_fmt

    def available(self) -> tuple[bool, str]:
        return probe_encoder(self.codec, self.init_args)

    def codec_args_template(self) -> list[str]:
        return [*self.init_args, *self.rc_args, "-b:v", "{kbps}", "-g", "2s", "-pix_fmt", self.pix_fmt]

    def points(self, tier: str, src: Source, anchor_kbps: float | None = None) -> list[Point]:
        base = anchor_kbps or 0.03 * src.width * src.height * src.fps_float / 1000.0
        return [Point(f"x{s:g}", {"kbps": max(50, int(round(base * s)))}) for s in self.anchor_scale]

    def codec_args(self, src: Source, params: dict, speed: bool) -> list[str]:
        g = max(1, int(round(2.0 * src.fps_float)))
        kbps = params["kbps"]
        return [*self.init_args, "-pix_fmt", self.pix_fmt, "-c:v", self.codec, *self.rc_args, "-b:v", f"{kbps}k",
                "-maxrate", f"{int(kbps * 1.5)}k", "-bufsize", f"{int(kbps * 2)}k", "-g", str(g)]


def hardware_adapters() -> list[HardwareEncoder]:
    return [
        HardwareEncoder("h264_nvenc", "nvenc", "NVIDIA NVENC H.264, VBR, preset p4, high profile",
                        ["-preset", "p4", "-rc", "vbr", "-profile:v", "high", "-bf", "0"]),
        HardwareEncoder("h264_videotoolbox", "videotoolbox", "Apple VideoToolbox H.264, ABR, high profile",
                        ["-profile:v", "high", "-allow_sw", "0", "-realtime", "1"]),
        HardwareEncoder("h264_qsv", "qsv", "Intel Quick Sync H.264, VBR, preset medium",
                        ["-preset", "medium", "-profile:v", "high"], pix_fmt="nv12"),
        HardwareEncoder("h264_amf", "amf", "AMD AMF H.264, VBR peak, quality",
                        ["-quality", "quality", "-rc", "vbr_peak", "-profile:v", "high"]),
        HardwareEncoder("h264_mf", "mediafoundation", "Windows Media Foundation H.264, hardware, quality rate control",
                        ["-hw_encoding", "1", "-rate_control", "quality"], pix_fmt="nv12"),
    ]
