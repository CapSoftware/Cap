import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const APP = "http://localhost:4173";
const SERVER = "http://localhost:8787";
const root = new URL("..", import.meta.url);

interface Captured {
	origin: string | null;
	fields: Record<string, string>;
	files: Record<string, { type: string; size: number }>;
}

async function serve(page: Page): Promise<Captured[]> {
	const reports: Captured[] = [];
	await page.route(`${APP}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.startsWith("/api/intake/"))
			return route.fulfill({
				status: 409,
				headers: { "X-Request-Id": "req-e2e-1" },
				body: '{"error":"conflict"}',
			});
		const file = new URL(`.${path}`, root);
		const type = path.endsWith(".js") ? "text/javascript" : "text/html";
		return route.fulfill({ body: await readFile(file), contentType: type });
	});
	await page.route(`${SERVER}/api/v1/feedback`, async (route) => {
		const request = route.request();
		const form = await new Response(
			new Uint8Array(request.postDataBuffer() ?? new Uint8Array()),
			{
				headers: { "Content-Type": request.headers()["content-type"] ?? "" },
			},
		).formData();
		const fields: Captured["fields"] = {};
		const files: Captured["files"] = {};
		for (const [name, value] of form.entries()) {
			if (typeof value === "string") fields[name] = value;
			else files[name] = { type: value.type, size: value.size };
		}
		reports.push({ origin: request.headers().origin ?? null, fields, files });
		return route.fulfill({
			status: 201,
			headers: { "Access-Control-Allow-Origin": APP, Vary: "Origin" },
			contentType: "application/json",
			body: '{"id":"e2e"}',
		});
	});
	return reports;
}

async function maskedPixels(page: Page) {
	return page.evaluate(async () => {
		const shadow = document.querySelector("feedback-widget")?.shadowRoot;
		const image = shadow?.querySelector<HTMLImageElement>(".attachment img");
		if (!image) throw new Error("no preview");
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no canvas");
		context.drawImage(image, 0, 0);
		const scale = image.naturalWidth / window.innerWidth;
		const sample = (selector: string) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect) throw new Error(selector);
			const x = Math.round((rect.left + 8) * scale);
			const y = Math.round((rect.top + rect.height / 2) * scale);
			return Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
		};
		return {
			name: sample("#patient-name"),
			note: sample("#visit-note"),
			chart: sample("[data-testid=chart-summary]"),
			signature: sample("#signature"),
			header: sample("header"),
			underNote: (() => {
				const point = (window as unknown as { __notePoint?: number[] })
					.__notePoint;
				if (!point) throw new Error("no unmasked page point under the note");
				return Array.from(
					context
						.getImageData(
							Math.round((point[0] ?? 0) * scale),
							Math.round((point[1] ?? 0) * scale),
							1,
							1,
						)
						.data.slice(0, 3),
				);
			})(),
		};
	});
}

const near = (actual: number[], expected: number[], tolerance = 24) =>
	actual.every(
		(value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance,
	);

test("a person sends feedback with a masked screenshot, voice memo and evidence", async ({
	page,
}) => {
	const reports = await serve(page);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		(window as unknown as { posthog: object }).posthog = {
			get_session_id: () => "ph-session-e2e",
			get_session_replay_url: () =>
				"https://us.posthog.com/project/1/replay/ph-session-e2e?t=5",
		};
	});
	await page.goto(`${APP}/demo/index.html?patient=jane#top`);

	await page.getByTestId("chart-summary").click();
	await page.getByTestId("save-intake").click();
	await expect
		.poll(() =>
			page.evaluate(() => performance.getEntriesByType("resource").length),
		)
		.toBeGreaterThan(0);

	const launcher = page
		.locator("feedback-widget")
		.getByRole("button", { name: "Send feedback" });
	const box = await launcher.boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(44);
	expect(box?.height).toBeGreaterThanOrEqual(44);
	await launcher.click();

	const panel = page
		.locator("feedback-widget")
		.getByRole("dialog", { name: "Send feedback" });
	await expect(panel).toBeVisible();
	const viewport = page.viewportSize();
	const panelBox = await panel.boundingBox();
	expect(
		panelBox &&
			viewport &&
			panelBox.x >= 0 &&
			panelBox.x + panelBox.width <= viewport.width,
	).toBe(true);
	expect(
		panelBox && viewport && panelBox.y + panelBox.height <= viewport.height,
	).toBe(true);
	for (const button of await panel.getByRole("button").all()) {
		const size = await button.boundingBox();
		if (size)
			expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(44);
	}

	await panel
		.getByLabel("Your note")
		.fill("Saving the intake form fails with a conflict.");
	await page.evaluate(() => {
		const note = document
			.querySelector("feedback-widget")
			?.shadowRoot?.querySelector("textarea");
		const rect = note?.getBoundingClientRect();
		if (!rect) return;
		const hidden =
			"input,textarea,select,[contenteditable]:not([contenteditable=false]),[data-worm-mask]";
		for (let y = rect.top + 8; y < rect.bottom - 8; y += 8)
			for (let x = rect.left + 8; x < rect.right - 8; x += 8) {
				const under = document
					.elementsFromPoint(x, y)
					.find((element) => element.tagName !== "FEEDBACK-WIDGET");
				if (under && !under.closest(hidden)) {
					(window as unknown as { __notePoint?: number[] }).__notePoint = [
						x,
						y,
					];
					return;
				}
			}
	});
	await panel.getByRole("button", { name: "Add screenshot" }).click();
	await expect(panel.getByText("Screenshot added")).toBeVisible({
		timeout: 20_000,
	});

	const pixels = await maskedPixels(page);
	expect(near(pixels.name, [63, 63, 70]), `name field ${pixels.name}`).toBe(
		true,
	);
	expect(near(pixels.note, [63, 63, 70]), `note field ${pixels.note}`).toBe(
		true,
	);
	expect(
		near(pixels.chart, [63, 63, 70]),
		`masked region ${pixels.chart}`,
	).toBe(true);
	expect(near(pixels.header, [15, 118, 110]), `header ${pixels.header}`).toBe(
		true,
	);
	expect(
		near(pixels.underNote, [63, 63, 70]),
		`page under the widget is not masked ${pixels.underNote}`,
	).toBe(false);
	expect(
		near(pixels.signature, [63, 63, 70]),
		`masked canvas ${pixels.signature}`,
	).toBe(true);

	await panel.getByRole("button", { name: "Record voice memo" }).click();
	const stop = panel.getByRole("button", { name: /Stop recording/ });
	await expect(stop).toBeVisible();
	await page.waitForTimeout(1500);
	await stop.click();
	await expect(panel.locator("audio")).toBeVisible();

	await panel.getByRole("button", { name: "Send feedback" }).click();
	await expect(
		panel.getByText("Thanks. Your feedback was sent."),
	).toBeVisible();

	expect(reports).toHaveLength(1);
	const [report] = reports;
	expect(report?.origin).toBe(APP);
	expect(report?.fields.key).toBe("wf_pub_demo_local_site");
	expect(report?.fields.note).toBe(
		"Saving the intake form fails with a conflict.",
	);
	expect(report?.files.screenshot?.type).toBe("image/jpeg");
	expect(report?.files.screenshot?.size).toBeGreaterThan(1000);
	expect(report?.files.voice?.type).toMatch(/^audio\/(webm|mp4)$/);
	expect(report?.files.voice?.size).toBeGreaterThan(100);

	const evidence = JSON.parse(report?.fields.evidence ?? "{}");
	expect(evidence.route).toBe("/demo/index.html");
	expect(evidence.posthog).toEqual({
		sessionId: "ph-session-e2e",
		replayUrl: "https://us.posthog.com/project/1/replay/ph-session-e2e?t=5",
	});
	expect(evidence.viewport.width).toBe(viewport?.width);
	const kinds = evidence.events.map((event: { ev: string }) => event.ev);
	expect(kinds).toEqual(expect.arrayContaining(["click", "console", "write"]));
	const write = evidence.events.find(
		(event: { ev: string }) => event.ev === "write",
	);
	expect(write).toMatchObject({
		method: "POST",
		request: "/api/intake/:id",
		status: 409,
		requestId: "req-e2e-1",
	});
	const masked = evidence.events.find(
		(event: { el?: { testid?: string } }) =>
			event.el?.testid === "chart-summary",
	);
	expect(masked.el).toMatchObject({ masked: true });
	const serialized = JSON.stringify(evidence);
	for (const secret of [
		"Jane Q. Example",
		"jane@example.com",
		"demo-secret",
		"5550123",
		"patient=jane",
		"draft=1",
	])
		expect(serialized).not.toContain(secret);
	expect(errors).toEqual([]);
});

