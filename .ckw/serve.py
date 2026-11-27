"""serve.py <dir> <port> <log>: serves browser.html and the wavs from <dir> on localhost and appends
each /log?<text> to <log>. Scratch, never ships."""
import http.server, os, sys, time, urllib.parse

ROOT, PORT, LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/log":
            with open(LOG, "a") as f:
                f.write(f"{int(time.time() * 1000)} {urllib.parse.unquote(url.query)}\n")
            self.send_response(204)
            self.end_headers()
            return
        return super().do_GET()


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
