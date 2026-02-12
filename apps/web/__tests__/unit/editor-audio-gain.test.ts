import { describe, expect, it } from "vitest";
import type { AudioConfiguration } from "@/app/editor/types/project-config";
import { getAudioPlaybackGain } from "@/app/editor/utils/audio";

const baseAudio: AudioConfiguration = {
	mute: false,
	improve: false,
	micVolumeDb: 0,
	micStereoMode: "stereo",
	systemVolumeDb: 0,
};

describe("getAudioPlaybackGain", () => {
	it("returns 0 when muted", () => {
		expect(getAudioPlaybackGain({ ...baseAudio, mute: true })).toBe(0);
	});

	it("returns unity gain at 0 dB", () => {
		expect(getAudioPlaybackGain(baseAudio)).toBe(1);
	});

	it("keeps full gain when one source is fully muted", () => {
		expect(
			getAudioPlaybackGain({
				...baseAudio,
				micVolumeDb: -30,
				systemVolumeDb: 0,
			}),
		).toBe(1);
	});

	it("applies negative gain values", () => {
		const value = getAudioPlaybackGain({
			...baseAudio,
			micVolumeDb: -6,
			systemVolumeDb: -6,
		});
		expect(value).toBeCloseTo(0.5011, 3);
	});

	it("applies positive gain values", () => {
		const value = getAudioPlaybackGain({
			...baseAudio,
			micVolumeDb: 10,
			systemVolumeDb: 10,
		});
		expect(value).toBeCloseTo(3.1622, 3);
	});
});
