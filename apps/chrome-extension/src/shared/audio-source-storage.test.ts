import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	FAILED_RECORDINGS_KEY,
	type FailedRecording,
	type LiveRecordingManifest,
	loadFailedRecordings,
	loadLiveRecordingManifests,
} from "./storage";
import type { StorageBridgeRequest } from "./storage-bridge";

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./storage-bridge", () => ({
	requestStorage: async (request: StorageBridgeRequest) => {
		if (request.type === "get") {
			return {
				ok: true,
				items: Object.fromEntries(
					request.keys
						.filter((key) => storage.has(key))
						.map((key) => [key, storage.get(key)]),
				),
			};
		}
		if (request.type === "set") {
			for (const [key, value] of Object.entries(request.items)) {
				storage.set(key, value);
			}
		} else {
			for (const key of Array.isArray(request.keys)
				? request.keys
				: [request.keys]) {
				storage.delete(key);
			}
		}
		return { ok: true };
	},
}));

const mic = {
	kind: "mic" as const,
	sessionId: "mic-session",
	mimeType: "audio/webm;codecs=opus",
	subpath: "mic-upload.webm",
	offsetMs: 12,
	recordedBytes: 4096,
};

const systemAudio = {
	kind: "systemAudio" as const,
	sessionId: "system-session",
	mimeType: "audio/mp4",
	subpath: "system-audio-upload.mp4",
	offsetMs: -8,
	recordedBytes: 2048,
};

const failedRecording: FailedRecording = {
	sessionId: "screen-session",
	cameraSessionId: "camera-session",
	videoId: "video-id",
	shareUrl: "https://cap.so/s/video-id",
	mimeType: "video/webm",
	subpath: "screen-upload.webm",
	durationMs: 1000,
	width: 1920,
	height: 1080,
	fps: 30,
	totalBytes: 8000,
	createdAt: 1,
	message: null,
};

const liveManifest: LiveRecordingManifest = {
	sessionId: "screen-session",
	cameraSessionId: "camera-session",
	videoId: "video-id",
	shareUrl: "https://cap.so/s/video-id",
	mimeType: "video/webm",
	subpath: "screen-upload.webm",
	width: 1920,
	height: 1080,
	fps: 30,
	startedAt: 1,
};

beforeEach(() => storage.clear());

describe("recording audio source recovery metadata", () => {
	it("loads independently captured microphone and system audio with the screen", async () => {
		storage.set(FAILED_RECORDINGS_KEY, [
			{ ...failedRecording, audioSources: [mic, systemAudio] },
		]);
		storage.set("cap-extension-live-recordings", [
			{ ...liveManifest, audioSources: [mic, systemAudio] },
		]);

		expect((await loadFailedRecordings())[0]?.audioSources).toEqual([
			mic,
			systemAudio,
		]);
		expect((await loadLiveRecordingManifests())[0]?.audioSources).toEqual([
			mic,
			systemAudio,
		]);
	});

	it.each([
		["duplicate kind", [mic, { ...mic, sessionId: "another-session" }]],
		["duplicate spool", [mic, { ...systemAudio, sessionId: mic.sessionId }]],
		["screen spool reused", [{ ...mic, sessionId: "screen-session" }]],
		["camera spool reused", [{ ...mic, sessionId: "camera-session" }]],
		["wrong upload path", [{ ...mic, subpath: "screen-upload.webm" }]],
		["video MIME type", [{ ...mic, mimeType: "video/webm" }]],
		["offset outside editor bounds", [{ ...mic, offsetMs: 30_001 }]],
		["negative captured size", [{ ...mic, recordedBytes: -1 }]],
	])(
		"rejects %s in failed and live recording metadata",
		async (_label, sources) => {
			storage.set(FAILED_RECORDINGS_KEY, [
				{ ...failedRecording, audioSources: sources },
			]);
			storage.set("cap-extension-live-recordings", [
				{ ...liveManifest, audioSources: sources },
			]);

			expect(await loadFailedRecordings()).toEqual([]);
			expect(await loadLiveRecordingManifests()).toEqual([]);
		},
	);
});
