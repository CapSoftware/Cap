import { describe, expect, it } from "vitest";
import { isPortraitOutput, safeZoneRect } from "./safe-zones";

describe("safe zones", () => {
	it("maps platform insets onto a portrait frame and skips landscape", () => {
		const rect = safeZoneRect("tiktok", 1080, 1920);
		expect(rect?.y).toBeCloseTo(160 / 1920);
		expect((rect?.y ?? 0) + (rect?.h ?? 0)).toBeCloseTo(1 - 480 / 1920);
		expect(safeZoneRect("reels", 1920, 1080)).toBeNull();
	});

	it("treats only tall outputs as portrait", () => {
		expect(isPortraitOutput(1080, 1920)).toBe(true);
		expect(isPortraitOutput(1080, 1350)).toBe(false);
		expect(isPortraitOutput(1080, 1080)).toBe(false);
	});
});
