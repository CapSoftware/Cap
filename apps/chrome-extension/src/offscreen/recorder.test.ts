import type { RecordingSpool } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionSettings,
	OffscreenResponse,
	RecordingMode,
} from "../shared/types";

type MessageListener = Parameters<
	typeof chrome.runtime.onMessage.addListener
>[0];

class Track extends EventTarget {
	enabled = true;
	readyState = "live";
	label = "Test capture";

	constructor(readonly kind: "audio" | "video") {
		super();
	}

	getSettings() {
		return { width: 320, height: 180, frameRate: 30 };
	}

	stop() {
		this.readyState = "ended";
	}
}

class Stream {
	constructor(private tracks: Track[] = []) {}

	getTracks() {
		return this.tracks;
	}

	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}

	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}

	addTrack(track: Track) {
		this.tracks.push(track);
	}
}

let onMessage: MessageListener;
let capturedStream: Stream;
let speakerStreams: Stream[];
let mixContextOptions: unknown[];
let spool: Pick<RecordingSpool, "sessionId" | "appendChunk" | "dispose">;

beforeEach(async () => {
	vi.resetModules();
	speakerStreams = [];
	mixContextOptions = [];
	vi.useFakeTimers();
	const stored: Record<string, unknown> = {};
	const storage = {
		get: (_keys: string[], callback: (items: object) => void) =>
			callback({ ...stored }),
		set: (items: object, callback: () => void) => {
			Object.assign(stored, items);
			callback();
		},
	};
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("chrome", {
		storage: { local: storage, session: storage },
		runtime: {
			onMessage: {
				addListener: (listener: MessageListener) => {
					onMessage = listener;
				},
			},
			sendMessage: vi.fn((_message: unknown, callback: () => void) =>
				callback(),
			),
		},
	});
	vi.stubGlobal("MediaStream", Stream);
	vi.stubGlobal(
		"MediaRecorder",
		class {
			static isTypeSupported() {
				return true;
			}

			constructor(stream: Stream) {
				capturedStream = stream;
			}

			start() {}
		},
	);
	vi.stubGlobal(
		"AudioContext",
		class {
			destination = {};

			constructor(readonly options?: unknown) {}

			createMediaStreamDestination() {
				mixContextOptions.push(this.options);
				return { stream: new Stream([new Track("audio")]) };
			}

			createMediaStreamSource(stream: Stream) {
				return {
					connect: (destination: object) => {
						if (destination === this.destination) speakerStreams.push(stream);
					},
				};
			}

			close() {
				return Promise.resolve();
			}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.endsWith("/instant-recordings")) {
				return Response.json({
					id: "video-test",
					shareUrl: "https://cap.test/s/video-test",
				});
			}
			if (url.endsWith("/initiate")) {
				return Response.json({ uploadId: "upload-test", provider: "s3" });
			}
			if (url.endsWith("/instant-recordings/video-test")) {
				return Response.json({ success: true });
			}
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	const { RecordingSpool } = await import("@cap/recorder-core");
	spool = {
		sessionId: "spool-test",
		appendChunk: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	};
	vi.spyOn(RecordingSpool, "create").mockResolvedValue(spool as RecordingSpool);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const send = (message: Record<string, unknown>) =>
	new Promise<OffscreenResponse>((resolve) => {
		onMessage({ target: "offscreen", ...message }, {}, resolve);
	});

const start = async (
	settings: Partial<ExtensionSettings> = {},
	mode: RecordingMode = "fullscreen",
) => {
	const { defaultSettings } = await import("../shared/storage");
	await import("./recorder");
	return send({
		type: "start-recording",
		mode,
		tabStreamId: "tab-test",
		settings: {
			...defaultSettings,
			apiBaseUrl: "https://cap.test",
			sounds: { enabled: false },
			countdown: { enabled: false, seconds: 3 },
			...settings,
		},
		auth: { authApiKey: "test", userId: "user-test" },
		bootstrap: {
			organization: { id: "org-test" },
			plan: { isPro: true, maxRecordingSeconds: null },
		},
	});
};

describe("recording microphone mute", () => {
	it.each([
		{ mode: "tab", microphone: true, systemAudio: true },
		{ mode: "tab", microphone: true, systemAudio: false },
		{ mode: "fullscreen", microphone: true, systemAudio: true },
		{ mode: "camera", microphone: true, systemAudio: false },
		{ mode: "tab", microphone: false, systemAudio: true },
	] satisfies Array<{
		mode: RecordingMode;
		microphone: boolean;
		systemAudio: boolean;
	}>)(
		"mutes only microphone capture in $mode with microphone=$microphone, systemAudio=$systemAudio",
		async ({ mode, microphone, systemAudio }) => {
			const mic = new Track("audio");
			const system = new Track("audio");
			const main = new Stream([new Track("video")]);
			if (systemAudio) main.addTrack(system);
			vi.stubGlobal("navigator", {
				userAgent: "Chrome/152.0.0.0",
				mediaDevices: {
					getUserMedia: async (constraints: MediaStreamConstraints) =>
						constraints.video ? main : new Stream([mic]),
					getDisplayMedia: async () => main,
				},
			});
			const started = await start(
				{
					microphone: { enabled: microphone, deviceId: null },
					systemAudio: { enabled: systemAudio },
				},
				mode,
			);
			expect(started).toMatchObject({
				ok: true,
				status: { phase: "recording" },
			});
			const recordingMicrophone = (response: unknown) =>
				(response as { status?: { microphone?: string } }).status?.microphone;
			expect(recordingMicrophone(started)).toBe(
				microphone ? "live" : undefined,
			);

			expect(speakerStreams).toEqual(
				mode === "tab" && systemAudio ? [main] : [],
			);
			expect(mixContextOptions).toEqual([{ sinkId: { type: "none" } }]);

			const muted = await send({ type: "toggle-microphone-mute", muted: true });
			expect(muted).toMatchObject({ ok: true });
			expect(recordingMicrophone(muted)).toBe(microphone ? "muted" : undefined);
			expect(mic.enabled).toBe(!microphone);
			expect(system.enabled).toBe(true);
			if (systemAudio) {
				expect(capturedStream.getAudioTracks()[0]?.enabled).toBe(true);
			}

			const unmuted = await send({
				type: "toggle-microphone-mute",
				muted: false,
			});
			expect(unmuted).toMatchObject({ ok: true });
			expect(recordingMicrophone(unmuted)).toBe(
				microphone ? "live" : undefined,
			);
			expect(mic.enabled).toBe(true);
			expect(system.enabled).toBe(true);
		},
	);
});

describe("recording source ending", () => {
	let video: Track;
	let microphone: Track;

	beforeEach(() => {
		video = new Track("video");
		microphone = new Track("audio");
		vi.stubGlobal("navigator", {
			userAgent: "Chrome/152.0.0.0",
			mediaDevices: {
				getDisplayMedia: async () => new Stream([video]),
				getUserMedia: async () => new Stream([microphone]),
			},
		});
	});

	it.each(["countdown", "recording creation", "manifest persistence"])(
		"cancels when screen capture ends during %s",
		async (stage) => {
			const endSource = () => {
				video.stop();
				video.dispatchEvent(new Event("ended"));
			};
			const api = await import("../shared/api");
			const storage = await import("../shared/storage");
			if (stage === "recording creation") {
				const create = api.createInstantRecording;
				vi.spyOn(api, "createInstantRecording").mockImplementationOnce(
					(input) => {
						const pending = create(input);
						endSource();
						return pending;
					},
				);
			}
			if (stage === "manifest persistence") {
				const save = storage.saveLiveRecordingManifest;
				vi.spyOn(storage, "saveLiveRecordingManifest").mockImplementationOnce(
					(manifest) => {
						const pending = save(manifest);
						endSource();
						return pending;
					},
				);
			}
			const recorderStart = vi.spyOn(MediaRecorder.prototype, "start");
			const closeAudio = vi.spyOn(AudioContext.prototype, "close");
			await import("./recorder");
			const pending = start({
				countdown: { enabled: stage === "countdown", seconds: 3 },
			});
			if (stage === "countdown") {
				await vi.advanceTimersByTimeAsync(1000);
				expect(await send({ type: "get-recording-status" })).toMatchObject({
					status: { phase: "creating" },
				});
				endSource();
				await vi.advanceTimersByTimeAsync(2000);
			}

			expect(await pending).toMatchObject({ ok: false, canceled: true });
			expect(await send({ type: "get-recording-status" })).toEqual({
				ok: true,
				status: { phase: "idle" },
			});
			expect(recorderStart).not.toHaveBeenCalled();
			expect(microphone.readyState).toBe("ended");
			expect(
				capturedStream
					.getTracks()
					.every((track) => track.readyState === "ended"),
			).toBe(true);
			expect(closeAudio).toHaveBeenCalledOnce();
			expect(spool.appendChunk).not.toHaveBeenCalled();
			expect(spool.dispose).toHaveBeenCalledOnce();
			expect(await storage.loadLiveRecordingManifests()).toEqual([]);
			expect(fetch).toHaveBeenCalledWith(
				"https://cap.test/api/extension/instant-recordings/video-test",
				expect.objectContaining({ method: "DELETE" }),
			);
			expect(
				vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PUT"),
			).toBe(false);
			expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
				{ target: "service-worker", type: "stop-recording" },
				expect.any(Function),
			);
		},
	);

	it("requests a normal stop when screen capture ends after startup", async () => {
		expect(await start()).toMatchObject({
			ok: true,
			status: { phase: "recording" },
		});
		video.stop();
		video.dispatchEvent(new Event("ended"));
		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
			{ target: "service-worker", type: "stop-recording" },
			expect.any(Function),
		);
	});
});

describe("capture device acquisition", () => {
	const deviceError = (name: string) => new DOMException(name, name);
	// Runs fake timers until the start settles, so a delayed retry fires.
	const settle = async <T>(promise: Promise<T>) => {
		let settled = false;
		void promise.finally(() => {
			settled = true;
		});
		while (!settled) await vi.advanceTimersByTimeAsync(50);
		return promise;
	};

	it.each(["fullscreen", "camera"] satisfies RecordingMode[])(
		"records from the default mic when the saved one is gone in %s",
		async (mode) => {
			const mic = new Track("audio");
			const requests: MediaStreamConstraints[] = [];
			vi.stubGlobal("navigator", {
				userAgent: "Chrome/152.0.0.0",
				mediaDevices: {
					getUserMedia: async (constraints: MediaStreamConstraints) => {
						requests.push(constraints);
						if (constraints.video) return new Stream([new Track("video")]);
						const audio = constraints.audio as MediaTrackConstraints;
						if (audio.deviceId) throw deviceError("OverconstrainedError");
						return new Stream([mic]);
					},
					getDisplayMedia: async () => new Stream([new Track("video")]),
				},
			});
			const started = await start(
				{
					microphone: { enabled: true, deviceId: "unplugged-mic" },
					webcam: {
						...(await import("../shared/storage")).defaultSettings.webcam,
						deviceId: "camera-1",
					},
				},
				mode,
			);

			expect(started).toMatchObject({
				ok: true,
				status: { phase: "recording", microphone: "live" },
			});
			expect(requests.filter((request) => request.audio)).toEqual([
				expect.objectContaining({
					audio: expect.objectContaining({
						deviceId: { exact: "unplugged-mic" },
					}),
				}),
				expect.objectContaining({
					audio: expect.not.objectContaining({ deviceId: expect.anything() }),
				}),
			]);
			expect(requests.filter((request) => request.video)).toEqual(
				mode === "camera" ? [expect.objectContaining({ audio: false })] : [],
			);
		},
	);

	it("retries a mic that is still being released", async () => {
		const mic = new Track("audio");
		let micAttempts = 0;
		vi.stubGlobal("navigator", {
			userAgent: "Chrome/152.0.0.0",
			mediaDevices: {
				getUserMedia: async () => {
					micAttempts += 1;
					if (micAttempts === 1) throw deviceError("NotReadableError");
					return new Stream([mic]);
				},
				getDisplayMedia: async () => new Stream([new Track("video")]),
			},
		});
		const started = start({ microphone: { enabled: true, deviceId: null } });

		expect(await settle(started)).toMatchObject({
			ok: true,
			status: { phase: "recording", microphone: "live" },
		});
		expect(micAttempts).toBe(2);
	});

	it("does not retry a mic the user has blocked", async () => {
		let micAttempts = 0;
		vi.stubGlobal("navigator", {
			userAgent: "Chrome/152.0.0.0",
			mediaDevices: {
				getUserMedia: async () => {
					micAttempts += 1;
					throw deviceError("NotAllowedError");
				},
				getDisplayMedia: async () => new Stream([new Track("video")]),
			},
		});
		const started = await start({
			microphone: { enabled: true, deviceId: "blocked-mic" },
		});

		expect(started).toMatchObject({ ok: true, status: { phase: "recording" } });
		expect(
			(started as { status?: { microphone?: string } }).status?.microphone,
		).toBeUndefined();
		expect(micAttempts).toBe(1);
	});

	it("retries a camera that is still being released in Camera mode", async () => {
		let cameraAttempts = 0;
		vi.stubGlobal("navigator", {
			userAgent: "Chrome/152.0.0.0",
			mediaDevices: {
				getUserMedia: async (constraints: MediaStreamConstraints) => {
					if (!constraints.video) return new Stream([new Track("audio")]);
					cameraAttempts += 1;
					if (cameraAttempts === 1) throw deviceError("NotReadableError");
					return new Stream([new Track("video")]);
				},
				getDisplayMedia: async () => new Stream([new Track("video")]),
			},
		});
		const started = start(
			{
				microphone: { enabled: true, deviceId: null },
				webcam: {
					...(await import("../shared/storage")).defaultSettings.webcam,
					deviceId: "__cap_default_camera__",
				},
			},
			"camera",
		);

		expect(await settle(started)).toMatchObject({
			ok: true,
			status: { phase: "recording", microphone: "live" },
		});
		expect(cameraAttempts).toBe(2);
	});
});
