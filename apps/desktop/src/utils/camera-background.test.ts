import { describe, expect, it } from "vitest";
import {
	cameraBackgroundOptions,
	cameraBorderRadius,
	cycleBlurMode,
	getDefaultCameraWindowState,
	normalizeBackgroundBlurMode,
} from "../components/CameraPreviewChrome";

describe("camera background effects", () => {
	it("offers removal only on macOS and keeps the existing modes everywhere", () => {
		expect(
			cameraBackgroundOptions(false).map((option) => option.value),
		).toEqual(["off", "light", "heavy"]);
		expect(cameraBackgroundOptions(true).map((option) => option.value)).toEqual(
			["off", "light", "heavy", "remove"],
		);
		expect(cycleBlurMode("heavy", true)).toBe("remove");
		expect(cycleBlurMode("remove", true)).toBe("off");
		expect(cycleBlurMode("heavy", false)).toBe("off");
	});

	it("preserves legacy boolean settings", () => {
		expect(normalizeBackgroundBlurMode(true)).toBe("heavy");
		expect(normalizeBackgroundBlurMode(false)).toBe("off");
		expect(normalizeBackgroundBlurMode(undefined)).toBe("off");
		expect(normalizeBackgroundBlurMode("remove")).toBe("remove");
	});

	it("removes the clipping shape without overwriting the stored shape", () => {
		const state = {
			...getDefaultCameraWindowState(),
			backgroundBlur: "remove" as const,
		};
		expect(cameraBorderRadius(state)).toBe("0px");
		expect(state.shape).toBe("round");
		expect(cameraBorderRadius({ ...state, backgroundBlur: "off" })).toBe(
			"9999px",
		);
	});
});
