import type { RecordingSpool } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenResponse, RecordingMode } from "../shared/types";

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
			sendMessage: (_message: unknown, callback: () => void) => callback(),
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
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	const { RecordingSpool } = await import("@cap/recorder-core");
	vi.spyOn(RecordingSpool, "create").mockResolvedValue({
		sessionId: "spool-test",
	} as RecordingSpool);
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
			const { defaultSettings } = await import("../shared/storage");
			await import("./recorder");
			expect(
				await send({
					type: "start-recording",
					mode,
					tabStreamId: "tab-test",
					settings: {
						...defaultSettings,
						apiBaseUrl: "https://cap.test",
						microphone: { enabled: microphone, deviceId: null },
						systemAudio: { enabled: systemAudio },
						sounds: { enabled: false },
						countdown: { enabled: false, seconds: 3 },
					},
					auth: { authApiKey: "test", userId: "user-test" },
					bootstrap: {
						organization: { id: "org-test" },
						plan: { isPro: true, maxRecordingSeconds: null },
					},
				}),
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
