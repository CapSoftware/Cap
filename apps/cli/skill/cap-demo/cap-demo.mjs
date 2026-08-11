#!/usr/bin/env node
// cap-demo orchestrator: URL in, cinematic 3D product-demo video out.
// Chains SCOUT + SHOOT (lib/scout-shoot.mjs) -> TREAT + EXPORT (lib/treat.py).
//
// Usage: cap-demo <url> [--out DIR] [--slug NAME] [--music ID] [--quality 4k|hd] [--story click|scroll]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, "lib");

// --- CLI ----------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { out: null, slug: null, music: null, quality: null, story: null };
const positionals = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const take = () => argv[++i];
	if (a === "--out" || a === "-o") opts.out = take();
	else if (a.startsWith("--out=")) opts.out = a.slice(6);
	else if (a === "--slug") opts.slug = take();
	else if (a.startsWith("--slug=")) opts.slug = a.slice(7);
	else if (a === "--music") opts.music = take();
	else if (a.startsWith("--music=")) opts.music = a.slice(8);
	else if (a === "--quality") opts.quality = take();
	else if (a.startsWith("--quality=")) opts.quality = a.slice(10);
	else if (a === "--story") opts.story = take();
	else if (a.startsWith("--story=")) opts.story = a.slice(8);
	else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
	else positionals.push(a);
}

function usage() {
	console.log(
		"Usage: cap-demo <url> [--out DIR] [--slug NAME] [--music ID] [--quality 4k|hd] [--story click|scroll]",
	);
}

const url = positionals[0];
if (!url) { usage(); fail("missing <url>"); }
if (opts.quality && opts.quality !== "4k" && opts.quality !== "hd") fail("--quality must be 4k or hd");
if (opts.story && opts.story !== "click" && opts.story !== "scroll") fail("--story must be click or scroll");

function fail(msg) {
	console.error(`cap-demo: ${msg}`);
	process.exit(1);
}

function slugFromUrl(u) {
	let host;
	try {
		host = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).host;
	} catch {
		host = u;
	}
	return (
		host
			.replace(/^www\./i, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "demo"
	);
}

const slug = opts.slug || slugFromUrl(url);
const outDir = opts.out || join(os.tmpdir(), "cap-demo", slug);
mkdirSync(outDir, { recursive: true });

// playwright-core is vendored into the skill; give a clear hint if missing.
if (!existsSync(join(__dirname, "node_modules", "playwright-core"))) {
	fail(`playwright-core not installed. Run: (cd "${__dirname}" && npm install)`);
}

// --- run a child, streaming stdout to the user and optionally capturing it -----
function run(cmd, cmdArgs, { capture = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "inherit"] });
		let buf = "";
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk);
			if (capture) buf += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve(buf) : reject(new Error(`${cmd} exited with code ${code}`)),
		);
	});
}

// Parse the scout's final machine-readable JSON line (last line with a `scout` key).
function parseScoutResult(out) {
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].startsWith("{")) continue;
		try {
			const o = JSON.parse(lines[i]);
			if (o && o.scout) return o;
		} catch {}
	}
	return null;
}

// Dark brand -> moody cinematic; light brand -> upbeat lofi.
function defaultMusic(scoutResult) {
	const bg = scoutResult?.scout?.pageBg;
	const light = Array.isArray(bg) && bg.reduce((a, b) => a + b, 0) / bg.length > 150;
	return light ? "sunday-mood-lofi-cafe-upbeat-bluelike" : "lofi-cinematic-pulsebox";
}

// --- pipeline -----------------------------------------------------------------
(async () => {
	console.log(`cap-demo: ${url}  ->  ${outDir}`);
	console.log(`[1/2] scout + shoot (slug=${slug}${opts.story ? `, story=${opts.story}` : ""})`);

	const shootArgs = [join(LIB, "scout-shoot.mjs"), url, outDir, slug];
	if (opts.story) shootArgs.push("--story", opts.story);

	let scoutOut;
	try {
		scoutOut = await run(process.execPath, shootArgs, { capture: true });
	} catch (e) {
		fail(`scout/shoot failed: ${e.message}`);
	}

	const scoutResult = parseScoutResult(scoutOut);
	const music = opts.music || defaultMusic(scoutResult);
	const decided = scoutResult
		? `story=${scoutResult.story} cta=${scoutResult.scout.ctaText ?? "none"}`
		: "story=?";

	console.log(`[2/2] treat + export (music=${music}${opts.quality ? `, quality=${opts.quality}` : ""})`);
	const treatArgs = [join(LIB, "treat.py"), outDir, slug, "--music", music];
	if (opts.quality) treatArgs.push("--quality", opts.quality);

	try {
		await run("python3", treatArgs, { capture: false });
	} catch (e) {
		fail(`treat/export failed: ${e.message}`);
	}

	const mp4 = join(outDir, `${slug}-demo.mp4`);
	console.log("");
	console.log(`Done: ${mp4}`);
	console.log(`  ${decided}, music=${music}${opts.quality ? `, ${opts.quality}` : ""}`);
})();
