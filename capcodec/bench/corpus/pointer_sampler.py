#!/usr/bin/env python3
"""Sample the X pointer position at a fixed rate and write JSON lines.

Each line is {"t": epoch_ms, "x": int, "y": int, "rtt": ms}. "t" is the
midpoint of the query_pointer round trip measured with time.time(), the same
clock that Chrome's Date.now() and ffmpeg's wallclock timestamps use.
Runs until SIGTERM/SIGINT.
"""

import argparse
import signal
import time

from Xlib import display


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--display", required=True)
    ap.add_argument("--hz", type=float, default=240.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    dpy = display.Display(args.display)
    root = dpy.screen().root
    stop = False

    def on_signal(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    period = 1.0 / args.hz
    with open(args.out, "w", buffering=1 << 16) as f:
        next_t = time.time()
        first = True
        while not stop:
            t0 = time.time()
            p = root.query_pointer()
            t1 = time.time()
            f.write(f'{{"t":{(t0 + t1) * 500.0:.3f},"x":{p.root_x},"y":{p.root_y},"rtt":{(t1 - t0) * 1000.0:.3f}}}\n')
            if first:
                f.flush()
                first = False
            next_t += period
            delay = next_t - time.time()
            if delay > 0:
                time.sleep(delay)
            else:
                next_t = time.time()


if __name__ == "__main__":
    main()
