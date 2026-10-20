import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PAGE = Path(__file__).resolve().parent / "encode.html"


class JobState:
    def __init__(self, yuv: Path, frame_bytes: int, frames: int, out_dir: Path):
        self.yuv = yuv
        self.frame_bytes = frame_bytes
        self.frames = frames
        self.out_dir = out_dir
        self.uploads: dict[str, Path] = {}


class _Handler(BaseHTTPRequestHandler):
    server_version = "capcodec-bench"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if parts == ["encode.html"] or parts == [""]:
            self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            return
        if len(parts) == 3 and parts[0] == "frame":
            job = self.server.jobs.get(parts[1])
            if job is None:
                self._send(404, b"no job")
                return
            i = int(parts[2])
            if i < 0 or i >= job.frames:
                self._send(404, b"no frame")
                return
            with open(job.yuv, "rb") as f:
                f.seek(i * job.frame_bytes)
                data = f.read(job.frame_bytes)
            self._send(200, data)
            return
        self._send(404, b"not found")

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "upload":
            job = self.server.jobs.get(parts[1])
            if job is None:
                self._send(404, b"no job")
                return
            n = int(self.headers.get("Content-Length", "0"))
            name = Path(parts[2]).name
            out = job.out_dir / name
            remaining = n
            with open(out, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            job.uploads[name] = out
            self._send(200, b"ok", "text/plain")
            return
        self._send(404, b"not found")


class FrameServer:
    def __init__(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.jobs = {}
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def add(self, state: JobState) -> str:
        jid = uuid.uuid4().hex
        self.httpd.jobs[jid] = state
        return jid

    def remove(self, jid: str):
        self.httpd.jobs.pop(jid, None)


_server: FrameServer | None = None
_lock = threading.Lock()


def server() -> FrameServer:
    global _server
    with _lock:
        if _server is None:
            _server = FrameServer()
        return _server
