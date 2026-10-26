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
let spool: Pick<RecordingSpool, "sessionId" | "appendChunk" | "dispose">;

beforeEach(async () => {
	vi.resetModules();
	speakerStreams = [];
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

			createMediaStreamDestination() {
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
			if (mode === "camera" && microphone) main.addTrack(mic);
			vi.stubGlobal("navigator", {
				userAgent: "Chrome/152.0.0.0",
				mediaDevices: {
					getUserMedia: async (constraints: MediaStreamConstraints) =>
						constraints.video ? main : new Stream([mic]),
					getDisplayMedia: async () => main,
				},
			});
			expect(
				await start(
					{
						microphone: { enabled: microphone, deviceId: null },
						systemAudio: { enabled: systemAudio },
					},
					mode,
				),
			).toMatchObject({ ok: true, status: { phase: "recording" } });

			expect(speakerStreams).toEqual(
				mode === "tab" && systemAudio ? [main] : [],
			);

			expect(
				await send({ type: "toggle-microphone-mute", muted: true }),
			).toEqual({ ok: true });
			expect(mic.enabled).toBe(!microphone);
			expect(system.enabled).toBe(true);
			if (systemAudio) {
				expect(capturedStream.getAudioTracks()[0]?.enabled).toBe(true);
			}

			expect(
				await send({ type: "toggle-microphone-mute", muted: false }),
			).toEqual({ ok: true });
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
