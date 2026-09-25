import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { directory, ids, origin } from "./paths.mjs";

const deadline = Date.now() + 150_000;
while (true) {
	try {
		await readFile(join(directory, "browser-states.json"));
		const response = await fetch(`${origin}/login`, {
			signal: AbortSignal.timeout(5_000),
		});
		if (response.ok) break;
	} catch {}
	if (Date.now() > deadline)
		throw new Error("Demo server did not become ready");
	await setTimeout(1_000);
}
const states = JSON.parse(
	await readFile(join(directory, "browser-states.json"), "utf8"),
);
const browser = await chromium.launch({
	headless: true,
	...(process.platform === "darwin" ? { channel: "chrome" } : {}),
});
try {
	const context = await browser.newContext({ storageState: states.owner });
	const page = await context.newPage();
	for (const path of [
		"/dashboard/settings/organization/preferences",
		`/c/${ids.publicSpace}`,
		`/s/${ids.publicVideo}`,
		`/s/${ids.privateVideo}`,
		`/embed/${ids.publicVideo}`,
	]) {
		await page.goto(`${origin}${path}`, {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
	}
	for (const path of [
		"/api/desktop/video/new-id",
		`/api/playlist?videoId=${ids.publicVideo}&videoType=mp4`,
		`/api/thumbnail?videoId=${ids.publicVideo}`,
		`/api/video/preview?videoId=${ids.publicVideo}`,
		`/api/oembed?url=${encodeURIComponent(`https://cap.so/s/${ids.publicVideo}`)}`,
	]) {
		await context.request.get(`${origin}${path}`, { maxRedirects: 0 });
	}
} finally {
	await browser.close();
}
console.log("Demo routes warmed");
