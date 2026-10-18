"""Scenarios run on a worker thread. Pointer and keyboard input is injected there; ctx.js() runs on the Playwright thread."""

import math
import re
import subprocess
import time

from Xlib import X, display
from Xlib.ext import xtest


class ScenarioOutOfTime(Exception):
    pass


class Input:
    def __init__(self, disp, log, rng):
        self.disp = disp
        self.d = display.Display(disp)
        self.root = self.d.screen().root
        self.log = log
        self.rng = rng
        self.buttons_down = set()

    def pos(self):
        p = self.root.query_pointer()
        return p.root_x, p.root_y

    def _motion(self, x, y):
        xtest.fake_input(self.d, X.MotionNotify, x=int(x), y=int(y))
        self.d.sync()

    def warp(self, x, y):
        self._motion(round(x), round(y))
        self.log("warp", to=[round(x), round(y)])

    def move(self, x, y, dur=None, curve=None, hz=120.0, log=True):
        x0, y0 = self.pos()
        x, y = round(x), round(y)
        dist = math.hypot(x - x0, y - y0)
        if dist < 1:
            return
        if dur is None:
            dur = (0.16 + 0.12 * math.log2(1 + dist / 14.0)) * self.rng.uniform(0.85, 1.2)
        if curve is None:
            curve = self.rng.uniform(-0.22, 0.22)
        ux, uy = (x - x0) / dist, (y - y0) / dist
        nx, ny = -uy, ux
        b1 = curve * dist * self.rng.uniform(0.7, 1.3)
        b2 = curve * dist * self.rng.uniform(0.4, 1.0)
        p1 = (x0 + (x - x0) * 0.3 + nx * b1, y0 + (y - y0) * 0.3 + ny * b1)
        p2 = (x0 + (x - x0) * 0.72 + nx * b2, y0 + (y - y0) * 0.72 + ny * b2)
        steps = max(2, int(dur * hz))
        start = time.time()
        last = (x0, y0)
        for i in range(1, steps + 1):
            u = i / steps
            s = 10 * u**3 - 15 * u**4 + 6 * u**5
            m = 1 - s
            bx = m**3 * x0 + 3 * m * m * s * p1[0] + 3 * m * s * s * p2[0] + s**3 * x
            by = m**3 * y0 + 3 * m * m * s * p1[1] + 3 * m * s * s * p2[1] + s**3 * y
            pt = (round(bx), round(by))
            delay = start + u * dur - time.time()
            if delay > 0:
                time.sleep(delay)
            if pt != last:
                self._motion(*pt)
                last = pt
        if last != (x, y):
            self._motion(x, y)
        if log:
            self.log("move", frm=[x0, y0], to=[x, y], dur=round(dur, 3))

    def jiggle(self, radius=6, dur=0.6):
        x0, y0 = self.pos()
        tx = x0 + self.rng.uniform(-radius, radius)
        ty = y0 + self.rng.uniform(-radius, radius)
        self.move(tx, ty, dur=dur)

    def press(self, button=1):
        xtest.fake_input(self.d, X.ButtonPress, button)
        self.d.sync()
        self.buttons_down.add(button)
        self.log("button_down", button=button, at=list(self.pos()))

    def release(self, button=1):
        xtest.fake_input(self.d, X.ButtonRelease, button)
        self.d.sync()
        self.buttons_down.discard(button)
        self.log("button_up", button=button, at=list(self.pos()))

    def click(self, button=1, hold=None):
        self.press(button)
        time.sleep(hold if hold is not None else self.rng.uniform(0.06, 0.11))
        self.release(button)

    def double_click(self):
        self.click(hold=0.05)
        time.sleep(0.09)
        self.click(hold=0.05)

    def wheel(self, notches, delay=0.08, horizontal=False):
        if notches == 0:
            return
        if horizontal:
            button = 7 if notches > 0 else 6
        else:
            button = 5 if notches > 0 else 4
        for i in range(abs(notches)):
            xtest.fake_input(self.d, X.ButtonPress, button)
            xtest.fake_input(self.d, X.ButtonRelease, button)
            self.d.sync()
            if i + 1 < abs(notches):
                time.sleep(delay)
        self.log("wheel", notches=notches, delay=delay, horizontal=horizontal, at=list(self.pos()))

    def drag(self, x, y, dur=None, hold_before=0.18, hold_after=0.15):
        x0, y0 = self.pos()
        self.press(1)
        time.sleep(hold_before)
        sx = x0 + (6 if x > x0 else -6)
        self.move(sx, y0 + (3 if y > y0 else -3), dur=0.12, curve=0)
        self.move(x, y, dur=dur, curve=self.rng.uniform(-0.12, 0.12))
        time.sleep(hold_after)
        self.release(1)

    def xdo(self, *args):
        subprocess.run(["xdotool", *args], check=True, env={"DISPLAY": self.disp, "PATH": "/usr/bin:/bin"})

    def key(self, *keys, delay=40):
        self.xdo("key", "--delay", str(delay), *keys)
        self.log("key", keys=list(keys))

    def type(self, text, delay):
        if not text:
            return
        self.xdo("type", "--delay", str(int(delay)), "--", text)
        self.log("type", text=text, delay=int(delay))

    def release_all(self):
        for b in list(self.buttons_down):
            self.release(b)


