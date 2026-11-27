import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

CASES = [
    ("default", [], ["base", "head"]),
    ("br5", ["--video-bitrate", "5"], ["head"]),
    ("br15", ["--video-bitrate", "15"], ["head"]),
    ("br60", ["--video-bitrate", "60"], ["head"]),
    ("fps120", ["--fps", "120"], ["base", "head"]),
    ("fps240", ["--fps", "240"], ["base", "head"]),
]


def run(cmd, timeout=600, env=None):
    started = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as e:
        return -999, "", f"timeout after {timeout}s", time.time() - started
    return p.returncode, p.stdout, p.stderr, time.time() - started


def ffprobe_json(ffprobe, args, path):
    rc, out, err, _ = run([ffprobe, "-v", "error", *args, "-of", "json", path])
    try:
        return json.loads(out or "{}")
    except json.JSONDecodeError:
        return {"error": err[-400:]}


def video_stats(ffprobe, ffmpeg, path):
    info = ffprobe_json(ffprobe, ["-select_streams", "v:0", "-show_entries",
                                  "packet=pts_time,size:stream=codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration,bit_rate,size"], path)
    packets = info.get("packets", [])
    pts = [float(p["pts_time"]) for p in packets if p.get("pts_time") not in (None, "N/A")]
    pts_sorted = sorted(pts)
    span = (pts_sorted[-1] - pts_sorted[0]) if len(pts_sorted) > 1 else 0.0
    total = sum(int(p.get("size", 0)) for p in packets)
    stream = (info.get("streams") or [{}])[0]
    fmt = info.get("format", {})
    frames = len(packets)
    dupes = len(pts_sorted) - len(set(round(t, 6) for t in pts_sorted))
    result = {
        "codec": stream.get("codec_name"),
        "size": f"{stream.get('width')}x{stream.get('height')}",
        "frames": frames,
        "span_s": round(span, 4),
        "fps_measured": round((frames - 1) / span, 3) if span else None,
        "video_mbps": round(total * 8 / (span + (span / max(frames - 1, 1))) / 1e6, 3) if span else None,
        "format_duration": float(fmt.get("duration", 0) or 0),
        "file_bytes": int(fmt.get("size", 0) or 0),
        "duplicate_pts": dupes,
        "avg_frame_rate": stream.get("avg_frame_rate"),
    }
    if ffmpeg:
        rc, out, err, _ = run([ffmpeg, "-v", "info", "-i", path, "-vf", "mpdecimate,showinfo", "-f", "null", "-"], timeout=900)
        result["unique_frames"] = sum(1 for l in err.splitlines() if "Parsed_showinfo" in l and " pts_time:" in l)
        if span:
            result["unique_fps"] = round(result["unique_frames"] / (span + span / max(frames - 1, 1)), 2)
    return result


def find_display(project):
    hits = sorted(glob.glob(os.path.join(project, "content", "segments", "*", "display.mp4")))
    if not hits:
        hits = sorted(glob.glob(os.path.join(project, "content", "display.mp4")))
    return hits[0] if hits else None


def one(args, arm, case, extra, rep, screen):
    cap = args.base if arm == "base" else args.head
    project = os.path.join(args.work, f"{case}-{arm}-{rep}.cap")
    if os.path.exists(project):
        shutil.rmtree(project)
    cmd = [cap, "--log-level", "info", "record", "--screen", str(screen), "--mode", "studio", "--duration", str(args.secs), "--path", project, *extra]
    rc, out, err, wall = run(cmd, timeout=args.secs + 300)
    row = {"arm": arm, "case": case, "rep": rep, "args": extra, "record_rc": rc,
           "record_wall_s": round(wall, 3), "stop_overhead_s": round(wall - args.secs, 3),
           "record_err_tail": err[-600:] if rc else "",
           "encoder_lines": [l.strip()[-260:] for l in err.splitlines() if "H264 encoder" in l or "SOFTWARE" in l or "fps" in l.lower() and "capture" in l.lower()][:8]}
    rc, out, err, _ = run([cap, "project", "validate", project])
    row["validate_rc"] = rc
    row["validate_out"] = (out + err)[-300:]
    rc, out, err, _ = run([cap, "project", "inspect", project, "--format", "json"])
    try:
        row["inspect"] = json.loads(out)
    except json.JSONDecodeError:
        row["inspect"] = (out + err)[-300:]
    display = find_display(project)
    row["display"] = video_stats(args.ffprobe, args.ffmpeg if args.unique else None, display) if display else None
    export = os.path.join(args.work, f"{case}-{arm}-{rep}.mp4")
    if args.no_export:
        rc, out, err, wall = None, "", "", 0.0
    else:
        rc, out, err, wall = run([cap, "export", project, "-o", export], timeout=900)
    row["export_rc"] = rc
    row["export_wall_s"] = round(wall, 2)
    row["export_err_tail"] = err[-400:] if rc else ""
    row["export"] = video_stats(args.ffprobe, None, export) if rc == 0 and os.path.exists(export) else None
    meta = os.path.join(project, "recording-meta.json")
    if os.path.exists(meta):
        try:
            m = json.load(open(meta))
            segs = m.get("segments") or []
            row["meta_fps"] = [s.get("display", {}).get("fps") for s in segs]
            row["meta_status"] = m.get("status")
        except Exception as e:
            row["meta_error"] = str(e)
    if not args.keep:
        shutil.rmtree(project, ignore_errors=True)
        if os.path.exists(export):
            os.remove(export)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pairs", type=int, default=3)
    ap.add_argument("--secs", type=float, default=10)
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--cases", default="")
    ap.add_argument("--label", default="")
    ap.add_argument("--unique", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--screen", default="")
    ap.add_argument("--fps-only", default="")
    ap.add_argument("--no-export", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.work, exist_ok=True)
    rc, out, err, _ = run([args.head, "record", "screens", "--format", "json"])
    screens = json.loads(out)
    screen = next((s for s in screens if s.get("primary")), screens[0])
    if args.screen:
        screen = next(s for s in screens if str(s.get("id")) == args.screen)
    report = {"label": args.label, "screens": screens, "screen": screen, "rows": []}
    for arm in ("base", "head"):
        cap = args.base if arm == "base" else args.head
        report[f"{arm}_version"] = run([cap, "--version"])[1].strip()
    wanted = [c for c in CASES if not args.cases or c[0] in args.cases.split(",")]
    if args.fps_only:
        wanted = [(f"fps{f}", ["--fps", f], ["base", "head"]) for f in args.fps_only.split(",")]
    for rep in range(1, args.pairs + 1):
        for case, extra, arms in wanted:
            order = arms if rep % 2 == 1 else list(reversed(arms))
            for arm in order:
                row = one(args, arm, case, extra, rep, screen["id"])
                report["rows"].append(row)
                d = row.get("display") or {}
                print(f"{case:8} {arm:4} r{rep} rc={row['record_rc']} frames={d.get('frames')} fps={d.get('fps_measured')} uniq={d.get('unique_fps')} mbps={d.get('video_mbps')} stop={row['stop_overhead_s']} val={row['validate_rc']} exp={row['export_rc']}", flush=True)
                with open(args.out, "w") as f:
                    json.dump(report, f, indent=1)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=1)


if __name__ == "__main__":
    sys.exit(main())
