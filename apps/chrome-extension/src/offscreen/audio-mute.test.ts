import { describe, expect, it } from "vitest";
import {
	resolveMicrophoneStream,
	setMicrophoneMuted,
	toggleMicrophoneMuteForRecording,
} from "./audio-mute";

const createMockTrack = (enabled = true): MediaStreamTrack =>
	({
		enabled,
	}) as MediaStreamTrack;

const createMockStream = (tracks: MediaStreamTrack[]): MediaStream =>
	({
		getAudioTracks: () => tracks,
	}) as MediaStream;

describe("setMicrophoneMuted", () => {
	it("disables microphone tracks when muted is true", () => {
		const micTrack = createMockTrack(true);
		const micStream = createMockStream([micTrack]);

		setMicrophoneMuted(micStream, true);

		expect(micTrack.enabled).toBe(false);
	});

	it("enables microphone tracks when muted is false", () => {
		const micTrack = createMockTrack(false);
		const micStream = createMockStream([micTrack]);

		setMicrophoneMuted(micStream, false);

		expect(micTrack.enabled).toBe(true);
	});

	it("safely handles null and undefined streams", () => {
		expect(() => setMicrophoneMuted(null, true)).not.toThrow();
		expect(() => setMicrophoneMuted(undefined, true)).not.toThrow();
	});
});

describe("resolveMicrophoneStream", () => {
	it("returns mainStream in camera mode when it contains microphone audio tracks", () => {
		const micTrack = createMockTrack(true);
		const cameraStream = createMockStream([micTrack]);

		const resolved = resolveMicrophoneStream("camera", cameraStream, null);
		expect(resolved).toBe(cameraStream);
	});

	it("returns undefined in camera mode when mainStream has no audio tracks", () => {
		const cameraStream = createMockStream([]);

		const resolved = resolveMicrophoneStream("camera", cameraStream, null);
		expect(resolved).toBeUndefined();
	});

	it("returns microphoneStream in tab mode without falling back to mainStream", () => {
		const tabTrack = createMockTrack(true);
		const micTrack = createMockTrack(true);
		const mainStream = createMockStream([tabTrack]);
		const micStream = createMockStream([micTrack]);

		const resolved = resolveMicrophoneStream("tab", mainStream, micStream);
		expect(resolved).toBe(micStream);
	});

	it("does not fall back to mainStream when microphoneStream is null in tab or screen mode", () => {
		const systemTrack = createMockTrack(true);
		const mainStream = createMockStream([systemTrack]);

		const resolvedTab = resolveMicrophoneStream("tab", mainStream, null);
		expect(resolvedTab).toBeUndefined();

		const resolvedScreen = resolveMicrophoneStream("screen", mainStream, null);
		expect(resolvedScreen).toBeUndefined();
	});
});

describe("toggleMicrophoneMuteForRecording", () => {
	it("mutes only microphone tracks while leaving mainStream and recordingStream tracks enabled", () => {
		const tabTrack = createMockTrack(true);
		const recordingTrack = createMockTrack(true);
		const micTrack = createMockTrack(true);

		const mainStream = createMockStream([tabTrack]);
		const recordingStream = createMockStream([recordingTrack]);
		const microphoneStream = createMockStream([micTrack]);

		const recording = {
			streams: [mainStream, microphoneStream],
			recordingStream,
			microphoneStream,
		};

		toggleMicrophoneMuteForRecording(recording, true);

		expect(micTrack.enabled).toBe(false);
		expect(tabTrack.enabled).toBe(true);
		expect(recordingTrack.enabled).toBe(true);
	});

	it("mutes camera audio when recording uses camera mode with microphone-bearing mainStream", () => {
		const cameraMicTrack = createMockTrack(true);
		const recordingTrack = createMockTrack(true);

		const mainStream = createMockStream([cameraMicTrack]);
		const recordingStream = createMockStream([recordingTrack]);

		const microphoneStream = resolveMicrophoneStream(
			"camera",
			mainStream,
			null,
		);
		const recording = {
			streams: [mainStream],
			recordingStream,
			microphoneStream,
		};

		toggleMicrophoneMuteForRecording(recording, true);

		expect(cameraMicTrack.enabled).toBe(false);
		expect(recordingTrack.enabled).toBe(true);
	});

	it("safely handles null or undefined recording", () => {
		expect(() => toggleMicrophoneMuteForRecording(null, true)).not.toThrow();
		expect(() =>
			toggleMicrophoneMuteForRecording(undefined, true),
		).not.toThrow();
	});
});
