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
	type CDPSession,
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
				get(
					keys: string | string[] | null,
					callback: (items: Record<string, unknown>) => void,
				): void;
				set(items: Record<string, unknown>, callback?: () => void): void;
			};
			session: {
				get(
					keys: string | string[] | null,
					callback: (items: Record<string, unknown>) => void,
				): void;
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
	options: {
		failInstantRecordings?: boolean;
		holdInstantRecordings?: boolean;
	} = {},
) => {
	let instantRecordingRequested = false;
	let releaseInstantRecording: () => void = () => undefined;
	const instantRecordingGate = new Promise<void>((resolve) => {
		releaseInstantRecording = resolve;
	});
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
			instantRecordingRequested = true;
			if (options.holdInstantRecordings) {
				await instantRecordingGate;
			}
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
		isInstantRecordingRequested: () => instantRecordingRequested,
		releaseInstantRecording,
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
	options: { countdownEnabled?: boolean; webcamEnabled?: boolean } = {},
) => {
	await worker.evaluate(
		async ({ authKey, bootstrapKey, settingsKey, apiBaseUrl, options }) => {
			const chromeApi = (globalThis as ChromeGlobal).chrome;
			const webcamEnabled = options.webcamEnabled ?? true;
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
								enabled: webcamEnabled,
								deviceId: webcamEnabled ? "__cap_default_camera__" : null,
								position: "bottom-left",
								size: 230,
								shape: "round",
								mirror: false,
							},
							microphone: { enabled: false, deviceId: null },
							systemAudio: { enabled: false },
							sounds: { enabled: false },
							countdown: {
								enabled: options.countdownEnabled ?? false,
								seconds: 3,
							},
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
			options,
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

const readSessionRecordingPhase = (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(
		() =>
			new Promise<string | null>((resolve) => {
				const chromeApi = (globalThis as ChromeGlobal).chrome;
				chromeApi.storage.session.get(
					"cap-extension-recording-state",
					(items) => {
						const state = items["cap-extension-recording-state"] as
							| { status?: { phase?: string } }
							| undefined;
						resolve(state?.status?.phase ?? null);
					},
				);
			}),
	);

const writeStaleCreatingState = (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const chromeApi = (globalThis as ChromeGlobal).chrome;
				chromeApi.storage.session.set(
					{
						"cap-extension-recording-state": {
							status: { phase: "creating" },
							plan: null,
							updatedAt: Date.now(),
						},
					},
					resolve,
				);
			}),
	);

const frameWithUrl = (page: Page, fragment: string) =>
	page.frames().find((frame) => frame.url().includes(fragment)) ?? null;

type ElementBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

const getClosedShadowNodeId = async (
	session: CDPSession,
	attribute: string,
	classToken?: string,
) => {
	await session.send("DOM.enable");
	const { nodes } = (await session.send("DOM.getFlattenedDocument", {
		depth: -1,
		pierce: true,
	})) as {
		nodes: Array<{ nodeId: number; attributes?: string[] }>;
	};
	return (
		nodes.find(({ attributes = [] }) => {
			for (let index = 0; index < attributes.length; index += 2) {
				if (attributes[index] !== attribute) continue;
				if (!classToken) return true;
				return (
					attributes[index + 1]?.split(/\s+/).includes(classToken) === true
				);
			}
			return false;
		})?.nodeId ?? null
	);
};

const getClosedShadowElementBox = async (
	session: CDPSession,
	attribute: string,
	classToken?: string,
): Promise<ElementBox | null> => {
	const nodeId = await getClosedShadowNodeId(session, attribute, classToken);
	if (nodeId === null) return null;

	try {
		const { model } = (await session.send("DOM.getBoxModel", {
			nodeId,
		})) as { model: { border: number[] } };
		const xCoordinates = model.border.filter((_, index) => index % 2 === 0);
		const yCoordinates = model.border.filter((_, index) => index % 2 === 1);
		const left = Math.min(...xCoordinates);
		const right = Math.max(...xCoordinates);
		const top = Math.min(...yCoordinates);
		const bottom = Math.max(...yCoordinates);
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	} catch {
		return null;
	}
};

const getClosedShadowComputedStyle = async (
	session: CDPSession,
	attribute: string,
	property: string,
) => {
	const nodeId = await getClosedShadowNodeId(session, attribute);
	if (nodeId === null) return null;
	await session.send("CSS.enable");
	const { computedStyle } = (await session.send("CSS.getComputedStyleForNode", {
		nodeId,
	})) as { computedStyle: Array<{ name: string; value: string }> };
	return computedStyle.find(({ name }) => name === property)?.value ?? null;
};

const readStoredWebcamSize = (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
) =>
	worker.evaluate(
		(settingsKey) =>
			new Promise<number | null>((resolve) => {
				const chromeApi = (globalThis as ChromeGlobal).chrome;
				chromeApi.storage.local.get(settingsKey, (items) => {
					const settings = items[settingsKey] as
						| { webcam?: { size?: number } }
						| undefined;
					resolve(
						typeof settings?.webcam?.size === "number"
							? settings.webcam.size
							: null,
					);
				});
			}),
		SETTINGS_KEY,
	);

test("idle bootstrap and tab activation never open the camera preview", async () => {
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
		await targetPage.waitForTimeout(2_500);

		expect(frameWithUrl(targetPage, "popup.html")).toBeNull();
		expect(frameWithUrl(targetPage, "camera-preview.html")).toBeNull();
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});

test("dismissing or closing the panel also closes the idle camera preview", async () => {
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
			type: "open-recorder-panel",
		});

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
		await targetPage.mouse.click(400, 300);

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

		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "open-recorder-panel",
		});
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

		const panelFrame = frameWithUrl(targetPage, "popup.html");
		if (!panelFrame) throw new Error("panel frame missing");
		await panelFrame
			.locator('button[aria-label="Close Cap and hide all recorder UI"]')
			.click();

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

		await targetPage.waitForTimeout(2_500);
		expect(frameWithUrl(targetPage, "camera-preview.html")).toBeNull();
		await targetPage.screenshot({ path: "test-results/close-ui-after.png" });
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});

