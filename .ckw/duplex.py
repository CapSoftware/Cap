"""duplex.py <wav> <output name part> <loops> [--exclusive] [--no-mic]: a stand-in native call app
(scratch, never ships). Records the default microphone (discarded) and plays the wav to one named
output through WASAPI, shared or exclusive, like a desktop call app set to a headset."""
import sys

import numpy as np
import sounddevice as sd
import soundfile as sf

path, want, loops = sys.argv[1], sys.argv[2].lower(), int(sys.argv[3])
exclusive = "--exclusive" in sys.argv
mic = "--no-mic" not in sys.argv
apis = sd.query_hostapis()
wasapi = next(i for i, a in enumerate(apis) if "WASAPI" in a["name"])
devices = sd.query_devices()
outputs = [(i, d) for i, d in enumerate(devices) if d["max_output_channels"] > 0 and d["hostapi"] == wasapi]
for i, d in outputs:
    print(f"output {i}: {d['name']} {d['default_samplerate']}", flush=True)
match = [i for i, d in outputs if want in d["name"].lower()]
if not match:
    print("NO DEVICE", want, flush=True)
    sys.exit(2)
out = match[0]
data, rate = sf.read(path, dtype="float32")
if data.ndim == 1:
    data = np.stack([data, data], axis=1)
data = np.tile(data, (loops, 1))
inp = None
if mic:
    default_in = apis[wasapi]["default_input_device"]
    inp = sd.InputStream(device=default_in, channels=1, samplerate=devices[default_in]["default_samplerate"],
                         callback=lambda *a: None)
    inp.start()
    print(f"mic open: {devices[default_in]['name']}", flush=True)
extra = sd.WasapiSettings(exclusive=True) if exclusive else None
dev_rate = int(devices[out]["default_samplerate"])
if dev_rate != rate:
    idx = np.linspace(0, len(data) - 1, int(len(data) * dev_rate / rate))
    data = np.stack([np.interp(idx, np.arange(len(data)), data[:, c]) for c in range(2)], axis=1).astype("float32")
for dtype in ("float32", "int16"):
    try:
        block = data if dtype == "float32" else (np.clip(data, -1, 1) * 32767).astype("int16")
        print(f"playing to {devices[out]['name']} exclusive={exclusive} {dtype} {dev_rate}", flush=True)
        sd.play(block, dev_rate, device=out, blocking=True, extra_settings=extra)
        break
    except Exception as e:  # an exclusive stream takes only the formats the device takes
        print(f"play {dtype} failed: {e}", flush=True)
if inp:
    inp.stop()