test("the host page can hide the launcher and keep the widget under its own menus", async ({
	page,
}) => {
	await serve(page);
	await page.goto(`${APP}/demo/index.html`);
	const host = page.locator("feedback-widget");
	const launcher = host.getByRole("button", { name: "Send feedback" });
	await expect(launcher).toBeVisible();
	await page.addStyleTag({
		content: "feedback-widget{--wf-z:45;--wf-launcher-display:none}",
	});
	await expect(launcher).toBeHidden();
	await page.addStyleTag({ content: "feedback-widget{--wf-launcher-display:flex}" });
	await expect(launcher).toBeVisible();
	const z = await launcher.evaluate((el) => getComputedStyle(el).zIndex);
	expect(z).toBe("45");
	// A menu the page draws at z-index 50 over the launcher's corner gets the tap, not the launcher.
	const box = await launcher.boundingBox();
	await page.evaluate(() => {
		const menu = document.createElement("div");
		menu.id = "menu";
		menu.style.cssText = "position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.1)";
		document.body.append(menu);
	});
	const hit = await page.evaluate(
		([x, y]) => document.elementFromPoint(x, y)?.id ?? "",
		[(box?.x ?? 0) + 10, (box?.y ?? 0) + 10],
	);
	expect(hit).toBe("menu");
});
