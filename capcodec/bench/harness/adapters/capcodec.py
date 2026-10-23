import json
import os
from pathlib import Path

from ..common import ROOT, run_measured, sha256_file
from ..corpus import Source
from .base import Adapter, EncodeOutput, Point
from .cap_baselines import cap_bitrate

QP_LADDER = [20, 25, 30, 35]
CRF_LADDER = [20, 24, 28, 32, 36, 40, 44]
CAP_BPP = [0.04, 0.08, 0.15, 0.3]


def default_binary(unchecked: bool = False) -> Path:
    env = os.environ.get("CAPCODEC_BIN_UNCHECKED" if unchecked else "CAPCODEC_BIN")
    if env:
        return Path(env)
    return ROOT / "build" / ("capcodec-unchecked" if unchecked else "capcodec")


class Capcodec(Adapter):
    family = "capcodec"
    speed_weight = 1

    def __init__(self, preset: str = "medium", unchecked: bool = False, output: str = "mp4", sideinfo: bool = True,
                 extra: list[str] | None = None, label: str | None = None, rate: str = "crf"):
        self.preset = preset
        self.unchecked = unchecked
        self.output = output
        self.use_sideinfo = sideinfo
        self.extra = extra or []
        self.rate = rate
        self.binary = default_binary(unchecked)
        suffix = "-unchecked" if unchecked else ""
        self.name = label or f"capcodec-{preset}{suffix}"
        self.description = f"capcodec preset {preset}" + (" (built with --unchecked)" if unchecked else "")
        if rate == "bitrate":
            self.description += ", bitrate mode at Cap's bpp targets (Potato 0.04 ... Maximum 0.3, maxrate 1.5x)"
        self.container = "annexb" if output == "264" else output

    def available(self) -> tuple[bool, str]:
        if not self.binary.exists():
            return False, f"{self.binary} not built (run bench/build_encoder.sh)"
        return True, ""

    def identity(self) -> dict:
        return {"adapter": "capcodec", "preset": self.preset, "binary": sha256_file(self.binary),
                "output": self.output, "sideinfo": self.use_sideinfo, "extra": self.extra, "rate": self.rate}

    def points(self, tier: str, src: Source) -> list[Point]:
        if self.rate == "crf":
            return [Point(f"crf{q}", {"crf": q}) for q in CRF_LADDER]
        if self.rate == "bitrate":
            return [Point(f"bpp{b:g}", {"bitrate": cap_bitrate(src, b) // 1000,
                                        "maxrate": cap_bitrate(src, b) * 3 // 2 // 1000}) for b in CAP_BPP]
        return [Point(f"qp{q}", {"qp": q}) for q in QP_LADDER]

    def encode(self, src: Source, point: Point, workdir: Path, speed: bool = False) -> EncodeOutput:
        out = workdir / f"out.{self.output}"
        recon = workdir / "recon.yuv"
        stats = workdir / "stats.json"
        cmd = [str(self.binary), "encode", "--input", str(src.path), "--width", str(src.width),
               "--height", str(src.height), "--fps", src.fps_arg, "--frames", str(src.frames),
               "--preset", self.preset, "--output", str(out), "--stats", str(stats)]
        for k, v in point.params.items():
            if v is True:
                cmd.append(f"--{k}")
            elif v is not False and v is not None:
                cmd += [f"--{k}", str(v)]
        if not speed:
            cmd += ["--recon", str(recon)]
            if "threads" not in point.params:
                cmd += ["--threads", "1"]
        if self.use_sideinfo and src.sideinfo:
            cmd += ["--sideinfo", str(src.sideinfo)]
        cmd += self.extra
        r = run_measured(cmd, cwd=workdir)
        err = None if r.returncode == 0 and out.exists() else (
            (r.stderr + r.stdout).decode(errors="replace")[-3000:] or f"exit status {r.returncode}, no output")
        extra = {"cmd": cmd}
        if stats.exists():
            try:
                extra["stats"] = json.loads(stats.read_text())
            except json.JSONDecodeError:
                pass
        return EncodeOutput(file=out, container=self.container, run=r, recon=recon if recon.exists() else None,
                            extra=extra, error=err)