TYPO_RE = re.compile(r"\[\[([^|\]]*)\|([^\]]*)\]\]")
PAUSE_RE = re.compile(r"<p:([0-9.]+)>")


class Ctx:
    def __init__(self, clip, inp, rng, js, t0, log):
        self.clip = clip
        self.inp = inp
        self.rng = rng
        self._js = js
        self.t0 = t0
        self.duration = clip.duration
        self.dsf = clip.dsf
        self.log = log
        self.end_margin = 1.4

    def t(self):
        return time.time() - self.t0

    def left(self):
        return self.t0 + self.duration - self.end_margin - time.time()

    def at(self, sec):
        delay = self.t0 + sec - time.time()
        if delay > 0:
            time.sleep(delay)

    def sleep(self, sec):
        if sec > 0:
            time.sleep(sec)

    def need(self, sec):
        if self.left() < sec:
            raise ScenarioOutOfTime(f"needed {sec:.2f}s at t={self.t():.2f}")

    def js(self, expr, arg=None):
        return self._js(expr, arg)

    def pt(self, expr, arg=None, dx=0, dy=0):
        r = self.js(expr, arg)
        if r is None:
            raise RuntimeError(f"page returned no point for {expr} {arg}")
        return (r[0] + dx) * self.dsf, (r[1] + dy) * self.dsf

    def move(self, x, y, **kw):
        self.need(0.3)
        self.inp.move(x, y, **kw)

    def move_css(self, x, y, **kw):
        self.move(x * self.dsf, y * self.dsf, **kw)

    def type_human(self, text, delay=(120, 250), punct_pause=(0.25, 0.7), hesitate=0.08, hesitate_pause=(0.4, 1.2)):
        """Type text word by word with `xdotool type --delay N`, N drawn per word.

        Markup: [[typed|correct]] types `typed`, pauses, backspaces the differing
        suffix and types the rest of `correct`; <p:SECONDS> pauses; "\\n" presses Return.
        """
        pos = 0
        parts = []
        for m in re.finditer(r"\[\[[^\]]*\]\]|<p:[0-9.]+>|\n", text):
            if m.start() > pos:
                parts.append(("text", text[pos : m.start()]))
            tok = m.group(0)
            if tok == "\n":
                parts.append(("enter", None))
            elif tok.startswith("<p:"):
                parts.append(("pause", float(PAUSE_RE.match(tok).group(1))))
            else:
                tm = TYPO_RE.match(tok)
                parts.append(("typo", (tm.group(1), tm.group(2))))
            pos = m.end()
        if pos < len(text):
            parts.append(("text", text[pos:]))
        for kind, val in parts:
            if kind == "pause":
                self.need(val)
                self.sleep(val)
            elif kind == "enter":
                self.need(0.5)
                self.inp.key("Return")
                self.sleep(self.rng.uniform(0.3, 0.8))
            elif kind == "typo":
                wrong, right = val
                k = 0
                while k < min(len(wrong), len(right)) and wrong[k] == right[k]:
                    k += 1
                d = self.rng.randint(*delay)
                self.need(len(wrong) * d / 1000 + 1.5 + len(right) * d / 1000)
                self.inp.type(wrong, d)
                self.sleep(self.rng.uniform(0.35, 0.8))
                self.inp.key(*(["BackSpace"] * (len(wrong) - k)), delay=self.rng.randint(90, 140))
                self.sleep(self.rng.uniform(0.15, 0.35))
                self.inp.type(right[k:], self.rng.randint(*delay))
            else:
                for chunk in re.findall(r"\S+\s*|\s+", val):
                    d = self.rng.randint(*delay)
                    self.need(len(chunk) * d / 1000 + 0.2)
                    self.inp.type(chunk, d)
                    if chunk.rstrip()[-1:] in ".,;:!?" and chunk.rstrip():
                        self.sleep(self.rng.uniform(*punct_pause))
                    elif self.rng.random() < hesitate:
                        self.sleep(self.rng.uniform(*hesitate_pause))

    def type_code(self, lines, lang, start_indent, delay=(55, 135), line_pause=(0.25, 0.9)):
        """Type source lines into the CodeEditor, compensating for its auto-indent."""
        cur = start_indent
        prev_text = None
        for idx, line in enumerate(lines):
            if idx > 0:
                self.need(0.6)
                self.inp.key("Return")
                indent = len(prev_text) - len(prev_text.lstrip(" ")) if prev_text.strip() else cur
                stripped = prev_text.rstrip()
                if (lang == "py" and stripped.endswith(":")) or (lang == "c" and stripped.endswith("{")):
                    indent += 4
                cur = indent
                self.sleep(self.rng.uniform(*line_pause))
            content = line.strip(" ")
            target = len(line) - len(line.lstrip(" ")) if content else cur
            if lang == "c" and content.startswith("}"):
                target += 4
            if target < cur:
                self.inp.key(*(["BackSpace"] * ((cur - target) // 4)), delay=70)
            elif target > cur:
                self.inp.key(*(["Tab"] * ((target - cur) // 4)), delay=70)
            cur = target
            if content:
                self.type_human(content, delay=delay, punct_pause=(0.05, 0.25), hesitate=0.05, hesitate_pause=(0.3, 0.9))
            prev_text = " " * cur + content if content else " " * cur
            if lang == "c" and content.startswith("}"):
                prev_text = " " * (cur - 4) + content
                cur -= 4

    def wander(self, until, region, dwell=(0.05, 0.35), seg=(120, 520)):
        x0, y0, x1, y1 = region
        while self.t() < until and self.left() > 0.8:
            cx, cy = self.inp.pos()
            ang = self.rng.uniform(0, 2 * math.pi)
            dist = self.rng.uniform(*seg)
            tx = min(max(cx + math.cos(ang) * dist, x0), x1)
            ty = min(max(cy + math.sin(ang) * dist, y0), y1)
            self.inp.move(tx, ty, curve=self.rng.uniform(-0.35, 0.35))
            self.sleep(self.rng.uniform(*dwell))


def css_rect(ctx, selector):
    return ctx.js(
        "(sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }",
        selector,
    )


def editor_point(ctx, line_index, col=999):
    return ctx.pt("([l, c]) => capEditor.pointFor(l, c)", [line_index, col])


def code_editor_common(ctx, lines, line_no, typing_delay):
    x, y = editor_point(ctx, line_no - 1)
    ctx.move(x + 40, y)
    ctx.sleep(0.25)
    ctx.inp.click()
    ctx.sleep(0.4)
    ctx.inp.key("End")
    ctx.sleep(0.3)
    ctx.inp.key("Return")
    ctx.sleep(0.25)
    ctx.inp.key("Return")
    ctx.sleep(0.35)
    ctx.inp.key("BackSpace")
    ctx.sleep(0.5)
    ctx.move(x + 260, y + 160 * ctx.dsf, dur=0.5)
    ctx.type_code(lines, "py", 0, delay=typing_delay)


def sc_slow_typing(ctx):
    ctx.at(1.0)
    x, y = ctx.pt("capEndOfText()")
    ctx.move(x + 3 * ctx.dsf, y)
    ctx.sleep(0.3)
    ctx.inp.click()
    ctx.sleep(0.6)
    ctx.inp.key("ctrl+End")
    ctx.sleep(0.5)
    ctx.move(x + 180, y + 110, dur=0.6)
    ctx.inp.key("Return")
    ctx.sleep(0.9)
    ctx.type_human("Next steps: run the pilot with three teams in November and collect [[feedbak|feedback]] weekly.<p:1.6>")
    ctx.need(6)
    cx, cy = ctx.pt("(() => { const r = document.querySelector('.comment').getBoundingClientRect(); return [r.left + 120, r.top + 40]; })()")
    ctx.move(cx, cy)
    ctx.sleep(1.1)
    ctx.inp.wheel(1)
    ctx.sleep(1.4)
    ctx.inp.wheel(-1)
    ctx.sleep(0.9)
    x, y = ctx.pt("capEndOfText()")
    ctx.move(x + 2 * ctx.dsf, y)
    ctx.sleep(0.25)
    ctx.inp.click()
    ctx.sleep(0.5)
    ctx.move(x + 150, y + 90, dur=0.5)
    ctx.type_human(" If it [[hods|holds]] up, we roll out in January.<p:1.2>")
    ctx.need(3)
    ctx.type_human(" Owner: Priya.")


def sc_code_editor(ctx):
    ctx.at(1.0)
    lines = [
        "def _normalize_ratio(ratio, lo=0.0, hi=1.0):",
        "    if hi <= lo:",
        '        raise ValueError("hi must be greater than lo")',
        "    return min(max((ratio - lo) / (hi - lo), 0.0), 1.0)",
    ]
    code_editor_common(ctx, lines, 42, (55, 135))
    ctx.sleep(0.6)
    ctx.inp.key("ctrl+s")
    ctx.at(max(ctx.t() + 0.8, 22.0))
    sx, sy = ctx.pt("(() => { const r = capEditor.scroller.getBoundingClientRect(); return [r.left + r.width * 0.45, r.top + r.height * 0.5]; })()")
    ctx.move(sx, sy)
    ctx.sleep(0.4)
    for n, d, pause in [(1, 0, 0.7), (1, 0, 0.6), (3, 0.045, 1.0), (5, 0.025, 1.2), (2, 0.11, 0.8)]:
        ctx.need(pause + 0.3)
        ctx.inp.wheel(n, delay=d)
        ctx.sleep(pause)
    for _ in range(3):
        ctx.need(1.0)
        ctx.inp.key("Next")
        ctx.sleep(0.85)
    ctx.need(2.0)
    ctx.inp.key(*(["Down"] * 6), delay=95)
    ctx.sleep(0.3)
    ctx.inp.key(*(["Right"] * 12), delay=45)
    ctx.sleep(0.5)
    ctx.need(1.5)
    ctx.inp.wheel(-4, delay=0.06)
    ctx.sleep(0.8)
    ctx.need(1.5)
    tx, ty = ctx.pt("(() => { const r = capEditor.scroller.getBoundingClientRect(); return [r.left + 330, r.top + 300]; })()")
    ctx.move(tx, ty)
    ctx.inp.click()
    ctx.sleep(0.7)
    ctx.need(1.2)
    ctx.inp.key("ctrl+Home")
    ctx.sleep(0.6)
    ctx.move(sx + 200, sy - 120)


def sc_text_scroll(ctx):
    ctx.at(1.0)
    ctx.move(940, 520)
    ctx.sleep(0.5)
    for gap in (0.9, 0.7, 1.1, 1.3):
        ctx.need(gap)
        ctx.inp.wheel(1)
        ctx.sleep(gap)
    ctx.sleep(0.8)
    ctx.inp.wheel(6, delay=0.018)
    ctx.sleep(1.6)
    ctx.inp.wheel(2, delay=0.07)
    ctx.sleep(1.0)
    link = ctx.js(
        "(() => { for (const a of document.querySelectorAll('#content p a')) { const r = a.getBoundingClientRect(); if (r.top > 260 && r.bottom < innerHeight - 280 && r.width > 40) return [r.left + r.width / 2, r.top + r.height / 2]; } return null; })()"
    )
    if link:
        ctx.move(link[0] * ctx.dsf, link[1] * ctx.dsf)
        ctx.sleep(1.6)
        ctx.move(link[0] * ctx.dsf + 260, link[1] * ctx.dsf - 160)
        ctx.sleep(0.6)
    sel = ctx.js(
        "(() => { for (const p of document.querySelectorAll('#content p')) { const r = p.getBoundingClientRect(); if (r.top > 200 && r.top < innerHeight - 300 && r.height > 60) { const rg = document.createRange(); rg.setStart(p.firstChild, 0); rg.setEnd(p.firstChild, 1); const a = rg.getBoundingClientRect(); return [a.left + 1, a.top + a.height / 2, r.left + r.width * 0.55, a.top + a.height * 1.5 + 4]; } } return null; })()"
    )
    if sel:
        ctx.need(3.5)
        ctx.move(sel[0] * ctx.dsf, sel[1] * ctx.dsf)
        ctx.sleep(0.3)
        ctx.inp.press(1)
        ctx.sleep(0.1)
        ctx.inp.move(sel[2] * ctx.dsf, sel[1] * ctx.dsf + 2, dur=0.7, curve=0.02)
        ctx.inp.move(sel[2] * ctx.dsf - 120, sel[3] * ctx.dsf, dur=0.35, curve=0.05)
        ctx.inp.release(1)
        ctx.sleep(1.3)
        ctx.move(sel[2] * ctx.dsf + 60, sel[3] * ctx.dsf + 60, dur=0.4)
        ctx.inp.click()
        ctx.sleep(0.6)
    ctx.need(6.0)
    ctx.js(
        "(() => { const start = scrollY, dist = 1400, dur = 4200, t0 = performance.now(); cap.event('smooth_scroll', {dist, dur}); function step(now) { const u = Math.min(1, (now - t0) / dur); const s = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; scrollTo(0, Math.round(start + dist * s)); if (u < 1) requestAnimationFrame(step); } requestAnimationFrame(step); })()"
    )
    ctx.sleep(4.6)
    for _ in range(2):
        ctx.need(1.4)
        ctx.inp.key("Next")
        ctx.sleep(1.3)
    ctx.need(2.0)
    ctx.inp.wheel(-8, delay=0.015)
    ctx.sleep(1.4)
    for n, d, pause in [(-3, 0.12, 0.9), (2, 0.3, 1.0), (1, 0, 0.6)]:
        ctx.need(pause + abs(n) * d + 0.2)
        ctx.inp.wheel(n, delay=d)
        ctx.sleep(pause)
    ctx.need(2.0)
    ctx.inp.wheel(10, delay=0.012)
    ctx.sleep(1.8)
    link = ctx.js(
        "(() => { for (const a of document.querySelectorAll('#content a')) { const r = a.getBoundingClientRect(); if (r.top > 300 && r.bottom < innerHeight - 300 && r.width > 40 && r.left > 470) return [r.left + r.width / 2, r.top + r.height / 2]; } return null; })()"
    )
    if link and ctx.left() > 3:
        ctx.move(link[0] * ctx.dsf, link[1] * ctx.dsf)
        ctx.sleep(1.5)
        ctx.move(link[0] * ctx.dsf - 200, link[1] * ctx.dsf + 220)
    ctx.sleep(0.5)
    ctx.need(1.0)
    ctx.inp.wheel(1)


def sc_slides(ctx):
    ctx.at(1.0)
    ctx.move(1700, 900, dur=0.8)
    ctx.at(2.6)
    k = 0
    plan = ["Right", "Right", "space", "Right", "click", "Right", "Left", "Right", "Right", "Right", "Right", "Right", "Right", "Right", "Right", "Right"]
    next_t = 2.6
    for action in plan:
        ctx.at(next_t)
        if ctx.left() < 0.9:
            break
        if action == "click":
            ctx.inp.click()
        else:
            ctx.inp.key(action)
        k += 1
        if k == 3:
            ctx.sleep(0.6)
            ctx.move(820, 560, dur=0.9)
            ctx.sleep(0.5)
            ctx.move(1180, 470, dur=0.7)
        if k == 9:
            ctx.sleep(0.8)
            ctx.move(1500, 860, dur=0.8)
        next_t += ctx.rng.uniform(2.6, 3.3) if action != "Left" else 1.1


def sc_busy_ui(ctx, long=True):
    def find(what):
        return ctx.js("(w) => capFind(w)", what)

    def go(what, dx=0, dy=0, dur=None):
        r = find(what)
        if r is None:
            raise RuntimeError(f"capFind({what}) returned null")
        ctx.move((r[0] + dx) * ctx.dsf, (r[1] + dy) * ctx.dsf, dur=dur, curve=ctx.rng.uniform(-0.3, 0.3))
        return r

    backlog = ctx.js("capCardsIn('backlog')")
    todo = ctx.js("capCardsIn('todo')")
    review = ctx.js("capCardsIn('review')")
    ctx.at(0.8)
    for cid in backlog[: 3 if long else 1]:
        go(f"card:{cid}", ctx.rng.uniform(-60, 60), ctx.rng.uniform(-15, 15))
        ctx.sleep(ctx.rng.uniform(0.1, 0.3))
    go("btn-filter")
    ctx.sleep(0.7 if long else 0.4)
    ctx.inp.click()
    ctx.sleep(0.35)
    for i in (0, 1, 2, 3, 2) if long else (0, 1, 2):
        go(f"menuitem:{i}", ctx.rng.uniform(-30, 30))
        ctx.sleep(ctx.rng.uniform(0.1, 0.25))
    ctx.inp.click()
    ctx.sleep(0.3)
    go(f"card:{todo[1]}", 40, -10)
    ctx.sleep(0.25)
    go(f"more:{todo[1]}")
    ctx.sleep(0.3)
    ctx.inp.click()
    ctx.sleep(0.3)
    for i in (0, 1, 2, 4, 3) if long else (0, 2, 1):
        go(f"menuitem:{i}", ctx.rng.uniform(-30, 30))
        ctx.sleep(ctx.rng.uniform(0.08, 0.22))
    ctx.inp.key("Escape")
    ctx.sleep(0.15)
    go(f"card:{backlog[1]}", -40, 0)
    ctx.sleep(0.2)
    target = find("col:progress")
    ctx.inp.drag(target[0] * ctx.dsf, (target[1] - target[3] / 2 + 150) * ctx.dsf, dur=1.1)
    ctx.sleep(0.4)
    if not long:
        go(f"card:{backlog[4]}", 30, 10)
        ctx.inp.wheel(3, delay=0.09)
        ctx.sleep(0.5)
        ctx.wander(ctx.t() + 0.8, (290, 200, 560, 1000), seg=(60, 200))
        ctx.inp.wheel(-2, delay=0.12)
        ctx.sleep(0.3)
    prog = ctx.js("capCardsIn('progress')")
    for cid in prog[1:4]:
        go(f"card:{cid}", ctx.rng.uniform(-70, 70), ctx.rng.uniform(-12, 12))
        ctx.sleep(ctx.rng.uniform(0.08, 0.25))
    go(f"card:{prog[2]}", -30, 4)
    ctx.sleep(0.2)
    ctx.inp.click()
    ctx.sleep(0.5)
    for i in (0, 1, 2, 3, 4, 2) if long else (0, 1, 2):
        go(f"prop:{i}", ctx.rng.uniform(-40, 60))
        ctx.sleep(ctx.rng.uniform(0.1, 0.3))
    ctx.inp.key("Escape")
    ctx.sleep(0.2)
    if not long:
        ctx.wander(ctx.duration, (300, 150, 1800, 1000))
        return
    go(f"card:{backlog[5]}", 30, 10)
    ctx.sleep(0.2)
    ctx.inp.wheel(3, delay=0.09)
    ctx.sleep(0.5)
    ctx.wander(ctx.t() + 1.2, (290, 200, 560, 1000), seg=(60, 200))
    ctx.inp.wheel(-2, delay=0.14)
    ctx.sleep(0.4)
    todo = ctx.js("capCardsIn('todo')")
    go(f"card:{todo[2]}", -20, 0)
    ctx.sleep(0.2)
    target = find("col:review")
    ctx.inp.drag(target[0] * ctx.dsf, (target[1] - target[3] / 2 + 230) * ctx.dsf, dur=1.2)
    ctx.sleep(0.4)
    go("colhead:review", 40, 0)
    ctx.sleep(0.2)
    ctx.inp.wheel(3, delay=0.1, horizontal=True)
    ctx.sleep(0.8)
    ctx.wander(ctx.t() + 1.0, (700, 200, 1800, 900))
    ctx.inp.wheel(-3, delay=0.12, horizontal=True)
    ctx.sleep(0.4)
    for k in ("team-issues", "team-cycles", "team-projects", "team-views", "nav-my", "nav-inbox"):
        if find(k):
            go(k, ctx.rng.uniform(-30, 40))
            ctx.sleep(ctx.rng.uniform(0.08, 0.2))
    if find("team-views"):
        go("team-views")
        ctx.inp.click()
        ctx.sleep(0.4)
    go("btn-display")
    ctx.sleep(0.6)
    ctx.inp.click()
    ctx.sleep(0.3)
    for i in (0, 1, 2, 1):
        go(f"menuitem:{i}", ctx.rng.uniform(-30, 30))
        ctx.sleep(ctx.rng.uniform(0.1, 0.25))
    ctx.inp.key("Escape")
    review = ctx.js("capCardsIn('review')")
    go(f"card:{review[0]}", -10, 0)
    ctx.sleep(0.15)
    target = find("col:done")
    ctx.inp.drag(target[0] * ctx.dsf, (target[1] - target[3] / 2 + 90) * ctx.dsf, dur=1.0)
    ctx.sleep(0.3)
    for k in ("btn-share", "btn-bell", "btn-new", "view-list", "view-board"):
        if ctx.left() < 1.2:
            break
        if find(k):
            go(k)
            ctx.sleep(0.6)
    ctx.wander(ctx.duration, (300, 150, 1800, 1000))


def sc_busy_ui_60(ctx):
    sc_busy_ui(ctx, long=False)


def sc_dashboard(ctx):
    ctx.at(1.2)

    def rect(sel):
        return css_rect(ctx, sel)

    c = rect(".chart canvas")
    ctx.move(c[0] + 90, c[1] + c[3] * 0.45)
    ctx.sleep(0.3)
    steps = 28
    for i in range(steps):
        ctx.inp.move(c[0] + 90 + (c[2] - 140) * (i + 1) / steps, c[1] + c[3] * (0.45 + 0.08 * math.sin(i / 4)), dur=0.17, curve=0, log=False)
    ctx.inp.log("sweep", what="rps chart")
    ctx.sleep(0.6)
    t = rect(".tbl tbody")
    ctx.move(t[0] + 260, t[1] + 12)
    for i in range(1, 9):
        ctx.inp.move(t[0] + 260 + ctx.rng.uniform(-20, 40), t[1] + 12 + i * 24, dur=0.35, curve=0.05, log=False)
        ctx.sleep(ctx.rng.uniform(0.15, 0.45))
    ctx.inp.log("sweep", what="table rows")
    ctx.move(t[0] + 900, t[1] + 300)
    ctx.at(max(ctx.t(), 17.5))
    lc = rect(".chart.r canvas")
    ctx.move(lc[0] + lc[2] - 30, lc[1] + lc[3] * 0.5)
    for i in range(22):
        ctx.inp.move(lc[0] + lc[2] - 30 - (lc[2] - 100) * (i + 1) / 22, lc[1] + lc[3] * (0.5 - 0.1 * math.sin(i / 3)), dur=0.18, curve=0, log=False)
    ctx.inp.log("sweep", what="latency chart")
    ctx.sleep(0.4)
    k = rect(".kpi")
    ctx.move(k[0] + 80, k[1] + 50)
    ctx.sleep(0.8)
    ctx.move(k[0] + k[2] * 2.2, k[1] + 45)
    ctx.sleep(0.8)
    ctx.move(1000, 640)
    ctx.at(max(ctx.t(), 31.0))
    f = rect(".feed")
    ctx.move(f[0] + 200, f[1] + 80)
    ctx.sleep(1.0)
    ctx.move(f[0] + 230, f[1] + 160, dur=0.9)
    ctx.sleep(0.8)
    r = rect("#range")
    ctx.move(r[0] + r[2] / 2, r[1] + r[3] / 2)
    ctx.sleep(1.0)
    ctx.move(r[0] - 260, r[1] + 300)


def sc_dark_mode(ctx):
    ctx.at(1.2)
    tr = ctx.js("(() => { const r = capTerm.scroller.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    ctx.move(tr[0] + 520, tr[1] + tr[3] - 60)
    ctx.sleep(0.6)
    ctx.inp.click()
    ctx.at(4.5)
    ctx.inp.key("ctrl+c")
    ctx.sleep(1.0)
    ctx.type_human("git status", delay=(70, 140), hesitate=0)
    ctx.sleep(0.3)
    ctx.inp.key("Return")
    ctx.sleep(2.0)
    ctx.type_human("make test", delay=(70, 140), hesitate=0)
    ctx.sleep(0.25)
    ctx.inp.key("Return")
    ctx.sleep(1.5)
    ex = editor_point(ctx, 124)
    ctx.move(ex[0] + 60, ex[1])
    ctx.sleep(4.0)
    ctx.inp.click()
    ctx.sleep(0.4)
    ctx.inp.key("End")
    ctx.sleep(0.3)
    ctx.inp.key("Return")
    ctx.sleep(0.4)
    ctx.type_human("state->wsize = 0;  /* force window reallocation */", delay=(60, 130), hesitate=0.04)
    ctx.sleep(0.6)
    ctx.inp.key("ctrl+s")
    ctx.sleep(0.6)
    er = ctx.js("(() => { const r = capEditor.scroller.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    ctx.move(er[0] + er[2] * 0.5, er[1] + er[3] * 0.4)
    ctx.inp.wheel(3, delay=0.09)
    ctx.sleep(0.9)
    ctx.inp.wheel(-2, delay=0.12)
    ctx.sleep(0.7)
    ctx.need(6)
    ctx.move(tr[0] + 600, tr[1] + tr[3] - 50)
    ctx.inp.click()
    ctx.sleep(0.5)
    ctx.type_human("./fuzz_inflate -max_len=4096 corpus/", delay=(55, 120), hesitate=0)
    ctx.sleep(0.4)
    ctx.inp.key("Return")
    ctx.sleep(1.0)
    ctx.move(tr[0] + 1100, tr[1] - 140, dur=0.9)


def sc_idle(ctx):
    ctx.at(0.8)
    ctx.js("capStart([10000, 28500, 45000])")
    for when, (x, y) in [(6.0, (1010, 560)), (19.5, (1180, 640)), (34.0, (930, 470)), (51.0, (1250, 820))]:
        ctx.at(when)
        ctx.move(x, y, dur=ctx.rng.uniform(0.7, 1.1))


def sc_webcam(ctx):
    def bubble():
        r = ctx.js("capWebcamRect()")
        return r[0] + r[2] / 2, r[1] + r[3] / 2

    ctx.at(1.2)
    bx, by = bubble()
    ctx.move(bx + 20, by - 10)
    ctx.sleep(0.4)
    ctx.inp.drag(1920 - 72 - 160 + 20, by - 10, dur=1.3)
    ctx.sleep(0.5)
    ctx.move(1000, 600)
    plan = [
        (6.0, "key"),
        (10.0, "key"),
        (13.0, ("drag", (1920 - 72 - 160, 72 + 160))),
        (17.5, "key"),
        (21.0, "key"),
        (24.0, ("drag", (72 + 160, 1080 - 72 - 160))),
        (28.5, "key"),
        (32.0, "key"),
        (35.0, ("drag", (72 + 160 + 40, 1080 - 72 - 160 - 300))),
    ]
    for when, action in plan:
        ctx.at(when)
        if ctx.left() < 1.0:
            break
        if action == "key":
            ctx.inp.key("Right")
            continue
        bx, by = bubble()
        ctx.move(bx + ctx.rng.uniform(-30, 30), by + ctx.rng.uniform(-30, 30))
        ctx.sleep(0.3)
        tx, ty = action[1]
        ctx.inp.drag(tx, ty, dur=ctx.rng.uniform(1.0, 1.4))
        ctx.sleep(0.4)
        ctx.move(ctx.rng.uniform(700, 1300), ctx.rng.uniform(400, 700))


def sc_code_4k(ctx):
    ctx.at(1.0)
    lines = [
        "def _normalize_ratio(ratio, lo=0.0, hi=1.0):",
        "    span = hi - lo",
        "    return min(max((ratio - lo) / span, 0.0), 1.0)",
    ]
    code_editor_common(ctx, lines, 42, (45, 110))
    ctx.sleep(0.5)
    ctx.inp.key("ctrl+s")
    ctx.sleep(0.5)
    sx, sy = ctx.pt("(() => { const r = capEditor.scroller.getBoundingClientRect(); return [r.left + r.width * 0.45, r.top + r.height * 0.5]; })()")
    ctx.move(sx, sy)
    for n, d, pause in [(1, 0, 0.6), (3, 0.05, 0.8), (5, 0.025, 0.9)]:
        ctx.need(pause + 0.3)
        ctx.inp.wheel(n, delay=d)
        ctx.sleep(pause)
    for _ in range(2):
        ctx.need(0.9)
        ctx.inp.key("Next")
        ctx.sleep(0.7)
    ctx.need(1.4)
    ctx.inp.key(*(["Down"] * 5), delay=90)
    ctx.inp.key(*(["Right"] * 8), delay=45)
    ctx.sleep(0.4)
    ctx.need(1.0)
    ctx.inp.wheel(-4, delay=0.06)


def sc_full_motion(ctx):
    for sec in [*range(0, ctx.duration, 5), ctx.duration - ctx.end_margin]:
        ctx.at(sec)
        ctx.log("video_stats", **ctx.js("capStats()"))


SCENARIOS = {
    "slow_typing": sc_slow_typing,
    "code_editor": sc_code_editor,
    "text_scroll": sc_text_scroll,
    "slides": sc_slides,
    "busy_ui": sc_busy_ui,
    "dashboard": sc_dashboard,
    "dark_mode": sc_dark_mode,
    "idle": sc_idle,
    "webcam_overlay": sc_webcam,
    "busy_ui_60fps": sc_busy_ui_60,
    "code_4k": sc_code_4k,
    "full_motion": sc_full_motion,
}
