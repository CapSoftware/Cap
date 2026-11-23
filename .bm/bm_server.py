#!/usr/bin/env python3
"""Replay the desktop API calls a 0.6.x client makes and normalise the replies.

replay <base_url> <api_key> <out.json>
compare <a.json> <b.json>   (prints differences, exit 1 on unexpected ones)
"""

import json
import re
import sys
import urllib.error
import urllib.request

VOLATILE = re.compile(
    r"(?i)(^id$|Id$|_id$|url|Url|URL|expires|Expires|date|Date|At$|_at$|time|Time|token|Token|key$|Key$|signature|"
    r"policy|Policy|credential|Credential|nonce|etag|ETag|uploadId|UploadId|fields)"
)

KEY = "__KEY__"


def calls(video_id_holder):
    vid = lambda: video_id_holder.get("id", "missing")
    return [
        ("plan", "GET", "/api/desktop/plan", None, True),
        ("organizations", "GET", "/api/desktop/organizations", None, True),
        ("profile", "GET", "/api/desktop/user/profile", None, True),
        ("profile_image", "GET", "/api/desktop/user/profile/image", None, True),
        ("org_custom_domain", "GET", "/api/desktop/org-custom-domain", None, True),
        ("s3_config_get", "GET", "/api/desktop/s3/config/get", None, True),
        ("storage_integrations", "GET", "/api/desktop/storage/integrations", None, True),
        ("new_id", "GET", "/api/desktop/video/new-id", None, True),
        ("video_create_mp4", "GET", "/api/desktop/video/create?recordingMode=desktopMP4", None, True),
        ("upload_signed", "POST", "/api/upload/signed", lambda: {"videoId": vid(), "subpath": "result.mp4", "method": "put"}, True),
        ("multipart_initiate", "POST", "/api/upload/multipart/initiate", lambda: {"videoId": vid(), "contentType": "video/mp4", "subpath": "result.mp4"}, True),
        ("recording_prepare", "POST", "/api/recording/prepare", lambda: {"videoId": vid()}, True),
        ("video_progress", "POST", "/api/desktop/video/progress", lambda: {"videoId": vid(), "uploaded": 10, "total": 100, "updatedAt": "2026-11-23T00:00:00.000Z"}, True),
        ("video_delete", "DELETE", f"/api/desktop/video/delete?videoId=__VID__", None, True),
        ("video_create_segments", "GET", "/api/desktop/video/create?recordingMode=desktopSegments", None, True),
        ("video_create_screenshot", "GET", "/api/desktop/video/create?recordingMode=desktopMP4&isScreenshot=true", None, True),
        ("logs", "POST", "/api/desktop/logs", lambda: {"logs": "bm replay log line", "os": "linux", "version": "0.6.3"}, True),
        ("feedback", "POST", "/api/desktop/feedback", lambda: {"feedback": "bm replay", "os": "linux", "version": "0.6.3"}, True),
        ("subscribe_with_price", "POST", "/api/desktop/subscribe", lambda: {"priceId": "price_test_bm"}, True),
        ("plan_noauth", "GET", "/api/desktop/plan", None, False),
        ("organizations_noauth", "GET", "/api/desktop/organizations", None, False),
        ("video_create_noauth", "GET", "/api/desktop/video/create?recordingMode=desktopMP4", None, False),
        ("upload_signed_noauth", "POST", "/api/upload/signed", lambda: {"videoId": "x", "subpath": "result.mp4"}, False),
        ("subscribe_noauth", "POST", "/api/desktop/subscribe", lambda: {"priceId": "price_test_bm"}, False),
        ("session_request", "GET", "/api/desktop/session/request?port=31234&type=api_key&platform=desktop", None, False),
        ("unknown_root", "GET", "/api/desktop/does-not-exist", None, True),
        ("meetings_prefix_lookalike", "GET", "/api/desktop/meetingsx", None, True),
        ("meetings_capabilities", "GET", "/api/desktop/meetings/capabilities", None, True),
        ("meetings_capabilities_noauth", "GET", "/api/desktop/meetings/capabilities", None, False),
    ]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def norm(value, key=""):
    if isinstance(value, dict):
        return {k: norm(v, k) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [norm(v, key) for v in value]
    if key and VOLATILE.search(key):
        return f"<{type(value).__name__}>"
    if isinstance(value, str) and re.match(r"^https?://", value):
        return "<url>"
    return value


def request(base, api_key, method, path, body, auth):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("User-Agent", "Cap/0.6.3")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        resp = opener.open(req, timeout=240)
        status, headers, raw = resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, e.headers, e.read()
    except Exception as e:
        return {"status": "exception", "error": type(e).__name__}
    ctype = (headers.get("content-type") or "").split(";")[0]
    out = {"status": status, "type": ctype}
    loc = headers.get("location")
    if loc:
        out["location"] = re.sub(r"\?.*", "?...", re.sub(r"^https?://[^/]+", "", loc))
    text = raw.decode("utf-8", "replace")
    if ctype == "application/json":
        try:
            parsed = json.loads(text)
            out["json"] = norm(parsed)
            out["_raw"] = parsed
        except Exception:
            out["text"] = text[:300]
    else:
        out["text_len"] = len(text)
        out["text_head"] = re.sub(r"\s+", " ", text[:120])
    return out


def replay(base, api_key, path):
    holder = {}
    results = {}
    for name, method, url, body, auth in calls(holder):
        url = url.replace("__VID__", holder.get("id", "missing"))
        r = request(base, api_key, method, url, body() if body else None, auth)
        raw = r.pop("_raw", None)
        if name == "video_create_mp4" and isinstance(raw, dict):
            holder["id"] = raw.get("id") or raw.get("videoId") or holder.get("id")
        results[name] = r
        print(name, r.get("status"), json.dumps(r)[:240], flush=True)
    json.dump(results, open(path, "w"), indent=1, sort_keys=True)


EXPECTED_DIFFS = {"meetings_capabilities", "meetings_capabilities_noauth"}


def compare(a_path, b_path):
    a, b = json.load(open(a_path)), json.load(open(b_path))
    bad = []
    for name in sorted(set(a) | set(b)):
        if a.get(name) == b.get(name):
            print(f"same    {name}: {a.get(name, {}).get('status')}")
            continue
        tag = "expect " if name in EXPECTED_DIFFS else "DIFF   "
        print(f"{tag}{name}:\n   a={json.dumps(a.get(name))[:500]}\n   b={json.dumps(b.get(name))[:500]}")
        if name not in EXPECTED_DIFFS:
            bad.append(name)
    print("unexpected differences:", bad or "none")
    return 1 if bad else 0


if __name__ == "__main__":
    if sys.argv[1] == "replay":
        replay(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(compare(sys.argv[2], sys.argv[3]))
