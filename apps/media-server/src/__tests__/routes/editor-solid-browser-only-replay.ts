import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import sharp from "sharp";
import {
	default_project_config_json,
	initSync,
	random_animated_gradient_json,
} from "../../../../../packages/editor-solid-web/renderer/pkg/cap_editor_browser_renderer.js";
import app from "../../editor-worker-app";
import { getEditorSession } from "../../lib/editor-sessions";
import {
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

const secret = "editor-browser-only-replay-secret";
const videoId = "editor-browser-only-replay";
const userId = "editor-browser-only-user";
const engine =
	process.env.CAP_EDITOR_UI_BROWSER === "webkit"
		? webkit
		: process.env.CAP_EDITOR_UI_BROWSER === "firefox"
			? firefox
			: chromium;
const editorPublic = resolve(
	process.env.CAP_EDITOR_SOLID_PUBLIC_DIR ??
		resolve(import.meta.dir, "../../../../../apps/web/public/editor-solid"),
);
const display = join(
	import.meta.dir,
	"../fixtures/editor-clips/display-red.webm",
);
const camera = join(
	import.meta.dir,
	"../fixtures/editor-clips/camera-green.webm",
);

assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
assert.ok(await Bun.file(join(editorPublic, "index.html")).exists());
initSync({
	module: readFileSync(
		resolve(
			import.meta.dir,
			"../../../../../packages/editor-solid-web/renderer/pkg/cap_editor_browser_renderer_bg.wasm",
		),
	),
});
let config = JSON.parse(default_project_config_json()) as {
	background: { source: unknown; blur: number };
};
config.background.source = {
	type: "animatedGradient",
	config: JSON.parse(random_animated_gradient_json(1234)),
};
config.background.blur = 60;

const hostModule = await Bun.build({
	entrypoints: [
		resolve(
			import.meta.dir,
			"../../../../../apps/web/app/s/[videoId]/edit/studio/editor-host.ts",
		),
	],
	target: "browser",
	format: "esm",
	splitting: false,
});
assert.ok(hostModule.success);
const hostCode = await hostModule.outputs[0]?.text();
assert.ok(hostCode);

const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
const previousPublicOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
const headers = {
	"x-media-server-secret": secret,
	"Content-Type": "application/json",
};
let server: ReturnType<typeof Bun.serve> | null = null;
let socketServer: ReturnType<typeof Bun.serve> | null = null;
let browser: Awaited<ReturnType<typeof engine.launch>> | null = null;
let sessionId: string | null = null;
let savedAt: string | null = null;
let base = "";
let bootstrapRequests = 0;
let rangeRequests = 0;
let workerRequests = 0;
let preparationRequests = 0;
let workerFixtureEnabled = false;

async function preparationInput() {
	return {
		videoId,
		title: "Paired browser-only editor fixture",
		captionsEnabled: false,
		display: {
			url: `${base}/display.webm`,
			contentType: "video/webm",
			size: (await stat(display)).size,
			fps: 30,
		},
		camera: {
			url: `${base}/camera.webm`,
			contentType: "video/webm",
			size: (await stat(camera)).size,
			fps: 25,
			offsetMs: 125,
		},
		projectConfig: config,
	};
}

function mediaResponse(request: Request, path: string) {
	const blob = Bun.file(path);
	const mediaHeaders: Record<string, string> = {
		"Content-Type": "video/webm",
		"Accept-Ranges": "bytes",
	};
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (!range) return new Response(blob, { headers: mediaHeaders });
	const start = Number(range[1]);
	const end = range[2]
		? Math.min(Number(range[2]), blob.size - 1)
		: blob.size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start >= blob.size ||
		end < start
	) {
		return new Response(null, {
			status: 416,
			headers: { ...mediaHeaders, "Content-Range": `bytes */${blob.size}` },
		});
	}
	rangeRequests++;
	return new Response(blob.slice(start, end + 1), {
		status: 206,
		headers: {
			...mediaHeaders,
			"Content-Range": `bytes ${start}-${end}/${blob.size}`,
		},
	});
}

async function readySession(id: string) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const response = await app.request(`/editor/preparations/${id}`, {
			headers,
		});
		assert.equal(response.status, 200);
		const status = (await response.json()) as {
			status: string;
			sessionId?: string;
			error?: string;
		};
		if (status.status === "ready") {
			assert.ok(status.sessionId);
			return status.sessionId;
		}
		if (status.status === "error")
			throw new Error(status.error ?? "Editor reference failed to prepare");
		await Bun.sleep(100);
	}
	throw new Error("Editor reference preparation timed out");
}

