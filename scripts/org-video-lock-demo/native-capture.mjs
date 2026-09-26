import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { directory, ids, origin } from "./paths.mjs";

const execFile = promisify(execFileCallback);
const outputDirectory = process.argv[2];
if (
	process.platform !== "darwin" ||
	!outputDirectory ||
	!isAbsolute(outputDirectory)
) {
	throw new Error("Supply an absolute artifact directory on macOS");
}
await mkdir(outputDirectory, { recursive: true });
const captureDirectory = join(outputDirectory, `native-${Date.now()}`);
await mkdir(captureDirectory);
const project = join(captureDirectory, "organization-access.cap");
const file = join(captureDirectory, "organization-access.mp4");
const cap = async (args, timeout = 60_000) =>
	execFile("cap", [...args, "--json"], {
		timeout,
		maxBuffer: 16 * 1024 * 1024,
	});
const capJson = async (args) => JSON.parse((await cap(args)).stdout);
const states = JSON.parse(
	await readFile(join(directory, "browser-states.json"), "utf8"),
);
const sha = (await execFile("git", ["rev-parse", "HEAD"])).stdout.trim();
const recorder = await capJson(["version"]);
const browser = await chromium.launch({
	headless: false,
	channel: "chrome",
	args: ["--window-size=1440,810", "--window-position=36,70"],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const visit = async (role, path) => {
	await context.clearCookies();
	if (role !== "anonymous") await context.addCookies(states[role].cookies);
	await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
	await page.bringToFront();
};
const pause = () => page.waitForTimeout(3_000);
const lock = page.getByRole("switch", {
	name: "Only members of this organization",
});
const receipt = { sha, recorder, project, file, passed: false, steps: [] };
const saveReceipt = () =>
	writeFile(
		join(captureDirectory, "capture.json"),
		JSON.stringify(receipt, null, "\t"),
	);
let recordingId;
let stopped = false;

try {
	await visit("anonymous", `/s/${ids.publicVideo}`);
	await expect(
		page.getByRole("heading", {
			name: "Existing project walkthrough",
			exact: true,
		}),
	).toBeVisible();
	const marker = `Organization access demo ${Date.now()}`;
	await page.evaluate((title) => {
		document.title = title;
	}, marker);
	let target;
	await expect
		.poll(async () => {
			const windows = await capJson(["targets", "windows"]);
			const matches = windows.filter(
				(window) =>
					window.ownerName === "Google Chrome" && window.name.includes(marker),
			);
			target = matches.length === 1 ? matches[0] : undefined;
			return Boolean(target);
		})
		.toBe(true);
	if (!target) throw new Error("Dedicated browser window was not found");
	receipt.windowId = target.id;
	receipt.windowBounds = target.bounds;
	const started = await capJson([
		"record",
		"start",
		"--window",
		target.id,
		"--detach",
		"--fps",
		"30",
		"--path",
		project,
	]);
	if (!started.recordingId)
		throw new Error("Cap did not return a recording ID");
	recordingId = started.recordingId;
	receipt.recordingId = recordingId;
	await saveReceipt();
	console.log("Recording the dedicated synthetic browser window");
	await pause();
	receipt.steps.push("existing public recording visible");
	await visit("owner", "/dashboard/settings/organization/preferences");
	await expect(lock).not.toBeChecked();
	await lock.scrollIntoViewIfNeeded();
	await pause();
	await lock.click();
	await expect(
		page.getByText("All recordings are now organization-only", { exact: true }),
	).toBeVisible();
	await expect(lock).toBeChecked();
	await pause();
	receipt.steps.push("owner enables organization-only access");
	await visit("anonymous", `/s/${ids.publicVideo}`);
	await expect(
		page.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await expect(page.locator("video")).toHaveCount(0);
	await pause();
	receipt.steps.push("existing public link denied to signed-out viewer");
	await visit("outsider", `/s/${ids.privateVideo}`);
	await expect(
		page.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await pause();
	receipt.steps.push("previously invited guest denied");
	await visit("member", `/s/${ids.privateVideo}`);
	await expect(
		page.getByRole("heading", { name: "Private team update", exact: true }),
	).toBeVisible();
	const video = page.locator("video").first();
	await expect(video).toBeVisible();
	await video.evaluate(async (element) => {
		element.muted = true;
		await element.play();
	});
	await expect
		.poll(() => video.evaluate((element) => element.currentTime))
		.toBeGreaterThan(1);
	await pause();
	receipt.steps.push("organization member plays an existing private recording");
	await visit("owner", `/s/${ids.publicVideo}`);
	await expect(async () => {
		await page
			.getByRole("button", {
				name: "Sharing: Organization only. Click to manage access.",
			})
			.click();
		await expect(
			page.getByRole("button", { name: "Copy link for organization members" }),
		).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	await expect(page.getByRole("switch")).toHaveCount(0);
	await pause();
	receipt.steps.push(
		"per-recording sharing controls explain the enforced policy",
	);
	const response = await context.request.get(
		`${origin}/api/desktop/video/create?recordingMode=desktopMP4&name=New%20organization%20recording&durationInSecs=12&width=1280&height=720`,
		{
			headers: { Authorization: `Bearer ${states.desktopToken}` },
		},
	);
	expect(response.status()).toBe(200);
	const created = await response.json();
	await visit("anonymous", `/s/${created.id}`);
	await expect(
		page.getByRole("heading", { name: "This video is organization-only" }),
	).toBeVisible();
	await pause();
	await visit("member", `/s/${created.id}`);
	await expect(
		page.getByRole("heading", {
			name: "New organization recording",
			exact: true,
		}),
	).toBeVisible();
	await pause();
	receipt.steps.push(
		"new recording denies outsiders and allows organization members",
	);
	await visit("owner", "/dashboard/settings/organization/preferences");
	await lock.scrollIntoViewIfNeeded();
	await lock.click();
	await expect(
		page.getByText("Individual sharing settings restored", { exact: true }),
	).toBeVisible();
	await pause();
	await visit("anonymous", `/s/${ids.publicVideo}`);
	await expect(
		page.getByRole("heading", {
			name: "Existing project walkthrough",
			exact: true,
		}),
	).toBeVisible();
	await pause();
	receipt.steps.push("disabling the rule restores the saved public setting");
	await visit("owner", "/dashboard/settings/organization/preferences");
	await lock.scrollIntoViewIfNeeded();
	await lock.click();
	await expect(
		page.getByText("All recordings are now organization-only", { exact: true }),
	).toBeVisible();
	await pause();
	await page.screenshot({ path: join(captureDirectory, "settings.png") });
	const result = await capJson(["record", "stop", "--id", recordingId]);
	stopped = true;
	if (result.recordingMetaExists !== true)
		throw new Error("Cap recording did not finalize");
	receipt.recordingMetaExists = true;
	const validation = await capJson(["project", "validate", project]);
	if (validation.valid === false)
		throw new Error("Cap project validation failed");
	receipt.validation = validation;
	console.log("Walkthrough assertions passed; exporting with Cap");
	const exported = await cap(
		[
			"export",
			project,
			"--output",
			file,
			"--resolution",
			"1920x1080",
			"--fps",
			"30",
			"--quality",
			"web",
		],
		600_000,
	);
	await writeFile(join(captureDirectory, "export.log"), exported.stdout);
	const probe = JSON.parse(
		(
			await execFile("ffprobe", [
				"-v",
				"error",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				file,
			])
		).stdout,
	);
	const stream = probe.streams.find((item) => item.codec_type === "video");
	if (!stream || Number(probe.format.duration) <= 0)
		throw new Error("Export has no playable video");
	receipt.width = stream.width;
	receipt.height = stream.height;
	receipt.duration = Number(probe.format.duration);
	receipt.fileHash = createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
	receipt.passed = true;
	receipt.observedAt = new Date().toISOString();
	await saveReceipt();
	console.log(
		JSON.stringify({
			passed: true,
			sha,
			file,
			width: receipt.width,
			height: receipt.height,
			duration: receipt.duration,
		}),
	);
} catch (error) {
	receipt.error = String(error.message);
	await page
		.screenshot({ path: join(captureDirectory, "failed.png") })
		.catch(() => {});
	await saveReceipt();
	throw error;
} finally {
	if (recordingId && !stopped) {
		await capJson(["record", "stop", "--id", recordingId]).catch(() => {});
	}
	await browser.close();
}
