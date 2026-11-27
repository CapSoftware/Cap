"""Windows: launch Cap with the MSVC runtime removed from System32, the way a
clean Windows 11 install has it. Compares the shipped 0.6.3 installer with
the packaged 0.6.3 and main builds."""

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path

APPS = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
SHOTS = OUT / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
SYS32 = Path(os.environ["SystemRoot"]) / "System32"
DLLS = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll"]
result = {}


def all_windows():
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            if rect.right - rect.left > 1:
                found.append({"pid": owner.value, "title": buf.value, "w": rect.right - rect.left, "h": rect.bottom - rect.top})
        return True

    user32.EnumWindows(cb, 0)
    return found


def shot(name):
    from PIL import ImageGrab

    path = SHOTS / f"{name}.png"
    ImageGrab.grab(all_screens=True).save(path)
    return f"shots/{name}.png"


def dll_imports(exe):
    try:
        out = subprocess.run(["dumpbin", "/dependents", str(exe)], capture_output=True, text=True).stdout
        return [line.strip() for line in out.splitlines() if line.strip().lower().endswith(".dll")]
    except OSError:
        return None


def launch(name, exe):
    data = Path(tempfile.mkdtemp(prefix=f"msvc-{name}-"))
    (data / "store").write_text(json.dumps({"general_settings": {"hasCompletedOnboarding": True, "hasCompletedStartup": True, "enableTelemetry": False}}))
    env = dict(os.environ)
    env.update({"CAP_GPUI_APP_DATA_DIR": str(data), "CAP_GPUI_LOG_DIR": str(data / "logs"), "CAP_GPUI_RECORDINGS_DIR": str(data / "rec")})
    windir = os.environ["SystemRoot"]
    env["PATH"] = f"{windir}\\System32;{windir};{windir}\\System32\\Wbem;{windir}\\System32\\WindowsPowerShell\\v1.0"
    before = {w["title"] for w in all_windows()}
    t0 = time.monotonic()
    proc = subprocess.Popen([str(exe)], env=env, cwd=str(exe.parent))
    first = None
    while time.monotonic() - t0 < 25:
        mine = [w for w in all_windows() if w["pid"] == proc.pid and w["w"] > 200]
        if mine and first is None:
            first = round(time.monotonic() - t0, 3)
            time.sleep(3)
            break
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    time.sleep(2)
    new = [w for w in all_windows() if w["title"] not in before]
    entry = {
        "exe": str(exe),
        "first_window_s": first,
        "exit": proc.poll(),
        "new_windows": new,
        "shot": shot(f"msvc-{name}"),
        "local_runtime": sorted(p.name for p in exe.parent.glob("*.dll") if p.name.lower() in DLLS),
        "imports": dll_imports(exe),
    }
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    for w in new:
        if "Error" in w["title"]:
            subprocess.run(["taskkill", "/F", "/PID", str(w["pid"])], capture_output=True)
    time.sleep(1)
    return entry


def main():
    installer = Path(tempfile.gettempdir()) / "cap-063-setup.exe"
    got = subprocess.run(["curl.exe", "-fsSL", "--retry", "8", "--retry-all-errors", "--retry-delay", "5", "-A", "Mozilla/5.0", "-o", str(installer), "https://cdn.crabnebula.app/download/cap/cap/latest/platform/nsis-x86_64"])
    result["installer_download_exit"] = got.returncode
    if got.returncode == 0:
        subprocess.run([str(installer), "/S"], check=False, timeout=600)
    shipped = None
    for root in [Path(os.environ.get("LOCALAPPDATA", "")) / "Cap", Path(os.environ["ProgramFiles"]) / "Cap", Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Cap"]:
        if (root / "Cap.exe").exists():
            shipped = root / "Cap.exe"
    result["shipped_install"] = str(shipped)
    if shipped:
        version = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"(Get-Item '{shipped}').VersionInfo.ProductVersion"], capture_output=True, text=True
        ).stdout.strip()
        result["shipped_version"] = version
        result["shipped_dir_dlls"] = sorted(p.name for p in shipped.parent.glob("*.dll"))

    renamed = []
    try:
        for name in DLLS:
            path = SYS32 / name
            if path.exists():
                subprocess.run(["takeown", "/f", str(path)], capture_output=True)
                subprocess.run(["icacls", str(path), "/grant", "Administrators:F"], capture_output=True)
                os.rename(path, str(path) + ".rc064bak")
                renamed.append(name)
        result["removed_from_system32"] = renamed
        result["runtime_copies_on_runner_path"] = sorted(
            {str(Path(d) / n) for d in os.environ.get("PATH", "").split(os.pathsep) if d for n in DLLS if (Path(d) / n).exists()}
        )[:20]
        windir = Path(os.environ["SystemRoot"])
        result["runtime_left_on_minimal_path"] = [str(p / n) for p in (windir / "System32", windir) for n in DLLS if (p / n).exists()]
        result["system32_left"] = [n for n in DLLS if (SYS32 / n).exists()]
        if shipped:
            result["shipped_063"] = launch("shipped-063", shipped)
        for side in ("base", "head"):
            result[f"pkg_{side}"] = launch(f"pkg-{side}", APPS / side / "bin" / "cap-gpui.exe")
    finally:
        for name in renamed:
            os.rename(str(SYS32 / name) + ".rc064bak", SYS32 / name)
    (OUT / "msvc.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


main()
