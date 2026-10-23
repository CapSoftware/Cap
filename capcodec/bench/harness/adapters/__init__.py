import os
import shlex

from .base import Adapter
from .capcodec import Capcodec
from .hardware import hardware_adapters
from .x264 import OpenH264, X264


def registry() -> list[Adapter]:
    adapters: list[Adapter] = [
        X264("ultrafast"),
        X264("veryfast"),
        X264("medium"),
        X264("slow"),
        X264("medium", tune="stillimage"),
        X264("veryfast", tune="zerolatency"),
        OpenH264(),
    ]
    try:
        from .cap_baselines import cap_adapters
        adapters += cap_adapters()
    except ImportError:
        pass
    try:
        from .browser import browser_adapters
        adapters += browser_adapters()
    except ImportError:
        pass
    adapters += hardware_adapters()
    for preset in ("live", "fast", "medium", "slow"):
        adapters.append(Capcodec(preset, unchecked=True, label=f"capcodec-{preset}"))
    adapters.append(Capcodec("live", unchecked=True, extra=["--zerolatency"], label="capcodec-live-zerolatency"))
    for preset in ("live", "medium"):
        adapters.append(Capcodec(preset, unchecked=True, rate="bitrate", label=f"capcodec-{preset}-abr"))
    adapters.append(Capcodec("medium", unchecked=False, label="capcodec-medium-checked"))
    adapters.append(Capcodec("medium", unchecked=True, sideinfo=False, label="capcodec-medium-nosideinfo"))
    for spec in filter(None, os.environ.get("CAPCODEC_VARIANTS", "").split(";")):
        name, _, args = spec.partition(":")
        argv = shlex.split(args)
        preset = "medium"
        if "--preset" in argv:
            i = argv.index("--preset")
            preset = argv[i + 1]
            del argv[i:i + 2]
        adapters.append(Capcodec(preset, unchecked=True, extra=argv, label=f"capcodec-x-{name}"))
    for spec in filter(None, os.environ.get("X264_VARIANTS", "").split(";")):
        name, _, rest = spec.partition(":")
        preset, _, params = rest.partition(":")
        adapters.append(X264(preset or "veryfast", params=params, label=f"x264-x-{name}"))
    return adapters
