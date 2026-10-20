from ..corpus import Source
from .base import FFmpegAdapter, Point


def cap_bitrate(src: Source, bpp: float) -> int:
    fps = src.fps_float
    return int(src.width * src.height * (max(fps - 30.0, 0.0) * 0.6 + 30.0) * bpp)


def keyint(src: Source) -> int:
    return max(1, int(round(2.0 * src.fps_float)))


class CapX264(FFmpegAdapter):
    codec = "libx264"
    family = "cap"
    production = True
    speed_weight = 1
    weight = 4

    def __init__(self, name: str, description: str, ladder: list[Point], args_fn, max_height: int | None = None):
        self.name = name
        self.description = description
        self.ladder = ladder
        self.args_fn = args_fn
        self.max_height = max_height

    def codec_args_template(self) -> list[str]:
        return [self.description]

    def points(self, tier: str, src: Source) -> list[Point]:
        if self.max_height and src.height > self.max_height:
            return []
        return list(self.ladder)

    def codec_args(self, src: Source, params: dict, speed: bool) -> list[str]:
        return self.args_fn(src, params)


def ms_transcode(src: Source, p: dict) -> list[str]:
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(p["crf"]), "-pix_fmt", "yuv420p", "-level:v", "4.2"]


def ms_edit(src: Source, p: dict) -> list[str]:
    return ["-c:v", "libx264", "-preset", "fast", "-crf", str(p["crf"]), "-pix_fmt", "yuv420p"]


