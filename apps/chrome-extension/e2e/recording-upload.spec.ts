import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BrowserContext,
	chromium,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { RecordingStatus } from "../src/shared/types";

type ChromeRuntimeResponse =
	| {
			ok: true;
			status?: RecordingStatus;
	  }
	| {
			ok: false;
			error: string;
	  };

type MockState = {
	abortBodies: unknown[];
	completeBodies: unknown[];
	progressBodies: unknown[];
	initiateBodies: unknown[];
	presignBodies: unknown[];
	uploadBytes: number[];
	uploadBytesBySubpath: Record<string, number>;
	completedPartsBySubpath: Record<string, number>;
	uploadHeaders: Record<string, string | string[] | undefined>[];
	videoId: string;
	simulateSlowCameraUpload: boolean;
	failCameraCompletion: boolean;
	failAudioCompletion: boolean;
	failScreenCompletion: boolean;
	cameraInitiateDelayMs: number;
};

type ChromeGlobal = typeof globalThis & {
	chrome: {
		runtime: {
			lastError?: { message?: string };
			sendMessage(
				message: unknown,
				callback: (response: unknown) => void,
			): void;
		};
		storage: {
			local: {
				clear(callback?: () => void): void;
				set(items: Record<string, unknown>, callback?: () => void): void;
			};
		};
	};
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = process.env.CAP_EXTENSION_E2E_DIR
	? path.resolve(process.env.CAP_EXTENSION_E2E_DIR)
	: path.resolve(__dirname, "../dist");
const SETTINGS_KEY = "cap-extension-settings";
const AUTH_KEY = "cap-extension-auth";
const BOOTSTRAP_CACHE_KEY = "cap-extension-bootstrap-cache";
const RECORDING_MS = 3_500;
const RECORDING_MODE = "fullscreen";

const readRequestBody = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
};

const parseJsonBody = async (request: IncomingMessage) => {
	const body = await readRequestBody(request);
	return body.length > 0 ? JSON.parse(body.toString("utf8")) : null;
};

const sendJson = (
	response: ServerResponse,
	status: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) => {
	response.writeHead(status, {
		"Access-Control-Allow-Headers":
			"Authorization, Content-Type, Content-Range",
		"Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, POST, PUT",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "ETag",
		"Content-Type": "application/json",
		...headers,
	});
	response.end(JSON.stringify(body));
};

const sendHtml = (response: ServerResponse, html: string) => {
	response.writeHead(200, {
		"Access-Control-Allow-Origin": "*",
		"Content-Type": "text/html; charset=utf-8",
	});
	response.end(html);
};

const animatedCapturePage = () => `<!doctype html>
<html>
	<head>
		<title>Cap E2E Capture Target</title>
		<style>
			html,
			body {
				margin: 0;
				width: 100%;
				height: 100%;
				overflow: hidden;
				background: #0b0f13;
			}

			canvas {
				display: block;
				width: 100vw;
				height: 100vh;
			}
		</style>
	</head>
	<body>
		<canvas id="scene" width="1280" height="720"></canvas>
		<script>
			const canvas = document.getElementById("scene");
			const context = canvas.getContext("2d");
			let frame = 0;

			function draw() {
				frame += 1;
				context.fillStyle = "#0b0f13";
				context.fillRect(0, 0, canvas.width, canvas.height);
				for (let index = 0; index < 64; index += 1) {
					const x = (frame * 9 + index * 47) % canvas.width;
					const y = (frame * 5 + index * 31) % canvas.height;
					context.fillStyle = "hsl(" + ((frame * 3 + index * 17) % 360) + " 90% 58%)";
					context.fillRect(x - 80, y - 32, 160, 64);
				}
				context.fillStyle = "#ffffff";
				context.font = "48px sans-serif";
				context.fillText("Cap extension recording E2E " + frame, 48, 96);
				requestAnimationFrame(draw);
			}

			draw();
		</script>
	</body>
</html>`;

