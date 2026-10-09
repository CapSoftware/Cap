import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "bench"
CORPUS_DIR = Path(os.environ.get("CAPCODEC_CORPUS", str(Path.home() / "work" / "corpus")))
CACHE_DIR = Path(os.environ.get("CAPCODEC_BENCH_CACHE", str(Path.home() / ".cache" / "capcodec-bench")))
OUT_DIR = Path(os.environ.get("CAPCODEC_BENCH_OUT", str(BENCH / "out")))
MANIFEST = Path(os.environ.get("CAPCODEC_MANIFEST", str(BENCH / "corpus" / "manifest.json")))
IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
EXE = ".exe" if IS_WINDOWS else ""


def tool(name: str) -> str:
    env = os.environ.get("CAPCODEC_" + name.upper())
    if env:
        return env
    local = Path.home() / "tools" / "bin" / (name + EXE)
    if local.exists():
        return str(local)
    found = shutil.which(name)
    return found or name


FFMPEG = tool("ffmpeg")
FFPROBE = tool("ffprobe")
LDECOD = tool("ldecod")
TESSERACT = tool("tesseract")


def ncores() -> int:
    env = os.environ.get("CAPCODEC_BENCH_JOBS")
    if env:
        return max(1, int(env))
    return os.cpu_count() or 1


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_file_hash_cache: dict[tuple[str, int, int], str] = {}


def sha256_file(path: Path) -> str:
    st = path.stat()
    key = (str(path), st.st_size, int(st.st_mtime_ns))
    hit = _file_hash_cache.get(key)
    if hit:
        return hit
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 22)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    _file_hash_cache[key] = digest
    return digest


def stable_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def key_of(*parts) -> str:
    return sha256_bytes(stable_json(parts).encode())[:32]


@dataclass
class RunResult:
    returncode: int
    wall_s: float
    cpu_s: float
    maxrss_mb: float
    stdout: bytes = b""
    stderr: bytes = b""


def run(cmd: list[str], cwd: Path | None = None, stdin_path: Path | None = None, stdout_path: Path | None = None,
        env: dict | None = None, timeout: float | None = None) -> RunResult:
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    stdout = open(stdout_path, "wb") if stdout_path else subprocess.PIPE
    t0 = time.perf_counter()
    try:
        proc = subprocess.run([str(c) for c in cmd], cwd=cwd, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE,
                              env={**os.environ, **(env or {})}, timeout=timeout)
        return RunResult(proc.returncode, time.perf_counter() - t0, 0.0, 0.0, proc.stdout or b"", proc.stderr or b"")
    finally:
        if stdin_path:
            stdin.close()
        if stdout_path:
            stdout.close()


def run_measured(cmd: list[str], cwd: Path | None = None, stdin_path: Path | None = None, stdout_path: Path | None = None,
                 env: dict | None = None, timeout: float | None = None) -> RunResult:
    """Runs a command and reports its wall time, CPU time (user+sys, including reaped children) and peak RSS."""
    if not hasattr(os, "wait4"):
        return _run_measured_psutil(cmd, cwd, stdin_path, stdout_path, env, timeout)
    import tempfile
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    stdout = open(stdout_path, "wb") if stdout_path else subprocess.PIPE
    errtmp = tempfile.TemporaryFile()
    outtmp = None if stdout_path else tempfile.TemporaryFile()
    t0 = time.perf_counter()
    try:
        proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, stdin=stdin, stdout=outtmp if outtmp else stdout,
                                stderr=errtmp, env={**os.environ, **(env or {})})
        deadline = None if timeout is None else t0 + timeout
        while True:
            pid, status, ru = os.wait4(proc.pid, os.WNOHANG)
            if pid != 0:
                break
            if deadline and time.perf_counter() > deadline:
                proc.kill()
                pid, status, ru = os.wait4(proc.pid, 0)
                break
            time.sleep(0.005)
        wall = time.perf_counter() - t0
        proc.returncode = os.waitstatus_to_exitcode(status)
        errtmp.seek(0)
        err = errtmp.read()
        out = b""
        if outtmp:
            outtmp.seek(0)
            out = outtmp.read()
        rss = ru.ru_maxrss / (1024.0 * 1024.0) if IS_MAC else ru.ru_maxrss / 1024.0
        return RunResult(proc.returncode, wall, ru.ru_utime + ru.ru_stime, rss, out, err)
    finally:
        errtmp.close()
        if outtmp:
            outtmp.close()
        if stdin_path:
            stdin.close()
        if stdout_path:
            stdout.close()


def _run_measured_psutil(cmd, cwd, stdin_path, stdout_path, env, timeout) -> RunResult:
    import psutil
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    stdout = open(stdout_path, "wb") if stdout_path else subprocess.PIPE
    t0 = time.perf_counter()
    try:
        proc = psutil.Popen([str(c) for c in cmd], cwd=cwd, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE,
                            env={**os.environ, **(env or {})})
        peak, cpu = 0.0, 0.0
        while proc.poll() is None:
            try:
                mi = proc.memory_info()
                peak = max(peak, mi.rss / (1024.0 * 1024.0))
                ct = proc.cpu_times()
                cpu = ct.user + ct.system
            except psutil.Error:
                pass
            if timeout and time.perf_counter() - t0 > timeout:
                proc.kill()
                break
            time.sleep(0.02)
        out, err = proc.communicate()
        return RunResult(proc.returncode, time.perf_counter() - t0, cpu, peak, out or b"", err or b"")
    finally:
        if stdin_path:
            stdin.close()
        if stdout_path:
            stdout.close()


def git_commit(path: Path = ROOT) -> str:
    try:
        out = subprocess.run(["git", "-C", str(path), "rev-parse", "--short=12", "HEAD"], capture_output=True, text=True)
        rev = out.stdout.strip() or "unknown"
        dirty = subprocess.run(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True)
        return rev + ("-dirty" if dirty.stdout.strip() else "")
    except OSError:
        return "unknown"


def ffmpeg_version() -> str:
    try:
        out = subprocess.run([FFMPEG, "-hide_banner", "-version"], capture_output=True, text=True)
        return out.stdout.splitlines()[0]
    except OSError:
        return "missing"


def log(msg: str) -> None:
    sys.stderr.write(time.strftime("%H:%M:%S ") + msg + "\n")
    sys.stderr.flush()


@dataclass
class Cache:
    root: Path = CACHE_DIR
    enabled: bool = True

    def dir(self, kind: str, key: str) -> Path:
        d = self.root / kind / key[:2] / key
        return d

    def get_json(self, kind: str, key: str) -> dict | None:
        if not self.enabled:
            return None
        p = self.dir(kind, key) / "result.json"
        if p.exists():
            try:
                return json.loads(p.read_text())
            except json.JSONDecodeError:
                return None
        return None

    def put_json(self, kind: str, key: str, obj: dict) -> None:
        d = self.dir(kind, key)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "result.json.tmp"
        tmp.write_text(json.dumps(obj, indent=1, sort_keys=True))
        tmp.replace(d / "result.json")
