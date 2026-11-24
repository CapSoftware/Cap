"""stub_server.py <port> <log file>

A local stand-in for the Cap web app's desktop meeting endpoints, so the real
app's cloud paths can run on a test box without staging, production or AI
providers. Every request is logged as one JSON line.

GET  /api/desktop/meetings/capabilities  -> transcription + notes on
POST /api/desktop/meetings/transcribe    -> fixed words spread over the clip,
                                            farm-style speaker letters by seq
POST /api/desktop/meetings/notes         -> SSE: title, deltas, done
POST /api/desktop/meetings/ask           -> SSE: deltas, done
anything else                            -> 200 {} (and logged)
"""
import http.server
import json
import struct
import sys
import time
import urllib.parse

PORT, LOG = int(sys.argv[1]), sys.argv[2]
NOTES = [
    "## Summary\n",
    "- The team walked through the scripted meeting on this test box.\n",
    "- Everyone agreed the recording, captions and speakers looked right.\n",
    "## Action items\n",
    "- Check the transcript against the script.\n",
]
ANSWER = ["The meeting ", "covered the scripted ", "discussion; ", "nothing was decided."]


def log(entry):
    entry["t"] = int(time.time() * 1000)
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def wav_seconds(body):
    # 16-bit or float WAV from the app: find the data chunk.
    try:
        rate = struct.unpack_from("<I", body, 24)[0]
        channels = struct.unpack_from("<H", body, 22)[0]
        bits = struct.unpack_from("<H", body, 34)[0]
        i = 12
        while i + 8 <= len(body):
            cid, size = body[i:i + 4], struct.unpack_from("<I", body, i + 4)[0]
            if cid == b"data":
                return size / (rate * channels * bits / 8)
            i += 8 + size
    except struct.error:
        pass
    return 0.0


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
            time.sleep(0.05)
        self.close_connection = True

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        log({"method": "GET", "path": url.path, "auth": bool(self.headers.get("Authorization"))})
        if url.path == "/api/desktop/meetings/capabilities":
            return self._json(200, {
                "transcription": True,
                "notes": True,
                "limits": {"maxClipSeconds": 30, "maxClipBytes": 4_000_000, "maxTranscriptChars": 400_000},
            })
        return self._json(200, {})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        entry = {"method": "POST", "path": url.path, "bytes": len(body),
                 "auth": bool(self.headers.get("Authorization"))}
        if url.path == "/api/desktop/meetings/transcribe":
            seconds = wav_seconds(body)
            seq = int(query.get("seq", ["0"])[0])
            session = query.get("session", [""])[0]
            entry.update(seconds=round(seconds, 2), seq=seq, session=session,
                         language=query.get("language", [""])[0])
            log(entry)
            words = []
            n = max(1, int(seconds * 2))
            letter = "AB"[seq % 2] if session else None
            for k in range(n):
                start = seconds * 1000 * k / n
                word = {"text": f"cloud{seq}w{k}", "startMs": start, "endMs": start + 300}
                if letter:
                    word["speaker"] = letter
                words.append(word)
            return self._json(200, {"text": " ".join(w["text"] for w in words), "words": words})
        try:
            request = json.loads(body or b"{}")
        except ValueError:
            request = {}
        if url.path == "/api/desktop/meetings/notes":
            transcript = json.dumps(request)
            entry.update(keys=sorted(request.keys()), transcriptChars=len(transcript))
            log(entry)
            return self._sse([("title", {"title": "Scripted meeting"})]
                             + [("delta", {"text": t}) for t in NOTES] + [("done", {})])
        if url.path == "/api/desktop/meetings/ask":
            entry.update(keys=sorted(request.keys()), question=str(request.get("question", ""))[:200])
            log(entry)
            return self._sse([("delta", {"text": t}) for t in ANSWER] + [("done", {})])
        log(entry)
        return self._json(200, {})


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
