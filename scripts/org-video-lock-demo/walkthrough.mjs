import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { directory, ids, origin } from "./paths.mjs";

const states = JSON.parse(
	await readFile(join(directory, "browser-states.json"), "utf8"),
);
const browser = await chromium.launch({
	headless: false,
	args: ["--window-size=1920,1080"],
	...(process.platform === "darwin" ? { channel: "chrome" } : {}),
});
const contextOptions = { viewport: { width: 1880, height: 980 } };
const owner = await browser.newContext({
	...contextOptions,
	storageState: states.owner,
});
const member = await browser.newContext({
	...contextOptions,
	storageState: states.member,
});
const outsider = await browser.newContext({
	...contextOptions,
	storageState: states.outsider,
});
const anonymous = await browser.newContext(contextOptions);
const settings = await owner.newPage();
const viewer = await anonymous.newPage();
const memberPage = await member.newPage();
const guestPage = await outsider.newPage();
const visit = async (page, path) => {
	await page.bringToFront();
	await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
};
for (const context of [owner, member, outsider, anonymous])
	context.setDefaultTimeout(15_000);
const pause = (page) => page.waitForTimeout(2_500);

try {
	await visit(viewer, `/c/${ids.publicSpace}`);
	await expect(
		viewer.getByText("Existing project walkthrough", { exact: true }),
	).toBeVisible();
	await visit(viewer, `/s/${ids.publicVideo}`);
	await expect(
		viewer.getByRole("heading", {
			name: "Existing project walkthrough",
			exact: true,
		}),
	).toBeVisible();
	await expect(viewer.locator("video").first()).toBeVisible();
	await pause(viewer);
	await visit(settings, "/dashboard/settings/organization/preferences");
	const lock = settings.getByRole("switch", {
		name: "Only members of this organization",
	});
	await expect(lock).not.toBeChecked();
	await lock.scrollIntoViewIfNeeded();
	await pause(settings);
	await lock.click();
	await expect(lock).toBeChecked();
	await expect(
		settings.getByText("All recordings are now organization-only", {
			exact: true,
		}),
	).toBeVisible();
	await pause(settings);
	await visit(viewer, `/s/${ids.publicVideo}`);
	await expect(
		viewer.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await expect(viewer.locator("video")).toHaveCount(0);
	await pause(viewer);
	await visit(viewer, `/embed/${ids.publicVideo}`);
	await expect(
		viewer.getByRole("heading", { name: "This video is private" }),
	).toBeVisible();
	await expect(viewer.locator("video")).toHaveCount(0);
	await visit(guestPage, `/s/${ids.privateVideo}`);
	await expect(
		guestPage.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await pause(guestPage);
	await visit(viewer, `/c/${ids.publicSpace}`);
	await expect(
		viewer.getByText("Existing project walkthrough", { exact: true }),
	).toHaveCount(0);
	await expect(
		viewer.getByText("Public project library", { exact: true }).first(),
	).toBeVisible();
	for (const [path, status] of [
		[`/api/playlist?videoId=${ids.publicVideo}&videoType=mp4`, 401],
		[`/api/thumbnail?videoId=${ids.publicVideo}`, 404],
		[`/api/video/preview?videoId=${ids.publicVideo}`, 404],
		[
			`/api/oembed?url=${encodeURIComponent(`https://cap.so/s/${ids.publicVideo}`)}`,
			404,
		],
	]) {
		const response = await anonymous.request.get(`${origin}${path}`, {
			maxRedirects: 0,
		});
		expect(response.status()).toBe(status);
	}
	await visit(memberPage, `/c/${ids.publicSpace}`);
	await expect(
		memberPage.getByText("Existing project walkthrough", { exact: true }),
	).toBeVisible();
	await visit(memberPage, `/c/${ids.protectedSpace}`);
	await expect(
		memberPage.getByText("Private team update", { exact: true }),
	).toBeVisible();
	await pause(memberPage);
	await visit(memberPage, `/c/${ids.domainSpace}`);
	await expect(
		memberPage.getByText("Shared public project update", { exact: true }),
	).toBeVisible();
	for (const title of [
		"Private external project update",
		"Password-protected external update",
		"Email-restricted external update",
	]) {
		await expect(memberPage.getByText(title, { exact: true })).toHaveCount(0);
	}
	await expect(
		memberPage.getByText("Invited external update", { exact: true }),
	).toBeVisible();
	const mobileDetail = await member.request.get(
		`${origin}/api/mobile/caps/${ids.privateVideo}`,
		{ headers: { Authorization: `Bearer ${states.memberToken}` } },
	);
	expect(mobileDetail.status()).toBe(200);
	const { cap: mobileCap } = await mobileDetail.json();
	expect(mobileCap.public).toBe(false);
	expect(mobileCap.protected).toBe(false);
	expect(mobileCap.thumbnailUrl).toBeTruthy();
	const mobileList = await member.request.get(
		`${origin}/api/mobile/caps?spaceId=${ids.protectedSpace}`,
		{ headers: { Authorization: `Bearer ${states.memberToken}` } },
	);
	expect(mobileList.status()).toBe(200);
	const { caps: mobileCaps } = await mobileList.json();
	expect(mobileCaps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: ids.privateVideo,
				public: false,
				protected: false,
				thumbnailUrl: expect.any(String),
			}),
		]),
	);
	const mobileDenied = await outsider.request.get(
		`${origin}/api/mobile/caps/${ids.publicVideo}`,
		{ headers: { Authorization: `Bearer ${states.outsiderToken}` } },
	);
	expect(mobileDenied.status()).toBe(404);
	const created = await owner.request.get(
		`${origin}/api/desktop/video/create?recordingMode=desktopMP4&name=New%20organization%20recording&durationInSecs=12&width=1280&height=720`,
		{ headers: { Authorization: `Bearer ${states.desktopToken}` } },
	);
	expect(created.status()).toBe(200);
	const newVideo = await created.json();
	expect(typeof newVideo.id).toBe("string");
	await visit(viewer, `/s/${newVideo.id}`);
	await expect(
		viewer.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await pause(viewer);
	await visit(memberPage, `/s/${newVideo.id}`);
	await expect(
		memberPage.getByRole("heading", {
			name: "New organization recording",
			exact: true,
		}),
	).toBeVisible();
	await pause(memberPage);
	await visit(memberPage, `/s/${ids.privateVideo}`);
	await expect(
		memberPage.getByRole("heading", {
			name: "Private team update",
			exact: true,
		}),
	).toBeVisible();
	const video = memberPage.locator("video").first();
	await expect(video).toBeVisible();
	await video.evaluate(async (element) => {
		element.muted = true;
		await element.play();
	});
	await expect
		.poll(() => video.evaluate((element) => element.currentTime))
		.toBeGreaterThan(0.5);
	await pause(memberPage);
	await visit(settings, `/s/${ids.publicVideo}`);
	await expect(
		settings.getByText("Organization only", { exact: true }).first(),
	).toBeVisible();
	await expect(async () => {
		await settings
			.getByRole("button", {
				name: "Sharing: Organization only. Click to manage access.",
			})
			.click();
		await expect(
			settings.getByRole("button", {
				name: "Copy link for organization members",
			}),
		).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	await expect(settings.getByRole("switch")).toHaveCount(0);
	await pause(settings);
	await visit(settings, "/dashboard/settings/organization/preferences");
	await lock.scrollIntoViewIfNeeded();
	await lock.click();
	await expect(
		settings.getByText("Individual sharing settings restored", { exact: true }),
	).toBeVisible();
	await visit(viewer, `/s/${ids.publicVideo}`);
	await expect(
		viewer.getByRole("heading", {
			name: "Existing project walkthrough",
			exact: true,
		}),
	).toBeVisible();
	await pause(viewer);
	await visit(memberPage, `/s/${ids.privateVideo}`);
	await expect(
		memberPage.getByRole("heading", { name: "This video is private" }),
	).toBeVisible();
	await visit(viewer, `/c/${ids.publicSpace}`);
	await expect(
		viewer.getByText("Existing project walkthrough", { exact: true }),
	).toBeVisible();
	await visit(settings, "/dashboard/settings/organization/preferences");
	await lock.scrollIntoViewIfNeeded();
	await lock.click();
	await expect(
		settings.getByText("All recordings are now organization-only", {
			exact: true,
		}),
	).toBeVisible();
	await pause(settings);
	await settings.screenshot({ path: join(directory, "settings.png") });
	await writeFile(
		join(directory, "walkthrough-result.json"),
		JSON.stringify({
			passed: true,
			observedAt: new Date().toISOString(),
			verified: [
				"existing public link blocked",
				"invited guest blocked",
				"anonymous embed blocked",
				"public collection hides outsider metadata and allows owning members",
				"saved collection passwords do not block organization members",
				"eligible recordings from other organizations remain in collections",
				"external email restrictions and explicit viewer grants are respected",
				"sharing controls explain the organization policy",
				"media and metadata endpoints blocked",
				"organization member playback",
				"mobile details and listings reflect the organization policy",
				"new recording access enforced",
				"original settings restored",
			],
		}),
	);
	console.log("Organization sharing walkthrough passed");
} catch (error) {
	await settings
		.screenshot({ path: join(directory, "failed-settings.png") })
		.catch(() => {});
	throw error;
} finally {
	await browser.close();
}
