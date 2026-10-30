import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { RecordingStatus } from "../src/shared/types";
import { launchExtensionBrowser, unpackedExtensionId } from "./browser";

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
	bootstrapDelayMs: number;
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
		bootstrapDelayMs: 0,
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
				await new Promise((resolve) =>
					setTimeout(resolve, state.bootstrapDelayMs),
				);
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
				// The share page the extension opens after an upload holds a
				// keep-alive connection that would otherwise block close.
				server.closeAllConnections();
			}),
	};
};

// Chromium's fake capture devices and fake permission UI both make tab capture
// fail with "Requested device not found", and headless Chromium captures tab
// audio as silence, so tab recordings launch headed without them.
const canLaunchHeaded =
	process.platform !== "linux" || Boolean(process.env.DISPLAY);

// CAP_E2E_SYSTEM_DEVICES uses the machine's own camera and microphone (on CI
// rigs, OS-level synthetic devices such as a v4l2loopback camera and a
// PulseAudio virtual mic) instead of Chromium's built-in fake devices.
const useSystemDevices = Boolean(process.env.CAP_E2E_SYSTEM_DEVICES);

const launchExtensionContext = async ({
	tabCapture = false,
	fakeAudioFile,
}: {
	tabCapture?: boolean;
	fakeAudioFile?: string;
} = {}) => {
	const extension = await launchExtensionBrowser({
		profilePrefix: "cap-extension-e2e-",
		headless: !tabCapture,
		// Without the fake permission UI, grant the camera and mic up front.
		allowExtensionMedia: tabCapture,
		args: [
			`--allowlisted-extension-id=${unpackedExtensionId}`,
			"--allow-http-screen-capture",
			"--auto-select-desktop-capture-source=Cap E2E Capture Target",
			"--auto-select-tab-capture-source-by-title=Cap E2E Capture Target",
			"--enable-usermedia-screen-capturing",
			"--autoplay-policy=no-user-gesture-required",
			...(!tabCapture
				? [
						"--use-fake-ui-for-media-stream",
						...(useSystemDevices ? [] : ["--use-fake-device-for-media-stream"]),
						...(fakeAudioFile
							? [`--use-file-for-fake-audio-capture=${fakeAudioFile}`]
							: []),
					]
				: []),
		],
	});
	return extension;
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
	mode: "fullscreen" | "tab" | "camera";
	microphone: boolean;
	webcam?: boolean;
	systemAudio: boolean;
	capturePath: string;
	durationMs: number;
	cachedPlan?: { isPro: boolean; maxRecordingSeconds: number | null };
	microphoneWarning?: boolean;
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
			webcam,
			systemAudio,
			cachedPlan,
			microphoneWarning,
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
								plan: cachedPlan,
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
								enabled: webcam,
								deviceId: webcam ? "__cap_default_camera__" : null,
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
								enabled: microphoneWarning,
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
			webcam: options.webcam ?? false,
			systemAudio: options.systemAudio,
			microphoneWarning: options.microphoneWarning ?? false,
			cachedPlan: options.cachedPlan ?? {
				isPro: true,
				maxRecordingSeconds: 600,
			},
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

// Frame size, mean brightness and how many frames differ from the one before,
// so a black or frozen camera fails even when the recording has frames.
const measureVideo = (file: string) => {
	const [width, height] = execFileSync("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height",
		"-of",
		"csv=p=0",
		file,
	])
		.toString()
		.trim()
		.split(",")
		.map(Number);
	const lines = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			file,
			"-an",
			"-vf",
			"signalstats,metadata=print:file=-",
			"-f",
			"null",
			"-",
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	)
		.toString()
		.split("\n");
	const luma: number[] = [];
	let movingFrames = 0;
	for (const line of lines) {
		const average = /YAVG=([\d.]+)/.exec(line);
		if (average) luma.push(Number(average[1]));
		const difference = /YDIF=([\d.]+)/.exec(line);
		if (difference && Number(difference[1]) > 0.5) movingFrames += 1;
	}
	return {
		width,
		height,
		frames: luma.length,
		meanLuma: luma.reduce((total, value) => total + value, 0) / luma.length,
		movingFrames,
	};
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
			audioPeak: samples.reduce(
				(peak, value) => Math.max(peak, Math.abs(value)),
				0,
			),
			video: measureVideo(file),
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

	for (const input of [
		{
			name: "quiet room tone starts without a warning",
			source: "anoisesrc=color=pink:amplitude=0.0005",
			warns: false,
		},
		{
			name: "a silent microphone still warns before starting",
			source: "anullsrc=channel_layout=mono:sample_rate=48000",
			warns: true,
		},
	]) {
		test(`microphone check: ${input.name}`, async () => {
			if (!extension || !mockServer)
				throw new Error("Test harness did not start");
			test.skip(
				useSystemDevices,
				"Feeds the mic through Chromium's fake device",
			);
			const audioDirectory = await mkdtemp(path.join(tmpdir(), "cap-e2e-mic-"));
			try {
				const audioFile = path.join(audioDirectory, "mic.wav");
				execFileSync("ffmpeg", [
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					input.source,
					"-t",
					"10",
					"-ar",
					"48000",
					"-ac",
					"1",
					audioFile,
				]);
				await extension.cleanup();
				extension = await launchExtensionContext({ fakeAudioFile: audioFile });
				const worker = await getServiceWorker(extension.context);
				await configureExtension(worker, mockServer.origin, {
					...DEFAULT_RECORDING_OPTIONS,
					microphone: true,
					microphoneWarning: true,
				});
				const messengerPage = await openExtensionMessengerPage(
					extension.context,
					worker,
				);
				const capturePage = await extension.context.newPage();
				await capturePage.goto(`${mockServer.origin}/capture.html`);
				await capturePage.bringToFront();
				void sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "start-recording",
					mode: DEFAULT_RECORDING_OPTIONS.mode,
				}).catch(() => undefined);

				const readPhase = async () => {
					const response = await sendServiceWorkerMessage(messengerPage, {
						target: "service-worker",
						type: "get-recording-status",
					});
					return response.ok ? response.status?.phase : response.error;
				};
				if (input.warns) {
					await capturePage.waitForTimeout(4_000);
					expect(await readPhase()).toBe("idle");
					expect(mockServer.state.initiateBodies).toHaveLength(0);
				} else {
					await expect.poll(readPhase, { timeout: 10_000 }).toBe("recording");
					await capturePage.waitForTimeout(1_000);
					const stopResponse = await sendServiceWorkerMessage(messengerPage, {
						target: "service-worker",
						type: "stop-recording",
					});
					expect(stopResponse).toMatchObject({ ok: true });
					await expectSuccessfulUpload(messengerPage, mockServer.state);
				}
			} finally {
				await rm(audioDirectory, { recursive: true, force: true });
			}
		});
	}

	test("cancel during a slow start leaves the recorder matching the result", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		mockServer.state.bootstrapDelayMs = 2_500;
		const worker = await getServiceWorker(extension.context);
		await configureExtension(worker, mockServer.origin, {
			...DEFAULT_RECORDING_OPTIONS,
			cachedPlan: { isPro: false, maxRecordingSeconds: 300 },
		});
		const messengerPage = await openExtensionMessengerPage(
			extension.context,
			worker,
		);
		const capturePage = await extension.context.newPage();
		await capturePage.goto(`${mockServer.origin}/capture.html`);
		await capturePage.bringToFront();
		const readPhase = async () => {
			const response = await sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				type: "get-recording-status",
			});
			return response.ok ? response.status?.phase : response.error;
		};

		const started = sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "start-recording",
			mode: DEFAULT_RECORDING_OPTIONS.mode,
		});
		await expect.poll(readPhase).toBe("creating");
		await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "cancel-recording-start",
		});

		// The cancel usually lands while the plan is still being re-checked and
		// stops the start before the recorder sees it. On a slow machine it can
		// land after the recorder has started; either way the result must match
		// what the recorder is doing.
		const result = await started;
		await capturePage.waitForTimeout(3_000);
		const phase = await readPhase();
		if (result.ok) {
			// A start that beat the cancel is real, and the cancel's stop may
			// already have ended it.
			expect(["recording", "uploading", "completed"]).toContain(phase);
			if (phase === "recording") {
				await sendServiceWorkerMessage(messengerPage, {
					target: "service-worker",
					type: "stop-recording",
				});
			}
		} else {
			expect(result).toMatchObject({ canceled: true });
			expect(phase).toBe("idle");
			expect(mockServer.state.initiateBodies).toHaveLength(0);
		}
	});

	test("re-checks a cached free plan so an upgraded account is not cut off", async () => {
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		// The popup's background plan refresh is still in flight when the
		// recording starts, as when Start is pressed right after opening it.
		mockServer.state.bootstrapDelayMs = 1_500;
		const worker = await getServiceWorker(extension.context);
		const { messengerPage } = await startRecording(
			extension.context,
			worker,
			mockServer.origin,
			{
				...DEFAULT_RECORDING_OPTIONS,
				durationMs: 4_000,
				cachedPlan: { isPro: false, maxRecordingSeconds: 2 },
			},
		);
		const status = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "get-recording-status",
		});
		expect(status).toMatchObject({ ok: true, status: { phase: "recording" } });

		const stopResponse = await sendServiceWorkerMessage(messengerPage, {
			target: "service-worker",
			type: "stop-recording",
		});
		expect(stopResponse).toMatchObject({ ok: true });
		await expectSuccessfulUpload(messengerPage, mockServer.state);
	});

	// Random interleavings of everything a user or the browser can do around a
	// recording. Run with CAP_E2E_FUZZ=<iterations> (and CAP_E2E_FUZZ_SEED to
	// replay a failure). After every step the service worker must answer, no
	// start may hang, and at the end a clean recording must still upload.
	test("survives random recording interleavings", async () => {
		const iterations = Number(process.env.CAP_E2E_FUZZ ?? 0);
		test.skip(iterations <= 0, "Set CAP_E2E_FUZZ to run the fuzz test");
		test.setTimeout(30 * 60_000);
		if (!extension || !mockServer)
			throw new Error("Test harness did not start");
		const context = extension.context;
		const server = mockServer;
		let seed = Number(process.env.CAP_E2E_FUZZ_SEED ?? Date.now() % 1_000_000);
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const initialSeed = seed;
		const pick = <T>(values: readonly T[]) =>
			values[Math.floor(random() * values.length)];

		await configureExtension(await getServiceWorker(context), server.origin);
		const messengerPage = await openExtensionMessengerPage(
			context,
			await getServiceWorker(context),
		);
		const capturePage = await context.newPage();
		await capturePage.goto(`${server.origin}/capture.html`);
		await capturePage.bringToFront();
		let otherPage: Page | null = null;

		const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) =>
			Promise.race([
				promise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`${label} timed out`)), ms),
				),
			]);
		const send = (message: Record<string, unknown>) =>
			sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				...message,
			});
		const liveWorker = async () => {
			const existing = context
				.serviceWorkers()
				.find((worker) => worker.url().includes("assets/service-worker.js"));
			if (existing) return existing;
			const waiting = getServiceWorker(context);
			await send({ type: "get-recording-status" }).catch(() => undefined);
			return waiting;
		};
		const readPhase = async () => {
			const response = await withTimeout(
				send({ type: "get-recording-status" }),
				5_000,
				"get-recording-status",
			);
			return response.ok ? (response.status?.phase ?? "unknown") : "failed";
		};

		const pendingStarts: { startedAt: number; settled: boolean }[] = [];
		const log: string[] = [];
		const actions: Record<string, () => Promise<unknown>> = {
			start: async () => {
				const entry = { startedAt: Date.now(), settled: false };
				pendingStarts.push(entry);
				void send({ type: "start-recording", mode: "fullscreen" })
					.catch(() => undefined)
					.finally(() => {
						entry.settled = true;
					});
			},
			stop: () => send({ type: "stop-recording" }),
			pause: () => send({ type: "pause-recording" }),
			resume: () => send({ type: "resume-recording" }),
			openPanel: () => send({ type: "open-recorder-panel" }),
			closeUi: () => send({ type: "close-extension-ui" }),
			reloadPage: () => capturePage.reload(),
			switchTab: async () => {
				if (otherPage && random() < 0.5) {
					await capturePage.bringToFront();
					return;
				}
				otherPage ??= await context.newPage();
				await otherPage.goto(`${server.origin}/capture-audio.html`);
				await otherPage.bringToFront();
			},
			closeOtherTab: async () => {
				await otherPage?.close();
				otherPage = null;
				await capturePage.bringToFront();
			},
			killWorker: async () => {
				const session = await context.newCDPSession(capturePage);
				await session.send("ServiceWorker.enable");
				await session.send("ServiceWorker.stopAllWorkers");
				await session.detach();
			},
			closeOffscreen: async () => {
				const worker = await liveWorker();
				await worker.evaluate(async () => {
					const chromeApi = (
						globalThis as unknown as {
							chrome: { offscreen: { closeDocument: () => Promise<void> } };
						}
					).chrome;
					await chromeApi.offscreen.closeDocument().catch(() => undefined);
				});
			},
			toggleMicrophone: async () => {
				const response = await send({ type: "bootstrap" });
				const settings = (
					response as { settings?: { microphone?: { enabled: boolean } } }
				).settings;
				if (!settings?.microphone) return;
				await send({
					type: "settings-updated",
					settings: {
						...settings,
						microphone: {
							...settings.microphone,
							enabled: !settings.microphone.enabled,
						},
					},
				});
			},
		};
		const weighted = [
			...Array(4).fill("start"),
			...Array(3).fill("stop"),
			"pause",
			"resume",
			"openPanel",
			"closeUi",
			"reloadPage",
			"switchTab",
			"closeOtherTab",
			"killWorker",
			"closeOffscreen",
			"toggleMicrophone",
		] as const;

		try {
			for (let step = 0; step < iterations; step += 1) {
				const action = pick(weighted);
				const phaseBefore = await readPhase();
				log.push(`${step}:${action}@${phaseBefore}`);
				await withTimeout(
					actions[action]().catch(() => undefined),
					15_000,
					action,
				);
				await capturePage.waitForTimeout(Math.floor(random() * 1_500));
				const phase = await readPhase();
				expect(phase).not.toBe("failed");
				const stuck = pendingStarts.find(
					(entry) => !entry.settled && Date.now() - entry.startedAt > 20_000,
				);
				expect(stuck, "a recording start never settled").toBeUndefined();
			}

			await send({ type: "stop-recording" }).catch(() => undefined);
			await expect
				.poll(readPhase, { timeout: 30_000 })
				.not.toMatch(/^(creating|recording|paused|uploading)$/);

			server.state.completeBodies = [];
			server.state.progressBodies = [];
			server.state.initiateBodies = [];
			server.state.presignBodies = [];
			server.state.uploadBytes = [];
			server.state.uploadParts = new Map();
			server.state.uploadHeaders = [];
			server.state.videoId = `e2e-${Date.now()}-after-fuzz`;
			await capturePage.bringToFront();
			const started = await send({
				type: "start-recording",
				mode: "fullscreen",
			});
			expect(started).toMatchObject({ ok: true });
			await expect.poll(readPhase).toBe("recording");
			await capturePage.waitForTimeout(2_000);
			expect(await send({ type: "stop-recording" })).toMatchObject({
				ok: true,
			});
			await expectSuccessfulUpload(messengerPage, server.state);
		} catch (error) {
			console.log(`fuzz seed ${initialSeed}: ${log.join(" ")}`);
			throw error;
		}
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

