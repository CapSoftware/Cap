// cap-demo SCOUT + SHOOT (adapted from director2.mjs; logic preserved verbatim,
// only I/O, path/binary resolution, CLI args and a final result line changed).
//
// Fully virtual input: CDP mouse/keyboard only (the user's real cursor is never
// touched); the cursor you see in the final video is synthesized from the logged
// glide path by treat.py. A near-invisible shimmer dot keeps the window capture
// emitting frames so the video clock never freezes on static content.
//
// Usage: node scout-shoot.mjs <url> <outDir> <slug> [--story click|scroll]
import { chromium } from "playwright-core";
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// --- CLI ----------------------------------------------------------------------
const argv = process.argv.slice(2);
const positionals = [];
let forceStory;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--story") {
		forceStory = argv[++i];
	} else if (a.startsWith("--story=")) {
		forceStory = a.slice("--story=".length);
	} else {
		positionals.push(a);
	}
}
const [url, outDir, slug] = positionals;
if (!url || !outDir || !slug) {
	throw new Error("usage: node scout-shoot.mjs <url> <outDir> <slug> [--story click|scroll]");
}
if (forceStory && forceStory !== "click" && forceStory !== "scroll") {
	throw new Error(`--story must be 'click' or 'scroll' (got '${forceStory}')`);
}
mkdirSync(outDir, { recursive: true });

// --- binary resolution --------------------------------------------------------
// Cap binary: env CAP_BIN, else `cap` on PATH, else a clear error.
function resolveCap() {
	if (process.env.CAP_BIN) return process.env.CAP_BIN;
	try {
		const p = execSync("command -v cap", { encoding: "utf8" }).trim();
		if (p) return p;
	} catch {}
	throw new Error(
		"cap CLI not found on PATH. Install Cap Desktop (https://cap.so) or set CAP_BIN.",
	);
}
const CAP = resolveCap();

// Chromium: newest cached ms-playwright chromium-*; fall back to the pinned build.
function resolveChromium() {
	const HOME = process.env.HOME;
	const suffix =
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
	const fallback = `${HOME}/Library/Caches/ms-playwright/chromium-1228/${suffix}`;
	try {
		const base = `${HOME}/Library/Caches/ms-playwright`;
		const dirs = readdirSync(base)
			.filter((d) => /^chromium-\d+$/.test(d))
			.map((d) => ({ d, n: parseInt(d.split("-")[1], 10) }))
			.sort((a, b) => b.n - a.n);
		for (const { d } of dirs) {
			const exe = join(base, d, suffix);
			if (existsSync(exe)) return exe;
		}
	} catch {}
	return fallback;
}
const EXE = resolveChromium();

