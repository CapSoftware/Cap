import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	uploadParts: Map<number, Buffer>;
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
const unpackedExtensionId = createHash("sha256")
	.update(extensionPath)
	.digest("hex")
	.slice(0, 32)
	.replace(/[0-9a-f]/g, (digit) =>
		String.fromCharCode(97 + Number.parseInt(digit, 16)),
	);
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

// Flashes white and beeps together once a second, both driven by the audio
// clock, so the uploaded file shows whether audio and video stay aligned.
const audibleCapturePage = () => `<!doctype html>
<html>
	<head>
		<title>Cap E2E Capture Target</title>
	</head>
	<body style="margin:0;height:100vh;background:#000">
		<script>
			const context = new AudioContext();
			let scheduledBeat = Math.ceil(context.currentTime);
			const tick = () => {
				while (scheduledBeat < context.currentTime + 0.5) {
					const oscillator = context.createOscillator();
					oscillator.frequency.value = 440;
					oscillator.connect(context.destination);
					oscillator.start(scheduledBeat);
					oscillator.stop(scheduledBeat + 0.2);
					scheduledBeat += 1;
				}
				const lit = context.currentTime % 1 < 0.2;
				document.body.style.background = lit ? "#fff" : "#000";
				requestAnimationFrame(tick);
			};
			tick();
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
		uploadParts: new Map(),
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

			if (request.method === "GET" && url.pathname === "/capture-audio.html") {
				sendHtml(response, audibleCapturePage());
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
				state.uploadParts.set(
					Number(url.pathname.replace("/mock-s3/part-", "")),
					body,
				);
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

// Chromium's fake capture devices and fake permission UI both make tab capture
// fail with "Requested device not found", and headless Chromium captures tab
// audio as silence, so tab recordings launch headed without them.
const canLaunchHeaded =
	process.platform !== "linux" || Boolean(process.env.DISPLAY);

const launchExtensionContext = async ({ tabCapture = false } = {}) => {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "cap-extension-e2e-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: !tabCapture,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			`--allowlisted-extension-id=${unpackedExtensionId}`,
			"--allow-http-screen-capture",
			"--auto-select-desktop-capture-source=Cap E2E Capture Target",
			"--auto-select-tab-capture-source-by-title=Cap E2E Capture Target",
			"--enable-usermedia-screen-capturing",
			"--autoplay-policy=no-user-gesture-required",
			...(!tabCapture
				? [
						"--use-fake-device-for-media-stream",
						"--use-fake-ui-for-media-stream",
					]
				: []),
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

type RecordingOptions = {
	mode: "fullscreen" | "tab";
	microphone: boolean;
	systemAudio: boolean;
	capturePath: string;
	durationMs: number;
};

const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
	mode: RECORDING_MODE,
	microphone: false,
	systemAudio: false,
	capturePath: "/capture.html",
	durationMs: RECORDING_MS,
};

const configureExtension = async (
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
	options: RecordingOptions = DEFAULT_RECORDING_OPTIONS,
) => {
	await worker.evaluate(
		async ({
			authKey,
			bootstrapKey,
			recordingMode,
			microphone,
			systemAudio,
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
								enabled: microphone,
								deviceId: null,
							},
							systemAudio: {
								enabled: systemAudio,
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
			recordingMode: options.mode,
			microphone: options.microphone,
			systemAudio: options.systemAudio,
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

type StreamDurations = { video: number; audio: number | null };

const onsets = (values: { time: number; level: number }[], threshold: number) =>
	values
		.filter(
			(value, index) =>
				value.level > threshold &&
				(index === 0 || values[index - 1].level <= threshold),
		)
		.map((value) => value.time);

// Pairs each white flash with the nearest beep and returns audio minus video
// time in seconds for every pair.
const measureFlashBeepOffsets = (
	file: string,
	samples: Float32Array,
	sampleRate: number,
) => {
	const lines = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			file,
			"-an",
			"-vf",
			"signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
			"-f",
			"null",
			"-",
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	)
		.toString()
		.split("\n");
	const frames: { time: number; level: number }[] = [];
	let frameTime: number | null = null;
	for (const line of lines) {
		const time = /pts_time:([\d.]+)/.exec(line);
		if (time) frameTime = Number(time[1]);
		const level = /YAVG=([\d.]+)/.exec(line);
		if (level && frameTime !== null) {
			frames.push({ time: frameTime, level: Number(level[1]) });
		}
	}
	const windowSize = sampleRate / 100;
	const windows: { time: number; level: number }[] = [];
	for (
		let start = 0;
		start + windowSize <= samples.length;
		start += windowSize
	) {
		let peak = 0;
		for (let index = start; index < start + windowSize; index += 1) {
			peak = Math.max(peak, Math.abs(samples[index]));
		}
		windows.push({ time: start / sampleRate, level: peak });
	}
	const beeps = onsets(windows, 0.1);
	return onsets(frames, 128).flatMap((flash) => {
		const nearest = beeps.reduce<number | null>(
			(best, beep) =>
				best === null || Math.abs(beep - flash) < Math.abs(best - flash)
					? beep
					: best,
			null,
		);
		return nearest !== null && Math.abs(nearest - flash) < 0.5
			? [nearest - flash]
			: [];
	});
};

const probeUploadedRecording = async (state: MockState) => {
	const parts = [...state.uploadParts.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, body]) => body);
	const directory = await mkdtemp(path.join(tmpdir(), "cap-e2e-media-"));
	const file = path.join(directory, "recording.webm");
	await writeFile(file, Buffer.concat(parts));
	try {
		const duration = (type: "v" | "a") => {
			const output = execFileSync("ffprobe", [
				"-v",
				"error",
				"-select_streams",
				type,
				"-show_entries",
				"packet=pts_time",
				"-of",
				"csv=p=0",
				file,
			])
				.toString()
				.trim()
				.split("\n")
				.map(Number)
				.filter(Number.isFinite);
			return output.length > 0 ? Math.max(...output) : null;
		};
		const pcm = execFileSync(
			"ffmpeg",
			[
				"-v",
				"error",
				"-i",
				file,
				"-vn",
				"-ac",
				"1",
				"-ar",
				"8000",
				"-f",
				"f32le",
				"-",
			],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		const samples = new Float32Array(
			pcm.buffer,
			pcm.byteOffset,
			Math.floor(pcm.byteLength / 4),
		);
		const tail = samples.subarray(Math.max(0, samples.length - 8000 * 1.5));
		const tailPeak = tail.reduce(
			(peak, value) => Math.max(peak, Math.abs(value)),
			0,
		);
		const durations: StreamDurations = {
			video: duration("v") ?? 0,
			audio: duration("a"),
		};
		return {
			durations,
			tailPeak,
			avOffsets: measureFlashBeepOffsets(file, samples, 8000),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const startRecording = async (
	context: BrowserContext,
	worker: Awaited<ReturnType<typeof getServiceWorker>>,
	apiBaseUrl: string,
	options: RecordingOptions = DEFAULT_RECORDING_OPTIONS,
) => {
	await configureExtension(worker, apiBaseUrl, options);
	const messengerPage = await openExtensionMessengerPage(context, worker);
	const capturePage = await context.newPage();
	await capturePage.goto(`${apiBaseUrl}${options.capturePath}`);
	await capturePage.bringToFront();

	const startResponse = await sendServiceWorkerMessage(messengerPage, {
		target: "service-worker",
		type: "start-recording",
		mode: options.mode,
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

	await capturePage.waitForTimeout(options.durationMs);
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

	for (const options of [
		{
			name: "fullscreen with microphone",
			mode: "fullscreen",
			microphone: true,
			systemAudio: false,
			capturePath: "/capture.html",
		},
		{
			name: "tab with tab audio",
			mode: "tab",
			microphone: false,
			systemAudio: true,
			capturePath: "/capture-audio.html",
		},
	] as const) {
		test(`keeps audio for the whole ${options.name} recording`, async () => {
			if (!extension || !mockServer)
				throw new Error("Test harness did not start");
			if (options.mode === "tab") {
				test.skip(!canLaunchHeaded, "Tab audio capture needs a headed browser");
				await extension.cleanup();
				extension = await launchExtensionContext({ tabCapture: true });
			}
			const worker = await getServiceWorker(extension.context);
			const { messengerPage } = await startRecording(
				extension.context,
				worker,
				mockServer.origin,
				{ ...options, durationMs: 6_000 },
			);
			const stopResponse = await sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				type: "stop-recording",
			});
			expect(stopResponse).toMatchObject({ ok: true });
			await expectSuccessfulUpload(messengerPage, mockServer.state);

			const { durations, tailPeak, avOffsets } = await probeUploadedRecording(
				mockServer.state,
			);
			if (process.env.CAP_E2E_REPORT_AV) {
				console.log(
					JSON.stringify({
						name: options.name,
						durations,
						tailPeak,
						avOffsets,
					}),
				);
			}
			expect(durations.video).toBeGreaterThan(5);
			expect(durations.audio).not.toBeNull();
			expect(Math.abs((durations.audio ?? 0) - durations.video)).toBeLessThan(
				0.5,
			);
			expect(tailPeak).toBeGreaterThan(0.01);
			if (options.mode === "tab") {
				expect(avOffsets.length).toBeGreaterThanOrEqual(4);
				const sorted = [...avOffsets].sort((a, b) => a - b);
				const median = sorted[Math.floor(sorted.length / 2)];
				expect(Math.abs(median)).toBeLessThan(0.15);
				expect(sorted[sorted.length - 1] - sorted[0]).toBeLessThan(0.1);
			}
		});
	}

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
		mockServer.state.uploadParts = new Map();
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
