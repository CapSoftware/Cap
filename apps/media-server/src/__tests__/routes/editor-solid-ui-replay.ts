import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	CAP_BUNDLE_HEADER_BYTES,
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";
import {
	type Browser,
	chromium,
	type Download,
	firefox,
	webkit,
} from "@playwright/test";
import sharp from "sharp";
import { hasEditorCaptionContent } from "../../../../../apps/web/lib/editor-caption-access";
import app from "../../editor-worker-app";
import { parseEditorSocketRequest } from "../../lib/editor-command-socket";
import { renderEditorExportPreview } from "../../lib/editor-export-previews";
import { getEditorSession } from "../../lib/editor-sessions";
import {
	type EditorSocketConnection,
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

const secret = "editor-solid-ui-replay-secret";
const videoId = "editor-solid-ui-replay";
const userId = "editor-solid-ui-user";
const proCaptions = process.env.CAP_EDITOR_UI_PRO_CAPTIONS === "1";
const shareReplay = process.env.CAP_EDITOR_UI_SHARE_REPLAY === "1";
const cursorMovReplay = process.env.CAP_EDITOR_UI_CURSOR_MOV === "1";
assert.ok(!(shareReplay && cursorMovReplay));
const canvasFallbackReplay = process.env.CAP_EDITOR_UI_CANVAS_FALLBACK === "1";
assert.ok(!(canvasFallbackReplay && (shareReplay || cursorMovReplay)));
const coldMount = process.env.CAP_EDITOR_UI_COLD_MOUNT === "1";
const recoveryFault = process.env.CAP_EDITOR_UI_RUNTIME_RECOVERY_FAULT === "1";
const runtimeFault =
	process.env.CAP_EDITOR_UI_RUNTIME_FAULT === "1" || recoveryFault;
const runtimeFaultMessage = recoveryFault
	? "Recording may need to be recovered"
	: "Editor runtime fault for UI replay";
const browserEngine =
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
	proCaptions
		? "../fixtures/editor-clips/clip-blue-audio.mp4"
		: "../fixtures/editor-clips/display-red.webm",
);
const camera = join(
	import.meta.dir,
	"../fixtures/editor-clips/camera-green.webm",
);
const image = join(import.meta.dir, "../fixtures/exif-orientation-6.jpg");
const imagePath = "content/images/3d82ac0f-c24a-4c21-aa3c-e1749c23b24b.jpg";
const cursorInputEvents = `${[
	{ version: 1, platform: "MacOS" },
	{
		kind: "move",
		timeMs: 200,
		x: 0.3,
		y: 0.4,
		cursor: "default",
		button: 0,
		modifiers: [],
	},
	{
		kind: "move",
		timeMs: 1000,
		x: 0.7,
		y: 0.6,
		cursor: "pointer",
		button: 0,
		modifiers: [],
	},
]
	.map((event) => JSON.stringify(event))
	.join("\n")}\n`;
const imageKey = `${userId}/${videoId}/editor-assets/images/${imagePath.slice("content/images/".length)}`;

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

