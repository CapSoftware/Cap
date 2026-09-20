import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { parseCapturedTabInputBatch } from "../shared/input-events";

const html = `<!doctype html>
<html>
	<head>
		<style>
			body { margin: 0; }
			.control { position: absolute; left: 40px; width: 220px; height: 30px; }
		</style>
	</head>
	<body>
		<input id="password" class="control" type="password" aria-label="Password" style="top: 40px">
		<div id="editable" class="control" contenteditable style="top: 80px">Private text</div>
		<div id="textbox" class="control" role="textbox" style="top: 120px">Custom text</div>
		<div id="pin" class="control" aria-label="PIN widget" style="top: 160px">PIN</div>
		<button id="secret" class="control" aria-label="Secret button" style="top: 200px">Secret</button>
		<label id="email-label" class="control" for="email" style="top: 240px">Email address</label>
		<input id="email" class="control" type="email" style="top: 280px">
		<input id="otp-code" class="control" inputmode="numeric" name="code" style="top: 520px">
		<div id="custom-code" class="control" inputmode="numeric" style="top: 600px">Custom code field</div>
		<svg id="svg-pin" class="control" aria-label="PIN keypad" style="top: 640px"><rect width="220" height="30" fill="gray"></rect></svg>
		<x-widget id="closed-widget" class="control" tabindex="0" style="top: 680px"></x-widget>
		<div id="focusable-secret" class="control" tabindex="0" style="top: 720px">Unlabelled private widget</div>
		<form id="payment" class="control" style="top: 320px; height: 80px">
			<input id="card" autocomplete="cc-number" style="width: 210px; height: 30px">
			<button id="pay" type="button" style="position: absolute; top: 40px; left: 0; width: 210px; height: 30px">Confirm payment</button>
		</form>
		<div id="shadow-host" class="control" style="top: 420px"></div>
		<div id="cap-extension-recorder-overlay" class="control" style="top: 460px">
			<button id="overlay-button" style="width: 210px; height: 30px">Recorder control</button>
		</div>
		<button id="public" class="control" style="left: 420px; top: 420px">Public action</button>
		<form class="control" style="left: 420px; top: 470px; height: 80px">
			<input name="shipping-address" style="width: 210px; height: 30px">
			<button id="shipping" type="button" style="position: absolute; top: 40px; left: 0; width: 210px; height: 30px">Update shipping</button>
		</form>
		<script>
			const shadowInput = document.createElement("input");
			shadowInput.setAttribute("aria-label", "Shadow private field");
			shadowInput.style.cssText = "width: 210px; height: 30px";
			document.getElementById("shadow-host").attachShadow({ mode: "open" }).append(shadowInput);
			const closedInput = document.createElement("input");
			closedInput.style.cssText = "width: 210px; height: 30px";
			document.getElementById("closed-widget").attachShadow({ mode: "closed" }).append(closedInput);
		</script>
	</body>
</html>`;

const tempDirectory = await mkdtemp(join(tmpdir(), "cap-input-privacy-"));
const entry = join(tempDirectory, "entry.ts");
await writeFile(
	entry,
	`import { initTabInputCapture } from ${JSON.stringify(resolve(import.meta.dir, "input-events.ts"))};\ninitTabInputCapture();\n`,
);

const bundled = await Bun.build({
	entrypoints: [entry],
	target: "browser",
	format: "iife",
	splitting: false,
});
assert.ok(bundled.success, bundled.logs.map((log) => log.message).join("\n"));
const contentScript = await bundled.outputs[0]?.text();
assert.ok(contentScript);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() {
		return new Response(html, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	},
});
const browser = await chromium.launch({ headless: true });