const createMockCapServer = async () => {
	const state: MockState = {
		abortBodies: [],
		completeBodies: [],
		progressBodies: [],
		initiateBodies: [],
		presignBodies: [],
		uploadBytes: [],
		uploadBytesBySubpath: {},
		completedPartsBySubpath: {},
		uploadHeaders: [],
		videoId: `e2e-${Date.now()}`,
		simulateSlowCameraUpload: false,
		failCameraCompletion: false,
		failAudioCompletion: false,
		failScreenCompletion: false,
		cameraInitiateDelayMs: 0,
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (request.method === "OPTIONS") {
			sendJson(response, 204, {});
			return;
		}

		try {
			if (request.method === "GET" && url.pathname === "/capture.html") {
				sendHtml(response, animatedCapturePage());
				return;
			}

			if (
				request.method === "GET" &&
				url.pathname === "/api/extension/bootstrap"
			) {
				sendJson(response, 200, {
					user: {
						id: "user-e2e",
						email: "extension-e2e@cap.test",
					},
					organization: {
						id: "org-e2e",
						name: "Extension E2E",
					},
					plan: {
						isPro: true,
						maxRecordingSeconds: 600,
					},
				});
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/extension/instant-recordings"
			) {
				await parseJsonBody(request);
				sendJson(response, 200, {
					id: state.videoId,
					shareUrl: `${baseUrl()}/share/${state.videoId}`,
					upload: {
						type: "multipart",
					},
				});
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/upload/multipart/initiate"
			) {
				const body = await parseJsonBody(request);
				state.initiateBodies.push(body);
				if (
					state.cameraInitiateDelayMs > 0 &&
					body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "camera-upload.webm"
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, state.cameraInitiateDelayMs),
					);
				}
				sendJson(response, 200, {
					uploadId: `upload-e2e-${state.initiateBodies.length}`,
					provider: "s3",
				});
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/upload/multipart/abort"
			) {
				state.abortBodies.push(await parseJsonBody(request));
				sendJson(response, 200, { success: true });
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/upload/multipart/presign-part"
			) {
				const body = await parseJsonBody(request);
				state.presignBodies.push(body);
				const partNumber =
					body &&
					typeof body === "object" &&
					"partNumber" in body &&
					typeof body.partNumber === "number"
						? body.partNumber
						: state.presignBodies.length;
				sendJson(response, 200, {
					presignedUrl: `${baseUrl()}/mock-s3/part-${partNumber}?subpath=${encodeURIComponent(String(body && typeof body === "object" && "subpath" in body ? body.subpath : "unknown"))}`,
					provider: "s3",
				});
				return;
			}

			if (request.method === "PUT" && url.pathname.startsWith("/mock-s3/")) {
				const body = await readRequestBody(request);
				state.uploadBytes.push(body.byteLength);
				const subpath = url.searchParams.get("subpath") ?? "unknown";
				state.uploadBytesBySubpath[subpath] =
					(state.uploadBytesBySubpath[subpath] ?? 0) + body.byteLength;
				state.uploadHeaders.push(request.headers);
				if (
					state.simulateSlowCameraUpload &&
					subpath === "camera-upload.webm"
				) {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.ceil(body.byteLength / 1_250)),
					);
				}
				response.writeHead(200, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Expose-Headers": "ETag",
					ETag: `"etag-${state.uploadBytes.length}"`,
				});
				response.end();
				state.completedPartsBySubpath[subpath] =
					(state.completedPartsBySubpath[subpath] ?? 0) + 1;
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/upload/multipart/complete"
			) {
				const body = await parseJsonBody(request);
				state.completeBodies.push(body);
				if (
					state.failCameraCompletion &&
					!!body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "camera-upload.webm"
				) {
					sendJson(response, 400, { error: "Camera completion rejected" });
					return;
				}
				if (
					state.failAudioCompletion &&
					!!body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "mic-upload.webm"
				) {
					sendJson(response, 400, { error: "Microphone completion rejected" });
					return;
				}
				if (
					state.failScreenCompletion &&
					!!body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "raw-upload.webm"
				) {
					sendJson(response, 400, { error: "Screen completion rejected" });
					return;
				}
				sendJson(response, 200, {
					success: true,
					processingStarted:
						!!body &&
						typeof body === "object" &&
						"subpath" in body &&
						body.subpath === "raw-upload.webm",
				});
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/extension/instant-recordings/progress"
			) {
				state.progressBodies.push(await parseJsonBody(request));
				sendJson(response, 200, {
					success: true,
				});
				return;
			}

			if (
				request.method === "DELETE" &&
				url.pathname.startsWith("/api/extension/instant-recordings/")
			) {
				sendJson(response, 200, {
					success: true,
				});
				return;
			}

			sendJson(response, 404, {
				error: `Unhandled ${request.method} ${url.pathname}`,
			});
		} catch (error) {
			console.error("Mock server request failed", error);
			sendJson(response, 500, {
				error: "Mock server request failed",
			});
		}
	});

	let origin = "";
	const baseUrl = () => origin;

	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Mock server did not expose a TCP address"));
				return;
			}
			origin = `http://127.0.0.1:${address.port}`;
			resolve();
		});
	});

	return {
		origin,
		state,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
};

const launchExtensionContext = async () => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "cap-extension-e2e-"));
	const testExtensionPath = path.join(userDataDir, "extension");
	await cp(extensionPath, testExtensionPath, { recursive: true });
	const manifestPath = path.join(testExtensionPath, "manifest.json");
	const manifest: Record<string, unknown> = JSON.parse(
		await readFile(manifestPath, "utf8"),
	);
	manifest.commands = {
		_execute_action: {
			suggested_key: {
				default: "Ctrl+Shift+Y",
				mac: "Command+Shift+Y",
			},
		},
	};
	await writeFile(manifestPath, JSON.stringify(manifest));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: process.env.CAP_EXTENSION_E2E_HEADED !== "1",
		args: [
			`--disable-extensions-except=${testExtensionPath}`,
			`--load-extension=${testExtensionPath}`,
			"--allow-http-screen-capture",
			"--auto-select-desktop-capture-source=Cap E2E Capture Target",
			"--auto-select-tab-capture-source-by-title=Cap E2E Capture Target",
			"--enable-usermedia-screen-capturing",
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-device-for-media-stream",
			"--auto-accept-camera-and-microphone-capture",
		],
	});
	const cleanup = async () => {
		await context.close();
		await rm(userDataDir, { recursive: true, force: true });
	};

	return { context, cleanup };
};

