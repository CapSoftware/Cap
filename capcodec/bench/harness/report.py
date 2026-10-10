import csv
import html
import json
import math
import os
import time
from pathlib import Path

CSV_FIELDS = ["tier", "kind", "clip", "encoder", "family", "point", "production", "width", "height", "fps", "frames",
              "bytes", "kbps", "wall_s", "cpu_s", "cpu_fps", "wall_fps", "maxrss_mb", "speed_wall_fps",
              "speed_cpu_fps", "speed_threads_cpu", "psnr_y", "psnr_u", "psnr_v", "psnr_yuv", "psnr_y_min", "ssim",
              "ssim_min", "vmaf", "vmaf_min", "vmaf_p5", "ocr_cer", "ocr_word_cer", "frames_decoded", "cfr_duplicated",
              "decode_ffmpeg_ok", "decode_jm_ok", "jm_match", "recon_match", "ms_total", "ms_analysis", "ms_motion",
              "ms_mode", "ms_tq", "ms_entropy", "ms_deblock", "frames_coded", "frames_dropped", "match_key", "target",
              "achieved", "ref_kbps", "ref_wall_fps", "ref_cpu_fps", "speedup_wall", "speedup_cpu", "bitrate_ratio",
              "prop_static_frames", "prop_static_frame_ms_mean", "prop_p_frame_ms_median", "prop_full_p_frame_ms",
              "prop_static_vs_full", "prop_fallback_static_frame_ms", "prop_fallback_static_vs_full",
              "prop_fit_fixed_ms", "prop_fit_full_frame_ms", "error"]

STAGES = ["analysis", "motion", "mode", "tq", "entropy", "deblock"]
STAGE_COLORS = {"analysis": "#8c564b", "motion": "#1f77b4", "mode": "#ff7f0e", "tq": "#2ca02c",
                "entropy": "#d62728", "deblock": "#9467bd", "other": "#bbbbbb"}

PALETTE = ["#d62728", "#1f77b4", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22",
           "#17becf", "#393b79", "#637939", "#8c6d31", "#843c39", "#7b4173", "#3182bd", "#e6550d", "#31a354",
           "#756bb1", "#636363"]


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r.get("kind", ""), r["clip"], r["encoder"], str(r.get("point")))):
            rr = dict(r)
            if rr.get("error"):
                rr["error"] = str(rr["error"]).replace("\n", " ")[:300]
            for k, v in rr.items():
                if isinstance(v, float):
                    rr[k] = f"{v:.4f}"
            w.writerow(rr)


