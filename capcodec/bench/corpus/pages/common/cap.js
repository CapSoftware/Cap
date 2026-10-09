(() => {
	const buffer = [];
	const tracked = new Map();
	let nextId = 1;

	function now() {
		return Date.now();
	}

	function preciseNow() {
		return performance.timeOrigin + performance.now();
	}

	function push(record) {
		record.t = now();
		record.tp = Math.round(preciseNow() * 1000) / 1000;
		buffer.push(record);
	}

	function clientRect(el) {
		if (el === document.scrollingElement || el === document.documentElement) {
			const de = document.documentElement;
			return [0, 0, de.clientWidth, de.clientHeight];
		}
		const r = el.getBoundingClientRect();
		return [r.left + el.clientLeft, r.top + el.clientTop, el.clientWidth, el.clientHeight];
	}

	function track(el, name) {
		if (!el || tracked.has(el)) return;
		tracked.set(el, { id: name || el.dataset.scrollId || `s${nextId++}`, last: null });
	}

	function sample(src) {
		for (const [el, info] of tracked) {
			if (!el.isConnected) continue;
			const rect = clientRect(el);
			const sx = el.scrollLeft;
			const sy = el.scrollTop;
			const key = `${sx},${sy},${rect.join(",")}`;
			if (src !== "scroll" && info.last === key) continue;
			info.last = key;
			push({ k: "scroll", id: info.id, src, sx, sy, rect });
		}
	}

	function onFrame() {
		sample("raf");
		requestAnimationFrame(onFrame);
	}

	function flush() {
		if (!buffer.length || typeof window.__capReport !== "function") return;
		const batch = buffer.splice(0, buffer.length);
		window.__capReport(batch);
	}

	function event(type, data) {
		push({ k: "page", type, ...(data || {}) });
	}

	function trackAll() {
		track(document.scrollingElement, "document");
		for (const el of document.querySelectorAll("[data-scroll-id]")) track(el);
	}

	document.addEventListener("scroll", () => sample("scroll"), { capture: true, passive: true });
	for (const type of ["keydown", "keyup"]) {
		window.addEventListener(type, (e) => push({ k: "input", type, key: e.key, code: e.code }), { capture: true });
	}
	for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
		window.addEventListener(type, (e) => push({ k: "input", type, x: e.clientX, y: e.clientY, button: e.button }), { capture: true });
	}
	window.addEventListener(
		"wheel",
		(e) => push({ k: "input", type: "wheel", x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode }),
		{ capture: true, passive: true },
	);

	window.cap = { track, trackAll, event, flush, sample };
	window.capReady = false;
	window.capSetReady = () => {
		trackAll();
		sample("ready");
		event("ready", { w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
		document.fonts.ready.then(() => {
			requestAnimationFrame(() => requestAnimationFrame(() => {
				window.capReady = true;
			}));
		});
	};
	requestAnimationFrame(onFrame);
	setInterval(flush, 250);
})();