const getServiceWorker = async (context: BrowserContext) => {
	const existing = context
		.serviceWorkers()
		.find((worker) => worker.url().includes("assets/service-worker.js"));
	if (existing) return existing;

	return context.waitForEvent("serviceworker", (worker) =>
		worker.url().includes("assets/service-worker.js"),
	);
};

const getExtensionId = (worker: Awaited<ReturnType<typeof getServiceWorker>>) =>
	new URL(worker.url()).host;

type DevToolsNode = {
	nodeId: number;
	attributes?: string[];
	children?: DevToolsNode[];
	shadowRoots?: DevToolsNode[];
};

const findCameraPreview = (node: DevToolsNode): DevToolsNode | null => {
	if (node.attributes?.includes("data-camera-preview")) return node;
	for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
		const result = findCameraPreview(child);
		if (result) return result;
	}
	return null;
};

const expectCameraPreviewOutOfCapture = async (page: Page) => {
	await expect(page.locator("#cap-extension-recorder-overlay")).toHaveAttribute(
		"data-cap-mounted",
		"true",
	);
	const session = await page.context().newCDPSession(page);
	try {
		await session.send("DOM.enable");
		await expect
			.poll(async () => {
				const document = (await session.send("DOM.getDocument", {
					depth: -1,
					pierce: true,
				})) as { root: DevToolsNode };
				const node = findCameraPreview(document.root);
				if (!node?.attributes) return true;
				const styleIndex = node.attributes.indexOf("style");
				if (styleIndex < 0) return false;
				return /visibility:\s*hidden/.test(node.attributes[styleIndex + 1]);
			})
			.toBe(true);
	} finally {
		await session.detach();
	}
};