def append_history(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


def esc(s) -> str:
    return html.escape(str(s))


def fmt(v, nd=2, pct=False):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    if pct:
        return f"{v:+.{nd}f}%"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def svg_rd(rows: list[dict], clip: str, qkey: str, colors: dict, w=520, h=320) -> str:
    pts = [r for r in rows if r["clip"] == clip and r.get(qkey) is not None and r.get("kbps")]
    if not pts:
        return ""
    xs = [math.log10(r["kbps"]) for r in pts]
    ys = [r[qkey] for r in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    if x1 - x0 < 1e-6:
        x1 = x0 + 1
    if y1 - y0 < 1e-6:
        y1 = y0 + 1
    pad = 46
    sx = lambda x: pad + (x - x0) / (x1 - x0) * (w - pad - 12)
    sy = lambda y: h - pad + 10 - (y - y0) / (y1 - y0) * (h - pad - 10)
    out = [f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg" class="chart">',
           f'<rect x="0" y="0" width="{w}" height="{h}" fill="#fff"/>']
    for i in range(5):
        yv = y0 + (y1 - y0) * i / 4
        out.append(f'<line x1="{pad}" x2="{w - 12}" y1="{sy(yv):.1f}" y2="{sy(yv):.1f}" stroke="#eee"/>')
        out.append(f'<text x="{pad - 4}" y="{sy(yv) + 4:.1f}" font-size="10" text-anchor="end">{yv:.1f}</text>')
    lo, hi = math.floor(x0 * 4) / 4, math.ceil(x1 * 4) / 4
    t = lo
    while t <= hi + 1e-9:
        if x0 - 1e-9 <= t <= x1 + 1e-9:
            out.append(f'<line y1="{h - pad + 10}" y2="16" x1="{sx(t):.1f}" x2="{sx(t):.1f}" stroke="#f3f3f3"/>')
            out.append(f'<text x="{sx(t):.1f}" y="{h - pad + 24}" font-size="10" text-anchor="middle">'
                       f'{10 ** t:.0f}</text>')
        t += 0.25
    out.append(f'<text x="{w / 2}" y="{h - 6}" font-size="11" text-anchor="middle">kbps (log)</text>')
    out.append(f'<text x="12" y="{h / 2}" font-size="11" transform="rotate(-90 12 {h / 2})" text-anchor="middle">'
               f'{esc(qkey)}</text>')
    by = {}
    for r in pts:
        by.setdefault(r["encoder"], []).append(r)
    for e, rs in sorted(by.items()):
        rs.sort(key=lambda r: r["kbps"])
        c = colors.get(e, "#000")
        path = " ".join(f"{sx(math.log10(r['kbps'])):.1f},{sy(r[qkey]):.1f}" for r in rs)
        dash = ' stroke-dasharray="4 3"' if not e.startswith("capcodec") else ' stroke-width="2.5"'
        out.append(f'<polyline points="{path}" fill="none" stroke="{c}"{dash}><title>{esc(e)}</title></polyline>')
        for r in rs:
            mark = "rect" if r.get("production") else "circle"
            cx, cy = sx(math.log10(r["kbps"])), sy(r[qkey])
            tip = f"{e} {r['point']}: {r['kbps']:.0f} kbps, {qkey} {r[qkey]:.2f}"
            if mark == "rect":
                out.append(f'<rect x="{cx - 4:.1f}" y="{cy - 4:.1f}" width="8" height="8" fill="{c}"><title>'
                           f'{esc(tip)} (production)</title></rect>')
            else:
                out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="3" fill="{c}"><title>{esc(tip)}</title></circle>')
    out.append("</svg>")
    return "".join(out)


def svg_scatter(summary: dict, ref: str, w=560, h=340) -> str:
    pts = []
    for e, s in summary.items():
        bd = s.get(f"bd_psnr_yuv_vs_{ref}")
        fps = s.get("speed_wall_fps_median") or s.get("cpu_fps_median")
        if bd is not None and fps:
            pts.append((e, math.log10(fps), bd))
    if len(pts) < 2:
        return ""
    xs = [p[1] for p in pts]
    ys = [p[2] for p in pts]
    x0, x1 = min(xs) - 0.1, max(xs) + 0.1
    y0, y1 = min(ys) - 2, max(ys) + 2
    pad = 50
    sx = lambda x: pad + (x - x0) / (x1 - x0) * (w - pad - 20)
    sy = lambda y: 20 + (y - y0) / (y1 - y0) * (h - pad - 20)
    out = [f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg" class="chart">',
           f'<rect width="{w}" height="{h}" fill="#fff"/>']
    if y0 < 0 < y1:
        out.append(f'<line x1="{pad}" x2="{w - 20}" y1="{sy(0):.1f}" y2="{sy(0):.1f}" stroke="#999"/>')
    for e, x, y in pts:
        c = "#d62728" if e.startswith("capcodec") else "#1f77b4"
        out.append(f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="4" fill="{c}"/>')
        out.append(f'<text x="{sx(x) + 6:.1f}" y="{sy(y) + 3:.1f}" font-size="10">{esc(e)}</text>')
    out.append(f'<text x="{w / 2}" y="{h - 8}" font-size="11" text-anchor="middle">encode fps (log; speed run '
               f'wall fps where measured, else single-thread CPU fps)</text>')
    out.append(f'<text x="14" y="{h / 2}" font-size="11" transform="rotate(-90 14 {h / 2})" text-anchor="middle">'
               f'BD-rate vs {esc(ref)} (lower is better)</text>')
    out.append("</svg>")
    return "".join(out)


def svg_stages(bars: list[tuple[str, dict]], w=760) -> str:
    if not bars:
        return ""
    row_h = 18
    h = 30 + row_h * len(bars) + 30
    label_w = 300
    vmax = max(sum(v for v in d.values()) for _, d in bars) or 1.0
    sx = (w - label_w - 70) / vmax
    out = [f'<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg" class="chart">',
           f'<rect width="{w}" height="{h}" fill="#fff"/>']
    x = label_w
    for i, s in enumerate(STAGES + ["other"]):
        out.append(f'<rect x="{label_w + i * 70}" y="6" width="10" height="10" fill="{STAGE_COLORS[s]}"/>'
                   f'<text x="{label_w + i * 70 + 13}" y="15" font-size="10">{s}</text>')
    for i, (label, d) in enumerate(bars):
        y = 26 + i * row_h
        out.append(f'<text x="{label_w - 6}" y="{y + 12}" font-size="10" text-anchor="end">{esc(label)}</text>')
        x = label_w
        for s in STAGES + ["other"]:
            v = d.get(s, 0.0)
            if v <= 0:
                continue
            out.append(f'<rect x="{x:.1f}" y="{y}" width="{v * sx:.1f}" height="{row_h - 4}" fill="{STAGE_COLORS[s]}">'
                       f'<title>{esc(label)} {s}: {v:.3f} ms/frame</title></rect>')
            x += v * sx
        out.append(f'<text x="{x + 4:.1f}" y="{y + 12}" font-size="10">{sum(d.values()):.2f} ms</text>')
    out.append("</svg>")
    return "".join(out)


def write_html(path: Path, tier: str, rows: list[dict], summ: dict, refs: list[str], meta: dict,
               crops_root: Path, notes: list[str]) -> None:
    summary = summ["summary"]
    q = [r for r in rows if not r.get("kind") and not r.get("error")]
    encoders = sorted({r["encoder"] for r in rows})
    colors = {e: PALETTE[i % len(PALETTE)] for i, e in enumerate(encoders)}
    clips = sorted({r["clip"] for r in q})
    qkeys = [k for k in ("psnr_yuv", "vmaf", "ssim") if any(r.get(k) is not None for r in q)]
    parts = ["<!doctype html><html><head><meta charset='utf-8'><title>capcodec bench: ", esc(tier),
             "</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}"
             "table{border-collapse:collapse;font-size:12px;margin:8px 0 20px}td,th{border:1px solid #ddd;"
             "padding:3px 7px;text-align:right}th{background:#f6f6f6}td:first-child,th:first-child{text-align:left}"
             ".good{color:#0a7d22;font-weight:600}.bad{color:#b3261e}.chart{border:1px solid #eee;margin:4px}"
             ".crops{display:flex;flex-wrap:wrap;gap:8px}.crops figure{margin:0}.crops img{image-rendering:pixelated;"
             "max-width:640px;border:1px solid #ccc}.crops figcaption{font-size:11px}.legend span{display:inline-block;"
             "margin-right:12px;font-size:12px}h2{margin-top:36px}</style></head><body>"]
    parts.append(f"<h1>capcodec benchmark — {esc(tier)} tier</h1>")
    parts.append("<p>" + " · ".join(f"<b>{esc(k)}</b>: {esc(v)}" for k, v in meta.items()) + "</p>")
    for n in notes:
        parts.append(f"<p>{esc(n)}</p>")
    matched = [r for r in rows if r.get("kind") == "matched"]
    if matched:
        parts.append("<h2>Encode speed vs x264 veryfast at matched quality</h2><p>For each clip, the target is "
                     "x264 veryfast's quality at CRF 23; each capcodec preset is encoded at the QP that reaches the "
                     "same quality (interpolated, rounded towards higher quality), and both are timed in serial speed "
                     "runs using all cores. Speedup above 1 means capcodec is faster.</p>")
        encs = sorted({r["encoder"] for r in matched})
        mclips = sorted({r["clip"] for r in matched})
        parts.append("<table><tr><th>clip</th>")
        for e in encs:
            parts.append(f"<th>{esc(e)}<br>speedup (wall)</th><th>CPU speedup<br>(1 thread)</th>"
                         f"<th>{esc(matched[0]['match_key'])}<br>target → got</th><th>bitrate<br>ratio</th>")
        parts.append("<th>x264 veryfast<br>wall fps</th></tr>")
        for c in mclips:
            parts.append(f"<tr><td>{esc(c)}</td>")
            ref_fps = None
            for e in encs:
                r = next((x for x in matched if x["clip"] == c and x["encoder"] == e), None)
                if r is None:
                    parts.append("<td>–</td><td>–</td><td>–</td><td>–</td>")
                    continue
                ref_fps = r["ref_wall_fps"]
                cls = "good" if r["speedup_wall"] >= 1 else "bad"
                parts.append(f"<td class='{cls}'>{r['speedup_wall']:.2f}×</td><td>{fmt(r.get('speedup_cpu'))}×</td>"
                             f"<td>{r['target']:.2f} → {r['achieved']:.2f}</td><td>{fmt(r.get('bitrate_ratio'))}</td>")
            parts.append(f"<td>{fmt(ref_fps, 1)}</td></tr>")
        parts.append("<tr><th>geometric mean</th>")
        for e in encs:
            s = summary.get(e, {})
            parts.append(f"<th>{fmt(s.get('matched_speedup_wall_geomean'))}×</th>"
                         f"<th>{fmt(s.get('matched_speedup_cpu_geomean'))}×</th><th></th><th></th>")
        parts.append("<th></th></tr></table>")
    prodm = summ.get("production") or {}
    if prodm:
        pkey = summ.get("production_key", "vmaf")
        parts.append(f"<h2>Against each Cap production setting</h2><p>For every production point of a Cap surface "
                     f"(squares in the RD plots), the bitrate capcodec needs to reach the same {esc(pkey)}, "
                     f"interpolated on its RD curve (log-rate). Ratio below 1 means capcodec needs fewer bits. "
                     f"Values marked * are extrapolated beyond capcodec's ladder.</p>")
        for e in sorted(prodm):
            parts.append(f"<h3>{esc(e)}</h3><table><tr><th>surface</th><th>clip</th><th>production point</th>"
                         f"<th>{esc(pkey)}</th><th>their kbps</th><th>capcodec kbps</th><th>ratio</th></tr>")
            for surf in sorted(prodm[e]):
                for clip, c in sorted(prodm[e][surf].items()):
                    cls = "good" if c["ratio"] < 1 else "bad"
                    star = "" if c["interpolated"] else "*"
                    parts.append(f"<tr><td>{esc(surf)}</td><td>{esc(clip)}</td><td>{esc(c['point'])}</td>"
                                 f"<td>{c['quality']:.2f}</td><td>{c['their_kbps']:.0f}</td><td>{c['our_kbps']:.0f}{star}</td>"
                                 f"<td class='{cls}'>{c['ratio']:.2f}</td></tr>")
            parts.append("</table>")
    targets = summ.get("cap_targets") or {}
    if targets:
        parts.append("<h2>At Cap's bitrate targets</h2><p>capcodec in bitrate mode (--bitrate B --maxrate 1.5B) "
                     "against each Cap ABR surface at the same bpp point: B = W*H*fps*bpp. Error is the achieved "
                     "average bitrate against B; screen clips undershoot when the encoder reaches its quality floor "
                     "before spending the budget. Deltas are capcodec minus the Cap surface; CPU speedup is "
                     "single-threaded CPU fps.</p>")
        for e in sorted(targets):
            for surf in sorted(targets[e]):
                agg = summary.get(e, {}).get("vs_cap_targets", {}).get(surf, {})
                parts.append(f"<h3>{esc(e)} vs {esc(surf)}</h3><table><tr><th>clip</th><th>point</th>"
                             "<th>target kbps</th><th>capcodec kbps</th><th>error</th><th>their kbps</th>"
                             "<th>their error</th><th>VMAF</th><th>their VMAF</th><th>ΔVMAF</th><th>ΔPSNR-YUV</th>"
                             "<th>CPU speedup</th></tr>")
                for clip, pts in sorted(targets[e][surf].items()):
                    for point, c in sorted(pts.items(), key=lambda kv: kv[1]["target_kbps"]):
                        dv = c.get("d_vmaf")
                        cls = "" if dv is None else ("good" if dv >= 0 else "bad")
                        parts.append(f"<tr><td>{esc(clip)}</td><td>{esc(point)}</td><td>{c['target_kbps']:.0f}</td>"
                                     f"<td>{c['our_kbps']:.0f}</td><td>{fmt(c['our_err'] * 100, 1, True)}</td>"
                                     f"<td>{c['their_kbps']:.0f}</td><td>{fmt(c['their_err'] * 100, 1, True)}</td>"
                                     f"<td>{fmt(c.get('vmaf'))}</td><td>{fmt(c.get('their_vmaf'))}</td>"
                                     f"<td class='{cls}'>{fmt(dv)}</td><td>{fmt(c.get('d_psnr_yuv'))}</td>"
                                     f"<td>{fmt(c.get('cpu_speedup'))}×</td></tr>")
                if agg:
                    parts.append(f"<tr><th>mean</th><th>{agg['n']}</th><th></th><th></th>"
                                 f"<th>|{agg['our_abs_err_mean'] * 100:.1f}%|</th><th></th>"
                                 f"<th>|{agg['their_abs_err_mean'] * 100:.1f}%|</th><th></th><th></th>"
                                 f"<th>{fmt(agg.get('d_vmaf_mean'))}</th><th>{fmt(agg.get('d_psnr_yuv_mean'))}</th>"
                                 f"<th>{fmt(agg.get('cpu_speedup_geomean'))}×</th></tr>")
                parts.append("</table>")
    stage_rows = [r for r in rows if (not r.get("kind") or r.get("kind") == "speed") and r.get("ms_total")]
    if stage_rows:
        parts.append("<h2>Encode time per frame by stage</h2><p>Milliseconds per input frame, from the encoder's "
                     "own stage timers. Quality runs are single-threaded (CPU time per frame); speed runs use all "
                     "cores (summed across threads). 'other' is input, setup and muxing.</p>")
        bars = []
        for r in sorted(stage_rows, key=lambda r: (r.get("kind") or "", r["clip"], r["encoder"], str(r["point"]))):
            d = {s: r.get(f"ms_{s}") or 0.0 for s in STAGES}
            d["other"] = max(0.0, r["ms_total"] - sum(d.values()))
            tag = "speed" if r.get("kind") == "speed" else "1 thread"
            bars.append((f"{r['clip']} · {r['encoder']} · {r['point']} · {tag}", d))
        parts.append(svg_stages(bars))
    prop = [r for r in rows if r.get("kind") == "proportionality"]
    if prop:
        parts.append("<h2>Cost proportional to changed area</h2><p>Single-threaded speed runs. Static frame cost is "
                     "the mean time of input frames in which no macroblock changed (dropped or skipped). Full P-frame "
                     "cost is measured explicitly on the same clip with every macroblock forced through full "
                     "analysis. Target: static frames under 1% of a full frame. The fit columns regress frame time "
                     "on the changed fraction.</p><table><tr><th>clip</th><th>static frames</th>"
                     "<th>static frame ms</th><th>full P frame ms</th><th>static / full</th>"
                     "<th>pixel-fallback static ms</th><th>fallback / full</th><th>fit fixed ms</th>"
                     "<th>fit full-frame ms</th><th>median P frame ms</th></tr>")
        for r in sorted(prop, key=lambda r: r["clip"]):
            ratio = r.get("prop_static_vs_full")
            fb = r.get("prop_fallback_static_vs_full")
            cls = "" if ratio is None else ("good" if ratio < 0.01 else "bad")
            ratio_s = "–" if ratio is None else f"{ratio * 100:.3f}%"
            fb_s = "–" if fb is None else f"{fb * 100:.2f}%"
            parts.append(f"<tr><td>{esc(r['clip'])}</td><td>{fmt(r.get('prop_static_frames'))}</td>"
                         f"<td>{fmt(r.get('prop_static_frame_ms_mean'), 4)}</td>"
                         f"<td>{fmt(r.get('prop_full_p_frame_ms'), 3)}</td>"
                         f"<td class='{cls}'>{ratio_s}</td>"
                         f"<td>{fmt(r.get('prop_fallback_static_frame_ms'), 4)}</td><td>{fb_s}</td>"
                         f"<td>{fmt(r.get('prop_fit_fixed_ms'), 3)}</td><td>{fmt(r.get('prop_fit_full_frame_ms'), 3)}</td>"
                         f"<td>{fmt(r.get('prop_p_frame_ms_median'), 3)}</td></tr>")
        parts.append("</table>")
    parts.append("<h2>Summary</h2><table><tr><th>encoder</th><th>encodes</th>")
    for k in qkeys:
        for ref in refs:
            parts.append(f"<th>BD-rate {esc(k)}<br>vs {esc(ref)}</th>")
    parts.append("<th>CPU fps (1 thread, median)</th><th>speed run wall fps</th><th>decode failures</th>"
                 "<th>errors</th></tr>")
    for e in encoders:
        s = summary.get(e, {})
        parts.append(f"<tr><td><span style='color:{colors[e]}'>■</span> {esc(e)}</td><td>{s.get('encodes', 0)}</td>")
        for k in qkeys:
            for ref in refs:
                v = s.get(f"bd_{k}_vs_{ref}")
                n = s.get(f"bd_{k}_vs_{ref}_n")
                cls = "" if v is None else ("good" if v < 0 else "bad")
                parts.append(f"<td class='{cls}'>{fmt(v, 1, True)}{'' if v is None else f' <small>({n})</small>'}</td>")
        parts.append(f"<td>{fmt(s.get('cpu_fps_median'), 1)}</td><td>{fmt(s.get('speed_wall_fps_median'), 1)}</td>"
                     f"<td class='{'bad' if s.get('decode_failures') else ''}'>{s.get('decode_failures', 0)}</td>"
                     f"<td>{s.get('errors', 0)}</td></tr>")
    parts.append("</table><p>BD-rate: average bitrate difference at equal quality, piecewise-cubic interpolation over "
                 "the overlapping quality range, averaged over clips (number of clips in brackets). Negative means "
                 "fewer bits than the reference.</p>")
    for ref in refs[:1]:
        sc = svg_scatter(summary, ref)
        if sc:
            parts.append(f"<h2>Speed vs compression</h2>{sc}")
    for k in qkeys:
        for ref in refs:
            t = summ["tables"].get(k, {})
            ent = {key.split("|")[0]: v for key, v in t.items() if key.split("|")[1] == ref}
            if not ent:
                continue
            parts.append(f"<h3>Per-clip BD-rate ({esc(k)}) vs {esc(ref)}</h3><table><tr><th>encoder</th>")
            parts += [f"<th>{esc(c)}</th>" for c in clips]
            parts.append("<th>mean</th></tr>")
            for e in encoders:
                if e not in ent:
                    continue
                parts.append(f"<tr><td>{esc(e)}</td>")
                for c in clips:
                    v = ent[e]["clips"].get(c)
                    cls = "" if v is None else ("good" if v < 0 else "bad")
                    parts.append(f"<td class='{cls}'>{fmt(v, 1, True)}</td>")
                parts.append(f"<td>{fmt(ent[e]['mean'], 1, True)}</td></tr>")
            parts.append("</table>")
    parts.append("<h2>Rate-distortion curves</h2><div class='legend'>")
    parts += [f"<span><span style='color:{colors[e]}'>■</span> {esc(e)}</span>" for e in encoders]
    parts.append("</div><p>Squares mark production settings.</p>")
    for c in clips:
        parts.append(f"<h3>{esc(c)}</h3><div>")
        for k in qkeys:
            parts.append(svg_rd(q, c, k, colors))
        parts.append("</div>")
    speed = [r for r in rows if r.get("kind") == "speed"]
    if speed:
        parts.append("<h2>Speed runs</h2><p>Serial runs, one at a time, encoder's own threading, wall-clock "
                     "fps.</p><table><tr><th>encoder</th><th>clip</th><th>point</th><th>size</th><th>wall fps</th>"
                     "<th>CPU fps</th><th>cores used</th><th>peak MB</th></tr>")
        for r in sorted(speed, key=lambda r: (r["encoder"], r["clip"])):
            parts.append(f"<tr><td>{esc(r['encoder'])}</td><td>{esc(r['clip'])}</td><td>{esc(r['point'])}</td>"
                         f"<td>{r['width']}x{r['height']}@{r['fps']:g}</td><td>{fmt(r.get('speed_wall_fps'), 1)}</td>"
                         f"<td>{fmt(r.get('speed_cpu_fps'), 1)}</td><td>{fmt(r.get('speed_threads_cpu'), 2)}</td>"
                         f"<td>{fmt(r.get('maxrss_mb'), 0)}</td></tr>")
        parts.append("</table>")
    if crops_root.exists():
        parts.append("<h2>Side-by-side crops</h2><p>Middle frame, first text region, decoded output at each "
                     "encoder's production point or its second-highest-quality ladder point.</p>")
        for c in clips:
            d = crops_root / c
            if not d.exists():
                continue
            figs = []
            src_imgs = sorted((d / "source").glob("*.png")) if (d / "source").exists() else []
            if src_imgs:
                figs.append(("source (lossless)", src_imgs[0]))
            for e in encoders:
                er = sorted([r for r in q if r["clip"] == c and r["encoder"] == e], key=lambda r: r.get("kbps") or 0)
                if not er:
                    continue
                prod = [r for r in er if r.get("production")]
                pick = prod[0] if prod else er[-2] if len(er) >= 2 else er[-1]
                imgs = sorted((d / f"{e}_{pick['point']}").glob("*.png"))
                if imgs:
                    figs.append((f"{e} {pick['point']} · {pick['kbps']:.0f} kbps · PSNR-Y {fmt(pick.get('psnr_y'))}",
                                 imgs[0]))
            if figs:
                parts.append(f"<h3>{esc(c)}</h3><div class='crops'>")
                for cap, img in figs:
                    rel = os.path.relpath(img, path.parent)
                    parts.append(f"<figure><img src='{esc(rel)}' loading='lazy'><figcaption>{esc(cap)}</figcaption>"
                                 f"</figure>")
                parts.append("</div>")
    parts.append("<h2>All encodes</h2><table><tr>")
    cols = ["clip", "encoder", "point", "kbps", "psnr_yuv", "psnr_y", "ssim", "vmaf", "ocr_cer", "ocr_word_cer", "cpu_fps",
            "maxrss_mb", "decode_ffmpeg_ok", "decode_jm_ok", "jm_match", "recon_match"]
    parts += [f"<th>{esc(c)}</th>" for c in cols]
    parts.append("</tr>")
    for r in sorted(rows, key=lambda r: (r["clip"], r["encoder"], r.get("kbps") or 0)):
        if r.get("kind"):
            continue
        parts.append("<tr>" + "".join(f"<td>{esc(fmt(r.get(c)))}</td>" for c in cols) + "</tr>")
    parts.append(f"</table><p>Generated {esc(time.strftime('%Y-%m-%d %H:%M:%S'))}.</p></body></html>")
    path.write_text("".join(parts))