test("an abandoned recording start clears without leaving controls behind", async () => {
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
			type: "open-recorder-panel",
		});
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") !== null, {
				timeout: 15_000,
			})
			.toBe(true);

		const devtools = await extension.context.newCDPSession(targetPage);
		await writeStaleCreatingState(worker);
		await expect.poll(() => readSessionRecordingPhase(worker)).toBe("creating");
		await targetPage.waitForTimeout(500);
		expect(
			await getClosedShadowElementBox(
				devtools,
				"class",
				"cap-extension-recording-rail",
			),
		).toBeNull();

		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "close-extension-ui",
		});
		const statusResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-recording-status",
		})) as { status?: { phase?: string } };
		expect(statusResponse.status?.phase).toBe("idle");
		await expect.poll(() => readSessionRecordingPhase(worker)).toBe("idle");
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") === null, {
				timeout: 10_000,
			})
			.toBe(true);
		expect(
			await getClosedShadowElementBox(
				devtools,
				"class",
				"cap-extension-recording-rail",
			),
		).toBeNull();
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

test("the countdown appears while recording setup is still pending", async () => {
	test.setTimeout(60_000);
	const mockServer = await createMockCapServer({ holdInstantRecordings: true });
	const extension = await launchExtensionContext();

	try {
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin, {
			countdownEnabled: true,
			webcamEnabled: false,
		});

		const messengerPage = await extension.context.newPage();
		await messengerPage.goto(
			`chrome-extension://${new URL(worker.url()).host}/popup.html`,
		);
		const targetPage = await extension.context.newPage();
		await targetPage.goto(`${mockServer.origin}/capture.html`);
		await targetPage.bringToFront();

		const startPromise = sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		});
		await expect
			.poll(mockServer.isInstantRecordingRequested, { timeout: 10_000 })
			.toBe(true);

		const devtools = await extension.context.newCDPSession(targetPage);
		await expect
			.poll(
				async () =>
					(await getClosedShadowElementBox(
						devtools,
						"class",
						"cap-extension-countdown",
					)) !== null,
				{ timeout: 1_000 },
			)
			.toBe(true);
		await targetPage.screenshot({
			path: "test-results/countdown-during-setup.png",
		});

		mockServer.releaseInstantRecording();
		const startResponse = (await startPromise) as { ok: boolean };
		expect(startResponse.ok).toBe(true);
		const stopResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		})) as { ok: boolean };
		expect(stopResponse.ok).toBe(true);
	} finally {
		mockServer.releaseInstantRecording();
		await extension.cleanup();
		await mockServer.close();
	}
});