// Reports whether the in-page camera preview is showing moving frames.
const readCameraPreview = async (page: Page) => {
	const frame = page
		.frames()
		.find((candidate) => candidate.url().includes("/camera-preview.html"));
	if (!frame) return "no preview frame";
	return frame
		.evaluate(
			() =>
				new Promise<string>((resolve) => {
					const video = document.querySelector("video");
					if (!video) return resolve("no video element");
					if (video.videoWidth === 0) return resolve("no frames yet");
					const startTime = video.currentTime;
					const timer = window.setTimeout(() => {
						resolve(video.currentTime > startTime ? "live" : "frozen");
					}, 1_000);
					video.requestVideoFrameCallback(() => {
						window.clearTimeout(timer);
						resolve("live");
					});
				}),
		)
		.catch((error: unknown) =>
			error instanceof Error ? error.message : String(error),
		);
};

// Starts and stops a recording with the webcam and microphone on, over and
// over in one browser, as someone recording several clips back to back would.
// Every start must show a live camera preview, report the mic as live and
// upload a recording whose audio carries the mic signal. With
// CAP_E2E_SYSTEM_DEVICES the camera and mic are the OS devices; set
// CAP_E2E_DEVICE_LOOPS to hammer it harder.
test.describe("camera and microphone start", () => {
	const loops = Number(process.env.CAP_E2E_DEVICE_LOOPS ?? 3);

	// Display capture of a virtual X screen fails, so with OS devices the
	// screen half of the matrix records a tab instead.
	const screenMode = useSystemDevices ? "tab" : "fullscreen";

	for (const mode of [screenMode, "camera"] as const) {
		test(`starts the webcam and microphone on every ${mode} recording`, async () => {
			test.setTimeout(60_000 + loops * 40_000);
			test.skip(
				mode === "tab" && !canLaunchHeaded,
				"Tab capture needs a headed browser",
			);
			// Tab capture cannot use the fake permission UI, and installed
			// browsers ignore the media grant seeded into a fresh profile.
			test.skip(
				mode === "tab" && Boolean(process.env.CAP_E2E_BROWSER),
				"Installed browsers need the permission page to grant the mic",
			);
			const extension = await launchExtensionContext({
				tabCapture: mode === "tab",
			});
			try {
				for (let index = 0; index < loops; index += 1) {
					const mockServer = await createMockCapServer();
					try {
						// Chrome stops an idle service worker between recordings, so
						// wake it with an extension page and take a fresh handle.
						const wakePage = await extension.context.newPage();
						await wakePage.goto(
							`chrome-extension://${unpackedExtensionId}/popup.html`,
						);
						const worker = await getServiceWorker(extension.context);
						await wakePage.close();
						const startedAt = Date.now();
						const { capturePage, messengerPage } = await startRecording(
							extension.context,
							worker,
							mockServer.origin,
							{
								...DEFAULT_RECORDING_OPTIONS,
								mode,
								microphone: true,
								webcam: true,
								durationMs: 0,
							},
						);
						const recordingAfterMs = Date.now() - startedAt;

						const status = await sendServiceWorkerMessage(messengerPage, {
							target: "service-worker",
							type: "get-recording-status",
						});
						expect(status).toMatchObject({
							ok: true,
							status: { phase: "recording", microphone: "live" },
						});
						await expect
							.poll(() => readCameraPreview(capturePage), { timeout: 10_000 })
							.toBe("live");
						const previewAfterMs = Date.now() - startedAt;

						await capturePage.waitForTimeout(3_000);
						const stopResponse = await sendServiceWorkerMessage(messengerPage, {
							target: "service-worker",
							type: "stop-recording",
						});
						expect(stopResponse).toMatchObject({ ok: true });
						await expectSuccessfulUpload(messengerPage, mockServer.state);

						const { durations, audioPeak, video } =
							await probeUploadedRecording(mockServer.state);
						if (process.env.CAP_E2E_REPORT_DEVICES) {
							console.log(
								JSON.stringify({
									mode,
									loop: index,
									recordingAfterMs,
									previewAfterMs,
									durations,
									audioPeak,
									video,
								}),
							);
						}
						expect(durations.video).toBeGreaterThan(2);
						expect(durations.audio).not.toBeNull();
						expect(audioPeak).toBeGreaterThan(0.01);
						expect(video.movingFrames).toBeGreaterThan(video.frames / 4);
						if (mode === "camera") {
							// Black video sits at 16 in limited-range luma.
							expect(video.meanLuma).toBeGreaterThan(20);
							// Camera mode records the camera's own frames. A rig that knows
							// its camera's size (CAP_E2E_CAMERA_SIZE=1280x720) checks it.
							const [width, height] = (process.env.CAP_E2E_CAMERA_SIZE ?? "")
								.split("x")
								.map(Number);
							if (width && height) {
								expect(video).toMatchObject({ width, height });
							}
						}

						await capturePage.close();
						await messengerPage.close();
					} finally {
						await mockServer.close();
					}
				}
			} finally {
				await extension.cleanup();
			}
		});
	}

	test("keeps the camera preview in the recorded tab when a background tab opens", async () => {
		// Camera mode keeps the fake permission UI, which tab capture cannot use.
		const mode = useSystemDevices ? "camera" : "fullscreen";
		const extension = await launchExtensionContext();
		const mockServer = await createMockCapServer();
		try {
			const worker = await getServiceWorker(extension.context);
			const { capturePage, messengerPage } = await startRecording(
				extension.context,
				worker,
				mockServer.origin,
				{
					...DEFAULT_RECORDING_OPTIONS,
					mode,
					microphone: true,
					webcam: true,
					durationMs: 0,
				},
			);
			await expect
				.poll(() => readCameraPreview(capturePage), { timeout: 10_000 })
				.toBe("live");

			// Links opened in the background mid-recording load the overlay
			// while the recording is live.
			const urls = [0, 1, 2].map(
				(index) => `${mockServer.origin}/background-tab-${index}`,
			);
			await worker.evaluate(async (urls) => {
				const chromeApi = (
					globalThis as unknown as {
						chrome: {
							tabs: { create(options: object): Promise<unknown> };
						};
					}
				).chrome;
				for (const url of urls) {
					await chromeApi.tabs.create({ url, active: false });
				}
			}, urls);
			await expect
				.poll(
					() =>
						extension.context
							.pages()
							.filter((page) => urls.includes(page.url())).length,
				)
				.toBe(urls.length);
			// Give every background overlay time to load and connect.
			await capturePage.waitForTimeout(4_000);
			expect(await readCameraPreview(capturePage)).toBe("live");
			for (const page of extension.context.pages()) {
				if (!urls.includes(page.url())) continue;
				expect(await readCameraPreview(page)).toBe("no preview frame");
			}

			const stopResponse = await sendServiceWorkerMessage(messengerPage, {
				target: "service-worker",
				type: "stop-recording",
			});
			expect(stopResponse).toMatchObject({ ok: true });
			await expectSuccessfulUpload(messengerPage, mockServer.state);
		} finally {
			await extension.cleanup();
			await mockServer.close();
		}
	});
});
