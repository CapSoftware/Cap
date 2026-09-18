import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type Browser, chromium, webkit } from "@playwright/test";
import app from "../../editor-worker-app";
import {
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

const secret = "editor-solid-ui-replay-secret";
const videoId = "editor-solid-ui-replay";
const userId = "editor-solid-ui-user";
const proCaptions = process.env.CAP_EDITOR_UI_PRO_CAPTIONS === "1";
const browserEngine =
	process.env.CAP_EDITOR_UI_BROWSER === "webkit" ? webkit : chromium;
const editorPublic = resolve(
	process.env.CAP_EDITOR_SOLID_PUBLIC_DIR ??
		resolve(import.meta.dir, "../../../../../apps/web/public/editor-solid"),
);
const display = join(
	import.meta.dir,
	proCaptions
		? "../fixtures/editor-clips/clip-blue-audio.mp4"
		: "../fixtures/editor-clips/display-red.webm",
);
const camera = join(
	import.meta.dir,
	"../fixtures/editor-clips/camera-green.webm",
);

async function readySession(id: string, headers: Record<string, string>) {
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
			throw new Error(status.error ?? "Editor UI fixture could not prepare");
		await Bun.sleep(100);
	}
	throw new Error("Editor UI fixture preparation timed out");
}

assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
assert.ok(await Bun.file(join(editorPublic, "index.html")).exists());

