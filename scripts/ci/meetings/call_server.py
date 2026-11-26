"""serve.py <meeting dir> <port> <log file> [--tls cert key]

Serves the stand-in call page for one scripted meeting: call.html (from this
script's directory) at any path, plus the meeting's truth.json and sys.wav.
POST /started?epoch=<ms> records when the page started the remote audio (the
harness lines the transcript up against the truth with it).
"""
import http.server
import os
import ssl
import sys
import threading
import urllib.parse

MEET, PORT, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
# The page posts /mic and /started at nearly the same moment, each on its own
# server thread. Windows appends by seeking to the end and then writing, so
# two unlocked writers can land on the same offset and one line overwrites
# the other's start ("started " lost, the audio offset with it).
LOG_LOCK = threading.Lock()


def log_line(line):
    with LOG_LOCK, open(LOG, "a") as log:
        log.write(line + "\n")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, path, kind):
        data = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        name = path.rsplit("/", 1)[-1]
        if name == "truth.json":
            return self._send(os.path.join(MEET, "truth.json"), "application/json")
        if name == "sys.wav":
            return self._send(os.path.join(MEET, "sys.wav"), "audio/wav")
        if name == "favicon.ico":
            self.send_response(404)
            self.end_headers()
            return
        return self._send(os.path.join(HERE, "call.html"), "text/html; charset=utf-8")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path.endswith("/mic"):
            log_line(f"mic {query.get('state', ['?'])[0]}")
        else:
            log_line(f"started {query.get('epoch', ['?'])[0]}")
        self.send_response(204)
        self.end_headers()


server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
if "--tls" in sys.argv:
    i = sys.argv.index("--tls")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(sys.argv[i + 1], sys.argv[i + 2])
    server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
