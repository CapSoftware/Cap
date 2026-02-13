import { describe, expect, it } from "vitest";
import type {
	AudioConfiguration,
	TimelineSegment,
} from "@/app/editor/types/project-config";
import {
	getAudioPlaybackGain,
	getSegmentAudioGain,
} from "@/app/editor/utils/audio";

const baseAudio: AudioConfiguration = {
	mute: false,
	improve: false,
	volumeDb: 0,
};

describe("getAudioPlaybackGain", () => {
	it("returns 0 when muted", () => {
		expect(getAudioPlaybackGain({ ...baseAudio, mute: true })).toBe(0);
	});

	it("returns unity gain at 0 dB", () => {
		expect(getAudioPlaybackGain(baseAudio)).toBe(1);
	});

	it("returns 0 at minimum dB", () => {
		expect(getAudioPlaybackGain({ ...baseAudio, volumeDb: -30 })).toBe(0);
	});

	it("applies negative gain values", () => {
		const value = getAudioPlaybackGain({ ...baseAudio, volumeDb: -6 });
		expect(value).toBeCloseTo(0.5011, 3);
	});

	it("applies positive gain values", () => {
		const value = getAudioPlaybackGain({ ...baseAudio, volumeDb: 10 });
		expect(value).toBeCloseTo(3.1622, 3);
	});
});

describe("getSegmentAudioGain", () => {
	const segment: TimelineSegment = {
		start: 0,
		end: 5,
		timescale: 1,
	};

	it("returns normal gain for unmuted segment", () => {
		expect(getSegmentAudioGain(baseAudio, segment)).toBe(1);
	});

	it("returns 0 for muted segment", () => {
		expect(getSegmentAudioGain(baseAudio, { ...segment, muted: true })).toBe(0);
	});

	it("returns 0 when global mute is on", () => {
		expect(getSegmentAudioGain({ ...baseAudio, mute: true }, segment)).toBe(0);
	});
});
