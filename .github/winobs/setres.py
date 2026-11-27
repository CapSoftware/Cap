"""setres.py list | W H [HZ] : list display modes or switch the primary display (Windows, console session)."""
import ctypes, json, sys
from ctypes import wintypes

class DEVMODE(ctypes.Structure):
    _fields_ = [("dmDeviceName", wintypes.WCHAR * 32), ("dmSpecVersion", wintypes.WORD),
                ("dmDriverVersion", wintypes.WORD), ("dmSize", wintypes.WORD), ("dmDriverExtra", wintypes.WORD),
                ("dmFields", wintypes.DWORD), ("dmPositionX", ctypes.c_long), ("dmPositionY", ctypes.c_long),
                ("dmDisplayOrientation", wintypes.DWORD), ("dmDisplayFixedOutput", wintypes.DWORD),
                ("dmColor", ctypes.c_short), ("dmDuplex", ctypes.c_short), ("dmYResolution", ctypes.c_short),
                ("dmTTOption", ctypes.c_short), ("dmCollate", ctypes.c_short), ("dmFormName", wintypes.WCHAR * 32),
                ("dmLogPixels", wintypes.WORD), ("dmBitsPerPel", wintypes.DWORD), ("dmPelsWidth", wintypes.DWORD),
                ("dmPelsHeight", wintypes.DWORD), ("dmDisplayFlags", wintypes.DWORD),
                ("dmDisplayFrequency", wintypes.DWORD), ("dmICMMethod", wintypes.DWORD),
                ("dmICMIntent", wintypes.DWORD), ("dmMediaType", wintypes.DWORD), ("dmDitherType", wintypes.DWORD),
                ("dmReserved1", wintypes.DWORD), ("dmReserved2", wintypes.DWORD),
                ("dmPanningWidth", wintypes.DWORD), ("dmPanningHeight", wintypes.DWORD)]

u = ctypes.windll.user32
modes = set()
i = 0
dm = DEVMODE()
dm.dmSize = ctypes.sizeof(DEVMODE)
while u.EnumDisplaySettingsW(None, i, ctypes.byref(dm)):
    modes.add((dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency, dm.dmBitsPerPel))
    i += 1
cur = DEVMODE()
cur.dmSize = ctypes.sizeof(DEVMODE)
u.EnumDisplaySettingsW(None, -1, ctypes.byref(cur))
def detach_others():
    class DISPLAY_DEVICE(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("DeviceName", wintypes.WCHAR * 32), ("DeviceString", wintypes.WCHAR * 128),
                    ("StateFlags", wintypes.DWORD), ("DeviceID", wintypes.WCHAR * 128), ("DeviceKey", wintypes.WCHAR * 128)]
    out = []
    i = 0
    dd = DISPLAY_DEVICE()
    dd.cb = ctypes.sizeof(dd)
    while u.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
        attached = bool(dd.StateFlags & 0x1)
        primary = bool(dd.StateFlags & 0x4)
        out.append({"name": dd.DeviceName, "desc": dd.DeviceString, "attached": attached, "primary": primary})
        if attached and not primary:
            m = DEVMODE()
            m.dmSize = ctypes.sizeof(DEVMODE)
            m.dmFields = 0x20 | 0x80000 | 0x100000
            m.dmPelsWidth = 0
            m.dmPelsHeight = 0
            r = u.ChangeDisplaySettingsExW(dd.DeviceName, ctypes.byref(m), None, 0x1 | 0x10000000, None)
            out[-1]["detach_rc"] = r
        i += 1
    out.append({"apply_rc": u.ChangeDisplaySettingsExW(None, None, None, 0, None)})
    return out


def solo(name, w, h, hz):
    class DISPLAY_DEVICE(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("DeviceName", wintypes.WCHAR * 32), ("DeviceString", wintypes.WCHAR * 128),
                    ("StateFlags", wintypes.DWORD), ("DeviceID", wintypes.WCHAR * 128), ("DeviceKey", wintypes.WCHAR * 128)]
    out = []
    m = DEVMODE()
    m.dmSize = ctypes.sizeof(DEVMODE)
    m.dmFields = 0x20 | 0x80000 | 0x100000 | 0x400000
    m.dmPositionX = 0
    m.dmPositionY = 0
    m.dmPelsWidth, m.dmPelsHeight, m.dmDisplayFrequency = w, h, hz
    out.append({"primary": name, "rc": u.ChangeDisplaySettingsExW(name, ctypes.byref(m), None, 0x1 | 0x10 | 0x10000000, None)})
    i = 0
    dd = DISPLAY_DEVICE()
    dd.cb = ctypes.sizeof(dd)
    while u.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
        if dd.DeviceName != name and dd.StateFlags & 0x1:
            z = DEVMODE()
            z.dmSize = ctypes.sizeof(DEVMODE)
            z.dmFields = 0x20 | 0x80000 | 0x100000
            out.append({"detach": dd.DeviceName, "desc": dd.DeviceString,
                        "rc": u.ChangeDisplaySettingsExW(dd.DeviceName, ctypes.byref(z), None, 0x1 | 0x10000000, None)})
        i += 1
    out.append({"apply_rc": u.ChangeDisplaySettingsExW(None, None, None, 0, None)})
    return out


def attach(name, w, h, hz, x, y):
    m = DEVMODE()
    m.dmSize = ctypes.sizeof(DEVMODE)
    m.dmFields = 0x20 | 0x80000 | 0x100000 | (0x400000 if hz else 0)
    m.dmPositionX, m.dmPositionY = x, y
    m.dmPelsWidth, m.dmPelsHeight = w, h
    if hz:
        m.dmDisplayFrequency = hz
    r = u.ChangeDisplaySettingsExW(name, ctypes.byref(m), None, 0x1 | 0x10000000, None)
    return {"attach": name, "rc": r, "apply_rc": u.ChangeDisplaySettingsExW(None, None, None, 0, None)}


def modes_of(name):
    res = set()
    i = 0
    d = DEVMODE()
    d.dmSize = ctypes.sizeof(DEVMODE)
    while u.EnumDisplaySettingsW(name, i, ctypes.byref(d)):
        res.add((d.dmPelsWidth, d.dmPelsHeight, d.dmDisplayFrequency))
        i += 1
    return sorted(res)


def main():
    if sys.argv[1:2] == ["modes"]:
        print(json.dumps(modes_of(sys.argv[2])))
        return
    if sys.argv[1:2] == ["attach"]:
        a = sys.argv[2:]
        print(json.dumps(attach(a[0], int(a[1]), int(a[2]), int(a[3]), int(a[4]), int(a[5]))))
        return
    if sys.argv[1:2] == ["solo"]:
        print(json.dumps(solo(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))))
        return
    if sys.argv[1:2] == ["detach"]:
        print(json.dumps(detach_others()))
        return
    if len(sys.argv) < 3:
        print(json.dumps({"current": [cur.dmPelsWidth, cur.dmPelsHeight, cur.dmDisplayFrequency],
                          "modes": sorted(m for m in modes if m[3] == 32)}))
        return
    w, h = int(sys.argv[1]), int(sys.argv[2])
    hz = int(sys.argv[3]) if len(sys.argv) > 3 else None
    cur.dmPelsWidth, cur.dmPelsHeight = w, h
    cur.dmFields = 0x80000 | 0x100000
    if hz:
        cur.dmDisplayFrequency = hz
        cur.dmFields |= 0x400000
    r = u.ChangeDisplaySettingsW(ctypes.byref(cur), 1)
    print(json.dumps({"set": [w, h, hz], "rc": r}))


main()
