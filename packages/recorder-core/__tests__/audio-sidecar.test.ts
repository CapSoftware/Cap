import {
	AudioRecordingSidecar,
	uploadRecoveredAudioSidecar,
} from "@cap/recorder-core/audio-sidecar";
import type { VideoId } from "@cap/recorder-core/recorder-types";
import { describe, expect, it } from "vitest";

const videoId = "video-123" as VideoId;

describe("AudioRecordingSidecar", () => {
	it("refuses to start where the browser can't record audio", async () => {
		await expect(
			AudioRecordingSidecar.create({
				kind: "mic",
				stream: {} as MediaStream,
				videoId,
				screenSubpath: "raw-upload.mp4",
				onFatalError: () => {},
			}),
		).rejects.toThrow("No supported mic audio recorder is available");
	});
});

describe("uploadRecoveredAudioSidecar", () => {
	const source = {
		kind: "systemAudio" as const,
		sessionId: "session",
		mimeType: "audio/webm;codecs=opus",
		subpath: "system-audio-upload.webm",
		offsetMs: 12,
		recordedBytes: 4,
	};

	it("rejects a backup whose size doesn't match what was recorded", async () => {
		await expect(
			uploadRecoveredAudioSidecar({
				videoId,
				source,
				blob: new Blob(["toolong"]),
				screenSubpath: "raw-upload.mp4",
				durationSeconds: 1,
			}),
		).rejects.toThrow("Audio source backup does not match its recording");
	});

	it("rejects an empty backup", async () => {
		await expect(
			uploadRecoveredAudioSidecar({
				videoId,
				source: { ...source, recordedBytes: 0 },
				blob: new Blob([]),
				screenSubpath: "raw-upload.mp4",
				durationSeconds: 1,
			}),
		).rejects.toThrow("Audio source backup does not match its recording");
	});
});
