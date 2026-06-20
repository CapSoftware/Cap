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
		tabs: {
			query(
				queryInfo: Record<string, unknown>,
				callback: (tabs: Array<{ id?: number; url?: string }>) => void,
			): void;
			sendMessage(
				tabId: number,
				message: unknown,
				callback?: (response: unknown) => void,
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

const createMockCapServer = async (
	options: { failInstantRecordings?: boolean } = {},
) => {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "OPTIONS") {
			sendJson(response, 204, {});
			return;
		}
		if (request.method === "GET" && url.pathname === "/capture.html") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(
				`<!doctype html><html><head><title>Cap Close UI Target</title></head><body style="background:#321"><h1>Close UI page</h1></body></html>`,
			);
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
			if (options.failInstantRecordings) {
				sendJson(response, 500, { error: "mock instant recording failure" });
				return;
			}
			sendJson(response, 200, {
				id: "video-close-ui",
				shareUrl: `${origin}/share/video-close-ui`,
				upload: { type: "multipart" },
			});
			return;
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/upload/multipart/initiate"
		) {
			await readRequestBody(request);
			sendJson(response, 200, { uploadId: "upload-close", provider: "s3" });
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
				ETag: '"etag-close"',
			});
			response.end();
			return;
		}
		await readRequestBody(request).catch(() => undefined);
		sendJson(response, 200, { success: true });
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
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const launchExtensionContext = async () => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "cap-close-e2e-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			"--allow-http-screen-capture",
			"--auto-select-tab-capture-source-by-title=Cap Close UI Target",
			"--auto-select-desktop-capture-source=Cap Close UI Target",
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

const togglePanelInTab = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	urlFragment: string,
) =>
	worker.evaluate(async (urlFragment) => {
		const chromeApi = (globalThis as ChromeGlobal).chrome;
		const tabs = await new Promise<Array<{ id?: number; url?: string }>>(
			(resolve) => chromeApi.tabs.query({}, resolve),
		);
		const tab = tabs.find((tab) => tab.url?.includes(urlFragment));
		if (tab?.id === undefined) throw new Error("capture tab not found");
		await new Promise<void>((resolve) => {
			chromeApi.tabs.sendMessage(tab.id as number, {
				type: "overlay-panel-toggle",
			});
			resolve();
		});
	}, urlFragment);

const frameWithUrl = (page: Page, fragment: string) =>
	page.frames().find((frame) => frame.url().includes(fragment)) ?? null;

test("clicking X in the panel closes the panel and the camera preview", async () => {
	test.setTimeout(120_000);
	const mockServer = await createMockCapServer();
	const extension = await launchExtensionContext();

	try {
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin);

		const messengerPage = await extension.context.newPage();
		await messengerPage.goto(
			`chrome-extension://${new URL(worker.url()).host}/popup.html`,
		);

		const targetPage = await extension.context.newPage();
		await targetPage.goto(`${mockServer.origin}/capture.html`);
		await targetPage.bringToFront();

		// Open the recorder panel + camera preview like the action click does.
		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "bootstrap",
		});
		for (let attempt = 0; attempt < 10; attempt += 1) {
			if (frameWithUrl(targetPage, "popup.html")) break;
			await togglePanelInTab(worker, "/capture.html");
			await targetPage.waitForTimeout(1_000);
		}

		// Both extension iframes should be mounted in the page.
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") !== null, {
				timeout: 15_000,
			})
			.toBe(true);
		await expect
			.poll(() => frameWithUrl(targetPage, "camera-preview.html") !== null, {
				timeout: 15_000,
			})
			.toBe(true);

		await targetPage.screenshot({ path: "test-results/close-ui-before.png" });

		const panelFrame = frameWithUrl(targetPage, "popup.html");
		if (!panelFrame) throw new Error("panel frame missing");
		await panelFrame
			.locator('button[aria-label="Close Cap and hide all recorder UI"]')
			.click();

		// The panel and the camera preview should both tear down.
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") === null, {
				timeout: 10_000,
			})
			.toBe(true);
		await expect
			.poll(() => frameWithUrl(targetPage, "camera-preview.html") === null, {
				timeout: 10_000,
			})
			.toBe(true);

		// And nothing should resurrect the preview shortly after.
		await targetPage.waitForTimeout(2_500);
		expect(frameWithUrl(targetPage, "camera-preview.html")).toBeNull();
		await targetPage.screenshot({ path: "test-results/close-ui-after.png" });
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});

test("a failed recording start reopens the panel with the error", async () => {
	test.setTimeout(120_000);
	const mockServer = await createMockCapServer({ failInstantRecordings: true });
	const extension = await launchExtensionContext();

	try {
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin);

		const messengerPage = await extension.context.newPage();
		await messengerPage.goto(
			`chrome-extension://${new URL(worker.url()).host}/popup.html`,
		);

		const targetPage = await extension.context.newPage();
		await targetPage.goto(`${mockServer.origin}/capture.html`);
		await targetPage.bringToFront();

		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "bootstrap",
		});
		await targetPage.waitForTimeout(3_000);

		const startResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		})) as { ok: boolean; error?: string; canceled?: boolean };
		expect(startResponse.ok).toBe(false);
		expect(startResponse.canceled).toBeFalsy();

		// The status should be a visible error, not a silent reset to idle.
		const statusResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-recording-status",
		})) as { status?: { phase?: string } };
		expect(statusResponse.status?.phase).toBe("error");

		// The panel should reopen in the page to show the failure.
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") !== null, {
				timeout: 10_000,
			})
			.toBe(true);
		const panelFrame = frameWithUrl(targetPage, "popup.html");
		if (!panelFrame) throw new Error("panel frame missing");
		await expect(panelFrame.getByText("Recording failed.")).toBeVisible({
			timeout: 10_000,
		});
		await targetPage.screenshot({
			path: "test-results/start-error-panel.png",
		});
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});

test("floating bar appears during recording", async () => {
	test.setTimeout(120_000);
	const mockServer = await createMockCapServer();
	const extension = await launchExtensionContext();

	try {
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin);

		const messengerPage = await extension.context.newPage();
		await messengerPage.goto(
			`chrome-extension://${new URL(worker.url()).host}/popup.html`,
		);

		const targetPage = await extension.context.newPage();
		await targetPage.goto(`${mockServer.origin}/capture.html`);
		await targetPage.bringToFront();

		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "bootstrap",
		});
		await targetPage.waitForTimeout(4_000);

		const startResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		})) as { ok: boolean };
		expect(startResponse.ok).toBe(true);

		await targetPage.waitForTimeout(2_000);
		await targetPage.screenshot({
			path: "test-results/recording-bar-visible.png",
		});

		const stopResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		})) as { ok: boolean };
		expect(stopResponse.ok).toBe(true);
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});
