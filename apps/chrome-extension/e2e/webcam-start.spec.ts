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

const readRequestBody = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
};

const sendJson = (
	response: ServerResponse,
	status: number,
	body: Record<string, unknown>,
) => {
	response.writeHead(status, {
		"Access-Control-Allow-Headers":
			"Authorization, Content-Type, Content-Range",
		"Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, POST, PUT",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "ETag",
		"Content-Type": "application/json",
	});
	response.end(JSON.stringify(body));
};

const capturePage = () => `<!doctype html>
<html>
	<head><title>Cap Repro Capture Target</title></head>
	<body style="background:#123; color:#fff"><h1>Repro page</h1></body>
</html>`;

const createMockCapServer = async () => {
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push(`${request.method} ${url.pathname}`);

		if (request.method === "OPTIONS") {
			sendJson(response, 204, {});
			return;
		}
		if (request.method === "GET" && url.pathname === "/capture.html") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(capturePage());
			return;
		}
		if (
			request.method === "GET" &&
			url.pathname === "/api/extension/bootstrap"
		) {
			sendJson(response, 200, {
				user: { id: "user-e2e", email: "e2e@cap.test" },
				organization: { id: "org-e2e", name: "E2E" },
				plan: { isPro: true, maxRecordingSeconds: 600 },
			});
			return;
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/extension/instant-recordings"
		) {
			await readRequestBody(request);
			sendJson(response, 200, {
				id: "video-repro",
				shareUrl: `${origin}/share/video-repro`,
				upload: { type: "multipart" },
			});
			return;
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/upload/multipart/initiate"
		) {
			await readRequestBody(request);
			sendJson(response, 200, { uploadId: "upload-repro", provider: "s3" });
			return;
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/upload/multipart/presign-part"
		) {
			await readRequestBody(request);
			sendJson(response, 200, {
				presignedUrl: `${origin}/mock-s3/part`,
				provider: "s3",
			});
			return;
		}
		if (request.method === "PUT" && url.pathname.startsWith("/mock-s3/")) {
			await readRequestBody(request);
			response.writeHead(200, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Expose-Headers": "ETag",
				ETag: '"etag-repro"',
			});
			response.end();
			return;
		}
		await readRequestBody(request).catch(() => undefined);
		sendJson(response, 200, { success: true, processingStarted: true });
	});

	let origin = "";
	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("no address"));
				return;
			}
			origin = `http://127.0.0.1:${address.port}`;
			resolve();
		});
	});

	return {
		origin,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const launchExtensionContext = async () => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "cap-repro-e2e-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			"--allow-http-screen-capture",
			"--auto-select-tab-capture-source-by-title=Cap Repro Capture Target",
			"--auto-select-desktop-capture-source=Cap Repro Capture Target",
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

const configureExtension = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
) => {
	await worker.evaluate(
		async ({ authKey, bootstrapKey, settingsKey, apiBaseUrl }) => {
			const chromeApi = (globalThis as ChromeGlobal).chrome;
			await new Promise<void>((resolve) =>
				chromeApi.storage.local.clear(() => resolve()),
			);
			await new Promise<void>((resolve) =>
				chromeApi.storage.local.set(
					{
						[authKey]: { authApiKey: "auth-e2e", userId: "user-e2e" },
						[bootstrapKey]: {
							bootstrap: {
								user: { id: "user-e2e", email: "e2e@cap.test" },
								organization: { id: "org-e2e", name: "E2E" },
								plan: { isPro: true, maxRecordingSeconds: 600 },
							},
							cachedAt: Date.now(),
						},
						[settingsKey]: {
							apiBaseUrl,
							capture: {
								recordingMode: "fullscreen",
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
							microphone: { enabled: false, deviceId: null },
							systemAudio: { enabled: false },
							sounds: { enabled: false },
							countdown: { enabled: false, seconds: 3 },
							microphoneWarning: { enabled: false },
						},
					},
					() => resolve(),
				),
			);
		},
		{
			apiBaseUrl,
			authKey: AUTH_KEY,
			bootstrapKey: BOOTSTRAP_CACHE_KEY,
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
		return new Promise<unknown>((resolve, reject) => {
			chromeApi.runtime.sendMessage(message, (response) => {
				const error = chromeApi.runtime.lastError;
				if (error) {
					reject(new Error(error.message ?? "Chrome runtime message failed"));
					return;
				}
				resolve(response);
			});
		});
	}, message);

test("repro: start recording with webcam preview enabled and live", async () => {
	test.setTimeout(120_000);
	const mockServer = await createMockCapServer();
	const extension = await launchExtensionContext();
	const logs: string[] = [];

	try {
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin);

		const messengerPage = await extension.context.newPage();
		await messengerPage.goto(
			`chrome-extension://${new URL(worker.url()).host}/popup.html`,
		);

		const targetPage = await extension.context.newPage();
		targetPage.on("console", (message) => {
			logs.push(`[capture-page ${message.type()}] ${message.text()}`);
		});
		await targetPage.goto(`${mockServer.origin}/capture.html`);
		await targetPage.bringToFront();

		// Simulate opening the recorder: this shows the camera preview overlay
		// in the active tab (same as openRecorderPanel does).
		const bootstrapResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "bootstrap",
		});
		logs.push(`bootstrap: ${JSON.stringify(bootstrapResponse).slice(0, 200)}`);

		// Give the camera preview time to go live (frames flowing over WebRTC).
		await targetPage.waitForTimeout(6_000);
		await targetPage.screenshot({
			path: "test-results/repro-before-start.png",
		});

		const startedAt = Date.now();
		const startResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		}).catch((error: unknown) => ({
			ok: false,
			error: `sendMessage rejected: ${error instanceof Error ? error.message : String(error)}`,
		}));
		logs.push(
			`start-recording after ${Date.now() - startedAt}ms: ${JSON.stringify(startResponse)}`,
		);

		// Poll the status for a while to watch transitions.
		for (let index = 0; index < 20; index += 1) {
			const statusResponse = (await sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				type: "get-recording-status",
			}).catch(() => null)) as { status?: { phase?: string } } | null;
			logs.push(
				`status t+${index * 500}ms: ${JSON.stringify(statusResponse?.status)}`,
			);
			if (statusResponse?.status?.phase === "recording") break;
			await messengerPage.waitForTimeout(500);
		}

		await targetPage.screenshot({ path: "test-results/repro-after-start.png" });
		logs.push(`api requests: ${JSON.stringify(mockServer.requests)}`);

		const finalStatus = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-recording-status",
		})) as { status?: { phase?: string } };
		expect(finalStatus.status?.phase).toBe("recording");

		// Content scripts read chrome.storage.session; without the service
		// worker widening the access level every call fails with this error.
		const storageErrors = logs.filter((line) =>
			line.includes("Access to storage is not allowed"),
		);
		expect(storageErrors).toHaveLength(0);
	} catch (error) {
		console.log(
			`\n===== REPRO LOG =====\n${logs.join("\n")}\n=====================`,
		);
		throw error;
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});
