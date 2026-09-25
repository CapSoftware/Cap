import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { demoVideoId } from "./fixture.mjs";

const require = createRequire(import.meta.url);

function loadPlaywright() {
	for (const candidate of [
		"playwright",
		"/opt/cap-tools/playwright/node_modules/playwright-core",
	]) {
		try {
			return require(candidate);
		} catch {}
	}
	throw new Error("Playwright is not available");
}

const { chromium } = loadPlaywright();
const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const headless = process.env.CTA_DEMO_HEADLESS === "1";
const screenshots = process.env.CTA_DEMO_SCREENSHOTS;
const storageState = process.env.CAP_BUILDING_BROWSER_STATE;
if (!storageState || !existsSync(storageState)) {
	throw new Error("Missing signed-in browser state");
}
if (screenshots) mkdirSync(screenshots, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let shot = 0;
async function capture(page, name) {
	if (!screenshots) return;
	shot += 1;
	await page.screenshot({
		path: join(screenshots, `${String(shot).padStart(2, "0")}-${name}.png`),
	});
}

function assert(condition, message) {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const executablePath = existsSync("/usr/bin/chromium")
	? "/usr/bin/chromium"
	: undefined;
const browser = await chromium.launch({
	headless,
	executablePath,
	args: headless
		? ["--autoplay-policy=no-user-gesture-required"]
		: [
				"--kiosk",
				"--window-position=0,0",
				"--window-size=1920,1080",
				"--autoplay-policy=no-user-gesture-required",
				"--disable-infobars",
			],
});

try {
	const context = await browser.newContext({
		storageState,
		viewport: headless ? { width: 1920, height: 1080 } : null,
	});
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);

	const shareUrl = `${base}/s/${demoVideoId}`;
	await page.goto(shareUrl, { waitUntil: "domcontentloaded" });
	const video = page.locator("video").first();
	await video.waitFor({ state: "attached", timeout: 90_000 });
	await page.waitForFunction(
		() => (document.querySelector("video")?.readyState ?? 0) >= 2,
		undefined,
		{ timeout: 90_000 },
	);
	assert(
		(await page.locator("[data-slot=cta-corner-card]").count()) === 0 &&
			(await page.locator("[data-slot=cta-end-screen]").count()) === 0,
		"no call to action before one is added",
	);
	await pause(2000);

	await page.getByRole("button", { name: "Manage Cap" }).click();
	await pause(700);
	await page.getByRole("menuitem", { name: "Add call to action" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.waitFor();
	await pause(1500);
	await capture(page, "dialog-empty");

	await dialog.getByRole("button", { name: "Book a call" }).click();
	await pause(600);
	const link = dialog.getByLabel("Link");
	await link.click();
	await page.keyboard.type("example.com/book", { delay: 70 });
	await pause(400);
	const headline = dialog.getByLabel(/Headline/);
	await headline.click();
	await page.keyboard.type("Want a guided tour?", { delay: 55 });
	assert(
		(await link.inputValue()) === "https://example.com/book",
		"link is normalized to https on blur",
	);
	await pause(600);
	await dialog.getByRole("button", { name: "Violet" }).click();
	await pause(1200);

	const preview = dialog.locator("[data-slot=cta-end-screen]");
	assert(
		(await preview.innerText()).includes("Want a guided tour?"),
		"end screen preview shows the headline",
	);
	await capture(page, "dialog-end-preview");
	await dialog.getByRole("tab", { name: "While playing" }).click();
	await dialog.locator("[data-slot=cta-corner-card]").waitFor();
	await pause(2200);
	await capture(page, "dialog-playing-preview");
	await dialog.getByRole("tab", { name: "End of video" }).click();
	await pause(1200);

	await dialog.getByRole("button", { name: "Add to video" }).click();
	await dialog.waitFor({ state: "hidden" });
	await page.getByText("Call to action added").waitFor();
	await pause(1500);

	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		() => (document.querySelector("video")?.readyState ?? 0) >= 2,
		undefined,
		{ timeout: 90_000 },
	);
	await page.getByRole("button", { name: "Manage Cap" }).click();
	await page.getByRole("menuitem", { name: /Edit call to action/ }).waitFor();
	await pause(900);
	await page.keyboard.press("Escape");
	await pause(500);

	await video.evaluate((element) => {
		element.muted = true;
		return element.play();
	});
	const cornerCard = page.locator(
		"[data-slot=cta-overlay] [data-slot=cta-corner-card]",
	);
	await cornerCard.waitFor({ timeout: 20_000 });
	const cornerLink = cornerCard.getByRole("link", { name: /Book a call/ });
	assert(
		(await cornerLink.getAttribute("href")) === "https://example.com/book",
		"corner card links to the saved destination",
	);
	assert(
		(await cornerLink.getAttribute("target")) === "_blank",
		"corner card opens in a new tab",
	);
	await page.mouse.move(960, 300);
	await pause(3500);
	await capture(page, "viewer-corner-card");

	await video.evaluate((element) => {
		element.currentTime = Math.max(0, element.duration - 2.5);
	});
	const endScreen = page.locator(
		"[data-slot=cta-overlay] [data-slot=cta-end-screen]",
	);
	await endScreen.waitFor({ timeout: 20_000 });
	assert(
		(await endScreen.innerText()).includes("Want a guided tour?"),
		"end screen shows the headline",
	);
	await cornerCard.waitFor({ state: "hidden", timeout: 3000 });
	await pause(1200);
	await endScreen.getByRole("link", { name: /Book a call/ }).hover();
	await pause(3000);
	await capture(page, "viewer-end-screen");

	await endScreen.getByRole("button", { name: "Replay" }).click();
	await endScreen.waitFor({ state: "hidden" });
	await cornerCard.waitFor({ timeout: 20_000 });
	await pause(1500);
	await cornerCard.getByRole("button", { name: "Dismiss" }).click();
	await cornerCard.waitFor({ state: "hidden" });
	await pause(2500);
	assert((await cornerCard.count()) === 0, "dismissed card stays closed");

	const phone = await browser.newContext({
		storageState,
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: headless ? 2 : 1,
		isMobile: false,
	});
	const phonePage = await phone.newPage();
	await phonePage.goto(shareUrl, { waitUntil: "domcontentloaded" });
	await phonePage.waitForFunction(
		() => (document.querySelector("video")?.readyState ?? 0) >= 2,
		undefined,
		{ timeout: 90_000 },
	);
	const phoneVideo = phonePage.locator("video").first();
	await phoneVideo.evaluate((element) => {
		element.muted = true;
		return element.play();
	});
	await phonePage.waitForFunction(
		() => (document.querySelector("video")?.currentTime ?? 0) > 4,
		undefined,
		{ timeout: 20_000 },
	);
	assert(
		(await phonePage.locator("[data-slot=cta-corner-card]").count()) === 0,
		"no corner card on a phone-sized player",
	);
	await capture(phonePage, "phone-playing");
	await phoneVideo.evaluate((element) => {
		element.currentTime = Math.max(0, element.duration - 1.5);
	});
	await phonePage
		.locator("[data-slot=cta-overlay] [data-slot=cta-end-screen]")
		.waitFor({ timeout: 20_000 });
	await pause(3000);
	await capture(phonePage, "phone-end-screen");
	await phone.close();
	console.log("walkthrough passed");
} finally {
	await browser.close();
}
