"""Fixture Cap API for the iOS UI tests: python3 server.py [port]. Debug builds only accept it on localhost."""
import json, re, sys, os, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timedelta, timezone

KEY = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"
EMPTY_KEY = "1f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e"
UNLOCK_TOKEN = "sealed-unlock-token"
import random
random.seed(7)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4310
BASE = f"http://localhost:{PORT}"
# Point CAP_FIXTURE_MEDIA at real clips and thumbnails, or let ffmpeg generate stand-ins.
MEDIA = os.environ.get("CAP_FIXTURE_MEDIA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
def ensure_media():
    import subprocess
    os.makedirs(MEDIA, exist_ok=True)
    def ff(*args): subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)
    for name, seconds in (("demo.mp4", 12), ("long.mp4", 180)):
        if not os.path.exists(os.path.join(MEDIA, name)):
            ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=330", "-t", str(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", os.path.join(MEDIA, name))
    hues = {"london": "0x3a6ea5", "sf": "0xd98c3a", "monaco": "0x7a4fb5", "rome": "0xb5513a", "santorini": "0x2f8fd1", "miami": "0x2fb59a", "nyc": "0x5a6270", "liverpool": "0xa53a5e"}
    for name, color in hues.items():
        if not os.path.exists(os.path.join(MEDIA, f"{name}.webp")) and not os.path.exists(os.path.join(MEDIA, f"{name}.jpg")):
            ff("-f", "lavfi", "-i", f"color=c={color}:size=1280x720", "-frames:v", "1", os.path.join(MEDIA, f"{name}.jpg"))