def export_x264(src: Source, p: dict) -> list[str]:
    b = cap_bitrate(src, p["bpp"])
    k = keyint(src)
    return ["-pix_fmt", "nv12", "-c:v", "libx264", "-preset", "veryfast", "-b:v", str(b), "-maxrate", str(b * 3 // 2),
            "-bf", "0", "-rc-lookahead", "10", "-aq-mode", "1", "-trellis", "0", "-g", str(k), "-keyint_min", str(k)]


def export_crf(src: Source, p: dict) -> list[str]:
    k = keyint(src)
    return ["-pix_fmt", "nv12", "-c:v", "libx264", "-preset", "slow", "-crf", str(p["crf"]), "-g", str(k),
            "-keyint_min", str(k)]


def rec_linux(src: Source, p: dict) -> list[str]:
    b = cap_bitrate(src, p["bpp"])
    k = keyint(src)
    return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", str(b), "-maxrate",
            str(b * 3 // 2), "-g", str(k), "-keyint_min", str(k), "-pix_fmt", "yuv420p"]


def rf_transcode(src: Source, p: dict) -> list[str]:
    return ["-fps_mode", "passthrough", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf",
            str(p["crf"]), "-bf", "0", "-force_key_frames", "expr:gte(t,n_forced*1)"]


def cap_adapters() -> list[FFmpegAdapter]:
    return [
        CapX264("cap-ms-transcode", "Media server processVideo: libx264 medium CRF 23, High@4.2, x264 default GOP and 3 B-frames",
                [Point(f"crf{c}", {"crf": c}, c == 23) for c in (18, 23, 28, 33)], ms_transcode, max_height=1088),
        CapX264("cap-ms-edit", "Media server edited render: libx264 fast CRF 18",
                [Point(f"crf{c}", {"crf": c}, c == 18) for c in (14, 18, 23, 28)], ms_edit),
        CapX264("cap-export-x264", "Desktop export default and render-farm libx264 override: veryfast ABR at Cap's bpp "
                "presets (Potato 0.04, Web 0.08, Social 0.15, Maximum 0.3), bf 0, rc-lookahead 10, trellis 0, 2 s GOP",
                [Point(f"bpp{b:g}", {"bpp": b}, b == 0.3) for b in (0.04, 0.08, 0.15, 0.3)], export_x264),
        CapX264("cap-export-crf", "Desktop export 'Optimize file size': libx264 slow CRF 24/28/32/36, 3 B-frames, 2 s GOP",
                [Point(f"crf{c}", {"crf": c}, c == 28) for c in (24, 28, 32, 36)], export_crf),
        CapX264("cap-rec-linux", "Desktop recording on Linux: libx264 ultrafast zerolatency ABR at bpp 0.3 (Balanced), "
                "2 s GOP; ladder adds Compat 0.15, 0.08 and Ultra-level 1.0",
                [Point(f"bpp{b:g}", {"bpp": b}, b == 0.3) for b in (0.08, 0.15, 0.3, 1.0)], rec_linux),
        CapX264("cap-rf-transcode", "Render-farm source transcode (libx264 override): veryfast CRF 18, bf 0, IDR every 1 s",
                [Point(f"crf{c}", {"crf": c}, c == 18) for c in (14, 18, 23, 28)], rf_transcode),
    ]


def recorder_bitrate(src: Source) -> int:
    px = src.width * src.height
    if px <= 1280 * 720:
        base = 2_500_000
    elif px <= 1920 * 1088:
        base = 4_000_000
    elif px <= 2560 * 1600:
        base = 6_000_000
    else:
        base = 10_000_000
    if src.fps_float > 40:
        base = int(round(base * 1.5))
    return base


def avc_level_codec(src: Source, bitrate: int) -> str:
    mbs = ((src.width + 15) // 16) * ((src.height + 15) // 16)
    levels = [(0x1F, 3600, 14_000_000), (0x20, 5120, 20_000_000), (0x28, 8192, 25_000_000),
              (0x29, 8192, 62_500_000), (0x2A, 8704, 62_500_000), (0x32, 22080, 168_750_000),
              (0x33, 36864, 300_000_000), (0x34, 36864, 300_000_000)]
    for lv, maxmb, maxbr in levels:
        if mbs <= maxmb and bitrate <= maxbr:
            return f"avc1.6400{lv:02X}"
    return "avc1.640034"


def mr_config(src: Source, p: dict) -> dict:
    return {"mimeType": 'video/mp4;codecs="avc1.64002A"',
            "videoBitsPerSecond": int(round(recorder_bitrate(src) * p["scale"])),
            "videoKeyFrameIntervalDuration": 2000}


def wc_config(src: Source, p: dict) -> dict:
    fps = src.fps_float
    bitrate = int(round(src.width * src.height * (max(fps - 30.0, 0.0) * 0.6 + 30.0) * p["bpp"]))
    return {"codec": avc_level_codec(src, bitrate), "width": src.width, "height": src.height, "bitrate": bitrate,
            "framerate": fps, "latencyMode": "quality", "hardwareAcceleration": "no-preference", "alpha": "discard",
            "avc": {"format": "annexb"}}


def mr_ladder(src: Source, anchor):
    return [Point(f"x{s:g}", {"scale": s}, s == 1.0) for s in (0.25, 0.5, 1.0, 1.6)]


def wc_ladder(src: Source, anchor):
    return [Point(f"bpp{b:g}", {"bpp": b}, b == 0.3) for b in (0.04, 0.08, 0.15, 0.3)]


def cap_browser_adapters():
    from .browser import BrowserAdapter
    return [
        BrowserAdapter("cap-web-recorder", "mediarecorder",
                       "PR 2312 web recorder (BR-MR-PR-SCREEN): MediaRecorder video/mp4 avc1.64002A, screen bitrate "
                       "tier (4 Mbit/s at 1080p30, x1.5 above 40 fps; high quality x1.6), 2 s keyframes, 1 s slices",
                       mr_config, mr_ladder, ext="mp4", key_interval_s=None, timeslice_ms=1000),
        BrowserAdapter("cap-browser-export", "webcodecs",
                       "PR 2312 browser export (BR-WC-EXPORT-PR): WebCodecs avc1.6400LL, bpp model (Maximum 0.3 ... "
                       "Potato 0.04), latencyMode quality, keyframe every 2 s",
                       wc_config, wc_ladder, key_interval_s=2.0),
    ]
