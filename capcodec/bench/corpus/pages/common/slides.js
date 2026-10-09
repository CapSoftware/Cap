(() => {
	const deck = document.getElementById("deck");
	const TOTAL = 14;
	const foot = (n, dark) =>
		`<div class="foot"><span class="logo"></span><span>Capture Pipeline 2.0 · Q3 Review</span><span class="num">${n} / ${TOTAL}</span></div>`;

	function barChart() {
		const groups = [
			["macOS (Apple Silicon)", 640, 210],
			["macOS (Intel)", 1480, 690],
			["Windows 11", 1910, 760],
			["Windows 10", 2350, 980],
			["Linux (X11)", 1720, 820],
		];
		const W = 1560;
		const H = 640;
		const x0 = 150;
		const y0 = 560;
		const max = 2500;
		let s = `<svg width="${W}" height="${H}" font-family="Noto Sans">`;
		for (let v = 0; v <= max; v += 500) {
			const y = y0 - (v / max) * 480;
			s += `<line x1="${x0}" x2="${W - 20}" y1="${y}" y2="${y}" stroke="#e5e7eb" stroke-width="2"/><text x="${x0 - 18}" y="${y + 8}" text-anchor="end" font-size="22" fill="#6b7280">${v.toLocaleString("en-US")}</text>`;
		}
		const gw = (W - x0 - 40) / groups.length;
		groups.forEach(([name, a, b], i) => {
			const gx = x0 + 30 + i * gw;
			const ha = (a / max) * 480;
			const hb = (b / max) * 480;
			s += `<rect x="${gx + 20}" y="${y0 - ha}" width="96" height="${ha}" rx="8" fill="#c7d2fe"/>`;
			s += `<rect x="${gx + 126}" y="${y0 - hb}" width="96" height="${hb}" rx="8" fill="#4f46e5"/>`;
			s += `<text x="${gx + 68}" y="${y0 - ha - 14}" text-anchor="middle" font-size="22" fill="#4b5563">${a}</text>`;
			s += `<text x="${gx + 174}" y="${y0 - hb - 14}" text-anchor="middle" font-size="22" font-weight="700" fill="#312e81">${b}</text>`;
			s += `<text x="${gx + 121}" y="${y0 + 42}" text-anchor="middle" font-size="24" fill="#374151">${name}</text>`;
		});
		s += `<line x1="${x0}" x2="${W - 20}" y1="${y0}" y2="${y0}" stroke="#9ca3af" stroke-width="2"/>`;
		s += `<rect x="${W - 360}" y="10" width="26" height="26" rx="5" fill="#c7d2fe"/><text x="${W - 322}" y="31" font-size="24" fill="#374151">Q2</text>`;
		s += `<rect x="${W - 250}" y="10" width="26" height="26" rx="5" fill="#4f46e5"/><text x="${W - 212}" y="31" font-size="24" fill="#374151">Q3</text>`;
		s += `<text x="20" y="300" font-size="22" fill="#6b7280" transform="rotate(-90 40 300)">milliseconds</text></svg>`;
		return s;
	}

	function lineChart() {
		const W = 1640;
		const H = 620;
		const x0 = 110;
		const y0 = 540;
		const pts = [];
		let v = 9.8;
		for (let i = 0; i < 26; i++) {
			v += Math.sin(i * 1.7) * 0.6 - (i > 8 ? 0.28 : 0.02);
			if (i === 15) v += 1.4;
			pts.push(Math.max(3.2, v));
		}
		let s = `<svg width="${W}" height="${H}" font-family="Noto Sans">`;
		for (let k = 0; k <= 12; k += 2) {
			const y = y0 - (k / 12) * 460;
			s += `<line x1="${x0}" x2="${W - 10}" y1="${y}" y2="${y}" stroke="#eef0f4" stroke-width="2"/><text x="${x0 - 16}" y="${y + 8}" text-anchor="end" font-size="22" fill="#6b7280">${k}</text>`;
		}
		const px = (i) => x0 + 20 + i * ((W - x0 - 60) / 25);
		const py = (val) => y0 - (val / 12) * 460;
		const line = pts
			.map((p, i) => `${px(i).toFixed(1)},${py(p).toFixed(1)}`)
			.join(" ");
		s += `<polygon points="${px(0)},${y0} ${line} ${px(25)},${y0}" fill="#4f46e5" opacity=".08"/>`;
		s += `<polyline points="${line}" fill="none" stroke="#4f46e5" stroke-width="5" stroke-linejoin="round"/>`;
		pts.forEach((p, i) => {
			if (i % 5 === 0 || i === 25)
				s += `<circle cx="${px(i)}" cy="${py(p)}" r="8" fill="#fff" stroke="#4f46e5" stroke-width="4"/>`;
			if (i % 4 === 0)
				s += `<text x="${px(i)}" y="${y0 + 40}" text-anchor="middle" font-size="22" fill="#6b7280">W${27 + i}</text>`;
		});
		s += `<line x1="${px(15)}" x2="${px(15)}" y1="${py(pts[15]) - 30}" y2="${py(pts[15]) - 100}" stroke="#f59e0b" stroke-width="3"/>`;
		s += `<text x="${px(15) + 14}" y="${py(pts[15]) - 104}" font-size="24" fill="#b45309" font-weight="700">CDN incident (Aug 14)</text>`;
		s += `<line x1="${px(9)}" x2="${px(9)}" y1="${y0}" y2="40" stroke="#10b981" stroke-width="3" stroke-dasharray="10 8"/>`;
		s += `<text x="${px(9) + 14}" y="62" font-size="24" fill="#047857" font-weight="700">Resumable uploads ship</text>`;
		s += `<line x1="${x0}" x2="${W - 10}" y1="${y0}" y2="${y0}" stroke="#9ca3af" stroke-width="2"/></svg>`;
		return s;
	}

	function donut() {
		const parts = [
			["1080p", 52, "#4f46e5"],
			["1440p", 17, "#06b6d4"],
			["4K", 21, "#a855f7"],
			["720p and below", 10, "#f59e0b"],
		];
		let a0 = -Math.PI / 2;
		let s = '<svg width="620" height="620" viewBox="-310 -310 620 620">';
		for (const [, pct, c] of parts) {
			const a1 = a0 + (pct / 100) * Math.PI * 2;
			const large = a1 - a0 > Math.PI ? 1 : 0;
			const r = 280;
			const ri = 170;
			s += `<path d="M${Math.cos(a0) * r} ${Math.sin(a0) * r} A${r} ${r} 0 ${large} 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r} L${Math.cos(a1) * ri} ${Math.sin(a1) * ri} A${ri} ${ri} 0 ${large} 0 ${Math.cos(a0) * ri} ${Math.sin(a0) * ri}Z" fill="${c}"/>`;
			a0 = a1;
		}
		s +=
			'<text x="0" y="-6" text-anchor="middle" font-family="Noto Sans" font-size="76" font-weight="800" fill="#1d2433">1.9M</text><text x="0" y="46" text-anchor="middle" font-family="Noto Sans" font-size="28" fill="#6b7280">recordings in Q3</text></svg>';
		const legend = parts
			.map(
				([n, p, c]) =>
					`<div style="display:flex;align-items:center;gap:22px;font-size:34px;margin-bottom:30px"><span style="width:30px;height:30px;border-radius:8px;background:${c}"></span><span style="flex:1">${n}</span><b>${p}%</b></div>`,
			)
			.join("");
		return `<div style="display:flex;gap:120px;align-items:center;margin-top:10px">${s}<div style="width:640px">${legend}<div style="font-size:24px;color:#5b6475;line-height:1.45;margin-top:40px">4K share doubled since Q1, driven by new external displays and the 5K iMac refresh.</div></div></div>`;
	}

	function landscape() {
		let ridges = "";
		const layers = [
			["#3b4a7a", 0.62, 90, 1],
			["#2a3560", 0.7, 70, 2],
			["#1b2343", 0.78, 50, 3],
		];
		for (const [c, base, amp, seed] of layers) {
			let d = `M0 1080 L0 ${base * 1080}`;
			for (let x = 0; x <= 1920; x += 40) {
				const y =
					base * 1080 -
					Math.abs(Math.sin(x / (180 + seed * 40) + seed) * amp) -
					Math.sin(x / 63 + seed * 2) * amp * 0.25;
				d += ` L${x} ${y.toFixed(1)}`;
			}
			d += " L1920 1080Z";
			ridges += `<path d="${d}" fill="${c}"/>`;
		}
		return `<svg width="1920" height="1080" viewBox="0 0 1920 1080" style="position:absolute;inset:0" filter="url(#grain)">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset=".45" stop-color="#c2649a"/><stop offset=".62" stop-color="#f6a05c"/><stop offset=".7" stop-color="#ffd59e"/></linearGradient>
<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff7d6"/><stop offset=".25" stop-color="#ffe29a" stop-opacity=".95"/><stop offset="1" stop-color="#ffb46b" stop-opacity="0"/></radialGradient>
<linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3a667"/><stop offset=".3" stop-color="#7a5a8c"/><stop offset="1" stop-color="#101a36"/></linearGradient></defs>
<rect width="1920" height="1080" fill="url(#sky)"/>
<circle cx="1260" cy="700" r="380" fill="url(#sun)"/>
<g filter="url(#blur8)" opacity=".55"><ellipse cx="520" cy="300" rx="420" ry="46" fill="#f8c3d0"/><ellipse cx="1500" cy="220" rx="360" ry="34" fill="#f2b5c8"/><ellipse cx="980" cy="420" rx="520" ry="30" fill="#ffd1a6"/></g>
${ridges}
<rect y="842" width="1920" height="238" fill="url(#lake)"/>
<g opacity=".35" filter="url(#blur3)">${Array.from({ length: 18 }, (_, i) => `<rect x="${1110 + Math.sin(i * 2.1) * 120}" y="${860 + i * 11}" width="${300 - i * 12}" height="3" fill="#ffe8c2"/>`).join("")}</g>
<path d="M0 842 L1920 842" stroke="#ffd8a8" stroke-width="2" opacity=".5"/>
</svg>`;
	}

	const slides = [
		{
			cls: "title-slide dark",
			tr: "cut",
			html: `<div class="kicker" style="color:#a5b4fc">Desktop &amp; Media · Q3 2026</div><h1>Capture Pipeline 2.0</h1><div class="subt">What we shipped, what we learned, and what comes next</div>
<div class="by"><div class="avatar" style="width:72px;height:72px;background:#7c3aed;font-size:30px">ML</div><div>Maya Lindqvist<br><span style="color:#a5b4fc;font-size:22px">Engineering Manager · October 7, 2026</span></div></div>`,
		},
		{
			tr: "fade",
			html: `<div class="kicker">Agenda</div><h2>Today we will cover</h2><div class="agenda">
${[
	["01", "Where we started", "Baseline from the Q2 review"],
	["02", "Results", "Startup time, uploads, file size"],
	["03", "Customer voice", "What users told us"],
	["04", "Roadmap", "Q4 milestones and owners"],
	["05", "Risks", "Memory growth on long recordings"],
	["06", "Q&amp;A", "Open discussion"],
]
	.map(
		([n, t, d]) =>
			`<div class="ai"><div class="n">${n}</div><div><div class="t">${t}</div><div class="d">${d}</div></div></div>`,
	)
	.join("")}</div>`,
		},
		{
			tr: "push",
			html: `<div class="kicker">01 · Baseline</div><h2>Where we started in July</h2><ul class="b">
<li>Recording took almost two seconds to start on Windows<span class="sub">Most of the time was spent creating the encoder and probing the camera</span></li>
<li>One in a hundred uploads failed on the first attempt<span class="sub">Hotel and conference Wi-Fi were the worst offenders</span></li>
<li>Text in screen recordings looked soft at 1080p<span class="sub">The encoder was tuned for camera footage, not for user interfaces</span></li></ul>
<div class="chips"><span class="chip">1.8 s to first frame</span><span class="chip">9.4 failures / 1,000</span><span class="chip">38 MB per minute</span></div>`,
		},
		{
			tr: "fade",
			html: `<div class="kicker">02 · Results</div><h2>Time to first frame, by platform</h2>${barChart()}`,
		},
		{
			cls: "dark",
			tr: "cover",
			html: `${landscape()}<div class="photo-cap"><div class="k">Design principle</div><div class="t">Fast should feel calm, not hurried.</div></div>`,
		},
		{
			tr: "cut",
			html: `<div class="kicker">02 · Results</div><h2>Before and after the new pipeline</h2><div class="cols2">
<div class="card"><h3>⏱ Q2 pipeline</h3><div class="row"><span>Encoder startup</span><b>1,240 ms</b></div><div class="row"><span>Camera probe</span><b>410 ms</b></div><div class="row"><span>First segment upload</span><b>6.2 s</b></div><div class="row"><span>Peak memory (30 min)</span><b>1.9 GB</b></div><div class="row"><span>CPU while idle</span><b>7.5%</b></div></div>
<div class="card after"><h3>⚡ Q3 pipeline</h3><div class="row"><span>Encoder startup</span><b>380 ms</b></div><div class="row"><span>Camera probe</span><b>95 ms</b></div><div class="row"><span>First segment upload</span><b>1.4 s</b></div><div class="row"><span>Peak memory (30 min)</span><b>1.1 GB</b></div><div class="row"><span>CPU while idle</span><b>2.1%</b></div></div></div>`,
		},
		{
			tr: "push",
			html: `<div class="kicker">02 · Results</div><h2>Failed uploads per 1,000 recordings</h2>${lineChart()}`,
		},
		{
			tr: "fade",
			html: `<div class="kicker">02 · Results</div><h2>The quarter in three numbers</h2><div class="kpis">
<div class="kpi"><div class="v">−61%</div><div class="l">Time to first frame</div><div class="s">Median across all desktop platforms, measured on 1.2M sessions</div></div>
<div class="kpi"><div class="v">4,118</div><div class="l">Recordings recovered</div><div class="s">Uploads that resumed after a dropped connection instead of failing</div></div>
<div class="kpi"><div class="v">99.72%</div><div class="l">Crash-free sessions</div><div class="s">Up from 99.31% in Q2, the best result since launch</div></div></div>`,
		},
		{
			tr: "cover",
			html: `<div class="kicker">03 · Customer voice</div><div class="quote">I hit record, explain the bug, and the link is already in my clipboard before I have finished talking. It feels like the app is waiting for me, not the other way round.</div>
<div class="qby"><div class="avatar" style="width:84px;height:84px;background:#0891b2;font-size:32px">PR</div><div><b>Priya Raman</b><div class="r">Staff Engineer, Northwind Logistics</div></div></div>`,
		},
		{
			tr: "fade",
			html: `<div class="kicker">04 · Roadmap</div><h2>Q4 milestones</h2><table class="rm"><tr><th>Milestone</th><th>Owner</th><th>Target</th><th>Status</th></tr>
<tr><td>Frame pool rewrite for long recordings</td><td>Marcus Feld</td><td>Oct 21</td><td><span class="pill prog">In progress</span></td></tr>
<tr><td>Screen content encoder, beta</td><td>Priya Raman</td><td>Nov 4</td><td><span class="pill prog">In progress</span></td></tr>
<tr><td>Windows on ARM native build</td><td>Daniel Okafor</td><td>Nov 18</td><td><span class="pill risk">At risk</span></td></tr>
<tr><td>Camera overlay GPU compositing</td><td>Lena Hoffmann</td><td>Dec 2</td><td><span class="pill plan">Planned</span></td></tr>
<tr><td>Upload resume on mobile networks</td><td>Sam Whitaker</td><td>Sep 30</td><td><span class="pill done">Done</span></td></tr></table>`,
		},
		{
			tr: "push",
			html: `<div class="kicker">04 · Roadmap</div><h2>How the next quarter fits together</h2><div class="timeline"><div class="line"></div>
${[
	["Oct 7", "Q3 review", "Today", 6],
	["Oct 21", "Frame pool", "Fix memory growth", 26],
	["Nov 4", "Encoder beta", "Opt-in for teams", 48],
	["Nov 18", "ARM build", "Native Windows on ARM", 70],
	["Dec 2", "GPU overlay", "Camera bubble on GPU", 92],
]
	.map(
		([d, t, x, p]) =>
			`<div class="ms" style="left:${p}%"><div class="d">${d}</div><div class="dot"></div><div class="t">${t}</div><div class="x">${x}</div></div>`,
	)
	.join("")}</div>`,
		},
		{
			tr: "cut",
			build: 3,
			html: `<div class="kicker">05 · Risks</div><h2>What could still go wrong</h2><ul class="b">
<li>Memory growth on long recordings with the camera enabled<span class="sub">Seen mostly on 8 GB machines after about 30 minutes</span></li>
<li class="build">Driver bugs in hardware encoders on older Intel GPUs<span class="sub">We fall back to software encoding, which costs battery life</span></li>
<li class="build">Windows on ARM toolchain is still changing<span class="sub">Two of our dependencies do not publish ARM64 builds yet</span></li>
<li class="build">Beta feedback may arrive late in the quarter<span class="sub">We are recruiting 40 design partners to test early</span></li></ul>`,
		},
		{
			tr: "fade",
			html: `<div class="kicker">Appendix</div><h2>Recording mix by resolution</h2>${donut()}`,
		},
		{
			cls: "title-slide dark end-slide",
			tr: "fade",
			html: `<h1 style="font-size:120px">Thank you</h1><div class="subt">Questions, ideas and complaints are all welcome in #capture-pipeline</div>`,
		},
	];

	const els = slides.map((s, i) => {
		const d = document.createElement("div");
		d.className = `slide ${s.cls || ""}`;
		d.innerHTML = s.html + (i > 0 && i < slides.length - 1 ? foot(i + 1) : "");
		deck.append(d);
		return d;
	});
	let cur = 0;
	let buildStep = 0;
	let anims = [];
	els[0].classList.add("show");

	function finishAnims() {
		for (const a of anims) a.finish();
		anims = [];
	}

	function go(next) {
		if (next < 0 || next >= els.length || next === cur) return;
		finishAnims();
		const from = els[cur];
		const to = els[next];
		const tr = next > cur ? slides[next].tr : "cut";
		to.classList.add("show");
		for (const b of to.querySelectorAll(".build")) b.classList.remove("on");
		buildStep = 0;
		const opts = {
			duration: tr === "fade" ? 600 : 650,
			easing: "cubic-bezier(.2,.7,.2,1)",
			fill: "both",
		};
		const done = () => {
			from.classList.remove("show");
			from.style.zIndex = "";
			to.style.zIndex = "";
		};
		cap.event("slide", { index: next, transition: tr });
		cur = next;
		if (tr === "cut") {
			done();
			return;
		}
		to.style.zIndex = 2;
		from.style.zIndex = 1;
		let a;
		if (tr === "fade") {
			a = to.animate([{ opacity: 0 }, { opacity: 1 }], opts);
		} else if (tr === "push") {
			a = to.animate(
				[{ transform: "translateX(100%)" }, { transform: "translateX(0)" }],
				opts,
			);
			anims.push(
				from.animate(
					[{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }],
					opts,
				),
			);
		} else {
			a = to.animate(
				[{ transform: "translateX(100%)" }, { transform: "translateX(0)" }],
				opts,
			);
		}
		anims.push(a);
		a.finished.then(() => {
			for (const x of [from, to])
				for (const an of x.getAnimations()) an.cancel();
			done();
		});
	}

	function advance() {
		const s = slides[cur];
		const builds = els[cur].querySelectorAll(".build");
		if (s.build && buildStep < builds.length) {
			builds[buildStep].classList.add("on");
			buildStep++;
			cap.event("build", { index: cur, step: buildStep });
			return;
		}
		go(cur + 1);
	}

	window.addEventListener("keydown", (e) => {
		if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) {
			e.preventDefault();
			advance();
		} else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) {
			e.preventDefault();
			go(cur - 1);
		}
	});
	window.addEventListener("mousedown", (e) => {
		if (e.target.closest("#webcam")) return;
		if (e.button === 0) advance();
	});

	window.capSlides = { go, advance, count: els.length, current: () => cur };
	window.capTextRegions = () => [
		[120, 80, 1400, 150],
		[120, 240, 1500, 560],
	];
})();