const PROJECT = join(outDir, `${slug}.cap`);
const TIMELINE = join(outDir, `${slug}.timeline.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (b, s) => b + (Math.random() - 0.5) * s;

// Stale/closing test-chrome windows stay enumerable in `cap record windows` and
// the first-match can grab the WRONG one. Also close Finder/preview windows so
// they never composite into the bottom of the window capture.
try { execSync(`pkill -f "Google Chrome for Testing" || true`); } catch {}
try { execSync(`osascript -e 'tell application "Finder" to close every window' || true`); } catch {}
await sleep(800);

const browser = await chromium.launch({
	executablePath: EXE,
	headless: false,
	ignoreDefaultArgs: ["--enable-automation"],
	args: [
		"--window-size=1560,1000",
		"--window-position=120,60",
		"--disable-blink-features=AutomationControlled",
	],
});
const page = await browser.newPage({ viewport: null });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await sleep(2600);

// Dismiss cookie / consent banners so they never leak into a shot.
await page.evaluate(() => {
	const re = /^(accept|accept all|allow all|agree|i agree|got it|ok|reject all|decline|dismiss|close)$/i;
	for (const el of document.querySelectorAll("button, a, [role=button]")) {
		const t = (el.textContent || "").trim();
		if (re.test(t)) { try { el.click(); } catch {} }
	}
}).catch(() => {});
await sleep(400);

const geo = await page.evaluate(() => ({
	chromeTop: window.outerHeight - window.innerHeight,
	iw: window.innerWidth,
	ih: window.innerHeight,
}));
// Window-fraction mapping for aim targets and the synthetic cursor track.
const toFrac = (b) => ({
	x: (b.x + b.width / 2) / geo.iw,
	y: (geo.chromeTop + b.y + b.height / 2) / (geo.ih + geo.chromeTop),
});
const pointFrac = (p) => ({
	x: p.x / geo.iw,
	y: (geo.chromeTop + p.y) / (geo.ih + geo.chromeTop),
});

// Shimmer dot: 3px, 2% opacity, orbits 2px in a corner. Invisible to the eye,
// visible to the encoder. Re-injected after navigations.
const injectShimmer = () =>
	page
		.evaluate(() => {
			if (document.getElementById("__cap_shimmer")) return;
			const d = document.createElement("div");
			d.id = "__cap_shimmer";
			d.style.cssText =
				"position:fixed;right:6px;bottom:6px;width:3px;height:3px;background:rgba(127,127,127,0.02);z-index:2147483647;pointer-events:none;";
			document.documentElement.appendChild(d);
			let t = 0;
			const tick = () => {
				t += 0.25;
				d.style.transform = `translate(${Math.sin(t) * 2}px, ${Math.cos(t) * 2}px)`;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		})
		.catch(() => {});
await injectShimmer();

// --- Scout --------------------------------------------------------------------
const scout = await page.evaluate(() => {
	const vis = (el) => {
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none" && r.y < innerHeight * 1.1;
	};
	const hero =
		[...document.querySelectorAll("h1")].find(vis) ?? [...document.querySelectorAll("h2")].find(vis);
	const heroBox = hero ? hero.getBoundingClientRect() : null;
	const sameHost = (href) => {
		try {
			return new URL(href, location.href).host === location.host;
		} catch {
			return false;
		}
	};
	// Content destinations tell the story; conversion CTAs dead-end at forms.
	const ctaWords =
		/how it works|features|product|explore|browse|see|watch|demo|learn|courses|membership|events|about|pricing|showcase|gallery|tools|docs/i;
	const ctaBad = /try|free|sign ?up|register|get started|start now|join|book|download|log ?in|subscribe|get a demo|book a demo|request a demo|contact|talk to/i;
	const candidates = [...document.querySelectorAll("a, button")]
		.filter(vis)
		.map((el) => {
			const r = el.getBoundingClientRect();
			const s = getComputedStyle(el);
			const text = (el.textContent || "").trim();
			const href = el.tagName === "A" ? el.href : null;
			const bg = s.backgroundColor;
			const filled = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
			let score = 0;
			if (ctaWords.test(text)) score += 3;
			if (filled) score += 2;
			if (r.width > 110) score += 1;
			if (r.y > 120 && r.y < innerHeight * 0.85) score += 2;
			if (href && sameHost(href) && !href.includes("#")) score += 2;
			if (href && new URL(href).pathname === location.pathname) score -= 3;
			if (/login|log in|sign in/i.test(text)) score -= 4;
			if (ctaBad.test(text)) score -= 5;
			if (href && /\/(blog|changelog|careers|jobs|news|press)(\/|$)/i.test(new URL(href).pathname)) score -= 5;
			if (/↗|↗️|external/i.test(text)) score -= 3;
			return {
				text: text.slice(0, 48),
				href,
				score,
				box: { x: r.x, y: r.y, width: r.width, height: r.height },
				filled,
				bg,
			};
		})
		.filter((c) => c.text && c.score >= 5)
		.sort((a, b) => b.score - a.score);
	const parse = (c) => {
		const m = c?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		return m ? [+m[1], +m[2], +m[3]] : null;
	};
	let pageBg = null;
	for (const el of [document.body, document.documentElement, ...document.querySelectorAll("main, header, section")]) {
		const c = parse(getComputedStyle(el).backgroundColor);
		if (c) {
			pageBg = c;
			break;
		}
	}
	const filledCta = candidates.find((c) => c.filled);
	return {
		title: document.title,
		heroBox,
		candidates: candidates.slice(0, 5),
		pageBg,
		accent: filledCta ? parse(filledCta.bg) : null,
	};
});
const cta = scout.candidates[0] ?? null;
const story = forceStory ?? (cta?.href ? "click" : "scroll");
console.log(`STORY=${story} cta=${cta?.text ?? "none"} accent=${scout.accent} bg=${scout.pageBg}`);

// --- Virtual cursor -----------------------------------------------------------
const events = [];
const cursorLog = { moves: [], clicks: [] };
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;
let vpos = { x: geo.iw * 0.55, y: geo.ih * 0.45 };

const logMove = () => {
	const f = pointFrac(vpos);
	cursorLog.moves.push({ t: now(), x: f.x, y: f.y });
};
const vmove = async (p) => {
	vpos = p;
	await page.mouse.move(p.x, p.y).catch(() => {});
	logMove();
};
async function glide(to, ms) {
	const from = { ...vpos };
	const steps = Math.max(8, Math.round(ms / 16));
	for (let i = 1; i <= steps; i++) {
		const t = i / steps,
			e = t * t * (3 - 2 * t);
		await vmove({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
		await sleep(ms / steps);
	}
}
const vclick = async () => {
	cursorLog.clicks.push({ t: now(), down: true });
	await page.mouse.down().catch(() => {});
	await sleep(70);
	await page.mouse.up().catch(() => {});
	cursorLog.clicks.push({ t: now() - 0.001, down: false });
};
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const pageTitle = await page.title();
const windows = JSON.parse(execFileSync(CAP, ["record", "windows", "--json"], { encoding: "utf8" }));
const chromeWins = windows.filter(
	(w) => /Chrome for Testing/i.test(w.ownerName ?? "") || /Chrome for Testing/i.test(w.name ?? ""),
);
let win = chromeWins.find((w) => (w.name ?? "").trim() === pageTitle.trim());
if (!win && chromeWins.length === 1) win = chromeWins[0];
if (!win) throw new Error(`window not found (title="${pageTitle}", ${chromeWins.length} chrome windows: ${chromeWins.map((w) => w.name).join(" | ")})`);

execFileSync(CAP, ["record", "start", "--detach", "--window", String(win.id), "--fps", "60", "--path", PROJECT], {
	encoding: "utf8",
});
t0 = Date.now();
const mark = (n, extra = {}) => {
	events.push({ name: n, t: now(), ...extra });
	console.log(`[${now().toFixed(2)}s] ${n}`);
};

try {
	logMove();
	if (scout.heroBox) mark("hero_frac", toFrac(scout.heroBox));
	await sleep(1300);

	if (story === "click" && cta) {
		const c = center(cta.box);
		mark("cta_frac", toFrac(cta.box));
		mark("drift_to_cta");
		await glide({ x: c.x + 16, y: c.y + 24 }, 700);
		await glide(c, 380);
		await sleep(420);
		mark("click_cta");
		await vclick();
		await page.waitForLoadState("load", { timeout: 25000 }).catch(() => {});
		await injectShimmer();
		await sleep(1100);
		mark("page_ready");
		const head2 = await page
			.locator("h1, h2")
			.first()
			.boundingBox()
			.catch(() => null);
		if (head2 && head2.y < geo.ih) mark("page2_frac", toFrac(head2));
		await glide({ x: geo.iw * 0.55, y: geo.ih * 0.5 }, 800);
		await sleep(1100);
	} else {
		mark("drift_hero");
		await glide({ x: geo.iw * 0.5, y: geo.ih * 0.45 }, 900);
		await sleep(500);
		mark("scroll1_start");
		await page.evaluate((d) => window.scrollBy({ top: d, behavior: "smooth" }), Math.round(geo.ih * 0.95));
		await glide({ x: vpos.x + 90, y: vpos.y + 120 }, 900);
		await sleep(800);
		mark("scroll1_settled");
		await sleep(1500);
	}

	mark("scroll_start");
	await page.evaluate(() => window.scrollBy({ top: 700, behavior: "smooth" }));
	await glide({ x: vpos.x + 110, y: vpos.y + 130 }, 900);
	await sleep(800);
	mark("scroll_settled");
	// Gentle idle drift for the settle; shimmer keeps the clock honest anyway.
	const until = Date.now() + 2300;
	while (Date.now() < until) {
		await vmove({ x: vpos.x + jitter(0, 2.4), y: vpos.y + jitter(0, 2.4) });
		await sleep(150);
	}
	mark("end");
} finally {
	execFileSync(CAP, ["record", "stop"], { encoding: "utf8" });
	writeFileSync(
		TIMELINE,
		JSON.stringify({ story, scout: { ...scout, candidates: undefined }, events, cursorLog }, null, 1),
	);
	await browser.close();
}

// Final machine-readable line: what the scout decided (orchestrator/agent reads this).
console.log(
	JSON.stringify({
		slug,
		story,
		scout: {
			title: scout.title,
			hero: scout.heroBox,
			accent: scout.accent,
			pageBg: scout.pageBg,
			ctaText: cta?.text ?? null,
		},
	}),
);
console.log("DONE");