try {
	const page = await browser.newPage({
		viewport: { width: 900, height: 800 },
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.addInitScript(() => {
		type ContentListener = (
			message: { type: string; recordingId?: string },
			sender: unknown,
			respond: (value: unknown) => void,
		) => boolean;
		(window as Window & { capInputBatches?: unknown[] }).capInputBatches = [];
		Object.defineProperty(window, "chrome", {
			configurable: true,
			value: {
				runtime: {
					lastError: null,
					onMessage: {
						addListener: (listener: ContentListener) => {
							(
								window as Window & {
									capInputListener?: ContentListener;
								}
							).capInputListener = listener;
						},
					},
					sendMessage: (
						message: unknown,
						callback: (value: unknown) => void,
					) => {
						(
							window as Window & { capInputBatches?: unknown[] }
						).capInputBatches?.push(message);
						callback({ ok: true });
					},
				},
				storage: {
					onChanged: { addListener: () => undefined },
				},
			},
		});
	});
	await page.goto(`http://127.0.0.1:${server.port}/capture.html`);
	await page.addScriptTag({ content: contentScript });
	assert.deepEqual(pageErrors, []);
	assert.equal(
		await page.evaluate(
			() =>
				typeof (
					window as Window & {
						capInputListener?: (...args: unknown[]) => unknown;
					}
				).capInputListener,
		),
		"function",
	);
	const requestCapture = (type: string) =>
		page.evaluate((requestType) => {
			const listener = (
				window as Window & {
					capInputListener?: (
						message: { type: string; recordingId: string },
						sender: unknown,
						respond: (value: unknown) => void,
					) => boolean;
				}
			).capInputListener;
			if (!listener) throw new Error("Content listener did not load");
			return new Promise<unknown>((resolve) => {
				listener(
					{ type: requestType, recordingId: "privacy-replay" },
					{},
					resolve,
				);
			});
		}, type);
	assert.deepEqual(await requestCapture("input-capture-start"), { ok: true });

	const privateSelectors = [
		"#password",
		"#editable",
		"#textbox",
		"#pin",
		"#secret",
		"#email-label",
		"#email",
		"#otp-code",
		"#custom-code",
		"#svg-pin",
		"#closed-widget",
		"#focusable-secret",
		"#card",
		"#pay",
		"#shadow-host input",
		"#overlay-button",
	];
	const privateBounds = await Promise.all(
		privateSelectors.map(async (selector) => {
			const bounds = await page.locator(selector).boundingBox();
			assert.ok(bounds, selector);
			return bounds;
		}),
	);
	for (const selector of privateSelectors) await page.locator(selector).click();
	const publicBounds = await page.locator("#public").boundingBox();
	assert.ok(publicBounds);
	await page.locator("#public").click();
	const shippingBounds = await page.locator("#shipping").boundingBox();
	assert.ok(shippingBounds);
	await page.locator("#shipping").click();
	await page.keyboard.press("Escape");
	assert.deepEqual(await requestCapture("input-capture-stop"), { ok: true });

	const rawBatches = await page.evaluate(
		() =>
			(window as Window & { capInputBatches?: unknown[] }).capInputBatches ??
			[],
	);
	const batches = rawBatches.map(parseCapturedTabInputBatch);
	assert.ok(batches.length > 0);
	assert.ok(batches.every((batch) => batch !== null));
	const pointerSamples = batches.flatMap(
		(batch) =>
			batch?.events.flatMap((event) =>
				event.kind === "move" || event.kind === "down" || event.kind === "up"
					? [
							{
								kind: event.kind,
								x: event.x * batch.viewportWidth,
								y: event.y * batch.viewportHeight,
							},
						]
					: [],
			) ?? [],
	);
	const inside = (
		point: { x: number; y: number },
		bounds: { x: number; y: number; width: number; height: number },
	) =>
		point.x >= bounds.x &&
		point.x <= bounds.x + bounds.width &&
		point.y >= bounds.y &&
		point.y <= bounds.y + bounds.height;
	assert.ok(
		pointerSamples.some(
			(point) => point.kind === "down" && inside(point, publicBounds),
		),
	);
	assert.ok(
		pointerSamples.some(
			(point) => point.kind === "down" && inside(point, shippingBounds),
		),
	);
	for (const bounds of privateBounds) {
		assert.equal(
			pointerSamples.some((point) => inside(point, bounds)),
			false,
		);
	}
	assert.ok(
		batches.some((batch) =>
			batch?.events.some(
				(event) => event.kind === "keyDown" && event.key === "Escape",
			),
		),
	);
	assert.deepEqual(pageErrors, []);
	process.stdout.write(
		`${JSON.stringify({ privateTargets: privateSelectors.length, publicPointerEvents: pointerSamples.length, batches: batches.length, pageErrors })}\n`,
	);
} finally {
	await browser.close();
	server.stop(true);
	await rm(tempDirectory, { recursive: true, force: true });
}