test("recording controls stay stable and the camera resizes directly", async () => {
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
		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "open-recorder-panel",
		});
		await expect
			.poll(() => frameWithUrl(targetPage, "popup.html") !== null, {
				timeout: 15_000,
			})
			.toBe(true);

		const startResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: "fullscreen",
		})) as { ok: boolean };
		expect(startResponse.ok).toBe(true);
		await expect
			.poll(() => frameWithUrl(targetPage, "camera-preview.html") !== null, {
				timeout: 10_000,
			})
			.toBe(true);

		const devtools = await extension.context.newCDPSession(targetPage);
		await expect
			.poll(
				async () =>
					(await getClosedShadowElementBox(
						devtools,
						"class",
						"cap-extension-recording-rail",
					)) !== null,
				{ timeout: 10_000 },
			)
			.toBe(true);
		const initialBox = await getClosedShadowElementBox(
			devtools,
			"class",
			"cap-extension-recording-rail",
		);
		if (!initialBox) throw new Error("recording bar missing");
		expect(initialBox.x).toBeLessThanOrEqual(20);
		expect(initialBox.width).toBeGreaterThan(100);
		expect(initialBox.width).toBeLessThanOrEqual(128);
		expect(initialBox.height).toBeLessThanOrEqual(44);
		const handleBox = await getClosedShadowElementBox(
			devtools,
			"data-drag-handle",
		);
		if (!handleBox) throw new Error("recording bar drag handle missing");
		const timeBox = await getClosedShadowElementBox(
			devtools,
			"data-recording-time",
		);
		if (!timeBox || timeBox.width < 30) {
			throw new Error("recording time is not visible at rest");
		}
		expect(
			await getClosedShadowComputedStyle(
				devtools,
				"data-recording-actions",
				"opacity",
			),
		).toBe("0");

		await targetPage.mouse.move(
			handleBox.x + handleBox.width / 2,
			handleBox.y + handleBox.height / 2,
		);
		await expect
			.poll(() =>
				getClosedShadowComputedStyle(
					devtools,
					"data-recording-actions",
					"opacity",
				),
			)
			.toBe("1");
		const actionsBox = await getClosedShadowElementBox(
			devtools,
			"data-recording-actions",
		);
		if (!actionsBox) throw new Error("recording action capsule missing");
		const actionGap = actionsBox.x - (initialBox.x + initialBox.width);
		expect(actionGap).toBeGreaterThanOrEqual(4);
		expect(actionGap).toBeLessThanOrEqual(8);
		expect(
			await getClosedShadowComputedStyle(
				devtools,
				"data-recording-actions",
				"border-top-left-radius",
			),
		).toBe("14px");
		const pauseBox = await getClosedShadowElementBox(
			devtools,
			"data-recording-pause",
		);
		if (!pauseBox) throw new Error("pause action missing on hover");
		await targetPage.mouse.move(
			pauseBox.x + pauseBox.width / 2,
			pauseBox.y + pauseBox.height / 2,
		);
		await targetPage.waitForTimeout(300);
		expect(
			await getClosedShadowComputedStyle(
				devtools,
				"data-recording-actions",
				"opacity",
			),
		).toBe("1");
		await targetPage.screenshot({
			path: "test-results/recording-bar-expanded.png",
		});
		await targetPage.mouse.click(
			pauseBox.x + pauseBox.width / 2,
			pauseBox.y + pauseBox.height / 2,
		);
		await expect
			.poll(async () => {
				const response = (await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				})) as { status?: { phase?: string } };
				return response.status?.phase;
			})
			.toBe("paused");
		expect(
			await getClosedShadowComputedStyle(
				devtools,
				"data-recording-actions",
				"opacity",
			),
		).toBe("1");
		await targetPage.mouse.click(
			pauseBox.x + pauseBox.width / 2,
			pauseBox.y + pauseBox.height / 2,
		);
		await expect
			.poll(async () => {
				const response = (await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "get-recording-status",
				})) as { status?: { phase?: string } };
				return response.status?.phase;
			})
			.toBe("recording");
		await targetPage.mouse.move(
			handleBox.x + handleBox.width / 2,
			handleBox.y + handleBox.height / 2,
		);
		await targetPage.mouse.down();
		await targetPage.mouse.move(
			handleBox.x + handleBox.width / 2 + 120,
			handleBox.y + handleBox.height / 2 - 80,
			{ steps: 8 },
		);
		await targetPage.mouse.up();

		await expect
			.poll(async () => {
				const movedBox = await getClosedShadowElementBox(
					devtools,
					"class",
					"cap-extension-recording-rail",
				);
				return (
					movedBox !== null &&
					movedBox.x - initialBox.x > 80 &&
					initialBox.y - movedBox.y > 50
				);
			})
			.toBe(true);
		await expect
			.poll(() =>
				worker.evaluate(
					() =>
						new Promise<boolean>((resolve) => {
							const chromeApi = (globalThis as ChromeGlobal).chrome;
							chromeApi.storage.local.get(
								"cap-extension-overlay-ui-state",
								(items) => {
									const state = items["cap-extension-overlay-ui-state"] as
										| {
												recordingBarPosition?: {
													x?: number;
													y?: number;
												};
										  }
										| undefined;
									resolve(
										typeof state?.recordingBarPosition?.x === "number" &&
											typeof state.recordingBarPosition.y === "number",
									);
								},
							);
						}),
				),
			)
			.toBe(true);

		await targetPage.mouse.move(760, 40);
		await expect
			.poll(() =>
				getClosedShadowComputedStyle(
					devtools,
					"data-recording-actions",
					"opacity",
				),
			)
			.toBe("0");
		await targetPage.waitForTimeout(500);
		await targetPage.screenshot({
			path: "test-results/recording-bar-visible.png",
		});

		const initialCameraBox = await getClosedShadowElementBox(
			devtools,
			"data-camera-preview",
		);
		if (!initialCameraBox) throw new Error("camera preview missing");
		await targetPage.mouse.move(
			initialCameraBox.x + initialCameraBox.width / 2,
			initialCameraBox.y + initialCameraBox.height / 2,
		);
		await expect
			.poll(() =>
				getClosedShadowComputedStyle(
					devtools,
					"data-camera-resize-ne",
					"opacity",
				),
			)
			.toBe("1");
		const cameraResizeHandle = await getClosedShadowElementBox(
			devtools,
			"data-camera-resize-ne",
		);
		if (!cameraResizeHandle) throw new Error("camera resize handle missing");
		await targetPage.screenshot({
			path: "test-results/camera-resize-handles.png",
		});
		await targetPage.mouse.move(
			cameraResizeHandle.x + cameraResizeHandle.width / 2,
			cameraResizeHandle.y + cameraResizeHandle.height / 2,
		);
		await targetPage.mouse.down();
		await targetPage.mouse.move(
			cameraResizeHandle.x + cameraResizeHandle.width / 2 + 80,
			cameraResizeHandle.y + cameraResizeHandle.height / 2 - 80,
			{ steps: 8 },
		);
		await targetPage.mouse.up();
		await expect
			.poll(async () => {
				const resizedCamera = await getClosedShadowElementBox(
					devtools,
					"data-camera-preview",
				);
				return (
					resizedCamera !== null &&
					resizedCamera.width - initialCameraBox.width > 50 &&
					resizedCamera.height - initialCameraBox.height > 50
				);
			})
			.toBe(true);
		await expect.poll(() => readStoredWebcamSize(worker)).toBeGreaterThan(230);
		await targetPage.screenshot({
			path: "test-results/camera-resized.png",
		});

		const stopResponse = (await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		})) as { ok: boolean };
		expect(stopResponse.ok).toBe(true);
		await expect
			.poll(() => frameWithUrl(targetPage, "camera-preview.html") === null, {
				timeout: 5_000,
			})
			.toBe(true);
	} finally {
		await extension.cleanup();
		await mockServer.close();
	}
});