async function waitForWorkerCaptionContent(expected: boolean) {
	if (!sessionId) throw new Error("Editor session is unavailable");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const response = await app.request(`/editor/sessions/${sessionId}/config`, {
			headers,
		});
		if (
			response.ok &&
			hasEditorCaptionContent(await response.json()) === expected
		)
			return;
		await Bun.sleep(100);
	}
	throw new Error(`Worker caption access did not become ${expected}`);
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
let currentCaptionPlan = proCaptions;
let freeCaptionlessSaves = 0;
let proCaptionSaves = 0;
let savedPaidCaptions = false;
let preservingFreeSaves = 0;
let bundleTicketRequests = 0;
let browserBootstrapRequests = 0;
let browserMediaRangeRequests = 0;
let imageImports = 0;
let imagePreviewRequests = 0;
let uploadedImage: Uint8Array<ArrayBuffer> | null = null;
let renderedExportId: string | null = null;
let cursorMovTicketRequests = 0;
let cursorMovDownloadUrl: string | null = null;
let cursorMovWorkerDigest: { sha256: string; size: number } | null = null;
function requireCursorMovWorkerDigest() {
	const digest = cursorMovWorkerDigest;
	if (!digest) throw new Error("Cursor-only MOV worker file is unavailable");
	return digest;
}
let cursorMovVerification: {
	sha256: string;
	size: number;
	visibleFrames: number;
} | null = null;
let cursorMovExpectedStatus404 = 0;
let cursorMovExpectedConsole404 = 0;
let multipartInitiations = 0;
let exportChunkRequests = 0;
const uploadedParts = new Map<number, Buffer>();
let completedShare: {
	sha256: string;
	size: number;
	parts: number;
	duration: number;
} | null = null;
let base = "";
function mediaFixtureResponse(
	request: Request,
	path: string,
	contentType: string,
) {
	const blob = Bun.file(path);
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Accept-Ranges": "bytes",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "Content-Range",
	};
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (!range) return new Response(blob, { headers });
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
			headers: { ...headers, "Content-Range": `bytes */${blob.size}` },
		});
	}
	browserMediaRangeRequests++;
	return new Response(blob.slice(start, end + 1), {
		status: 206,
		headers: {
			...headers,
			"Content-Range": `bytes ${start}-${end}/${blob.size}`,
		},
	});
}
try {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/display.webm" || url.pathname === "/display.mp4")
				return mediaFixtureResponse(
					request,
					display,
					proCaptions ? "video/mp4" : "video/webm",
				);
			if (url.pathname === "/camera.webm")
				return mediaFixtureResponse(request, camera, "video/webm");
			if (url.pathname === "/input-events.ndjson")
				return new Response(cursorInputEvents, {
					headers: { "Content-Type": "application/x-ndjson" },
				});
			if (
				url.pathname === "/api/upload/multipart/initiate" &&
				request.method === "POST"
			) {
				const payload = (await request.json()) as {
					videoId?: string;
					contentType?: string;
					subpath?: string;
					replaceExisting?: boolean;
				};
				if (
					payload.videoId !== videoId ||
					payload.contentType !== "video/mp4" ||
					payload.subpath !== "result.mp4" ||
					payload.replaceExisting !== true
				)
					return new Response("Invalid replacement upload", { status: 400 });
				multipartInitiations++;
				return Response.json({ uploadId: "ui-reupload", provider: "s3" });
			}
			if (
				url.pathname === "/api/upload/multipart/presign-part" &&
				request.method === "POST"
			) {
				const payload = (await request.json()) as {
					videoId?: string;
					uploadId?: string;
					partNumber?: number;
					subpath?: string;
					replaceExisting?: boolean;
				};
				if (
					payload.videoId !== videoId ||
					payload.uploadId !== "ui-reupload" ||
					!Number.isSafeInteger(payload.partNumber) ||
					!payload.partNumber ||
					payload.partNumber < 1 ||
					payload.subpath !== "result.mp4" ||
					payload.replaceExisting !== true
				)
					return new Response("Invalid upload part", { status: 400 });
				return Response.json({
					presignedUrl: `${base}/test-multipart-part/${payload.partNumber}`,
					provider: "s3",
				});
			}
			const uploadPart = /^\/test-multipart-part\/([1-9][0-9]*)$/.exec(
				url.pathname,
			);
			if (uploadPart && request.method === "PUT") {
				const partNumber = Number(uploadPart[1]);
				uploadedParts.set(partNumber, Buffer.from(await request.arrayBuffer()));
				return new Response(null, {
					status: 200,
					headers: { ETag: `"ui-etag-${partNumber}"` },
				});
			}
			if (
				url.pathname === "/api/upload/multipart/complete" &&
				request.method === "POST"
			) {
				const payload = (await request.json()) as {
					videoId?: string;
					uploadId?: string;
					subpath?: string;
					replaceExisting?: boolean;
					durationInSecs?: number;
					width?: number;
					height?: number;
					fps?: number;
					parts?: Array<{ partNumber: number; etag: string; size: number }>;
				};
				if (
					payload.videoId !== videoId ||
					payload.uploadId !== "ui-reupload" ||
					payload.subpath !== "result.mp4" ||
					payload.replaceExisting !== true ||
					!payload.parts?.length ||
					!sessionId ||
					!renderedExportId
				)
					return new Response("Invalid upload completion", { status: 400 });
				const exportRoot = `/editor/sessions/${sessionId}/exports/${renderedExportId}`;
				const status = await app.request(exportRoot, { headers });
				const file = await app.request(`${exportRoot}/file`, { headers });
				if (!status.ok || !file.ok)
					return new Response("Rendered MP4 is unavailable", { status: 503 });
				const source = (await status.json()) as {
					mediaMetadata?: {
						duration: number;
						width: number;
						height: number;
						fps: number;
					} | null;
				};
				const sourceBytes = Buffer.from(await file.arrayBuffer());
				const parts = [...payload.parts].sort(
					(left, right) => left.partNumber - right.partNumber,
				);
				for (const part of parts) {
					assert.equal(part.etag, `ui-etag-${part.partNumber}`);
					assert.equal(part.size, uploadedParts.get(part.partNumber)?.length);
				}
				const uploaded = Buffer.concat(
					parts.map(
						(part) => uploadedParts.get(part.partNumber) ?? Buffer.alloc(0),
					),
				);
				assert.deepEqual(uploaded, sourceBytes);
				assert.ok(source.mediaMetadata);
				assert.equal(payload.width, source.mediaMetadata.width);
				assert.equal(payload.height, source.mediaMetadata.height);
				assert.equal(payload.fps, source.mediaMetadata.fps);
				assert.ok(payload.durationInSecs);
				assert.ok(
					Math.abs(payload.durationInSecs - source.mediaMetadata.duration) <
						0.001,
				);
				completedShare = {
					sha256: createHash("sha256").update(uploaded).digest("hex"),
					size: uploaded.byteLength,
					parts: parts.length,
					duration: source.mediaMetadata.duration,
				};
				return Response.json({ success: true, processingStarted: true });
			}
			if (
				url.pathname === "/api/upload/multipart/abort" &&
				request.method === "POST"
			)
				return Response.json({ success: true });
			if (url.pathname === "/test-image-upload" && request.method === "PUT") {
				uploadedImage = new Uint8Array(await request.arrayBuffer());
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/test-image.jpg" && uploadedImage)
				return new Response(uploadedImage, {
					headers: { "Content-Type": "image/jpeg" },
				});
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
			if (
				url.pathname ===
					`/api/editor/videos/${encodeURIComponent(videoId)}/bootstrap` &&
				request.method === "GET"
			) {
				browserBootstrapRequests++;
				return Response.json({
					videoId,
					sources: {
						videoId,
						title: "Paired editor UI fixture",
						captionsEnabled: currentCaptionPlan,
						signedUrlExpiresAt: Date.now() + 20 * 60_000,
						displayHasAudio: proCaptions,
						display: {
							url: `${base}/display.${proCaptions ? "mp4" : "webm"}`,
							contentType: proCaptions ? "video/mp4" : "video/webm",
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
			if (sessionId) {
				const apiRoot = `/api/editor/sessions/${encodeURIComponent(sessionId)}`;
				const exportRoot = `${apiRoot}/exports`;
				if (url.pathname === exportRoot && request.method === "POST") {
					const payload = (await request.json()) as {
						videoId?: string;
						settings?: unknown;
					};
					if (
						payload.videoId !== videoId ||
						typeof payload.settings !== "object" ||
						payload.settings === null
					)
						return new Response("Invalid editor export", { status: 400 });
					if (
						cursorMovReplay &&
						(!("format" in payload.settings) ||
							payload.settings.format !== "Mov" ||
							!("cursor_only" in payload.settings) ||
							payload.settings.cursor_only !== true)
					)
						return new Response("Invalid cursor-only MOV settings", {
							status: 400,
						});
					const started = await app.request(
						`/editor/sessions/${sessionId}/exports`,
						{
							method: "POST",
							headers,
							body: JSON.stringify(payload.settings),
						},
					);
					if (started.ok) {
						const state = (await started.clone().json()) as { id: string };
						renderedExportId = state.id;
					}
					return started;
				}
				if (url.pathname.startsWith(`${exportRoot}/`)) {
					const relative = url.pathname.slice(exportRoot.length + 1);
					const [exportId, action, extra] = relative.split("/");
					if (
						!exportId ||
						extra ||
						(action !== "download-ticket" &&
							url.searchParams.get("videoId") !== videoId) ||
						(action && action !== "chunk" && action !== "download-ticket")
					)
						return new Response("Invalid editor export request", {
							status: 400,
						});
					const workerPath = `/editor/sessions/${sessionId}/exports/${encodeURIComponent(exportId)}`;
					if (
						!action &&
						(request.method === "GET" || request.method === "DELETE")
					)
						return app.request(workerPath, { method: request.method, headers });
					if (action === "chunk" && request.method === "GET") {
						const offset = url.searchParams.get("offset");
						const length = url.searchParams.get("length");
						if (!offset || !length)
							return new Response("Invalid editor export chunk", {
								status: 400,
							});
						const chunk = await app.request(
							`${workerPath}/chunk?offset=${offset}&length=${length}`,
							{ headers },
						);
						if (chunk.status === 206) exportChunkRequests++;
						return chunk;
					}
					if (action === "download-ticket" && request.method === "POST") {
						const payload = (await request.json()) as {
							videoId?: string;
							fileName?: string;
						};
						if (
							!cursorMovReplay ||
							payload.videoId !== videoId ||
							!payload.fileName?.endsWith(".mov")
						)
							return new Response("Invalid cursor-only MOV ticket", {
								status: 400,
							});
						const ticket = await app.request(`${workerPath}/download-ticket`, {
							method: "POST",
							headers,
							body: JSON.stringify({ fileName: payload.fileName }),
						});
						if (ticket.ok) {
							const file = await app.request(`${workerPath}/file`, {
								headers,
							});
							assert.equal(file.status, 200);
							assert.equal(file.headers.get("Content-Type"), "video/quicktime");
							const bytes = Buffer.from(await file.arrayBuffer());
							cursorMovWorkerDigest = {
								sha256: createHash("sha256").update(bytes).digest("hex"),
								size: bytes.length,
							};
							const value = (await ticket.clone().json()) as { url: string };
							cursorMovDownloadUrl = value.url;
							cursorMovTicketRequests++;
						}
						return ticket;
					}
				}
				if (
					url.pathname === `${apiRoot}/project-bundle/download-ticket` &&
					request.method === "POST"
				) {
					const payload = (await request.json()) as { videoId?: string };
					if (payload.videoId !== videoId)
						return new Response("Invalid recording", { status: 403 });
					const ticketed = await app.request(
						`/editor/sessions/${sessionId}/project-bundle/download-ticket`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({ fileName: "Cap Recording.capbundle" }),
						},
					);
					if (ticketed.ok) bundleTicketRequests++;
					return ticketed;
				}
				if (url.pathname === `${apiRoot}/assets`) {
					if (request.method === "GET") return Response.json({ path: null });
					const payload = (await request.json()) as {
						kind?: string;
						videoId?: string;
						fileName?: string;
						size?: number;
						contentType?: string;
						key?: string;
						path?: string;
					};
					if (
						payload.kind !== "image" ||
						payload.videoId !== videoId ||
						payload.fileName !== "exif-orientation-6.jpg" ||
						payload.contentType !== "image/jpeg" ||
						payload.size !== (await stat(image)).size
					)
						return new Response("Invalid image import", { status: 400 });
					if (request.method === "POST")
						return Response.json({
							key: imageKey,
							path: imagePath,
							upload: {
								type: "put",
								url: `${base}/test-image-upload`,
								headers: {},
							},
						});
					if (
						request.method !== "PUT" ||
						payload.key !== imageKey ||
						payload.path !== imagePath ||
						!uploadedImage ||
						uploadedImage.byteLength !== payload.size
					)
						return new Response("Image upload is incomplete", { status: 400 });
					const imported = await app.request(
						`/editor/sessions/${sessionId}/image-assets`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								path: imagePath,
								name: "exif-orientation-6",
								url: `${base}/test-image.jpg`,
								size: payload.size,
								contentType: "image/jpeg",
								objectIdentity: null,
							}),
						},
					);
					if (imported.ok) imageImports++;
					return imported;
				}
				if (url.pathname === `${apiRoot}/file`) {
					if (
						request.method !== "GET" ||
						url.searchParams.get("videoId") !== videoId ||
						url.searchParams.get("path") !==
							`cap-web-editor://session/${sessionId}/${imagePath}`
					)
						return new Response("Image asset is unavailable", { status: 404 });
					imagePreviewRequests++;
					return Response.redirect(`${base}/test-image.jpg`);
				}
				if (url.pathname === `${apiRoot}/captions`) {
					const requestedVideoId =
						request.method === "GET"
							? url.searchParams.get("videoId")
							: ((await request.json()) as { videoId?: string }).videoId;
					if (!currentCaptionPlan || requestedVideoId !== videoId)
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
							preserveExistingPaidCaptions?: boolean;
						};
						if (
							payload.videoId !== videoId ||
							payload.expectedSavedAt !== savedAt
						)
							return new Response("Editor revision changed", { status: 409 });
						if (!currentCaptionPlan && hasEditorCaptionContent(payload.config))
							return new Response("Cap Pro is required for captions", {
								status: 403,
							});
						if (
							payload.preserveExistingPaidCaptions === true &&
							hasEditorCaptionContent(payload.config)
						)
							return new Response("Preserved captions must be absent", {
								status: 403,
							});
						const worker = await app.request(
							`/editor/sessions/${sessionId}/config`,
							{
								method: "PUT",
								headers,
								body: JSON.stringify(payload.config),
							},
						);
						if (!worker.ok) return worker;
						if (!currentCaptionPlan) {
							freeCaptionlessSaves++;
							if (
								savedPaidCaptions &&
								payload.preserveExistingPaidCaptions === true
							)
								preservingFreeSaves++;
						} else if (hasEditorCaptionContent(payload.config)) {
							proCaptionSaves++;
							savedPaidCaptions = true;
						} else if (payload.preserveExistingPaidCaptions !== true) {
							savedPaidCaptions = false;
						}
						savedAt = new Date().toISOString();
						return Response.json({ saved: true, savedAt });
					}
				}
				if (url.pathname === `${apiRoot}/plan` && request.method === "GET")
					return Response.json({ pro: currentCaptionPlan });
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
			...(cursorMovReplay
				? {
						inputEvents: {
							url: `${base}/input-events.ndjson`,
							contentType: "application/x-ndjson",
							size: Buffer.byteLength(cursorInputEvents),
						},
					}
				: {}),
		}),
	});
	assert.equal(preparation.status, 202);
	const prepared = (await preparation.json()) as { id: string };
	sessionId = await readySession(prepared.id, headers);
	const preparedNative = getEditorSession(sessionId);
	assert.ok(preparedNative);
	if (proCaptions && !runtimeFault) {
		const endPreview = await renderEditorExportPreview(
			sessionId,
			preparedNative,
			2,
			{
				fps: 60,
				resolution_base: { x: 640, y: 360 },
				compression_bpp: 0.14,
			},
			new AbortController().signal,
		);
		assert.equal(endPreview.total_frames, 120);
		assert.ok(Buffer.from(endPreview.jpeg_base64, "base64").length > 1_000);
	}
	if (shareReplay) {
		const gradientResponse = await preparedNative.request(
			"/animated-gradients/random",
		);
		assert.equal(gradientResponse.status, 200);
		const gradient = await gradientResponse.json();
		const configResponse = await app.request(
			`/editor/sessions/${sessionId}/config`,
			{ headers },
		);
		assert.equal(configResponse.status, 200);
		const config = (await configResponse.json()) as {
			background: { source: unknown; blur: number };
		};
		config.background.source = { type: "animatedGradient", config: gradient };
		config.background.blur = 60;
		const saved = await app.request(`/editor/sessions/${sessionId}/config`, {
			method: "PUT",
			headers,
			body: JSON.stringify(config),
		});
		assert.equal(saved.status, 204);
	}
	const socketHandler: Bun.WebSocketHandler<EditorSocketConnection> =
		runtimeFault
			? {
					...editorWebSocketHandler,
					message(ws, message) {
						let command = null;
						try {
							command = parseEditorSocketRequest(
								JSON.parse(
									typeof message === "string"
										? message
										: Buffer.from(message).toString("utf8"),
								),
							);
						} catch {}
						if (
							command?.kind === "invoke" &&
							command.name === "createEditorInstance"
						) {
							ws.send(
								JSON.stringify({
									kind: "error",
									id: command.id,
									error: runtimeFaultMessage,
								}),
							);
							return;
						}
						editorWebSocketHandler.message(ws, message);
					},
				}
			: editorWebSocketHandler;
	socketServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, listener) {
			const upgrade = handleEditorSocketUpgrade(request, listener);
			return upgrade === null ? app.fetch(request) : upgrade;
		},
		websocket: socketHandler,
	});
	process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = `http://127.0.0.1:${socketServer.port}`;
	browser = await browserEngine.launch({
		headless: process.env.CAP_EDITOR_UI_HEADED !== "1",
		...(process.env.CAP_EDITOR_UI_HEADED === "1" &&
		process.env.CAP_EDITOR_UI_BROWSER === "firefox"
			? {
					firefoxUserPrefs: {
						"webgl.force-enabled": true,
						"webgl.forbid-software": false,
					},
				}
			: {}),
	});
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	if (canvasFallbackReplay) {
		await page.addInitScript(() => {
			for (const name of [
				"OffscreenCanvas",
				"createImageBitmap",
				"VideoDecoder",
				"EncodedVideoChunk",
				"VideoFrame",
			]) {
				Object.defineProperty(window, name, {
					value: undefined,
					configurable: true,
				});
			}
			Object.defineProperty(navigator, "gpu", {
				value: undefined,
				configurable: true,
			});
		});
	}
	await page.addInitScript(() => {
		const nativeClose = WebSocket.prototype.close;
		WebSocket.prototype.close = function (code?: number, reason?: string) {
			if (code === 4003) {
				const browserWindow = window as typeof window & {
					capTestInvalidFrameCloses?: number;
				};
				browserWindow.capTestInvalidFrameCloses =
					(browserWindow.capTestInvalidFrameCloses ?? 0) + 1;
			}
			if (code === undefined) return nativeClose.call(this);
			if (reason === undefined) return nativeClose.call(this, code);
			return nativeClose.call(this, code, reason);
		};
	});
	const pageErrors: string[] = [];
	const dialogMessages: string[] = [];
	const rendererFallbacks: string[] = [];
	const failedResponses: string[] = [];
	const exportResponses: string[] = [];
	const failedResponseReads: Promise<void>[] = [];
	let delayedSkeletonRequests = 0;
	let delayedEditorRequests = 0;
	if (coldMount) {
		await page.addInitScript(() => {
			window.addEventListener("message", (event: MessageEvent<unknown>) => {
				if (typeof event.data !== "object" || event.data === null) return;
				if (!("kind" in event.data)) return;
				if (event.data.kind === "cap-editor-connect")
					document.body.dataset.editorConnectReceived = "true";
			});
		});
		await page.route(
			/\/editor-solid\/assets\/editor-skeleton-[^/]+\.js(?:\?.*)?$/,
			async (route) => {
				delayedSkeletonRequests++;
				await Bun.sleep(3_000);
				await route.continue();
			},
		);
		await page.route(
			/\/editor-solid\/assets\/Editor-[^/]+\.js(?:\?.*)?$/,
			async (route) => {
				delayedEditorRequests++;
				await Bun.sleep(6_000);
				await route.continue();
			},
		);
	}
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message),
	);
	page.on("dialog", (dialog) => {
		dialogMessages.push(dialog.message());
		void dialog
			.dismiss()
			.catch((cause: unknown) => pageErrors.push(String(cause)));
	});
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
		if (
			cursorMovReplay &&
			cursorMovTicketRequests === 1 &&
			sessionId &&
			renderedExportId &&
			message.text().includes("404") &&
			message.location().url ===
				`${base}/api/editor/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(renderedExportId)}?videoId=${videoId}`
		) {
			cursorMovExpectedConsole404++;
			return;
		}
		pageErrors.push(message.text());
	});
	page.on("response", (response) => {
		if (
			response.url().includes("/api/editor/sessions/") &&
			response.url().includes("/exports/")
		) {
			exportResponses.push(`${response.status()} ${response.url()}`);
			if (exportResponses.length > 12) exportResponses.shift();
		}
		if (response.status() < 400) return;
		const index =
			failedResponses.push(`${response.status()} ${response.url()}`) - 1;
		failedResponseReads.push(
			response.text().then(
				(body) => {
					failedResponses[index] += `: ${body.slice(0, 500)}`;
				},
				(error: unknown) => {
					failedResponses[index] += `: ${String(error)}`;
				},
			),
		);
	});
	await page.goto(`${base}/test-editor`);
	await page.locator("#editor").evaluate(async (frame) => {
		const iframe = frame as HTMLIFrameElement;
		if (iframe.contentDocument?.readyState === "complete") return;
		await new Promise<void>((resolve) =>
			iframe.addEventListener("load", () => resolve(), { once: true }),
		);
	});
	const connecting = page.evaluate(
		async ({ recordingId, editorSession, ownerId, captionsEnabled }) => {
			const { EditorHostBridge } = await import(
				new URL("/test-host.js", location.origin).href
			);
			const iframe = document.getElementById("editor") as HTMLIFrameElement;
			const browserWindow = window as typeof window & {
				capTestEditorError?: string;
				capTestEditorClosed?: boolean;
				capTestBridge?: { dispose: () => void };
				capTestSavedAt?: string | null;
			};
			browserWindow.capTestSavedAt = null;
			const bridge = new EditorHostBridge(
				recordingId,
				editorSession,
				ownerId,
				() => {
					browserWindow.capTestEditorClosed = true;
				},
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
	if (canvasFallbackReplay) {
		assert.deepEqual(
			await editor
				.locator("body")
				.evaluate(() => [
					typeof OffscreenCanvas,
					typeof createImageBitmap,
					typeof VideoDecoder,
				]),
			["undefined", "undefined", "undefined"],
		);
	}
	if (runtimeFault) {
		await connecting;
		await editor
			.getByRole("heading", { name: "Unable to Open Recording" })
			.waitFor({ state: "visible", timeout: 20_000 });
		assert.equal(await editor.getByText(runtimeFaultMessage).count(), 1);
		assert.equal(
			await editor.getByRole("button", { name: "Try again" }).count(),
			1,
		);
		assert.equal(
			await editor.getByRole("button", { name: "Open Folder" }).count(),
			0,
		);
		assert.equal(
			await editor.getByRole("button", { name: "Close Window" }).count(),
			0,
		);
		assert.equal(
			await editor.getByRole("button", { name: "Recover Recording" }).count(),
			0,
		);
		if (process.env.CAP_EDITOR_UI_RUNTIME_ERROR_SCREENSHOT_PATH)
			await writeFile(
				process.env.CAP_EDITOR_UI_RUNTIME_ERROR_SCREENSHOT_PATH,
				await page.screenshot(),
			);
		await editor.getByRole("button", { name: "Back to recording" }).click();
		await page.waitForFunction(
			() =>
				(window as typeof window & { capTestEditorClosed?: boolean })
					.capTestEditorClosed === true,
		);
		assert.deepEqual(failedResponses, []);
		process.stdout.write(
			`${JSON.stringify({ browserEngine: browserEngine.name(), runtimeFault: true, recoveryFault, nativeOnlyActionsHidden: true, backToRecordingClosedEditor: true, failedResponses })}\n`,
		);
	} else {
		if (coldMount) {
			await editor
				.locator("body[data-editor-connect-received=true]")
				.waitFor({ state: "attached", timeout: 4_000 });
			await editor
				.getByRole("button", { name: "Export", exact: true })
				.waitFor({ timeout: 4_000 });
			assert.equal(
				await editor
					.getByRole("button", { name: "Export", exact: true })
					.isDisabled(),
				true,
			);
			assert.equal(delayedSkeletonRequests, 1);
			assert.equal(delayedEditorRequests, 1);
		}
		await connecting;
		await editor.getByRole("button", { name: "Export", exact: true }).waitFor({
			state: "visible",
			timeout: 20_000,
		});
		await editor.getByRole("tab", { name: "Camera" }).waitFor({
			state: "visible",
			timeout: 20_000,
		});
		try {
			await editor.locator('[aria-busy="false"]').waitFor({
				state: "attached",
				timeout: 20_000,
			});
		} catch (cause) {
			throw new Error(
				`Local Studio preview did not render: ${JSON.stringify({ browserBootstrapRequests, browserMediaRangeRequests, pageErrors, failedResponses, rendererFallbacks })}`,
				{ cause },
			);
		}
		assert.ok(browserBootstrapRequests > 0);
		assert.ok(browserMediaRangeRequests > 0);
		assert.equal(
			await editor.getByRole("tab", { name: "Camera" }).isDisabled(),
			false,
		);
		if (shareReplay) {
			const blurControl = await editor
				.getByText("Blur", { exact: true })
				.locator("..")
				.innerText();
			assert.ok(blurControl.includes("60.0%"));
		}
		let nativePreviewParity: {
			meanAbsoluteError: number;
			psnrDb: number;
			differentPixels: number;
			totalPixels: number;
		} | null = null;
		if (!cursorMovReplay && !canvasFallbackReplay) {
			await editor.locator("#canvas").evaluate(async (canvas) => {
				const previewSurface = canvas.parentElement?.parentElement;
				if (!previewSurface) throw new Error("Preview surface is unavailable");
				const deadline = performance.now() + 3_000;
				while (Number(getComputedStyle(previewSurface).opacity) < 0.999) {
					if (performance.now() > deadline)
						throw new Error("Preview fade did not complete");
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			});
			const canvasSize = await editor.locator("#canvas").evaluate((canvas) => {
				const element = canvas as HTMLCanvasElement;
				return { width: element.width, height: element.height };
			});
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
			assert.ok(stride >= nativeWidth * 4);
			const browserScreenshot = await editor.locator("#canvas").screenshot();
			const { data: browserPixels, info: browserInfo } = await sharp(
				browserScreenshot,
			)
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
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
			nativePreviewParity = {
				meanAbsoluteError: Math.round((absolute / samples) * 100) / 100,
				psnrDb:
					Math.round(
						(mse === 0 ? 100 : 10 * Math.log10(255 ** 2 / mse)) * 100,
					) / 100,
				differentPixels,
				totalPixels: browserInfo.width * browserInfo.height,
			};
			assert.ok(nativePreviewParity.meanAbsoluteError < 3);
			assert.ok(nativePreviewParity.psnrDb > 30);
			assert.ok(differentPixels < nativePreviewParity.totalPixels * 0.05);
		}
		let cropFrameLoadMs = 0;
		let cropFrameSize = { width: 0, height: 0 };
		if (!shareReplay && !cursorMovReplay) {
			const cropStartedAt = Date.now();
			await editor.getByRole("button", { name: "Crop", exact: true }).click();
			await editor.getByText("Loading frame…").waitFor({
				state: "hidden",
				timeout: 30_000,
			});
			cropFrameLoadMs = Date.now() - cropStartedAt;
			cropFrameSize = await editor
				.getByRole("img", { name: "Current frame" })
				.evaluate((frame) => {
					const image = frame as HTMLImageElement;
					return { width: image.naturalWidth, height: image.naturalHeight };
				});
			assert.ok(cropFrameSize.width > 0 && cropFrameSize.width <= 1440);
			assert.ok(cropFrameSize.height > 0 && cropFrameSize.height <= 1440);
			const cropSurface = editor.locator(".cropper-editor");
			await cropSurface.click({ button: "right" });
			const cropMenu = editor.getByRole("menu", { name: "Editor actions" });
			await cropMenu.waitFor({ state: "visible" });
			assert.equal(
				await cropMenu.evaluate(
					(menu) => getComputedStyle(menu).backgroundColor,
				),
				"rgb(246, 246, 247)",
			);
			const checkedCropItem = cropMenu.locator(
				'[role="menuitemcheckbox"][aria-checked="true"]',
			);
			assert.ok((await checkedCropItem.count()) > 0);
			assert.equal(
				await checkedCropItem
					.first()
					.locator('span[aria-hidden="true"]')
					.innerText(),
				"✓",
			);
			await cropMenu.getByRole("menuitemcheckbox", { name: "16:9" }).click();
			await cropSurface.click({ button: "right" });
			const selectedRatio = cropMenu.getByRole("menuitemcheckbox", {
				name: "16:9",
			});
			assert.equal(await selectedRatio.getAttribute("aria-checked"), "true");
			assert.equal(
				await selectedRatio.locator('span[aria-hidden="true"]').innerText(),
				"✓",
			);
			await page.keyboard.press("Escape");
			assert.equal(await cropSurface.count(), 1);
			await editor
				.locator("html")
				.evaluate((root) => root.classList.add("dark"));
			await cropSurface.click({ button: "right" });
			assert.equal(
				await cropMenu.evaluate(
					(menu) => getComputedStyle(menu).backgroundColor,
				),
				"rgb(32, 32, 36)",
			);
			await page.keyboard.press("Escape");
			assert.equal(await cropSurface.count(), 1);
			await editor
				.locator("html")
				.evaluate((root) => root.classList.remove("dark"));
			await editor.getByRole("button", { name: "Cancel", exact: true }).click();
		}
		const bundleDownload = page.waitForEvent("download");
		await editor
			.getByRole("button", { name: "Download recording bundle" })
			.click();
		let bundle: Awaited<typeof bundleDownload>;
		try {
			bundle = await bundleDownload;
		} catch (cause) {
			throw new Error(
				`Recording bundle download failed: ${JSON.stringify({ bundleTicketRequests, pageErrors, failedResponses, pageText: (await editor.locator("body").innerText()).slice(0, 2_000) })}`,
				{ cause },
			);
		}
		assert.equal(bundle.suggestedFilename(), "Cap Recording.capbundle");
		assert.equal(await bundle.failure(), null);
		assert.equal(bundleTicketRequests, 1);
		const bundleBytes = Buffer.from(
			await Bun.file(await bundle.path()).arrayBuffer(),
		);
		const bundleManifestLength = readCapBundleManifestLength(
			bundleBytes.subarray(0, CAP_BUNDLE_HEADER_BYTES),
		);
		assert.ok(bundleManifestLength);
		const bundleManifest = parseCapBundleManifest(
			bundleBytes.subarray(
				CAP_BUNDLE_HEADER_BYTES,
				CAP_BUNDLE_HEADER_BYTES + bundleManifestLength,
			),
			bundleBytes.byteLength,
		);
		assert.ok(bundleManifest);
		assert.ok(
			bundleManifest.files.some((file) =>
				file.path.startsWith("content/segments/segment-0/display."),
			),
			JSON.stringify(bundleManifest.files.map((file) => file.path)),
		);
		assert.ok(
			bundleManifest.files.some((file) =>
				file.path.startsWith("content/segments/segment-0/camera."),
			),
			JSON.stringify(bundleManifest.files.map((file) => file.path)),
		);
		await editor.getByRole("tab", { name: "Captions" }).click();
		if (proCaptions) {
			await editor.getByRole("button", { name: "Generate Captions" }).waitFor({
				state: "visible",
				timeout: 20_000,
			});
			const languageField = editor
				.getByText("Language", { exact: true })
				.last()
				.locator("..");
			await languageField.getByRole("button").click();
			await editor
				.getByRole("option", { name: "English" })
				.waitFor({ state: "visible" });
			assert.equal(
				await editor.getByRole("option", { name: "Punjabi" }).count(),
				0,
			);
			await page.keyboard.press("Escape");
			assert.equal(
				await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).count(),
				0,
			);
			await editor.getByRole("button", { name: "Generate Captions" }).click();
			await editor
				.getByRole("button", { name: "Regenerate Captions" })
				.waitFor({ state: "visible", timeout: 20_000 });
			await editor.locator("[data-caption-segment]").first().waitFor({
				state: "visible",
			});
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "visible",
			});
			await waitForWorkerCaptionContent(true);
			const proSaveDeadline = Date.now() + 10_000;
			while (proCaptionSaves === 0 && Date.now() < proSaveDeadline)
				await Bun.sleep(100);
			assert.ok(proCaptionSaves > 0);
			assert.equal(captionRequests, 1);
			await editor.getByText("Captions", { exact: true }).last().waitFor({
				state: "visible",
			});
			await editor
				.getByRole("button", { name: "Captions", exact: true })
				.click();
			await editor.getByRole("button", { name: "SRT", exact: true }).waitFor({
				state: "visible",
			});
			const srtDownload = page.waitForEvent("download");
			await editor.getByRole("button", { name: "SRT", exact: true }).click();
			const srt = await srtDownload;
			assert.ok(srt.suggestedFilename().endsWith(".srt"));
			assert.match(await Bun.file(await srt.path()).text(), /Hello Cap/);
			const vttDownload = page.waitForEvent("download");
			await editor.getByRole("button", { name: "VTT", exact: true }).click();
			const vtt = await vttDownload;
			assert.ok(vtt.suggestedFilename().endsWith(".vtt"));
			assert.match(
				await Bun.file(await vtt.path()).text(),
				/WEBVTT[\s\S]*Hello Cap/,
			);
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
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "hidden",
			});
			await waitForWorkerCaptionContent(false);
		}
		if (proCaptions)
			await editor
				.getByRole("button", { name: "Back to editor" })
				.waitFor({ state: "visible" });
		currentCaptionPlan = !proCaptions;
		await editor
			.locator("body")
			.evaluate(() => window.dispatchEvent(new Event("focus")));
		if (proCaptions) {
			await editor
				.getByRole("button", { name: "Back to editor" })
				.waitFor({ state: "hidden" });
			await editor
				.getByRole("button", { name: "SRT", exact: true })
				.waitFor({ state: "hidden" });
			await editor
				.getByRole("button", { name: "VTT", exact: true })
				.waitFor({ state: "hidden" });
			assert.equal(
				await editor
					.getByRole("button", { name: "Captions", exact: true })
					.count(),
				0,
			);
			await editor.getByRole("tab", { name: "Captions" }).click();
			await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).waitFor({
				state: "visible",
			});
			await editor.locator("[data-caption-segment]").first().waitFor({
				state: "hidden",
			});
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "hidden",
			});
			const previousFreeSaves = freeCaptionlessSaves;
			const previousPreservingFreeSaves = preservingFreeSaves;
			await editor.getByRole("tab", { name: "Camera" }).click();
			await editor
				.getByText("Mirror Camera", { exact: true })
				.locator("..")
				.locator(".cap-toggle")
				.click();
			const saveDeadline = Date.now() + 10_000;
			while (
				freeCaptionlessSaves === previousFreeSaves &&
				Date.now() < saveDeadline
			)
				await Bun.sleep(100);
			assert.ok(freeCaptionlessSaves > previousFreeSaves);
			assert.ok(preservingFreeSaves > previousPreservingFreeSaves);
			assert.equal(savedPaidCaptions, true);
			let unsavedSnapshot: string | null | undefined;
			const receiptDeadline = Date.now() + 10_000;
			while (Date.now() < receiptDeadline) {
				unsavedSnapshot = await editor.locator("body").evaluate(() =>
					(
						window as Window & {
							capWebEditorUnsavedProjectSnapshot?: () => string | null;
						}
					).capWebEditorUnsavedProjectSnapshot?.(),
				);
				if (unsavedSnapshot === null) break;
				await Bun.sleep(100);
			}
			assert.equal(unsavedSnapshot, null);
			await editor.getByRole("tab", { name: "Captions" }).click();
			assert.equal(
				await editor
					.getByRole("button", { name: "Regenerate Captions" })
					.count(),
				0,
			);
		} else {
			await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).waitFor({
				state: "hidden",
			});
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "visible",
			});
			await waitForWorkerCaptionContent(false);
		}
		currentCaptionPlan = proCaptions;
		await editor
			.locator("body")
			.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
		if (proCaptions) {
			await editor
				.getByRole("button", { name: "Captions", exact: true })
				.waitFor({ state: "visible" });
			await editor
				.getByRole("button", { name: "Regenerate Captions" })
				.waitFor({
					state: "visible",
				});
			await editor.locator("[data-caption-segment]").first().waitFor({
				state: "visible",
			});
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "visible",
			});
		} else {
			await editor.getByRole("link", { name: "Upgrade to Cap Pro" }).waitFor({
				state: "visible",
			});
			await editor.getByText("Font settings", { exact: true }).waitFor({
				state: "hidden",
			});
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
		await editor.getByRole("button", { name: "Add track" }).click();
		const fileChooser = page.waitForEvent("filechooser");
		await editor.getByRole("button", { name: "Image", exact: true }).click();
		await (await fileChooser).setFiles(image);
		await editor.locator("[data-image-overlay]").waitFor({
			state: "visible",
			timeout: 20_000,
		});
		assert.equal(imageImports, 1);
		assert.ok(imagePreviewRequests > 0);
		let canvasFallbackPreviewPixel: number[] | null = null;
		if (canvasFallbackReplay) {
			const deadline = Date.now() + 15_000;
			do {
				const canvasImage = await editor.locator("#canvas").screenshot();
				const { data, info } = await sharp(canvasImage)
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				const center =
					(Math.floor(info.height / 2) * info.width +
						Math.floor(info.width / 2)) *
					info.channels;
				canvasFallbackPreviewPixel = Array.from(
					data.subarray(center, center + info.channels),
				);
				if (Math.max(...canvasFallbackPreviewPixel.slice(0, 3)) > 20) break;
				await Bun.sleep(150);
			} while (Date.now() < deadline);
			if (Math.max(...(canvasFallbackPreviewPixel ?? []).slice(0, 3)) <= 20) {
				const browserState = await editor.locator("body").evaluate(() => {
					const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
					const display = document.querySelector<HTMLVideoElement>("video");
					const sample = (source: CanvasImageSource | null) => {
						if (!source) return null;
						const target = document.createElement("canvas");
						target.width = 1;
						target.height = 1;
						const context = target.getContext("2d", {
							willReadFrequently: true,
						});
						if (!context) return null;
						try {
							context.drawImage(source, 0, 0, 1, 1);
							return Array.from(context.getImageData(0, 0, 1, 1).data);
						} catch {
							return null;
						}
					};
					return {
						canvasWidth: canvas?.width ?? null,
						canvasHeight: canvas?.height ?? null,
						canvasConnected: canvas?.isConnected ?? false,
						canvasReadbackPixel: sample(canvas),
						displayReadbackPixel: sample(display),
						webglContextLost:
							canvas?.getContext("webgl2")?.isContextLost() ?? null,
						loadingFrame: document.body.textContent?.includes("Loading frame…"),
						videos: Array.from(document.querySelectorAll("video")).map(
							(video) => ({
								readyState: video.readyState,
								videoWidth: video.videoWidth,
								videoHeight: video.videoHeight,
								error: video.error?.message ?? null,
							}),
						),
					};
				});
				console.error(
					JSON.stringify({
						canvasFallbackPreviewPixel,
						browserState,
						pageErrors,
						failedResponses,
						rendererFallbacks,
					}),
				);
			}
			assert.ok(Math.max(...canvasFallbackPreviewPixel.slice(0, 3)) > 20);
		}
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
				.getByText(/^0:(?:00\.(?:0[1-9]|[1-9]\d)|01\.\d\d)$/)
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
		if (!shareReplay) {
			const cameraBackground = editor
				.getByText("Background", { exact: true })
				.locator("..");
			await cameraBackground.locator("button").click();
			await editor.getByRole("option", { name: "Remove Background" }).click();
			await cameraBackground.getByText("Remove Background").waitFor({
				state: "visible",
			});
		}
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
		if (cursorMovReplay) {
			await editor.getByRole("button", { name: "Advanced" }).click();
			const cursorOnly = editor.getByRole("group", {
				name: "Export cursor only",
			});
			await cursorOnly.locator(".cap-toggle").click();
			assert.equal(
				await cursorOnly.getByRole("switch").getAttribute("aria-checked"),
				"true",
			);
			await editor
				.getByText("Exports as a transparent MOV.", { exact: false })
				.waitFor({ state: "visible" });
			const destination = editor.getByRole("radio", {
				name: "File",
				exact: true,
			});
			await destination.click();
			assert.equal(await destination.getAttribute("aria-checked"), "true");
			const downloading = page.waitForEvent("download", {
				timeout: 120_000,
			});
			await editor.getByRole("button", { name: "Export to File" }).click();
			let download: Download;
			try {
				download = await downloading;
			} catch (cause) {
				let workerStatus: { status: number; body: string } | string | null =
					null;
				if (renderedExportId && sessionId) {
					try {
						const response = await app.request(
							`/editor/sessions/${sessionId}/exports/${renderedExportId}`,
							{ headers },
						);
						workerStatus = {
							status: response.status,
							body: (await response.text()).slice(0, 800),
						};
					} catch (error) {
						workerStatus = String(error);
					}
				}
				let pageText: string;
				try {
					pageText = (await editor.locator("body").innerText()).slice(0, 2_000);
				} catch (error) {
					pageText = String(error);
				}
				throw new Error(
					`Cursor MOV download failed: ${JSON.stringify({
						renderedExportId,
						cursorMovTicketRequests,
						workerStatus,
						exportResponses,
						dialogMessages,
						pageErrors,
						failedResponses,
						browserPages: page
							.context()
							.pages()
							.map((browserPage) => browserPage.url().split("?")[0]),
						pageText,
					})}`,
					{ cause },
				);
			}
			await editor
				.getByText("Cursor track exported to file", { exact: false })
				.waitFor({ state: "visible" });
			assert.ok(download.suggestedFilename().endsWith(".mov"));
			const downloadPath = await download.path();
			assert.ok(downloadPath);
			const downloadedBytes = await readFile(downloadPath);
			assert.ok(downloadedBytes.length > 20_000);
			assert.equal(cursorMovTicketRequests, 1);
			const workerDigest = requireCursorMovWorkerDigest();
			const digest = createHash("sha256").update(downloadedBytes).digest("hex");
			assert.equal(downloadedBytes.length, workerDigest.size);
			assert.equal(digest, workerDigest.sha256);
			const probe = spawnSync("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,pix_fmt",
				"-of",
				"json",
				downloadPath,
			]);
			assert.equal(probe.status, 0);
			const streams = JSON.parse(probe.stdout.toString()) as {
				streams: Array<{ codec_name?: string; pix_fmt?: string }>;
			};
			assert.equal(streams.streams[0]?.codec_name, "prores");
			assert.ok(streams.streams[0]?.pix_fmt?.startsWith("yuva"));
			const decoder = spawnSync(
				"ffmpeg",
				[
					"-v",
					"error",
					"-i",
					downloadPath,
					"-vf",
					"fps=2,scale=320:180",
					"-pix_fmt",
					"rgba",
					"-f",
					"rawvideo",
					"-",
				],
				{ maxBuffer: 4 * 1024 * 1024 },
			);
			assert.equal(decoder.status, 0);
			const pixelsPerFrame = 320 * 180;
			const frameBytes = pixelsPerFrame * 4;
			assert.equal(decoder.stdout.length % frameBytes, 0);
			let visibleFrames = 0;
			for (let frame = 0; frame < decoder.stdout.length / frameBytes; frame++) {
				let visiblePixels = 0;
				for (let pixel = 0; pixel < pixelsPerFrame; pixel++) {
					if (decoder.stdout[frame * frameBytes + pixel * 4 + 3] > 0)
						visiblePixels++;
				}
				if (visiblePixels > 0) visibleFrames++;
				assert.ok(visiblePixels < pixelsPerFrame / 20);
			}
			assert.ok(visibleFrames >= 2);
			assert.ok(cursorMovDownloadUrl);
			const consumedUrl = new URL(cursorMovDownloadUrl);
			assert.equal(
				(await app.request(consumedUrl.pathname + consumedUrl.search)).status,
				404,
			);
			cursorMovVerification = {
				sha256: digest,
				size: downloadedBytes.length,
				visibleFrames,
			};
		}
		if (shareReplay) {
			const destination = editor.getByRole("radio", {
				name: "Reupload",
				exact: true,
			});
			assert.equal(await destination.isDisabled(), false);
			await destination.click();
			assert.equal(await destination.getAttribute("aria-checked"), "true");
			await editor
				.getByRole("button", { name: "Reupload to same link" })
				.click();
			await editor.getByText("Reupload complete", { exact: true }).waitFor({
				state: "visible",
				timeout: 120_000,
			});
			await editor.getByRole("button", { name: "Copy Link" }).waitFor({
				state: "visible",
			});
			assert.equal(multipartInitiations, 1);
			assert.ok(exportChunkRequests > 0);
			assert.ok(uploadedParts.size > 0);
			assert.ok(completedShare);
		}
		const bridgeError = await page.evaluate(
			() =>
				(window as typeof window & { capTestEditorError?: string })
					.capTestEditorError ?? null,
		);
		const invalidFrameCloses = await editor
			.locator("body")
			.evaluate(
				() =>
					(window as typeof window & { capTestInvalidFrameCloses?: number })
						.capTestInvalidFrameCloses ?? 0,
			);
		assert.equal(bridgeError, null);
		assert.equal(invalidFrameCloses, 0);
		await Promise.all(failedResponseReads);
		if (cursorMovReplay) {
			assert.ok(sessionId);
			assert.ok(renderedExportId);
			const expectedStatus = `404 ${base}/api/editor/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(renderedExportId)}?videoId=${videoId}:`;
			for (let index = failedResponses.length - 1; index >= 0; index--) {
				if (failedResponses[index]?.startsWith(expectedStatus)) {
					failedResponses.splice(index, 1);
					cursorMovExpectedStatus404++;
				}
			}
		}
		assert.deepEqual(failedResponses, []);
		assert.deepEqual(pageErrors, []);
		process.stdout.write(
			`${JSON.stringify({
				videoId,
				browserEngine: browserEngine.name(),
				proCaptions,
				coldMount,
				delayedSkeletonRequests,
				delayedEditorRequests,
				separateCameraTabEnabled: true,
				cropFrameSize,
				cropFrameLoadMs,
				cropRatiosAndThemesVerified: !shareReplay && !cursorMovReplay,
				recordingBundleDownloaded: bundleTicketRequests === 1,
				freeCaptionsUpgradeVisible: !proCaptions,
				proCaptionGenerationVisible: proCaptions,
				proCaptionGenerationApplied: proCaptions && captionRequests === 1,
				captionPlanChangesWithoutReload: true,
				playbackAdvanced,
				localModelDownloadsAbsent: true,
				imageOverlayImported: imageImports === 1 && imagePreviewRequests > 0,
				cameraControlsVisible: true,
				cameraBackgroundRemovalSelectable: !shareReplay,
				exportPreviewVisible: true,
				cursorMovReplay,
				canvasFallbackReplay,
				canvasFallbackPreviewPixel,
				nativePreviewParity,
				cursorMovVerification,
				cursorMovExpectedStatus404,
				cursorMovExpectedConsole404,
				shareReplay,
				multipartInitiations,
				exportChunkRequests,
				completedShare,
				screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
				exportScreenshotSha256: createHash("sha256")
					.update(exportScreenshot)
					.digest("hex"),
				pageErrors,
				failedResponses,
				rendererFallbacks: rendererFallbacks.length,
				invalidFrameCloses,
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
	}
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
