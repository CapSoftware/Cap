import { mkdtemp, rm } from "node:fs/promises";
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
	completeBodies: unknown[];
	progressBodies: unknown[];
	initiateBodies: unknown[];
	presignBodies: unknown[];
	uploadBytes: number[];
	uploadHeaders: Record<string, string | string[] | undefined>[];
	videoId: string;
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
const extensionPath = path.resolve(__dirname, "../dist");
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
		completeBodies: [],
		progressBodies: [],
		initiateBodies: [],
		presignBodies: [],
		uploadBytes: [],
		uploadHeaders: [],
		videoId: `e2e-${Date.now()}`,
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
				state.initiateBodies.push(await parseJsonBody(request));
				sendJson(response, 200, {
					uploadId: "upload-e2e",
					provider: "s3",
				});
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
					presignedUrl: `${baseUrl()}/mock-s3/part-${partNumber}`,
					provider: "s3",
				});
				return;
			}

			if (request.method === "PUT" && url.pathname.startsWith("/mock-s3/")) {
				const body = await readRequestBody(request);
				state.uploadBytes.push(body.byteLength);
				state.uploadHeaders.push(request.headers);
				response.writeHead(200, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Expose-Headers": "ETag",
					ETag: `"etag-${state.uploadBytes.length}"`,
				});
				response.end();
				return;
			}

			if (
				request.method === "POST" &&
				url.pathname === "/api/upload/multipart/complete"
			) {
				state.completeBodies.push(await parseJsonBody(request));
				sendJson(response, 200, {
					success: true,
					processingStarted: true,
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
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			"--allow-http-screen-capture",
			"--auto-select-desktop-capture-source=Cap E2E Capture Target",
			"--auto-select-tab-capture-source-by-title=Cap E2E Capture Target",
			"--enable-usermedia-screen-capturing",
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
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
) => {
	await worker.evaluate(
		async ({
			authKey,
			bootstrapKey,
			recordingMode,
			settingsKey,
			apiBaseUrl,
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
								enabled: false,
								deviceId: null,
								position: "bottom-left",
								size: 230,
								shape: "round",
								mirror: false,
							},
							microphone: {
								enabled: false,
								deviceId: null,
							},
							systemAudio: {
								enabled: false,
							},
							sounds: {
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

	expect(state.initiateBodies).toHaveLength(1);
	expect(state.presignBodies.length).toBeGreaterThanOrEqual(1);
	expect(state.uploadBytes.length).toBeGreaterThanOrEqual(1);
	expect(
		state.uploadBytes.reduce((total, bytes) => total + bytes, 0),
	).toBeGreaterThan(0);
	expect(state.completeBodies).toHaveLength(1);
	expect(state.progressBodies.length).toBeGreaterThanOrEqual(1);

	const completeBody = state.completeBodies[0];
	expect(completeBody).toMatchObject({
		videoId: state.videoId,
		uploadId: "upload-e2e",
		subpath: "raw-upload.webm",
	});
	expect(
		completeBody &&
			typeof completeBody === "object" &&
			"parts" in completeBody &&
			Array.isArray(completeBody.parts)
			? completeBody.parts.length
			: 0,
	).toBeGreaterThanOrEqual(1);
};

const startRecording = async (
	context: BrowserContext,
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
) => {
	await configureExtension(worker, apiBaseUrl);
	const messengerPage = await openExtensionMessengerPage(context, worker);
	const capturePage = await context.newPage();
	await capturePage.goto(`${apiBaseUrl}/capture.html`);
	await capturePage.bringToFront();

	const startResponse = await sendServiceWorkerMessage(messengerPage, {
		target: "service-worker",
		type: "start-recording",
		mode: RECORDING_MODE,
	});
	if (!startResponse.ok) {
		throw new Error(startResponse.error);
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

	await capturePage.waitForTimeout(RECORDING_MS);
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

	test("records the selected display surface, uploads non-empty multipart data, and completes", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
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
