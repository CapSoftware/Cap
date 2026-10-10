import { expect, test } from "bun:test";
import { fitDisplayGamma } from "./browser-color-calibration";

test("fits the display gamma Chrome applies to hardware frames", () => {
	// Chrome on macOS, hardware-decoded BT.709 greys copied into WebGPU
	const gamma = fitDisplayGamma([0, 16, 38, 58, 77, 96, 139, 199, 238, 255]);
	expect(gamma).not.toBeNull();
	expect(Math.abs((gamma ?? 0) - 1.961)).toBeLessThan(0.05);
});

test("leaves plain copies and unknown transforms alone", () => {
	expect(
		fitDisplayGamma([0, 17, 34, 51, 68, 85, 128, 192, 235, 255]),
	).toBeNull();
	expect(
		fitDisplayGamma([0, 18, 33, 52, 67, 86, 127, 193, 234, 254]),
	).toBeNull();
	expect(
		fitDisplayGamma([0, 30, 30, 30, 90, 90, 90, 200, 200, 200]),
	).toBeNull();
});
