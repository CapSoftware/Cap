"""Probe only: Windows flash + click stimulus.

  win-stimulus.py flash <seconds> <t0_epoch>
      fullscreen window, white for 150 ms at t0 + 1 + 2k
  win-stimulus.py click <seconds> <t0_epoch> <device substring>
      continuous WASAPI stream to the render endpoint whose name contains the
      substring, with a 20 ms 2 kHz click at the same instants. Samples are
      indexed from the wall clock, so when the endpoint is disabled and comes
      back the reopened stream keeps the clicks on the flashes.
"""

import ctypes
import sys
import time

LEAD = 1.0
PERIOD = 2.0

role, seconds, t0 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
if t0 <= 0:
    t0 = time.time()
end = t0 + LEAD + seconds
try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass


def flash():
    import tkinter as tk

    root = tk.Tk()
    root.title("cap-devswitch-stimulus")
    root.configure(bg="black", cursor="none")
    root.attributes("-fullscreen", True)
    root.attributes("-topmost", True)
    root.update()
    k = 0
    while time.time() < end:
        at = t0 + LEAD + k * PERIOD
        now = time.time()
        if now >= at:
            root.configure(bg="white")
            root.update()
            off = at + 0.15
            while time.time() < off:
                root.update()
                time.sleep(0.002)
            root.configure(bg="black")
            root.update()
            k += 1
        else:
            root.update()
            time.sleep(min(0.002, at - now))
    print("flashes", k, flush=True)


def click(sub):
    import numpy as np
    import sounddevice as sd

    while time.time() < end:
        try:
            sd._terminate()
            sd._initialize()
        except Exception:
            pass
        found = None
        for i, d in enumerate(sd.query_devices()):
            api = sd.query_hostapis(d["hostapi"])["name"]
            if d["max_output_channels"] > 0 and sub in d["name"] and api == "Windows WASAPI":
                found = (i, d)
                break
        if not found:
            time.sleep(0.25)
            continue
        index, dev = found
        rate = int(dev["default_samplerate"])
        channels = min(2, dev["max_output_channels"])
        n = rate // 50
        tone = (0.9 * np.exp(-np.arange(n) / rate * 200) * np.sin(2 * np.pi * 2000 * np.arange(n) / rate)).astype(np.float32)
        state = {"pos": None, "last": time.time()}

        def callback(outdata, frames, info, status):
            if state["pos"] is None:
                dac = time.time() + max(0.0, info.outputBufferDacTime - info.currentTime)
                state["pos"] = int(round((dac - t0) * rate))
            idx = np.arange(state["pos"], state["pos"] + frames)
            secs = idx / rate - LEAD
            phase = np.floor(np.mod(secs, PERIOD) * rate).astype(np.int64)
            hit = (secs >= 0) & (phase < n)
            sig = np.zeros(frames, dtype=np.float32)
            sig[hit] = tone[phase[hit]]
            outdata[:] = np.repeat(sig[:, None], outdata.shape[1], axis=1)
            state["pos"] += frames
            state["last"] = time.time()

        try:
            with sd.OutputStream(device=index, samplerate=rate, channels=channels, dtype="float32", callback=callback, latency="low"):
                print(f"click stream open on {dev['name']} at {time.time() - t0:.3f}", flush=True)
                while time.time() < end and time.time() - state["last"] < 0.75:
                    time.sleep(0.05)
        except Exception as e:
            print(f"click stream error {e!r} at {time.time() - t0:.3f}", flush=True)
        print(f"click stream closed at {time.time() - t0:.3f}", flush=True)
        time.sleep(0.25)


if role == "flash":
    flash()
else:
    click(sys.argv[4])
