import { describe, expect, it } from "vitest";
import { setMicrophoneMuted } from "./audio-mute";

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

	it("does not mutate tab or system audio tracks when muting microphone", () => {
		const tabTrack = createMockTrack(true);
		const micTrack = createMockTrack(true);
		const micStream = createMockStream([micTrack]);

		setMicrophoneMuted(micStream, true);

		expect(micTrack.enabled).toBe(false);
		expect(tabTrack.enabled).toBe(true);
	});

	it("safely handles null and undefined streams", () => {
		expect(() => setMicrophoneMuted(null, true)).not.toThrow();
		expect(() => setMicrophoneMuted(undefined, true)).not.toThrow();
	});
});