now = datetime(2026, 10, 29, 17, 0, tzinfo=timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")

user = {"id": "user_richie", "name": "Richie", "lastName": "McIlroy", "email": "richie@cap.so", "imageUrl": None, "activeOrganizationId": "org_cap"}
orgs = [{"id": "org_cap", "name": "Cap", "iconUrl": None, "role": "owner"}, {"id": "org_acme", "name": "Acme Studio", "iconUrl": None, "role": "member"}]
spaces = [
    {"id": "org_cap", "name": "Cap", "iconUrl": None, "kind": "organization", "privacy": "Private", "role": "owner", "canManage": True, "hasPassword": False},
    {"id": "space_design", "name": "Design", "iconUrl": None, "kind": "space", "privacy": "Public", "role": "member", "canManage": True, "hasPassword": False},
    {"id": "space_eng", "name": "Engineering", "iconUrl": None, "kind": "space", "privacy": "Private", "role": None, "canManage": False, "hasPassword": False},
]
folders = [
    {"id": "folder_launch", "name": "Launch", "color": "blue", "parentId": None, "videoCount": 4},
    {"id": "folder_support", "name": "Support replies", "color": "yellow", "parentId": None, "videoCount": 12},
    {"id": "folder_internal", "name": "Internal", "color": "red", "parentId": None, "videoCount": 2},
]
titles = [
    ("london", "Walkthrough: the new Cap 0.6.2 editor", 312, 1840, 6, 14, None),
    ("sf", "Instant mode, recorded on iPhone", 94, 422, 2, 9, None),
    ("monaco", "Q4 roadmap review for the team", 1420, 96, 11, 3, None),
    ("rome", "Fixing the share page loading state", 188, 57, 0, 1, None),
    ("santorini", "Customer onboarding, step by step", 605, 2310, 18, 41, None),
    ("miami", "Uploading from Photos", 61, 0, 0, 0, {"uploaded": 0, "total": 0, "phase": "processing", "processingProgress": 62, "processingMessage": "Processing video", "processingError": None}),
    ("nyc", "Design critique: analytics charts", 742, 130, 7, 5, None),
    ("liverpool", "Bug report: export stalls at 99%", 47, 12, 1, 0, None),
]
def cap(i, t):
    img, title, dur, views, comments, reactions, upload = t
    created = now - timedelta(hours=3 + i * 19)
    return {"id": f"cap_{img}", "shareUrl": f"https://cap.so/s/cap_{img}", "title": title, "createdAt": iso(created), "updatedAt": iso(created), "ownerId": "user_richie" if i % 4 != 3 else "user_sam", "ownerName": "Richie McIlroy" if i % 4 != 3 else "Sam Rivera", "durationSeconds": dur, "thumbnailUrl": None if upload else f"{BASE}/api/mobile/caps/cap_{img}/thumbnail?v=1", "thumbnailCacheKey": None if upload else f"cap-thumbnail:cap_{img}:1", "folderId": None, "public": i % 3 != 2, "protected": i == 3, "viewCount": views, "commentCount": comments, "reactionCount": reactions, "upload": upload, "ownedByCurrentUser": i % 4 != 3}
caps = [cap(i, t) for i, t in enumerate(titles)]
LONG_TITLE = "An extremely long Cap title that keeps going to check wrapping on small iPhones: onboarding, billing, analytics, comments, reactions and the share page all in one recording (part 3 of 7)"
def extra(cid, title, img, dur, owner_me=False, **kw):
    c = cap(1, ("x", title, dur, 0, 0, 0, None))
    c.update({"id": cid, "shareUrl": f"https://cap.so/s/{cid}", "title": title, "thumbnailUrl": f"{BASE}/api/mobile/caps/{cid}/thumbnail?v=1", "thumbnailCacheKey": f"cap-thumbnail:{cid}:1", "ownerId": "user_richie" if owner_me else "user_sam", "ownerName": "Richie McIlroy" if owner_me else "Samantha Rivera-Oyelaran de la Cruz", "ownedByCurrentUser": owner_me, "viewCount": kw.pop("views", 1234567), "public": True})
    c["_img"] = img
    c.update(kw)
    return c
stress = [
    extra("cap_stress", LONG_TITLE, "santorini", 180, commentCount=180, reactionCount=300),
    extra("cap_locked", "Board update (password protected)", "monaco", 300, protected=True),
    extra("cap_restricted", "Restricted to acme.com", "nyc", 120),
    extra("cap_link", "Team update for the organization", "nyc", 120, owner_me=True, linkAccess="restricted", linkRestricted=True, _linkChoice=True),
    extra("cap_quiet", "Comments and reactions turned off", "rome", 95),
    extra("cap_shot", "Screenshot of the pricing page", "sf", 0, durationSeconds=None),
    extra("cap_limit", "Over the free plan limit", "liverpool", 61),
    extra("cap_rtl", "مراجعة التصميم الأسبوعية 第3回 デザインレビュー", "london", 180),
]
caps.extend(stress)
VIEWER = {"settings": {"disableSummary": False, "disableCaptions": False, "disableChapters": False, "disableReactions": False, "disableTranscript": False, "disableComments": False}, "defaultPlaybackSpeed": 1.2, "canDownload": True, "isScreenshot": False, "overShareLimit": False, "ownerImageUrl": None, "aiGenerationStatus": "COMPLETE"}
def viewer(cid):
    v = json.loads(json.dumps(VIEWER))
    if cid == "cap_quiet":
        v["settings"].update(disableComments=True, disableReactions=True, disableTranscript=True)
    if cid == "cap_shot": v["isScreenshot"] = True
    if cid == "cap_limit": v["overShareLimit"] = True
    if cid == "cap_miami": v["aiGenerationStatus"] = "PROCESSING"
    return v

def comment(cid, kind, content, ts, author, mins, parent=None):
    d = now - timedelta(minutes=mins)
    return {"id": cid, "videoId": "cap_london", "type": kind, "content": content, "timestamp": ts, "parentCommentId": parent, "createdAt": iso(d), "updatedAt": iso(d), "author": {"id": author[0], "name": author[1], "imageUrl": None}}
sam = ("user_sam", "Sam Rivera"); ana = ("user_ana", "Ana Ortiz"); me = ("user_richie", "Richie McIlroy")
comments = [
    comment("c1", "text", "The new timeline snapping feels so much better. Can we ship this in 0.6.2?", 42.5, sam, 180),
    comment("c2", "text", "Yes, it's in the release branch already.", None, me, 170, "c1"),
    comment("c3", "text", "Small thing: the zoom handles overlap the playhead at 1:12.", 72.0, ana, 95),
    comment("r1", "emoji", "🔥", 12.0, sam, 60), comment("r2", "emoji", "🔥", 30.0, ana, 50), comment("r3", "emoji", "👍", 50.0, sam, 40), comment("r4", "emoji", "🙌", 55.0, ana, 30),
]
people = [("user_sam", "Samantha Rivera-Oyelaran de la Cruz"), ("user_ana", "Ana Ortiz"), ("user_kenji", "健二 田中"), ("user_lea", "Léa Dubois"), ("user_omar", "عمر الفاروق"), ("user_richie", "Richie McIlroy"), ("user_null", None)]
bodies = ["Love this part!", "Can we cut the first 10 seconds? The intro drags a bit before you get to the actual demo and I think people will drop off.",
    "🔥🔥🔥", "See https://cap.so/pricing for the plan details and https://example.com/a/very/long/path/that/keeps/going/and/going?query=1",
    "هذا رائع جدا، شكرا على المشاركة", "これはとても分かりやすいです。ありがとうございます！", "Line one\nLine two\nLine three after a break",
    "W" * 300, "A paragraph that is long enough to wrap several times on the smallest iPhone screen. " * 6, "ok", "👍"]
def stress_comments(cid):
    out = []
    for i in range(140):
        who = people[i % len(people)]
        out.append({"id": f"s{i}", "videoId": cid, "type": "text", "content": bodies[i % len(bodies)], "timestamp": None if i % 9 == 0 else round(random.uniform(0, 180), 1), "parentCommentId": None, "createdAt": iso(now - timedelta(minutes=10000 - i * 60)), "updatedAt": iso(now), "author": {"id": who[0], "name": who[1], "imageUrl": None}})
    for i in range(40):
        who = people[(i + 3) % len(people)]
        parent = f"s{(i * 7) % 140}" if i % 5 else f"r{i - 1}" if i else "s1"
        out.append({"id": f"r{i}", "videoId": cid, "type": "text", "content": bodies[(i + 4) % len(bodies)], "timestamp": None, "parentCommentId": parent, "createdAt": iso(now - timedelta(minutes=5000 - i * 30)), "updatedAt": iso(now), "author": {"id": who[0], "name": who[1], "imageUrl": None}})
    emojis = ["😂", "😍", "😮", "🙌", "👍", "👎"]
    for i in range(300):
        t = round(min(179, max(0, random.gauss(95, 40))), 1)
        out.append({"id": f"e{i}", "videoId": cid, "type": "emoji", "content": emojis[int(random.random() ** 2 * 6)], "timestamp": t, "parentCommentId": None, "createdAt": iso(now - timedelta(minutes=300 - i)), "updatedAt": iso(now), "author": {"id": "user_ana", "name": "Ana Ortiz", "imageUrl": None}})
    return out
store = {"cap_london": None, "cap_stress": None}
def comments_for(cid):
    if cid not in store or store[cid] is None:
        store[cid] = list(comments) if cid == "cap_london" else stress_comments(cid) if cid in ("cap_stress", "cap_rtl") else []
    return store[cid]
LONG_SUMMARY = "**Overview.** " + "Richie walks through onboarding, billing and analytics in detail, covering edge cases customers hit most often. " * 8
LONG_CHAPTERS = [{"title": t, "start": i * 12} for i, t in enumerate(["Intro", "Signing up and verifying email", "Creating your first organization with a really long chapter title that wraps", "Inviting teammates", "Billing", "Seats and roles", "Analytics overview", "Top Caps", "Countries and cities", "Devices", "Comments", "Reactions", "Sharing settings", "Custom domains", "Wrap up"])]
detail_extra = {"summary": "Richie walks through the redesigned editor in Cap 0.6.2: faster timeline snapping, the new zoom handles, smarter auto zoom on cursor movement and a cleaner export flow. He finishes with a quick look at sharing straight from the editor.", "chapters": [{"title": "Intro and what's new", "start": 0}, {"title": "Timeline snapping", "start": 38}, {"title": "Zoom handles and auto zoom", "start": 96}, {"title": "Export and sharing", "start": 214}], "transcriptionStatus": "COMPLETE"}

def chart(n, hourly):
    pts = []
    import math
    for i in range(n):
        d = now - timedelta(hours=n - i) if hourly else now - timedelta(days=n - i)
        d = d.replace(minute=0, second=0, microsecond=0) if hourly else d.replace(hour=0, minute=0, second=0, microsecond=0)
        v = int(40 + 30 * math.sin(i / 2.2) + i * 3 + (i % 5) * 7)
        pts.append({"bucket": d.strftime("%Y-%m-%dT%H:%M:%SZ"), "caps": i % 3 == 0, "views": max(0, v), "comments": i % 4, "reactions": (i * 3) % 7})
    for p in pts: p["caps"] = int(p["caps"])
    return pts
def analytics(rng, single=False):
    n = {"24h": 24, "7d": 7, "30d": 30, "lifetime": 90}.get(rng, 7)
    pts = chart(n, rng == "24h")
    views = sum(p["views"] for p in pts)
    bd = lambda rows: [{"name": r[0], **({"subtitle": r[2]} if len(r) > 2 else {}), "views": int(views * r[1]), "percentage": r[1] * 100} for r in rows]
    return {"available": True, "data": {"capName": "Walkthrough" if single else "", "counts": {"caps": 0 if single else 48, "views": views, "comments": sum(p["comments"] for p in pts), "reactions": sum(p["reactions"] for p in pts)}, "chart": pts,
        "breakdowns": {"countries": bd([("US", .41), ("GB", .22), ("DE", .11), ("IN", .08), ("CA", .06), ("FR", .05)]), "cities": bd([("London", .19, "GB"), ("New York", .14, "US"), ("San Francisco", .11, "US"), ("Berlin", .08, "DE"), ("Toronto", .05, "CA")]),
        "browsers": bd([("Chrome", .58), ("Safari", .29), ("Firefox", .07), ("Edge", .06)]), "operatingSystems": bd([("macOS", .46), ("Windows", .28), ("iOS", .17), ("Android", .09)]), "devices": bd([("Desktop", .74), ("Mobile", .23), ("Tablet", .03)]),
        "topCaps": [] if single else [{"id": c["id"], "name": c["title"], "views": c["viewCount"], "percentage": 10} for c in sorted(caps, key=lambda c: -c["viewCount"])[:5]]}}}

def long_vtt(n):
    lines = ["Okay so this next part is about billing and seats.", "هذا الجزء عن الفوترة", "ここからは分析の話です。", "A much longer caption line that should wrap onto two lines on a small phone in portrait and stay readable.", "Short."]
    def ts(x): return f"{x//3600:02d}:{(x//60)%60:02d}:{x%60:02d}.000"
    return "WEBVTT\n\n" + "\n\n".join(f"{ts(i*6)} --> {ts(i*6+6)}\n{lines[i % len(lines)]}" for i in range(n))
VTT = "WEBVTT\n\n" + "\n\n".join(f"00:{(i*7)//60:02d}:{(i*7)%60:02d}.000 --> 00:{(i*7+7)//60:02d}:{(i*7+7)%60:02d}.000\n{t}" for i, t in enumerate([
    "Hey everyone, quick walkthrough of the new editor in Cap 0.6.2.", "The first thing you'll notice is the timeline.", "Clips now snap to each other and to the playhead.",
    "That makes trimming a lot faster, especially on longer recordings.", "Next up are the new zoom handles.", "You can drag them to change exactly when a zoom starts and ends.",
    "Auto zoom also follows your cursor more closely now.", "Finally, exporting and sharing.", "You can share a link straight from the editor.", "That's it. Let me know what you think in the comments."]))

# CAP_FIXTURE_SHOWCASE=1 swaps in clean demo content for App Store screenshots: a fictional team, realistic
# titles and no stress cases. Pair it with CAP_FIXTURE_MEDIA pointing at real thumbnails and clips.
if os.environ.get("CAP_FIXTURE_SHOWCASE"):
    user = {"id": "user_richie", "name": "Maya", "lastName": "Chen", "email": "maya@lumen.example", "imageUrl": None, "activeOrganizationId": "org_cap"}
    orgs = [{"id": "org_cap", "name": "Lumen", "iconUrl": None, "role": "owner"}, {"id": "org_acme", "name": "Acme Studio", "iconUrl": None, "role": "member"}]
    spaces = [
        {"id": "org_cap", "name": "All Lumen", "iconUrl": None, "kind": "organization", "privacy": "Private", "role": "owner", "canManage": True, "hasPassword": False},
        {"id": "space_design", "name": "Design", "iconUrl": None, "kind": "space", "privacy": "Public", "role": "member", "canManage": True, "hasPassword": False},
        {"id": "space_eng", "name": "Engineering", "iconUrl": None, "kind": "space", "privacy": "Private", "role": "member", "canManage": False, "hasPassword": False},
        {"id": "space_cs", "name": "Customer Success", "iconUrl": None, "kind": "space", "privacy": "Public", "role": "member", "canManage": False, "hasPassword": False},
    ]
    folders = [
        {"id": "folder_launch", "name": "Product updates", "color": "blue", "parentId": None, "videoCount": 6},
        {"id": "folder_support", "name": "Customer calls", "color": "yellow", "parentId": None, "videoCount": 12},
        {"id": "folder_internal", "name": "Onboarding", "color": "red", "parentId": None, "videoCount": 4},
    ]
    titles = [
        ("london", "Product update: the new editor", 312, 1840, 6, 14, None),
        ("sf", "Design review: share page", 214, 422, 4, 9, None),
        ("monaco", "Q4 roadmap walkthrough", 1420, 96, 11, 3, None),
        ("rome", "Setting up your workspace", 188, 357, 2, 6, None),
        ("santorini", "Recording your first Cap", 605, 2310, 18, 41, None),
        ("miami", "Customer call recap", 61, 0, 0, 0, {"uploaded": 0, "total": 0, "phase": "processing", "processingProgress": 62, "processingMessage": "Processing video", "processingError": None}),
        ("nyc", "Bug repro: export settings", 142, 130, 7, 5, None),
        ("liverpool", "Welcome to the team, Sam", 47, 212, 9, 22, None),
    ]
    _base_cap = cap
    def cap(i, t):
        c = _base_cap(i, t)
        if not c["ownedByCurrentUser"]: c["ownerName"] = "Jordan Lee"
        else: c["ownerName"] = "Maya Chen"
        return c
    caps = [cap(i, t) for i, t in enumerate(titles)]
    jordan = ("user_sam", "Jordan Lee"); priya = ("user_ana", "Priya Patel"); me = ("user_richie", "Maya Chen")
    comments = [
        comment("c1", "text", "The timeline snapping feels so much better. Can we ship this next week?", 42.5, jordan, 180),
        comment("c2", "text", "Yes, it's already in the release branch.", None, me, 170, "c1"),
        comment("c3", "text", "Small thing: the zoom handles overlap the playhead here.", 72.0, priya, 95),
        comment("c4", "text", "Auto zoom following the cursor is so good. Sharing this with the sales team.", 118.0, ("user_alex", "Alex Kim"), 40),
        comment("r1", "emoji", "🔥", 12.0, jordan, 60), comment("r2", "emoji", "🔥", 30.0, priya, 50), comment("r3", "emoji", "👍", 50.0, jordan, 40),
        comment("r4", "emoji", "🙌", 55.0, priya, 30), comment("r5", "emoji", "😍", 96.0, ("user_alex", "Alex Kim"), 20), comment("r6", "emoji", "🔥", 140.0, priya, 10),
    ]
    store = {"cap_london": None}
    detail_extra = {"summary": "Maya walks through the redesigned editor: faster timeline snapping, new zoom handles, smarter auto zoom that follows the cursor and a cleaner export flow. She finishes by sharing a link straight from the editor.", "chapters": [{"title": "What's new", "start": 0}, {"title": "Timeline snapping", "start": 38}, {"title": "Zoom handles and auto zoom", "start": 96}, {"title": "Export and sharing", "start": 214}], "transcriptionStatus": "COMPLETE"}
    VTT = VTT.replace("Hey everyone, quick walkthrough of the new editor in Cap 0.6.2.", "Hey everyone, quick walkthrough of the new editor.")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *a): sys.stderr.write("%s %s\n" % (self.command, self.path))
    def send(self, status, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def authed(self): return self.headers.get("Authorization") in (f"Bearer {KEY}", f"Bearer {EMPTY_KEY}")
    def empty(self): return self.headers.get("Authorization") == f"Bearer {EMPTY_KEY}"
    def raw_body(self):
        return self._raw
    def read_request_body(self):
        # Always drain the body so keep-alive connections stay in sync.
        n = int(self.headers.get("Content-Length") or 0)
        data = b""
        while len(data) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(data)))
            if not chunk: break
            data += chunk
        self._raw = data
    def body(self):
        return json.loads(self._raw or b"{}") if self._raw else {}
    def media(self, name):
        path = os.path.join(MEDIA, os.path.basename(name))
        if not os.path.exists(path): return self.send(404, {})
        data = open(path, "rb").read()
        ctype = {"mp4": "video/mp4", "webp": "image/webp", "jpg": "image/jpeg", "vtt": "text/vtt"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")
        rng = self.headers.get("Range")
        if rng and ctype == "video/mp4":
            m = re.match(r"bytes=(\d+)-(\d*)", rng); s = int(m.group(1)); e = int(m.group(2)) if m.group(2) else len(data) - 1
            return self.send(206, data[s:e+1], ctype, {"Content-Range": f"bytes {s}-{e}/{len(data)}", "Accept-Ranges": "bytes"})
        self.send(200, data, ctype, {"Accept-Ranges": "bytes"})
    def route(self):
        self.read_request_body()
        path = self.path.split("?")[0]; q = dict(p.split("=", 1) for p in self.path.split("?", 1)[1].split("&")) if "?" in self.path else {}
        if path.startswith("/upload/") and self.command == "PUT":
            data = self.raw_body(); UPLOADS[path[8:]] = len(data)
            sys.stderr.write(f"UPLOAD {path} {len(data)} bytes ct={self.headers.get('Content-Type')}\n")
            return self.send(200, b"", "text/plain")
        if path.startswith("/media/"):
            if path.endswith("long.vtt"): return self.send(200, long_vtt(30).encode(), "text/vtt")
            if path.endswith("transcript.vtt"): return self.send(200, VTT.encode(), "text/vtt")
            return self.media(path[7:])
        if path == "/api/mobile/session/config": return self.send(200, {"appleAuthAvailable": True, "googleAuthAvailable": True, "workosAuthAvailable": True})
        if path == "/api/mobile/session/email/request": return self.send(200, {"success": True})
        if path == "/api/mobile/session/email/verify":
            b = self.body()
            return self.send(200, {"type": "api_key", "apiKey": KEY, "userId": "user_richie"}) if b.get("code") == "123456" else self.send(403, {})
        if path == "/fixture/events":
            if self.command == "DELETE": EVENTS.clear()
            return self.send(200, {"batches": EVENTS})
        if not self.authed(): return self.send(401, {})
        if path == "/api/mobile/events" and self.command == "POST":
            b = self.body()
            EVENTS.append({"app": b.get("app"), "events": b.get("events", [])})
            return self.send(200, {"success": True})
        if self.empty() and path == "/api/mobile/caps": return self.send(200, {"folders": [], "caps": [], "page": 1, "limit": 30, "total": 0, "collectionTotal": 0, "hasMore": False})
        if self.empty() and path == "/api/mobile/bootstrap": return self.send(200, {"user": {**user, "id": "user_empty", "name": "Alexandria-Rose", "lastName": "Montgomery-Featherstonehaugh", "email": "alexandria.rose.montgomery@an-unusually-long-company-domain.example.com"}, "organizations": [{"id": "org_x", "name": "A Very Long Organization Name That Goes On And On Ltd.", "iconUrl": None, "role": "member"}], "activeOrganizationId": "org_x", "rootFolders": [], "spaces": []})
        if self.empty() and path == "/api/mobile/analytics": return self.send(200, {"available": False, "data": None})
        if self.empty() and path == "/api/desktop/plan": return self.send(200, {"upgraded": False, "stripeSubscriptionStatus": None})
        if path == "/api/mobile/uploads" and self.command == "POST":
            b = self.body(); vid = f"cap_up{len(UPLOADS)}"
            return self.send(200, {"id": vid, "shareUrl": f"https://cap.so/s/{vid}", "rawFileKey": f"user_richie/{vid}/raw-upload.mp4", "upload": {"type": "put", "url": f"{BASE}/upload/{vid}", "headers": {"Content-Type": b.get("contentType", "video/mp4")}}})
        m2 = re.match(r"^/api/mobile/uploads/([A-Za-z0-9_-]+)/(progress|complete)$", path)
        if m2:
            b = self.body(); sys.stderr.write(f"UPLOAD-{m2.group(2).upper()} {m2.group(1)} {json.dumps(b)}\n")
            return self.send(200, {"success": True})
        if path == "/api/mobile/imports/loom":
            b = self.body(); sys.stderr.write(f"LOOM {json.dumps(b)}\n")
            return self.send(200, {"id": "cap_loom1", "shareUrl": "https://cap.so/s/cap_loom1"})
        m3 = re.match(r"^/api/mobile/comments/([A-Za-z0-9_-]+)$", path)
        if m3 and self.command == "DELETE":
            for lst in store.values():
                if lst: lst[:] = [c for c in lst if c["id"] != m3.group(1) and c.get("parentCommentId") != m3.group(1)]
            return self.send(200, {"success": True})
        if path == "/api/mobile/bootstrap": return self.send(200, {"user": user, "organizations": orgs, "activeOrganizationId": "org_cap", "rootFolders": folders, "spaces": spaces})
        if path == "/api/desktop/plan": return self.send(200, {"upgraded": True, "stripeSubscriptionStatus": "active"})
        if path == "/api/mobile/caps":
            items = [{k: val for k, val in c.items() if not k.startswith("_")} for c in (caps if "folderId" not in q else caps[:3])]
            return self.send(200, {"folders": [] if "folderId" in q else folders, "caps": items, "page": 1, "limit": 30, "total": len(items), "collectionTotal": len(items), "hasMore": False})
        if path == "/api/mobile/caps/statuses": return self.send(200, {"caps": [{"id": "cap_miami", "upload": caps[5]["upload"]}]})
        if path == "/api/mobile/analytics": return self.send(200, analytics(q.get("range", "7d")))
        if path == "/api/mobile/user/push-tokens" and self.command == "POST":
            b = self.body()
            if not re.fullmatch(r"[0-9a-fA-F]{32,200}", str(b.get("token", ""))) or b.get("environment") not in ("sandbox", "production"): return self.send(400, {})
            PUSH_TOKENS[b["token"].lower()] = b["environment"]
            return self.send(200, {"success": True})
        if path == "/api/mobile/user/push-tokens/remove" and self.command == "POST":
            PUSH_TOKENS.pop(str(self.body().get("token", "")).lower(), None)
            return self.send(200, {"success": True})
        if path == "/fixture/push-tokens": return self.send(200, PUSH_TOKENS)
        if path == "/api/mobile/user/notification-preferences":
            if self.command == "PATCH":
                time.sleep(random.uniform(0, 0.3))  # lets concurrent saves finish out of order
                NOTIFICATIONS.update({k: v for k, v in self.body().items() if k in NOTIFICATIONS and isinstance(v, bool)})
            return self.send(200, NOTIFICATIONS)
        if path == "/api/mobile/organization/settings": return self.send(200, {"id": "org_cap", "name": orgs[0]["name"], "role": "owner", "canManage": True, "iconUrl": None, "allowedEmailDomain": "cap.so", "customDomain": "videos.cap.so", "domainVerified": True})
        for done in [k for k, v in EDITS.items() if v["until"] <= datetime.now(timezone.utc).timestamp()]:
            edited = next((x for x in caps if x["id"] == done), None)
            if edited and edited.get("upload") and edited["upload"].get("processingMessage") == "Applying your edit": edited["upload"] = None
        m = re.match(r"^/api/mobile/caps/([A-Za-z0-9_-]+)(/.*)?$", path)
        if m:
            cid, sub = m.group(1), m.group(2) or ""
            c = next((c for c in caps if c["id"] == cid), None)
            if not c: return self.send(404, {})
            unlocked = self.headers.get("X-Cap-Video-Access") == UNLOCK_TOKEN
            if sub == "/access":
                if cid == "cap_locked": return self.send(200, {"status": "granted" if unlocked else "password_required"})
                if cid == "cap_restricted": return self.send(200, {"status": "restricted"})
                return self.send(200, {"status": "granted"})
            if sub == "/unlock":
                b = self.body()
                return self.send(200, {"accessToken": UNLOCK_TOKEN, "expiresAt": "2099-01-01T00:00:00.000Z"}) if cid == "cap_locked" and b.get("password") == "letmein" else self.send(403, {})
            if cid == "cap_restricted" or (cid == "cap_locked" and not unlocked): return self.send(403, {})
            if sub == "/views": sys.stderr.write(f"VIEW {cid} {self.body()}\n"); return self.send(200, {"success": True})
            if sub in ("/comments", "/reactions") and self.command == "POST":
                b = self.body(); lst = comments_for(cid)
                nc = {"id": f"n{len(lst)}_{random.randint(0, 9999)}", "videoId": cid, "type": "text" if sub == "/comments" else "emoji", "content": b.get("content", ""), "timestamp": b.get("timestamp"), "parentCommentId": b.get("parentCommentId"), "createdAt": iso(datetime.now(timezone.utc)), "updatedAt": iso(datetime.now(timezone.utc)), "author": {"id": "user_richie", "name": "Richie McIlroy", "imageUrl": None}}
                lst.append(nc); sys.stderr.write(f"COMMENT {json.dumps(nc)}\n")
                return self.send(200, nc)
            if sub == "/thumbnail":
                img = c.get("_img", cid[4:])
                ext = "webp" if os.path.exists(os.path.join(MEDIA, f"{img}.webp")) else "jpg"
                return self.send(302, b"", headers={"Location": f"{BASE}/media/{img}.{ext}"})
            if sub == "/playback":
                if cid == "cap_limit": return self.send(403, {})
                return self.send(200, {"kind": "mp4", "url": f"{BASE}/media/{'long' if cid in ('cap_stress', 'cap_rtl', 'cap_locked') else 'demo'}.mp4", "transcriptUrl": None if cid == "cap_quiet" else f"{BASE}/media/{'long' if cid in ('cap_stress', 'cap_rtl') else 'transcript'}.vtt"})
            if sub == "/edit" and self.command == "GET":
                if cid == "cap_shot": return self.send(200, {"status": "not_editable", "duration": 0, "hasEdits": False})
                processing = EDITS.get(cid, {}).get("until", 0) > datetime.now(timezone.utc).timestamp()
                return self.send(200, {"status": "busy" if processing else "available", "duration": c.get("durationSeconds") or 0, "hasEdits": cid in EDITS})
            if sub in ("/edit", "/edit/restore") and self.command == "POST":
                b = self.body(); sys.stderr.write(f"EDIT {cid} {sub} {json.dumps(b)}\n")
                if sub == "/edit":
                    ranges = b.get("keepRanges") or []
                    if not ranges: return self.send(400, {})
                    c["durationSeconds"] = round(sum(r["end"] - r["start"] for r in ranges), 3)
                EDITS[cid] = {"until": datetime.now(timezone.utc).timestamp() + 4, "body": b}
                c["upload"] = {"uploaded": 0, "total": 0, "phase": "processing", "processingProgress": 10, "processingMessage": "Applying your edit", "processingError": None}
                return self.send(200, {"success": True})
            if sub == "/analytics": return self.send(200, analytics(q.get("range", "7d"), True))
            if sub == "/sharing":
                b = self.body(); was_public = c["public"]; c["public"] = b.get("public", c["public"])
                if c.get("_linkChoice"):
                    if b.get("linkAccess") and not was_public: c["public"] = False; return self.send(409, {})
                    if not c["public"]: c.pop("linkAccess", None); c.pop("linkRestricted", None)
                    else:
                        c["linkAccess"] = b.get("linkAccess") or c.get("linkAccess") or "restricted"
                        c["linkRestricted"] = c["linkAccess"] != "anyone"
                return self.send(200, c)
            if sub == "/title": c["title"] = self.body().get("title", c["title"]); return self.send(200, c)
            if sub == "" and self.command == "DELETE": return self.send(200, {"success": True})
            if sub == "":
                v = viewer(cid); lst = comments_for(cid)
                if v["settings"]["disableComments"]: lst = [x for x in lst if x["type"] != "text"]
                if v["settings"]["disableReactions"]: lst = [x for x in lst if x["type"] != "emoji"]
                ex = dict(detail_extra)
                if cid in ("cap_stress", "cap_rtl"): ex = {"summary": LONG_SUMMARY, "chapters": LONG_CHAPTERS, "transcriptionStatus": "COMPLETE"}
                if cid == "cap_miami": ex = {"summary": None, "chapters": [], "transcriptionStatus": "PROCESSING"}
                if cid == "cap_shot": ex = {"summary": None, "chapters": [], "transcriptionStatus": None}
                pub = {k: val for k, val in c.items() if not k.startswith("_")}
                return self.send(200, {"cap": pub, **ex, "comments": lst, "shareUrl": c["shareUrl"], "viewer": v})
        return self.send(404, {})
    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = route

UPLOADS = {}
PUSH_TOKENS = {}
EVENTS = []
NOTIFICATIONS = {"comments": True, "replies": True, "views": True, "anonymousViews": True, "reactions": True}
EDITS = {}
ensure_media()
class Server(ThreadingHTTPServer):
    # HTTPServer.server_bind does a reverse DNS lookup that can hang; it's only used for a log name.
    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", PORT
Server(("127.0.0.1", PORT), H).serve_forever()
