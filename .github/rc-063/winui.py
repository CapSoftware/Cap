"""Win32 window helpers for the Windows scenarios."""

import ctypes
import ctypes.wintypes as wt

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass


def windows(pid=None):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def visit(hwnd, _):
        owner = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if pid is not None and owner.value != pid:
            return True
        title = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        kind = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, kind, 256)
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        found.append(
            {
                "hwnd": hwnd,
                "pid": owner.value,
                "title": title.value,
                "class": kind.value,
                "visible": bool(user32.IsWindowVisible(hwnd)),
                "minimized": bool(user32.IsIconic(hwnd)),
                "rect": (rect.left, rect.top, rect.right, rect.bottom),
            }
        )
        return True

    user32.EnumWindows(visit, 0)
    return found


def describe(entries):
    return "\n".join(
        f"hwnd={entry['hwnd']} pid={entry['pid']} visible={entry['visible']} minimized={entry['minimized']} "
        f"rect={entry['rect']} class={entry['class']!r} title={entry['title']!r}"
        for entry in entries
    )


def place(hwnd, x, y):
    user32.SetWindowPos(hwnd, 0, x, y, 0, 0, 0x0001 | 0x0004 | 0x0040)


def raise_window(hwnd):
    user32.ShowWindow(hwnd, 9)
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    user32.SetForegroundWindow(hwnd)


def rect(hwnd):
    area = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(area))
    return (area.left, area.top, area.right, area.bottom)


def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
