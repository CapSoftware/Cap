#!/usr/bin/env python3
"""Cross-platform stimulus (Windows, Linux) for the OBS bench. Same code layout and output files as
bench/rig/stimulus.swift, so bench/rig/analyze.py reads its recordings unchanged.

stim.py --scene scroll|motion|still --out DIR [--hz N] [--duration S] [--stop-file F] [--beep]

Full-screen borderless window, SDL2 GPU renderer with vsync, one coded frame per refresh.
Writes DIR/stimulus.json (geometry, summary) and DIR/present.csv (idx,present_ns,target_ns), where
present_ns is time.perf_counter_ns() right after the vsynced present returned (system-wide QPC on
Windows, CLOCK_MONOTONIC on Linux). target_ns = present_ns. With --beep a 1 kHz 50 ms tone plays
right after every frame whose idx is a multiple of round(hz); DIR/beeps.csv logs idx,ns.
Stops on SIGTERM/SIGINT, when --stop-file appears, or after --duration.
"""
import argparse, json, os, random, signal, sys, time

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
os.environ.setdefault("SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS", "0")
os.environ.setdefault("SDL_WINDOWS_DPI_AWARENESS", "permonitorv2")
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
import pygame  # noqa: E402
from pygame._sdl2 import video  # noqa: E402


def crc8(v):
    crc = 0
    for b in ((v >> 16) & 0x3F, (v >> 8) & 0xFF, v & 0xFF):
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def code_bits(idx):
    return ((idx & 0x3FFFFF) << 8) | crc8(idx & 0x3FFFFF)


def document_surface(w, h, seed=7):
    rnd = random.Random(seed)
    s = pygame.Surface((w, h))
    s.fill((246, 246, 242))
    y = 0
    while y < h:
        if rnd.random() < 0.12:
            pygame.draw.rect(s, (30, 60, 120), (int(w * 0.1), y + 8, int(w * rnd.uniform(0.3, 0.6)), 22))
            y += 46
            continue
        x = int(w * 0.1)
        end = int(w * rnd.uniform(0.55, 0.9))
        while x < end:
            word = rnd.randint(int(w * 0.012), int(w * 0.05))
            g = rnd.randint(40, 90)
            pygame.draw.rect(s, (g, g, g), (x, y + 6, word, 10))
            x += word + int(w * 0.006)
        if rnd.random() < 0.05:
            pygame.draw.rect(s, (rnd.randint(80, 230), rnd.randint(80, 230), rnd.randint(80, 230)),
                             (int(w * 0.62), y, int(w * 0.25), int(h * 0.12)))
        y += 22
    return s


