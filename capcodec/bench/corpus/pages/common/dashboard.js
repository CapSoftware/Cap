(() => {
	const rng = window.mulberry32(20261007);
	const rand = (a, b) => a + (b - a) * rng();
	const pick = (arr) => arr[Math.floor(rng() * arr.length)];
	const gauss = () => {
		let s = 0;
		for (let i = 0; i < 4; i++) s += rng();
		return (s - 2) / 0.58;
	};
	const dpr = () => window.devicePixelRatio || 1;
	const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
	const fmt1 = (v) =>
		v.toLocaleString("en-US", {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		});
	const fmt2 = (v) =>
		v.toLocaleString("en-US", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
	const el = (tag, cls, html) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html !== undefined) e.innerHTML = html;
		return e;
	};

	const startPerf = performance.now();
	const baseClock = new Date(2026, 9, 7, 14, 32, 5).getTime();
	const vnow = () => baseClock + (performance.now() - startPerf);
	const pad = (n) => String(n).padStart(2, "0");
	const hms = (ms) => {
		const d = new Date(ms);
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	};

	function sizeCanvas(c) {
		const r = c.getBoundingClientRect();
		const k = dpr();
		c.width = Math.round(r.width * k);
		c.height = Math.round(r.height * k);
		const ctx = c.getContext("2d");
		ctx.setTransform(k, 0, 0, k, 0, 0);
		return { ctx, w: r.width, h: r.height };
	}

	function drawSpark(c, data, color, fill) {
		if (!c._ctx)
			Object.assign(
				c,
				(({ ctx, w, h }) => ({ _ctx: ctx, _w: w, _h: h }))(sizeCanvas(c)),
			);
		const ctx = c._ctx;
		const w = c._w;
		const h = c._h;
		ctx.clearRect(0, 0, w, h);
		const lo = Math.min(...data);
		let hi = Math.max(...data);
		if (hi - lo < 1e-9) hi = lo + 1;
		const padY = 2;
		const xs = (i) => (i / (data.length - 1)) * (w - 2) + 1;
		const ys = (v) => h - padY - ((v - lo) / (hi - lo)) * (h - 2 * padY);
		ctx.beginPath();
		data.forEach((v, i) =>
			i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v)),
		);
		if (fill) {
			ctx.save();
			ctx.lineTo(xs(data.length - 1), h);
			ctx.lineTo(xs(0), h);
			ctx.closePath();
			const g = ctx.createLinearGradient(0, 0, 0, h);
			g.addColorStop(0, `${color}38`);
			g.addColorStop(1, `${color}00`);
			ctx.fillStyle = g;
			ctx.fill();
			ctx.restore();
			ctx.beginPath();
			data.forEach((v, i) =>
				i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v)),
			);
		}
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.lineJoin = "round";
		ctx.stroke();
		const lx = xs(data.length - 1);
		const ly = ys(data[data.length - 1]);
		if (fill) {
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	const grid = document.getElementById("grid");
	const tip = document.getElementById("tip");

	const kpiDefs = [
		{
			lab: "Active users",
			v: 18432,
			dv: 0.004,
			f: fmtInt,
			unit: "",
			vs: "+6.2%",
			color: "#4f46e5",
			up: true,
		},
		{
			lab: "Requests / s",
			v: 2864,
			dv: 0.03,
			f: fmtInt,
			unit: "",
			vs: "+3.9%",
			color: "#0891b2",
			up: true,
		},
		{
			lab: "p95 latency",
			v: 184,
			dv: 0.04,
			f: fmtInt,
			unit: "ms",
			vs: "−11 ms",
			color: "#d97706",
			up: true,
		},
		{
			lab: "Error rate",
			v: 0.42,
			dv: 0.06,
			f: fmt2,
			unit: "%",
			vs: "+0.05 pp",
			color: "#dc2626",
			up: false,
		},
		{
			lab: "Revenue today",
			v: 48213.5,
			dv: 0,
			f: (v) => `$${fmtInt(v)}`,
			unit: "",
			vs: "+12.4%",
			color: "#16a34a",
			up: true,
		},
		{
			lab: "Conversion",
			v: 3.18,
			dv: 0.01,
			f: fmt2,
			unit: "%",
			vs: "+0.21 pp",
			color: "#9333ea",
			up: true,
		},
	];
	const kpis = kpiDefs.map((d, i) => {
		const p = el("div", "panel kpi");
		p.innerHTML = `<div class="lab">${d.lab}</div><div class="val num"></div><div class="dl"><span class="${d.up ? "up" : "dn"}">${d.up ? "▲" : "▼"} ${d.vs}</span><span class="vs">vs. last hour</span></div><canvas></canvas>`;
		grid.append(p);
		const hist = [];
		let v = d.v;
		for (let k = 0; k < 32; k++) {
			v = i === 4 ? v - rand(30, 160) : v * (1 + gauss() * d.dv * 0.6);
			hist.unshift(v);
		}
		hist[hist.length - 1] = d.v;
		return {
			d,
			p,
			val: p.querySelector(".val"),
			canvas: p.querySelector("canvas"),
			hist,
			v: d.v,
		};
	});

	function renderKpi(k) {
		k.val.innerHTML = `${k.d.f(k.v)}${k.d.unit ? `<small>${k.d.unit}</small>` : ""}`;
		drawSpark(k.canvas, k.hist, k.d.color, true);
	}

	class LineChart {
		constructor(panel, opts) {
			this.panel = panel;
			this.opts = opts;
			this.canvas = panel.querySelector("canvas");
			this.series = opts.series.map((s) => ({ ...s, data: [] }));
			this.n = 90;
			this.times = [];
			const t0 = vnow() - this.n * 1000;
			for (let i = 0; i <= this.n; i++) {
				this.times.push(t0 + i * 1000);
				const vals = opts.gen(i - this.n);
				this.series.forEach((s, j) => s.data.push(vals[j]));
			}
			this.anim = null;
			this.yMax = this.targetMax();
			this.hover = null;
			this.dirty = true;
			const sized = sizeCanvas(this.canvas);
			this.ctx = sized.ctx;
			this.w = sized.w;
			this.h = sized.h;
			this.left = 46;
			this.right = 10;
			this.top = 10;
			this.bottom = 22;
			this.canvas.addEventListener("mousemove", (e) => {
				const r = this.canvas.getBoundingClientRect();
				this.hover = {
					x: e.clientX - r.left,
					y: e.clientY - r.top,
					cx: e.clientX,
					cy: e.clientY,
				};
				this.dirty = true;
			});
			this.canvas.addEventListener("mouseleave", () => {
				this.hover = null;
				tip.style.display = "none";
				this.dirty = true;
			});
		}

		targetMax() {
			let m = 0;
			for (const s of this.series)
				for (const v of s.data.slice(-this.n - 1)) m = Math.max(m, v);
			const step = this.opts.step;
			return Math.ceil((m * 1.12) / step) * step;
		}

		push(vals, t) {
			this.series.forEach((s, j) => {
				s.data.push(vals[j]);
				if (s.data.length > this.n + 3) s.data.shift();
			});
			this.times.push(t);
			if (this.times.length > this.n + 3) this.times.shift();
			this.anim = {
				t0: performance.now(),
				dur: 420,
				from: this.yMax,
				to: this.targetMax(),
			};
			this.dirty = true;
		}

		draw(now) {
			let frac = 1;
			if (this.anim) {
				const p = Math.min(1, (now - this.anim.t0) / this.anim.dur);
				frac = 1 - (1 - p) ** 3;
				this.yMax = this.anim.from + (this.anim.to - this.anim.from) * frac;
				if (p >= 1) this.anim = null;
				this.dirty = true;
			}
			if (!this.dirty) return;
			this.dirty = !!this.anim;
			const { ctx, w, h, left, right, top, bottom } = this;
			const pw = w - left - right;
			const ph = h - top - bottom;
			ctx.clearRect(0, 0, w, h);
			ctx.font = '11px "Noto Sans", "Liberation Sans", sans-serif';
			ctx.textBaseline = "middle";
			const yTicks = 5;
			for (let i = 0; i <= yTicks; i++) {
				const y = Math.round(top + ph - (i / yTicks) * ph) + 0.5;
				ctx.strokeStyle = i === 0 ? "#d5d9df" : "#eef0f3";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(left, y);
				ctx.lineTo(left + pw, y);
				ctx.stroke();
				ctx.fillStyle = "#8a94a3";
				ctx.textAlign = "right";
				ctx.fillText(this.opts.axis((i / yTicks) * this.yMax), left - 8, y);
			}
			const step = pw / (this.n - 1);
			const len = this.times.length;
			const shift = this.anim ? 1 - frac : 0;
			const xOf = (idx) => left + pw - (len - 1 - idx - shift) * step;
			const yOf = (v) => top + ph - (v / this.yMax) * ph;
			ctx.save();
			ctx.beginPath();
			ctx.rect(left, top - 2, pw, ph + 4);
			ctx.clip();
			this.series.forEach((s, j) => {
				ctx.beginPath();
				s.data.forEach((v, i) =>
					i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)),
				);
				if (j === 0) {
					ctx.save();
					ctx.lineTo(xOf(len - 1), top + ph);
					ctx.lineTo(xOf(0), top + ph);
					ctx.closePath();
					const g = ctx.createLinearGradient(0, top, 0, top + ph);
					g.addColorStop(0, `${s.color}30`);
					g.addColorStop(1, `${s.color}02`);
					ctx.fillStyle = g;
					ctx.fill();
					ctx.restore();
					ctx.beginPath();
					s.data.forEach((v, i) =>
						i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)),
					);
				}
				ctx.strokeStyle = s.color;
				ctx.lineWidth = s.width || 1.6;
				ctx.lineJoin = "round";
				ctx.setLineDash(s.dash || []);
				ctx.stroke();
				ctx.setLineDash([]);
			});
			ctx.restore();
			ctx.textAlign = "center";
			ctx.fillStyle = "#8a94a3";
			for (let i = 0; i < len; i++) {
				const t = this.times[i];
				if (Math.round(t / 1000) % 15 !== 0) continue;
				const x = xOf(i);
				if (x < left + 18 || x > left + pw - 18) continue;
				ctx.fillText(hms(t), x, top + ph + 12);
				ctx.strokeStyle = "#d5d9df";
				ctx.beginPath();
				ctx.moveTo(Math.round(x) + 0.5, top + ph);
				ctx.lineTo(Math.round(x) + 0.5, top + ph + 4);
				ctx.stroke();
			}
			if (
				this.hover &&
				this.hover.x >= left &&
				this.hover.x <= left + pw &&
				this.hover.y >= top &&
				this.hover.y <= top + ph
			) {
				let best = len - 1;
				let bd = Number.POSITIVE_INFINITY;
				for (let i = 0; i < len; i++) {
					const d = Math.abs(xOf(i) - this.hover.x);
					if (d < bd) {
						bd = d;
						best = i;
					}
				}
				const x = Math.round(xOf(best)) + 0.5;
				ctx.strokeStyle = "#9aa3af";
				ctx.setLineDash([3, 3]);
				ctx.beginPath();
				ctx.moveTo(x, top);
				ctx.lineTo(x, top + ph);
				ctx.stroke();
				ctx.setLineDash([]);
				let html = `<b>${hms(this.times[best])}</b><br>`;
				for (const s of this.series) {
					const v = s.data[best];
					ctx.fillStyle = "#fff";
					ctx.strokeStyle = s.color;
					ctx.lineWidth = 2;
					ctx.beginPath();
					ctx.arc(x, yOf(v), 3.5, 0, Math.PI * 2);
					ctx.fill();
					ctx.stroke();
					html += `<i style="background:${s.color}"></i>${s.name} <b class="num">${this.opts.tip(v)}</b><br>`;
				}
				tip.innerHTML = html;
				tip.style.display = "block";
				const tw = tip.offsetWidth;
				const tx =
					this.hover.cx + 16 + tw > innerWidth
						? this.hover.cx - 16 - tw
						: this.hover.cx + 16;
				tip.style.left = `${tx}px`;
				tip.style.top = `${this.hover.cy - 30}px`;
			}
		}
	}

	function chartPanel(cls, title, sub, series) {
		const p = el("div", `panel chart${cls}`);
		p.innerHTML = `<h4>${title}<span class="sub">${sub}</span></h4><div class="legend">${series
			.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`)
			.join("")}</div><canvas></canvas>`;
		grid.append(p);
		return p;
	}

	let rpsBase = 2800;
	const rpsSeries = [
		{ name: "2xx", color: "#0891b2", width: 1.8 },
		{ name: "4xx", color: "#d97706" },
		{ name: "5xx", color: "#dc2626" },
	];
	const latSeries = [
		{ name: "p50", color: "#4f46e5", width: 1.8 },
		{ name: "p95", color: "#d97706" },
		{ name: "p99", color: "#dc2626", dash: [4, 3] },
	];
	const rpsGen = (i) => {
		rpsBase += gauss() * 40 + (2850 - rpsBase) * 0.05 + Math.sin(i / 9) * 12;
		const spike = rng() < 0.04 ? rand(1.1, 1.3) : 1;
		const ok = rpsBase * spike;
		return [
			ok,
			ok * rand(0.035, 0.06),
			ok * rand(0.002, 0.009) * (rng() < 0.05 ? 4 : 1),
		];
	};
	let latBase = 62;
	const latGen = () => {
		latBase += gauss() * 3 + (62 - latBase) * 0.08;
		const p95 = latBase * rand(2.7, 3.2) * (rng() < 0.05 ? 1.5 : 1);
		return [latBase, p95, p95 * rand(1.5, 2.1)];
	};
	const rpsChart = new LineChart(
		chartPanel(
			"",
			"Requests per second",
			"by status class · 1 s resolution",
			rpsSeries,
		),
		{
			series: rpsSeries,
			gen: rpsGen,
			step: 500,
			axis: (v) => (v >= 1000 ? `${fmt1(v / 1000)}k` : fmtInt(v)),
			tip: (v) => `${fmtInt(v)} req/s`,
		},
	);
	const latChart = new LineChart(
		chartPanel(" r", "Latency", "all endpoints · ms", latSeries),
		{
			series: latSeries,
			gen: latGen,
			step: 100,
			axis: (v) => `${fmtInt(v)}`,
			tip: (v) => `${fmtInt(v)} ms`,
		},
	);
	const charts = [rpsChart, latChart];

	const endpoints = [
		["GET", "/api/v2/orders"],
		["POST", "/api/v2/orders"],
		["GET", "/api/v2/orders/:id"],
		["GET", "/api/v2/products"],
		["GET", "/api/v2/products/:sku"],
		["GET", "/api/v2/cart"],
		["POST", "/api/v2/cart/items"],
		["DELETE", "/api/v2/cart/items/:id"],
		["POST", "/api/v2/checkout"],
		["POST", "/api/v2/payments/intent"],
		["GET", "/api/v2/users/me"],
		["PATCH", "/api/v2/users/me"],
		["POST", "/api/v2/auth/token"],
		["POST", "/api/v2/auth/refresh"],
		["GET", "/api/v2/search"],
		["GET", "/api/v2/recommendations"],
		["POST", "/api/v2/events/batch"],
		["GET", "/healthz"],
	];
	const tblPanel = el("div", "panel tbl");
	tblPanel.innerHTML = `<h4>Top endpoints<span class="sub">sorted by traffic · last 5 min</span><span class="acts"><span>Export CSV</span><span>Columns ▾</span></span></h4>`;
	const table = el("table", "num");
	table.innerHTML =
		"<thead><tr><th>Endpoint</th><th>Req/min</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th><th>Error %</th><th>Apdex</th><th>Throughput (15 min)</th></tr></thead>";
	const tbody = el("tbody");
	table.append(tbody);
	tblPanel.append(table);
	grid.append(tblPanel);
	const rows = endpoints.map(([m, path], i) => {
		const rpm = Math.round(42000 / (1 + i * 0.55) ** 1.25 + rand(-400, 400));
		const p50 = Math.round(rand(14, 90) * (m === "POST" ? 1.6 : 1));
		const r = {
			m,
			path,
			rpm,
			p50,
			p95: Math.round(p50 * rand(2.4, 3.6)),
			p99: 0,
			err: 0,
			hist: [],
		};
		r.p99 = Math.round(r.p95 * rand(1.4, 2.2));
		r.errPct = path === "/healthz" ? 0 : rand(0.02, 1.1);
		r.err = Math.round((r.rpm * 5 * r.errPct) / 100);
		r.apdex = Math.min(0.99, 1.02 - r.p95 / 900 - r.errPct / 30);
		for (let k = 0; k < 30; k++)
			r.hist.push(r.rpm * (1 + gauss() * 0.06 + Math.sin(k / 4 + i) * 0.05));
		const tr = el("tr");
		tr.innerHTML = `<td class="ep"><span class="m">${m}</span>${path}</td><td data-c="rpm"></td><td data-c="p50"></td><td data-c="p95"></td><td data-c="p99"></td><td data-c="err"></td><td data-c="errPct"></td><td><span data-c="apdex"></span><span class="bar"><i></i></span></td><td><canvas></canvas></td>`;
		tbody.append(tr);
		r.tr = tr;
		r.cells = Object.fromEntries(
			[...tr.querySelectorAll("[data-c]")].map((c) => [c.dataset.c, c]),
		);
		r.barI = tr.querySelector(".bar i");
		r.canvas = tr.querySelector("canvas");
		return r;
	});

	function renderRow(r, flash) {
		const vals = {
			rpm: fmtInt(r.rpm),
			p50: `${r.p50} ms`,
			p95: `${r.p95} ms`,
			p99: `${r.p99} ms`,
			err: fmtInt(r.err),
			errPct: `${fmt2(r.errPct)}%`,
			apdex: r.apdex.toFixed(2),
		};
		for (const [k, v] of Object.entries(vals)) {
			const c = r.cells[k];
			if (c.textContent === v) continue;
			c.textContent = v;
			if (flash && k !== "apdex") {
				c.classList.remove("flash");
				void c.offsetWidth;
				c.classList.add("flash");
			}
		}
		r.cells.errPct.className = r.errPct > 0.8 ? "dn" : "";
		r.barI.style.width = `${Math.round(r.apdex * 100)}%`;
		r.barI.style.background =
			r.apdex > 0.85 ? "#22c55e" : r.apdex > 0.7 ? "#f59e0b" : "#ef4444";
		drawSpark(r.canvas, r.hist, "#6366f1", false);
	}

	const side = el("div", "side");
	const errPanel = el("div", "panel errs");
	errPanel.innerHTML = `<h4>Errors by type<span class="sub">last 15 min</span><span class="acts"><span>View all</span></span></h4>`;
	const errTypes = [
		["UpstreamTimeout (payments)", 412],
		["HTTP 502 Bad Gateway", 268],
		["ValidationError: sku", 191],
		["RateLimitExceeded", 143],
		["ConnectionResetError", 87],
		["KeyError: 'currency'", 41],
	].map(([n, c]) => {
		const row = el(
			"div",
			"er",
			`<span class="n">${n}</span><span class="b"><i></i></span><span class="c num"></span>`,
		);
		errPanel.append(row);
		return { n, c, i: row.querySelector("i"), cEl: row.querySelector(".c") };
	});
	const feedPanel = el("div", "panel feed");
	feedPanel.innerHTML = `<h4>Live events<span class="sub">all services</span><span class="acts"><span>Pause</span><span>Filter ▾</span></span></h4>`;
	const feedList = el("div");
	feedPanel.append(feedList);
	side.append(errPanel, feedPanel);
	grid.append(side);

	function renderErrs() {
		const max = Math.max(...errTypes.map((e) => e.c));
		for (const e of errTypes) {
			e.i.style.width = `${((e.c / max) * 100).toFixed(1)}%`;
			e.cEl.textContent = fmtInt(e.c);
		}
	}

	const services = [
		"api-gateway",
		"checkout-svc",
		"payments-svc",
		"cart-svc",
		"search-svc",
		"catalog-svc",
		"auth-svc",
		"worker-events",
	];
	const pods = () =>
		`${pick(services)}-${Math.floor(rand(4096, 65535)).toString(16)}-${pick(["x7k2p", "m4q9z", "t2v8c", "b6n1r", "h3d5w"])}`;
	const eventTemplates = [
		[
			"info",
			() =>
				`deploy <b>${pick(services)}</b> v2.${Math.floor(rand(30, 48))}.${Math.floor(rand(0, 9))} rolled out to ${Math.floor(rand(6, 13))}/12 pods`,
		],
		[
			"info",
			() =>
				`autoscaler: <b>${pick(services)}</b> scaled ${Math.floor(rand(4, 7))} → ${Math.floor(rand(7, 11))} replicas`,
		],
		[
			"warn",
			() =>
				`p95 latency on <b>/api/v2/${pick(["search", "checkout", "orders", "recommendations"])}</b> above ${pick([300, 400, 500])} ms`,
		],
		[
			"err",
			() =>
				`<b>payments-svc</b> 502 from upstream stripe-proxy (${Math.floor(rand(2, 30))} in 60 s)`,
		],
		[
			"info",
			() =>
				`cache hit ratio ${fmt1(rand(91, 97))}% on redis-${pick(["main", "sessions", "catalog"])}`,
		],
		[
			"info",
			() =>
				`job <b>${pick(["nightly-reindex", "export-orders", "sync-inventory", "gc-sessions"])}</b> completed in ${Math.floor(rand(1, 9))}m${pad(Math.floor(rand(0, 59)))}s`,
		],
		["warn", () => `pod <b>${pods()}</b> restarted (OOMKilled)`],
		[
			"info",
			() =>
				`alert resolved: ${pick(["High error rate", "Disk usage > 80%", "Queue backlog"])} on ${pick(services)}`,
		],
		[
			"err",
			() =>
				`<b>${pick(services)}</b> ${pick(["ConnectionResetError", "UpstreamTimeout", "KeyError: 'currency'"])} in ${pick(["handler.py:212", "client.go:88", "routes.ts:47"])}`,
		],
		[
			"info",
			() =>
				`${pick(["sw", "mk", "jl", "ar"])}@acme.io acknowledged INC-${Math.floor(rand(2200, 2400))}`,
		],
		[
			"warn",
			() =>
				`queue <b>${pick(["events.batch", "emails", "webhooks"])}</b> depth ${fmtInt(rand(1200, 9000))} (consumer lag ${fmt1(rand(1, 9))} s)`,
		],
	];
	function addEvent(animate, tms) {
		const [lv, f] = pick(eventTemplates);
		const ev = el(
			"div",
			`ev${animate ? " new" : ""}`,
			`<span class="t">${hms(tms)}</span><span class="lv ${lv}">${lv.toUpperCase()}</span><span>${f()}</span>`,
		);
		feedList.prepend(ev);
		while (feedList.children.length > 16) feedList.lastChild.remove();
		if (animate) cap.event("dash_event", { level: lv });
	}
	for (let i = 14; i >= 0; i--) addEvent(false, vnow() - i * rand(2000, 6000));

	for (const k of kpis) renderKpi(k);
	for (const r of rows) renderRow(r, false);
	renderErrs();

	const upd = document.getElementById("upd");
	const lag = document.getElementById("lag");
	const pts = document.getElementById("pts");
	const cd = document.getElementById("cd");
	let points = 1284331;
	let tickNo = 0;
	let countdown = 10;
	const timers = [];
	const later = (ms, fn) => timers.push(setTimeout(fn, ms));

	function tick() {
		tickNo++;
		const t = vnow();
		upd.textContent = hms(t);
		lag.textContent = `${fmt1(rand(0.4, 1.4))} s`;
		points += Math.floor(rand(2400, 3400));
		pts.textContent = fmtInt(points);
		countdown = countdown <= 1 ? 10 : countdown - 1;
		cd.textContent = `${countdown}s`;
		later(30, () => rpsChart.push(rpsGen(tickNo), t));
		later(90, () => latChart.push(latGen(), t));
		kpis.forEach((k, i) => {
			later(140 + i * 110, () => {
				if (i === 4) k.v += rand(8, 140) * (rng() < 0.25 ? 3 : 1);
				else k.v *= 1 + gauss() * k.d.dv * 0.5;
				if (i === 1)
					k.v =
						rpsChart.series[0].data.at(-1) +
						rpsChart.series[1].data.at(-1) +
						rpsChart.series[2].data.at(-1);
				if (i === 2) k.v = latChart.series[1].data.at(-1);
				k.hist.push(k.v);
				k.hist.shift();
				renderKpi(k);
			});
		});
		const nUpd = countdown === 10 ? rows.length : Math.floor(rand(3, 7));
		const chosen = new Set();
		while (chosen.size < nUpd) chosen.add(Math.floor(rng() * rows.length));
		[...chosen].forEach((idx, j) => {
			later(220 + j * 45, () => {
				const r = rows[idx];
				r.rpm = Math.max(10, Math.round(r.rpm * (1 + gauss() * 0.025)));
				r.p50 = Math.max(3, Math.round(r.p50 * (1 + gauss() * 0.04)));
				r.p95 = Math.max(r.p50 + 4, Math.round(r.p95 * (1 + gauss() * 0.05)));
				r.p99 = Math.max(r.p95 + 6, Math.round(r.p99 * (1 + gauss() * 0.06)));
				if (r.path !== "/healthz")
					r.errPct = Math.max(0, r.errPct * (1 + gauss() * 0.08));
				r.err = Math.round((r.rpm * 5 * r.errPct) / 100);
				r.apdex = Math.max(
					0.4,
					Math.min(0.99, 1.02 - r.p95 / 900 - r.errPct / 30),
				);
				r.hist.push(r.rpm);
				r.hist.shift();
				renderRow(r, true);
			});
		});
		if (tickNo % 2 === 0) {
			later(500, () => {
				for (const e of errTypes)
					e.c += Math.floor(rand(0, 6) * (rng() < 0.15 ? 4 : 1));
				renderErrs();
			});
		}
	}

	function eventLoop() {
		addEvent(true, vnow());
		later(rand(900, 2300), eventLoop);
	}

	function frame(now) {
		for (const c of charts) c.draw(now);
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
	upd.textContent = hms(vnow());

	let started = false;
	window.capStart = () => {
		if (started) return;
		started = true;
		const msToNext = 1000 - (Math.round(vnow()) % 1000);
		later(msToNext, () => {
			tick();
			timers.push(setInterval(tick, 1000));
		});
		later(700, eventLoop);
	};
	window.capStop = () => {
		for (const t of timers) {
			clearTimeout(t);
			clearInterval(t);
		}
	};
	window.capTextRegions = () => {
		const tb = tbody.getBoundingClientRect();
		const kr = kpis[0].p.getBoundingClientRect();
		const kl = kpis[2].p.getBoundingClientRect();
		const fr = feedList.getBoundingClientRect();
		return [
			[tb.left, tb.top, Math.min(820, tb.width), Math.min(400, tb.height)],
			[kr.left, kr.top, kl.right - kr.left, kr.height],
			[fr.left, fr.top, fr.width, Math.min(320, fr.height)],
		];
	};
})();
