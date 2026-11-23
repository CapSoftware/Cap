import { describe, expect, it } from "vitest";
import { clipAudioMuted, clipVolume } from "./clip-audio";

describe("clip audio", () => {
	it("keeps old clips at full volume and bounds saved values", () => {
		expect(clipVolume({})).toBe(1);
		expect(clipVolume({ volume: null })).toBe(1);
		expect(clipVolume({ volume: 0.35 })).toBe(0.35);
		expect(clipVolume({ volume: -1 })).toBe(0);
		expect(clipVolume({ volume: 3 })).toBe(2);
		expect(clipVolume({ volume: Number.NaN })).toBe(1);
		expect(clipVolume({ volume: Number.POSITIVE_INFINITY })).toBe(1);
	});

	it("mutes normal clips explicitly and sped-up clips by default", () => {
		expect(clipAudioMuted({ timescale: 1 })).toBe(false);
		expect(clipAudioMuted({ timescale: 1, speedAudioMode: "mute" })).toBe(true);
		expect(clipAudioMuted({ timescale: 2 })).toBe(true);
		for (const speedAudioMode of ["maintainPitch", "matchSpeed"] as const) {
			expect(clipAudioMuted({ timescale: 2, speedAudioMode })).toBe(false);
		}
	});
});