def motion_surfaces(w, h, n=6, seed=11):
    """Plasma-like gradient plus moving coloured noise blocks; every pixel changes every frame."""
    import numpy as np
    rnd = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    out = []
    for k in range(n):
        ph = k * 1.1
        r = 127 + 127 * np.sin(xx / 97.0 + ph) * np.cos(yy / 131.0 - ph)
        g = 127 + 127 * np.sin((xx + yy) / 157.0 + 2 * ph)
        b = 127 + 127 * np.cos(np.hypot(xx - w / 2, yy - h / 2) / 83.0 - ph)
        img = np.stack([r, g, b], axis=-1)
        noise = rnd.integers(0, 90, size=(h // 4 + 1, w // 4 + 1, 3)).repeat(4, 0).repeat(4, 1)[:h, :w]
        img = np.clip(img * 0.7 + noise, 0, 255).astype(np.uint8)
        out.append(pygame.surfarray.make_surface(img.swapaxes(0, 1)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="scroll")
    ap.add_argument("--out", required=True)
    ap.add_argument("--hz", type=float)
    ap.add_argument("--duration", type=float)
    ap.add_argument("--stop-file")
    ap.add_argument("--still-every", type=int, default=0)
    ap.add_argument("--beep", action="store_true")
    ap.add_argument("--display", type=int, default=0)
    ap.add_argument("--pace", type=int, default=None, help="1: software pacing at --hz (for outputs without vblank)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    pygame.init()
    if a.beep:
        pygame.mixer.init(frequency=48000, size=-16, channels=2, buffer=256)
    sizes = pygame.display.get_desktop_sizes()
    W, H = sizes[a.display]
    rates = []
    try:
        rates = pygame.display.get_desktop_refresh_rates()
    except Exception:
        pass
    disp_hz = float(rates[a.display]) if rates and rates[a.display] else 60.0
    hz = a.hz or disp_hz
    if sys.platform.startswith("linux"):
        win = video.Window("obsbench-stimulus", size=(W, H), position=(0, 0), fullscreen_desktop=True, always_on_top=True)
    else:
        win = video.Window("obsbench-stimulus", size=(W, H), position=(0, 0), borderless=True, always_on_top=True)
    ren = video.Renderer(win, accelerated=1, vsync=True)
    cell = round(H / 27.0)
    cx = round(W * 0.06)
    cy = round(H * 0.30)
    scene = a.scene
    if scene == "motion":
        surfs = motion_surfaces(W, H)
        texs = [video.Texture.from_surface(ren, s) for s in surfs]
    else:
        doc = document_surface(W, H * 2)
        doc_tex = video.Texture.from_surface(ren, doc)
    beep = None
    if a.beep:
        import numpy as np
        t = np.arange(int(48000 * 0.05)) / 48000.0
        tone = (np.sin(2 * np.pi * 1000 * t) * 0.6 * 32767).astype(np.int16)
        beep = pygame.sndarray.make_sound(np.stack([tone, tone], axis=-1).copy(order="C"))
    still_every = a.still_every or int(round(hz / 2))

    stop = {"v": False}

    def on_sig(*_):
        stop["v"] = True
    signal.signal(signal.SIGINT, on_sig)
    try:
        signal.signal(signal.SIGTERM, on_sig)
    except Exception:
        pass

    pres = open(os.path.join(a.out, "present.csv"), "w")
    pres.write("idx,present_ns,target_ns\n")
    beeps = open(os.path.join(a.out, "beeps.csv"), "w") if a.beep else None
    if beeps:
        beeps.write("idx,ns\n")
    header = {"scene": scene, "pid": os.getpid(), "hz_requested": int(round(hz)), "screen_max_fps": disp_hz,
              "display_index": a.display, "px_w": W, "px_h": H, "points_w": W, "points_h": H, "backing_scale": 1,
              "code": {"cell": cell, "x": cx, "y": cy, "cols": 10, "rows": 4, "cell_frac": cell / H,
                       "x_frac": cx / W, "y_frac": cy / H},
              "start_ns": time.perf_counter_ns(), "still_every": still_every, "scroll_px_per_s": H * 0.25,
              "platform": sys.platform, "renderer": "sdl2", "beep": bool(a.beep)}
    json.dump(header, open(os.path.join(a.out, "stimulus.json"), "w"), indent=1)

    def draw(idx, t):
        if scene == "motion":
            tex = texs[idx % len(texs)]
            off = (idx * 7) % 64
            tex.draw(srcrect=(off, 0, W - off, H), dstrect=(0, 0, W - off, H))
            tex.draw(srcrect=(0, 0, off, H), dstrect=(W - off, 0, off, H))
        else:
            sp = int(round(t * H * 0.25)) % H if scene == "scroll" else 0
            doc_tex.draw(srcrect=(0, sp, W, H), dstrect=(0, 0, W, H))
            if scene == "still":
                ren.draw_color = (200, 40, 40, 255)
                ren.fill_rect((int(W * 0.7), int(H * 0.7), int(W * 0.1), int(H * 0.1)))
        ren.draw_color = (128, 128, 128, 255)
        ren.fill_rect((cx - cell, cy - cell, cell * 12, cell * 6))
        bits = code_bits(idx)
        for col in range(10):
            v = 255 if col % 2 == 0 else 0
            ren.draw_color = (v, v, v, 255)
            ren.fill_rect((cx + col * cell, cy, cell, cell))
        for k in range(30):
            v = 255 if (bits >> (29 - k)) & 1 else 0
            ren.draw_color = (v, v, v, 255)
            ren.fill_rect((cx + (k % 10) * cell, cy + (1 + k // 10) * cell, cell, cell))

    presented = []
    idx = 0
    t_start = time.perf_counter()
    deadline = t_start + a.duration if a.duration else None
    ready = False
    next_still = 0.0
    pace = a.pace if a.pace is not None else sys.platform.startswith("linux")
    period = 1.0 / hz
    next_frame = None
    while not stop["v"]:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                stop["v"] = True
        if deadline and time.perf_counter() > deadline:
            break
        if a.stop_file and idx % 30 == 0 and os.path.exists(a.stop_file):
            break
        t = time.perf_counter() - t_start
        if scene == "still":
            if t < next_still:
                time.sleep(min(0.004, next_still - t))
                continue
            next_still += still_every / hz
        draw(idx, t)
        if pace and scene != "still":
            now = time.perf_counter()
            if next_frame is None or now - next_frame > period:
                next_frame = now
            elif now < next_frame:
                if next_frame - now > 0.002:
                    time.sleep(next_frame - now - 0.0015)
                while time.perf_counter() < next_frame:
                    pass
            next_frame += period
        ren.present()
        ns = time.perf_counter_ns()
        pres.write(f"{idx},{ns},{ns}\n")
        presented.append(ns)
        if beep is not None and idx > 0 and idx % int(round(hz)) == 0:
            beep.play()
            beeps.write(f"{idx},{time.perf_counter_ns()}\n")
        if not ready:
            print(f"stimulus ready scene={scene} px={W}x{H} hz={hz}", flush=True)
            ready = True
        idx += 1
        if idx % 120 == 0:
            pres.flush()
    pres.close()
    if beeps:
        beeps.close()
    iv = sorted((b - a_) / 1e6 for a_, b in zip(presented, presented[1:]))

    def pct(p):
        return iv[min(len(iv) - 1, int((len(iv) - 1) * p))] if iv else 0
    span = (presented[-1] - presented[0]) / 1e9 if len(presented) > 1 else 0
    nominal = 1000.0 / hz
    header["summary"] = {"submitted": idx, "presented": len(presented), "not_presented": 0,
                         "achieved_fps": (len(presented) - 1) / span if span else 0,
                         "interval_ms": {"p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99), "max": iv[-1] if iv else 0},
                         "intervals_over_1_5x": sum(1 for x in iv if x > nominal * 1.5)}
    json.dump(header, open(os.path.join(a.out, "stimulus.json"), "w"), indent=1)
    pygame.quit()


if __name__ == "__main__":
    main()