try {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/display.webm")
				return mediaResponse(request, display);
			if (url.pathname === "/camera.webm")
				return mediaResponse(request, camera);
			if (url.pathname === "/favicon.ico")
				return new Response(null, { status: 204 });
			if (url.pathname === "/api/desktop/organizations")
				return Response.json([]);
			if (url.pathname === "/test-host.js")
				return new Response(hostCode, {
					headers: { "Content-Type": "text/javascript; charset=utf-8" },
				});
			if (url.pathname === "/test-editor")
				return new Response(
					'<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100vw;height:100vh;border:0}</style></head><body><iframe id="editor" src="/editor-solid/index.html"></iframe></body></html>',
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
			if (
				url.pathname === `/api/editor/videos/${videoId}/bootstrap` &&
				request.method === "GET"
			) {
				bootstrapRequests++;
				return Response.json({
					videoId,
					sources: {
						videoId,
						title: "Paired browser-only editor fixture",
						captionsEnabled: false,
						signedUrlExpiresAt: Date.now() + 20 * 60_000,
						displayHasAudio: false,
						projectConfig: config,
						display: {
							url: `${base}/display.webm`,
							contentType: "video/webm",
							fps: 30,
						},
						camera: {
							url: `${base}/camera.webm`,
							contentType: "video/webm",
							fps: 25,
							offsetMs: 125,
						},
					},
				});
			}
			if (url.pathname.startsWith("/editor-solid/")) {
				const staticPath = resolve(
					editorPublic,
					url.pathname.slice("/editor-solid/".length),
				);
				if (
					staticPath.startsWith(`${editorPublic}${sep}`) &&
					(await Bun.file(staticPath).exists())
				) {
					const file = Bun.file(staticPath);
					return new Response(file, {
						headers: { "Content-Type": file.type },
					});
				}
				return new Response("Missing editor asset", { status: 404 });
			}
			const apiRoot = `/api/editor/videos/${videoId}`;
			if (url.pathname === `${apiRoot}/plan` && request.method === "GET")
				return Response.json({ pro: false });
			if (url.pathname === `${apiRoot}/assets` && request.method === "GET")
				return Response.json({ path: null });
			if (url.pathname === `${apiRoot}/config` && request.method === "GET")
				return Response.json({ savedAt });
			if (url.pathname === `${apiRoot}/config` && request.method === "PUT") {
				const payload = (await request.json()) as {
					config?: unknown;
					expectedSavedAt?: string | null;
				};
				if (
					payload.expectedSavedAt !== savedAt ||
					!payload.config ||
					Array.isArray(payload.config) ||
					typeof payload.config !== "object"
				)
					return new Response("Editor revision changed", { status: 409 });
				config = payload.config as typeof config;
				savedAt = new Date().toISOString();
				return Response.json({ saved: true, savedAt });
			}
			if (
				url.pathname.startsWith("/api/editor/preparations") ||
				url.pathname.startsWith("/api/editor/sessions")
			) {
				workerRequests++;
				if (workerFixtureEnabled) {
					if (
						url.pathname === "/api/editor/preparations" &&
						request.method === "POST"
					) {
						const payload = (await request.json()) as { videoId?: string };
						if (payload.videoId !== videoId)
							return new Response("Invalid recording", { status: 403 });
						preparationRequests++;
						return app.request("/editor/preparations", {
							method: "POST",
							headers,
							body: JSON.stringify(await preparationInput()),
						});
					}
					const preparationMatch =
						/^\/api\/editor\/preparations\/([0-9a-f-]{36})$/.exec(url.pathname);
					if (
						preparationMatch &&
						url.searchParams.get("videoId") === videoId &&
						(request.method === "GET" || request.method === "DELETE")
					) {
						const response = await app.request(
							`/editor/preparations/${preparationMatch[1]}`,
							{ method: request.method, headers },
						);
						if (request.method === "GET" && response.ok) {
							const status = (await response.clone().json()) as {
								status?: string;
								sessionId?: string;
							};
							if (status.status === "ready" && status.sessionId)
								sessionId = status.sessionId;
						}
						return response;
					}
					const sessionMatch =
						/^\/api\/editor\/sessions\/([0-9a-f-]{36})(?:\/(tickets))?$/.exec(
							url.pathname,
						);
					if (sessionMatch && sessionMatch[1] === sessionId) {
						if (sessionMatch[2] === "tickets" && request.method === "POST") {
							const payload = (await request.json()) as { videoId?: string };
							if (payload.videoId !== videoId)
								return new Response("Invalid recording", { status: 403 });
							const ticketed = await app.request(
								`/editor/sessions/${sessionId}/sockets`,
								{
									method: "POST",
									headers,
									body: JSON.stringify({ origin: base }),
								},
							);
							if (!ticketed.ok) return ticketed;
							const result = (await ticketed.json()) as {
								sockets: Record<string, unknown>;
							};
							return Response.json(result.sockets);
						}
						if (
							!sessionMatch[2] &&
							request.method === "DELETE" &&
							url.searchParams.get("videoId") === videoId
						) {
							const response = await app.request(
								`/editor/sessions/${sessionId}`,
								{ method: "DELETE", headers },
							);
							if (response.ok) sessionId = null;
							return response;
						}
					}
				}
				return new Response("Browser preview requested a native worker", {
					status: 503,
				});
			}
			return new Response("Missing browser-only editor fixture route", {
				status: 404,
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	browser = await engine.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	const pageErrors: string[] = [];
	const failedResponses: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	page.on("response", (response) => {
		if (response.status() >= 400)
			failedResponses.push(`${response.status()} ${response.url()}`);
	});
	await page.goto(`${base}/test-editor`);
	await page.locator("#editor").evaluate(async (element) => {
		const iframe = element as HTMLIFrameElement;
		if (iframe.contentDocument?.readyState === "complete") return;
		await new Promise<void>((resolve) =>
			iframe.addEventListener("load", () => resolve(), { once: true }),
		);
	});
	await page.evaluate(
		async ({ recordingId, ownerId }) => {
			const { EditorHostBridge } = await import(
				new URL("/test-host.js", location.origin).href
			);
			const iframe = document.getElementById("editor") as HTMLIFrameElement;
			const bridge = new EditorHostBridge(
				recordingId,
				`browser-${recordingId}`,
				ownerId,
				() => undefined,
				(error: Error) => {
					(window as typeof window & { capTestError?: string }).capTestError =
						error.message;
				},
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				(value: string) => {
					(
						window as typeof window & { capTestSavedAt?: string | null }
					).capTestSavedAt = value;
				},
				() =>
					(window as typeof window & { capTestSavedAt?: string | null })
						.capTestSavedAt ?? null,
				true,
			);
			(
				window as typeof window & { capTestBridge?: { dispose: () => void } }
			).capTestBridge = bridge;
			await bridge.connect(iframe);
		},
		{ recordingId: videoId, ownerId: userId },
	);
	const editor = page.frameLocator("#editor");
	await editor.getByRole("button", { name: "Export", exact: true }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await editor.getByRole("tab", { name: "Camera" }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await editor.locator('[aria-busy="false"]').waitFor({
		state: "attached",
		timeout: 20_000,
	});
	await editor.locator("#canvas").evaluate(async (canvas) => {
		const surface = canvas.parentElement?.parentElement;
		if (!surface) throw new Error("Preview surface is unavailable");
		const deadline = performance.now() + 3_000;
		while (Number(getComputedStyle(surface).opacity) < 0.999) {
			if (performance.now() > deadline)
				throw new Error("Preview fade did not complete");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});
	assert.ok(bootstrapRequests > 0);
	assert.ok(rangeRequests > 0);
	assert.equal(workerRequests, 0);
	assert.ok(
		(
			await editor.getByText("Blur", { exact: true }).locator("..").innerText()
		).includes("60.0%"),
	);
	const canvasSize = await editor.locator("#canvas").evaluate((canvas) => {
		const element = canvas as HTMLCanvasElement;
		return { width: element.width, height: element.height };
	});
	const browserScreenshot = await editor.locator("#canvas").screenshot();
	const { data: browserPixels, info: browserInfo } = await sharp(
		browserScreenshot,
	)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	await editor.getByRole("button", { name: "Play video" }).click();
	await editor.getByRole("button", { name: "Pause video" }).waitFor({
		state: "visible",
		timeout: 10_000,
	});
	await editor
		.getByText(/^0:(?:00\.(?:0[1-9]|[1-9]\d)|01\.\d\d)$/)
		.first()
		.waitFor({ state: "visible", timeout: 10_000 });
	await editor.getByRole("button", { name: "Pause video" }).click();
	assert.equal(workerRequests, 0);
	assert.deepEqual(failedResponses, []);
	assert.deepEqual(pageErrors, []);
	assert.equal(
		await page.evaluate(
			() =>
				(window as typeof window & { capTestError?: string }).capTestError ??
				null,
		),
		null,
	);
	const preparation = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify(await preparationInput()),
	});
	assert.equal(preparation.status, 202);
	const prepared = (await preparation.json()) as { id: string };
	sessionId = await readySession(prepared.id);
	const native = getEditorSession(sessionId);
	assert.ok(native);
	const preview = await native.request("/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			frameNumber: 0,
			fps: 60,
			resolutionBase: { x: canvasSize.width, y: canvasSize.height },
		}),
	});
	assert.equal(preview.status, 200);
	const exact = Buffer.from(await preview.arrayBuffer());
	const footer = exact.subarray(-24);
	const stride = footer.readUInt32LE(0);
	const nativeHeight = footer.readUInt32LE(4);
	const nativeWidth = footer.readUInt32LE(8);
	assert.equal(footer.readUInt32LE(12), 0);
	assert.equal(exact.length, stride * nativeHeight + 24);
	assert.ok(Math.abs(nativeWidth - browserInfo.width) <= 2);
	assert.ok(Math.abs(nativeHeight - browserInfo.height) <= 2);
	const packed = Buffer.alloc(nativeWidth * nativeHeight * 4);
	for (let row = 0; row < nativeHeight; row++) {
		exact.copy(
			packed,
			row * nativeWidth * 4,
			row * stride,
			row * stride + nativeWidth * 4,
		);
	}
	const nativePixels = await sharp(packed, {
		raw: { width: nativeWidth, height: nativeHeight, channels: 4 },
	})
		.resize(browserInfo.width, browserInfo.height, { kernel: "nearest" })
		.raw()
		.toBuffer();
	assert.equal(nativePixels.length, browserPixels.length);
	let absolute = 0;
	let squared = 0;
	let differentPixels = 0;
	for (let pixel = 0; pixel < browserPixels.length; pixel += 4) {
		let changed = false;
		for (let channel = 0; channel < 3; channel++) {
			const delta =
				(nativePixels[pixel + channel] ?? 0) -
				(browserPixels[pixel + channel] ?? 0);
			absolute += Math.abs(delta);
			squared += delta * delta;
			changed ||= Math.abs(delta) > 8;
		}
		if (changed) differentPixels++;
	}
	const samples = browserInfo.width * browserInfo.height * 3;
	const mse = squared / samples;
	const meanAbsoluteError = Math.round((absolute / samples) * 100) / 100;
	const psnrDb =
		Math.round((mse === 0 ? 100 : 10 * Math.log10(255 ** 2 / mse)) * 100) / 100;
	assert.ok(meanAbsoluteError < 3);
	assert.ok(psnrDb > 30);
	assert.ok(differentPixels < browserInfo.width * browserInfo.height * 0.05);
	assert.equal(workerRequests, 0);
	const closedReference = await app.request(`/editor/sessions/${sessionId}`, {
		method: "DELETE",
		headers,
	});
	assert.equal(closedReference.status, 204);
	sessionId = null;
	socketServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, listener) {
			const upgrade = handleEditorSocketUpgrade(request, listener);
			return upgrade === null ? app.fetch(request) : upgrade;
		},
		websocket: editorWebSocketHandler,
	});
	process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = `http://127.0.0.1:${socketServer.port}`;
	workerFixtureEnabled = true;
	const exportPreviewStartedAt = Date.now();
	await editor.getByRole("button", { name: "Export", exact: true }).click();
	await editor.getByRole("button", { name: "Back to editor" }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await editor.getByRole("img", { name: "Export preview" }).waitFor({
		state: "visible",
		timeout: 90_000,
	});
	const workerExportPreviewMs = Date.now() - exportPreviewStartedAt;
	await editor
		.getByText(/(?:< 1 MB|~[0-9.]+(?:–[0-9.]+)? (?:MB|GB))/)
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
	assert.equal(preparationRequests, 1);
	assert.ok(workerRequests > 0);
	assert.ok(sessionId);
	assert.ok(getEditorSession(sessionId));
	assert.deepEqual(failedResponses, []);
	assert.deepEqual(pageErrors, []);
	process.stdout.write(
		`${JSON.stringify({ browserEngine: engine.name(), browserOnly: true, bootstrapRequests, rangeRequests, workerRequests, preparationRequests, playbackAdvanced: true, persistedGradient: true, workerExportPreviewVisible: true, workerExportEstimateVisible: true, workerExportPreviewMs, meanAbsoluteError, psnrDb, differentPixels, totalPixels: browserInfo.width * browserInfo.height, pageErrors, failedResponses })}\n`,
	);
	await page.evaluate(() => {
		(
			window as typeof window & { capTestBridge?: { dispose: () => void } }
		).capTestBridge?.dispose();
	});
} finally {
	if (sessionId)
		await app.request(`/editor/sessions/${sessionId}`, {
			method: "DELETE",
			headers,
		});
	await browser?.close();
	socketServer?.stop(true);
	server?.stop(true);
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
	if (previousAllowHttp === undefined)
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
	if (previousPublicOrigin === undefined)
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	else process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = previousPublicOrigin;
}