const hostModule = await Bun.build({
	entrypoints: [
		join(
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
let browser: Browser | null = null;
let sessionId: string | null = null;
let savedAt: string | null = null;
let captionRequests = 0;
let base = "";
try {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/display.webm" || url.pathname === "/display.mp4")
				return new Response(Bun.file(display));
			if (url.pathname === "/camera.webm")
				return new Response(Bun.file(camera));
			if (url.pathname === "/test-host.js")
				return new Response(hostCode, {
					headers: { "Content-Type": "text/javascript; charset=utf-8" },
				});
			if (url.pathname === "/api/desktop/organizations")
				return Response.json([]);
			if (url.pathname === "/favicon.ico")
				return new Response(null, { status: 204 });
			if (url.pathname === "/test-editor")
				return new Response(
					'<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100vw;height:100vh;border:0}</style></head><body><iframe id="editor" src="/editor-solid/index.html"></iframe></body></html>',
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
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
			if (sessionId) {
				const apiRoot = `/api/editor/sessions/${encodeURIComponent(sessionId)}`;
				if (url.pathname === `${apiRoot}/captions`) {
					const requestedVideoId =
						request.method === "GET"
							? url.searchParams.get("videoId")
							: ((await request.json()) as { videoId?: string }).videoId;
					if (!proCaptions || requestedVideoId !== videoId)
						return new Response("Cap Pro is required for captions", {
							status: 403,
						});
					captionRequests++;
					return Response.json({
						status: "ready",
						captions: {
							segments: [
								{
									id: "assemblyai-caption",
									start: 0.5,
									end: 1.2,
									text: "Hello Cap",
									words: [
										{ text: "Hello", start: 0.5, end: 0.8 },
										{ text: "Cap", start: 0.8, end: 1.2 },
									],
								},
							],
							settings: null,
						},
						message: null,
					});
				}
				if (
					url.pathname === `${apiRoot}/tickets` &&
					request.method === "POST"
				) {
					const payload = (await request.json()) as { videoId?: string };
					if (payload.videoId !== videoId)
						return new Response("Invalid recording", { status: 403 });
					const worker = await app.request(
						`/editor/sessions/${sessionId}/sockets`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({ origin: base }),
						},
					);
					if (!worker.ok) return worker;
					const ticketed = (await worker.json()) as {
						sockets: Record<string, unknown>;
					};
					return Response.json(ticketed.sockets);
				}
				if (url.pathname === `${apiRoot}/config`) {
					if (request.method === "GET") return Response.json({ savedAt });
					if (request.method === "PUT") {
						const payload = (await request.json()) as {
							videoId?: string;
							config?: unknown;
							expectedSavedAt?: string | null;
						};
						if (
							payload.videoId !== videoId ||
							payload.expectedSavedAt !== savedAt
						)
							return new Response("Editor revision changed", { status: 409 });
						const worker = await app.request(
							`/editor/sessions/${sessionId}/config`,
							{
								method: "PUT",
								headers,
								body: JSON.stringify(payload.config),
							},
						);
						if (!worker.ok) return worker;
						savedAt = new Date().toISOString();
						return Response.json({ saved: true, savedAt });
					}
				}
				if (url.pathname === `${apiRoot}/plan` && request.method === "GET")
					return Response.json({ pro: proCaptions });
				if (url.pathname === `${apiRoot}/assets` && request.method === "GET")
					return Response.json({ path: null });
			}
			return new Response("Missing editor fixture route", { status: 404 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	const preparation = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId,
			title: "Paired editor UI fixture",
			captionsEnabled: proCaptions,
			display: {
				url: `${base}/display.${proCaptions ? "mp4" : "webm"}`,
				contentType: proCaptions ? "video/mp4" : "video/webm",
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
		}),
	});
	assert.equal(preparation.status, 202);
	const prepared = (await preparation.json()) as { id: string };
	sessionId = await readySession(prepared.id, headers);
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
	browser = await browserEngine.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	const pageErrors: string[] = [];
	const rendererFallbacks: string[] = [];
	const failedResponses: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		if (
			message
				.text()
				.includes(
					"Main thread WebGPU init failed: Error: No WebGPU adapter available",
				)
		) {
			rendererFallbacks.push(message.text());
			return;
		}
		pageErrors.push(message.text());
	});
	page.on("response", (response) => {
		if (response.status() >= 400)
			failedResponses.push(`${response.status()} ${response.url()}`);
	});
	await page.goto(`${base}/test-editor`);
	await page.locator("#editor").evaluate(async (frame) => {
		const iframe = frame as HTMLIFrameElement;
		if (iframe.contentDocument?.readyState === "complete") return;
		await new Promise<void>((resolve) =>
			iframe.addEventListener("load", () => resolve(), { once: true }),
		);
	});
	await page.evaluate(
		async ({ recordingId, editorSession, ownerId, captionsEnabled }) => {
			const { EditorHostBridge } = await import(
				new URL("/test-host.js", location.origin).href
			);
			const iframe = document.getElementById("editor") as HTMLIFrameElement;
			const browserWindow = window as typeof window & {
				capTestEditorError?: string;
				capTestBridge?: { dispose: () => void };
				capTestSavedAt?: string | null;
			};
			browserWindow.capTestSavedAt = null;
			const bridge = new EditorHostBridge(
				recordingId,
				editorSession,
				ownerId,
				() => undefined,
				(error: Error) => {
					browserWindow.capTestEditorError = error.message;
				},
				undefined,
				undefined,
				undefined,
				captionsEnabled,
				undefined,
				(value: string) => {
					browserWindow.capTestSavedAt = value;
				},
				() => browserWindow.capTestSavedAt ?? null,
			);
			browserWindow.capTestBridge = bridge;
			await bridge.connect(iframe);
		},
		{
			recordingId: videoId,
			editorSession: sessionId,
			ownerId: userId,
			captionsEnabled: proCaptions,
		},
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
	assert.equal(
		await editor.getByRole("tab", { name: "Camera" }).isDisabled(),
		false,
	);
	await editor.getByRole("tab", { name: "Captions" }).click();
	if (proCaptions) {
		await editor.getByRole("button", { name: "Generate Captions" }).waitFor({
			state: "visible",
			timeout: 20_000,
		});
		assert.equal(
			await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).count(),
			0,
		);
		await editor.getByRole("button", { name: "Generate Captions" }).click();
		await editor
			.getByRole("button", { name: "Regenerate Captions" })
			.waitFor({ state: "visible", timeout: 20_000 });
		assert.equal(captionRequests, 1);
		await editor.getByText("Captions", { exact: true }).last().waitFor({
			state: "visible",
		});
	} else {
		await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).waitFor({
			state: "visible",
			timeout: 20_000,
		});
		assert.equal(
			await editor.getByRole("button", { name: "Generate Captions" }).count(),
			0,
		);
		assert.equal(captionRequests, 0);
	}
	assert.equal(
		await editor
			.getByText(
				"Cap Pro captions use the same AssemblyAI transcription as your shareable link.",
			)
			.isVisible(),
		true,
	);
	assert.equal(await editor.getByText("Download Whisper model").count(), 0);
	const screenshot = await page.screenshot();
	if (process.env.CAP_EDITOR_UI_SCREENSHOT_PATH)
		await writeFile(process.env.CAP_EDITOR_UI_SCREENSHOT_PATH, screenshot);
	let playbackAdvanced = false;
	if (proCaptions) {
		await editor.getByRole("button", { name: "Play video" }).click();
		await editor.getByRole("button", { name: "Pause video" }).waitFor({
			state: "visible",
			timeout: 10_000,
		});
		await editor
			.getByText(/^0:00\.[1-9]\d$/)
			.first()
			.waitFor({
				state: "visible",
				timeout: 10_000,
			});
		playbackAdvanced = true;
		await editor.getByRole("button", { name: "Pause video" }).click();
	}
	await editor.getByRole("tab", { name: "Camera" }).click();
	await editor.getByText("Hide Camera").waitFor({ state: "visible" });
	const cameraBackground = editor
		.getByText("Background", { exact: true })
		.locator("..");
	await cameraBackground.locator("button").click();
	await editor.getByRole("option", { name: "Remove Background" }).click();
	await cameraBackground.getByText("Remove Background").waitFor({
		state: "visible",
	});
	await editor.getByRole("button", { name: "Export", exact: true }).click();
	await editor.getByRole("button", { name: "Back to editor" }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await editor.getByRole("button", { name: "Export to File" }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	try {
		await editor.getByRole("img", { name: "Export preview" }).waitFor({
			state: "visible",
			timeout: 20_000,
		});
	} catch (cause) {
		throw new Error(
			`Export preview failed: ${JSON.stringify({ pageErrors, failedResponses, pageText: (await editor.locator("body").innerText()).slice(0, 2_000) })}`,
			{ cause },
		);
	}
	const exportScreenshot = await page.screenshot();
	if (process.env.CAP_EDITOR_UI_EXPORT_SCREENSHOT_PATH)
		await writeFile(
			process.env.CAP_EDITOR_UI_EXPORT_SCREENSHOT_PATH,
			exportScreenshot,
		);
	const bridgeError = await page.evaluate(
		() =>
			(window as typeof window & { capTestEditorError?: string })
				.capTestEditorError ?? null,
	);
	assert.equal(bridgeError, null);
	assert.deepEqual(pageErrors, []);
	assert.deepEqual(failedResponses, []);
	process.stdout.write(
		`${JSON.stringify({
			videoId,
			browserEngine: browserEngine.name(),
			proCaptions,
			separateCameraTabEnabled: true,
			freeCaptionsUpgradeVisible: !proCaptions,
			proCaptionGenerationVisible: proCaptions,
			proCaptionGenerationApplied: proCaptions && captionRequests === 1,
			playbackAdvanced,
			localModelDownloadsAbsent: true,
			cameraControlsVisible: true,
			cameraBackgroundRemovalSelectable: true,
			exportPreviewVisible: true,
			screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
			exportScreenshotSha256: createHash("sha256")
				.update(exportScreenshot)
				.digest("hex"),
			pageErrors,
			failedResponses,
			rendererFallbacks: rendererFallbacks.length,
		})}\n`,
	);
	await page.evaluate(() => {
		(
			window as typeof window & { capTestBridge?: { dispose: () => void } }
		).capTestBridge?.dispose();
	});
	await page.close();
	const faultPage = await browser.newPage();
	let blockedEditorChunks = 0;
	await faultPage.route(
		/\/editor-solid\/assets\/Editor-[^/]+\.js(?:\?.*)?$/,
		async (route) => {
			blockedEditorChunks++;
			await route.abort("failed");
		},
	);
	await faultPage.goto(`${base}/test-editor`);
	await faultPage.locator("#editor").evaluate(async (frame) => {
		const iframe = frame as HTMLIFrameElement;
		if (iframe.contentDocument?.readyState === "complete") return;
		await new Promise<void>((resolve) =>
			iframe.addEventListener("load", () => resolve(), { once: true }),
		);
	});
	const mountFailure = await faultPage.evaluate(
		async ({ recordingId, editorSession, ownerId }) => {
			const { EditorHostBridge } = await import(
				new URL("/test-host.js", location.origin).href
			);
			const iframe = document.getElementById("editor") as HTMLIFrameElement;
			const bridge = new EditorHostBridge(
				recordingId,
				editorSession,
				ownerId,
				() => undefined,
				() => undefined,
			);
			try {
				await bridge.connect(iframe);
				return null;
			} catch (cause) {
				return cause instanceof Error ? cause.message : String(cause);
			} finally {
				bridge.dispose();
			}
		},
		{ recordingId: videoId, editorSession: sessionId, ownerId: userId },
	);
	assert.ok(blockedEditorChunks > 0);
	assert.equal(mountFailure, "Editor could not load");
	await faultPage.close();
	process.stdout.write(
		`${JSON.stringify({ editorChunkFailureVisible: true, blockedEditorChunks })}\n`,
	);
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
