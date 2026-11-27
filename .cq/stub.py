"""stub.py <port> <log> <answer long|short|stream>: builder CQ's stand-in for the Cap web app.

A Cap Pro account with Cap AI on. POST /api/desktop/meetings/ask streams a fixed answer in small
deltas. Nothing here reaches a real Cap server or AI provider. One JSON line per request in <log>,
plus "ask_done" when the answer has been sent.
"""
import http.server
import json
import sys
import threading
import time
import urllib.parse

PORT, LOG, ANSWER = int(sys.argv[1]), sys.argv[2], sys.argv[3]
LIMITS = {"maxClipSeconds": 30, "maxClipBytes": 4_000_000, "maxTranscriptChars": 400_000}
NOTES = ["## Summary\n", "- The team walked through the scripted meeting.\n",
         "## Action items\n", "- Check the transcript against the script.\n"]
LONG = (
    "Subject: Follow-up: onboarding launch\n\n"
    "Hi Alex,\n\n"
    "We're set to launch the new onboarding next Tuesday. Here's a quick recap of next steps:\n\n"
    "- Sam will send the final welcome email copy by Thursday and share the setup-flow screenshots with the whole team before launch.\n"
    "- Alex will record the demo video on Monday, draft a short blurb for the newsletter and check it with support.\n"
    "  - The blurb should mention the new setup flow, the help docs link and the date the old screens go away for good.\n"
    "1. Priya will provide the new homepage banner by Wednesday, sized for both the light and the dark theme.\n"
    "2. We'll update the help docs the week after launch so they don't hold up the launch itself.\n"
    "- Full plan: https://example.com/onboarding/launch-plan/2026/week-48/final-checklist-with-owners-and-dates-v3\n"
    "- Run `cap launch --dry-run --all-regions --notify-support-team` before Tuesday's release window opens.\n\n"
    "Thanks,\n\n"
    "Sam"
)
SHORT = (
    "### Action items\n\n"
    "- Ana: share the designs by Thursday\n"
    "- Ben: follow up with legal\n"
    "- You: write down the pricing decision"
)
TEXT = {"long": LONG, "short": SHORT, "stream": "\n\n".join([LONG] * 3)}[ANSWER]
STEP = 0.02
LOCK = threading.Lock()


def log(entry):
    entry["t"] = int(time.time() * 1000)
    with LOCK:
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sse(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for name, data in events:
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()
            time.sleep(STEP)
        self.close_connection = True

    def _any(self, method):
        url = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        log({"method": method, "path": url.path, "auth": bool(self.headers.get("Authorization"))})
        if url.path == "/api/desktop/meetings/capabilities":
            return self._json(200, {"transcription": True, "notes": True, "limits": LIMITS})
        if url.path == "/api/desktop/plan":
            return self._json(200, {"upgraded": True})
        if url.path == "/api/desktop/organizations":
            return self._json(200, [])
        if url.path == "/api/desktop/meetings/notes" and method == "POST":
            return self._sse([("title", {"title": "Scripted meeting"})]
                             + [("delta", {"text": t}) for t in NOTES] + [("done", {})])
        if url.path == "/api/desktop/meetings/ask" and method == "POST":
            chunks = [TEXT[i:i + 6] for i in range(0, len(TEXT), 6)]
            self._sse([("delta", {"text": c}) for c in chunks] + [("done", {})])
            log({"event": "ask_done", "deltas": len(chunks)})
            return
        if url.path.startswith("/api/desktop/meetings/"):
            return self._json(503, {"error": "stub"})
        return self._json(200, {})

    def do_GET(self):
        self._any("GET")

    def do_POST(self):
        self._any("POST")


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