const openExtensionMessengerPage = async (
	context: BrowserContext,
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${getExtensionId(worker)}/popup.html`);
	return page;
};

const configureExtension = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
	microphoneEnabled = false,
) => {
	await worker.evaluate(
		async ({
			authKey,
			bootstrapKey,
			recordingMode,
			settingsKey,
			apiBaseUrl,
			microphoneEnabled,
		}) => {
			const chromeApi = (globalThis as ChromeGlobal).chrome;
			await new Promise<void>((resolve, reject) => {
				chromeApi.storage.local.clear(() => {
					const error = chromeApi.runtime.lastError;
					if (error) {
						reject(new Error(error.message ?? "Failed to clear storage"));
						return;
					}
					resolve();
				});
			});
			await new Promise<void>((resolve, reject) => {
				chromeApi.storage.local.set(
					{
						[authKey]: {
							authApiKey: "auth-e2e",
							userId: "user-e2e",
						},
						[bootstrapKey]: {
							bootstrap: {
								user: {
									id: "user-e2e",
									email: "extension-e2e@cap.test",
								},
								organization: {
									id: "org-e2e",
									name: "Extension E2E",
								},
								plan: {
									isPro: true,
									maxRecordingSeconds: 600,
								},
							},
							cachedAt: Date.now(),
						},
						[settingsKey]: {
							apiBaseUrl,
							capture: {
								recordingMode,
								camera: null,
								microphone: null,
							},
							webcam: {
								enabled: true,
								deviceId: "__cap_default_camera__",
								position: "bottom-left",
								size: 230,
								shape: "round",
								mirror: false,
							},
							microphone: {
								enabled: microphoneEnabled,
								deviceId: null,
							},
							systemAudio: {
								enabled: false,
							},
							sounds: {
								enabled: false,
							},
							countdown: {
								enabled: false,
								seconds: 3,
							},
							microphoneWarning: {
								enabled: false,
							},
						},
					},
					() => {
						const error = chromeApi.runtime.lastError;
						if (error) {
							reject(new Error(error.message ?? "Failed to write storage"));
							return;
						}
						resolve();
					},
				);
			});
		},
		{
			apiBaseUrl,
			authKey: AUTH_KEY,
			bootstrapKey: BOOTSTRAP_CACHE_KEY,
			recordingMode: RECORDING_MODE,
			settingsKey: SETTINGS_KEY,
			microphoneEnabled,
		},
	);
};

const sendServiceWorkerMessage = async (
	page: Page,
	message: Record<string, unknown>,
) =>
	page.evaluate(async (message) => {
		const chromeApi = (globalThis as ChromeGlobal).chrome;
		return new Promise<ChromeRuntimeResponse>((resolve, reject) => {
			chromeApi.runtime.sendMessage(message, (response) => {
				const error = chromeApi.runtime.lastError;
				if (error) {
					reject(new Error(error.message ?? "Chrome runtime message failed"));
					return;
				}
				resolve(response as ChromeRuntimeResponse);
			});
		});
	}, message);

const expectSuccessfulUpload = async (page: Page, state: MockState) => {
	await expect
		.poll(async () => {
			const response = await sendServiceWorkerMessage(page, {
				target: "service-worker",
				type: "get-recording-status",
			});
			if (!response.ok) return response.error;
			return response.status?.phase;
		})
		.toBe("completed");

	expect(state.initiateBodies).toHaveLength(2);
	expect(state.initiateBodies[0]).toMatchObject({ subpath: "raw-upload.webm" });
	expect(state.initiateBodies[1]).toMatchObject({
		subpath: "camera-upload.webm",
	});
	expect(state.presignBodies.length).toBeGreaterThanOrEqual(1);
	expect(state.uploadBytes.length).toBeGreaterThanOrEqual(1);
	expect(
		state.uploadBytes.reduce((total, bytes) => total + bytes, 0),
	).toBeGreaterThan(0);
	expect(state.completeBodies).toHaveLength(2);
	expect(state.progressBodies.length).toBeGreaterThanOrEqual(1);

	const completeBody = state.completeBodies[0];
	expect(completeBody).toMatchObject({
		videoId: state.videoId,
		uploadId: "upload-e2e-2",
		subpath: "camera-upload.webm",
		screenSubpath: "raw-upload.webm",
	});
	expect(
		completeBody &&
			typeof completeBody === "object" &&
			"parts" in completeBody &&
			Array.isArray(completeBody.parts)
			? completeBody.parts.length
			: 0,
	).toBeGreaterThanOrEqual(1);
	const cameraOffsetMs =
		completeBody &&
		typeof completeBody === "object" &&
		"cameraOffsetMs" in completeBody
			? completeBody.cameraOffsetMs
			: null;
	expect(
		typeof cameraOffsetMs === "number" && Number.isFinite(cameraOffsetMs),
	).toBe(true);
	expect(state.completeBodies[1]).toMatchObject({
		subpath: "raw-upload.webm",
		uploadId: "upload-e2e-1",
	});
	expect(state.uploadBytesBySubpath["camera-upload.webm"]).toBeGreaterThan(0);
	expect(state.uploadBytesBySubpath["raw-upload.webm"]).toBeGreaterThan(0);
};

const readLiveCameraOffset = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(async () => {
		const key = "cap-extension-live-recordings";
		const items = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get([key], (result) => resolve(result)),
		);
		const manifests = items[key];
		if (!Array.isArray(manifests)) {
			throw new Error(`Live manifest storage is ${typeof manifests}`);
		}
		const offset = (manifests[0] as { cameraOffsetMs?: unknown } | undefined)
			?.cameraOffsetMs;
		if (typeof offset !== "number") {
			throw new Error(
				`Live manifests: ${manifests.length}; first camera offset: ${typeof offset}`,
			);
		}
		return offset;
	});

const readLiveMicrophoneOffset = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(async () => {
		const key = "cap-extension-live-recordings";
		const items = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get([key], (result) => resolve(result)),
		);
		const manifests = items[key];
		const sources = Array.isArray(manifests)
			? (
					manifests[0] as {
						audioSources?: Array<{ kind: string; offsetMs: number }>;
					}
				)?.audioSources
			: undefined;
		const offset = sources?.find((source) => source.kind === "mic")?.offsetMs;
		if (typeof offset !== "number") {
			throw new Error("The live microphone offset is unavailable");
		}
		return offset;
	});

const readLiveCameraSessionId = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(async () => {
		const key = "cap-extension-live-recordings";
		const items = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get([key], (result) => resolve(result)),
		);
		const manifests = items[key];
		const sessionId = Array.isArray(manifests)
			? (manifests[0] as { cameraSessionId?: unknown } | undefined)
					?.cameraSessionId
			: null;
		if (typeof sessionId !== "string") {
			throw new Error("The live camera spool session is unavailable");
		}
		return sessionId;
	});

const deleteCameraSpoolSession = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	sessionId: string,
) =>
	worker.evaluate(async (sessionId) => {
		const request = indexedDB.open("cap-recording-spool", 1);
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const read = database.transaction("chunks", "readonly");
		const keysRequest = read
			.objectStore("chunks")
			.index("by-session")
			.getAllKeys(IDBKeyRange.only(sessionId));
		const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
			keysRequest.onsuccess = () => resolve(keysRequest.result);
			keysRequest.onerror = () => reject(keysRequest.error);
		});
		const write = database.transaction(["sessions", "chunks"], "readwrite");
		const finished = new Promise<void>((resolve, reject) => {
			write.oncomplete = () => resolve();
			write.onerror = () => reject(write.error);
			write.onabort = () => reject(write.error);
		});
		write.objectStore("sessions").delete(sessionId);
		const chunks = write.objectStore("chunks");
		for (const key of keys) chunks.delete(key);
		await finished;
		database.close();
	}, sessionId);

const readFailedCameraRecovery = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(async () => {
		const key = "cap-extension-failed-recordings";
		const items = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get([key], (result) => resolve(result)),
		);
		const recordings = items[key];
		if (!Array.isArray(recordings)) return null;
		const failed = recordings[0] as
			| {
					videoId?: unknown;
					cameraSessionId?: unknown;
					cameraSubpath?: unknown;
					cameraOffsetMs?: unknown;
					cameraRetryUnavailable?: unknown;
			  }
			| undefined;
		return failed
			? {
					videoId: failed.videoId,
					cameraSessionId: failed.cameraSessionId,
					cameraSubpath: failed.cameraSubpath,
					cameraOffsetMs: failed.cameraOffsetMs,
					cameraRetryUnavailable: failed.cameraRetryUnavailable,
				}
			: null;
	});

const hasLiveRecordingManifest = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(async () => {
		const key = "cap-extension-live-recordings";
		const items = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get([key], (result) => resolve(result)),
		);
		return Array.isArray(items[key]) && items[key].length > 0;
	});

const startRecording = async (
	context: BrowserContext,
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
	mode: "fullscreen" | "tab" = RECORDING_MODE,
	recordingMs = RECORDING_MS,
	microphoneEnabled = false,
) => {
	await configureExtension(worker, apiBaseUrl, microphoneEnabled);
	const messengerPage = await openExtensionMessengerPage(context, worker);
	const capturePage = await context.newPage();
	await capturePage.goto(`${apiBaseUrl}/capture.html`);
	await capturePage.bringToFront();
	await expect
		.poll(async () => {
			const tabs = await worker.evaluate(() =>
				chrome.tabs.query({ active: true, lastFocusedWindow: true }),
			);
			return tabs[0]?.url;
		})
		.toBe(`${apiBaseUrl}/capture.html`);
	if (mode === "tab") {
		await worker.evaluate(() => {
			const target = globalThis as typeof globalThis & {
				capE2eActionClicks?: number;
			};
			target.capE2eActionClicks = 0;
			chrome.action.onClicked.addListener(() => {
				target.capE2eActionClicks = (target.capE2eActionClicks ?? 0) + 1;
			});
		});
	}
	if (mode === "tab") {
		await expect
			.poll(
				() =>
					worker.evaluate(
						() =>
							(
								globalThis as typeof globalThis & {
									capE2eActionClicks?: number;
								}
							).capE2eActionClicks ?? 0,
					),
				{
					message:
						"Click the Cap extension action icon in the test Chromium window",
					timeout: 60_000,
				},
			)
			.toBeGreaterThan(0);
	}

	const startResponse = await sendServiceWorkerMessage(messengerPage, {
		target: "service-worker",
		type: "start-recording",
		mode,
	});
	if (!startResponse.ok) {
		const captures = await worker.evaluate(
			() =>
				new Promise<chrome.tabCapture.CaptureInfo[]>((resolve) =>
					chrome.tabCapture.getCapturedTabs(resolve),
				),
		);
		throw new Error(
			`${startResponse.error}; captured tabs: ${JSON.stringify(captures)}`,
		);
	}

	await expect
		.poll(async () => {
			const response = await sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				type: "get-recording-status",
			});
			if (!response.ok) return response.error;
			return response.status?.phase;
		})
		.toBe("recording");

	await capturePage.waitForTimeout(recordingMs);
	return {
		capturePage,
		messengerPage,
	};
};

test.describe("extension recording upload", () => {
	let mockServer: Awaited<ReturnType<typeof createMockCapServer>> | null = null;
	let extension: Awaited<ReturnType<typeof launchExtensionContext>> | null =
		null;

	test.beforeEach(async () => {
		mockServer = await createMockCapServer();
		extension = await launchExtensionContext();
	});

	test.afterEach(async () => {
		await extension?.cleanup();
		await mockServer?.close();
	});

	test("records a separate camera sidecar and hides its page overlay during display capture", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const { capturePage, messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
		);
		await expectCameraPreviewOutOfCapture(capturePage);
		const persistedCameraOffsetMs = await readLiveCameraOffset(worker);
		expect(typeof persistedCameraOffsetMs).toBe("number");

		expect(mockServer.state.initiateBodies).toHaveLength(2);
		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });

		await expectSuccessfulUpload(messengerPage, mockServer.state);
		expect(mockServer.state.completeBodies[0]).toMatchObject({
			cameraOffsetMs: persistedCameraOffsetMs,
		});
	});

	test("uploads microphone audio independently of screen and camera in Chromium", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"fullscreen",
			RECORDING_MS,
			true,
		);
		const persistedAudioOffsetMs = await readLiveMicrophoneOffset(worker);
		expect(mockServer.state.initiateBodies).toHaveLength(3);
		expect(mockServer.state.initiateBodies).toContainEqual(
			expect.objectContaining({
				subpath: "mic-upload.webm",
				contentType: "audio/webm",
			}),
		);

		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("completed");
		expect(mockServer.state.completeBodies).toHaveLength(3);
		const audioCompletion = mockServer.state.completeBodies.find(
			(body) =>
				!!body &&
				typeof body === "object" &&
				"subpath" in body &&
				body.subpath === "mic-upload.webm",
		);
		expect(audioCompletion).toMatchObject({
			videoId: mockServer.state.videoId,
			subpath: "mic-upload.webm",
			screenSubpath: "raw-upload.webm",
			audioOffsetMs: persistedAudioOffsetMs,
		});
		expect(
			mockServer.state.uploadBytesBySubpath["mic-upload.webm"],
		).toBeGreaterThan(0);
		expect(
			mockServer.state.uploadBytesBySubpath["camera-upload.webm"],
		).toBeGreaterThan(0);
		expect(
			mockServer.state.uploadBytesBySubpath["raw-upload.webm"],
		).toBeGreaterThan(0);
	});

	test("keeps the microphone spool downloadable and retries all sources after audio upload failure", async () => {
		test.setTimeout(120_000);
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.failAudioCompletion = true;
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"fullscreen",
			RECORDING_MS,
			true,
		);
		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("error");

		const uploadPage = await extension.context.newPage();
		await uploadPage.goto(
			`chrome-extension://${getExtensionId(worker)}/uploading.html?videoId=${mockServer.state.videoId}`,
		);
		await expect(
			uploadPage.getByRole("button", { name: "Download microphone" }),
		).toBeVisible();
		const micDownload = uploadPage.waitForEvent("download");
		await uploadPage
			.getByRole("button", { name: "Download microphone" })
			.click();
		expect((await micDownload).suggestedFilename()).toContain("-mic.webm");
		const screenDownload = uploadPage.waitForEvent("download");
		await uploadPage.getByRole("button", { name: "Download screen" }).click();
		expect((await screenDownload).suggestedFilename()).toContain(
			"-screen.webm",
		);

		mockServer.state.failAudioCompletion = false;
		const retryResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "retry-upload",
			videoId: mockServer.state.videoId,
		});
		expect(retryResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("completed");
		expect(
			mockServer.state.completeBodies.filter(
				(body) =>
					!!body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "mic-upload.webm",
			),
		).toHaveLength(2);
	});

	test("keeps uploaded microphone audio downloadable when screen completion fails", async () => {
		test.setTimeout(120_000);
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.failScreenCompletion = true;
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"fullscreen",
			RECORDING_MS,
			true,
		);
		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("error");
		expect(mockServer.state.completeBodies).toContainEqual(
			expect.objectContaining({ subpath: "mic-upload.webm" }),
		);
		const uploadPage = await extension.context.newPage();
		await uploadPage.goto(
			`chrome-extension://${getExtensionId(worker)}/uploading.html?videoId=${mockServer.state.videoId}`,
		);
		const downloadButton = uploadPage.getByRole("button", {
			name: "Download microphone",
		});
		await expect(downloadButton).toBeVisible();
		const micDownload = uploadPage.waitForEvent("download");
		await downloadButton.click();
		expect((await micDownload).suggestedFilename()).toContain("-mic.webm");

		mockServer.state.failScreenCompletion = false;
		const retryResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "retry-upload",
			videoId: mockServer.state.videoId,
		});
		expect(retryResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("completed");
		expect(
			mockServer.state.completeBodies.filter(
				(body) =>
					!!body &&
					typeof body === "object" &&
					"subpath" in body &&
					body.subpath === "mic-upload.webm",
			),
		).toHaveLength(2);
	});

	test("uploads a camera multipart part during a long recording on a constrained network", async () => {
		test.setTimeout(180_000);
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.simulateSlowCameraUpload = true;
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"fullscreen",
			0,
		);
		const persistedCameraOffsetMs = await readLiveCameraOffset(worker);
		expect(mockServer.state.initiateBodies).toHaveLength(2);
		await expect
			.poll(
				() =>
					mockServer?.state.completedPartsBySubpath["camera-upload.webm"] ?? 0,
				{ timeout: 120_000 },
			)
			.toBeGreaterThan(0);
		expect(
			mockServer.state.uploadBytesBySubpath["camera-upload.webm"],
		).toBeGreaterThanOrEqual(5 * 1024 * 1024);

		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expectSuccessfulUpload(messengerPage, mockServer.state);
		expect(mockServer.state.completeBodies[0]).toMatchObject({
			cameraOffsetMs: persistedCameraOffsetMs,
		});
	});

	test("offers separate clip downloads after a camera upload failure", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.failCameraCompletion = true;
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
		);
		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("error");
		await expect
			.poll(() => readFailedCameraRecovery(worker))
			.toMatchObject({ videoId: mockServer.state.videoId });
		const uploadPage = await extension.context.newPage();
		await uploadPage.goto(
			`chrome-extension://${getExtensionId(worker)}/uploading.html?videoId=${mockServer.state.videoId}`,
		);
		await expect(
			uploadPage.getByRole("button", { name: "Try again" }),
		).toBeVisible();
		const screenDownload = uploadPage.waitForEvent("download");
		await uploadPage.getByRole("button", { name: "Download screen" }).click();
		expect((await screenDownload).suggestedFilename()).toContain(
			"-screen.webm",
		);
		const cameraDownload = uploadPage.waitForEvent("download");
		await uploadPage.getByRole("button", { name: "Download camera" }).click();
		expect((await cameraDownload).suggestedFilename()).toContain(
			"-camera.webm",
		);
		await worker.evaluate(async () => {
			const key = "cap-extension-failed-recordings";
			const data = await new Promise<Record<string, unknown>>((resolve) =>
				chrome.storage.local.get([key], (items) => resolve(items)),
			);
			const recordings = data[key];
			if (!Array.isArray(recordings) || !recordings[0]) {
				throw new Error("The failed paired recording is unavailable");
			}
			const failed = { ...(recordings[0] as Record<string, unknown>) };
			delete failed.cameraSessionId;
			failed.cameraRetryUnavailable = true;
			await new Promise<void>((resolve) =>
				chrome.storage.local.set({ [key]: [failed] }, () => resolve()),
			);
		});
		await uploadPage.reload();
		await expect(
			uploadPage.getByRole("button", { name: "Try again" }),
		).toHaveCount(0);
		await expect(
			uploadPage.getByRole("button", { name: "Download camera" }),
		).toHaveCount(0);
		await expect(
			uploadPage.getByRole("button", { name: "Download screen" }),
		).toBeVisible();
		expect(mockServer.state.completeBodies).toEqual([
			expect.objectContaining({ subpath: "camera-upload.webm" }),
		]);
	});

	test("recovers camera, microphone and screen spools after the offscreen recorder closes", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"fullscreen",
			RECORDING_MS,
			true,
		);
		const persistedCameraOffsetMs = await readLiveCameraOffset(worker);
		const persistedAudioOffsetMs = await readLiveMicrophoneOffset(worker);
		await worker.evaluate(() => chrome.offscreen.closeDocument());

		const refreshResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-media-devices",
		});
		expect(refreshResponse).toMatchObject({ ok: true });
		await expect
			.poll(() => readFailedCameraRecovery(worker))
			.toMatchObject({
				videoId: mockServer.state.videoId,
				cameraSubpath: "camera-upload.webm",
				cameraOffsetMs: persistedCameraOffsetMs,
			});
		const optionsPage = await extension.context.newPage();
		await optionsPage.addInitScript(() => {
			const target = globalThis as typeof globalThis & {
				capE2eChunkReads?: number;
			};
			target.capE2eChunkReads = 0;
			const originalGetAll = IDBIndex.prototype.getAll;
			IDBIndex.prototype.getAll = function (
				...args: Parameters<typeof originalGetAll>
			) {
				if (this.name === "by-session") {
					target.capE2eChunkReads = (target.capE2eChunkReads ?? 0) + 1;
				}
				return originalGetAll.apply(this, args);
			};
		});
		await optionsPage.goto(
			`chrome-extension://${getExtensionId(worker)}/options.html`,
		);
		await expect(optionsPage.locator(".recovery-item")).toHaveCount(1);
		expect(
			await optionsPage.evaluate(
				() =>
					(globalThis as typeof globalThis & { capE2eChunkReads?: number })
						.capE2eChunkReads ?? 0,
			),
		).toBe(0);
		const screenDownload = optionsPage.waitForEvent("download");
		await optionsPage.getByRole("button", { name: "Download screen" }).click();
		expect((await screenDownload).suggestedFilename()).toContain(
			"-screen.webm",
		);
		const cameraDownload = optionsPage.waitForEvent("download");
		await optionsPage.getByRole("button", { name: "Download camera" }).click();
		expect((await cameraDownload).suggestedFilename()).toContain(
			"-camera.webm",
		);
		const micDownload = optionsPage.waitForEvent("download");
		await optionsPage
			.getByRole("button", { name: "Download microphone" })
			.click();
		expect((await micDownload).suggestedFilename()).toContain("-mic.webm");
		expect(
			await optionsPage.evaluate(
				() =>
					(globalThis as typeof globalThis & { capE2eChunkReads?: number })
						.capE2eChunkReads ?? 0,
			),
		).toBeGreaterThanOrEqual(3);

		const retryResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "retry-upload",
			videoId: mockServer.state.videoId,
		});
		expect(retryResponse).toMatchObject({ ok: true });
		await expect
			.poll(async () => {
				const response = await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				});
				return response.ok ? response.status?.phase : response.error;
			})
			.toBe("completed");
		expect(mockServer.state.completeBodies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subpath: "camera-upload.webm",
					cameraOffsetMs: persistedCameraOffsetMs,
				}),
				expect.objectContaining({
					subpath: "mic-upload.webm",
					audioOffsetMs: persistedAudioOffsetMs,
				}),
				expect.objectContaining({ subpath: "raw-upload.webm" }),
			]),
		);
		expect(
			mockServer.state.uploadBytesBySubpath["camera-upload.webm"],
		).toBeGreaterThan(0);
		expect(
			mockServer.state.uploadBytesBySubpath["mic-upload.webm"],
		).toBeGreaterThan(0);
		expect(
			mockServer.state.uploadBytesBySubpath["raw-upload.webm"],
		).toBeGreaterThan(0);
		expect(await readFailedCameraRecovery(worker)).toBeNull();
		expect(await hasLiveRecordingManifest(worker)).toBe(false);
	});

	test("never retries a screen-only upload after a crash loses the camera spool", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
		);
		const cameraSessionId = await readLiveCameraSessionId(worker);
		await worker.evaluate(() => chrome.offscreen.closeDocument());
		await deleteCameraSpoolSession(worker, cameraSessionId);
		const refreshResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-media-devices",
		});
		expect(refreshResponse).toMatchObject({ ok: true });
		await expect
			.poll(() => readFailedCameraRecovery(worker))
			.toMatchObject({
				videoId: mockServer.state.videoId,
				cameraRetryUnavailable: true,
			});
		const optionsPage = await extension.context.newPage();
		await optionsPage.goto(
			`chrome-extension://${getExtensionId(worker)}/options.html`,
		);
		await expect(optionsPage.locator(".recovery-item")).toHaveCount(1);
		await expect(
			optionsPage.getByRole("button", { name: "Retry upload" }),
		).toHaveCount(0);
		await expect(
			optionsPage.getByRole("button", { name: "Download screen" }),
		).toBeVisible();
		const retryResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "retry-upload",
			videoId: mockServer.state.videoId,
		});
		expect(retryResponse).toMatchObject({
			ok: false,
			error: expect.stringContaining(
				"camera recording is unavailable to retry",
			),
		});
		expect(mockServer.state.completeBodies).toHaveLength(0);
	});

	test("aborts both multipart sessions when Stop cancels camera upload setup", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.cameraInitiateDelayMs = 1_500;
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin);
		const startPage = await openExtensionMessengerPage(
			extension.context,
			worker,
		);
		const stopPage = await openExtensionMessengerPage(
			extension.context,
			worker,
		);
		const capturePage = await extension.context.newPage();
		await capturePage.goto(`${mockServer.origin}/capture.html`);
		await capturePage.bringToFront();
		const startPromise = sendServiceWorkerMessage(startPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		});
		await expect.poll(() => mockServer?.state.initiateBodies.length).toBe(2);
		const stopResponse = await sendServiceWorkerMessage(stopPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		const startResponse = await startPromise;
		expect(startResponse).toMatchObject({ ok: false });
		expect(mockServer.state.abortBodies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ subpath: "raw-upload.webm" }),
				expect.objectContaining({ subpath: "camera-upload.webm" }),
			]),
		);
		expect(mockServer.state.completeBodies).toHaveLength(0);
	});

	test("keeps camera sidecar separate in current-tab capture", async () => {
		test.skip(
			process.env.CAP_EXTENSION_E2E_HEADED !== "1" ||
				process.env.CAP_EXTENSION_E2E_NATIVE_GESTURE !== "1" ||
				process.platform !== "darwin",
			"Headed current-tab capture needs a manual Cap action click in the isolated test Chromium profile",
		);
		test.setTimeout(120_000);
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const { capturePage, messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			"tab",
		);
		await expectCameraPreviewOutOfCapture(capturePage);
		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expectSuccessfulUpload(messengerPage, mockServer.state);
	});

	test("can complete two consecutive recording uploads without stale state", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const worker = await getServiceWorker(extension.context);
		const firstRecording = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
		);
		const firstStopResponse = await sendServiceWorkerMessage(
			firstRecording.messengerPage,
			{
				target: "service-worker",
				type: "stop-recording",
			},
		);
		expect(firstStopResponse).toMatchObject({ ok: true });
		await expectSuccessfulUpload(
			firstRecording.messengerPage,
			mockServer.state,
		);

		await firstRecording.capturePage.close();
		await firstRecording.messengerPage.close();

		mockServer.state.completeBodies = [];
		mockServer.state.progressBodies = [];
		mockServer.state.initiateBodies = [];
		mockServer.state.presignBodies = [];
		mockServer.state.uploadBytes = [];
		mockServer.state.uploadBytesBySubpath = {};
		mockServer.state.completedPartsBySubpath = {};
		mockServer.state.uploadHeaders = [];
		mockServer.state.videoId = `e2e-${Date.now()}-second`;

		const secondRecording = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
		);
		const secondStopResponse = await sendServiceWorkerMessage(
			secondRecording.messengerPage,
			{
				target: "service-worker",
				type: "stop-recording",
			},
		);
		expect(secondStopResponse).toMatchObject({ ok: true });
		await expectSuccessfulUpload(
			secondRecording.messengerPage,
			mockServer.state,
		);
	});
});
